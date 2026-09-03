-- F4 consolidation -- an order is built once, from what was actually asked for
--
-- The hosted walkthrough found three faults that are really one fault.
--
--   1. "Create Purchase Order" wrote a purchase order to the database before
--      anybody had entered anything. Closing the dialog left a numbered,
--      zero-line order behind for ever. PO-2026-0003 in production is one.
--
--   2. The order was then built by hand, including a POS product dropdown fed
--      by pos_products -- which is Administrator-only. Finance reads nothing
--      from it, so the only option the dropdown could ever offer was
--      "Not POS stock", and every line was saved with pos_product_id = NULL.
--
--   3. Which is why an approved order for twenty bottles of Coca-Cola never
--      appeared under the branch's Deliveries: receiving keys on the line's
--      product and destination, and the line had neither.
--
-- Widening Finance's access to the POS catalogue would have fixed (2) and been
-- the wrong fix -- Finance would gain the whole enterprise catalogue in order
-- to fulfil one request. The request already knows its product and its branch.
-- So the order is built FROM the request, server-side, in one statement: the
-- facts are inherited rather than retyped, and there is no window in which a
-- half-made order exists.

-- ------------------------------------------------- what is left to order
--
-- Shared by the demand list and the builder so they cannot disagree about how
-- much is outstanding. Quantities on cancelled and rejected orders are not
-- outstanding demand -- they are demand that came back.
create or replace function public.pos_request_ordered_quantity(_request_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(sum(i.quantity_ordered - i.quantity_cancelled), 0)::integer
    from public.purchase_order_sources s
    join public.purchase_orders po on po.id = s.purchase_order_id
    join public.purchase_order_items i on i.purchase_order_id = po.id
   where s.pos_inventory_request_id = _request_id
     and po.status not in ('cancelled', 'rejected')
     and i.pos_product_id is not null;
$fn$;

revoke all on function public.pos_request_ordered_quantity(uuid) from public, anon, authenticated;

-- ------------------------------------------------------- the source, read once
--
-- Everything the builder needs about one piece of demand, and nothing else. A
-- narrow answer on purpose: it gives Finance this product and this branch,
-- not the catalogue they came from.
create or replace function public.get_procurement_source(_source_kind text, _source_id uuid)
returns table (
  source_kind        text,
  source_id          uuid,
  reference          text,
  title              text,
  product_id         uuid,
  product_name       text,
  branch_id          uuid,
  branch_name        text,
  requested_quantity integer,
  ordered_quantity   integer,
  outstanding        integer,
  requested_by_name  text,
  amount             numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if not public.has_finance_privilege(array['finance_staff', 'finance_manager']) then
    raise exception 'Only Finance may prepare a purchase order.'
      using errcode = 'insufficient_privilege';
  end if;

  if _source_kind = 'pos_restock' then
    return query
      select
        'pos_restock'::text,
        q.id,
        'Stock request'::text,
        coalesce(q.product_name_snapshot, p.name),
        q.product_id,
        coalesce(p.name, q.product_name_snapshot),
        q.branch_id,
        coalesce(b.name, q.branch_name_snapshot),
        q.requested_quantity,
        public.pos_request_ordered_quantity(q.id),
        greatest(q.requested_quantity - public.pos_request_ordered_quantity(q.id), 0),
        coalesce(q.requester_name_snapshot, 'Unknown'),
        null::numeric
      from public.pos_inventory_requests q
      left join public.pos_products p on p.id = q.product_id
      left join public.branches b on b.id = q.branch_id
      where q.id = _source_id
        and q.request_type = 'restock'
        and q.status = 'approved';

  elsif _source_kind = 'finance_request' then
    -- A general purchase names no product and no quantity: what to buy is
    -- Finance's judgement, which is why this mode builds its own lines. What
    -- it does carry is where the requester works, snapshotted when they asked.
    return query
      select
        'finance_request'::text,
        r.id,
        r.request_no,
        r.title,
        null::uuid,
        null::text,
        r.delivery_branch_id,
        b.name,
        null::integer,
        null::integer,
        null::integer,
        coalesce(pr.full_name, 'Unknown'),
        r.amount
      from public.finance_requests r
      left join public.branches b on b.id = r.delivery_branch_id
      left join public.profiles pr on pr.id = r.requester_id
      where r.id = _source_id
        and r.status = 'approved'
        and r.type = 'purchase';
  else
    raise exception 'Unknown procurement source %.', _source_kind using errcode = 'check_violation';
  end if;
end;
$fn$;

revoke all on function public.get_procurement_source(text, uuid) from public, anon;
grant execute on function public.get_procurement_source(text, uuid) to authenticated;

-- ------------------------------------------------------ build it, all at once
--
-- One statement, one transaction: the order, its link to the demand that
-- caused it, and its lines. Either all of it exists or none of it does, so
-- there is no orphan draft to leave behind and a failure halfway costs nothing
-- but a retry.
--
-- _submit decides the ending. false leaves a draft the maker meant to keep;
-- true submits it for approval in the same breath, which is the ordinary case.
create or replace function public.create_purchase_order_from_source(
  _source_kind text,
  _source_id uuid,
  _vendor_id uuid,
  _expected_delivery_date date default null,
  _notes text default null,
  _quantity integer default null,
  _unit_cost numeric default null,
  _lines jsonb default null,
  _submit boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid    uuid := (select auth.uid());
  _src    record;
  _po     uuid;
  _line   jsonb;
  _count  integer := 0;
begin
  if not public.has_finance_privilege(array['finance_staff']) then
    raise exception 'Preparing a purchase order is Finance Staff''s work.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into _src from public.get_procurement_source(_source_kind, _source_id);
  if _src.source_id is null then
    raise exception 'That demand is not available for procurement.' using errcode = 'no_data_found';
  end if;

  insert into public.purchase_orders
    (vendor_id, order_date, expected_delivery_date, notes, delivery_branch_id, created_by)
  values
    (_vendor_id, current_date, _expected_delivery_date, nullif(btrim(coalesce(_notes, '')), ''),
     _src.branch_id, _uid)
  returning id into _po;

  insert into public.purchase_order_sources
    (purchase_order_id, finance_request_id, pos_inventory_request_id)
  values (_po,
          case when _source_kind = 'finance_request' then _source_id end,
          case when _source_kind = 'pos_restock' then _source_id end);

  if _source_kind = 'pos_restock' then
    -- The product, the branch and the description are the request's, not the
    -- preparer's. Retyping them is how an order stops matching what a branch
    -- asked for, and a mistyped product is an order that can never be received.
    _quantity := coalesce(_quantity, _src.outstanding);

    if _quantity is null or _quantity <= 0 then
      raise exception 'There is nothing left outstanding on that request to order.'
        using errcode = 'check_violation';
    end if;
    if _quantity > _src.outstanding then
      raise exception 'That request has % left to order, not %.', _src.outstanding, _quantity
        using errcode = 'check_violation';
    end if;
    if _unit_cost is null or _unit_cost < 0 then
      raise exception 'Enter the unit cost before saving the order.'
        using errcode = 'check_violation';
    end if;

    insert into public.purchase_order_items
      (purchase_order_id, description, quantity_ordered, unit_cost,
       pos_product_id, destination_branch_id)
    values
      (_po, _src.product_name, _quantity, _unit_cost, _src.product_id, _src.branch_id);
    _count := 1;

  else
    -- A general purchase. Finance decides what actually gets bought, so the
    -- lines are theirs -- but they carry no POS product and no inventory
    -- destination, and therefore can never move stock however they are
    -- received. The delivery branch above is where the box goes; it is not an
    -- inventory destination and is deliberately recorded elsewhere.
    if _lines is null or jsonb_array_length(_lines) = 0 then
      raise exception 'Add at least one item to the order.' using errcode = 'check_violation';
    end if;

    for _line in select * from jsonb_array_elements(_lines) loop
      insert into public.purchase_order_items
        (purchase_order_id, description, quantity_ordered, unit_cost,
         pos_product_id, destination_branch_id)
      values
        (_po,
         public.require_business_reason(_line->>'description', 'each item on the order'),
         coalesce((_line->>'quantity')::integer, 0),
         coalesce((_line->>'unit_cost')::numeric, -1),
         null, null);
      _count := _count + 1;
    end loop;
  end if;

  if _submit then
    perform public.transition_purchase_order(_po, 'pending_approval', null);
  end if;

  return _po;
end;
$fn$;

revoke all on function public.create_purchase_order_from_source(
  text, uuid, uuid, date, text, integer, numeric, jsonb, boolean) from public, anon;
grant execute on function public.create_purchase_order_from_source(
  text, uuid, uuid, date, text, integer, numeric, jsonb, boolean) to authenticated;

-- --------------------------------------------------- discarding a real draft
--
-- A draft that was deliberately saved is a business record, so abandoning it
-- is a business transition: it takes a reason, it is audited, and the demand
-- it was going to satisfy becomes available again. (That last part needs no
-- code: the demand view and the outstanding calculation both ignore cancelled
-- orders, so the request reappears the moment this one does not count.)
create or replace function public.discard_purchase_order_draft(
  _purchase_order_id uuid,
  _reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _po record;
begin
  select * into _po from public.purchase_orders where id = _purchase_order_id for update;
  if _po.id is null then
    raise exception 'That purchase order no longer exists.' using errcode = 'no_data_found';
  end if;
  if _po.status not in ('draft', 'returned') then
    raise exception 'Only a draft can be discarded. This order is %.', _po.status
      using errcode = 'check_violation';
  end if;

  _reason := public.require_business_reason(_reason, 'discarding this draft');
  perform public.transition_purchase_order(_purchase_order_id, 'cancelled', _reason);
end;
$fn$;

revoke all on function public.discard_purchase_order_draft(uuid, text) from public, anon;
grant execute on function public.discard_purchase_order_draft(uuid, text) to authenticated;

-- ------------------------------------------- stopping the rest of a delivery
--
-- Ordered 20, received 6, and the supplier cannot supply the other 14.
-- Cancelling the order would be a lie -- six bottles are on the shelf. This
-- records what actually happened: fourteen were stopped, six stand, and the
-- order closes as short rather than as complete.
create or replace function public.cancel_purchase_order_remainder(
  _purchase_order_id uuid,
  _reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _po      record;
  _stopped integer := 0;
  _uid     uuid := (select auth.uid());
begin
  select * into _po from public.purchase_orders where id = _purchase_order_id for update;
  if _po.id is null then
    raise exception 'That purchase order no longer exists.' using errcode = 'no_data_found';
  end if;
  if not public.has_finance_privilege(array['finance_manager']) then
    raise exception 'Stopping an outstanding delivery is the Finance Manager''s decision.'
      using errcode = 'insufficient_privilege';
  end if;
  if _po.status <> 'approved' then
    raise exception 'Only an approved order has deliveries to stop. This order is %.', _po.status
      using errcode = 'check_violation';
  end if;

  _reason := public.require_business_reason(_reason, 'stopping the outstanding quantity');

  with received as (
    select i.id,
           i.quantity_ordered - i.quantity_cancelled
             - coalesce((select sum(r.quantity_received)
                           from public.procurement_receipts r
                          where r.purchase_order_item_id = i.id), 0) as outstanding
      from public.purchase_order_items i
     where i.purchase_order_id = _purchase_order_id
  )
  update public.purchase_order_items i
     set quantity_cancelled = i.quantity_cancelled + received.outstanding
    from received
   where i.id = received.id and received.outstanding > 0;

  get diagnostics _stopped = row_count;

  if _stopped = 0 then
    raise exception 'Nothing is outstanding on purchase order %.', _po.po_number
      using errcode = 'check_violation';
  end if;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (_uid, 'Purchase Order Remainder Cancelled', 'purchase_orders', _purchase_order_id,
          jsonb_build_object('po_number', _po.po_number, 'lines_affected', _stopped,
                             'reason', _reason));

  -- Everything ordered has now either arrived or been stopped, so the order is
  -- finished. Received stock is untouched -- what physically arrived stays on
  -- the shelf whatever happens to the paperwork.
  perform public.transition_purchase_order(_purchase_order_id, 'closed', _reason);

  return _stopped;
end;
$fn$;

revoke all on function public.cancel_purchase_order_remainder(uuid, text) from public, anon;
grant execute on function public.cancel_purchase_order_remainder(uuid, text) to authenticated;

comment on function public.cancel_purchase_order_remainder(uuid, text) is
  'Stop what has not arrived without pretending what did arrive never happened.';
