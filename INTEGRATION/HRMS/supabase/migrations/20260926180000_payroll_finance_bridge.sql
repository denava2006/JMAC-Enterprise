-- ===========================================================================
-- F7B  Finance pays what HR finalized
-- ===========================================================================
--
-- WHAT THE AUDIT FOUND.
--
--   payroll_periods   the run: period_start, period_end, pay_date, frequency,
--                     status (payroll_status enum)
--   payroll_records   one row per employee: basic_salary, total_allowances,
--                     overtime_pay, gross_salary, the deduction columns,
--                     total_deductions, net_salary, plus SSS, PhilHealth and
--                     Pag-IBIG, and the attendance figures behind them
--   payroll_status    draft, generated, pending_approval, approved, released
--                     and rejected
--
--   recompute_payroll_period_status() sets a period to 'released' only when
--   every one of its records is released. So a released PERIOD is the
--   finalization boundary, and it is derived rather than typed by anyone.
--
--   payroll_records_self_select lets an employee read their own record only
--   once it is released, which confirms released is the published state.
--
--   payroll RLS is is_active_staff() -- admin or HR staff/manager. No Finance
--   role can read payroll_records at all today, and this migration does not
--   change that. Finance reads the snapshot instead.
--
-- FMS computes nothing. Every figure below is copied from the finalized HR
-- row at the moment of finalization, which is the whole point: Finance pays
-- what HR finalized, and can still show what that was a year later even if
-- somebody edits the source.

-- ---------------------------------------------------------------------------
-- 1. The batch
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_finance_batches (
  id uuid primary key default gen_random_uuid(),
  batch_no text,

  -- One Finance payable per HR run, enforced by the unique constraint rather
  -- than by whoever remembers to check. A retried finalization finds the row
  -- already there.
  source_payroll_period_id uuid not null unique
    references public.payroll_periods(id) on delete restrict,

  period_start date not null,
  period_end date not null,
  pay_date date,
  frequency text,

  employee_count integer not null check (employee_count >= 0),
  gross_total numeric(14,2) not null check (gross_total >= 0),
  deductions_total numeric(14,2) not null check (deductions_total >= 0),
  net_total numeric(14,2) not null check (net_total >= 0),

  -- When HR finalized, taken from the source rather than from now().
  source_finalized_at timestamptz,

  created_at timestamptz not null default now(),

  constraint payroll_finance_batches_period_order check (period_end >= period_start)
);

create unique index if not exists payroll_finance_batches_no_unique
  on public.payroll_finance_batches (batch_no) where batch_no is not null;

comment on table public.payroll_finance_batches is
  'An immutable financial snapshot of one finalized HR payroll period. Copied, '
  'never calculated -- Finance pays what HR finalized at that moment.';

-- ---------------------------------------------------------------------------
-- 2. The lines
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_finance_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null
    references public.payroll_finance_batches(id) on delete cascade,

  source_payroll_record_id uuid not null unique
    references public.payroll_records(id) on delete restrict,

  employee_id uuid not null references public.employees(id) on delete restrict,
  -- Snapshotted so a historical batch still reads correctly after a rename or
  -- a departure.
  employee_name text,

  gross_amount numeric(14,2) not null,
  deductions_amount numeric(14,2) not null,
  net_amount numeric(14,2) not null,

  created_at timestamptz not null default now()
);

create index if not exists payroll_finance_items_batch_idx
  on public.payroll_finance_items (batch_id);

comment on table public.payroll_finance_items is
  'Per-employee snapshot of a finalized payroll record. Unique on the source '
  'record, so one HR line can only ever appear once in Finance.';

-- ---------------------------------------------------------------------------
-- 3. Numbering
-- ---------------------------------------------------------------------------
create or replace function public.set_payroll_batch_no()
returns trigger language plpgsql set search_path = '' as $fn$
declare _year text := to_char(new.period_end, 'YYYY');
begin
  if new.batch_no is null then
    new.batch_no := 'PY-' || _year || '-' || lpad((
      select count(*) + 1 from public.payroll_finance_batches
       where batch_no like 'PY-' || _year || '-%'
    )::text, 4, '0');
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_payroll_batch_no on public.payroll_finance_batches;
create trigger trg_payroll_batch_no
  before insert on public.payroll_finance_batches
  for each row execute function public.set_payroll_batch_no();

