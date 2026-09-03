-- F4 final consistency -- what funds this order, and what has actually arrived
--
-- Two corrections, both about a number the system already had and was not
-- reading properly.
--
-- Fulfillment. purchase_order_status.quantity_outstanding was ordered minus
-- received, written before quantity_cancelled existed. An order whose
-- remainder had been stopped still reported those units as outstanding, so it
-- looked like it was waiting for a delivery that nobody was expecting.
--
-- Funding. A POS restock order had no relationship to a budget at all, so
-- nothing could answer "which approved budget pays for this?" -- and a branch
-- could be sent twenty crates of cola against a ceiling that knew nothing
-- about it.

-- ------------------------------------------------------- what an order commits
--
-- Derived, never stored. The effective amount is what is still on order:
-- everything ordered, less whatever was stopped. That single definition does
-- all the release work by itself -- stopping fourteen of twenty units drops
-- the commitment by fourteen units' worth with no separate release path to
-- forget, and cancelling the order drops it out of the sum entirely.
--
-- Note what it is NOT: it is not what was received. Goods arriving does not
-- change what the company committed to pay, and receiving is not payment.
create or replace function public.purchase_order_commitment(_purchase_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    sum((i.quantity_ordered - i.quantity_cancelled)::numeric * i.unit_cost), 0
  )::numeric(14,2)
  from public.purchase_order_items i
  where i.purchase_order_id = _purchase_order_id;
$fn$;

revoke all on function public.purchase_order_commitment(uuid) from public, anon;
grant execute on function public.purchase_order_commitment(uuid) to authenticated;

-- ------------------------------------------------------------ the funding link
alter table public.purchase_orders
  add column if not exists budget_id uuid references public.budgets(id) on delete restrict;

comment on column public.purchase_orders.budget_id is
  'The approved budget this order commits against. Required for POS-sourced orders from F4 onward; null on orders raised before that and on orders sourced from a finance request, whose reservation belongs to the request.';

create index if not exists purchase_orders_budget_idx
  on public.purchase_orders (budget_id) where budget_id is not null;

-- --------------------------------------------------- what is actually left to come
--
-- Same columns in the same order, with quantity_cancelled subtracted from
-- outstanding and four columns appended. Replacing rather than dropping keeps
-- every existing reader working.
create or replace view public.purchase_order_status
with (security_invoker = on) as
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
    coalesce(l.line_count, 0)::integer as line_count,
    coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
    coalesce(l.quantity_ordered, 0)::integer as quantity_ordered,
    coalesce(r.quantity_received, 0)::integer as quantity_received,
    -- Stopped units are not on their way. This is the fix.
    greatest(
      coalesce(l.quantity_ordered, 0)
        - coalesce(l.quantity_cancelled, 0)
        - coalesce(r.quantity_received, 0),
      0
    )::integer as quantity_outstanding,
    coalesce(l.quantity_cancelled, 0)::integer as quantity_cancelled,
    po.budget_id,
    b.name as budget_name,
    public.purchase_order_commitment(po.id) as committed_amount
  from public.purchase_orders po
  left join public.vendors v on v.id = po.vendor_id
  left join public.budgets b on b.id = po.budget_id
  left join lateral (
    select count(*) as line_count,
           sum(i.line_total) as subtotal,
           sum(i.quantity_ordered) as quantity_ordered,
           sum(i.quantity_cancelled) as quantity_cancelled
      from public.purchase_order_items i
     where i.purchase_order_id = po.id
  ) l on true
  left join lateral (
    select sum(pr.quantity_received) as quantity_received
      from public.procurement_receipts pr
      join public.purchase_order_items i on i.id = pr.purchase_order_item_id
     where i.purchase_order_id = po.id
  ) r on true;

