-- ===========================================================================
-- F7A  Paying an employee back
-- ===========================================================================
--
-- WHAT THE AUDIT FOUND, because it decided that this file is small.
--
-- The reimbursement domain already exists and is authoritative:
--
--   finance_requests.type has 'reimbursement' as a first-class value
--   expense_date exists, with a CHECK tying it to that type alone
--   the workflow is draft -> pending_validation -> pending_approval ->
--     approved, with returned, rejected and cancelled
--   RLS already lets an employee amend only their own draft or returned row,
--     lets finance_staff classify at pending_validation, and lets the Finance
--     Manager decide at pending_approval
--   budget_status.reserved already counts approved finance_requests -- both
--     types, no filter
--   finance_request_attachments and the finance-request-documents private
--     bucket already hold the evidence
--   the employee already files one from My Requests
--
-- So a new employee_reimbursements table would not be a new domain. It would
-- be a second one, and the brief is explicit that the same reimbursement must
-- never become two reservation sources. Everything below extends what is
-- there.
--
-- What is genuinely missing is the settlement half. transition_finance_request
-- refuses 'completed' today with this message:
--
--   'A request cannot be completed yet: completion means settlement, and no
--    procurement, invoice or payment record exists in JMAC to settle it.'
--
-- That was written anticipating this phase. This file supplies the payment
-- record it was waiting for, built on the supplier-payment architecture that
-- F6 proved rather than a second opinion about how payment works.

-- ---------------------------------------------------------------------------
-- 1. The payment
-- ---------------------------------------------------------------------------
create table if not exists public.reimbursement_payments (
  id uuid primary key default gen_random_uuid(),
  payment_no text,

  finance_request_id uuid not null
    references public.finance_requests(id) on delete restrict,
  treasury_account_id uuid not null
    references public.treasury_accounts(id) on delete restrict,

  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('bank_transfer', 'cash', 'cheque', 'other')),

  -- A calendar date, known only once the money has actually gone. Never
  -- defaulted from a UTC clock: see F6's date correction.
  payment_date date,
  reference text,
  notes text,

  status text not null default 'draft'
    check (status in ('draft', 'for_approval', 'approved', 'paid', 'returned', 'rejected')),

  prepared_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  paid_by uuid references public.profiles(id) on delete set null,
  paid_at timestamptz,
  decision_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint reimbursement_payments_paid_has_evidence check (
    status <> 'paid' or (payment_date is not null and paid_at is not null)
  )
);

-- The query paths that actually exist: every payment for one request, and the
-- Finance Manager's queue of things awaiting a decision.
create index if not exists reimbursement_payments_request_idx
  on public.reimbursement_payments (finance_request_id, status);
create index if not exists reimbursement_payments_status_idx
  on public.reimbursement_payments (status) where status in ('for_approval', 'approved');

create unique index if not exists reimbursement_payments_no_unique
  on public.reimbursement_payments (payment_no) where payment_no is not null;

-- The same external transfer cannot be recorded twice against one account.
-- Returned and rejected are excluded so a corrected record may reuse the
-- real-world reference of the attempt it replaces.
create unique index if not exists reimbursement_payments_reference_unique
  on public.reimbursement_payments (treasury_account_id, upper(btrim(reference)))
  where reference is not null and btrim(reference) <> ''
    and status not in ('returned', 'rejected');

comment on table public.reimbursement_payments is
  'Payment of an approved employee reimbursement. Only status = paid moves a '
  'treasury balance or turns reserved budget into spent.';

-- ---------------------------------------------------------------------------
-- 2. Numbering, following the house pattern
-- ---------------------------------------------------------------------------
create or replace function public.set_reimbursement_payment_no()
returns trigger language plpgsql set search_path = '' as $fn$
declare _year text := to_char(public.pos_business_date(), 'YYYY');
begin
  if new.payment_no is null then
    new.payment_no := 'RV-' || _year || '-' || lpad((
      select count(*) + 1 from public.reimbursement_payments
       where payment_no like 'RV-' || _year || '-%'
    )::text, 4, '0');
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_reimbursement_payment_no on public.reimbursement_payments;
create trigger trg_reimbursement_payment_no
  before insert on public.reimbursement_payments
  for each row execute function public.set_reimbursement_payment_no();

