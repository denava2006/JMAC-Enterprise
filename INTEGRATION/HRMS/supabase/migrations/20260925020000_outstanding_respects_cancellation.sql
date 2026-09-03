-- F4 consolidation -- cancelled quantity is not outstanding quantity
--
-- quantity_cancelled now exists, so everything that asks "how much is still
-- coming?" has to subtract it. Three places ask, and they must agree:
-- receiving, closing, and what a branch is shown.
--
-- Reasons are also enforced here on the transitions that stop, return or
-- refuse a purchase order, for the same argument as everywhere else: it is
-- answerable only in the moment, and worthless reconstructed later.

-- --------------------------------------------------------------- receiving
--
-- Stopped quantity must not be receivable. The guard lives on the receipts
-- table rather than inside receive_procurement_stock, deliberately.
--
-- That function claims the receipt row first so the idempotency key is taken
-- before any side effect, then passes that receipt id to apply_pos_receipt as
-- the movement source, then links the movement back. Reproducing 90 lines of
-- that ordering to tighten one comparison is how a retry quietly starts
-- doubling stock. A trigger on the row every receipt must pass through gets
-- the same rule with none of that risk -- and it also covers apply_pos_receipt
-- reaching the table by any future path.
create or replace function public.guard_receipt_within_outstanding()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  _item     record;
  _received integer;
begin
  select * into _item from public.purchase_order_items where id = new.purchase_order_item_id;
  if _item.id is null then
    raise exception 'That order line no longer exists.' using errcode = 'no_data_found';
  end if;

  select coalesce(sum(quantity_received), 0) into _received
    from public.procurement_receipts
   where purchase_order_item_id = new.purchase_order_item_id
     and id is distinct from new.id;

  if _received + new.quantity_received > _item.quantity_ordered - _item.quantity_cancelled then
    raise exception
      'Only % of % remain outstanding on this line; % cannot be received.',
      greatest(_item.quantity_ordered - _item.quantity_cancelled - _received, 0),
      _item.quantity_ordered, new.quantity_received
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

revoke all on function public.guard_receipt_within_outstanding() from public, anon, authenticated;

drop trigger if exists trg_receipt_within_outstanding on public.procurement_receipts;
create trigger trg_receipt_within_outstanding
  before insert on public.procurement_receipts
  for each row execute function public.guard_receipt_within_outstanding();

-- ------------------------------------------------------------- what a branch sees
--
-- Same shape as before, with two corrections: stopped quantity is reported as
-- stopped rather than as still coming, and a request whose order was cancelled
-- says so instead of falling silently back to looking unstarted.
-- Gains a quantity_cancelled column, which changes the return type, so the old
-- one is dropped rather than replaced. Forward-only: nothing reads it between
-- these two statements.
drop function if exists public.get_branch_request_progress(uuid);

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
  quantity_cancelled   integer,
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
    greatest(coalesce(i.quantity_ordered, 0) - coalesce(i.quantity_cancelled, 0)
             - coalesce(rc.received, 0), 0)::integer,
    coalesce(i.quantity_cancelled, 0)::integer,
    case
      when r.status = 'declined'  then 'declined'
      when r.status = 'cancelled' then 'withdrawn'
      -- An order that was raised and then stopped is not the same as one that
      -- was never raised. The branch is told procurement reopened rather than
      -- being quietly returned to the start.
      when cancelled_po.id is not null and po.id is null then 'procurement_reopened'
      when po.id is null and r.status = 'pending'     then 'with_finance'
      when po.id is null                              then 'accepted'
      when po.status in ('draft', 'pending_approval') then 'being_ordered'
      when po.status in ('rejected', 'cancelled')     then 'order_stopped'
      when coalesce(rc.received, 0) = 0               then 'ordered'
      when coalesce(rc.received, 0) < i.quantity_ordered - coalesce(i.quantity_cancelled, 0)
                                                      then 'part_delivered'
      else 'delivered'
    end
  from public.pos_inventory_requests r
  join public.pos_products p on p.id = r.product_id
  left join public.purchase_order_sources s on s.pos_inventory_request_id = r.id
  left join public.purchase_orders po
    on po.id = s.purchase_order_id and po.status not in ('cancelled', 'rejected')
  left join public.purchase_order_items i
    on i.purchase_order_id = po.id
   and i.pos_product_id = r.product_id
   and i.destination_branch_id = r.branch_id
  left join lateral (
    select pc.id
      from public.purchase_order_sources ps
      join public.purchase_orders pc on pc.id = ps.purchase_order_id
     where ps.pos_inventory_request_id = r.id
       and pc.status in ('cancelled', 'rejected')
     limit 1
  ) cancelled_po on true
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

