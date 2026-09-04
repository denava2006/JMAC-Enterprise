-- ===========================================================================
-- F6B  The payment lifecycle, and the one step that moves money
-- ===========================================================================
--
--   Draft -> For approval -> Approved for payment -> Paid
--
-- with Returned and Rejected as the two ways back, both requiring a reason.
--
-- Accountant prepares and submits. Finance Manager approves -- and approval
-- changes nothing but the document, because JMAC has no transfer API and
-- somebody still has to go to the bank. The Accountant then records what
-- actually happened, with the reference and the date, and that is the step
-- that moves a treasury balance, reduces the payable and turns reserved
-- budget into spent.
--
-- Recording completion is the Accountant's rather than the Manager's for the
-- same reason recording an invoice is: it is bookkeeping, not authorisation.
-- The Manager already decided; asking them to also type the reference would
-- collapse the two acts back into one and lose the distinction the workflow
-- exists to keep.

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
begin
  if not public.has_finance_privilege(array['accountant']) then
    raise exception 'Preparing a supplier payment is the Accountant''s work.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into _inv from public.supplier_invoice_status where id = _supplier_invoice_id;
  if _inv.id is null then
    raise exception 'That invoice is not available.' using errcode = 'check_violation';
  end if;
  -- Only an approved invoice is a payable. Paying a document still under
  -- review would settle an obligation nobody has agreed to yet.
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

  -- Never more than is owed. The balance already nets off completed payments,
  -- so this covers the partial case without a second rule.
  if _amount > _inv.balance_due then
    raise exception 'Invoice % has % outstanding, so it cannot take a payment of %.',
      _inv.supplier_invoice_number,
      to_char(_inv.balance_due, 'FM999,999,990.00'),
      to_char(_amount, 'FM999,999,990.00')
      using errcode = 'check_violation';
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
-- Moving it along, including the step that spends
-- ---------------------------------------------------------------------------
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
  -- The payment row is locked first and held for the whole transaction. A
  -- double-clicked Record therefore serialises: the second call finds the
  -- status already 'paid' and is refused, rather than writing a second
  -- movement.
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
    if _p.status <> 'for_approval' then
      raise exception 'Only a payment awaiting approval can be decided.'
        using errcode = 'check_violation';
    end if;
    -- Identity, not role: the person who prepared it may not approve it, even
    -- if their role changed in between.
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
    -- Nothing moves here. Approval is authorisation, not a transfer.

  elsif _to_status = 'paid' then
    if not public.has_finance_privilege(array['accountant']) then
      raise exception 'The Accountant records a completed payment.'
        using errcode = 'insufficient_privilege';
    end if;
    -- Completion requires an authorisation to complete. Without this, any
    -- Accountant could mark any invoice paid without a Manager ever seeing it.
    if _p.status <> 'approved' then
      raise exception 'This payment has not been approved for payment yet.'
        using errcode = 'check_violation';
    end if;
    if nullif(btrim(coalesce(_reference, '')), '') is null then
      raise exception 'Record the payment reference from the bank or receipt.'
        using errcode = 'check_violation';
    end if;

    -- Re-check what is owed at the moment of completion, not at preparation.
    -- Two payments prepared against the same balance must not both complete.
    select * into _inv from public.supplier_invoice_status where id = _p.supplier_invoice_id;
    if _p.amount > _inv.balance_due then
      raise exception 'Invoice % now has only % outstanding.',
        _inv.supplier_invoice_number, to_char(_inv.balance_due, 'FM999,999,990.00')
        using errcode = 'check_violation';
    end if;

    -- Funds, under a row lock on the account. Two payments racing the same
    -- balance serialise here, so the second one sees the first one's money
    -- already gone instead of both spending it.
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

    -- Money leaves. One row, and the unique index on (source_type, source_id)
    -- means a retried transaction cannot write a second.
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

-- ---------------------------------------------------------------------------
-- Reading payments
-- ---------------------------------------------------------------------------
create or replace function public.get_supplier_payments(_invoice_id uuid default null)
returns table (
  id uuid,
  payment_no text,
  supplier_invoice_id uuid,
  supplier_invoice_number text,
  invoice_no text,
  vendor_name text,
  treasury_account_id uuid,
  account_name text,
  amount numeric,
  method text,
  payment_date date,
  reference text,
  notes text,
  status text,
  prepared_by uuid,
  prepared_by_name text,
  submitted_at timestamptz,
  approved_by uuid,
  approved_by_name text,
  approved_at timestamptz,
  paid_by uuid,
  paid_by_name text,
  paid_at timestamptz,
  decision_reason text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    p.id, p.payment_no, p.supplier_invoice_id, si.supplier_invoice_number, si.invoice_no,
    v.name, p.treasury_account_id, ta.name, p.amount, p.method, p.payment_date,
    p.reference, p.notes, p.status,
    p.prepared_by, pp.full_name, p.submitted_at,
    p.approved_by, ap.full_name, p.approved_at,
    p.paid_by, yp.full_name, p.paid_at,
    p.decision_reason, p.created_at
  from public.supplier_payments p
  join public.supplier_invoices si on si.id = p.supplier_invoice_id
  left join public.vendors v on v.id = si.vendor_id
  left join public.treasury_accounts ta on ta.id = p.treasury_account_id
  left join public.profiles pp on pp.id = p.prepared_by
  left join public.profiles ap on ap.id = p.approved_by
  left join public.profiles yp on yp.id = p.paid_by
  where public.can_read_finance_master()
    and (_invoice_id is null or p.supplier_invoice_id = _invoice_id)
  order by p.created_at desc;
$fn$;

-- The invoices a payment can actually be prepared against: approved, and still
-- owing something.
create or replace function public.get_payable_invoices()
returns table (
  id uuid,
  invoice_no text,
  supplier_invoice_number text,
  vendor_id uuid,
  vendor_name text,
  total_amount numeric,
  amount_paid numeric,
  balance_due numeric,
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
    v.total_amount, v.amount_paid, v.balance_due, v.due_date,
    v.settlement_state, v.payment_state
  from public.supplier_invoice_status v
  where public.can_read_finance_master()
    and v.status = 'approved'
    and v.balance_due > 0
  order by v.due_date nulls last, v.invoice_no;
$fn$;

revoke all on function public.create_supplier_payment(uuid, uuid, numeric, text, text, boolean) from public, anon;
revoke all on function public.transition_supplier_payment(uuid, text, text, text, date) from public, anon;
revoke all on function public.get_supplier_payments(uuid) from public, anon;
revoke all on function public.get_payable_invoices() from public, anon;

grant execute on function public.create_supplier_payment(uuid, uuid, numeric, text, text, boolean) to authenticated;
grant execute on function public.transition_supplier_payment(uuid, text, text, text, date) to authenticated;
grant execute on function public.get_supplier_payments(uuid) to authenticated;
grant execute on function public.get_payable_invoices() to authenticated;
