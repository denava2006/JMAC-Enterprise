-- Receiving belongs to the branch that receives.
--
-- Every physical stock movement used to need an Administrator: a manager asked
-- for stock, an Administrator approved it, and an Administrator also had to
-- press Receive when the delivery turned up at the manager's branch. The person
-- holding the boxes was the one person who could not say they had arrived.
--
-- Audited before changing anything, because "make approval add stock" would
-- have been the wrong fix: approve_pos_request already touches no quantity, and
-- says so in its own comment. Approval means the business agreed to buy, not
-- that goods exist -- making it move stock would invent units nobody received.
-- So the ownership moves and the meaning stays.
--
-- These are the original function bodies with the authorization changed, not
-- rewrites: the weighted-average maths, the row lock, the movement ledger with
-- its server-set source_type, and the audit_logs entries are all exactly as
-- they were. Reconstructing them from memory once dropped the audit insert
-- entirely, which is the sort of thing that is only noticed much later.
--
-- FMS will later own procurement and call this same path. There is still one
-- inventory system.

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
  -- then flows into margin. A manager's receipt therefore carries the branch's
  -- existing average forward, and procurement corrects it from the real figure.
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

  -- A manager's receipt is priced at what the branch already paid, so the
  -- average is carried forward rather than moved by a number nobody supplied.
  if _unit_cost is null then
    _unit_cost := _row.average_unit_cost;
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

create or replace function public.adjust_pos_stock(
  _branch_id uuid,
  _product_id uuid,
  _quantity_change integer,
  _reason text,
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
  _type public.pos_movement_type;
begin
  if _actor is null
     or not (public.is_admin()
             or public.has_pos_role(_branch_id, array['manager']::public.pos_role[])) then
    raise exception 'Only an Administrator or this branch''s manager can adjust stock';
  end if;
  if _quantity_change is null or _quantity_change = 0 then
    raise exception 'An adjustment cannot be zero';
  end if;
  if _reason is null or _reason not in ('recount', 'damaged', 'expired', 'lost', 'found') then
    raise exception 'Invalid adjustment reason';
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

  if _row.quantity_on_hand + _quantity_change < 0 then
    raise exception 'That adjustment would leave % units, which is below zero',
      _row.quantity_on_hand + _quantity_change;
  end if;

  _type := case when _quantity_change > 0 then 'adjustment_in' else 'adjustment_out' end;

  perform set_config('harmony.pos_inventory_write', 'allowed', true);
  update public.pos_branch_inventory
  set quantity_on_hand = _row.quantity_on_hand + _quantity_change
  where branch_id = _branch_id and product_id = _product_id
  returning * into _updated;
  perform set_config('harmony.pos_inventory_write', '', true);

  insert into public.pos_inventory_movements (
    branch_id, product_id, movement_type, quantity_change,
    stock_before, stock_after, unit_cost, source_type, source_id, notes, actor_id
  ) values (
    _branch_id, _product_id, _type, _quantity_change,
    _row.quantity_on_hand, _updated.quantity_on_hand,
    -- No unit cost: nothing was bought.
    null, 'manual_adjustment', null,
    nullif(btrim(coalesce(_reason || case when _notes is null then '' else ' -- ' || btrim(_notes) end, '')), ''),
    _actor
  );

  insert into public.audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
  values (
    _actor, 'POS Stock Adjusted', 'pos_branch_inventory', _product_id,
    jsonb_build_object('quantity_on_hand', _row.quantity_on_hand),
    jsonb_build_object('branch_id', _branch_id, 'quantity_change', _quantity_change,
                       'reason', _reason, 'quantity_on_hand', _updated.quantity_on_hand)
  );

  return _updated;
end;
$$;

revoke all on function public.receive_pos_stock(uuid, uuid, integer, numeric, text) from public, anon;
revoke all on function public.adjust_pos_stock(uuid, uuid, integer, text, text) from public, anon;
grant execute on function public.receive_pos_stock(uuid, uuid, integer, numeric, text) to authenticated;
grant execute on function public.adjust_pos_stock(uuid, uuid, integer, text, text) to authenticated;

comment on function public.receive_pos_stock(uuid, uuid, integer, numeric, text) is
  'Records a physical receipt. An Administrator supplies the unit cost; a branch '
  'manager may not, and their receipt carries the branch average forward until '
  'procurement supplies the real figure. Quantities move only through here.';
