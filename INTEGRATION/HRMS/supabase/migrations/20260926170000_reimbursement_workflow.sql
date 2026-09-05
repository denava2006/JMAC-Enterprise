-- ===========================================================================
-- F7A  The reimbursement payment lifecycle
-- ===========================================================================
--
-- Draft -> For approval -> Approved for payment -> Paid, with Returned and
-- Rejected as the two ways back, both requiring a reason.
--
-- The F6 distinction holds unchanged: approving authorises, and only recording
-- the completed external payment moves anything. JMAC still has no transfer
-- API, so somebody still has to go and do it.

-- ---------------------------------------------------------------------------
-- 1. What a reimbursement still owes
-- ---------------------------------------------------------------------------
create or replace view public.reimbursement_status
with (security_invoker = on) as
  select
    fr.id,
    fr.request_no,
    fr.title,
    fr.description,
    fr.justification,
    fr.requester_id,
    pr.full_name as requester_name,
    fr.department_id,
    fr.finance_category_id,
    fc.name as finance_category_name,
    fr.budget_id,
    b.name as budget_name,
    fr.amount,
    fr.expense_date,
    fr.needed_by,
    fr.priority,
    fr.status,
    coalesce(public.reimbursement_paid(fr.id), 0)::numeric(14,2) as amount_paid,
    -- Only an approved claim is a payable. A draft or returned one owes
    -- nothing, however large the number on it.
    case when fr.status = 'approved'
      then greatest(fr.amount - coalesce(public.reimbursement_paid(fr.id), 0), 0)
      else 0 end::numeric(14,2) as balance_due,
    coalesce(public.reimbursement_pending_payment(fr.id), 0)::numeric(14,2)
      as pending_payment_amount,
    case when fr.status = 'approved'
      then greatest(
        fr.amount
          - coalesce(public.reimbursement_paid(fr.id), 0)
          - coalesce(public.reimbursement_pending_payment(fr.id), 0), 0)
      else 0 end::numeric(14,2) as available_to_prepare,
    -- The payment state, derived. The workflow status stays what the Finance
    -- Manager decided; paying a claim does not un-approve it, and a second
    -- mutable column would be a second thing to keep in step.
    case
      when fr.status <> 'approved' then null
      when coalesce(public.reimbursement_paid(fr.id), 0) <= 0 then 'awaiting_payment'
      when coalesce(public.reimbursement_paid(fr.id), 0) < fr.amount then 'partially_paid'
      else 'paid'
    end as settlement_state,
    fr.created_at,
    fr.updated_at
  from public.finance_requests fr
  left join public.profiles pr on pr.id = fr.requester_id
  left join public.finance_categories fc on fc.id = fr.finance_category_id
  left join public.budgets b on b.id = fr.budget_id
  where fr.type = 'reimbursement';

comment on view public.reimbursement_status is
  'Employee reimbursements with what is owed, claimed and still preparable. '
  'A view over finance_requests -- there is no second reimbursement table, and '
  'so no second budget reservation source.';

