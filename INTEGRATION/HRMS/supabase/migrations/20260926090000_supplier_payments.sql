-- ===========================================================================
-- F6B  Supplier payments, and the first time Reserved becomes Spent
-- ===========================================================================
--
-- F5 leaves an approved invoice sitting at "awaiting payment" because the
-- phase that settles it did not exist. This is that phase.
--
-- THE DISTINCTION THIS FILE IS BUILT AROUND.
--
--   Approved for payment  the Finance Manager authorised it
--   Paid                  money actually left the account, and here is the
--                         reference and the date
--
-- JMAC has no bank-transfer API. Approval cannot move money because approval
-- is not a transfer -- somebody still has to go and do it. So approval changes
-- nothing but the document's own state, and only recording the completed
-- external payment moves a treasury balance, reduces the payable, and turns
-- reserved budget into spent.
--
-- WHY RESERVED AND SPENT STAY DERIVED.
--
-- budget_status already derives reserved from two sources and hardcodes spent
-- to zero. The temptation now is a pair of counters on budgets that each
-- payment nudges. That is how the numbers start disagreeing with the documents
-- -- a failed transaction, a retried call, a manual fix, and the counter is
-- adrift with nothing to reconcile it against. So payments become another
-- derived input, and the arithmetic below is the whole change:
--
--   reserved = (finance request reservations - payments against them)
--            + (PO commitments            - payments against them)
--   spent    = completed payments attributable to the budget
--
-- Available = ceiling - reserved - spent, so as reserved falls by exactly what
-- spent rises by, available does not move. Which is the point: paying a bill
-- you had already set money aside for does not give you more to spend.

-- ---------------------------------------------------------------------------
-- 1. The payment
-- ---------------------------------------------------------------------------
create table if not exists public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  payment_no text,

  supplier_invoice_id uuid not null
    references public.supplier_invoices(id) on delete restrict,
  treasury_account_id uuid not null
    references public.treasury_accounts(id) on delete restrict,

  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('bank_transfer', 'cash', 'cheque', 'other')),

  -- The date the payment instruction is for. payment_date is when money left,
  -- and is only known once it has.
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

  -- A paid record must carry the evidence that it was paid. Without this,
  -- "paid" could be asserted with nothing behind it.
  constraint supplier_payments_paid_has_evidence check (
    status <> 'paid' or (payment_date is not null and paid_at is not null)
  )
);

create index if not exists supplier_payments_invoice_idx
  on public.supplier_payments (supplier_invoice_id, status);

create unique index if not exists supplier_payments_no_unique
  on public.supplier_payments (payment_no) where payment_no is not null;

-- The same external transfer reference cannot be recorded twice against one
-- account. Returned and rejected are excluded so a corrected record may reuse
-- the real-world reference of the attempt it replaces.
create unique index if not exists supplier_payments_reference_unique
  on public.supplier_payments (treasury_account_id, upper(btrim(reference)))
  where reference is not null and btrim(reference) <> ''
    and status not in ('returned', 'rejected');

comment on table public.supplier_payments is
  'Payment of a supplier invoice. Only status = paid moves a treasury balance, '
  'reduces the payable, or turns reserved budget into spent.';

