-- ===========================================================================
-- F6A  The settlement workflow, and the moment money is recognised
-- ===========================================================================
--
-- Draft -> For review -> Confirmed, with Returned and Rejected as the two ways
-- back. Confirmed is the only state that touches a treasury balance, and it
-- means one specific thing: the company recognises that the destination
-- account received the net amount. It is a record of something that already
-- happened in the world, not an instruction to make it happen.
--
-- The treasury movement is written exactly once, at confirmation, and the
-- unique index on (source_type, source_id) is what makes that true under a
-- double click, a retry, or two Managers pressing Confirm at the same instant.

-- ---------------------------------------------------------------------------
-- What is still waiting to be settled
-- ---------------------------------------------------------------------------
--
-- The eligible set: completed sales, of the right method, not already covered
-- by a live settlement. Note what cannot appear here without any status list
-- being written -- a failed, cancelled, expired or paid_unfulfilled attempt
-- never produced a pos_sales row, so it has nothing to offer.
create or replace function public.get_unsettled_collections(
  _kind text,
  _branch_id uuid default null,
  _payment_method text default null,
  _from_date date default null,
  _to_date date default null
)
returns table (
  sale_id uuid,
  sold_at timestamptz,
  branch_id uuid,
  branch_name text,
  cashier_name text,
  payment_method text,
  payment_reference text,
  amount numeric
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    s.id, s.created_at, s.branch_id, s.branch_name, s.cashier_name,
    s.payment_method, s.payment_reference, s.total_amount
  from public.pos_report_bounds(_from_date, _to_date) b
  join public.pos_sales s
    on s.status = 'completed'
   and s.created_at >= b.period_start
   and s.created_at < b.period_end
  where public.can_read_finance_master()
    and case
          when _kind = 'branch_cash' then
            s.payment_method = 'cash' and (_branch_id is null or s.branch_id = _branch_id)
          else
            s.payment_method <> 'cash'
            and (_payment_method is null or s.payment_method = _payment_method)
        end
    and not exists (
      select 1
      from public.collection_settlement_items i
      join public.collection_settlements cs on cs.id = i.settlement_id
      where i.pos_sale_id = s.id
        and cs.status not in ('returned', 'rejected')
    )
  order by s.created_at, s.id;
$fn$;

-- ---------------------------------------------------------------------------
-- Preparing one
-- ---------------------------------------------------------------------------
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
    _kind, _branch_id, _payment_method, _destination_account_id,
    coalesce(_fee_amount, 0), coalesce(_settlement_date, current_date),
    nullif(btrim(coalesce(_reference, '')), ''), _notes
  ) returning id into _id;

  -- Each line is validated by guard_settlement_item_once: completed, right
  -- method, right branch, and not already settled. The amount is taken from
  -- the sale rather than from the caller.
  foreach _sale in array _sale_ids loop
    insert into public.collection_settlement_items (settlement_id, pos_sale_id, amount)
    values (_id, _sale, 1);
  end loop;

  -- A provider fee cannot exceed what the provider collected, or the "net"
  -- reaching the bank would be negative and the record would be describing
  -- something that did not happen.
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
-- Moving it along
-- ---------------------------------------------------------------------------
create or replace function public.transition_collection_settlement(
  _settlement_id uuid,
  _to_status text,
  _reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _s public.collection_settlements%rowtype;
  _me uuid := (select auth.uid());
  _gross numeric(14,2);
  _net numeric(14,2);
begin
  -- Locked for the duration: two Managers pressing Confirm at the same moment
  -- serialise here, and the second one finds the status already moved.
  select * into _s from public.collection_settlements
   where id = _settlement_id for update;
  if _s.id is null then
    raise exception 'That settlement is not available.' using errcode = 'check_violation';
  end if;

  _gross := public.settlement_gross(_settlement_id);
  _net := _gross - _s.fee_amount;

  -- Going backwards always needs a reason. Somebody has to answer for it later.
  if _to_status in ('returned', 'rejected')
     and nullif(btrim(coalesce(_reason, '')), '') is null then
    raise exception 'Say why this settlement is being %.',
      case _to_status when 'returned' then 'returned' else 'rejected' end
      using errcode = 'check_violation';
  end if;

  if _to_status = 'for_review' then
    if not public.has_finance_privilege(array['accountant']) then
      raise exception 'Only the Accountant submits a settlement for review.'
        using errcode = 'insufficient_privilege';
    end if;
    if _s.status not in ('draft', 'returned') then
      raise exception 'Only a draft can be submitted.' using errcode = 'check_violation';
    end if;
    if _gross <= 0 then
      raise exception 'This settlement covers no sales.' using errcode = 'check_violation';
    end if;
    update public.collection_settlements
       set status = 'for_review', submitted_at = now(), decision_reason = null
     where id = _settlement_id;

  elsif _to_status in ('confirmed', 'returned', 'rejected') then
    if not public.has_finance_privilege(array['finance_manager']) then
      raise exception 'Only the Finance Manager decides a settlement.'
        using errcode = 'insufficient_privilege';
    end if;
    if _s.status <> 'for_review' then
      raise exception 'Only a settlement under review can be decided.'
        using errcode = 'check_violation';
    end if;
    -- Identity, not role. Someone who prepared this yesterday and was promoted
    -- this morning still may not approve their own work.
    if _s.prepared_by = _me then
      raise exception 'You prepared settlement %, so somebody else has to confirm it.',
        _s.settlement_no using errcode = 'insufficient_privilege';
    end if;

    update public.collection_settlements
       set status = _to_status,
           reviewed_by = _me,
           reviewed_at = now(),
           decision_reason = nullif(btrim(coalesce(_reason, '')), '')
     where id = _settlement_id;

    if _to_status = 'confirmed' then
      if _net <= 0 then
        raise exception 'The net amount has to be more than nothing.'
          using errcode = 'check_violation';
      end if;
      -- The money arrives. One row, and the unique index on
      -- (source_type, source_id) means a retry of this whole function inserts
      -- nothing the second time rather than crediting the bank twice.
      insert into public.treasury_movements (
        treasury_account_id, direction, amount, source_type, source_id,
        occurred_on, reference, created_by
      ) values (
        _s.destination_account_id, 'in', _net, 'collection_settlement', _settlement_id,
        _s.settlement_date, _s.reference, _me
      );
    end if;

  else
    raise exception 'A settlement cannot move to %.', _to_status using errcode = 'check_violation';
  end if;

  -- Old and new state, the reason, and the external reference -- so a balance
  -- can be explained months later without opening the document.
  insert into public.audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
  values (
    _me,
    'Settlement ' || _to_status,
    'collection_settlements',
    _settlement_id,
    jsonb_build_object('status', _s.status),
    jsonb_build_object(
      'status', _to_status,
      'settlement_no', _s.settlement_no,
      'gross', _gross,
      'fee', _s.fee_amount,
      'net', _net,
      'destination_account_id', _s.destination_account_id,
      'reference', _s.reference,
      'reason', nullif(btrim(coalesce(_reason, '')), '')
    )
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Reading them
-- ---------------------------------------------------------------------------
create or replace function public.get_collection_settlements()
returns setof public.collection_settlement_status
language sql
stable
security definer
set search_path = ''
as $fn$
  select * from public.collection_settlement_status
  where public.can_read_finance_master()
  order by settlement_date desc, created_at desc;
$fn$;

create or replace function public.get_collection_settlement_items(_settlement_id uuid)
returns table (
  id uuid,
  pos_sale_id uuid,
  sold_at timestamptz,
  branch_name text,
  cashier_name text,
  payment_method text,
  payment_reference text,
  amount numeric
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select i.id, i.pos_sale_id, s.created_at, s.branch_name, s.cashier_name,
         s.payment_method, s.payment_reference, i.amount
  from public.collection_settlement_items i
  join public.pos_sales s on s.id = i.pos_sale_id
  where public.can_read_finance_master()
    and i.settlement_id = _settlement_id
  order by s.created_at;
$fn$;

revoke all on function public.get_unsettled_collections(text, uuid, text, date, date) from public, anon;
revoke all on function public.create_collection_settlement(text, uuid, date, uuid[], uuid, text, numeric, text, text, boolean) from public, anon;
revoke all on function public.transition_collection_settlement(uuid, text, text) from public, anon;
revoke all on function public.get_collection_settlements() from public, anon;
revoke all on function public.get_collection_settlement_items(uuid) from public, anon;
revoke all on function public.settlement_gross(uuid) from public, anon;

grant execute on function public.get_unsettled_collections(text, uuid, text, date, date) to authenticated;
grant execute on function public.create_collection_settlement(text, uuid, date, uuid[], uuid, text, numeric, text, text, boolean) to authenticated;
grant execute on function public.transition_collection_settlement(uuid, text, text) to authenticated;
grant execute on function public.get_collection_settlements() to authenticated;
grant execute on function public.get_collection_settlement_items(uuid) to authenticated;
grant execute on function public.settlement_gross(uuid) to authenticated;
