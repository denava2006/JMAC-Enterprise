-- ===========================================================================
-- F6  Treasury: where money actually sits, and every movement in or out
-- ===========================================================================
--
-- THE AUDIT QUESTION, ANSWERED FIRST.
--
-- finance_accounts looks like it could hold a balance: it has opening_balance,
-- opening_balance_as_of, and subtypes 'bank', 'cash' and 'e_wallet'. It is not
-- that table, and its own F2 comment says so:
--
--     "A stated fact with a date, not a running total. The standalone table
--      kept a mutable `balance` that nothing posted to -- a number anyone could
--      type and nobody could reconcile. The current balance becomes derivable
--      when the journal arrives; until then this says what was true on a given
--      day and makes no claim about today."
--
-- The journal is F7 at the earliest, and this phase is explicitly forbidden
-- from building one. finance_accounts also spans revenue, expense and equity
-- -- classifications, not places money sits -- and carries no branch, so it
-- cannot say "the cash drawer at Cavite". Turning a chart-of-accounts row into
-- a wallet because the words overlap is exactly the mistake the brief warns
-- about.
--
-- So: a narrow operational model, with an OPTIONAL link back to the chart of
-- accounts. The link is how a future general ledger maps a treasury movement to
-- a posting without any of this being rebuilt; leaving it null costs nothing
-- today.
--
-- Balances are never stored. treasury_account_status derives every balance from
-- the opening figure plus movements, so a balance cannot drift from its
-- history, and there is no column for anybody to type a number into.

-- ---------------------------------------------------------------------------
-- 1. The accounts
-- ---------------------------------------------------------------------------
create table if not exists public.treasury_accounts (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,

  -- What kind of place this is, not what it is classified as on a statement.
  -- Two values, because two are what F6 can honestly support: a drawer someone
  -- can open, and an account a bank holds. An e-wallet float would be a third,
  -- and is deliberately absent until JMAC actually operates one.
  account_type text not null check (account_type in ('cash', 'bank')),

  -- The chart-of-accounts row this maps to, when Finance has decided. Optional
  -- and non-unique on purpose: several branch drawers may map to one Cash
  -- account long before anybody wants a ledger line per branch.
  finance_account_id uuid references public.finance_accounts(id) on delete set null,

  -- Set for a branch drawer, null for a company account. This is what makes
  -- "Cavite's cash" a thing the settlement flow can name.
  branch_id uuid references public.branches(id) on delete restrict,

  currency text not null default 'PHP' check (currency = 'PHP'),

  -- The same stated-fact-with-a-date shape F2 chose, for the same reason: it
  -- says what was true on a day and makes no claim about today. Today comes
  -- from the movements.
  opening_balance       numeric(14,2) not null default 0,
  opening_balance_as_of date,

  is_active  boolean not null default true,
  notes      text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint treasury_accounts_opening_dated check (
    opening_balance = 0 or opening_balance_as_of is not null
  ),
  -- A bank account belongs to the company, not to a branch. Allowing both
  -- would make "which bank account did Cavite deposit into" ambiguous.
  constraint treasury_accounts_branch_is_cash check (
    branch_id is null or account_type = 'cash'
  ),
  constraint treasury_accounts_opening_not_negative check (opening_balance >= 0)
);

create unique index if not exists treasury_accounts_name_unique
  on public.treasury_accounts (lower(btrim(name)));

create index if not exists treasury_accounts_branch_idx
  on public.treasury_accounts (branch_id) where branch_id is not null;

comment on table public.treasury_accounts is
  'Operational places money is held or paid from. NOT the chart of accounts -- '
  'finance_accounts classifies, this one holds. No stored balance: see '
  'treasury_account_status.';