-- ------------------------------------------------------- what a budget is holding
--
-- reserved gains a second source, and the two must never overlap.
--
-- A general purchase reserves when the REQUEST is approved -- that is F3, and
-- PR-2026-0001's five thousand pesos comes from there. An order raised later
-- against that request must not reserve it a second time, so orders carrying a
-- finance_request source are excluded here by construction rather than by
-- remembering not to set their budget_id.
--
-- A POS restock has no request-level money: the branch asks for twenty crates,
-- not for a peso figure. Nothing is committed until a Finance Manager approves
-- the order, and then the commitment is the order's own effective amount.
--
-- Approved and closed both count. Closing an order is filing the paperwork on
-- a delivery, not paying for it, so the money stays committed until a future
-- settlement phase converts it.
create or replace view public.budget_status
with (security_invoker = on) as
  select
    b.id,
    b.name,
    b.department_id,
    d.name as department_name,
    b.finance_category_id,
    c.name as finance_category_name,
    b.period,
    b.fiscal_year,
    b.amount,
    coalesce(a.allocated, 0)::numeric(14,2) as allocated,
    (coalesce(r.reserved, 0) + coalesce(p.committed, 0))::numeric(14,2) as reserved,
    -- Still zero, and still on purpose. Nothing in JMAC can yet produce a
    -- payment, and a spend figure with no settlement behind it is a number
    -- somebody will act on.
    0::numeric(14,2) as spent,
    (b.amount - coalesce(a.allocated, 0))::numeric(14,2) as unallocated,
    (b.amount - coalesce(r.reserved, 0) - coalesce(p.committed, 0) - 0)::numeric(14,2) as remaining,
    case when b.amount > 0
         then round(coalesce(a.allocated, 0) / b.amount * 100)::integer
         else 0 end as allocated_pct,
    b.start_date,
    b.end_date,
    b.status,
    b.alert_threshold,
    b.approved_by,
    b.approved_at,
    b.created_by,
    b.created_at,
    b.updated_at
  from public.budgets b
  left join public.departments d on d.id = b.department_id
  left join public.finance_categories c on c.id = b.finance_category_id
  left join lateral (
    select sum(al.amount) as allocated
      from public.budget_allocations al
     where al.budget_id = b.id and al.status = 'active'
  ) a on true
  left join lateral (
    select sum(fr.amount) as reserved
      from public.finance_requests fr
     where fr.budget_id = b.id and fr.status = 'approved'
  ) r on true
  left join lateral (
    select sum(public.purchase_order_commitment(po.id)) as committed
      from public.purchase_orders po
     where po.budget_id = b.id
       and po.status in ('approved', 'closed')
       -- The double-reservation guard, stated structurally.
       and not exists (
         select 1 from public.purchase_order_sources s
          where s.purchase_order_id = po.id
            and s.finance_request_id is not null
       )
  ) p on true;

-- ------------------------------------------- funding is checked where it commits
--
-- On the trigger rather than inside transition_purchase_order, for the reason
-- that function's own history gives: its authority table is the delicate part
-- of it, and reproducing a hundred lines to insert a check is how a branch of
-- the matrix disappears by transcription. Every approval passes through this
-- row, whatever moves it.
--
-- The FOR UPDATE is the concurrency answer. Two Finance Managers approving
-- different orders against the same budget serialise on that row, so the
-- second one computes its available figure after the first has committed and
-- cannot spend the same headroom twice.
create or replace function public.guard_purchase_order_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _is_pos     boolean;
  _budget     record;
  _reserved   numeric(14,2);
  _commitment numeric(14,2);
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  select exists (
    select 1 from public.purchase_order_sources s
     where s.purchase_order_id = new.id
       and s.pos_inventory_request_id is not null
  ) into _is_pos;

  -- A branch restock buys stock with somebody's money, and which money is a
  -- decision the maker takes rather than one discovered later. Orders raised
  -- before this existed are already approved and never transition again, so
  -- they are grandfathered without a special case.
  if _is_pos and new.status in ('pending_approval', 'approved') and new.budget_id is null then
    raise exception 'Choose the budget this purchase order is charged to before submitting it.'
      using errcode = 'check_violation';
  end if;

  if new.status <> 'approved' or new.budget_id is null then
    return new;
  end if;

  -- Locked for the rest of the transaction: this is where two approvals meet.
  select id, name, amount, status, start_date, end_date
    into _budget
    from public.budgets
   where id = new.budget_id
   for update;

  if _budget.id is null then
    raise exception 'That budget no longer exists.' using errcode = 'no_data_found';
  end if;
  if _budget.status <> 'active' then
    raise exception 'Budget "%" is %, so nothing can be charged to it.', _budget.name, _budget.status
      using errcode = 'check_violation';
  end if;
  if _budget.start_date is not null and current_date < _budget.start_date then
    raise exception 'Budget "%" does not start until %.', _budget.name, _budget.start_date
      using errcode = 'check_violation';
  end if;
  if _budget.end_date is not null and current_date > _budget.end_date then
    raise exception 'Budget "%" ended on %.', _budget.name, _budget.end_date
      using errcode = 'check_violation';
  end if;

  -- The order being approved is not yet approved as far as this query is
  -- concerned -- its row is mid-update -- so it does not count itself.
  select reserved into _reserved from public.budget_status where id = new.budget_id;
  _commitment := public.purchase_order_commitment(new.id);

  if _commitment > _budget.amount - coalesce(_reserved, 0) then
    raise exception 'This budget does not have enough available funds for this purchase order.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

