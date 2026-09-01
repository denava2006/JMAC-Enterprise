-- Abandoned online payments must not stay payable forever.
--
-- PayMongo Checkout Sessions do NOT expire on their own. A session stays live
-- until something explicitly expires it, which means a customer who wandered
-- off can reopen yesterday's URL and pay a basket the shop has long forgotten.
-- Worse, the sale would then be created from a cart priced at yesterday's
-- prices against today's stock.
--
-- There is also no checkout_session.expired webhook on this account, so nothing
-- tells JMAC that a payment died. Verified the hard way: a real failed test
-- payment left its attempt 'pending' with no event that could clear it.
--
-- So JMAC owns the deadline. Every attempt gets an expires_at; a sweep expires
-- the session AT PAYMONGO first, and only then records the local outcome.
-- Order matters: marking an attempt cancelled while its session is still live
-- is the one sequence that could let a customer pay something JMAC has written
-- off.

-- ------------------------------------------------------------------- the TTL
insert into public.system_settings (key, value)
values ('pos_payment_ttl_minutes', '30'::jsonb)
on conflict (key) do nothing;

create or replace function public.pos_payment_ttl_minutes()
returns integer
language sql
stable
set search_path = ''
as $fn$
  -- Configurable, but never absurd: a floor of one minute stops a mistyped 0
  -- from expiring payments the instant they are created, and the ceiling keeps
  -- an abandoned session from living for days.
  select least(greatest(
    coalesce((select (value #>> '{}')::integer from public.system_settings
               where key = 'pos_payment_ttl_minutes'), 30), 1), 1440);
$fn$;

revoke all on function public.pos_payment_ttl_minutes() from public, anon;
grant execute on function public.pos_payment_ttl_minutes() to authenticated, service_role;

-- Every attempt carries its own deadline, set server-side at insert.
create or replace function public.set_pos_payment_expiry()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.expires_at is null then
    new.expires_at := now() + make_interval(mins => public.pos_payment_ttl_minutes());
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_pos_payment_expiry on public.pos_payment_attempts;
create trigger trg_pos_payment_expiry
  before insert on public.pos_payment_attempts
  for each row execute function public.set_pos_payment_expiry();

-- Attempts created before this migration have no deadline. Give them one based
-- on when they were created, so the sweep can finish what it never started.
update public.pos_payment_attempts
set expires_at = created_at + make_interval(mins => public.pos_payment_ttl_minutes())
where expires_at is null;

-- ------------------------------------------------- paid is a one-way door
-- The CAS in mark_pos_payment_state already refuses to touch anything that is
-- not pending. This trigger is the second lock on the same door: no code path,
-- present or future, may turn a paid payment into an expired or cancelled one.
-- A customer whose money was taken must never have the record of it rewritten
-- by a sweep that arrived a moment later.
create or replace function public.pos_payment_no_demotion()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if old.status = 'paid' and new.status <> 'paid' then
    raise exception 'A paid payment cannot become %', new.status
      using errcode = 'check_violation';
  end if;
  if old.status = 'paid_unfulfilled' and new.status in ('expired', 'cancelled') then
    raise exception 'A paid-but-unfulfilled payment needs a refund decision, not %', new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_pos_payment_no_demotion on public.pos_payment_attempts;
create trigger trg_pos_payment_no_demotion
  before update on public.pos_payment_attempts
  for each row execute function public.pos_payment_no_demotion();

-- ------------------------------------------------- compare-and-set outcomes
-- Returns whether THIS caller was the one that moved the row, so a sweeper can
-- tell "I expired it" from "the webhook got there first" instead of guessing.
drop function if exists public.mark_pos_payment_state(uuid, public.pos_payment_status, text);
create function public.mark_pos_payment_state(
  _attempt_id uuid,
  _status public.pos_payment_status,
  _reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _changed integer;
begin
  if _status not in ('failed', 'expired', 'cancelled') then
    raise exception 'mark_pos_payment_state only records terminal non-paid states';
  end if;

  -- The `status = 'pending'` predicate IS the compare-and-set. Two writers
  -- racing -- an expiry sweep and a payment webhook -- both attempt it, exactly
  -- one matches a pending row, and the loser changes nothing.
  update public.pos_payment_attempts
  set status = _status,
      last_error = coalesce(_reason, last_error),
      failed_at = case when _status = 'failed' then now() else failed_at end,
      cancelled_at = case when _status = 'cancelled' then now() else cancelled_at end
  where id = _attempt_id
    and status = 'pending';

  get diagnostics _changed = row_count;
  return _changed = 1;
end;
$fn$;

revoke all on function public.mark_pos_payment_state(uuid, public.pos_payment_status, text) from public, anon, authenticated;
grant execute on function public.mark_pos_payment_state(uuid, public.pos_payment_status, text) to service_role;

-- ------------------------------------------------------- what the sweep sees
create or replace function public.get_expirable_pos_payments(_limit integer default 50)
returns table (
  id uuid,
  provider_checkout_session_id text,
  reference_number text,
  amount_centavos bigint,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.id, a.provider_checkout_session_id, a.reference_number,
         a.amount_centavos, a.expires_at
  from public.pos_payment_attempts a
  where a.status = 'pending'
    and a.livemode = false
    and a.expires_at is not null
    and a.expires_at < now()
  order by a.expires_at
  limit least(greatest(coalesce(_limit, 50), 1), 200);
$fn$;

revoke all on function public.get_expirable_pos_payments(integer) from public, anon, authenticated;
grant execute on function public.get_expirable_pos_payments(integer) to service_role;

comment on function public.get_expirable_pos_payments(integer) is
  'Pending payments past their deadline. The sweep must expire the session at '
  'PayMongo before recording anything locally.';

-- ------------------------------------------- cancelling is now server-only
-- The till used to call cancel_pos_payment_attempt directly. That marked the
-- attempt cancelled locally while the PayMongo session stayed live and payable
-- -- exactly the sequence that lets a customer pay a written-off basket.
--
-- Cancellation now goes through the cancel-pos-payment Edge Function, which
-- expires the session at PayMongo first and refuses outright if the provider
-- says the payment already succeeded. The browser keeps no direct route.
revoke execute on function public.cancel_pos_payment_attempt(uuid) from authenticated;

-- Branch authority for the Edge Function to check on the caller's behalf,
-- using the same rule every other POS surface uses.
create or replace function public.may_cancel_pos_payment(_checkout_key uuid)
returns table (attempt_id uuid, provider_checkout_session_id text, status text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _a public.pos_payment_attempts%rowtype;
begin
  select * into _a from public.pos_payment_attempts a where a.checkout_key = _checkout_key;
  if not found then
    raise exception 'Unknown payment';
  end if;
  if not public.has_pos_role(_a.branch_id, array['manager', 'cashier']::public.pos_role[]) then
    raise exception 'You do not have POS access at this branch';
  end if;
  return query select _a.id, _a.provider_checkout_session_id, _a.status::text;
end;
$fn$;

revoke all on function public.may_cancel_pos_payment(uuid) from public, anon, authenticated;
grant execute on function public.may_cancel_pos_payment(uuid) to service_role;

-- ------------------------------------------------------ the sweep's own token
-- The sweep endpoint is reachable without a Supabase JWT, because pg_cron
-- cannot present one. It authenticates with a dedicated token instead.
--
-- The token is generated inside the database and stored in Vault, so it is
-- never typed by a person, never pasted into a terminal, and never passes
-- through a chat transcript. Both sides read it from here: pg_cron to send it,
-- the Edge Function to check it.
--
-- A dedicated token rather than the service-role key, deliberately: if it ever
-- leaked, the only thing it can do is expire checkout sessions that are already
-- past their deadline. It cannot read data, create a sale, or mark anything
-- paid.
create or replace function public.pos_expiry_token()
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select decrypted_secret from vault.decrypted_secrets where name = 'pos_expiry_token';
$fn$;

revoke all on function public.pos_expiry_token() from public, anon, authenticated;
grant execute on function public.pos_expiry_token() to service_role;

comment on function public.pos_expiry_token() is
  'Shared secret proving a sweep request came from pg_cron. Service-role only.';
