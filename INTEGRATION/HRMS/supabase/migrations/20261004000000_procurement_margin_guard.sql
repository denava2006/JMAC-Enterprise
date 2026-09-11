-- Procurement margin protection: supplier cost against the branch selling price.
--
-- The gap this closes. A POS Manager requests stock; Finance Staff raise the
-- purchase order and type a supplier unit cost by hand. The order already knows
-- the product and the destination branch -- purchase_order_items carries both --
-- but nothing ever compared what JMAC pays with what that branch charges. So a
-- product selling for 30.00 at Cavite could be bought at 35.00 with no warning
-- and no refusal.
--
-- WHAT THE MARGIN IS MEASURED AGAINST, and why it is not the customer total.
-- checkout_pos_sale builds a sale as:
--
--     subtotal    = sum(branch selling price * quantity)
--     fee_amount  = round(subtotal * value/100, 2)   -- for a 'percent' fee
--     total       = subtotal + fees_total
--
-- and pos_sales carries `check (total_amount = subtotal + fees_total)`. VAT in
-- this system is a branch fee of type 'percent', applied ON TOP of the line
-- prices. The branch selling price is therefore PRE-VAT, and the customer total
-- includes tax that was never JMAC's revenue. pos_sales.gross_profit already
-- settles the question for the POS side -- it is `subtotal - total_cogs`, the
-- pre-VAT basis -- and procurement uses the same basis here rather than
-- inventing a second definition of margin.
--
-- WHAT unit_cost MEANS is left exactly as it was: purchase_order_items.unit_cost
-- is what the supplier charges per unit, numeric(12,2), >= 0, with line_total
-- generated from it. No input-VAT accounting is introduced, and none is implied.
--
-- WHERE THE GUARD LIVES. On a trigger, not inside transition_purchase_order,
-- for the reason that function's own history gives twice already: its authority
-- table is the delicate part of it, and reproducing a hundred lines to insert a
-- check is how a branch of the matrix disappears by transcription. Every
-- submission and every approval passes through this row, whatever moves it --
-- including a direct UPDATE that never calls the RPC at all, which is what
-- makes this enforcement rather than validation.