-- ---------------------------------------------------------------------------
-- 2. What a payment consumes
-- ---------------------------------------------------------------------------
--
-- Which budget, and which of the two reservation sources. Both existing paths
-- are honoured, and the choice between them mirrors what budget_status already
-- does: a PO raised from a finance request is counted at the request, so a
-- payment against it must release the request's reservation, not invent a
-- third one.
create or replace function public.payment_budget_id(_payment_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select po.budget_id
  from public.supplier_payments p
  join public.supplier_invoices si on si.id = p.supplier_invoice_id
  join public.purchase_orders po on po.id = si.purchase_order_id
  where p.id = _payment_id;
$fn$;

-- Completed payments against one purchase order.
create or replace function public.purchase_order_paid(_purchase_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(sum(p.amount), 0)::numeric(14,2)
  from public.supplier_payments p
  join public.supplier_invoices si on si.id = p.supplier_invoice_id
  where si.purchase_order_id = _purchase_order_id
    and p.status = 'paid';
$fn$;

-- Completed payments against one finance request, reached through the purchase
-- orders that request raised.
create or replace function public.finance_request_paid(_finance_request_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(sum(p.amount), 0)::numeric(14,2)
  from public.supplier_payments p
  join public.supplier_invoices si on si.id = p.supplier_invoice_id
  join public.purchase_order_sources s on s.purchase_order_id = si.purchase_order_id
  where s.finance_request_id = _finance_request_id
    and p.status = 'paid';
$fn$;

-- ---------------------------------------------------------------------------
-- 3. AP balance, now that payments exist
-- ---------------------------------------------------------------------------
--
-- balance_due was total_amount, because nothing could pay an invoice. It is
-- now total minus completed payments. Draft and approved instructions change
-- nothing -- an authorised payment that has not been made is not a payment.
--
-- Dropped rather than replaced: amount_paid lands before balance_due, and
-- CREATE OR REPLACE VIEW may only append columns. Nothing in the database
-- depends on this view -- the only readers are the Finance hooks -- so the
-- drop is safe and the recreate is immediate.
drop view if exists public.supplier_invoice_status;

create view public.supplier_invoice_status
with (security_invoker = on) as
  select
    si.id,
    si.invoice_no,
    si.supplier_invoice_number,
    si.vendor_id,
    v.name as vendor_name,
    si.purchase_order_id,
    po.po_number,
    po.status as purchase_order_status,
    si.invoice_date,
    si.due_date,
    si.currency,
    si.status,
    si.notes,
    si.tax_amount,
    si.other_charges,
    si.other_charges_note,
    coalesce(l.line_count, 0)::integer as line_count,
    coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
    (coalesce(l.subtotal, 0) + si.tax_amount + si.other_charges)::numeric(14,2) as total_amount,
    coalesce(pay.amount_paid, 0)::numeric(14,2) as amount_paid,
    (coalesce(l.subtotal, 0) + si.tax_amount + si.other_charges
       - coalesce(pay.amount_paid, 0))::numeric(14,2) as balance_due,
    -- What a person needs to know at a glance, in the order they would ask.
    -- Only an approved invoice can be any of these; the rest are still
    -- documents in review.
    case
      when si.status <> 'approved' then null
      when coalesce(pay.amount_paid, 0) <= 0 then 'awaiting_payment'
      when coalesce(pay.amount_paid, 0)
           < (coalesce(l.subtotal, 0) + si.tax_amount + si.other_charges) then 'partially_paid'
      else 'paid'
    end as settlement_state,
    case
      when si.status <> 'approved' then null
      when si.due_date is null then null
      else si.due_date - current_date
    end as days_until_due,
    case
      when si.status <> 'approved' or si.due_date is null then null
      -- A fully paid invoice is not overdue. It was the outstanding balance
      -- that could be late, and there is none.
      when (coalesce(l.subtotal, 0) + si.tax_amount + si.other_charges
              - coalesce(pay.amount_paid, 0)) <= 0 then 'settled'
      when si.due_date < current_date then 'overdue'
      when si.due_date <= (current_date + 7) then 'due_soon'
      else 'scheduled'
    end as payment_state,
    si.created_by,
    si.created_at,
    si.submitted_at,
    si.approved_by,
    si.approved_at,
    si.decision_reason,
    si.updated_at
  from public.supplier_invoices si
  left join public.vendors v on v.id = si.vendor_id
  left join public.purchase_orders po on po.id = si.purchase_order_id
  left join lateral (
    select count(*) as line_count, sum(sl.line_total) as subtotal
    from public.supplier_invoice_lines sl
    where sl.supplier_invoice_id = si.id
  ) l on true
  left join lateral (
    select sum(p.amount) as amount_paid
    from public.supplier_payments p
    where p.supplier_invoice_id = si.id and p.status = 'paid'
  ) pay on true;

-- ---------------------------------------------------------------------------
-- 4. Budget: reserved falls, spent rises, available holds
-- ---------------------------------------------------------------------------
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
    -- Still the same two sources, each now net of what has actually been paid
    -- against it. greatest(...,0) because an overpayment must not push a
    -- reservation negative and quietly hand headroom back.
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
  -- Employee purchase requests: what was approved, less what has been paid
  -- through the purchase orders it raised.
  left join lateral (
    select sum(greatest(fr.amount - public.finance_request_paid(fr.id), 0)) as reserved
    from public.finance_requests fr
    where fr.budget_id = b.id and fr.status = 'approved'
  ) r on true
  -- POS procurement: the order's own commitment, less what has been paid
  -- against it. The finance-request-sourced orders are still excluded here,
  -- because they are already counted above -- counting both would reserve the
  -- same money twice.
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
  -- Spent: every completed payment whose purchase order draws on this budget.
  -- One expression covering both reservation sources, because a payment is
  -- spending regardless of which document reserved it.
  left join lateral (
    select sum(pay.amount) as spent
    from public.supplier_payments pay
    join public.supplier_invoices si on si.id = pay.supplier_invoice_id
    join public.purchase_orders po on po.id = si.purchase_order_id
    where pay.status = 'paid' and po.budget_id = b.id
  ) sp on true;

comment on view public.budget_status is
  'Ceiling, reserved and spent, all derived. Reserved falls by exactly what '
  'spent rises by when a payment completes, so remaining does not move.';

-- ---------------------------------------------------------------------------
-- 5. Numbering, guards, and who may act
-- ---------------------------------------------------------------------------
create or replace function public.set_payment_no()
returns trigger language plpgsql set search_path = '' as $fn$
declare _year text := to_char(current_date, 'YYYY');
begin
  if new.payment_no is null then
    new.payment_no := 'PV-' || _year || '-' || lpad((
      select count(*) + 1 from public.supplier_payments
       where payment_no like 'PV-' || _year || '-%'
    )::text, 4, '0');
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_payment_no on public.supplier_payments;
create trigger trg_payment_no
  before insert on public.supplier_payments
  for each row execute function public.set_payment_no();

create or replace function public.guard_supplier_payment_edit()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if tg_op = 'INSERT' then
    new.status := 'draft';
    new.prepared_by := coalesce(new.prepared_by, (select auth.uid()));
    new.approved_by := null; new.approved_at := null;
    new.paid_by := null; new.paid_at := null; new.submitted_at := null;
    return new;
  end if;

  -- A completed payment is a permanent record. Corrections are a reversal,
  -- which this phase does not build -- and mutating the row instead would
  -- restate a treasury balance and a budget with no trace of the change.
  if old.status = 'paid' then
    raise exception 'A completed payment is a permanent record and cannot be changed.'
      using errcode = 'insufficient_privilege';
  end if;

  if (new.amount is distinct from old.amount
      or new.treasury_account_id is distinct from old.treasury_account_id
      or new.supplier_invoice_id is distinct from old.supplier_invoice_id
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

drop trigger if exists trg_supplier_payment_edit on public.supplier_payments;
create trigger trg_supplier_payment_edit
  before insert or update on public.supplier_payments
  for each row execute function public.guard_supplier_payment_edit();

alter table public.supplier_payments enable row level security;

drop policy if exists supplier_payments_read on public.supplier_payments;
create policy supplier_payments_read on public.supplier_payments
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists supplier_payments_write on public.supplier_payments;
create policy supplier_payments_write on public.supplier_payments
  for insert to authenticated
  with check (public.has_finance_privilege(array['accountant']));

drop policy if exists supplier_payments_update on public.supplier_payments;
create policy supplier_payments_update on public.supplier_payments
  for update to authenticated
  using (public.has_finance_privilege(array['accountant', 'finance_manager']))
  with check (public.has_finance_privilege(array['accountant', 'finance_manager']));

-- ---------------------------------------------------------------------------
-- 6. The treasury drill-down, now that both source documents exist
-- ---------------------------------------------------------------------------
create or replace function public.get_treasury_movements(
  _account_id uuid default null,
  _limit integer default 50,
  _offset integer default 0
)
returns table (
  id uuid,
  treasury_account_id uuid,
  account_name text,
  direction text,
  amount numeric,
  source_type text,
  source_id uuid,
  source_no text,
  occurred_on date,
  reference text,
  created_by uuid,
  actor_name text,
  created_at timestamptz,
  total_rows bigint
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    m.id, m.treasury_account_id, a.name, m.direction, m.amount,
    m.source_type, m.source_id,
    -- The document behind the movement, so a balance can be walked back to
    -- the settlement or payment that moved it.
    case m.source_type
      when 'collection_settlement' then
        (select s.settlement_no from public.collection_settlements s where s.id = m.source_id)
      when 'supplier_payment' then
        (select p.payment_no from public.supplier_payments p where p.id = m.source_id)
    end,
    m.occurred_on, m.reference, m.created_by, pr.full_name, m.created_at,
    count(*) over ()
  from public.treasury_movements m
  join public.treasury_accounts a on a.id = m.treasury_account_id
  left join public.profiles pr on pr.id = m.created_by
  where public.can_read_finance_master()
    and (_account_id is null or m.treasury_account_id = _account_id)
  order by m.occurred_on desc, m.created_at desc
  limit greatest(1, least(coalesce(_limit, 50), 200))
  offset greatest(0, coalesce(_offset, 0));
$fn$;

revoke all on function public.get_treasury_movements(uuid, integer, integer) from public, anon;
revoke all on function public.payment_budget_id(uuid) from public, anon;
revoke all on function public.purchase_order_paid(uuid) from public, anon;
revoke all on function public.finance_request_paid(uuid) from public, anon;
grant execute on function public.get_treasury_movements(uuid, integer, integer) to authenticated;
grant execute on function public.payment_budget_id(uuid) to authenticated;
grant execute on function public.purchase_order_paid(uuid) to authenticated;
grant execute on function public.finance_request_paid(uuid) to authenticated;
