-- ===========================================================================
-- F6 integrity: an invoice that has been paid cannot be voided away
-- ===========================================================================
--
-- Hosted acceptance produced a state that should not exist: SI-93842 is
-- voided, and 1,300.00 has been paid against it, with a treasury movement to
-- match. Voiding says "this bill was never valid"; the payment says "we paid
-- it". Both cannot be true, and the money is the part that actually happened.
--
-- transition_supplier_invoice let a Finance Manager void an approved invoice
-- without ever asking whether anything had been paid. That was fine when
-- nothing could pay an invoice. F6B changed that and this check was not added
-- with it -- my omission.
--
-- Voiding is not a reversal. F6 has no payment reversal, no supplier credit
-- note and no refund, so voiding a paid invoice does not undo the payment; it
-- just hides the bill the payment answered. Until a reversal exists, a paid
-- invoice has to stay.

-- ---------------------------------------------------------------------------
-- 1. The guard, on the row every void must write
-- ---------------------------------------------------------------------------
--
-- A trigger rather than an edit to transition_supplier_invoice. That function
-- is long and carries an authority matrix built over two phases; reproducing
-- it to insert two checks is how a branch of it goes missing. This sits on the
-- boundary instead, so it holds for the workflow function, for a direct
-- UPDATE, and for whatever route is added next.
create or replace function public.guard_invoice_void()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  _paid numeric(14,2);
  _pending numeric(14,2);
begin
  if new.status <> 'voided' or old.status = 'voided' then
    return new;
  end if;

  select coalesce(sum(p.amount) filter (where p.status = 'paid'), 0),
         coalesce(sum(p.amount) filter (where p.status in ('draft','for_approval','approved')), 0)
    into _paid, _pending
  from public.supplier_payments p
  where p.supplier_invoice_id = old.id;

  -- Money that has actually left the company. There is nothing this phase can
  -- do to take it back, so the bill it paid stays on the books.
  if _paid > 0 then
    raise exception
      'This invoice already has recorded payments and cannot be voided. A reversal process is required.'
      using errcode = 'check_violation';
  end if;

  -- Instructions still in flight. Voiding underneath them would leave a
  -- payment pointing at a bill the company says was never real -- so they are
  -- resolved first, by the person who raised them.
  if _pending > 0 then
    raise exception 'Resolve the pending payment instructions before voiding this invoice.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_invoice_void_guard on public.supplier_invoices;
create trigger trg_invoice_void_guard
  before update on public.supplier_invoices
  for each row execute function public.guard_invoice_void();

comment on function public.guard_invoice_void() is
  'Refuses to void an invoice carrying paid or in-flight payments. Voiding is '
  'not a reversal, and F6 has no reversal to offer.';

-- ---------------------------------------------------------------------------
-- 2. Repairing the row that already exists
-- ---------------------------------------------------------------------------
--
-- Written as a condition, not as an id: the invariant is "voided while paid",
-- and anything matching it is wrong for the same reason. Idempotent, because
-- once repaired nothing matches.
--
-- Nothing financial moves. The payment, the treasury movement, the amount
-- paid, the balance and the earlier void record all stay exactly as they are.
-- Only the workflow status is put back to the last state that was true, and
-- the history says why.
do $repair$
declare
  _before integer;
  _after integer;
  _r record;
begin
  select count(*) into _before
  from public.supplier_invoice_status v
  where v.status = 'voided' and v.amount_paid > 0;

  raise notice 'invoices voided while paid, before repair: %', _before;

  for _r in
    select v.id, v.invoice_no, v.amount_paid
    from public.supplier_invoice_status v
    where v.status = 'voided' and v.amount_paid > 0
  loop
    -- The void record is left in place above this one. Two entries, in order:
    -- what was done, and what was put right.
    insert into public.supplier_invoice_history
      (supplier_invoice_id, actor_id, role_at_action, action, from_status, to_status, remarks)
    values (
      _r.id, null, 'system', 'system_correction', 'voided', 'approved',
      'Invalid void-after-payment state restored to approved. '
        || to_char(_r.amount_paid, 'FM999,999,990.00')
        || ' had been paid against this invoice, and voiding is not a reversal. '
        || 'The payment, its treasury movement and the original void record are unchanged.'
    );

    update public.supplier_invoices
       set status = 'approved',
           decision_reason = null,
           updated_at = now()
     where id = _r.id;

    raise notice 'restored % to approved (% paid)', _r.invoice_no, _r.amount_paid;
  end loop;

  select count(*) into _after
  from public.supplier_invoice_status v
  where v.status = 'voided' and v.amount_paid > 0;

  raise notice 'invoices voided while paid, after repair: %', _after;

  if _after <> 0 then
    raise exception 'repair failed: % invoice(s) are still voided while paid', _after;
  end if;
end;
$repair$;

-- ---------------------------------------------------------------------------
-- 3. A returned payment cannot be resubmitted into a full payable
-- ---------------------------------------------------------------------------
--
-- The over-instruction guard was added at creation only. A payment that was
-- returned still exists, and submitting it again is another way of claiming
-- the same money -- so PV-2026-0001 sat there offering Submit against an
-- invoice with nothing left to pay.
--
-- The sum deliberately excludes the payment being submitted. It is not yet
-- live, and counting it against itself would refuse every resubmission.
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
  _siblings numeric(14,2);
  _account public.treasury_accounts%rowtype;
  _locked uuid;
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

    -- Same rule as creation, same lock order: the payable is locked before
    -- what is available is read, so two submissions cannot both see room.
    select id into _locked from public.supplier_invoices
     where id = _p.supplier_invoice_id for update;

    select * into _inv from public.supplier_invoice_status where id = _p.supplier_invoice_id;

    select coalesce(sum(s.amount), 0)::numeric(14,2) into _siblings
    from public.supplier_payments s
    where s.supplier_invoice_id = _p.supplier_invoice_id
      and s.id <> _payment_id
      and s.status in ('draft', 'for_approval', 'approved');

    _available := greatest(_inv.balance_due - _siblings, 0);

    if _p.amount > _available then
      if _available <= 0 then
        raise exception
          'This invoice no longer has a balance available for this payment.'
          using errcode = 'check_violation';
      else
        raise exception
          'This invoice only has % available, and this payment is for %.',
          to_char(_available, 'FM999,999,990.00'),
          to_char(_p.amount, 'FM999,999,990.00')
          using errcode = 'check_violation';
      end if;
    end if;

    update public.supplier_payments
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
    -- Withdrawing an authorisation stays reachable until the money moves.
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

-- ---------------------------------------------------------------------------
-- 4. Whether a returned payment can still be offered
-- ---------------------------------------------------------------------------
--
-- So the screen can ask the same question the server will, rather than
-- offering a Submit button that is about to be refused.
create or replace function public.payment_can_be_submitted(_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select case
    when p.status not in ('draft', 'returned') then false
    else p.amount <= greatest(
      v.balance_due - coalesce((
        select sum(s.amount) from public.supplier_payments s
        where s.supplier_invoice_id = p.supplier_invoice_id
          and s.id <> p.id
          and s.status in ('draft', 'for_approval', 'approved')
      ), 0), 0)
  end
  from public.supplier_payments p
  join public.supplier_invoice_status v on v.id = p.supplier_invoice_id
  where p.id = _payment_id;
$fn$;

revoke all on function public.payment_can_be_submitted(uuid) from public, anon;
grant execute on function public.payment_can_be_submitted(uuid) to authenticated;
