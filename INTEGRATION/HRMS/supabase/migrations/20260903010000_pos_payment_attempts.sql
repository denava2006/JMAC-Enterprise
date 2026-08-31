-- Provider-backed POS payments (PayMongo, test mode).
--
-- The existing checkout is deliberately NOT replaced. checkout_pos_sale stays
-- the one engine that creates a sale: it already holds the advisory locking,
-- the fingerprint idempotency, the deterministic lock ordering and the atomic
-- inventory deduction that two concurrency harnesses exercise. A second sales
-- path for card payments would mean two engines that must agree forever, and
-- they would not.
--
-- So this table is a *waiting room*, not a sale. It records what the customer
-- is being asked to pay and what the provider said about it. When the provider
-- confirms payment, the webhook calls the same checkout_pos_sale every cash
-- sale goes through, with the cart that was authoritative when the payment was
-- created.
--
-- Two consequences follow, both deliberate:
--
--   * Stock is NOT held while the customer pays. There is no reservation
--     system, because the existing architecture does not need one and adding
--     one would introduce expiry, release and orphan-reservation problems of
--     its own. The trade is explicit: a payment can succeed for stock that has
--     since sold out. That case is recorded as `paid_unfulfilled` rather than
--     silently creating negative inventory -- somebody must refund it, which is
--     a decision for a person.
--
--   * The cart is snapshotted here, server-side. The browser cannot change the
--     amount between creating the payment and the webhook arriving, because
--     the webhook never reads anything the browser sent.

do $enum$
begin
  if not exists (select 1 from pg_type where typname = 'pos_payment_status') then
    create type public.pos_payment_status as enum (
      'pending',            -- created at the provider, customer has not paid
      'paid',               -- provider confirmed; sale finalized
      'paid_unfulfilled',   -- provider confirmed, but the sale could not be created
      'failed',             -- provider reported failure
      'expired',            -- session lapsed without payment
      'cancelled'           -- cancelled at the till before payment
    );
  end if;
end
$enum$;

create table if not exists public.pos_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  cashier_profile_id uuid not null references public.profiles(id),

  -- The idempotency key the till generates, and the same one handed to
  -- checkout_pos_sale on success. One key means one sale, whatever happens
  -- upstream: a webhook delivered twelve times still finalizes once.
  checkout_key uuid not null,
  sale_id uuid references public.pos_sales(id),

  method text not null check (method in ('gcash', 'paymaya', 'card', 'qrph')),
  provider text not null default 'paymongo' check (provider = 'paymongo'),

  -- Centavos, because that is what the provider speaks and because money in a
  -- float is a bug waiting for a rounding boundary. PHP 1.00 = 100.
  amount_centavos bigint not null check (amount_centavos >= 100),
  currency text not null default 'PHP' check (currency = 'PHP'),

  -- The authoritative cart, snapshotted server-side at creation. The webhook
  -- finalizes from THIS, never from anything a browser later sends.
  items jsonb not null,

  status public.pos_payment_status not null default 'pending',

  -- Provider identifiers, kept for reconciliation. No card data, no CVC, no
  -- expiry, no wallet credential, no raw provider payload.
  provider_checkout_session_id text,
  provider_payment_intent_id text,
  provider_payment_id text,
  checkout_url text,

  -- The JMAC-owned reference sent to the provider, e.g. JMAC-POS-<short key>.
  -- Traceable back to exactly one checkout and carrying nothing about the
  -- employee, the customer or the database.
  reference_number text not null,

  livemode boolean not null default false,
  last_error text,

  created_at timestamptz not null default now(),
  expires_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now(),

  -- Test mode only, enforced by the database rather than by remembering.
  constraint pos_payment_attempts_test_mode_only check (livemode = false)
);

-- One live attempt per checkout key: a double-clicked Pay button reuses the
-- row rather than creating a second provider session.
create unique index if not exists pos_payment_attempts_one_per_checkout
  on public.pos_payment_attempts (checkout_key);

create unique index if not exists pos_payment_attempts_session
  on public.pos_payment_attempts (provider_checkout_session_id)
  where provider_checkout_session_id is not null;

create index if not exists idx_pos_payment_attempts_branch_status
  on public.pos_payment_attempts (branch_id, status, created_at desc);

comment on table public.pos_payment_attempts is
  'A POS payment being attempted at PayMongo. Not a sale: the sale is created by '
  'checkout_pos_sale once the provider confirms payment. Test mode only.';

alter table public.pos_payment_attempts enable row level security;

-- A cashier sees their own branch's attempts; an Administrator sees all.
-- Nobody writes one from the API: creation and finalization are both
-- server-side, because a browser that could write here could mark itself paid.
drop policy if exists pos_payment_attempts_read on public.pos_payment_attempts;
create policy pos_payment_attempts_read on public.pos_payment_attempts
  for select using (
    public.is_admin()
    or public.has_pos_role(branch_id, array['cashier', 'manager']::public.pos_role[])
  );

drop trigger if exists trg_pos_payment_attempts_updated_at on public.pos_payment_attempts;
create trigger trg_pos_payment_attempts_updated_at
  before update on public.pos_payment_attempts
  for each row execute function public.set_updated_at();

-- ------------------------------------------------- the new payment methods
-- pos_sales accepted cash|gcash|maya|bank|other. Card and QR Ph are new, and
-- 'paymaya' is PayMongo's identifier for Maya -- the existing 'maya' value is
-- kept so historical sales stay valid.
alter table public.pos_sales drop constraint if exists pos_sales_payment_method_check;
alter table public.pos_sales add constraint pos_sales_payment_method_check
  check (payment_method in ('cash', 'gcash', 'maya', 'paymaya', 'card', 'qrph', 'bank', 'other'));

-- ----------------------------------------------------- reporting: cash vs not
-- Till and reporting must not count an electronic payment as drawer cash.
create or replace function public.pos_payment_is_cash(_method text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select _method = 'cash';
$fn$;

revoke all on function public.pos_payment_is_cash(text) from public, anon;
grant execute on function public.pos_payment_is_cash(text) to authenticated;

comment on function public.pos_payment_is_cash(text) is
  'One place that decides whether a payment method touches the physical drawer. '
  'Everything else -- change due, drawer totals -- follows from it.';