-- ---------------------------------------------------------------------------
-- 4. The handoff
-- ---------------------------------------------------------------------------
--
-- Idempotent by construction: the unique constraint on
-- source_payroll_period_id decides, so a retried or repeated finalization
-- inserts nothing the second time rather than relying on a check that could
-- race. The function is safe to call at any time and on any period.
--
-- Nothing is calculated. sum() over the finalized rows is a copy of what HR
-- already computed, taken once, at the moment the period became released.
create or replace function public.build_payroll_finance_batch(_period_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _period public.payroll_periods%rowtype;
  _batch_id uuid;
  _count integer;
begin
  select * into _period from public.payroll_periods where id = _period_id;
  if _period.id is null then
    return null;
  end if;

  -- Only a finalized period becomes a payable. HR owns that judgement, and
  -- 'released' is how it says so.
  if _period.status <> 'released' then
    return null;
  end if;

  select id into _batch_id from public.payroll_finance_batches
   where source_payroll_period_id = _period_id;
  if _batch_id is not null then
    return _batch_id;
  end if;

  select count(*) into _count from public.payroll_records
   where payroll_period_id = _period_id and status = 'released';
  if _count = 0 then
    return null;
  end if;

  insert into public.payroll_finance_batches (
    source_payroll_period_id, period_start, period_end, pay_date, frequency,
    employee_count, gross_total, deductions_total, net_total, source_finalized_at
  )
  select
    _period_id, _period.period_start, _period.period_end, _period.pay_date,
    _period.frequency,
    count(*)::integer,
    coalesce(sum(r.gross_salary), 0),
    coalesce(sum(r.total_deductions), 0),
    coalesce(sum(r.net_salary), 0),
    max(r.released_at)
  from public.payroll_records r
  where r.payroll_period_id = _period_id and r.status = 'released'
  returning id into _batch_id;

  insert into public.payroll_finance_items (
    batch_id, source_payroll_record_id, employee_id, employee_name,
    gross_amount, deductions_amount, net_amount
  )
  select
    _batch_id, r.id, r.employee_id,
    nullif(btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')), ''),
    r.gross_salary, r.total_deductions, r.net_salary
  from public.payroll_records r
  left join public.employees e on e.id = r.employee_id
  where r.payroll_period_id = _period_id and r.status = 'released';

  insert into public.audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
  values (
    (select auth.uid()),
    'Payroll finance snapshot created',
    'payroll_finance_batches',
    _batch_id,
    jsonb_build_object('source_payroll_period_id', _period_id),
    (select jsonb_build_object(
       'batch_no', b.batch_no, 'period_start', b.period_start, 'period_end', b.period_end,
       'employee_count', b.employee_count, 'gross_total', b.gross_total,
       'deductions_total', b.deductions_total, 'net_total', b.net_total)
     from public.payroll_finance_batches b where b.id = _batch_id)
  );

  return _batch_id;
end;
$fn$;

-- Fired when a period reaches released. A trigger rather than an edit to the
-- HR finalization path: recompute_payroll_period_status() is what actually
-- decides a period is finalized, and hanging the handoff off its result means
-- every route that finalizes -- one record at a time, or in bulk -- reaches
-- Finance the same way.
create or replace function public.handoff_payroll_to_finance()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  if new.status = 'released' and old.status is distinct from 'released' then
    perform public.build_payroll_finance_batch(new.id);
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_payroll_handoff on public.payroll_periods;
create trigger trg_payroll_handoff
  after update on public.payroll_periods
  for each row execute function public.handoff_payroll_to_finance();

-- ---------------------------------------------------------------------------
-- 5. The snapshot is a snapshot
-- ---------------------------------------------------------------------------
--
-- Nothing rewrites it. HR remains free to correct payroll under its own rules;
-- what it must not do is silently restate a figure Finance has already paid
-- against. Since the snapshot is never resynced, divergence cannot happen
-- quietly -- and the batch itself is immutable so nobody can bring it into
-- line by hand either.
create or replace function public.guard_payroll_snapshot_immutable()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception 'A payroll finance snapshot records what HR finalized and cannot be % .',
    case when tg_op = 'DELETE' then 'deleted' else 'changed' end
    using errcode = 'insufficient_privilege';
end;
$fn$;

drop trigger if exists trg_payroll_batch_immutable on public.payroll_finance_batches;
create trigger trg_payroll_batch_immutable
  before update or delete on public.payroll_finance_batches
  for each row execute function public.guard_payroll_snapshot_immutable();

drop trigger if exists trg_payroll_item_immutable on public.payroll_finance_items;
create trigger trg_payroll_item_immutable
  before update or delete on public.payroll_finance_items
  for each row execute function public.guard_payroll_snapshot_immutable();

-- ---------------------------------------------------------------------------
-- 6. Who may read a payroll payable
-- ---------------------------------------------------------------------------
--
-- The batch totals are what Finance needs in order to pay: a period, a head
-- count, and a net payable. Every Finance role may see that.
--
-- The per-employee lines are salary data, and payroll RLS today admits only
-- HR staff and administrators. Finance Staff review reimbursements; that is
-- not a reason to hand them everybody's salary. So the lines are limited to
-- the two roles that actually execute the payment, plus HR and admin, who
-- already had them at source.
alter table public.payroll_finance_batches enable row level security;
alter table public.payroll_finance_items enable row level security;

drop policy if exists payroll_finance_batches_read on public.payroll_finance_batches;
create policy payroll_finance_batches_read on public.payroll_finance_batches
  for select to authenticated
  using (public.can_read_finance_master() or public.is_active_staff());

drop policy if exists payroll_finance_items_read on public.payroll_finance_items;
create policy payroll_finance_items_read on public.payroll_finance_items
  for select to authenticated
  using (
    public.is_active_staff()
    or public.has_finance_privilege(array['accountant', 'finance_manager'])
  );

-- No INSERT policy on either table. They are written only by
-- build_payroll_finance_batch, which runs security definer from the
-- finalization trigger. A Finance user with a SQL client cannot invent a
-- payroll payable.