-- ---------------------------------------------------------------------------
-- 2. Preparing a payment
-- ---------------------------------------------------------------------------
create or replace function public.create_reimbursement_payment(
  _finance_request_id uuid,
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
  _r public.reimbursement_status%rowtype;
  _account public.treasury_accounts%rowtype;
  _available numeric(14,2);
  _locked uuid;
begin
  if not public.has_finance_privilege(array['accountant']) then
    raise exception 'Preparing a reimbursement payment is the Accountant''s work.'
      using errcode = 'insufficient_privilege';
  end if;

  -- The claim is locked before what is available is read, and held to the end
  -- of the transaction. Two tabs both seeing the whole balance free and both
  -- writing it is the race F6 met on SI-93842; serialising here means the
  -- second reads the first one's instruction.
  select id into _locked from public.finance_requests
   where id = _finance_request_id for update;
  if _locked is null then
    raise exception 'That reimbursement is not available.' using errcode = 'check_violation';
  end if;

  select * into _r from public.reimbursement_status where id = _finance_request_id;
  if _r.id is null then
    raise exception 'That reimbursement is not available.' using errcode = 'check_violation';
  end if;
  if _r.status <> 'approved' then
    raise exception 'Only an approved reimbursement can be paid.'
      using errcode = 'check_violation';
  end if;

  select * into _account from public.treasury_accounts where id = _treasury_account_id;
  if _account.id is null or not _account.is_active then
    raise exception 'That account is not available.' using errcode = 'check_violation';
  end if;

  if coalesce(_amount, 0) <= 0 then
    raise exception 'A payment has to be for more than nothing.' using errcode = 'check_violation';
  end if;

  _available := _r.available_to_prepare;
  if _amount > _available then
    if _available <= 0 then
      raise exception
        'This reimbursement is already fully covered by payment instructions.'
        using errcode = 'check_violation';
    else
      raise exception
        'This reimbursement only has % still available to prepare for payment.',
        to_char(_available, 'FM999,999,990.00') using errcode = 'check_violation';
    end if;
  end if;

  insert into public.reimbursement_payments (
    finance_request_id, treasury_account_id, amount, method, notes
  ) values (
    _finance_request_id, _treasury_account_id, _amount,
    coalesce(_method, 'bank_transfer'), _notes
  ) returning id into _id;

  if _submit then
    perform public.transition_reimbursement_payment(_id, 'for_approval', null, null, null);
  end if;

  return _id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Moving it along, including the step that spends
-- ---------------------------------------------------------------------------
create or replace function public.transition_reimbursement_payment(
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
  _p public.reimbursement_payments%rowtype;
  _r public.reimbursement_status%rowtype;
  _me uuid := (select auth.uid());
  _available numeric(14,2);
  _siblings numeric(14,2);
  _account public.treasury_accounts%rowtype;
  _locked uuid;
begin
  select * into _p from public.reimbursement_payments where id = _payment_id for update;
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

    -- Resubmission re-checks the balance, under the same lock and excluding
    -- this payment from its own sibling sum. Counting it against itself would
    -- refuse every resubmission there is.
    select id into _locked from public.finance_requests
     where id = _p.finance_request_id for update;
    select * into _r from public.reimbursement_status where id = _p.finance_request_id;

    select coalesce(sum(s.amount), 0)::numeric(14,2) into _siblings
    from public.reimbursement_payments s
    where s.finance_request_id = _p.finance_request_id
      and s.id <> _payment_id
      and s.status in ('draft', 'for_approval', 'approved');

    _available := greatest(_r.balance_due - _siblings, 0);
    if _p.amount > _available then
      if _available <= 0 then
        raise exception
          'This reimbursement no longer has a balance available for this payment.'
          using errcode = 'check_violation';
      else
        raise exception
          'This reimbursement only has % available, and this payment is for %.',
          to_char(_available, 'FM999,999,990.00'),
          to_char(_p.amount, 'FM999,999,990.00')
          using errcode = 'check_violation';
      end if;
    end if;

    update public.reimbursement_payments
       set status = 'for_approval', submitted_at = now(), decision_reason = null
     where id = _payment_id;

  elsif _to_status in ('approved', 'returned', 'rejected') then
    if not public.has_finance_privilege(array['finance_manager']) then
      raise exception 'Only the Finance Manager decides a payment.'
        using errcode = 'insufficient_privilege';
    end if;
    if _to_status = 'approved' and _p.status <> 'for_approval' then
      raise exception 'Only a payment awaiting approval can be approved.'
        using errcode = 'check_violation';
    end if;
    -- An authorisation may be withdrawn right up until the money moves.
    if _to_status in ('returned', 'rejected')
       and _p.status not in ('for_approval', 'approved') then
      raise exception 'Only a payment that has not been made can be %.', _to_status
        using errcode = 'check_violation';
    end if;
    -- Identity, not role: someone promoted overnight still cannot approve
    -- what they prepared yesterday.
    if _p.prepared_by = _me then
      raise exception 'You prepared payment %, so another Finance user must approve it.',
        _p.payment_no using errcode = 'insufficient_privilege';
    end if;

    update public.reimbursement_payments
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
    if _p.status <> 'approved' then
      raise exception 'This payment has not been approved for payment yet.'
        using errcode = 'check_violation';
    end if;
    if nullif(btrim(coalesce(_reference, '')), '') is null then
      raise exception 'Record the payment reference from the bank or receipt.'
        using errcode = 'check_violation';
    end if;
    -- Stated, never guessed. current_date here is UTC, and guessing with it is
    -- what dated a payment a day early in F6.
    if _payment_date is null then
      raise exception 'Record the date this payment was made.'
        using errcode = 'check_violation';
    end if;

    select * into _r from public.reimbursement_status where id = _p.finance_request_id;
    if _p.amount > _r.balance_due then
      raise exception 'Reimbursement % now has only % outstanding.',
        _r.request_no, to_char(_r.balance_due, 'FM999,999,990.00')
        using errcode = 'check_violation';
    end if;

    select * into _account from public.treasury_accounts
     where id = _p.treasury_account_id for update;
    _available := public.treasury_account_balance(_p.treasury_account_id);
    if _p.amount > _available then
      raise exception 'This account does not have enough available funds for this payment.'
        using errcode = 'check_violation';
    end if;

    update public.reimbursement_payments
       set status = 'paid',
           paid_by = _me,
           paid_at = now(),
           payment_date = _payment_date,
           reference = btrim(_reference)
     where id = _payment_id;

    -- Money leaves. The unique index on (source_type, source_id) means a
    -- retried transaction cannot write a second movement.
    insert into public.treasury_movements (
      treasury_account_id, direction, amount, source_type, source_id,
      occurred_on, reference, created_by
    ) values (
      _p.treasury_account_id, 'out', _p.amount, 'reimbursement_payment', _payment_id,
      _payment_date, btrim(_reference), _me
    );

  else
    raise exception 'A payment cannot move to %.', _to_status using errcode = 'check_violation';
  end if;

  insert into public.audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
  values (
    _me,
    'Reimbursement payment ' || _to_status,
    'reimbursement_payments',
    _payment_id,
    jsonb_build_object('status', _p.status),
    jsonb_build_object(
      'status', _to_status,
      'payment_no', _p.payment_no,
      'finance_request_id', _p.finance_request_id,
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
-- 4. An approved reimbursement that has been paid cannot be withdrawn
-- ---------------------------------------------------------------------------
--
-- Same reasoning as the F6 invoice void guard, and the same shape: a trigger
-- on the row every path must write, rather than an edit to
-- transition_finance_request -- a long function carrying an authority matrix
-- built across several phases, where reproducing it to insert two checks is
-- how a branch goes missing.
create or replace function public.guard_reimbursement_withdrawal()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  _paid numeric(14,2);
  _pending numeric(14,2);
begin
  if new.type <> 'reimbursement' then return new; end if;
  -- Only leaving 'approved' for a state that no longer owes anything matters.
  if old.status <> 'approved'
     or new.status not in ('returned', 'rejected', 'cancelled') then
    return new;
  end if;

  select coalesce(sum(p.amount) filter (where p.status = 'paid'), 0),
         coalesce(sum(p.amount) filter (where p.status in ('draft','for_approval','approved')), 0)
    into _paid, _pending
  from public.reimbursement_payments p
  where p.finance_request_id = old.id;

  if _paid > 0 then
    raise exception
      'This reimbursement has already been paid and cannot be withdrawn. A reversal process is required.'
      using errcode = 'check_violation';
  end if;

  if _pending > 0 then
    raise exception 'Resolve the pending payment instructions before withdrawing this reimbursement.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_reimbursement_withdrawal on public.finance_requests;
create trigger trg_reimbursement_withdrawal
  before update on public.finance_requests
  for each row execute function public.guard_reimbursement_withdrawal();

-- ---------------------------------------------------------------------------
-- 5. Reading
-- ---------------------------------------------------------------------------
create or replace function public.get_reimbursements()
returns setof public.reimbursement_status
language sql
stable
security definer
set search_path = ''
as $fn$
  select * from public.reimbursement_status v
  where public.can_read_finance_master()
     -- The claimant sees their own, whatever its state.
     or v.requester_id = (select auth.uid())
  order by v.created_at desc;
$fn$;

create or replace function public.get_reimbursement_payments(_request_id uuid default null)
returns table (
  id uuid,
  payment_no text,
  finance_request_id uuid,
  request_no text,
  requester_name text,
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
    p.id, p.payment_no, p.finance_request_id, fr.request_no, rq.full_name,
    p.treasury_account_id, ta.name, p.amount, p.method, p.payment_date,
    p.reference, p.notes, p.status,
    p.prepared_by, pp.full_name, p.submitted_at,
    p.approved_by, ap.full_name, p.approved_at,
    p.paid_by, yp.full_name, p.paid_at,
    p.decision_reason, p.created_at
  from public.reimbursement_payments p
  join public.finance_requests fr on fr.id = p.finance_request_id
  left join public.profiles rq on rq.id = fr.requester_id
  left join public.treasury_accounts ta on ta.id = p.treasury_account_id
  left join public.profiles pp on pp.id = p.prepared_by
  left join public.profiles ap on ap.id = p.approved_by
  left join public.profiles yp on yp.id = p.paid_by
  where public.can_read_finance_master()
    and (_request_id is null or p.finance_request_id = _request_id)
  order by p.created_at desc;
$fn$;

-- The approved reimbursements an Accountant can still prepare against.
create or replace function public.get_payable_reimbursements()
returns setof public.reimbursement_status
language sql
stable
security definer
set search_path = ''
as $fn$
  select * from public.reimbursement_status v
  where public.can_read_finance_master()
    and v.status = 'approved'
    and v.balance_due > 0
  order by v.expense_date nulls last, v.request_no;
$fn$;

revoke all on function public.create_reimbursement_payment(uuid, uuid, numeric, text, text, boolean) from public, anon;
revoke all on function public.transition_reimbursement_payment(uuid, text, text, text, date) from public, anon;
revoke all on function public.get_reimbursements() from public, anon;
revoke all on function public.get_reimbursement_payments(uuid) from public, anon;
revoke all on function public.get_payable_reimbursements() from public, anon;
revoke all on function public.reimbursement_paid(uuid) from public, anon;
revoke all on function public.reimbursement_pending_payment(uuid) from public, anon;

grant execute on function public.create_reimbursement_payment(uuid, uuid, numeric, text, text, boolean) to authenticated;
grant execute on function public.transition_reimbursement_payment(uuid, text, text, text, date) to authenticated;
grant execute on function public.get_reimbursements() to authenticated;
grant execute on function public.get_reimbursement_payments(uuid) to authenticated;
grant execute on function public.get_payable_reimbursements() to authenticated;
grant execute on function public.reimbursement_paid(uuid) to authenticated;
grant execute on function public.reimbursement_pending_payment(uuid) to authenticated;
