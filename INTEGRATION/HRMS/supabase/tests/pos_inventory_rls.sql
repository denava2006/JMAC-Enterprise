-- POS inventory — database contract test.
--
-- Phase 4 adds a stock balance, which is only safe if three things hold: the
-- quantity cannot be moved except through the trusted operations, a movement is
-- written for every change, and cost never reaches a POS user. This proves each,
-- as the actual roles.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_inventory_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.
-- Concurrency is NOT covered here -- a single session cannot demonstrate a lost
-- update. See scripts/pos-inventory-concurrency.sh.

begin;

-- ---------------------------------------------------------------------------
-- Phase 9A test fixture helper.
--
-- POS access now requires: an active profile with role 'employee', linked to an
-- active employee, whose position belongs to its department and is configured
-- in position_system_roles for the role being granted.
--
-- The demo accounts do not satisfy that (IT Support, Sales Associate, and an
-- hr_staff account that can never hold an operational POS role), which is the
-- whole point of this phase. So each suite builds the people it needs.
--
-- pg_temp: session-local. Rolled back with everything else, and it cannot ship.
create function pg_temp.make_pos_eligible(_profile_id uuid, _position_title text)
returns void
language plpgsql
as $helper$
declare
  _dept uuid;
  _position uuid;
  _employee uuid;
  _saved text := current_setting('request.jwt.claims', true);
  _admin uuid;
begin
  select d.id into _dept from public.departments d where d.name = 'Store Operations';
  select po.id into _position from public.positions po
   where po.department_id = _dept and po.title = _position_title;
  if _position is null then
    raise exception 'fixture: no % position in Store Operations', _position_title;
  end if;

  select p.employee_id into _employee from public.profiles p where p.id = _profile_id;

  if _employee is null then
    insert into public.employees (first_name, last_name, email, department_id, position_id,
                                  employment_status, hire_date)
    select coalesce(split_part(p.full_name, ' ', 1), 'Test'),
           coalesce(nullif(split_part(p.full_name, ' ', 2), ''), 'Worker'),
           p.email, _dept, _position, 'active', current_date
    from public.profiles p where p.id = _profile_id
    returning id into _employee;
  else
    update public.employees
       set department_id = _dept, position_id = _position, employment_status = 'active'
     where id = _employee;
  end if;

  -- profiles.role/status are guarded for API callers; the suite runs as owner,
  -- and an admin claim is set so the guard sees a legitimate actor.
  select p.id into _admin from public.profiles p
   where p.role = 'admin' and p.status = 'active' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _admin, 'role', 'authenticated')::text, true);
  update public.profiles
     set employee_id = _employee, role = 'employee', status = 'active'
   where id = _profile_id;
  perform set_config('request.jwt.claims', coalesce(_saved, ''), true);
end;
$helper$;

-- A position eligible for BOTH POS roles, for the mixed-role cases. Under Phase
-- 9A a single position grants exactly the roles an Administrator configured for
-- it, so "manager at A, cashier at B" is only possible where both were granted.
create function pg_temp.make_dual_role_position() returns uuid
language plpgsql
as $dual$
declare _dept uuid; _pos uuid;
begin
  select d.id into _dept from public.departments d where d.name = 'Store Operations';
  insert into public.positions (title, department_id, description)
  values ('ZZ Test Branch Supervisor', _dept, 'Fixture: eligible for both POS roles')
  returning id into _pos;
  insert into public.position_system_roles (position_id, system, role_code)
  values (_pos, 'pos', 'manager'), (_pos, 'pos', 'cashier');
  return _pos;
end;
$dual$;

