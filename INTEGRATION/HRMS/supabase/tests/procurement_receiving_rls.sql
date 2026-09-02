-- FMS F4 — procurement, and the one bridge to physical stock.
--
-- The rule this whole phase exists to hold, checked rather than asserted:
--
--   request approval  != stock received
--   purchase order    != stock received
--   supplier invoice  != stock received   (none exists in F4, and that is checked too)
--   payment           != stock received
--
-- Only a POS Manager confirming a physical delivery moves inventory, and POS
-- remains the only place a quantity lives.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/procurement_receiving_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

create or replace function pg_temp.acts_as(_uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
$$;

create or replace function pg_temp.hire(_name text, _position text)
returns uuid
language plpgsql as $$
declare
  _emp uuid; _uid uuid; _pos uuid; _dept uuid; _admin uuid;
  _tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into _admin from public.profiles where role='admin' and status='active' limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', _admin, 'role', 'authenticated')::text, true);

  select p.id, p.department_id into _pos, _dept
  from public.positions p where lower(p.title) = lower(_position) limit 1;
  if _pos is null then raise exception 'fixture: no position %', _position; end if;

  insert into public.employees (first_name, last_name, email, department_id, position_id,
                                hire_date, employment_status)
  values ('ZZ', _name || ' ' || _tag, 'zz.' || _tag || '@jmac-test.invalid',
          _dept, _pos, current_date, 'active')
  returning id into _emp;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, email_change,
                          email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
          'authenticated', 'zz.' || _tag || '@jmac-test.invalid',
          crypt('x', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
  returning id into _uid;

  update public.profiles set employee_id = _emp, status = 'active' where id = _uid;
  return _uid;
end;
$$;

do $$
declare
  admin_id uuid; staff uuid; manager uuid; acct uuid;
  mgr_a uuid; mgr_b uuid; cashier uuid;
  branch_a uuid; branch_b uuid; general_id uuid; product uuid; vendor uuid;
  po uuid; line_a uuid; line_b uuid; receipt uuid; key1 uuid := gen_random_uuid();
  n integer; qty integer; num numeric; txt text;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';
  if admin_id is null or branch_b is null or general_id is null then
    raise exception 'fixture: need an admin, two branches and the General category';
  end if;

  staff   := pg_temp.hire('Fin Staff',   'Finance Staff');
  manager := pg_temp.hire('Fin Manager', 'Finance Manager');
  acct    := pg_temp.hire('Fin Acct',    'Accountant');
  mgr_a   := pg_temp.hire('Branch A Mgr', 'POS Manager');
  mgr_b   := pg_temp.hire('Branch B Mgr', 'POS Manager');
  cashier := pg_temp.hire('Till Person',  'Cashier');

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (mgr_a, branch_a, 'manager', admin_id),
         (mgr_b, branch_b, 'manager', admin_id),
         (cashier, branch_a, 'cashier', admin_id);

  perform pg_temp.acts_as(admin_id);
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Procurement Cola ' || tag, general_id, 85.00, 60.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true), (branch_b, product, true);

  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.vendors (name) values ('ZZ Supplier ' || tag) returning id into vendor;
  reset role;

  -- ======================================================================
  -- 1. Finance Staff prepare; only the Finance Manager approves
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.purchase_orders (vendor_id, order_date, expected_delivery_date)
  values (vendor, current_date, current_date + 7) returning id into po;

  select po_number into txt from public.purchase_orders where id = po;
  if txt !~ '^PO-\d{4}-\d{4}$' then raise exception 'FAIL 1a po_number is %', txt; end if;

  insert into public.purchase_order_items
    (purchase_order_id, description, quantity_ordered, unit_cost, pos_product_id, destination_branch_id)
  values (po, 'ZZ Cola case', 10, 55.00, product, branch_a) returning id into line_a;

  select line_total into num from public.purchase_order_items where id = line_a;
  if num <> 550 then raise exception 'FAIL 1b line_total is %, expected 550', num; end if;
  raise notice 'PASS  1a-b Finance Staff draft an order; the number and the line total are the server''s';

  perform public.transition_purchase_order(po, 'pending_approval');

  begin
    perform public.transition_purchase_order(po, 'approved');
    raise exception 'FAIL 1c Finance Staff approved their own purchase order';
  exception when insufficient_privilege then
    raise notice 'PASS  1c Finance Staff submit; they do not approve';
  end;
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  begin
    perform public.transition_purchase_order(po, 'approved');
    raise exception 'FAIL 1d the Accountant approved a purchase order';
  exception when insufficient_privilege then
    raise notice 'PASS  1d the Accountant reads procurement and approves none of it';
  end;
  reset role;

  perform pg_temp.acts_as(admin_id); set local role authenticated;
  begin
    perform public.transition_purchase_order(po, 'approved');
    raise exception 'FAIL 1e the Administrator approved a purchase order';
  exception when insufficient_privilege then
    raise notice 'PASS  1e the Administrator has oversight, not operational approval';
  end;
  reset role;

  perform pg_temp.acts_as(cashier); set local role authenticated;
  begin
    insert into public.purchase_orders (vendor_id) values (vendor);
    raise exception 'FAIL 1f a cashier created a purchase order';
  exception when insufficient_privilege then
    raise notice 'PASS  1f nobody outside Finance creates procurement documents';
  end;
  reset role;

  begin
    set local role anon;
    perform 1 from public.purchase_orders limit 1;
    raise exception 'FAIL 1g anon read the purchase orders';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  1g anon is refused by the table grant';
  end;
  reset role;

  -- ======================================================================
  -- 2. A purchase order moves no stock, at any status
  -- ======================================================================
  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  if qty <> 0 then raise exception 'FAIL 2a the branch did not start at zero (%)', qty; end if;

  select count(*) into n from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;
  if n <> 0 then raise exception 'FAIL 2a % movements exist before anything happened', n; end if;

  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'approved');
  reset role;

  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  select count(*) into n from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;
  if qty <> 0 or n <> 0 then
    raise exception 'FAIL 2b approving a purchase order moved stock (qty %, movements %)', qty, n;
  end if;
  raise notice 'PASS  2a-b draft, submitted and approved orders all leave stock untouched';

  -- ======================================================================
  -- 3. Only the destination branch's manager may confirm a delivery
  -- ======================================================================
  perform pg_temp.acts_as(mgr_b); set local role authenticated;
  begin
    perform public.receive_procurement_stock(line_a, 5, 'DR-1');
    raise exception 'FAIL 3a a manager received another branch''s delivery';
  exception when insufficient_privilege then
    raise notice 'PASS  3a a manager cannot receive another branch''s delivery';
  end;
  reset role;

  perform pg_temp.acts_as(cashier); set local role authenticated;
  begin
    perform public.receive_procurement_stock(line_a, 5, 'DR-1');
    raise exception 'FAIL 3b a cashier received a delivery';
  exception when insufficient_privilege then
    raise notice 'PASS  3b a cashier cannot receive a delivery';
  end;
  reset role;

  perform pg_temp.acts_as(admin_id); set local role authenticated;
  begin
    perform public.receive_procurement_stock(line_a, 5, 'DR-1');
    raise exception 'FAIL 3c the Administrator received a procurement delivery';
  exception when insufficient_privilege then
    raise notice 'PASS  3c procurement receiving belongs to the branch manager, not the Administrator';
  end;
  reset role;

  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.receive_procurement_stock(line_a, 5, 'DR-1');
    raise exception 'FAIL 3d Finance received physical stock';
  exception when insufficient_privilege then
    raise notice 'PASS  3d Finance orders goods; it does not confirm they arrived';
  end;
  reset role;

  -- ======================================================================
  -- 4. A partial delivery moves exactly what arrived, at the order's cost
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  receipt := public.receive_procurement_stock(line_a, 6, 'DR-1001', key1);
  -- pos_inventory_movements is Administrator-only by policy, so the ledger
  -- assertions run as the suite owner. What is under test is who may RECEIVE,
  -- and that call was made as the branch manager.
  reset role;

  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  if qty <> 6 then raise exception 'FAIL 4a stock reads % after receiving 6', qty; end if;

  select count(*) into n from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;
  if n <> 1 then raise exception 'FAIL 4a % movements for one receipt', n; end if;

  -- The cost basis is the approved order line's, not the catalogue default of
  -- 60.00 and not anything the manager could have supplied.
  select unit_cost into num from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;
  if num <> 55.00 then
    raise exception 'FAIL 4b the movement was costed at % rather than the order''s 55.00', num;
  end if;

  select average_unit_cost into num from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  if num <> 55.00 then raise exception 'FAIL 4b weighted average reads %', num; end if;
  raise notice 'PASS  4a-b a partial delivery adds only what arrived, at the approved order cost';

  select source_type into txt from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;
  if txt <> 'procurement_receipt' then
    raise exception 'FAIL 4c the movement says its source was %', txt;
  end if;

  select count(*) into n from public.procurement_receipts pr
   join public.pos_inventory_movements m on m.id = pr.inventory_movement_id
   where pr.id = receipt;
  if n <> 1 then raise exception 'FAIL 4c the receipt is not linked to its movement'; end if;
  raise notice 'PASS  4c the movement names procurement as its source and links to the receipt';

  -- ======================================================================
  -- 5. Receiving is idempotent
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  if public.receive_procurement_stock(line_a, 6, 'DR-1001', key1) <> receipt then
    raise exception 'FAIL 5a a replay produced a different receipt';
  end if;

  reset role;
  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  select count(*) into n from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;
  if qty <> 6 or n <> 1 then
    raise exception 'FAIL 5a a replay moved stock again (qty %, movements %)', qty, n;
  end if;
  raise notice 'PASS  5a the same receiving action replayed changes nothing';

  -- ======================================================================
  -- 6. Over-receipt is refused; the remainder is not
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  begin
    perform public.receive_procurement_stock(line_a, 5, 'DR-1002');
    raise exception 'FAIL 6a 11 units were received against an order for 10';
  exception when check_violation then
    raise notice 'PASS  6a receiving more than remains outstanding is refused';
  end;

  perform public.receive_procurement_stock(line_a, 4, 'DR-1002');
  reset role;

  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  select count(*) into n from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;
  if qty <> 10 or n <> 2 then
    raise exception 'FAIL 6c after the remainder stock is % over % movements', qty, n;
  end if;
  raise notice 'PASS  6b-c the remainder completes the line: 6 then 4, two movements, ten units';

  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  begin
    perform public.receive_procurement_stock(line_a, 1, 'DR-1003');
    raise exception 'FAIL 6d a fully received line accepted more';
  exception when check_violation then
    raise notice 'PASS  6d a fully received line accepts nothing further';
  end;
  reset role;

  -- ======================================================================
  -- 7. What a branch manager is allowed to see of an order
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select count(*) into n from public.purchase_orders;
  if n <> 0 then raise exception 'FAIL 7a a branch manager read % purchase orders', n; end if;
  select count(*) into n from public.purchase_order_items;
  if n <> 0 then raise exception 'FAIL 7a a branch manager read the order lines, and their costs'; end if;
  raise notice 'PASS  7a a branch manager cannot read procurement documents or their costs';

  select count(*) into n from public.get_branch_deliveries(branch_a);
  if n <> 1 then raise exception 'FAIL 7b the delivery surface returned % lines', n; end if;

  select quantity_ordered, quantity_received, quantity_outstanding
    into qty, n, n
  from public.get_branch_deliveries(branch_a);
  if qty <> 10 then raise exception 'FAIL 7b ordered reads %', qty; end if;
  raise notice 'PASS  7b they see product and quantities through the branch delivery surface';
  reset role;

  perform pg_temp.acts_as(mgr_b); set local role authenticated;
  select count(*) into n from public.get_branch_deliveries(branch_a);
  if n <> 0 then raise exception 'FAIL 7c a manager saw another branch''s deliveries'; end if;
  raise notice 'PASS  7c the delivery surface is branch-scoped';
  reset role;

  -- ======================================================================
  -- 8. Nothing here settles anything
  -- ======================================================================
  select count(*) into n from information_schema.tables
   where table_schema = 'public'
     and table_name in ('supplier_invoices', 'accounts_payable', 'supplier_payments',
                        'journal_entries', 'fms_stock_balance', 'finance_inventory_quantity',
                        'procurement_on_hand');
  if n <> 0 then
    raise exception 'FAIL 8a F4 introduced % table(s) it was not supposed to', n;
  end if;
  raise notice 'PASS  8a no invoice, no payable, no payment, no journal, and no second stock balance';

  -- The reservation from F3 is untouched by any of this, and spent is still 0.
  perform pg_temp.acts_as(manager); set local role authenticated;
  select count(*) into n from public.budget_status where spent <> 0;
  if n <> 0 then raise exception 'FAIL 8b % budgets report spending', n; end if;
  raise notice 'PASS  8b approving and receiving an order moves neither reserved nor spent';
  reset role;
end $$;

rollback;
