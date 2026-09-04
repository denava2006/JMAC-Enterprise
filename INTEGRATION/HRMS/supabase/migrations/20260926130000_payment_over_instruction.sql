-- ===========================================================================
-- F6B fix: an invoice cannot be instructed twice for the same money
-- ===========================================================================
--
-- Hosted acceptance created two payment instructions of 1,300.00 against
-- SI-93842, whose balance is 1,300.00. Both were accepted. Ten seconds apart,
-- same preparer, same account.
--
-- ROOT CAUSE, and it is mine. create_supplier_payment checked the requested
-- amount against supplier_invoice_status.balance_due, and balance_due
-- subtracts only COMPLETED payments -- deliberately, because an approved but
-- unsent instruction has not paid the supplier and must not reduce what is
-- owed. Both facts are right. Using the second as the ceiling for the first is
-- what was wrong: after preparing 1,300 the balance is still 1,300, so a
-- second 1,300 sails through.
--
-- The completion-time recheck would have stopped the second from ever becoming
-- paid, so no money was at risk. But by then two Managers have two identical
-- instructions in front of them and no way to tell which is real. Refusing at
-- completion is a safety net; refusing at creation is the actual answer.
--
-- THE DISTINCTION, kept explicit rather than collapsed:
--
--   balance_due            total - completed payments      what is OWED
--   pending_payment        live instructions not yet paid  what is CLAIMED
--   available_to_prepare   balance_due - pending_payment   what may be ASKED
--
-- Partial payments keep working, which is the point of using a cumulative sum
-- rather than "one instruction at a time": 800 then 500 is a legitimate way to
-- settle 1,300, and a rule that allowed only one live instruction would have
-- banned it to fix a different problem.
--
-- EXISTING PRODUCTION ROWS. PV-2026-0001 and PV-2026-0002 both remain, exactly
-- as they are. They are acceptance evidence, and this migration will not touch
-- them. Note that the rule cannot be a CHECK constraint in any case: it is a
-- sum across sibling rows, which no row-level constraint can see. It has to
-- live in the function that creates them, under a lock -- so there is no
-- constraint to validate and nothing to grandfather.

-- ---------------------------------------------------------------------------
-- 1. What is already claimed
-- ---------------------------------------------------------------------------
--
-- The live statuses, taken from the lifecycle as it actually is rather than
-- guessed: draft, for_approval and approved all still intend to pay. 'paid' is
-- excluded because it is counted as paid instead -- money must never be both
-- claimed and settled. 'returned' and 'rejected' release their hold, which is
-- what lets an Accountant correct a mistake rather than being blocked by it.
create or replace function public.invoice_pending_payment(_invoice_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(sum(p.amount), 0)::numeric(14,2)
  from public.supplier_payments p
  where p.supplier_invoice_id = _invoice_id
    and p.status in ('draft', 'for_approval', 'approved');
$fn$;

comment on function public.invoice_pending_payment(uuid) is
  'Money already claimed by live payment instructions: draft, for_approval and '
  'approved. Paid is excluded because it is counted as paid; returned and '
  'rejected release their hold so a correction can be prepared.';

-- ---------------------------------------------------------------------------
-- 2. The invoice, with all three figures
-- ---------------------------------------------------------------------------
--
-- Dropped rather than replaced: the two new columns belong beside balance_due,
-- and CREATE OR REPLACE VIEW may only append. Nothing in the database depends
-- on this view -- get_payable_invoices reads it from a string-bodied SQL
-- function, which carries no recorded dependency -- and it is recreated in the
-- same transaction.
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
    -- What is owed. Unchanged, and deliberately so: an instruction nobody has
    -- sent has not paid the supplier.
    (coalesce(l.subtotal, 0) + si.tax_amount + si.other_charges
       - coalesce(pay.amount_paid, 0))::numeric(14,2) as balance_due,
    -- What is claimed by instructions still in flight.
    coalesce(pend.pending, 0)::numeric(14,2) as pending_payment_amount,
    -- What may still be asked for. greatest(...,0) because the two historical
    -- acceptance rows already claim more than is owed, and a negative
    -- "available" would read as a number rather than as nothing.
    greatest(
      coalesce(l.subtotal, 0) + si.tax_amount + si.other_charges
        - coalesce(pay.amount_paid, 0) - coalesce(pend.pending, 0),
      0
    )::numeric(14,2) as available_to_prepare,
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
  ) pay on true
  left join lateral (
    select sum(p.amount) as pending
    from public.supplier_payments p
    where p.supplier_invoice_id = si.id
      and p.status in ('draft', 'for_approval', 'approved')
  ) pend on true;