create function pg_temp.make_eligible_at(_profile_id uuid, _position_id uuid)
returns void language plpgsql as $at$
declare _employee uuid; _dept uuid; _saved text := current_setting('request.jwt.claims', true); _admin uuid;
begin
  select po.department_id into _dept from public.positions po where po.id = _position_id;
  select p.employee_id into _employee from public.profiles p where p.id = _profile_id;
  if _employee is null then
    insert into public.employees (first_name, last_name, email, department_id, position_id,
                                  employment_status, hire_date)
    select coalesce(split_part(p.full_name,' ',1),'Test'),
           coalesce(nullif(split_part(p.full_name,' ',2),''),'Worker'),
           p.email, _dept, _position_id, 'active', current_date
    from public.profiles p where p.id = _profile_id returning id into _employee;
  else
    update public.employees set department_id=_dept, position_id=_position_id,
           employment_status='active' where id=_employee;
  end if;
  select p.id into _admin from public.profiles p where p.role='admin' and p.status='active' limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub',_admin,'role','authenticated')::text, true);
  update public.profiles set employee_id=_employee, role='employee', status='active' where id=_profile_id;
  perform set_config('request.jwt.claims', coalesce(_saved,''), true);
end;
$at$;

do $$
declare
  admin_id    uuid;
  outsider_id uuid;
  cashier_id  uuid;
  manager_id  uuid;
  branch_a    uuid;
  branch_b    uuid;
  general_id  uuid;
  cola_id     uuid;
  n           integer;
  qty         integer;
  avg_cost    numeric;
  txt         text;
  tag         text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  ------------------------------------------------------------------ fixtures
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into cashier_id from public.profiles
    where role = 'employee' and status = 'active' order by created_at limit 1;
  select id into manager_id from public.profiles
    where role = 'employee' and status = 'active' and id <> cashier_id order by created_at limit 1;
  select id into outsider_id from public.profiles
    where role <> 'admin' and status = 'active' and id not in (cashier_id, manager_id) limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';

  if admin_id is null or branch_b is null or cashier_id is null
     or manager_id is null or outsider_id is null or general_id is null then
    raise exception 'fixture: need an admin, two branches, two employees, one other account, General';
  end if;

  -- Known starting point. Deleting rather than deactivating: a leftover row for
  -- the same person and branch collides with the partial unique index if this
  -- test later restores one. The transaction is rolled back regardless.
  delete from public.pos_branch_assignments;
    -- FIXTURE WIRED (Phase 9A): give these people the employment record
  -- their POS role now requires. The assignment INSERT below is refused
  -- otherwise, which is the point of the phase.
  perform pg_temp.make_pos_eligible(cashier_id, 'Cashier');
  perform pg_temp.make_pos_eligible(manager_id, 'POS Manager');

insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (cashier_id, branch_a, 'cashier', admin_id),
         (manager_id, branch_a, 'manager', admin_id);

  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Inv Cola ' || tag, general_id, 85.00, 60.00, 'active') returning id into cola_id;

  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, cola_id, true), (branch_b, cola_id, true);

  ------------------------------------------ 1. the balance row is auto-created
  select count(*) into n from public.pos_branch_inventory i
    where i.product_id = cola_id;
  if n <> 2 then raise exception 'FAIL  1a expected 2 auto-created balances, found %', n; end if;

  select i.quantity_on_hand into qty from public.pos_branch_inventory i
    where i.branch_id = branch_a and i.product_id = cola_id;
  if qty <> 0 then raise exception 'FAIL  1b a new branch product started with % units, expected 0', qty; end if;
  raise notice 'PASS  1a carrying a product auto-creates a zero balance at each branch';

  select count(*) into n from public.pos_inventory_movements m where m.product_id = cola_id;
  if n <> 0 then raise exception 'FAIL  1c auto-creation wrote % movements; nothing moved', n; end if;
  raise notice 'PASS  1b auto-creation writes no movement and no stock';

  ------------------------------------------------- 2. only an admin receives
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.receive_pos_stock(branch_a, cola_id, 10, 40.00, null);
    raise exception 'FAIL  2a a POS manager received stock';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a a POS manager cannot receive stock';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.receive_pos_stock(branch_a, cola_id, 10, 40.00, null);
    raise exception 'FAIL  2b a cashier received stock';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2b a cashier cannot receive stock';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.adjust_pos_stock(branch_a, cola_id, 5, 'found', null);
    raise exception 'FAIL  2c a POS manager adjusted stock';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2c a POS manager cannot adjust stock';
  end;
  reset role;

  --------------------------------------------- 3. receiving: balance + ledger
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  perform public.receive_pos_stock(branch_a, cola_id, 10, 40.00, 'first delivery');

  select i.quantity_on_hand, i.average_unit_cost into qty, avg_cost
    from public.pos_branch_inventory i
    where i.branch_id = branch_a and i.product_id = cola_id;
  if qty <> 10 then raise exception 'FAIL  3a expected 10 units, found %', qty; end if;
  if avg_cost <> 40.00 then raise exception 'FAIL  3b first receipt gave average %, expected 40.00', avg_cost; end if;
  raise notice 'PASS  3a receiving increases the balance exactly once';
  raise notice 'PASS  3b the first receipt sets the branch average to the received price';

  select count(*) into n from public.pos_inventory_movements m
    where m.branch_id = branch_a and m.product_id = cola_id;
  if n <> 1 then raise exception 'FAIL  3c one receipt wrote % movements, expected 1', n; end if;
  raise notice 'PASS  3c one receipt writes exactly one movement';

  select m.movement_type::text || '|' || m.source_type || '|' || coalesce(m.actor_id::text, 'null')
    into txt from public.pos_inventory_movements m
    where m.branch_id = branch_a and m.product_id = cola_id;
  if txt <> 'receipt|manual_receiving|' || admin_id::text then
    raise exception 'FAIL  3d movement recorded as %, expected receipt|manual_receiving|<admin>', txt;
  end if;
  raise notice 'PASS  3d the movement records its own type, source and database-derived actor';

  ----------------------------------------- 4. weighted average over receipts
  perform public.receive_pos_stock(branch_a, cola_id, 10, 50.00, 'second delivery');
  select i.quantity_on_hand, i.average_unit_cost into qty, avg_cost
    from public.pos_branch_inventory i
    where i.branch_id = branch_a and i.product_id = cola_id;
  if qty <> 20 then raise exception 'FAIL  4a expected 20 units, found %', qty; end if;
  if avg_cost <> 45.00 then
    raise exception 'FAIL  4b 10@40 + 10@50 gave average %, expected 45.00', avg_cost;
  end if;
  raise notice 'PASS  4  10@40 then 10@50 gives 20 @ 45.00 weighted average';

  ------------------------------------- 5. the other branch is untouched by it
  select i.quantity_on_hand, i.average_unit_cost into qty, avg_cost
    from public.pos_branch_inventory i
    where i.branch_id = branch_b and i.product_id = cola_id;
  if qty <> 0 or avg_cost <> 0 then
    raise exception 'FAIL  5a branch B moved to % units @ %, expected 0 @ 0', qty, avg_cost;
  end if;
  raise notice 'PASS  5a receiving at one branch does not touch another branch';

  select p.default_unit_cost into avg_cost from public.pos_products p where p.id = cola_id;
  if avg_cost <> 60.00 then
    raise exception 'FAIL  5b receiving changed the enterprise default cost to %', avg_cost;
  end if;
  raise notice 'PASS  5b receiving never moves the enterprise default unit cost';

  --------------------------------------------------- 6. adjustments and cost
  perform public.adjust_pos_stock(branch_a, cola_id, -5, 'damaged', 'water damage');
  select i.quantity_on_hand, i.average_unit_cost into qty, avg_cost
    from public.pos_branch_inventory i
    where i.branch_id = branch_a and i.product_id = cola_id;
  if qty <> 15 then raise exception 'FAIL  6a expected 15 units after -5, found %', qty; end if;
  if avg_cost <> 45.00 then
    raise exception 'FAIL  6b a negative adjustment changed the average to %', avg_cost;
  end if;
  raise notice 'PASS  6a a negative adjustment lowers quantity';
  raise notice 'PASS  6b an adjustment does not invent or change a unit cost';

  select m.unit_cost into avg_cost from public.pos_inventory_movements m
    where m.branch_id = branch_a and m.product_id = cola_id
      and m.movement_type = 'adjustment_out';
  if avg_cost is not null then
    raise exception 'FAIL  6c an adjustment movement carried a unit cost of %', avg_cost;
  end if;
  raise notice 'PASS  6c an adjustment movement carries no unit cost -- nothing was bought';

  ----------------------------------------------- 7. the stock equation holds
  select count(*) into n from public.pos_inventory_movements m
    where m.branch_id = branch_a and m.product_id = cola_id
      and m.stock_after <> m.stock_before + m.quantity_change;
  if n <> 0 then raise exception 'FAIL  7  % movements break stock_after = stock_before + change', n; end if;
  raise notice 'PASS  7  stock_after = stock_before + quantity_change on every movement';

  ------------------------------------------- 8. a failed mutation writes none
  select count(*) into n from public.pos_inventory_movements m
    where m.branch_id = branch_a and m.product_id = cola_id;
  begin
    perform public.adjust_pos_stock(branch_a, cola_id, -100, 'recount', null);
    raise exception 'FAIL  8a an adjustment below zero was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  8a an adjustment that would go below zero is refused';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select i.quantity_on_hand into qty from public.pos_branch_inventory i
    where i.branch_id = branch_a and i.product_id = cola_id;
  if qty <> 15 then raise exception 'FAIL  8b the refused adjustment changed the balance to %', qty; end if;
  select count(*) into qty from public.pos_inventory_movements m
    where m.branch_id = branch_a and m.product_id = cola_id;
  if qty <> n then raise exception 'FAIL  8c the refused adjustment wrote a movement'; end if;
  raise notice 'PASS  8b a refused mutation changes neither the balance nor the ledger';

  --------------------------------------- 9. branch/product mismatch refused
  begin
    perform public.receive_pos_stock(branch_a, gen_random_uuid(), 5, 10.00, null);
    raise exception 'FAIL  9  stock was received for a product the branch does not carry';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  9  receiving refuses a product the branch does not carry';
  end;

  reset role;

  ------------------------------------- 10. nobody may write the table directly
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.pos_branch_inventory set quantity_on_hand = 999
      where branch_id = branch_a and product_id = cola_id;
    raise exception 'FAIL 10a an administrator changed the quantity directly';
  exception when insufficient_privilege then
    raise notice 'PASS 10a even an administrator cannot UPDATE the balance directly';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.pos_branch_inventory set quantity_on_hand = 999
      where branch_id = branch_a and product_id = cola_id;
    raise exception 'FAIL 10b a POS manager changed the quantity directly';
  exception when insufficient_privilege then
    raise notice 'PASS 10b a POS manager cannot UPDATE the balance directly';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.pos_inventory_movements
      (branch_id, product_id, movement_type, quantity_change, stock_before, stock_after, source_type)
    values (branch_a, cola_id, 'receipt', 50, 15, 65, 'manual_receiving');
    raise exception 'FAIL 10c a cashier forged a movement';
  exception when insufficient_privilege then
    raise notice 'PASS 10c a cashier cannot INSERT a movement';
  end;
  reset role;

  -- And the guard holds even for a caller that bypasses RLS entirely, which is
  -- what a future SECURITY DEFINER function would do.
  begin
    update public.pos_branch_inventory set quantity_on_hand = 999
      where branch_id = branch_a and product_id = cola_id;
    raise exception 'FAIL 10d the write guard let an RLS-bypassing caller move stock';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 10d the write guard refuses stock changes outside the inventory operations';
  end;

  --------------------------------------------------- 11. reading: the manager
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.get_branch_inventory(branch_a) where product_id = cola_id;
  if n <> 1 then raise exception 'FAIL 11a a POS manager cannot read their own branch inventory'; end if;
  raise notice 'PASS 11a a POS manager reads their own branch inventory';

  select count(*) into n from public.get_branch_inventory(branch_b);
  if n <> 0 then raise exception 'FAIL 11b a POS manager read another branch inventory'; end if;
  raise notice 'PASS 11b a POS manager cannot read another branch inventory';

  select count(*) into n from public.pos_branch_inventory;
  if n <> 0 then raise exception 'FAIL 11c a POS manager read the balance table directly'; end if;
  select count(*) into n from public.pos_inventory_movements;
  if n <> 0 then raise exception 'FAIL 11d a POS manager read the movement table directly'; end if;
  raise notice 'PASS 11c a POS manager cannot read the balance or movement tables directly';

  select count(*) into n from public.get_branch_movements(branch_a, 100);
  if n < 1 then raise exception 'FAIL 11e a POS manager cannot read their own movement history'; end if;
  raise notice 'PASS 11e a POS manager reads their own movement history';

  select count(*) into n from public.get_branch_movements(branch_b, 100);
  if n <> 0 then raise exception 'FAIL 11f a POS manager read another branch movement history'; end if;
  raise notice 'PASS 11f a POS manager cannot read another branch movement history';

  begin
    select count(*) into n from public.get_branch_movements_with_cost(branch_a, 100);
    if n <> 0 then raise exception 'FAIL 11g a POS manager read cost-bearing movement history'; end if;
    raise notice 'PASS 11g a POS manager gets nothing from the cost-bearing history';
  exception when insufficient_privilege then
    raise notice 'PASS 11g a POS manager cannot execute the cost-bearing history';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  ---------------------------------- 12. cost is absent from the POS signatures
  txt := pg_get_function_result('public.get_branch_inventory(uuid)'::regprocedure);
  if txt ~* '(cost|margin|cogs|profit)' then
    raise exception 'FAIL 12a get_branch_inventory declares a cost-like column: %', txt;
  end if;
  txt := pg_get_function_result('public.get_branch_movements(uuid, integer)'::regprocedure);
  if txt ~* '(cost|margin|cogs|profit)' then
    raise exception 'FAIL 12b get_branch_movements declares a cost-like column: %', txt;
  end if;
  txt := pg_get_function_result('public.get_pos_catalogue(uuid)'::regprocedure);
  if txt ~* '(cost|margin|cogs|profit|threshold)' then
    raise exception 'FAIL 12c get_pos_catalogue declares a cost-like or threshold column: %', txt;
  end if;
  raise notice 'PASS 12  no POS-facing function declares cost, margin, COGS or the threshold';

  ------------------------------------------- 13. the low-stock threshold
  perform public.set_low_stock_threshold(branch_a, cola_id, 20);
  raise notice 'PASS 13a a POS manager sets the low-stock level at their own branch';

  reset role;
  select i.quantity_on_hand, i.average_unit_cost into qty, avg_cost
    from public.pos_branch_inventory i
    where i.branch_id = branch_a and i.product_id = cola_id;
  if qty <> 15 or avg_cost <> 45.00 then
    raise exception 'FAIL 13b setting a threshold changed quantity/valuation to % @ %', qty, avg_cost;
  end if;
  raise notice 'PASS 13b setting a threshold changes neither quantity nor valuation';

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.set_low_stock_threshold(branch_b, cola_id, 5);
    raise exception 'FAIL 13c a POS manager set a threshold at another branch';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 13c a POS manager cannot set a threshold at another branch';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.set_low_stock_threshold(branch_a, cola_id, 5);
    raise exception 'FAIL 13d a cashier set a low-stock level';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 13d a cashier cannot set a low-stock level';
  end;

  ----------------------------------------------- 14. the cashier's catalogue
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select available_quantity, is_low_stock::text into qty, txt
    from public.get_pos_catalogue(branch_a) where product_id = cola_id;
  if qty <> 15 then raise exception 'FAIL 14a cashier sees % available, expected 15', qty; end if;
  if txt <> 'true' then raise exception 'FAIL 14b 15 units under a threshold of 20 was not low stock'; end if;
  raise notice 'PASS 14a a cashier sees the operational quantity through the catalogue';
  raise notice 'PASS 14b low stock is computed server-side from the threshold the cashier never receives';

  select count(*) into n from public.get_branch_inventory(branch_a);
  if n <> 0 then raise exception 'FAIL 14c a cashier read the inventory management view'; end if;
  select count(*) into n from public.get_branch_movements(branch_a, 100);
  if n <> 0 then raise exception 'FAIL 14d a cashier read the movement history'; end if;
  raise notice 'PASS 14c a cashier reads neither the inventory view nor the movement history';

  ----------------------------------- 15. no POS access, revoked, deactivated
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_branch_inventory(branch_a);
  if n <> 0 then raise exception 'FAIL 15a an account with no POS access read inventory'; end if;
  select count(*) into n from public.get_pos_catalogue(branch_a);
  if n <> 0 then raise exception 'FAIL 15b an account with no POS access read the catalogue'; end if;
  raise notice 'PASS 15a an account with no POS access sees no inventory';
  reset role;

  update public.pos_branch_assignments set status = 'inactive'
    where profile_id = manager_id and status = 'active';
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_branch_inventory(branch_a);
  if n <> 0 then raise exception 'FAIL 15c a revoked manager still reads inventory'; end if;
  raise notice 'PASS 15b a revoked assignment loses inventory access';
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set status = 'inactive' where id = cashier_id;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_catalogue(branch_a);
  if n <> 0 then raise exception 'FAIL 15d a deactivated cashier still reads the catalogue'; end if;
  raise notice 'PASS 15c a deactivated profile loses inventory access';
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set status = 'active' where id = cashier_id;
  reset role;

  ------------------------------------------ 16. history survives un-carrying
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.pos_branch_products set is_available = false
    where branch_id = branch_a and product_id = cola_id;

  reset role;
  select i.quantity_on_hand into qty from public.pos_branch_inventory i
    where i.branch_id = branch_a and i.product_id = cola_id;
  if qty <> 15 then raise exception 'FAIL 16a disabling a branch product lost its balance'; end if;
  select count(*) into n from public.pos_inventory_movements m
    where m.branch_id = branch_a and m.product_id = cola_id;
  if n < 3 then raise exception 'FAIL 16b disabling a branch product lost its history'; end if;
  raise notice 'PASS 16a disabling a branch product keeps its balance and its history';

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_catalogue(branch_a) where product_id = cola_id;
  if n <> 0 then raise exception 'FAIL 16c a disabled product still appears in the catalogue'; end if;
  raise notice 'PASS 16b a disabled product disappears from the branch catalogue';
  reset role;

  ------------------------- 17. deletion is refused once history exists
  begin
    delete from public.pos_branch_products
      where branch_id = branch_a and product_id = cola_id;
    raise exception 'FAIL 17a a branch product with movement history was deleted';
  exception when foreign_key_violation then
    raise notice 'PASS 17a a branch product with movement history cannot be deleted';
  end;

  -- Branch B never received anything, so it is exceptional cleanup and allowed.
  delete from public.pos_branch_products
    where branch_id = branch_b and product_id = cola_id;
  select count(*) into n from public.pos_branch_inventory i
    where i.branch_id = branch_b and i.product_id = cola_id;
  if n <> 0 then raise exception 'FAIL 17b removing a never-stocked branch product left its balance'; end if;
  raise notice 'PASS 17b a branch product with no history can still be cleaned up';

  ------------------------------------------------ 18. anon and PUBLIC are out
  set local role anon;
  begin
    perform public.get_branch_inventory(branch_a);
    raise exception 'FAIL 18a anon executed get_branch_inventory';
  exception when insufficient_privilege then
    raise notice 'PASS 18a anon cannot execute the inventory reads';
  end;
  reset role;

  set local role anon;
  begin
    perform public.receive_pos_stock(branch_a, cola_id, 1, 1.00, null);
    raise exception 'FAIL 18b anon executed receive_pos_stock';
  exception when insufficient_privilege then
    raise notice 'PASS 18b anon cannot execute the inventory mutations';
  end;
  reset role;

  -- Asserted against the catalogue, not the REVOKE statement: this project has
  -- twice had a revoke that read as though it worked and did not.
  select count(*) into n
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('get_branch_inventory', 'get_branch_movements',
                      'get_branch_movements_with_cost', 'receive_pos_stock',
                      'adjust_pos_stock', 'set_low_stock_threshold', 'get_pos_catalogue')
    and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception 'FAIL 18c % inventory functions are still executable by anon', n; end if;
  raise notice 'PASS 18c has_function_privilege confirms anon holds EXECUTE on none of them';

  raise notice '--- all POS inventory contract checks passed ---';
end $$;

rollback;

select 'balances after rollback: ' || count(*)::text as verify from public.pos_branch_inventory;
