-- Stock does not enter inventory at a cost nobody established.
--
-- Letting a branch manager receive without naming a unit cost was right -- the
-- invoice is not in their hands -- but the fallback was wrong. A manager's
-- receipt carried the branch's existing average forward, and for a product
-- nobody had ever bought that average is 0. Audited before touching anything:
--
--   BEFORE  qty=0  avg_cost=0.00
--   AFTER   qty=10 avg_cost=0.00
--
-- Ten real units, valued at nothing. That is not a rounding problem: stock at
-- zero cost reports as free inventory, infinite margin and no cost of goods
-- sold, and every figure downstream inherits it. A wrong number that looks
-- like a number is worse than a missing one.
--
-- So receiving now needs a cost basis to exist, and refuses when it does not.
-- The manager is still never asked for a cost -- they are told the product is
-- not ready to receive yet, which is true and actionable.
--
-- This is a pre-FMS boundary, deliberately:
--
--   POS Manager  -- confirms the quantity that physically arrived
--   Finance/FMS  -- establishes what it cost
--
-- When FMS owns procurement it will supply the cost through this same path,
-- and the refusal below stops being reachable for products it manages.

create or replace function public.receive_pos_stock(
  _branch_id uuid,
  _product_id uuid,
  _quantity integer,
  _unit_cost numeric default null,
  _notes text default null
)
returns public.pos_branch_inventory
language plpgsql
security definer
set search_path = ''
as $$
declare
  _actor uuid := (select auth.uid());
  _row public.pos_branch_inventory%rowtype;
  _updated public.pos_branch_inventory%rowtype;
  _new_average numeric(12,2);
  _basis numeric(12,2);
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
  where i.branch_id = _branch_id and i.product_id = _product_id
  for update;
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
  returning * into _updated;
  perform set_config('harmony.pos_inventory_write', '', true);

  insert into public.pos_inventory_movements (
    branch_id, product_id, movement_type, quantity_change,
    stock_before, stock_after, unit_cost, source_type, source_id, notes, actor_id
  ) values (
    _branch_id, _product_id, 'receipt', _quantity,
    _row.quantity_on_hand, _updated.quantity_on_hand, round(_unit_cost, 2),
    -- Set here, not accepted from the caller. A browser cannot claim to be an
    -- FMS receipt.
    'manual_receiving', null, nullif(btrim(_notes), ''), _actor
  );

  insert into public.audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
  values (
    _actor, 'POS Stock Received', 'pos_branch_inventory', _product_id,
    jsonb_build_object('quantity_on_hand', _row.quantity_on_hand,
                       'average_unit_cost', _row.average_unit_cost),
    jsonb_build_object('branch_id', _branch_id,
                       'quantity_received', _quantity,
                       'unit_cost', round(_unit_cost, 2),
                       'quantity_on_hand', _updated.quantity_on_hand,
                       'average_unit_cost', _updated.average_unit_cost)
  );

  return _updated;
end;
$$;

comment on function public.receive_pos_stock(uuid, uuid, integer, numeric, text) is
  'Records a physical receipt. An Administrator supplies the unit cost and may '
  'establish it. A branch manager may not, and their receipt is refused unless a '
  'cost basis already exists -- stock never enters at a valuation nobody set. '
  'Quantities move only through here.';
