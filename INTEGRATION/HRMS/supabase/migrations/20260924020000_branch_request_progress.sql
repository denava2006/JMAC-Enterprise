-- FMS F4.2 -- a branch can see what happened to what it asked for
--
-- A POS Manager raises a restock request and then it goes quiet. Finance
-- accepts it, raises an order, the Manager approves the order -- and none of
-- that is visible at the branch, so the only way to find out is to ask
-- somebody. The state already exists in the procurement documents; this
-- reports it back to the branch that started it.
--
-- What it deliberately does not report is money. A POS Manager never sees unit
-- cost, line totals, margin or which vendor was chosen: that is procurement's
-- judgement and the branch's job is to receive what arrives. The columns are
-- not filtered in the client, they are absent from the function.

create or replace function public.get_branch_request_progress(_branch_id uuid)
returns table (
  request_id           uuid,
  product_id           uuid,
  product_name         text,
  requested_quantity   integer,
  requested_at         timestamptz,
  request_status       text,
  po_number            text,
  po_status            text,
  quantity_ordered     integer,
  quantity_received    integer,
  quantity_outstanding integer,
  progress             text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    r.id,
    r.product_id,
    p.name,
    r.requested_quantity,
    r.requested_at,
    r.status,
    po.po_number,
    po.status,
    i.quantity_ordered,
    coalesce(rc.received, 0)::integer,
    (coalesce(i.quantity_ordered, 0) - coalesce(rc.received, 0))::integer,
    -- One word for where this stands, derived rather than stored. Nothing here
    -- is a second copy of the request's state; it is the same documents read
    -- from the branch's side.
    case
      when r.status = 'declined'                          then 'declined'
      when r.status = 'cancelled'                         then 'withdrawn'
      when po.id is null and r.status = 'pending'         then 'with_finance'
      when po.id is null                                  then 'accepted'
      when po.status in ('draft', 'pending_approval')     then 'being_ordered'
      when po.status in ('rejected', 'cancelled')         then 'order_stopped'
      when coalesce(rc.received, 0) = 0                   then 'ordered'
      when coalesce(rc.received, 0) < i.quantity_ordered  then 'part_delivered'
      else 'delivered'
    end
  from public.pos_inventory_requests r
  join public.pos_products p on p.id = r.product_id
  -- The link from request to order, and from there to the line for this
  -- branch. Left joins throughout: a request that Finance has not turned into
  -- an order yet is the normal early case, not a missing row.
  left join public.purchase_order_sources s on s.pos_inventory_request_id = r.id
  left join public.purchase_orders po on po.id = s.purchase_order_id
  left join public.purchase_order_items i
    on i.purchase_order_id = po.id
   and i.pos_product_id = r.product_id
   and i.destination_branch_id = r.branch_id
  left join lateral (
    select sum(pr.quantity_received) as received
      from public.procurement_receipts pr
     where pr.purchase_order_item_id = i.id
  ) rc on true
  where r.branch_id = _branch_id
    and r.request_type = 'restock'
    and public.has_pos_role(_branch_id, array['manager']::public.pos_role[])
  order by r.requested_at desc;
$fn$;

revoke all on function public.get_branch_request_progress(uuid) from public, anon;
grant execute on function public.get_branch_request_progress(uuid) to authenticated;

comment on function public.get_branch_request_progress(uuid) is
  'What became of a branch''s restock requests, read from the procurement documents. Carries no cost of any kind.';
