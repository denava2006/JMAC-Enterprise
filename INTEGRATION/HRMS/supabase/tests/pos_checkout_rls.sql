-- POS checkout — database contract test.
--
-- Checkout is the one operation that takes money, moves stock and writes
-- accounting in a single step, so almost everything about it is load-bearing:
-- the client cannot influence price, cost, fees or identity; a retry cannot
-- charge twice; a failure leaves nothing behind; and cost never reaches a till.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_checkout_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.
-- Concurrency is NOT covered here -- see scripts/pos-checkout-concurrency.sh.

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
  till_user  uuid;
  manager_id  uuid;
  outsider_id uuid;
  branch_a    uuid;
  branch_b    uuid;
  general_id  uuid;
  cola_id     uuid;
  chips_id    uuid;
  draft_id    uuid;
  key1        uuid := gen_random_uuid();
  key2        uuid := gen_random_uuid();
  receipt     jsonb;
  receipt2    jsonb;
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
  select id into till_user from public.profiles
    where role = 'employee' and status = 'active' order by created_at, id limit 1;
  select id into manager_id from public.profiles
    where role = 'employee' and status = 'active' and id <> till_user order by created_at, id limit 1;
  select id into outsider_id from public.profiles
    where role <> 'admin' and status = 'active' and id not in (till_user, manager_id)
    order by created_at, id limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';

  if admin_id is null or branch_b is null or till_user is null or manager_id is null
     or outsider_id is null or general_id is null then
    raise exception 'fixture: need an admin, two branches, two employees, one other account, General';
  end if;

  delete from public.pos_branch_assignments;
    -- FIXTURE WIRED (Phase 9A): give these people the employment record
  -- their POS role now requires. The assignment INSERT below is refused
  -- otherwise, which is the point of the phase.
  perform pg_temp.make_pos_eligible(manager_id, 'POS Manager');
  perform pg_temp.make_pos_eligible(till_user, 'Cashier');

insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (till_user, branch_a, 'cashier', admin_id),
         (manager_id, branch_a, 'manager', admin_id);

  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Chk Cola ' || tag, general_id, 100.00, 0, 'active') returning id into cola_id;
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Chk Chips ' || tag, general_id, 25.00, 0, 'active') returning id into chips_id;
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Chk Draft ' || tag, general_id, 50.00, 0, 'draft') returning id into draft_id;

  insert into public.pos_branch_products (branch_id, product_id, is_available, selling_price_override)
  values (branch_a, cola_id, true, null),
         (branch_a, chips_id, true, 20.00),   -- branch override, must win
         (branch_a, draft_id, true, null),
         (branch_b, cola_id, true, null);

  -- Stock, and a branch valuation for COGS to snapshot from.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_pos_stock(branch_a, cola_id, 20, 60.00, null);
  perform public.receive_pos_stock(branch_a, chips_id, 10, 8.00, null);
  perform public.receive_pos_stock(branch_a, draft_id, 5, 30.00, null);
  reset role;

  -- A fee on this branch, so fee handling is exercised.
  insert into public.branch_pos_settings (branch_id, fees)
  values (branch_a, jsonb_build_array(jsonb_build_object(
    'id', 'f1', 'name', 'Service Charge', 'type', 'percent', 'value', 10, 'enabled', true)))
  on conflict (branch_id) do update set fees = excluded.fees;

  ------------------------------------------------------- 1. who may check out
  perform set_config('request.jwt.claims', json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.checkout_pos_sale(branch_a,
      jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 1)),
      'cash', gen_random_uuid(), null, 1000);
    raise exception 'FAIL  1a an account with no POS access checked out';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1a an account with no POS access cannot check out';
  end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.checkout_pos_sale(branch_b,
      jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 1)),
      'cash', gen_random_uuid(), null, 1000);
    raise exception 'FAIL  1b a cashier checked out at another branch';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1b a cashier cannot check out at a branch they are not assigned to';
  end;

  ------------------------------------------------------- 2. cart validation
  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  begin
    perform public.checkout_pos_sale(branch_a, '[]'::jsonb, 'cash', gen_random_uuid(), null, 100);
    raise exception 'FAIL  2a an empty cart was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a an empty cart is refused';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.checkout_pos_sale(branch_a,
      jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 0)),
      'cash', gen_random_uuid(), null, 100);
    raise exception 'FAIL  2b a zero quantity was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2b a non-positive quantity is refused';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.checkout_pos_sale(branch_a,
      jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', public.pos_max_line_quantity() + 1)),
      'cash', gen_random_uuid(), null, 1000000);
    raise exception 'FAIL  2c a line above the quantity cap was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2c a line above the per-line quantity cap is refused';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.checkout_pos_sale(branch_a,
      jsonb_build_array(jsonb_build_object('product_id', draft_id, 'quantity', 1)),
      'cash', gen_random_uuid(), null, 1000);
    raise exception 'FAIL  2d a DRAFT product was sold';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2d a product that is not active cannot be sold';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.checkout_pos_sale(branch_a,
      jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 999)),
      'cash', gen_random_uuid(), null, 1000000);
    raise exception 'FAIL  2e a sale beyond available stock was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2e a sale beyond available stock is refused';
  end;

  ------------------------------------------------------------- 3. payment
  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.checkout_pos_sale(branch_a,
      jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 1)),
      'cash', gen_random_uuid(), null, 50);
    raise exception 'FAIL  3a an underpaid cash sale was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3a cash below the total is refused';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.checkout_pos_sale(branch_a,
      jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 1)),
      'gcash', gen_random_uuid(), 'abc', null);
    raise exception 'FAIL  3b a malformed GCash reference was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3b a malformed electronic reference is refused';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.checkout_pos_sale(branch_a,
      jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 1)),
      'gcash', gen_random_uuid(), null, null);
    raise exception 'FAIL  3c an electronic sale with no reference was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3c an electronic payment requires a reference';
  end;

  -------------------------------- 4. nothing was written by any of the above
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.pos_sales;
  if n <> 0 then raise exception 'FAIL  4a a refused checkout wrote % sales', n; end if;
  select count(*) into n from public.pos_inventory_movements m where m.movement_type = 'sale';
  if n <> 0 then raise exception 'FAIL  4b a refused checkout wrote % sale movements', n; end if;
  select i.quantity_on_hand into qty from public.pos_branch_inventory i
    where i.branch_id = branch_a and i.product_id = cola_id;
  if qty <> 20 then raise exception 'FAIL  4c a refused checkout changed stock to %', qty; end if;
  raise notice 'PASS  4  every refused checkout left no sale, no movement and no deduction';
  reset role;

  ---------------------------------------- 5. a real sale, with duplicate lines
  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- Cola twice (2 + 3) and Chips once. Subtotal must be 5x100 + 2x20 = 540,
  -- the 10% fee 54.00, total 594.00, change from 600 = 6.00.
  receipt := public.checkout_pos_sale(
    branch_a,
    jsonb_build_array(
      jsonb_build_object('product_id', cola_id, 'quantity', 2),
      jsonb_build_object('product_id', chips_id, 'quantity', 2),
      jsonb_build_object('product_id', cola_id, 'quantity', 3)
    ),
    'cash', key1, null, 600
  );

  if (receipt->>'subtotal')::numeric <> 540.00 then
    raise exception 'FAIL  5a subtotal is %, expected 540.00', receipt->>'subtotal';
  end if;
  raise notice 'PASS  5a duplicate lines are merged and priced once (5 x 100 + 2 x 20 = 540)';

  if (receipt->>'fees_total')::numeric <> 54.00 then
    raise exception 'FAIL  5b fees total is %, expected 54.00', receipt->>'fees_total';
  end if;
  if (receipt->>'total_amount')::numeric <> 594.00 then
    raise exception 'FAIL  5c total is %, expected 594.00', receipt->>'total_amount';
  end if;
  raise notice 'PASS  5b the branch fee is applied server-side (10%% of 540 = 54.00)';

  if (receipt->>'change_given')::numeric <> 6.00 then
    raise exception 'FAIL  5d change is %, expected 6.00', receipt->>'change_given';
  end if;
  raise notice 'PASS  5c change is computed and returned by the database';

  if jsonb_array_length(receipt->'items') <> 2 then
    raise exception 'FAIL  5e receipt has % lines, expected 2 after merging', jsonb_array_length(receipt->'items');
  end if;
  raise notice 'PASS  5d the receipt shows one line per product';

  ------------------------------------------ 6. the branch override was used
  reset role;
  select i.unit_price into avg_cost from public.pos_sale_items i
    join public.pos_sales s on s.id = i.sale_id
    where i.product_id = chips_id;
  if avg_cost <> 20.00 then
    raise exception 'FAIL  6  the chips sold at %, expected the branch override of 20.00', avg_cost;
  end if;
  raise notice 'PASS  6  the branch price override is what the customer paid';

  ------------------------------------------------- 7. cost snapshot and COGS
  select i.unit_cost_snapshot, i.line_cogs into avg_cost, qty
    from public.pos_sale_items i where i.product_id = cola_id;
  if avg_cost <> 60.00 then
    raise exception 'FAIL  7a cola cost snapshot is %, expected the branch average of 60.00', avg_cost;
  end if;
  if qty <> 300 then
    raise exception 'FAIL  7b cola line COGS is %, expected 5 x 60 = 300', qty;
  end if;
  select s.total_cogs into avg_cost from public.pos_sales s;
  if avg_cost <> 316.00 then
    raise exception 'FAIL  7c sale COGS is %, expected 300 + 16 = 316.00', avg_cost;
  end if;
  raise notice 'PASS  7  COGS is snapshotted from the branch average at the moment of sale';

  ------------------------------- 8. selling does not move the branch average
  select i.quantity_on_hand, i.average_unit_cost into qty, avg_cost
    from public.pos_branch_inventory i
    where i.branch_id = branch_a and i.product_id = cola_id;
  if qty <> 15 then raise exception 'FAIL  8a cola stock is %, expected 20 - 5 = 15', qty; end if;
  if avg_cost <> 60.00 then
    raise exception 'FAIL  8b selling moved the branch average to %', avg_cost;
  end if;
  raise notice 'PASS  8  stock falls by exactly the quantity sold and the average is untouched';

  ------------------------------------------------------------ 9. movements
  select count(*) into n from public.pos_inventory_movements m
    where m.movement_type = 'sale';
  if n <> 2 then raise exception 'FAIL  9a the sale wrote % movements, expected one per line', n; end if;

  select count(*) into n from public.pos_inventory_movements m
    join public.pos_sales s on s.id = m.source_id
    where m.movement_type = 'sale' and m.source_type = 'sale' and m.quantity_change < 0
      and m.actor_id = till_user;
  if n <> 2 then raise exception 'FAIL  9b sale movements carry the wrong provenance or actor'; end if;
  raise notice 'PASS  9a one sale movement per line, typed and sourced by the database';

  -- The movement's cost must equal what the sale line snapshotted.
  select count(*) into n
  from public.pos_inventory_movements m
  join public.pos_sale_items i on i.product_id = m.product_id and i.sale_id = m.source_id
  where m.movement_type = 'sale' and m.unit_cost is distinct from i.unit_cost_snapshot;
  if n <> 0 then raise exception 'FAIL  9c % sale movements disagree with their sale line cost', n; end if;
  raise notice 'PASS  9b every sale movement carries the same unit cost as its sale line';

  select count(*) into n from public.pos_inventory_movements m
    where m.stock_after <> m.stock_before + m.quantity_change;
  if n <> 0 then raise exception 'FAIL  9d the stock equation broke on % movements', n; end if;
  raise notice 'PASS  9c the ledger equation still holds after a sale';

  --------------------------------------------------------- 10. idempotency
  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  receipt2 := public.checkout_pos_sale(
    branch_a,
    jsonb_build_array(
      jsonb_build_object('product_id', chips_id, 'quantity', 2),
      jsonb_build_object('product_id', cola_id, 'quantity', 5)
    ),
    'cash', key1, null, 600
  );
  if (receipt2->>'sale_id') <> (receipt->>'sale_id') then
    raise exception 'FAIL 10a a retry created a different sale';
  end if;
  raise notice 'PASS 10a the same key and the same cart (in any order) returns the original sale';

  reset role;
  select count(*) into n from public.pos_sales;
  if n <> 1 then raise exception 'FAIL 10b a retry created % sales', n; end if;
  select count(*) into n from public.pos_inventory_movements m where m.movement_type = 'sale';
  if n <> 2 then raise exception 'FAIL 10c a retry wrote extra movements (%)', n; end if;
  select i.quantity_on_hand into qty from public.pos_branch_inventory i
    where i.branch_id = branch_a and i.product_id = cola_id;
  if qty <> 15 then raise exception 'FAIL 10d a retry deducted stock again (now %)', qty; end if;
  raise notice 'PASS 10b a retry writes no second sale, no second movement, no second deduction';

  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.checkout_pos_sale(branch_a,
      jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 1)),
      'cash', key1, null, 600);
    raise exception 'FAIL 10e the same key was reused for a different cart';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 10c the same key with a different cart is rejected';
  end;

  ------------------------------------------------- 11. no cost in the receipt
  txt := receipt::text;
  if txt ~* '(cost|cogs|margin|profit)' then
    raise exception 'FAIL 11a the checkout response carries a cost-like field: %', left(txt, 200);
  end if;
  raise notice 'PASS 11a the checkout response contains no cost, COGS, margin or profit';

  -- And nothing in the receipt-builder's construction can produce one.
  select pg_get_functiondef(p.oid) into txt from pg_proc p
    where p.proname = 'pos_sale_receipt' and p.pronamespace = 'public'::regnamespace;
  if txt ~* '(unit_cost|line_cogs|total_cogs|gross_profit|net_profit)' then
    raise exception 'FAIL 11b the receipt builder references a cost column';
  end if;
  raise notice 'PASS 11b the receipt is built from receipt-safe columns only, not stripped afterwards';

  ------------------------------------------ 12. the sale tables stay private
  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.pos_sales;
  if n <> 0 then raise exception 'FAIL 12a a cashier read the sales table directly'; end if;
  select count(*) into n from public.pos_sale_items;
  if n <> 0 then raise exception 'FAIL 12b a cashier read the sale items table directly'; end if;
  raise notice 'PASS 12a a cashier cannot read the sale tables directly';

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.pos_sales;
  if n <> 0 then raise exception 'FAIL 12c a POS manager read the sales table directly'; end if;
  raise notice 'PASS 12b a POS manager cannot read the sale tables directly';

  begin
    insert into public.pos_sales (branch_id, cashier_id, subtotal, total_amount,
      payment_method, amount_tendered, change_given, branch_name, cashier_name,
      checkout_key, request_fingerprint)
    values (branch_a, manager_id, 1, 1, 'cash', 1, 0, 'x', 'y', gen_random_uuid(), 'z');
    raise exception 'FAIL 12d a POS manager forged a sale';
  exception when insufficient_privilege then
    raise notice 'PASS 12c a POS manager cannot INSERT a sale';
  end;
  reset role;

  ------------------------------------------------------------- 13. the ACLs
  --
  -- Asserted against the catalogue, not against the REVOKE statements. This
  -- project has had four different default-privilege traps; the statements are
  -- not the evidence.
  select count(*) into n from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('checkout_pos_sale', 'pos_sale_receipt', 'validate_pos_payment_reference')
    and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception 'FAIL 13a % checkout functions are executable by anon', n; end if;
  raise notice 'PASS 13a anon holds EXECUTE on none of the checkout functions';

  if has_function_privilege('authenticated', 'public.pos_sale_receipt(uuid)', 'execute') then
    raise exception 'FAIL 13b the internal receipt helper is callable by any signed-in account';
  end if;
  raise notice 'PASS 13b the internal receipt helper is not reachable by a signed-in account';

  if not has_function_privilege('authenticated', 'public.checkout_pos_sale(uuid,jsonb,text,uuid,text,numeric)', 'execute') then
    raise exception 'FAIL 13c the till cannot call checkout';
  end if;
  raise notice 'PASS 13c the till itself can still call checkout';

  select count(*) into n from information_schema.role_table_grants
  where table_schema = 'public' and table_name in ('pos_sales', 'pos_sale_items')
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  if n <> 0 then raise exception 'FAIL 13d anon/authenticated hold % write grants on the sale tables', n; end if;
  raise notice 'PASS 13d neither anon nor authenticated holds any write grant on the sale tables';

  ------------------------------------------ 14. a manager may also check out
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  receipt2 := public.checkout_pos_sale(branch_a,
    jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 1)),
    'gcash', key2, '1234567890', null);
  if (receipt2->>'payment_reference') <> '1234567890' then
    raise exception 'FAIL 14a the payment reference was not captured';
  end if;
  if receipt2 ? 'change_given' and (receipt2->>'change_given') is not null then
    raise exception 'FAIL 14b an electronic sale recorded change';
  end if;
  txt := receipt2::text;
  if txt ~* '(cost|cogs|margin|profit)' then
    raise exception 'FAIL 14c a manager received cost in the checkout response';
  end if;
  raise notice 'PASS 14  a POS manager may check out, and receives no cost either';
  reset role;

  ------------------------------------------------ 15. snapshots are frozen
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.pos_products set name = 'ZZ Renamed ' || tag where id = cola_id;
  reset role;

  select i.product_name into txt from public.pos_sale_items i
    where i.product_id = cola_id limit 1;
  if txt like 'ZZ Renamed%' then
    raise exception 'FAIL 15a renaming a product rewrote an old sale line';
  end if;
  raise notice 'PASS 15a renaming a product does not rewrite a completed sale';

  select count(*) into n from public.pos_sales s
    where coalesce(btrim(s.cashier_name), '') <> ''
      and coalesce(btrim(s.branch_name), '') <> '';
  if n <> 2 then
    raise exception 'FAIL 15b % of 2 sales carry a branch and cashier name snapshot', n;
  end if;
  raise notice 'PASS 15b every sale carries its own branch and cashier name for reprints';

  raise notice '--- all POS checkout contract checks passed ---';
end $$;

rollback;

select 'sales after rollback: ' || count(*)::text as verify from public.pos_sales;