-- ---------------------------------------------------------------------------
-- 2. The movements
-- ---------------------------------------------------------------------------
--
-- Append-only. Every row names the document that caused it, and the pair
-- (source_type, source_id) is unique -- which is where idempotency actually
-- lives. A double-clicked confirmation, a retried request and a racing second
-- worker all try to insert the same pair, and exactly one of them wins on the
-- index rather than on anybody remembering to check first.
create table if not exists public.treasury_movements (
  id uuid primary key default gen_random_uuid(),
  treasury_account_id uuid not null
    references public.treasury_accounts(id) on delete restrict,

  direction text not null check (direction in ('in', 'out')),
  amount    numeric(14,2) not null check (amount > 0),

  -- What caused this. There is no 'adjustment' member, and that absence is the
  -- design: an arbitrary balance correction is not something F6 offers, and
  -- adding one later should be a deliberate audited workflow rather than a row
  -- type that quietly already exists.
  source_type text not null
    check (source_type in ('collection_settlement', 'supplier_payment')),
  source_id   uuid not null,

  occurred_on date not null,
  reference   text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- One movement per source document. The whole of F6's idempotency guarantee.
create unique index if not exists treasury_movements_source_unique
  on public.treasury_movements (source_type, source_id);

create index if not exists treasury_movements_account_idx
  on public.treasury_movements (treasury_account_id, occurred_on);

comment on table public.treasury_movements is
  'Append-only record of money in and out. Unique on (source_type, source_id), '
  'so one completed document can only ever produce one movement.';

-- Immutable, enforced rather than described. A balance derived from history is
-- only trustworthy if the history cannot be rewritten, and "we agreed not to"
-- is not an enforcement mechanism.
create or replace function public.guard_treasury_movement_immutable()
returns trigger language plpgsql as $fn$
begin
  raise exception 'Treasury movements are a permanent record and cannot be % .',
    case when tg_op = 'DELETE' then 'deleted' else 'changed' end
    using errcode = 'insufficient_privilege';
end;
$fn$;

drop trigger if exists trg_treasury_movements_immutable on public.treasury_movements;
create trigger trg_treasury_movements_immutable
  before update or delete on public.treasury_movements
  for each row execute function public.guard_treasury_movement_immutable();

-- ---------------------------------------------------------------------------
-- 3. Balances, derived
-- ---------------------------------------------------------------------------
create or replace function public.treasury_account_balance(_account_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select (
    coalesce((select a.opening_balance from public.treasury_accounts a where a.id = _account_id), 0)
    + coalesce((select sum(m.amount) from public.treasury_movements m
                 where m.treasury_account_id = _account_id and m.direction = 'in'), 0)
    - coalesce((select sum(m.amount) from public.treasury_movements m
                 where m.treasury_account_id = _account_id and m.direction = 'out'), 0)
  )::numeric(14,2);
$fn$;

create or replace view public.treasury_account_status
with (security_invoker = on) as
  select
    a.id,
    a.name,
    a.account_type,
    a.finance_account_id,
    fa.name as finance_account_name,
    a.branch_id,
    b.name as branch_name,
    a.currency,
    a.opening_balance,
    a.opening_balance_as_of,
    coalesce(mv.total_in, 0)::numeric(14,2) as total_in,
    coalesce(mv.total_out, 0)::numeric(14,2) as total_out,
    (a.opening_balance + coalesce(mv.total_in, 0) - coalesce(mv.total_out, 0))::numeric(14,2)
      as balance,
    coalesce(mv.movement_count, 0)::integer as movement_count,
    mv.last_movement_on,
    a.is_active,
    a.notes,
    a.created_by,
    a.created_at,
    a.updated_at
  from public.treasury_accounts a
  left join public.finance_accounts fa on fa.id = a.finance_account_id
  left join public.branches b on b.id = a.branch_id
  left join lateral (
    select
      sum(m.amount) filter (where m.direction = 'in')  as total_in,
      sum(m.amount) filter (where m.direction = 'out') as total_out,
      count(*)                                          as movement_count,
      max(m.occurred_on)                                as last_movement_on
    from public.treasury_movements m
    where m.treasury_account_id = a.id
  ) mv on true;

comment on view public.treasury_account_status is
  'Treasury accounts with balances derived from opening balance plus movements. '
  'Nothing stores a current balance, so nothing can disagree with the history.';

-- ---------------------------------------------------------------------------
-- 4. Who may see and manage treasury
-- ---------------------------------------------------------------------------
alter table public.treasury_accounts enable row level security;
alter table public.treasury_movements enable row level security;

-- Reading is the whole Finance group's, matching every other Finance master
-- surface: can_read_finance_master() is is_active_finance() or is_admin().
drop policy if exists treasury_accounts_read on public.treasury_accounts;
create policy treasury_accounts_read on public.treasury_accounts
  for select to authenticated
  using (public.can_read_finance_master());

drop policy if exists treasury_movements_read on public.treasury_movements;
create policy treasury_movements_read on public.treasury_movements
  for select to authenticated
  using (public.can_read_finance_master());

-- Opening an account is the Accountant's: it is a bookkeeping act, and the
-- Accountant is the accounting maker throughout F5 and F6.
drop policy if exists treasury_accounts_write on public.treasury_accounts;
create policy treasury_accounts_write on public.treasury_accounts
  for insert to authenticated
  with check (public.has_finance_privilege(array['accountant']));

drop policy if exists treasury_accounts_update on public.treasury_accounts;
create policy treasury_accounts_update on public.treasury_accounts
  for update to authenticated
  using (public.has_finance_privilege(array['accountant']))
  with check (public.has_finance_privilege(array['accountant']));

-- No INSERT policy on treasury_movements, and that is deliberate. Movements are
-- written only by the settlement and payment functions, which run security
-- definer and own the transaction that creates them. A Finance user with a SQL
-- client and the best of intentions still cannot type a balance into existence.

-- An account that has moved money is history. Renaming it is fine; removing it
-- would orphan movements that reconcile against it.
create or replace function public.guard_treasury_account_change()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if tg_op = 'UPDATE' then
    -- The opening balance is a stated historical fact. Once movements exist it
    -- is load-bearing for every balance since, so changing it would silently
    -- restate them all.
    if (new.opening_balance is distinct from old.opening_balance
        or new.opening_balance_as_of is distinct from old.opening_balance_as_of
        or new.account_type is distinct from old.account_type
        or new.branch_id is distinct from old.branch_id)
       and exists (select 1 from public.treasury_movements m
                    where m.treasury_account_id = old.id)
    then
      raise exception 'This account has recorded movements, so its opening balance, type and branch are fixed.'
        using errcode = 'check_violation';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_treasury_accounts_guard on public.treasury_accounts;
create trigger trg_treasury_accounts_guard
  before update on public.treasury_accounts
  for each row execute function public.guard_treasury_account_change();

-- ---------------------------------------------------------------------------
-- 5. Reading treasury
-- ---------------------------------------------------------------------------
create or replace function public.get_treasury_accounts()
returns setof public.treasury_account_status
language sql
stable
security definer
set search_path = ''
as $fn$
  select * from public.treasury_account_status
  where public.can_read_finance_master()
  order by is_active desc, account_type, name;
$fn$;

-- get_treasury_movements() names both source documents, so it is defined in
-- the supplier-payments migration once collection_settlements and
-- supplier_payments both exist. A sql-language body is parsed at creation, and
-- a forward reference here would fail rather than wait.

revoke all on function public.get_treasury_accounts() from public, anon;
revoke all on function public.treasury_account_balance(uuid) from public, anon;
grant execute on function public.get_treasury_accounts() to authenticated;
grant execute on function public.treasury_account_balance(uuid) to authenticated;