revoke all on function public.guard_purchase_order_budget() from public, anon, authenticated;

drop trigger if exists trg_purchase_order_budget on public.purchase_orders;
create trigger trg_purchase_order_budget
  before update on public.purchase_orders
  for each row execute function public.guard_purchase_order_budget();

-- ------------------------------------------------ the builder learns about budgets
--
-- Signature gains _budget_id, so the old one is dropped. Forward-only: nothing
-- reads it between these two statements.
drop function if exists public.create_purchase_order_from_source(
  text, uuid, uuid, date, text, integer, numeric, jsonb, boolean);

create or replace function public.create_purchase_order_from_source(
  _source_kind text,
  _source_id uuid,
  _vendor_id uuid,
  _expected_delivery_date date default null,
  _notes text default null,
  _quantity integer default null,
  _unit_cost numeric default null,
  _lines jsonb default null,
  _submit boolean default false,
  _budget_id uuid default null
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
begin
  if not public.has_finance_privilege(array['finance_staff']) then
    raise exception 'Preparing a purchase order is Finance Staff''s work.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into _src from public.get_procurement_source(_source_kind, _source_id);
  if _src.source_id is null then
    raise exception 'That demand is not available for procurement.' using errcode = 'no_data_found';
  end if;

  -- A general purchase already reserved its money when the request was
  -- approved, so it carries no budget of its own: two reservations for one
  -- purchase is the failure this guards against.
  if _source_kind = 'finance_request' and _budget_id is not null then
    raise exception 'A purchase request already reserves its budget; the order does not reserve it again.'
      using errcode = 'check_violation';
  end if;

  insert into public.purchase_orders
    (vendor_id, order_date, expected_delivery_date, notes, delivery_branch_id, created_by, budget_id)
  values
    (_vendor_id, current_date, _expected_delivery_date, nullif(btrim(coalesce(_notes, '')), ''),
     _src.branch_id, _uid, _budget_id)
  returning id into _po;

  insert into public.purchase_order_sources
    (purchase_order_id, finance_request_id, pos_inventory_request_id)
  values (_po,
          case when _source_kind = 'finance_request' then _source_id end,
          case when _source_kind = 'pos_restock' then _source_id end);

  if _source_kind = 'pos_restock' then
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

  else
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
    end loop;
  end if;

  if _submit then
    perform public.transition_purchase_order(_po, 'pending_approval', null);
  end if;

  return _po;
end;
$fn$;

revoke all on function public.create_purchase_order_from_source(
  text, uuid, uuid, date, text, integer, numeric, jsonb, boolean, uuid) from public, anon;
grant execute on function public.create_purchase_order_from_source(
  text, uuid, uuid, date, text, integer, numeric, jsonb, boolean, uuid) to authenticated;

comment on view public.budget_status is
  'Authoritative budget figures. reserved covers approved finance requests and the effective amount of approved or closed POS-sourced purchase orders; orders raised from a finance request are excluded so nothing reserves twice. spent stays 0 until a settlement phase exists.';
