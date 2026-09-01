-- FMS F2 — Finance master data.
--
-- The records every later finance module refers to: what money is classified
-- as, who it is paid to, which account it moves through, and what was approved
-- to be spent. No workflow, no postings, no procurement — those are later
-- phases and this migration deliberately gives them nothing to lean on early.
--
-- Names were chosen after comparing the standalone FMS schema against the live
-- JMAC schema rather than ported:
--
--   categories  -> finance_categories   'categories' is ambiguous next to
--                                       pos_product_categories, which is a
--                                       different taxonomy entirely.
--   accounts    -> finance_accounts     'account' already means a LOGIN in
--                                       JMAC (create-employee-account, account
--                                       status, "This employee already has an
--                                       account"). A bare `accounts` table
--                                       would read as user accounts.
--   vendors     -> vendors              No collision and no ambiguity. The
--                                       domain term is kept.
--   budgets, budget_allocations         No collision, no ambiguity. Kept.
--
-- Identity stays JMAC's. departments, profiles, employees and branches are
-- reused as they are; the standalone FMS profiles/departments/auth tables are
-- not ported in any form.

-- ---------------------------------------------------------------- read access
-- Used by the SELECT policy on every table below. Finance people read finance
-- master data; the Administrator reads it for oversight and writes none of it.
-- Stated once so "who may look at Finance" cannot drift between six tables.
create or replace function public.can_read_finance_master()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.is_active_finance() or public.is_admin();
$fn$;

revoke all on function public.can_read_finance_master() from public, anon;
grant execute on function public.can_read_finance_master() to authenticated;

-- ------------------------------------------------------------- server actor
-- created_by is stamped from the session, never accepted from the client. A
-- caller cannot claim somebody else prepared a record.
create or replace function public.stamp_finance_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  new.created_by := (select auth.uid());
  return new;
end;
$fn$;

revoke all on function public.stamp_finance_actor() from public, anon, authenticated;

-- =========================================================================
-- finance_categories — how money is classified
-- =========================================================================
-- Separate from pos_product_categories on purpose. That taxonomy answers "what
-- shelf is this on"; this one answers "what kind of money is this". A product
-- category has a price and a branch; a finance category has a statement side.
create table if not exists public.finance_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- Text with a check rather than an enum. Adding a value to a Postgres enum
  -- cannot be used in the transaction that adds it, which cost F1 a migration
  -- of its own; a check constraint is altered and used freely.
  kind        text not null check (kind in ('income', 'expense')),
  description text,
  is_active   boolean not null default true,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists finance_categories_name_kind
  on public.finance_categories (lower(name), kind);

-- =========================================================================
-- vendors — who the company pays
-- =========================================================================
create table if not exists public.vendors (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  contact_person text,
  email          text,
  phone          text,
  address        text,
  tin            text,
  notes          text,
  is_active      boolean not null default true,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists vendors_name_unique
  on public.vendors (lower(name));

-- What each vendor actually supplies. Many-to-many because a stationery
-- supplier can also sell equipment, and a vendor with no categories is a
-- general supplier that stays available everywhere.
--
-- This is the standalone vendor/category relationship, preserved. It is NOT
-- supplier_products: product-level sourcing belongs to procurement, if that
-- workflow ever genuinely needs it.
create table if not exists public.vendor_categories (
  vendor_id            uuid not null references public.vendors(id) on delete cascade,
  finance_category_id  uuid not null references public.finance_categories(id) on delete cascade,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  primary key (vendor_id, finance_category_id)
);

create index if not exists vendor_categories_category_idx
  on public.vendor_categories (finance_category_id);

-- =========================================================================
-- finance_accounts — the chart of accounts
-- =========================================================================
-- The standalone table was audited against what JMAC will need and found
-- insufficient. It had one free-text column:
--
--   account_type text not null default 'bank'  -- asset|liability|equity|revenue|expense|bank
--
-- which mixes two different questions. 'bank' is not a peer of 'asset' — a bank
-- account IS an asset, and putting both in one column means the statement side
-- is unknowable for any row that chose the other vocabulary. It also leaves no
-- way to tell a PayMongo receivable from any other asset, or payroll payable
-- from any other liability, which are exactly the two rows later phases need.
--
-- So: account_type is the statement classification, account_subtype is the
-- instrument, and the pair is constrained together.
create table if not exists public.finance_accounts (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  account_code text,
  account_type text not null
    check (account_type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  account_subtype text not null,
  currency     text not null default 'PHP',
  -- A stated fact with a date, not a running total. The standalone table kept a
  -- mutable `balance` that nothing posted to -- a number anyone could type and
  -- nobody could reconcile. The current balance becomes derivable when the
  -- journal arrives; until then this says what was true on a given day and
  -- makes no claim about today.
  opening_balance       numeric(14,2) not null default 0,
  opening_balance_as_of date,
  is_active    boolean not null default true,
  notes        text,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint finance_accounts_subtype_matches_type check (
    (account_type = 'asset'     and account_subtype in ('bank', 'cash', 'e_wallet', 'receivable', 'other')) or
    (account_type = 'liability' and account_subtype in ('payable', 'accrual', 'other')) or
    (account_type = 'equity'    and account_subtype in ('other')) or
    (account_type = 'revenue'   and account_subtype in ('operating', 'other')) or
    (account_type = 'expense'   and account_subtype in ('operating', 'other'))
  ),
  constraint finance_accounts_opening_balance_dated check (
    opening_balance = 0 or opening_balance_as_of is not null
  )
);

create unique index if not exists finance_accounts_code_unique
  on public.finance_accounts (upper(account_code))
  where account_code is not null;

create unique index if not exists finance_accounts_name_unique
  on public.finance_accounts (lower(name));

comment on table public.finance_accounts is
  'Chart of accounts. Master records only in F2 -- no postings, and no derived '
  'balance until a journal exists to derive it from. asset/receivable carries a '
  'later PayMongo receivable; liability/payable carries a later payroll payable.';

-- =========================================================================
-- budgets — what was approved to be spent
-- =========================================================================
create table if not exists public.budgets (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  department_id uuid references public.departments(id) on delete restrict,
  finance_category_id uuid references public.finance_categories(id) on delete restrict,
  period        text not null default 'monthly'
    check (period in ('monthly', 'quarterly', 'yearly')),
  fiscal_year   integer not null default extract(year from current_date)::integer,
  -- The approved ceiling. One number, set by one authority.
  amount        numeric(14,2) not null default 0 check (amount >= 0),
  start_date    date,
  end_date      date,
  status        text not null default 'draft'
    check (status in ('draft', 'active', 'closed')),
  alert_threshold integer not null default 80
    check (alert_threshold between 1 and 100),
  approved_by   uuid references public.profiles(id) on delete set null,
  approved_at   timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint budgets_period_dates check (end_date is null or start_date is null or end_date >= start_date)
);

create unique index if not exists budgets_name_year_unique
  on public.budgets (lower(name), fiscal_year);

create index if not exists budgets_department_idx on public.budgets (department_id);

-- =========================================================================
-- budget_allocations — portions drawn against a ceiling
-- =========================================================================
create table if not exists public.budget_allocations (
  id           uuid primary key default gen_random_uuid(),
  budget_id    uuid not null references public.budgets(id) on delete cascade,
  amount       numeric(14,2) not null check (amount > 0),
  allocated_to text not null,
  reference    text,
  note         text,
  -- Released rather than deleted. Who committed what against which budget, and
  -- when, is the point of having a budget at all.
  status       text not null default 'active' check (status in ('active', 'released')),
  released_at  timestamptz,
  released_by  uuid references public.profiles(id) on delete set null,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint budget_allocations_release_is_stamped check (
    (status = 'active'   and released_at is null) or
    (status = 'released' and released_at is not null)
  )
);

create index if not exists budget_allocations_budget_idx
  on public.budget_allocations (budget_id) where status = 'active';

-- ------------------------------------------------ the ceiling is a ceiling
-- Active allocations may not exceed the approved amount, and nothing may be
-- drawn against a budget that is not active. In the database rather than in the
-- form, so it holds for every client that ever writes here.
create or replace function public.enforce_budget_ceiling()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _budget record;
  _active numeric(14,2);
begin
  -- Locked: two allocations submitted at the same moment must not both read the
  -- pre-draw total and both fit.
  select id, amount, status, name into _budget
  from public.budgets where id = new.budget_id for update;

  if _budget.id is null then
    raise exception 'That budget no longer exists.' using errcode = 'foreign_key_violation';
  end if;

  if new.status = 'active' and _budget.status <> 'active' then
    raise exception 'Budget "%" is %, so nothing can be drawn against it.',
      _budget.name, _budget.status
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into _active
  from public.budget_allocations
  where budget_id = new.budget_id
    and status = 'active'
    and id <> new.id;

  if new.status = 'active' and _active + new.amount > _budget.amount then
    raise exception
      'Allocating % would put budget "%" over its approved ceiling of % (% already allocated).',
      to_char(new.amount, 'FM999,999,999.00'),
      _budget.name,
      to_char(_budget.amount, 'FM999,999,999.00'),
      to_char(_active, 'FM999,999,999.00')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

revoke all on function public.enforce_budget_ceiling() from public, anon, authenticated;

drop trigger if exists trg_budget_allocations_ceiling on public.budget_allocations;
create trigger trg_budget_allocations_ceiling
  before insert or update of amount, budget_id, status on public.budget_allocations
  for each row execute function public.enforce_budget_ceiling();

-- --------------------------------------------- a closed ceiling stays closed
create or replace function public.protect_closed_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if old.status = 'closed' and new.amount is distinct from old.amount then
    raise exception 'Budget "%" is closed; its approved amount cannot be changed.', old.name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

revoke all on function public.protect_closed_budget() from public, anon, authenticated;

drop trigger if exists trg_budgets_protect_closed on public.budgets;
create trigger trg_budgets_protect_closed
  before update on public.budgets
  for each row execute function public.protect_closed_budget();

-- =========================================================================
-- budget_status — the four numbers a budget has
-- =========================================================================
-- The standalone system's useful distinction, preserved. Two of the four have
-- no source yet and say so rather than being quietly omitted:
--
--   ceiling     what was approved                      set here, in F2
--   allocated   portioned out                          sum of active allocations, F2
--   reserved    committed but not yet paid             the request pipeline, later
--   spent       actually disbursed                     the payment pipeline, later
--
-- reserved and spent are zero because nothing in JMAC can yet produce either
-- number -- not because the concept was dropped. When those phases land they
-- replace the literals here and every consumer of this view keeps working.
create or replace view public.budget_status
with (security_invoker = true) as
select
  b.id,
  b.name,
  b.department_id,
  d.name as department_name,
  b.finance_category_id,
  c.name as finance_category_name,
  b.period,
  b.fiscal_year,
  b.amount,
  coalesce(a.allocated, 0)::numeric(14,2) as allocated,
  0::numeric(14,2) as reserved,
  0::numeric(14,2) as spent,
  (b.amount - coalesce(a.allocated, 0))::numeric(14,2) as unallocated,
  (b.amount - 0 - 0)::numeric(14,2) as remaining,
  case when b.amount > 0
       then round((coalesce(a.allocated, 0) / b.amount) * 100)::integer
       else 0 end as allocated_pct,
  b.start_date,
  b.end_date,
  b.status,
  b.alert_threshold,
  b.approved_by,
  b.approved_at,
  b.created_by,
  b.created_at,
  b.updated_at
from public.budgets b
left join public.departments d on d.id = b.department_id
left join public.finance_categories c on c.id = b.finance_category_id
left join lateral (
  select sum(amount) as allocated
  from public.budget_allocations al
  where al.budget_id = b.id and al.status = 'active'
) a on true;

-- =========================================================================
-- Row level security
-- =========================================================================
-- Every policy is TO authenticated. A {public} policy calling a function anon
-- cannot execute raises 42501 and fails the whole request for every table in
-- scope -- a defect this project has already paid for once.
alter table public.finance_categories  enable row level security;
alter table public.vendors             enable row level security;
alter table public.vendor_categories   enable row level security;
alter table public.finance_accounts    enable row level security;
alter table public.budgets             enable row level security;
alter table public.budget_allocations  enable row level security;

-- ------------------------------------------------------ finance_categories
drop policy if exists finance_categories_read on public.finance_categories;
create policy finance_categories_read on public.finance_categories
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists finance_categories_curate on public.finance_categories;
create policy finance_categories_curate on public.finance_categories
  for insert to authenticated
  with check (public.has_finance_privilege(array['finance_staff', 'finance_manager']));

drop policy if exists finance_categories_edit on public.finance_categories;
create policy finance_categories_edit on public.finance_categories
  for update to authenticated
  using (public.has_finance_privilege(array['finance_staff', 'finance_manager']))
  with check (
    -- Archiving changes how past classifications read, so it is the Manager's.
    public.has_finance_privilege(array['finance_manager'])
    or (is_active and public.has_finance_privilege(array['finance_staff']))
  );

-- ----------------------------------------------------------------- vendors
drop policy if exists vendors_read on public.vendors;
create policy vendors_read on public.vendors
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists vendors_curate on public.vendors;
create policy vendors_curate on public.vendors
  for insert to authenticated
  with check (public.has_finance_privilege(array['finance_staff', 'finance_manager']));

drop policy if exists vendors_edit on public.vendors;
create policy vendors_edit on public.vendors
  for update to authenticated
  using (public.has_finance_privilege(array['finance_staff', 'finance_manager']))
  with check (
    public.has_finance_privilege(array['finance_manager'])
    or (is_active and public.has_finance_privilege(array['finance_staff']))
  );

-- -------------------------------------------------------- vendor_categories
drop policy if exists vendor_categories_read on public.vendor_categories;
create policy vendor_categories_read on public.vendor_categories
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists vendor_categories_link on public.vendor_categories;
create policy vendor_categories_link on public.vendor_categories
  for insert to authenticated
  with check (public.has_finance_privilege(array['finance_staff', 'finance_manager']));

-- A link row has nothing to edit: it exists or it does not.
drop policy if exists vendor_categories_unlink on public.vendor_categories;
create policy vendor_categories_unlink on public.vendor_categories
  for delete to authenticated
  using (public.has_finance_privilege(array['finance_staff', 'finance_manager']));

-- --------------------------------------------------------- finance_accounts
-- The narrowest module in Finance. The chart of accounts has a single owner.
drop policy if exists finance_accounts_read on public.finance_accounts;
create policy finance_accounts_read on public.finance_accounts
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists finance_accounts_write on public.finance_accounts;
create policy finance_accounts_write on public.finance_accounts
  for insert to authenticated
  with check (public.has_finance_privilege(array['accountant']));

drop policy if exists finance_accounts_edit on public.finance_accounts;
create policy finance_accounts_edit on public.finance_accounts
  for update to authenticated
  using (public.has_finance_privilege(array['accountant']))
  with check (public.has_finance_privilege(array['accountant']));

-- ----------------------------------------------------------------- budgets
-- Budget authority is the Finance Manager's, and nobody else's. Not the
-- Administrator's: an account that grants finance privilege and also sets the
-- ceilings those officers work under is not oversight.
drop policy if exists budgets_read on public.budgets;
create policy budgets_read on public.budgets
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists budgets_write on public.budgets;
create policy budgets_write on public.budgets
  for insert to authenticated
  with check (public.has_finance_privilege(array['finance_manager']));

drop policy if exists budgets_edit on public.budgets;
create policy budgets_edit on public.budgets
  for update to authenticated
  using (public.has_finance_privilege(array['finance_manager']))
  with check (public.has_finance_privilege(array['finance_manager']));

-- -------------------------------------------------------- budget_allocations
drop policy if exists budget_allocations_read on public.budget_allocations;
create policy budget_allocations_read on public.budget_allocations
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists budget_allocations_draw on public.budget_allocations;
create policy budget_allocations_draw on public.budget_allocations
  for insert to authenticated
  with check (public.has_finance_privilege(array['finance_staff', 'finance_manager']));

drop policy if exists budget_allocations_edit on public.budget_allocations;
create policy budget_allocations_edit on public.budget_allocations
  for update to authenticated
  using (
    public.has_finance_privilege(array['finance_manager'])
    -- Staff may correct their OWN draw while it is still active. Releasing
    -- returns money to the ceiling, so it belongs to the ceiling's authority.
    or (status = 'active'
        and created_by = (select auth.uid())
        and public.has_finance_privilege(array['finance_staff']))
  )
  with check (
    public.has_finance_privilege(array['finance_manager'])
    or (status = 'active'
        and created_by = (select auth.uid())
        and public.has_finance_privilege(array['finance_staff']))
  );

-- =========================================================================
-- Table privileges
-- =========================================================================
-- Supabase grants anon and authenticated full DML on public by default, and
-- every earlier JMAC table inherited that -- protected by RLS alone. These
-- tables do not: anon is revoked outright, so an unauthenticated request is
-- refused by the grant before any policy is consulted, and authenticated gets
-- only the verbs its policies can ever satisfy.
--
-- Nothing here may be deleted. Master data is archived, released or closed,
-- because a vendor that was paid and a budget that was drawn against are part
-- of the record.
revoke all on public.finance_categories  from anon, public;
revoke all on public.vendors             from anon, public;
revoke all on public.vendor_categories   from anon, public;
revoke all on public.finance_accounts    from anon, public;
revoke all on public.budgets             from anon, public;
revoke all on public.budget_allocations  from anon, public;
revoke all on public.budget_status       from anon, public;

revoke all on public.finance_categories  from authenticated;
revoke all on public.vendors             from authenticated;
revoke all on public.vendor_categories   from authenticated;
revoke all on public.finance_accounts    from authenticated;
revoke all on public.budgets             from authenticated;
revoke all on public.budget_allocations  from authenticated;
revoke all on public.budget_status       from authenticated;

grant select, insert, update on public.finance_categories  to authenticated;
grant select, insert, update on public.vendors             to authenticated;
grant select, insert, delete on public.vendor_categories   to authenticated;
grant select, insert, update on public.finance_accounts    to authenticated;
grant select, insert, update on public.budgets             to authenticated;
grant select, insert, update on public.budget_allocations  to authenticated;
grant select                 on public.budget_status       to authenticated;

grant all on public.finance_categories  to service_role;
grant all on public.vendors             to service_role;
grant all on public.vendor_categories   to service_role;
grant all on public.finance_accounts    to service_role;
grant all on public.budgets             to service_role;
grant all on public.budget_allocations  to service_role;
grant select on public.budget_status    to service_role;

-- =========================================================================
-- Triggers
-- =========================================================================
drop trigger if exists trg_set_updated_at on public.finance_categories;
create trigger trg_set_updated_at before update on public.finance_categories
  for each row execute function public.set_updated_at();

drop trigger if exists trg_set_updated_at on public.vendors;
create trigger trg_set_updated_at before update on public.vendors
  for each row execute function public.set_updated_at();

drop trigger if exists trg_set_updated_at on public.finance_accounts;
create trigger trg_set_updated_at before update on public.finance_accounts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_set_updated_at on public.budgets;
create trigger trg_set_updated_at before update on public.budgets
  for each row execute function public.set_updated_at();

drop trigger if exists trg_set_updated_at on public.budget_allocations;
create trigger trg_set_updated_at before update on public.budget_allocations
  for each row execute function public.set_updated_at();

drop trigger if exists trg_stamp_actor on public.finance_categories;
create trigger trg_stamp_actor before insert on public.finance_categories
  for each row execute function public.stamp_finance_actor();

drop trigger if exists trg_stamp_actor on public.vendors;
create trigger trg_stamp_actor before insert on public.vendors
  for each row execute function public.stamp_finance_actor();

drop trigger if exists trg_stamp_actor on public.vendor_categories;
create trigger trg_stamp_actor before insert on public.vendor_categories
  for each row execute function public.stamp_finance_actor();

drop trigger if exists trg_stamp_actor on public.finance_accounts;
create trigger trg_stamp_actor before insert on public.finance_accounts
  for each row execute function public.stamp_finance_actor();

drop trigger if exists trg_stamp_actor on public.budgets;
create trigger trg_stamp_actor before insert on public.budgets
  for each row execute function public.stamp_finance_actor();

drop trigger if exists trg_stamp_actor on public.budget_allocations;
create trigger trg_stamp_actor before insert on public.budget_allocations
  for each row execute function public.stamp_finance_actor();

-- =========================================================================
-- The expense taxonomy JMAC actually needs
-- =========================================================================
-- Adapted, not ported. The standalone reference data describes a consulting
-- firm -- 'Consulting Fees', 'Bookkeeping Services', 'Tax Preparation' as
-- INCOME -- which is not what JMAC Enterprise sells. A taxonomy is a
-- classification rather than a business fact, so a sensible starting set is
-- seeded here; vendors and accounts are NOT, because supplier names, TINs,
-- bank account numbers and balances are real-world facts nobody has stated.
insert into public.finance_categories (name, kind, description)
select v.name, v.kind, v.description
from (values
  ('Retail Sales',              'income',  'Revenue from branch sales.'),
  ('Other Income',              'income',  'Miscellaneous income.'),
  ('Cost of Goods Sold',        'expense', 'Purchase cost of merchandise sold.'),
  ('Office Supplies',           'expense', 'Stationery, consumables and office materials.'),
  ('Equipment & Hardware',      'expense', 'Computers, fixtures and branch equipment.'),
  ('Software & Subscriptions',  'expense', 'Software licences and recurring services.'),
  ('Utilities',                 'expense', 'Electricity, water, internet and phone.'),
  ('Rent & Facilities',         'expense', 'Branch and office rent, facility costs.'),
  ('Transportation & Delivery', 'expense', 'Fuel, freight and delivery of goods.'),
  ('Repairs & Maintenance',     'expense', 'Upkeep of premises and equipment.'),
  ('Professional Fees',         'expense', 'Legal, audit and outsourced professional fees.'),
  ('Training & Development',    'expense', 'Seminars, training and certifications.'),
  ('Meals & Representation',    'expense', 'Client meals and representation.'),
  ('Miscellaneous',             'expense', 'Other operating expenses.')
) as v(name, kind, description)
where not exists (
  select 1 from public.finance_categories fc
  where lower(fc.name) = lower(v.name) and fc.kind = v.kind
);

-- =========================================================================
-- Finance must be able to name a department
-- =========================================================================
-- A budget belongs to a department, so the Finance Manager setting one has to
-- read the list. The existing SELECT policies on departments cover HR
-- (is_active_staff) and plain employees (is_active_employee, which requires
-- role = 'employee') -- a Finance Manager satisfies neither, and the picker
-- would have come up empty with no error to explain it.
--
-- The same shape as the two policies already there: additive, TO authenticated,
-- and read-only. Finance names departments; it does not maintain them.
drop policy if exists departments_finance_select on public.departments;
create policy departments_finance_select on public.departments
  for select to authenticated using (public.is_active_finance());