-- -------------------------------------------------- what a branch may receive
--
-- Same correction, so a branch is not shown a delivery it can no longer take.
create or replace function public.get_branch_deliveries(_branch_id uuid)
returns table (
  purchase_order_item_id uuid,
  po_number              text,
  expected_delivery_date date,
  product_id             uuid,
  product_name           text,
  quantity_ordered       integer,
  quantity_received      integer,
  quantity_outstanding   integer
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    i.id,
    po.po_number,
    po.expected_delivery_date,
    i.pos_product_id,
    p.name,
    i.quantity_ordered,
    coalesce(r.received, 0)::integer,
    (i.quantity_ordered - i.quantity_cancelled - coalesce(r.received, 0))::integer
  from public.purchase_order_items i
  join public.purchase_orders po on po.id = i.purchase_order_id
  join public.pos_products p on p.id = i.pos_product_id
  left join lateral (
    select sum(pr.quantity_received) as received
    from public.procurement_receipts pr
    where pr.purchase_order_item_id = i.id
  ) r on true
  where po.status = 'approved'
    and i.destination_branch_id = _branch_id
    and i.pos_product_id is not null
    -- A completed line stays listed. The branch reads this to see what it
    -- ordered and what arrived, not only what it still owes, and hiding a line
    -- the moment the last unit lands would make a delivery look unrecorded.
    and public.has_pos_role(_branch_id, array['manager']::public.pos_role[])
  order by po.expected_delivery_date nulls last, po.po_number;
$fn$;

-- ------------------------------------------------------------- the transition
--
-- Two changes: outstanding excludes stopped quantity, and the transitions that
-- stop, return or refuse an order now insist on a reason. The message when a
-- partially delivered order is cancelled outright now names the thing to do
-- instead, rather than only refusing.
create or replace function public.transition_purchase_order(
  _purchase_order_id uuid,
  _to_status text,
  _remarks text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _po          record;
  _uid         uuid := (select auth.uid());
  _role        text;
  _allowed     boolean := false;
  _lines       integer;
  _vendor      record;
  _outstanding integer;
  _action      text;
begin
  select * into _po from public.purchase_orders where id = _purchase_order_id for update;
  if _po.id is null then
    raise exception 'That purchase order no longer exists.' using errcode = 'no_data_found';
  end if;

  select role::text into _role from public.profiles where id = _uid and status = 'active';
  if _role is null or not public.has_finance_privilege(array[_role]) then
    raise exception 'Only Finance can move a purchase order.' using errcode = 'insufficient_privilege';
  end if;

  if _role = 'finance_staff' and _po.status = 'draft' and _to_status = 'pending_approval' then
    _allowed := true;
  elsif _role = 'finance_staff' and _po.status = 'returned' and _to_status = 'pending_approval' then
    _allowed := true;
  elsif _role = 'finance_staff' and _po.status in ('draft', 'returned') and _to_status = 'cancelled' then
    _allowed := true;
  elsif _role = 'finance_manager' and _po.status = 'pending_approval'
        and _to_status in ('approved', 'returned', 'rejected') then
    _allowed := true;
  elsif _role = 'finance_manager' and _po.status = 'approved' and _to_status = 'cancelled' then
    _allowed := true;
  elsif _role = 'finance_manager' and _po.status = 'approved' and _to_status = 'closed' then
    _allowed := true;
  end if;

  if not _allowed then
    raise exception 'A % cannot move purchase order % from % to %.',
      _role, _po.po_number, _po.status, _to_status
      using errcode = 'insufficient_privilege';
  end if;

  -- Nobody approves the order they raised.
  if _to_status = 'approved' and _po.created_by is not distinct from _uid then
    raise exception 'You raised purchase order %, so somebody else has to approve it.', _po.po_number
      using errcode = 'insufficient_privilege';
  end if;

  -- Stopping, returning or refusing takes a reason. Approving and submitting
  -- do not: what an approval means is answered by the approval itself.
  if _to_status in ('returned', 'rejected', 'cancelled') then
    _remarks := public.require_business_reason(_remarks,
      case _to_status
        when 'returned'  then 'returning this order for revision'
        when 'rejected'  then 'rejecting this order'
        else 'cancelling this order'
      end);
  end if;

  if _to_status = 'pending_approval' then
    select count(*) into _lines from public.purchase_order_items where purchase_order_id = _po.id;
    if _lines = 0 then
      raise exception 'Add at least one line before submitting purchase order %.', _po.po_number
        using errcode = 'check_violation';
    end if;
  end if;

  if _to_status in ('pending_approval', 'approved') then
    select * into _vendor from public.vendors where id = _po.vendor_id;
    if _vendor.approval_status <> 'approved' then
      raise exception 'Vendor % is not an approved supplier yet.', _vendor.name
        using errcode = 'check_violation';
    end if;
    if not _vendor.is_active then
      raise exception 'Vendor % is no longer active.', _vendor.name
        using errcode = 'check_violation';
    end if;
  end if;

  -- Cancelling an order that has already taken delivery would claim the
  -- delivered part never happened. The remainder is what can be stopped.
  if _to_status = 'cancelled' and exists (
    select 1 from public.procurement_receipts pr
    join public.purchase_order_items i on i.id = pr.purchase_order_item_id
    where i.purchase_order_id = _po.id
  ) then
    raise exception
      'Purchase order % has already taken delivery. Stop the outstanding quantity instead; what arrived stays received.',
      _po.po_number using errcode = 'check_violation';
  end if;

  _action := 'Purchase Order ' || initcap(_to_status);

  if _to_status = 'closed' then
    select coalesce(sum(i.quantity_ordered - i.quantity_cancelled - coalesce(r.received, 0)), 0)
      into _outstanding
      from public.purchase_order_items i
      left join (
        select purchase_order_item_id, sum(quantity_received) as received
          from public.procurement_receipts group by purchase_order_item_id
      ) r on r.purchase_order_item_id = i.id
     where i.purchase_order_id = _po.id
       and i.pos_product_id is not null;

    if _outstanding > 0 then
      if nullif(btrim(coalesce(_remarks, '')), '') is null then
        raise exception
          'Purchase order % still has % unit(s) undelivered. Receive them, or give a reason to close it short.',
          _po.po_number, _outstanding
          using errcode = 'check_violation';
      end if;
      _action := 'Purchase Order Closed Short';
    end if;
  end if;

  update public.purchase_orders
     set status = _to_status,
         submitted_at = case when _to_status = 'pending_approval' then now() else submitted_at end,
         approved_by  = case when _to_status = 'approved' then _uid else approved_by end,
         approved_at  = case when _to_status = 'approved' then now() else approved_at end,
         closed_at    = case when _to_status in ('closed', 'cancelled', 'rejected') then now() else closed_at end,
         closed_reason = case when _to_status in ('closed', 'cancelled', 'rejected')
                              then coalesce(_remarks, _to_status) else closed_reason end,
         updated_at = now()
   where id = _purchase_order_id;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (_uid, _action, 'purchase_orders', _purchase_order_id,
          jsonb_build_object('po_number', _po.po_number, 'from', _po.status,
                             'to', _to_status, 'remarks', _remarks,
                             'outstanding', _outstanding));
end;
$fn$;

-- ------------------------------------------------------ returning a request
--
-- The same rule on the employee-purchase side, enforced at the point every
-- transition passes through rather than inside transition_finance_request.
--
-- That function is long and its authority table is the delicate part of it;
-- reproducing 140 lines to insert one check is a good way to lose a branch of
-- the matrix by transcription. Every transition writes exactly one approval
-- row, so the row is the boundary, and a rule held here cannot drift out of
-- step with the transitions it governs. It also covers any future caller that
-- records a decision without going through that one function.
create or replace function public.guard_finance_request_reason()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.action in ('returned', 'rejected', 'cancelled') then
    new.remarks := public.require_business_reason(new.remarks,
      case new.action
        when 'returned'  then 'returning this request'
        when 'rejected'  then 'rejecting this request'
        else 'cancelling this request'
      end);
  end if;
  return new;
end;
$fn$;

revoke all on function public.guard_finance_request_reason() from public, anon, authenticated;

drop trigger if exists trg_require_decision_reason on public.finance_request_approvals;
create trigger trg_require_decision_reason
  before insert on public.finance_request_approvals
  for each row execute function public.guard_finance_request_reason();
