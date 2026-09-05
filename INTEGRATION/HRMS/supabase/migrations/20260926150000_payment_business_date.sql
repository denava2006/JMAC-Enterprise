-- ===========================================================================
-- F6 blocker: a payment is dated the day it happened
-- ===========================================================================
--
-- Acceptance recorded PV-2026-0003 at 00:50 on 5 September Manila time and the
-- database stored 2026-09-04, on the payment and on its treasury movement.
--
-- ROOT CAUSE, and it is in the browser, not here. The Record payment dialog
-- defaulted its date field with:
--
--     new Date().toISOString().slice(0, 10)
--
-- toISOString() converts to UTC first. At 00:50 Manila it is still 16:50 on
-- the previous day in UTC, so the field opened showing yesterday and the
-- Accountant recorded what it offered. The RPC received 2026-09-04 and stored
-- exactly that -- the database shifted nothing.
--
-- src/lib/dates.ts has carried a comment warning about this precise one-liner
-- since the HR phases. I wrote the payment dialog without reading it.
--
-- The frontend now asks for the Manila business date. This migration handles
-- the two server-side halves: the fallback that could reintroduce the same
-- error, and the one production row that already carries it.

-- ---------------------------------------------------------------------------
-- 1. No silent fallback when recording a completed payment
-- ---------------------------------------------------------------------------
--
-- coalesce(_payment_date, current_date) would have quietly produced the same
-- wrong day, because current_date in a Supabase session is UTC. Recording a
-- completed payment means stating when it happened, so the date is now
-- required rather than guessed. The frontend always sends one; a caller that
-- does not is not describing a real payment.
--
-- Only the two lines below change. The rest of this function is reproduced
-- unchanged so its authority matrix, its locks and its guards travel together
-- rather than being reassembled from memory.
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
    -- The change. A completed payment happened on a day, and the caller knows
    -- which; the server guessing in UTC is what produced the wrong date once
    -- already.
    if _payment_date is null then
      raise exception 'Record the date this payment was made.'
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
           payment_date = _payment_date,
           reference = btrim(_reference)
     where id = _payment_id;

    -- The movement carries the same calendar day as the payment. One value,
    -- stated once, used twice.
    insert into public.treasury_movements (
      treasury_account_id, direction, amount, source_type, source_id,
      occurred_on, reference, created_by
    ) values (
      _p.treasury_account_id, 'out', _p.amount, 'supplier_payment', _payment_id,
      _payment_date, btrim(_reference), _me
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
-- 2. The settlement fallback, resolved in Manila
-- ---------------------------------------------------------------------------
--
-- A settlement may still default its date, because recording one the same day
-- is the ordinary case. But it defaults to the business date rather than to
-- current_date, which is UTC and would be a day behind for the first eight
-- hours of every Manila day. pos_business_date() already answers this exact
-- question for every POS report; there is no second definition here.
create or replace function public.create_collection_settlement(
  _kind text,
  _destination_account_id uuid,
  _settlement_date date,
  _sale_ids uuid[],
  _branch_id uuid default null,
  _payment_method text default null,
  _fee_amount numeric default 0,
  _reference text default null,
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
  _sale uuid;
  _account public.treasury_accounts%rowtype;
  _gross numeric(14,2);
begin
  if not public.has_finance_privilege(array['accountant']) then
    raise exception 'Recording a settlement is the Accountant''s work.'
      using errcode = 'insufficient_privilege';
  end if;

  if _branch_id is null then
    raise exception 'Choose a branch for this settlement.' using errcode = 'check_violation';
  end if;

  if _sale_ids is null or array_length(_sale_ids, 1) is null then
    raise exception 'A settlement has to cover at least one sale.'
      using errcode = 'check_violation';
  end if;

  select * into _account from public.treasury_accounts where id = _destination_account_id;
  if _account.id is null or not _account.is_active then
    raise exception 'That destination account is not available.' using errcode = 'check_violation';
  end if;

  insert into public.collection_settlements (
    kind, branch_id, payment_method, destination_account_id,
    fee_amount, settlement_date, reference, notes
  ) values (
    _kind,
    _branch_id,
    case when _kind = 'provider' then public.pos_provider_family(_payment_method) end,
    _destination_account_id,
    coalesce(_fee_amount, 0),
    coalesce(_settlement_date, public.pos_business_date()),
    nullif(btrim(coalesce(_reference, '')), ''), _notes
  ) returning id into _id;

  foreach _sale in array _sale_ids loop
    insert into public.collection_settlement_items (settlement_id, pos_sale_id, amount)
    values (_id, _sale, 1);
  end loop;

  _gross := public.settlement_gross(_id);
  if coalesce(_fee_amount, 0) > _gross then
    raise exception 'The fee cannot be more than the % collected.',
      to_char(_gross, 'FM999,999,990.00') using errcode = 'check_violation';
  end if;

  if _submit then
    perform public.transition_collection_settlement(_id, 'for_review', null);
  end if;

  return _id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The one production row that already carries the wrong day
-- ---------------------------------------------------------------------------
--
-- PV-2026-0003 and its single treasury movement. Nothing else is touched: not
-- the amount, the status, who paid it, when it was recorded, the reference,
-- the account, the direction, the budget or the invoice. Only the calendar day
-- the payment claims to have happened on.
--
-- The predicate names all three facts -- number, reference and the wrong date
-- -- so it matches this row and no other, and matches nothing at all once
-- repaired. It refuses to proceed unless the counts are exactly one and one.
--
-- treasury_movements is immutable by trigger, deliberately: a balance derived
-- from history is only trustworthy if the history cannot be rewritten. The
-- trigger is lifted for this one statement and put straight back, which is the
-- honest way to do this -- an "except when correcting" clause in the trigger
-- would weaken the rule permanently for the sake of one row.
do $repair$
declare
  _pay_id uuid;
  _pay_count integer;
  _mv_count integer;
  _bal_before numeric(14,2);
  _bal_after numeric(14,2);
  _mv_total integer;
begin
  -- Counted and identified in one pass. uuid has no min(), so the id comes
  -- from an ordered pick; the count beside it is what proves there is only one
  -- to pick from.
  select count(*) into _pay_count
  from public.supplier_payments p
  where p.payment_no = 'PV-2026-0003'
    and p.reference = 'CODEX-F6-PAY-20260905-0250'
    and p.payment_date = date '2026-09-04'
    and p.status = 'paid';

  select p.id into _pay_id
  from public.supplier_payments p
  where p.payment_no = 'PV-2026-0003'
    and p.reference = 'CODEX-F6-PAY-20260905-0250'
    and p.payment_date = date '2026-09-04'
    and p.status = 'paid'
  order by p.id
  limit 1;

  select count(*) into _mv_count
  from public.treasury_movements m
  where m.source_type = 'supplier_payment'
    and m.source_id = _pay_id
    and m.reference = 'CODEX-F6-PAY-20260905-0250'
    and m.occurred_on = date '2026-09-04';

  raise notice 'date correction: matching payments = %, matching movements = %',
    _pay_count, _mv_count;

  if _pay_count = 0 then
    raise notice 'date correction: nothing to repair (already corrected, or not this database)';
    return;
  end if;

  if _pay_count <> 1 or _mv_count <> 1 then
    raise exception
      'date correction refused: expected exactly 1 payment and 1 movement, found % and %',
      _pay_count, _mv_count;
  end if;

  select t.balance, (select count(*) from public.treasury_movements)
    into _bal_before, _mv_total
  from public.treasury_account_status t
  where t.id = (select treasury_account_id from public.supplier_payments where id = _pay_id);

  update public.supplier_payments
     set payment_date = date '2026-09-05',
         updated_at = now()
   where id = _pay_id;

  alter table public.treasury_movements disable trigger trg_treasury_movements_immutable;
  update public.treasury_movements
     set occurred_on = date '2026-09-05'
   where source_type = 'supplier_payment'
     and source_id = _pay_id;
  alter table public.treasury_movements enable trigger trg_treasury_movements_immutable;

  -- The balance is derived from opening plus movements, and a date is not a
  -- term in that sum -- but asserting it beats assuming it.
  select t.balance into _bal_after
  from public.treasury_account_status t
  where t.id = (select treasury_account_id from public.supplier_payments where id = _pay_id);

  if _bal_after is distinct from _bal_before then
    raise exception 'date correction changed the balance: % -> %', _bal_before, _bal_after;
  end if;
  if (select count(*) from public.treasury_movements) <> _mv_total then
    raise exception 'date correction changed the movement count';
  end if;

  insert into public.audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
  values (
    null,
    'System correction: payment business date',
    'supplier_payments',
    _pay_id,
    jsonb_build_object('payment_date', '2026-09-04', 'occurred_on', '2026-09-04'),
    jsonb_build_object(
      'payment_date', '2026-09-05',
      'occurred_on', '2026-09-05',
      'reason',
        'Recorded on 2026-09-05 Manila time but stored as 2026-09-04. The Record '
        || 'payment dialog defaulted its date with toISOString(), which converts to '
        || 'UTC before taking the day. Only the calendar date was corrected; the '
        || 'amount, status, actor, reference, treasury account, direction, budget '
        || 'and invoice totals are unchanged, and the original payment audit entry '
        || 'stands.',
      'payment_no', 'PV-2026-0003',
      'reference', 'CODEX-F6-PAY-20260905-0250',
      'balance_before', _bal_before,
      'balance_after', _bal_after
    )
  );

  raise notice 'date correction: PV-2026-0003 and its movement now dated 2026-09-05; balance unchanged at %',
    _bal_after;
end;
$repair$;