-- ---------------------------------------------------------------------------
-- 3. What a reimbursement owes, and what is already claimed
-- ---------------------------------------------------------------------------
create or replace function public.reimbursement_paid(_request_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(sum(p.amount), 0)::numeric(14,2)
  from public.reimbursement_payments p
  where p.finance_request_id = _request_id and p.status = 'paid';
$fn$;

-- Live instructions: prepared, awaiting a decision, or authorised but not yet
-- sent. 'paid' is excluded because it is counted as paid instead -- money must
-- never be both claimed and settled. Returned and rejected release their hold.
create or replace function public.reimbursement_pending_payment(_request_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(sum(p.amount), 0)::numeric(14,2)
  from public.reimbursement_payments p
  where p.finance_request_id = _request_id
    and p.status in ('draft', 'for_approval', 'approved');
$fn$;

comment on function public.reimbursement_pending_payment(uuid) is
  'Money already claimed by live reimbursement payment instructions. The F6 '
  'lesson: what is owed and what is claimed are different questions.';

-- ---------------------------------------------------------------------------
-- 4. The single budget integration point
-- ---------------------------------------------------------------------------
--
-- finance_request_paid() is what budget_status already subtracts from an
-- approved request's reservation. Extending it here means reimbursement
-- payments join the existing arithmetic at exactly one place, rather than
-- adding a parallel term that could drift.
--
-- A request is settled either through procurement (a purchase order raised
-- from it, invoiced and paid) or directly (an employee reimbursed). Both are
-- money paid against the same request, so both belong in the same sum.
create or replace function public.finance_request_paid(_finance_request_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select (
    -- Settled through procurement.
    coalesce((
      select sum(p.amount)
      from public.supplier_payments p
      join public.supplier_invoices si on si.id = p.supplier_invoice_id
      join public.purchase_order_sources s on s.purchase_order_id = si.purchase_order_id
      where s.finance_request_id = _finance_request_id
        and p.status = 'paid'
    ), 0)
    +
    -- Settled by paying the employee back.
    coalesce((
      select sum(p.amount)
      from public.reimbursement_payments p
      where p.finance_request_id = _finance_request_id
        and p.status = 'paid'
    ), 0)
  )::numeric(14,2);
$fn$;

comment on function public.finance_request_paid(uuid) is
  'Money paid against a finance request, by whichever route -- a purchase '
  'order raised from it, or a direct reimbursement to the employee. One sum, '
  'so budget_status subtracts it once.';

-- ---------------------------------------------------------------------------
-- 5. Spent, extended by the same single term
-- ---------------------------------------------------------------------------
--
-- reserved already nets off finance_request_paid(), so section 4 above makes
-- reimbursement payments release their reservation with no change here. spent
-- needs the matching addition: a reimbursement paid from a budget is that
-- budget being spent.
create or replace view public.budget_status
with (security_invoker = on) as
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
    (coalesce(r.reserved, 0) + coalesce(p.committed, 0))::numeric(14,2) as reserved,
    coalesce(sp.spent, 0)::numeric(14,2) as spent,
    (b.amount - coalesce(a.allocated, 0))::numeric(14,2) as unallocated,
    (b.amount - coalesce(r.reserved, 0) - coalesce(p.committed, 0)
       - coalesce(sp.spent, 0))::numeric(14,2) as remaining,
    case
      when b.amount > 0 then round(coalesce(a.allocated, 0) / b.amount * 100)::integer
      else 0
    end as allocated_pct,
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
  left join departments d on d.id = b.department_id
  left join finance_categories c on c.id = b.finance_category_id
  left join lateral (
    select sum(al.amount) as allocated
    from public.budget_allocations al
    where al.budget_id = b.id and al.status = 'active'
  ) a on true
  -- Approved requests -- purchases and reimbursements alike -- less whatever
  -- has actually been paid against them. Unchanged in shape; it simply sees
  -- reimbursement payments now, through finance_request_paid.
  left join lateral (
    select sum(greatest(fr.amount - public.finance_request_paid(fr.id), 0)) as reserved
    from public.finance_requests fr
    where fr.budget_id = b.id and fr.status = 'approved'
  ) r on true
  left join lateral (
    select sum(greatest(
      public.purchase_order_commitment(po.id) - public.purchase_order_paid(po.id), 0
    )) as committed
    from public.purchase_orders po
    where po.budget_id = b.id
      and po.status in ('approved', 'closed')
      and not exists (
        select 1 from public.purchase_order_sources s
        where s.purchase_order_id = po.id and s.finance_request_id is not null
      )
  ) p on true
  -- Spent, from both settlement routes. A supplier payment whose order draws
  -- on this budget, and a reimbursement whose request draws on it.
  left join lateral (
    select
      coalesce((
        select sum(pay.amount)
        from public.supplier_payments pay
        join public.supplier_invoices si on si.id = pay.supplier_invoice_id
        join public.purchase_orders po on po.id = si.purchase_order_id
        where pay.status = 'paid' and po.budget_id = b.id
      ), 0)
      +
      coalesce((
        select sum(rp.amount)
        from public.reimbursement_payments rp
        join public.finance_requests fr on fr.id = rp.finance_request_id
        where rp.status = 'paid' and fr.budget_id = b.id
      ), 0) as spent
  ) sp on true;

comment on view public.budget_status is
  'Ceiling, reserved and spent, all derived. Reserved falls by exactly what '
  'spent rises by when a payment completes -- supplier or reimbursement -- so '
  'remaining does not move.';

-- ---------------------------------------------------------------------------
-- 6. Guards, and who may act
-- ---------------------------------------------------------------------------
create or replace function public.guard_reimbursement_payment_edit()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if tg_op = 'INSERT' then
    new.status := 'draft';
    new.prepared_by := coalesce(new.prepared_by, (select auth.uid()));
    new.approved_by := null; new.approved_at := null;
    new.paid_by := null; new.paid_at := null; new.submitted_at := null;
    return new;
  end if;

  -- A completed payment is a permanent record. Correcting one is a reversal,
  -- which F7 does not build; mutating the row instead would restate a treasury
  -- balance and a budget with no trace of the change.
  if old.status = 'paid' then
    raise exception 'A completed reimbursement payment is a permanent record and cannot be changed.'
      using errcode = 'insufficient_privilege';
  end if;

  if (new.amount is distinct from old.amount
      or new.treasury_account_id is distinct from old.treasury_account_id
      or new.finance_request_id is distinct from old.finance_request_id
      or new.method is distinct from old.method
      or new.notes is distinct from old.notes)
  then
    if not public.has_finance_privilege(array['accountant']) then
      raise exception 'Only the Accountant who prepares a payment may change its details.'
        using errcode = 'insufficient_privilege';
    end if;
    if old.status not in ('draft', 'returned') then
      raise exception 'This payment is no longer a draft. Ask for it back before editing.'
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_reimbursement_payment_edit on public.reimbursement_payments;
create trigger trg_reimbursement_payment_edit
  before insert or update on public.reimbursement_payments
  for each row execute function public.guard_reimbursement_payment_edit();

-- Deleting a payment would remove the explanation for a treasury movement.
create or replace function public.guard_reimbursement_payment_delete()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if old.status = 'paid' then
    raise exception 'A completed reimbursement payment is a permanent record and cannot be deleted.'
      using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$fn$;

drop trigger if exists trg_reimbursement_payment_delete on public.reimbursement_payments;
create trigger trg_reimbursement_payment_delete
  before delete on public.reimbursement_payments
  for each row execute function public.guard_reimbursement_payment_delete();

alter table public.reimbursement_payments enable row level security;

-- Reading is the Finance group's. The employee sees their own payment state
-- through the request read surface rather than this table, so a claimant never
-- reads treasury account ids.
drop policy if exists reimbursement_payments_read on public.reimbursement_payments;
create policy reimbursement_payments_read on public.reimbursement_payments
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists reimbursement_payments_write on public.reimbursement_payments;
create policy reimbursement_payments_write on public.reimbursement_payments
  for insert to authenticated
  with check (public.has_finance_privilege(array['accountant']));

drop policy if exists reimbursement_payments_update on public.reimbursement_payments;
create policy reimbursement_payments_update on public.reimbursement_payments
  for update to authenticated
  using (public.has_finance_privilege(array['accountant', 'finance_manager']))
  with check (public.has_finance_privilege(array['accountant', 'finance_manager']));

-- ---------------------------------------------------------------------------
-- 7. The treasury movement source
-- ---------------------------------------------------------------------------
--
-- treasury_movements.source_type is a CHECK, not an enum, so it is widened
-- here rather than altered. The unique index on (source_type, source_id) is
-- what keeps one completed payment to exactly one movement, and it needs no
-- change to cover a new member.
alter table public.treasury_movements
  drop constraint if exists treasury_movements_source_type_check;

alter table public.treasury_movements
  add constraint treasury_movements_source_type_check check (
    source_type in ('collection_settlement', 'supplier_payment',
                    'reimbursement_payment', 'payroll_disbursement')
  );