-- ---------------------------------------------------------------------------
-- 3. Preparing, against what is actually available
-- ---------------------------------------------------------------------------
create or replace function public.create_supplier_payment(
  _supplier_invoice_id uuid,
  _treasury_account_id uuid,
  _amount numeric,
  _method text default 'bank_transfer',
  _notes text default null,
  _submit boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
  _inv public.supplier_invoice_status%rowtype;
  _account public.treasury_accounts%rowtype;
  _available numeric(14,2);
  _locked uuid;
begin
  if not public.has_finance_privilege(array['accountant']) then
    raise exception 'Preparing a supplier payment is the Accountant''s work.'
      using errcode = 'insufficient_privilege';
  end if;

  -- The invoice row is locked before anything is read from it, and held to the
  -- end of the transaction. Two tabs both seeing 1,300 available and both
  -- writing 1,300 is exactly the race that produced PV-0001 and PV-0002 ten
  -- seconds apart; serialising here means the second one reads the first one's
  -- instruction rather than the state before it.
  select id into _locked from public.supplier_invoices
   where id = _supplier_invoice_id for update;
  if _locked is null then
    raise exception 'That invoice is not available.' using errcode = 'check_violation';
  end if;

  select * into _inv from public.supplier_invoice_status where id = _supplier_invoice_id;

  if _inv.status <> 'approved' then
    raise exception 'Only an approved supplier invoice can be paid.'
      using errcode = 'check_violation';
  end if;

  select * into _account from public.treasury_accounts where id = _treasury_account_id;
  if _account.id is null or not _account.is_active then
    raise exception 'That account is not available.' using errcode = 'check_violation';
  end if;

  if coalesce(_amount, 0) <= 0 then
    raise exception 'A payment has to be for more than nothing.' using errcode = 'check_violation';
  end if;

  -- Owed, less what is already claimed. Read under the lock above, so it
  -- cannot be stale by the time it is acted on.
  _available := greatest(_inv.balance_due - _inv.pending_payment_amount, 0);

  if _amount > _available then
    if _available <= 0 then
      raise exception
        'This invoice already has payment instructions covering its remaining balance.'
        using errcode = 'check_violation';
    else
      raise exception
        'This invoice only has % still available to prepare for payment.',
        to_char(_available, 'FM999,999,990.00') using errcode = 'check_violation';
    end if;
  end if;

  insert into public.supplier_payments (
    supplier_invoice_id, treasury_account_id, amount, method, notes
  ) values (
    _supplier_invoice_id, _treasury_account_id, _amount,
    coalesce(_method, 'bank_transfer'), _notes
  ) returning id into _id;

  if _submit then
    perform public.transition_supplier_payment(_id, 'for_approval', null, null, null);
  end if;

  return _id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. What may still be prepared, for the payables list
-- ---------------------------------------------------------------------------
-- Dropped first: two columns are being added to the result, and a function's
-- return type cannot be changed in place.
drop function if exists public.get_payable_invoices();

create function public.get_payable_invoices()
returns table (
  id uuid,
  invoice_no text,
  supplier_invoice_number text,
  vendor_id uuid,
  vendor_name text,
  total_amount numeric,
  amount_paid numeric,
  balance_due numeric,
  pending_payment_amount numeric,
  available_to_prepare numeric,
  due_date date,
  settlement_state text,
  payment_state text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    v.id, v.invoice_no, v.supplier_invoice_number, v.vendor_id, v.vendor_name,
    v.total_amount, v.amount_paid, v.balance_due,
    v.pending_payment_amount, v.available_to_prepare,
    v.due_date, v.settlement_state, v.payment_state
  from public.supplier_invoice_status v
  where public.can_read_finance_master()
    and v.status = 'approved'
    and v.balance_due > 0
  order by v.due_date nulls last, v.invoice_no;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Withdrawing an authorisation
-- ---------------------------------------------------------------------------
--
-- A gap this fix would otherwise open. Returned and rejected were reachable
-- only from for_approval, which was harmless while an approved instruction
-- claimed nothing -- it just sat there. Now it holds part of the payable, so
-- an approved payment that cannot be completed (the account was short, the
-- supplier changed their details, it was simply wrong) would block the invoice
-- for ever with no way back.
--
-- So the Finance Manager may also withdraw an approval, with a reason, right
-- up until the money moves. Nothing about 'paid' changes: a completed payment
-- stays permanent, and correcting one is still a reversal this phase does not
-- build.
create or replace function public.transition_supplier_payment(
  _payment_id uuid,
  _to_status text,
  _reason text default null,
  _reference text default null,
  _payment_date date default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _p public.supplier_payments%rowtype;
  _inv public.supplier_invoice_status%rowtype;
  _me uuid := (select auth.uid());
  _available numeric(14,2);
  _account public.treasury_accounts%rowtype;
begin
  select * into _p from public.supplier_payments where id = _payment_id for update;
  if _p.id is null then
    raise exception 'That payment is not available.' using errcode = 'check_violation';
  end if;

  if _to_status in ('returned', 'rejected')
     and nullif(btrim(coalesce(_reason, '')), '') is null then
    raise exception 'Say why this payment is being %.',
      case _to_status when 'returned' then 'returned' else 'rejected' end
      using errcode = 'check_violation';
  end if;

  if _to_status = 'for_approval' then
    if not public.has_finance_privilege(array['accountant']) then
      raise exception 'Only the Accountant submits a payment for approval.'
        using errcode = 'insufficient_privilege';
    end if;
    if _p.status not in ('draft', 'returned') then
      raise exception 'Only a draft payment can be submitted.' using errcode = 'check_violation';
    end if;
    update public.supplier_payments
       set status = 'for_approval', submitted_at = now(), decision_reason = null
     where id = _payment_id;

  elsif _to_status in ('approved', 'returned', 'rejected') then
    if not public.has_finance_privilege(array['finance_manager']) then
      raise exception 'Only the Finance Manager decides a payment.'
        using errcode = 'insufficient_privilege';
    end if;
    -- Approving needs something awaiting approval. Withdrawing may also reach
    -- one already approved, because until it is paid there is still something
    -- to withdraw.
    if _to_status = 'approved' and _p.status <> 'for_approval' then
      raise exception 'Only a payment awaiting approval can be approved.'
        using errcode = 'check_violation';
    end if;
    if _to_status in ('returned', 'rejected')
       and _p.status not in ('for_approval', 'approved') then
      raise exception 'Only a payment that has not been made can be %.', _to_status
        using errcode = 'check_violation';
    end if;
    if _p.prepared_by = _me then
      raise exception 'You prepared payment %, so somebody else has to approve it.',
        _p.payment_no using errcode = 'insufficient_privilege';
    end if;

    update public.supplier_payments
       set status = _to_status,
           approved_by = case when _to_status = 'approved' then _me else null end,
           approved_at = case when _to_status = 'approved' then now() else null end,
           decision_reason = nullif(btrim(coalesce(_reason, '')), '')
     where id = _payment_id;

  elsif _to_status = 'paid' then
    if not public.has_finance_privilege(array['accountant']) then
      raise exception 'The Accountant records a completed payment.'
        using errcode = 'insufficient_privilege';
    end if;
    if _p.status <> 'approved' then
      raise exception 'This payment has not been approved for payment yet.'
        using errcode = 'check_violation';
    end if;
    if nullif(btrim(coalesce(_reference, '')), '') is null then
      raise exception 'Record the payment reference from the bank or receipt.'
        using errcode = 'check_violation';
    end if;

    select * into _inv from public.supplier_invoice_status where id = _p.supplier_invoice_id;
    if _p.amount > _inv.balance_due then
      raise exception 'Invoice % now has only % outstanding.',
        _inv.supplier_invoice_number, to_char(_inv.balance_due, 'FM999,999,990.00')
        using errcode = 'check_violation';
    end if;

    select * into _account from public.treasury_accounts
     where id = _p.treasury_account_id for update;
    _available := public.treasury_account_balance(_p.treasury_account_id);
    if _p.amount > _available then
      raise exception 'This account does not have enough available funds for this payment.'
        using errcode = 'check_violation';
    end if;

    update public.supplier_payments
       set status = 'paid',
           paid_by = _me,
           paid_at = now(),
           payment_date = coalesce(_payment_date, current_date),
           reference = btrim(_reference)
     where id = _payment_id;

    insert into public.treasury_movements (
      treasury_account_id, direction, amount, source_type, source_id,
      occurred_on, reference, created_by
    ) values (
      _p.treasury_account_id, 'out', _p.amount, 'supplier_payment', _payment_id,
      coalesce(_payment_date, current_date), btrim(_reference), _me
    );

  else
    raise exception 'A payment cannot move to %.', _to_status using errcode = 'check_violation';
  end if;

  insert into public.audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
  values (
    _me,
    'Supplier payment ' || _to_status,
    'supplier_payments',
    _payment_id,
    jsonb_build_object('status', _p.status),
    jsonb_build_object(
      'status', _to_status,
      'payment_no', _p.payment_no,
      'supplier_invoice_id', _p.supplier_invoice_id,
      'amount', _p.amount,
      'treasury_account_id', _p.treasury_account_id,
      'reference', nullif(btrim(coalesce(_reference, '')), ''),
      'payment_date', _payment_date,
      'reason', nullif(btrim(coalesce(_reason, '')), '')
    )
  );
end;
$fn$;

revoke all on function public.invoice_pending_payment(uuid) from public, anon;
revoke all on function public.get_payable_invoices() from public, anon;
grant execute on function public.invoice_pending_payment(uuid) to authenticated;
grant execute on function public.get_payable_invoices() to authenticated;