-- ------------------------------------------------------- the price, once
--
-- `coalesce(bp.selling_price_override, p.default_selling_price)` is written out
-- in six places already -- the catalogue RPCs, the till, the inventory reader.
-- Procurement needs the same answer and must not become a seventh copy that can
-- drift, so the rule gets a name here and the new callers use it.
--
-- NULL means "this branch has no price for this product", which is a different
-- thing from a price of zero and is answered differently upstream. A branch
-- that does not carry the product has no row, so it gets NULL rather than the
-- enterprise default -- procurement for a branch must not be judged against a
-- price that branch does not charge.
create or replace function public.pos_branch_selling_price(
  _branch_id uuid,
  _product_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(bp.selling_price_override, p.default_selling_price)
    from public.pos_branch_products bp
    join public.pos_products p on p.id = bp.product_id
   where bp.branch_id = _branch_id
     and bp.product_id = _product_id;
$fn$;

comment on function public.pos_branch_selling_price(uuid, uuid) is
  'The price a branch charges for a product: its override, else the enterprise default. PRE-VAT -- VAT is a branch fee applied on top of the line subtotal at checkout. NULL when the branch does not carry the product.';

revoke all on function public.pos_branch_selling_price(uuid, uuid) from public, anon;
grant execute on function public.pos_branch_selling_price(uuid, uuid) to authenticated, service_role;

-- --------------------------------------------------------------- the snapshot
--
-- Necessary, and not redundant with anything already stored. A purchase order
-- records what was bought and for how much; nothing recorded what it was worth
-- selling at when the decision was taken. Without that, an approved order can
-- never afterwards explain why it passed a margin check -- the POS price is
-- free to move the next day, and the brief is explicit that an approved order
-- must NOT be kept synchronised with it.
--
-- One column, not two. It holds the price the guard actually validated against
-- at the last transition, so before approval it is the submission-time price
-- (which is what lets a Manager see that the price has moved since), and after
-- approval it is the price the company committed against. Nullable: lines that
-- are not POS restock have no branch price, and orders that predate this never
-- transition again.
alter table public.purchase_order_items
  add column if not exists selling_price_snapshot numeric(12,2)
    check (selling_price_snapshot is null or selling_price_snapshot >= 0);

comment on column public.purchase_order_items.selling_price_snapshot is
  'The destination branch selling price (pre-VAT) that the margin guard validated this line against at its last submission or approval. Historical: a later POS price change does not rewrite it.';

-- ----------------------------------------------------------------- the guard
--
-- Three outcomes, and only one of them refuses:
--
--   cost <  price   pass
--   cost =  price   pass, zero margin -- the screen warns, the server allows
--   cost >  price   refuse
--
-- Zero margin is deliberately permitted. A promotion or a clearance line is a
-- real business decision and this is not the place to litigate it; buying above
-- the price being charged is the thing that cannot be allowed to happen
-- silently.
create or replace function public.guard_purchase_order_margin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _item  record;
  _price numeric(12,2);
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status not in ('pending_approval', 'approved') then
    return new;
  end if;

  -- Only POS-sourced lines have a branch price to be judged against. A general
  -- purchase -- stationery, a repair -- is not retail and has no margin.
  for _item in
    select i.id, i.description, i.unit_cost, i.pos_product_id, i.destination_branch_id
      from public.purchase_order_items i
     where i.purchase_order_id = new.id
       and i.pos_product_id is not null
       and i.destination_branch_id is not null
     order by i.created_at
  loop
    _price := public.pos_branch_selling_price(_item.destination_branch_id, _item.pos_product_id);

    -- Missing and zero are both refusals, and neither is treated as 0.00 that
    -- happens to fail the comparison: an unpriced product is a POS question,
    -- and saying so is more use than "cost exceeds 0.00".
    if _price is null or _price <= 0 then
      raise exception
        'The destination branch does not have a valid selling price for %. Set or review the POS price before procurement continues.',
        _item.description
        using errcode = 'check_violation';
    end if;

    if _item.unit_cost > _price then
      raise exception
        'Unit cost for % exceeds the current selling price by %. Revise the supplier cost or have the POS selling price reviewed before submitting this purchase order.',
        _item.description,
        to_char(_item.unit_cost - _price, 'FM999999990.00')
        using errcode = 'check_violation';
    end if;

    -- Written on the way through, so the record of what was validated is made
    -- by the thing that validated it. At approval this overwrites the
    -- submission-time price with the price the company actually committed
    -- against, which is the decision worth keeping.
    update public.purchase_order_items
       set selling_price_snapshot = _price
     where id = _item.id;
  end loop;

  return new;
end;
$fn$;

comment on function public.guard_purchase_order_margin() is
  'Refuses submission or approval of a POS-sourced purchase order whose unit cost exceeds the destination branch selling price, or whose branch has no valid price. Zero margin passes. Runs again at approval because the POS price may have moved since submission.';

revoke all on function public.guard_purchase_order_margin() from public, anon, authenticated;

drop trigger if exists trg_purchase_order_margin on public.purchase_orders;
create trigger trg_purchase_order_margin
  before update on public.purchase_orders
  for each row execute function public.guard_purchase_order_margin();

-- -------------------------------------------------- what the builder is told
--
-- The dialog must show the price it is being judged against, and must not be
-- the one deciding it. Adding the column here means the number arrives from the
-- same function the guard uses, on the same request that already tells the
-- builder the product, the branch and the outstanding quantity -- so a client
-- that sends a different selling price is not merely ignored, it was never
-- asked.
--
-- Forward-only: `returns table` cannot gain a column in place.
drop function if exists public.get_procurement_source(text, uuid);

create or replace function public.get_procurement_source(_source_kind text, _source_id uuid)
returns table (
  source_kind          text,
  source_id            uuid,
  reference            text,
  title                text,
  product_id           uuid,
  product_name         text,
  branch_id            uuid,
  branch_name          text,
  requested_quantity   integer,
  ordered_quantity     integer,
  outstanding          integer,
  requested_by_name    text,
  amount               numeric,
  branch_selling_price numeric
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
        null::numeric,
        -- The destination branch's price, never another branch's and never the
        -- enterprise default for a product this branch does not carry.
        public.pos_branch_selling_price(q.branch_id, q.product_id)
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
    -- No product, no branch price, no margin -- this is not retail.
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
        r.amount,
        null::numeric
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

-- ------------------------------------------------- what the reviewer is told
--
-- The Finance Manager approving an order sees the same arithmetic the Staff who
-- raised it saw, recomputed now rather than replayed from what was typed. If
-- the POS price has moved since submission, `selling_price_snapshot` is what it
-- was then and `current_selling_price` is what it is now, and the screen can say
-- so instead of the approval quietly proceeding on stale margin.
create or replace function public.get_purchase_order_margins(_purchase_order_id uuid)
returns table (
  item_id                uuid,
  description            text,
  quantity_ordered       integer,
  unit_cost              numeric,
  current_selling_price  numeric,
  selling_price_snapshot numeric,
  branch_name            text
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if not public.has_finance_privilege(array['finance_staff', 'finance_manager'])
     and not public.is_admin() then
    raise exception 'Only Finance may read a purchase order.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select
      i.id,
      i.description,
      i.quantity_ordered,
      i.unit_cost,
      public.pos_branch_selling_price(i.destination_branch_id, i.pos_product_id),
      i.selling_price_snapshot,
      b.name
    from public.purchase_order_items i
    left join public.branches b on b.id = i.destination_branch_id
   where i.purchase_order_id = _purchase_order_id
     and i.pos_product_id is not null
   order by i.created_at;
end;
$fn$;

comment on function public.get_purchase_order_margins(uuid) is
  'Per-line procurement margin context for a purchase order: the supplier unit cost, the destination branch selling price as it is NOW, and the price the guard last validated against. POS-sourced lines only.';

revoke all on function public.get_purchase_order_margins(uuid) from public, anon;
grant execute on function public.get_purchase_order_margins(uuid) to authenticated;
