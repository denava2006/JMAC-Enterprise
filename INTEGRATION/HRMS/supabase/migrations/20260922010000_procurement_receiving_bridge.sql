-- FMS F4 (2/2) — the receiving bridge.
--
-- The only place in JMAC where a procurement document is allowed to touch
-- physical stock, and it does so by calling the receiving engine POS already
-- owns rather than by writing inventory itself.
--
--   receipt quantity          procurement evidence  (documentary)
--   pos_inventory_movements   physical stock        (authoritative)
--
-- There is no fms_stock_balance, no finance_inventory_quantity and no
-- procurement_on_hand. The quantity a branch holds is whatever POS says it is.

-- ------------------------------------------------- a movement may say where it came from
-- source_type was constrained to manual_receiving | manual_adjustment | sale.
-- A procurement receipt is a fourth provenance, and naming it is the whole
-- point: a movement produced by a delivery against an approved PO should not be
-- indistinguishable from one somebody typed in.
alter table public.pos_inventory_movements
  drop constraint if exists pos_inventory_movements_source_type;

alter table public.pos_inventory_movements
  add constraint pos_inventory_movements_source_type check (
    source_type = any (array['manual_receiving', 'manual_adjustment', 'sale', 'procurement_receipt'])
  );

-- =========================================================================
-- The receiving engine, factored out so both paths share it
-- =========================================================================
-- receive_pos_stock's body moves here unchanged: the same lock, the same
-- weighted average, the same movement row, the same audit entry. What it gains
-- is provenance as parameters instead of literals, so a procurement receipt can
-- say what it was without a second implementation of the arithmetic.
--
-- Reachable by no API role. Authorization and the cost basis are decided by the
-- callers below, each of which answers those questions differently.
create or replace function public.apply_pos_receipt(
  _branch_id   uuid,
  _product_id  uuid,
  _quantity    integer,
  _unit_cost   numeric,
  _notes       text,
  _source_type text,
  _source_id   uuid,
  out _movement_id uuid,
  out _inventory   public.pos_branch_inventory
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row public.pos_branch_inventory%rowtype;
  _new_average numeric(12,2);
  _actor uuid := (select auth.uid());
begin
  if _unit_cost is null or _unit_cost < 0 then
    raise exception 'A receipt needs an established unit cost';
  end if;

  select * into _row
  from public.pos_branch_inventory i
  where i.branch_id = _branch_id and i.product_id = _product_id
  for update;
  if not found then
    raise exception 'That product is not carried at this branch';
  end if;

  -- Weighted average over what this branch holds. First receipt (or a branch
  -- back at zero) takes the received price outright, which also avoids a
  -- division by zero.
  _new_average := case
    when _row.quantity_on_hand = 0 then round(_unit_cost, 2)
    else round(
      ((_row.quantity_on_hand * _row.average_unit_cost) + (_quantity * _unit_cost))
      / (_row.quantity_on_hand + _quantity),
      2
    )
  end;

  perform set_config('harmony.pos_inventory_write', 'allowed', true);
  update public.pos_branch_inventory
  set quantity_on_hand = _row.quantity_on_hand + _quantity,
      average_unit_cost = _new_average
  where branch_id = _branch_id and product_id = _product_id
  returning * into _inventory;
  perform set_config('harmony.pos_inventory_write', '', true);

  insert into public.pos_inventory_movements (
    branch_id, product_id, movement_type, quantity_change,
    stock_before, stock_after, unit_cost, source_type, source_id, notes, actor_id
  ) values (
    _branch_id, _product_id, 'receipt', _quantity,
    _row.quantity_on_hand, _inventory.quantity_on_hand, round(_unit_cost, 2),
    _source_type, _source_id, nullif(btrim(_notes), ''), _actor
  )
  returning id into _movement_id;

  insert into public.audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
  values (
    _actor, 'POS Stock Received', 'pos_branch_inventory', _product_id,
    jsonb_build_object('quantity_on_hand', _row.quantity_on_hand,
                       'average_unit_cost', _row.average_unit_cost),
    jsonb_build_object('branch_id', _branch_id,
                       'quantity_received', _quantity,
                       'unit_cost', round(_unit_cost, 2),
                       'quantity_on_hand', _inventory.quantity_on_hand,
                       'average_unit_cost', _inventory.average_unit_cost,
                       'source_type', _source_type)
  );
end;
$fn$;

revoke all on function public.apply_pos_receipt(uuid, uuid, integer, numeric, text, text, uuid)
  from public, anon, authenticated;

-- ------------------------------------------------- manual receiving, unchanged
-- Same signature, same rules, same refusals. It now delegates the arithmetic
-- rather than repeating it.
create or replace function public.receive_pos_stock(
  _branch_id uuid,
  _product_id uuid,
  _quantity integer,
  -- Defaults preserved exactly. Dropping them would change the signature every
  -- existing caller was written against, and Postgres refuses the replacement
  -- outright -- which is how this was caught.
  _unit_cost numeric default null,
  _notes text default null
)
returns public.pos_branch_inventory
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _actor uuid := (select auth.uid());
  _basis numeric(12,2);
  _row public.pos_branch_inventory%rowtype;
  -- A record, not two variables: INTO cannot split a composite OUT parameter
  -- across separate targets.
  _out record;
begin
  -- The branch manager, for their own branch. Checked from their assignments,
  -- never from the branch id the request supplied.
  if _actor is null
     or not (public.is_admin()
             or public.has_pos_role(_branch_id, array['manager']::public.pos_role[])) then
    raise exception 'Only an Administrator or this branch''s manager can receive stock';
  end if;
  if _quantity is null or _quantity <= 0 then
    raise exception 'Received quantity must be positive';
  end if;
  -- Cost stays an Administrator's. A manager confirms that units arrived,
  -- which is a fact in front of them; what those units cost is on an invoice
  -- they do not hold, and asking them to type one would produce a guess that
  -- then flows into margin.
  if public.is_admin() then
    if _unit_cost is null or _unit_cost < 0 then
      raise exception 'Unit cost must be zero or greater';
    end if;
  elsif _unit_cost is not null then
    raise exception 'A branch manager does not set unit cost';
  end if;
  if _notes is not null and char_length(btrim(_notes)) > 500 then
    raise exception 'Notes must be 500 characters or fewer';
  end if;

  select * into _row
  from public.pos_branch_inventory i
  where i.branch_id = _branch_id and i.product_id = _product_id;
  if not found then
    raise exception 'That product is not carried at this branch';
  end if;

  if _unit_cost is null then
    -- What this branch already paid, or failing that what the catalogue says
    -- the product costs. Either is an authoritative figure somebody with the
    -- authority to set it actually set.
    select coalesce(
             nullif(_row.average_unit_cost, 0),
             nullif(p.default_unit_cost, 0))
      into _basis
    from public.pos_products p
    where p.id = _product_id;

    if _basis is null or _basis <= 0 then
      -- Refused rather than valued at zero. Worded for the person holding the
      -- delivery: it says what is missing, and does not ask them to supply it.
      raise exception 'Purchase cost has not been established for this product yet.';
    end if;

    _unit_cost := _basis;
  end if;

  select * into _out
  from public.apply_pos_receipt(
    _branch_id, _product_id, _quantity, _unit_cost, _notes, 'manual_receiving', null);

  return _out._inventory;
end;
$fn$;

revoke all on function public.receive_pos_stock(uuid, uuid, integer, numeric, text) from public, anon;
grant execute on function public.receive_pos_stock(uuid, uuid, integer, numeric, text) to authenticated;

-- =========================================================================
-- procurement_receipts — evidence, not stock
-- =========================================================================
-- What arrived, against which order line, confirmed by whom, and which
-- inventory movement it produced. The quantity here is documentary: it records
-- what a delivery note said. The movement it points at is the stock.
create table if not exists public.procurement_receipts (
  id                      uuid primary key default gen_random_uuid(),
  purchase_order_item_id  uuid not null references public.purchase_order_items(id) on delete restrict,
  quantity_received       integer not null check (quantity_received > 0),
  delivery_reference      text,
  received_by             uuid references public.profiles(id) on delete set null,
  received_at             timestamptz not null default now(),

  -- The authoritative stock event this receipt caused. Not nullable in
  -- practice: the wrapper writes it in the same transaction.
  inventory_movement_id   uuid references public.pos_inventory_movements(id) on delete restrict,

  -- One receiving action, one receipt, however many times the browser sends it.
  idempotency_key         uuid not null,

  created_at              timestamptz not null default now(),

  constraint procurement_receipts_key_unique unique (idempotency_key)
);

create index if not exists procurement_receipts_item_idx
  on public.procurement_receipts (purchase_order_item_id);

comment on table public.procurement_receipts is
  'Procurement evidence that a delivery was confirmed. quantity_received is '
  'documentary; the linked pos_inventory_movements row is the authoritative '
  'stock change. This is not a stock ledger and no balance is kept here.';

-- =========================================================================
-- purchase_order_status — totals the server derives
-- =========================================================================
create or replace view public.purchase_order_status
with (security_invoker = true) as
select
  po.id,
  po.po_number,
  po.vendor_id,
  v.name as vendor_name,
  po.status,
  po.order_date,
  po.expected_delivery_date,
  po.notes,
  po.created_by,
  po.submitted_at,
  po.approved_by,
  po.approved_at,
  po.created_at,
  po.updated_at,
  coalesce(l.line_count, 0)::integer      as line_count,
  coalesce(l.subtotal, 0)::numeric(14,2)  as subtotal,
  coalesce(l.quantity_ordered, 0)::integer as quantity_ordered,
  coalesce(r.quantity_received, 0)::integer as quantity_received,
  (coalesce(l.quantity_ordered, 0) - coalesce(r.quantity_received, 0))::integer as quantity_outstanding
from public.purchase_orders po
left join public.vendors v on v.id = po.vendor_id
left join lateral (
  select count(*) as line_count,
         sum(line_total) as subtotal,
         sum(quantity_ordered) as quantity_ordered
  from public.purchase_order_items i where i.purchase_order_id = po.id
) l on true
left join lateral (
  select sum(pr.quantity_received) as quantity_received
  from public.procurement_receipts pr
  join public.purchase_order_items i on i.id = pr.purchase_order_item_id
  where i.purchase_order_id = po.id
) r on true;

-- =========================================================================
-- The bridge
-- =========================================================================
-- A POS Manager confirms that units physically arrived. Everything else is
-- decided here: which branch, which product, what it cost, and whether that
-- many were still outstanding.
--
-- There is no cost parameter. The manager cannot supply one, cannot influence
-- one, and never sees one -- the basis is the unit cost on the approved order
-- line, which somebody with the authority to commit money set and a Finance
-- Manager approved. That closes the zero-cost receiving problem properly: the
-- earlier fix refused a receipt with no established cost, and this supplies an
-- authoritative one.
create or replace function public.receive_procurement_stock(
  _purchase_order_item_id uuid,
  _quantity integer,
  _delivery_reference text default null,
  _idempotency_key uuid default gen_random_uuid()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _item      record;
  _po        record;
  _uid       uuid := (select auth.uid());
  _received  integer;
  _existing  uuid;
  _receipt   uuid;
  _out       record;
begin
  if _uid is null then
    raise exception 'Not authenticated.' using errcode = 'insufficient_privilege';
  end if;

  -- Replays return the receipt that already happened, without touching stock.
  -- Checked before anything else so a retry is cheap and cannot half-run.
  select id into _existing from public.procurement_receipts where idempotency_key = _idempotency_key;
  if _existing is not null then
    return _existing;
  end if;

  select * into _item from public.purchase_order_items where id = _purchase_order_item_id for update;
  if _item.id is null then
    raise exception 'That order line no longer exists.' using errcode = 'no_data_found';
  end if;

  if _item.pos_product_id is null or _item.destination_branch_id is null then
    raise exception 'That order line does not deliver stock to a branch.'
      using errcode = 'check_violation';
  end if;

  select * into _po from public.purchase_orders where id = _item.purchase_order_id for update;
  if _po.status <> 'approved' then
    raise exception 'Purchase order % is %, so nothing can be received against it.',
      _po.po_number, _po.status using errcode = 'check_violation';
  end if;

  -- The manager of the branch this line is destined for. Not is_admin: F4 puts
  -- physical receiving with the person who is physically there, and an
  -- Administrator is not a branch manager. Manual receiving still exists for
  -- anything genuinely exceptional, and says so in its own audit trail.
  if not exists (
    select 1
    from public.pos_branch_assignments a
    join public.profiles p on p.id = a.profile_id
    where a.profile_id = _uid
      and a.branch_id = _item.destination_branch_id
      and a.pos_role = 'manager'
      and a.status = 'active'
      and p.status = 'active'
      and public.is_eligible_for_system_role(a.profile_id, 'pos', 'manager')
  ) then
    raise exception 'Only the manager of the destination branch can confirm this delivery.'
      using errcode = 'insufficient_privilege';
  end if;

  if _quantity is null or _quantity <= 0 then
    raise exception 'Received quantity must be positive.' using errcode = 'check_violation';
  end if;

  select coalesce(sum(quantity_received), 0) into _received
  from public.procurement_receipts where purchase_order_item_id = _purchase_order_item_id;

  if _received + _quantity > _item.quantity_ordered then
    raise exception
      'Only % of % remain outstanding on this line; % cannot be received.',
      _item.quantity_ordered - _received, _item.quantity_ordered, _quantity
      using errcode = 'check_violation';
  end if;

  -- Claim the receipt first. The unique key means a second call racing this one
  -- loses here rather than after the stock has moved.
  insert into public.procurement_receipts (
    purchase_order_item_id, quantity_received, delivery_reference,
    received_by, idempotency_key
  ) values (
    _purchase_order_item_id, _quantity, nullif(btrim(_delivery_reference), ''),
    _uid, _idempotency_key
  )
  returning id into _receipt;

  select * into _out
  from public.apply_pos_receipt(
    _item.destination_branch_id,
    _item.pos_product_id,
    _quantity,
    _item.unit_cost,
    'PO ' || _po.po_number || coalesce(' · ' || nullif(btrim(_delivery_reference), ''), ''),
    'procurement_receipt',
    _receipt
  );

  update public.procurement_receipts
     set inventory_movement_id = _out._movement_id where id = _receipt;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (_uid, 'Procurement Delivery Received', 'procurement_receipts', _receipt,
          jsonb_build_object('po_number', _po.po_number,
                             'branch_id', _item.destination_branch_id,
                             'product_id', _item.pos_product_id,
                             'quantity', _quantity,
                             'movement_id', _out._movement_id));

  return _receipt;
end;
$fn$;

revoke all on function public.receive_procurement_stock(uuid, integer, text, uuid) from public, anon;
grant execute on function public.receive_procurement_stock(uuid, integer, text, uuid) to authenticated;

-- =========================================================================
-- What a POS Manager may see of an order
-- =========================================================================
-- Product, quantities and a reference. No unit cost, no line total, no vendor
-- terms. Receiving a delivery is not a reason to learn what the company pays
-- for the goods -- that is procurement's, and margin follows from it.
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
    (i.quantity_ordered - coalesce(r.received, 0))::integer
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
    and public.has_pos_role(_branch_id, array['manager']::public.pos_role[])
  order by po.expected_delivery_date nulls last, po.po_number;
$fn$;

revoke all on function public.get_branch_deliveries(uuid) from public, anon;
grant execute on function public.get_branch_deliveries(uuid) to authenticated;

-- =========================================================================
-- Row level security
-- =========================================================================
alter table public.procurement_receipts enable row level security;

-- Finance reads procurement evidence. A branch manager reads the receipts for
-- their own branch -- which are their own confirmations -- and neither can
-- write one: receipts are created by receive_procurement_stock alone.
drop policy if exists procurement_receipts_read on public.procurement_receipts;
create policy procurement_receipts_read on public.procurement_receipts
  for select to authenticated
  using (
    public.can_read_finance_master()
    or exists (
      select 1 from public.purchase_order_items i
      where i.id = purchase_order_item_id
        and i.destination_branch_id is not null
        and public.has_pos_role(i.destination_branch_id, array['manager']::public.pos_role[])
    )
  );

revoke all on public.procurement_receipts   from anon, public, authenticated;
revoke all on public.purchase_order_status  from anon, public, authenticated;

grant select on public.procurement_receipts  to authenticated;
grant select on public.purchase_order_status to authenticated;
grant all    on public.procurement_receipts  to service_role;
grant select on public.purchase_order_status to service_role;
