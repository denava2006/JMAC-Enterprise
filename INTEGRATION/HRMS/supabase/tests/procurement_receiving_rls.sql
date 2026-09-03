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
  po2 uuid; po3 uuid; line_c uuid; vendor_b uuid;
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

  -- A second order, left in draft, for the sections that test who may write to
  -- one. The first order goes through the whole receiving story and cannot
  -- also be the one nobody is allowed to touch.
  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.purchase_orders (vendor_id) values (vendor) returning id into po2;
  insert into public.purchase_order_items
    (purchase_order_id, description, quantity_ordered, unit_cost)
  values (po2, 'ZZ Draft line', 2, 25.00) returning id into line_c;
  reset role;

  -- Since F4.2 a proposed vendor is not yet a supplier the company deals with,
  -- and an order cannot be put forward against one. Everything below is about
  -- receiving rather than vendor approval, so the vendor is admitted here.
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.review_vendor(vendor, true, 'fixture');
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
  -- supplier_invoices left this list when F5 built it: recording what a
  -- supplier charged is exactly what that phase is for, and it settles nothing.
  -- The rest stay, and the line still holds what it was written to hold --
  -- receiving is not payment, and there is never a second place a quantity
  -- lives. Payment arrives in F6, and this assertion is what will notice it.
  select count(*) into n from information_schema.tables
   where table_schema = 'public'
     and table_name in ('supplier_payments', 'payments', 'journal_entries',
                        'general_ledger', 'fms_stock_balance',
                        'finance_inventory_quantity', 'procurement_on_hand');
  if n <> 0 then
    raise exception 'FAIL 8a % table(s) exist that no phase up to F5 should have built', n;
  end if;
  raise notice 'PASS  8a no payment, no journal, no ledger, and no second stock balance';

  -- The reservation from F3 is untouched by any of this, and spent is still 0.
  perform pg_temp.acts_as(manager); set local role authenticated;
  select count(*) into n from public.budget_status where spent <> 0;
  if n <> 0 then raise exception 'FAIL 8b % budgets report spending', n; end if;
  raise notice 'PASS  8b approving and receiving an order moves neither reserved nor spent';
  reset role;

  -- ======================================================================
  -- 9. Restock demand reaches Finance with no Administrator in the way
  -- ======================================================================
  -- The defect this section exists for: a branch asked for stock and Finance
  -- never saw it, because can_review_pos_request('restock') was is_admin() --
  -- a stand-in left in place until there was an FMS to hand it to.
  declare restock uuid;
  begin
    insert into public.pos_inventory_requests
      (branch_id, product_id, request_type, requested_quantity, reason, status,
       requested_by, branch_name_snapshot, product_name_snapshot, requester_name_snapshot)
    values (branch_a, product, 'restock', 10, 'ZZ running low', 'pending',
            mgr_a, 'Branch A', 'ZZ Procurement Cola', 'ZZ Branch A Mgr')
    returning id into restock;

    -- Finance sees it immediately. No Administrator has touched it.
    perform pg_temp.acts_as(staff); set local role authenticated;
    select count(*) into n from public.get_procurement_demand()
     where source_kind = 'pos_restock' and source_id = restock;
    if n <> 1 then
      raise exception 'FAIL 9a Finance cannot see a submitted restock request (% rows)', n;
    end if;

    select demand_state into txt from public.get_procurement_demand()
     where source_id = restock;
    if txt <> 'awaiting_finance_review' then
      raise exception 'FAIL 9a the demand state reads %', txt;
    end if;
    raise notice 'PASS  9a a submitted restock reaches Finance with no Administrator step';

    -- And Finance, not the Administrator, is who accepts it for procurement.
    perform public.approve_pos_request(restock, 'Accepted for procurement');
    select demand_state into txt from public.get_procurement_demand()
     where source_id = restock;
    if txt <> 'accepted_for_procurement' then
      raise exception 'FAIL 9b after acceptance the state reads %', txt;
    end if;
    raise notice 'PASS  9b Finance Staff accept restock demand for procurement';
    reset role;

    -- Accepting a restock is not general POS authority.
    perform pg_temp.acts_as(staff); set local role authenticated;
    if public.can_review_pos_request('carry_existing_product') then
      raise exception 'FAIL 9c Finance Staff gained catalogue authority';
    end if;
    if public.can_review_pos_request('new_product') then
      raise exception 'FAIL 9c Finance Staff gained product-creation authority';
    end if;
    raise notice 'PASS  9c Finance Staff review restock only, not the catalogue';
    reset role;

    -- The Administrator keeps catalogue authority and loses the procurement
    -- step, which is the dependency this correction removes.
    perform pg_temp.acts_as(admin_id); set local role authenticated;
    if public.can_review_pos_request('restock') then
      raise exception 'FAIL 9d the Administrator is still an approver for restock';
    end if;
    if not public.can_review_pos_request('new_product') then
      raise exception 'FAIL 9d the Administrator lost catalogue authority';
    end if;
    raise notice 'PASS  9d the Administrator keeps the catalogue and leaves procurement';
    reset role;

    -- A cashier reviews nothing and sees no procurement demand.
    perform pg_temp.acts_as(cashier); set local role authenticated;
    if public.can_review_pos_request('restock') then
      raise exception 'FAIL 9e a cashier can review restock';
    end if;
    select count(*) into n from public.get_procurement_demand();
    if n <> 0 then raise exception 'FAIL 9e a cashier read % procurement demand rows', n; end if;
    raise notice 'PASS  9e a cashier reviews nothing and sees no procurement demand';
    reset role;

    -- Finance still cannot read the underlying POS table directly.
    perform pg_temp.acts_as(staff); set local role authenticated;
    begin
      select count(*) into n from public.pos_inventory_requests;
      if n <> 0 then
        raise exception 'FAIL 9f Finance read % rows of pos_inventory_requests directly', n;
      end if;
    exception when insufficient_privilege then
      null;  -- refused outright is at least as good
    end;
    raise notice 'PASS  9f Finance reads procurement demand through the RPC, not the POS table';
    reset role;
  end;

  -- ======================================================================
  -- 11. The checker cannot write the document they approve
  -- ======================================================================
  --
  -- A hosted screenshot showed a Finance Manager looking at an order with the
  -- line editor still on screen. Hiding the buttons was not the fix; these are.
  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    insert into public.purchase_orders (vendor_id) values (vendor);
    raise exception 'FAIL 11a the Finance Manager raised a purchase order';
  exception when insufficient_privilege then
    raise notice 'PASS  11a the Finance Manager does not raise purchase orders';
  end;

  begin
    insert into public.purchase_order_items
      (purchase_order_id, description, quantity_ordered, unit_cost)
    values (po2, 'ZZ Manager line', 1, 10.00);
    raise exception 'FAIL 11b the Finance Manager added a line to an order';
  exception when insufficient_privilege then
    raise notice 'PASS  11b the Finance Manager does not add lines';
  end;

  delete from public.purchase_order_items where id = line_c;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 11c the Finance Manager deleted a line'; end if;
  raise notice 'PASS  11c the Finance Manager does not delete lines';

  update public.purchase_order_items set quantity_ordered = 99 where id = line_c;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 11d the Finance Manager edited a line'; end if;
  raise notice 'PASS  11d the Finance Manager does not edit lines';

  begin
    perform public.transition_purchase_order(po2, 'pending_approval');
    raise exception 'FAIL 11e the Finance Manager submitted an order for their own approval';
  exception when insufficient_privilege then
    raise notice 'PASS  11e submitting is the maker''s act, so the checker cannot do it';
  end;
  reset role;

  -- ======================================================================
  -- 12. Nobody approves the order they raised
  -- ======================================================================
  --
  -- Section 11 means a Manager cannot normally be an order's author at all.
  -- What that does not cover is promotion: the Staff member who raised this
  -- order last month and is the Manager today. Re-pointing created_by stands
  -- in for that history.
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_purchase_order(po2, 'pending_approval');
  reset role;

  update public.purchase_orders set created_by = manager where id = po2;

  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_purchase_order(po2, 'approved');
    raise exception 'FAIL 12a somebody approved a purchase order they had raised';
  exception when insufficient_privilege then
    raise notice 'PASS  12a nobody approves the purchase order they raised';
  end;
  reset role;

  update public.purchase_orders set created_by = staff where id = po2;

  -- ======================================================================
  -- 13. An order cannot be placed with a vendor nobody approved
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.vendors (name) values ('ZZ Unvetted ' || tag) returning id into vendor_b;
  insert into public.purchase_orders (vendor_id) values (vendor_b) returning id into po3;
  insert into public.purchase_order_items
    (purchase_order_id, description, quantity_ordered, unit_cost,
     pos_product_id, destination_branch_id)
  values (po3, 'ZZ Something', 5, 10.00, product, branch_b);

  begin
    perform public.transition_purchase_order(po3, 'pending_approval');
    raise exception 'FAIL 13a an order went forward against an unapproved vendor';
  exception when check_violation then
    raise notice 'PASS  13a a proposed vendor is not yet a supplier an order may be placed with';
  end;
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.review_vendor(vendor_b, true, 'checked');
  reset role;

  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_purchase_order(po3, 'pending_approval');
  raise notice 'PASS  13b once approved, the same vendor carries the same order forward';

  -- A material edit reopens the vendor, and the order must not carry the old
  -- verdict past the approval step on the strength of it.
  update public.vendors set tin = '777-666-555-44444' where id = vendor_b;
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_purchase_order(po3, 'approved');
    raise exception 'FAIL 13c an order was approved against a reopened vendor';
  exception when check_violation then
    raise notice 'PASS  13c a vendor sent back for re-approval stops the order too';
  end;
  reset role;

  -- ======================================================================
  -- 14. Closing an order means everything ordered arrived
  -- ======================================================================
  --
  -- po is complete: line_a ordered 10 and sections 4 and 6 received 6 then 4.
  -- A finished order closes with nothing further required.
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'closed');
  select status into txt from public.purchase_orders where id = po;
  if txt <> 'closed' then raise exception 'FAIL 14a a completed order would not close'; end if;
  -- The audit trail is the Administrator's to read, so the assertion drops
  -- back to the suite owner rather than asking Finance to see it.
  reset role;
  select count(*) into n from public.audit_logs
   where record_id = po and action = 'Purchase Order Closed';
  if n <> 1 then raise exception 'FAIL 14a a completed close was not audited as one'; end if;
  raise notice 'PASS  14a an order whose stock all arrived closes, and is audited as closed';

  -- po3 is the opposite case: approved, nothing delivered against it.
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.review_vendor(vendor_b, true, 're-checked after the TIN change');
  perform public.transition_purchase_order(po3, 'approved');

  begin
    perform public.transition_purchase_order(po3, 'closed');
    raise exception 'FAIL 14b an order closed with stock still undelivered';
  exception when check_violation then
    raise notice 'PASS  14b an order with something still outstanding does not simply close';
  end;

  -- Short-closing is allowed, but it costs a reason and it is audited under
  -- its own name, so a closed-short order is never mistaken for a complete one.
  perform public.transition_purchase_order(po3, 'closed', 'supplier discontinued the line');
  reset role;
  select count(*) into n from public.audit_logs
   where record_id = po3 and action = 'Purchase Order Closed Short';
  if n <> 1 then raise exception 'FAIL 14c a short close was audited as an ordinary close'; end if;
  raise notice 'PASS  14c closing short takes a reason, and says so in the audit trail';

  -- And what was already received stays received. Closing the paperwork does
  -- not reach back into stock that physically arrived.
  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  if qty is null or qty < 10 then
    raise exception 'FAIL 14d closing the order disturbed received stock (on hand %)', qty;
  end if;
  raise notice 'PASS  14d closing an order leaves stock that already arrived alone';

  -- An order with nothing receivable on it -- services, rent, a licence -- has
  -- no delivery to wait for, so "everything arrived" is vacuously true and it
  -- closes without a reason. po2's only line names no POS product, which is
  -- also why it can never move stock: there is nowhere for it to move to.
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po2, 'approved');
  perform public.transition_purchase_order(po2, 'closed');
  select status into txt from public.purchase_orders where id = po2;
  if txt <> 'closed' then raise exception 'FAIL 14e a services order would not close'; end if;
  reset role;
  select count(*) into n from public.pos_inventory_movements m
   where m.source_id in (
     select i.id from public.purchase_order_items i where i.purchase_order_id = po2
   );
  if n <> 0 then raise exception 'FAIL 14e a non-stock order moved inventory'; end if;
  raise notice 'PASS  14e an order with no stock lines closes freely and moves nothing';

  -- ======================================================================
  -- 15. A branch can see what became of what it asked for -- and no money
  -- ======================================================================
  --
  -- Section 9 leaves restock_req raised by mgr_a and accepted by Finance. The
  -- branch that raised it should be able to see where it got to without asking
  -- anybody, and without learning what anything cost.
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select count(*) into n from public.get_branch_request_progress(branch_a);
  if n = 0 then raise exception 'FAIL 15a the branch cannot see its own requests'; end if;
  raise notice 'PASS  15a a branch manager sees what became of their restock requests';

  -- The progress word is derived from the documents, not stored anywhere.
  select progress into txt from public.get_branch_request_progress(branch_a)
   order by requested_at desc limit 1;
  if txt is null then raise exception 'FAIL 15b no progress for an accepted request'; end if;
  raise notice 'PASS  15b progress is derived from the procurement documents (%)', txt;
  reset role;

  -- Not another branch's, and not a cashier's.
  perform pg_temp.acts_as(mgr_b); set local role authenticated;
  select count(*) into n from public.get_branch_request_progress(branch_a);
  if n <> 0 then raise exception 'FAIL 15c another branch''s manager read branch A''s requests'; end if;
  reset role;

  perform pg_temp.acts_as(cashier); set local role authenticated;
  select count(*) into n from public.get_branch_request_progress(branch_a);
  if n <> 0 then raise exception 'FAIL 15c a cashier read the branch''s request progress'; end if;
  raise notice 'PASS  15c the answer is per branch, and per manager';
  reset role;

  -- The money guarantee, checked against the function's signature rather than
  -- against one row: a column that does not exist cannot leak.
  select string_agg(a.attname, ', ') into txt
    from pg_proc pr
    join unnest(pr.proallargtypes, pr.proargnames) with ordinality as a(typ, attname, ord) on true
   where pr.proname = 'get_branch_request_progress'
     and (a.attname ilike '%cost%' or a.attname ilike '%price%' or a.attname ilike '%total%'
          or a.attname ilike '%amount%' or a.attname ilike '%margin%' or a.attname ilike '%vendor%');
  if txt is not null then
    raise exception 'FAIL 15d the branch view exposes procurement money: %', txt;
  end if;
  raise notice 'PASS  15d a POS Manager is told what arrived, never what it cost';

  -- ======================================================================
  -- 10. A vendor's details are checked by the database, not just the form
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;

  -- TIN: fourteen digits, stored in one canonical shape.
  insert into public.vendors (name, tin) values ('ZZ Tin Digits ' || tag, '12345678901234');
  select tin into txt from public.vendors where name = 'ZZ Tin Digits ' || tag;
  if txt <> '123-456-789-01234' then
    raise exception 'FAIL 10a a plain 14-digit TIN stored as %', txt;
  end if;

  insert into public.vendors (name, tin) values ('ZZ Tin Spaced ' || tag, ' 223 456 789 01234 ');
  select tin into txt from public.vendors where name = 'ZZ Tin Spaced ' || tag;
  if txt <> '223-456-789-01234' then
    raise exception 'FAIL 10a a spaced TIN stored as %', txt;
  end if;
  raise notice 'PASS  10a a TIN is stored in one canonical shape however it was typed';

  begin
    insert into public.vendors (name, tin) values ('ZZ Tin Short ' || tag, '123456');
    raise exception 'FAIL 10b a six-digit TIN was accepted';
  exception when check_violation then null; end;

  begin
    insert into public.vendors (name, tin) values ('ZZ Tin Alpha ' || tag, 'ABC-456-789-01234');
    raise exception 'FAIL 10b a TIN with letters was accepted';
  exception when check_violation then null; end;

  begin
    insert into public.vendors (name, tin) values ('ZZ Tin Slash ' || tag, '123/456/789/01234');
    raise exception 'FAIL 10b a TIN with slashes was accepted';
  exception when check_violation then null; end;
  raise notice 'PASS  10b a short, alphabetic or punctuated TIN is refused';

  begin
    insert into public.vendors (name, tin) values ('ZZ Tin Dup ' || tag, '123-456-789-01234');
    raise exception 'FAIL 10c two vendors share a TIN';
  exception when unique_violation then
    raise notice 'PASS  10c a TIN identifies one business, and spacing cannot defeat that';
  end;

  -- Email: a real address, lowercased and trimmed.
  insert into public.vendors (name, email) values ('ZZ Mail OK ' || tag, '  Supplier@Example.COM ');
  select email into txt from public.vendors where name = 'ZZ Mail OK ' || tag;
  if txt <> 'supplier@example.com' then raise exception 'FAIL 10d email stored as %', txt; end if;

  foreach txt in array array['supplier', 'supplier@', '@example.com', 'supplier@example',
                             'supplier example@example.com'] loop
    begin
      insert into public.vendors (name, email) values ('ZZ Mail Bad ' || tag || txt, txt);
      raise exception 'FAIL 10d "%" was accepted as an email', txt;
    exception when check_violation then null; end;
  end loop;
  raise notice 'PASS  10d an email must be an address, and is stored lowercased and trimmed';

  -- Phone: a Philippine mobile number, exactly. 09 and nine more digits.
  -- F4.1 accepted any 7-15 digits, which let a landline and a 63-prefixed
  -- number through; F4.2 narrows it to the one form the business actually
  -- uses. Nothing is stripped or rewritten -- a wrong number is refused and
  -- said so, rather than quietly reshaped into a plausible one.
  insert into public.vendors (name, phone) values ('ZZ Phone A ' || tag, '09171234567');

  foreach txt in array array['+639171234567', '639171234567', '0917-123-4567',
                             '0917 123 4567', 'abc0917', '0917',
                             '0288887777', '091712345678'] loop
    begin
      insert into public.vendors (name, phone) values ('ZZ Phone Bad ' || tag || txt, txt);
      raise exception 'FAIL 10e "%" was accepted as a phone number', txt;
    exception when check_violation then null; end;
  end loop;
  raise notice 'PASS  10e a phone number is 09 followed by nine digits, and nothing else';

  -- Contact person: letters and spaces.
  insert into public.vendors (name, contact_person)
  values ('ZZ Contact OK ' || tag, '  Juan   Dela Cruz ');
  select contact_person into txt from public.vendors where name = 'ZZ Contact OK ' || tag;
  if txt <> 'Juan Dela Cruz' then raise exception 'FAIL 10f contact stored as "%"', txt; end if;

  foreach txt in array array['Juan123', 'Juan/Cruz', 'Juan.Cruz', 'Juan_Cruz', 'Juan+Cruz', 'Juan=Cruz'] loop
    begin
      insert into public.vendors (name, contact_person)
      values ('ZZ Contact Bad ' || tag || txt, txt);
      raise exception 'FAIL 10f "%" was accepted as a contact person', txt;
    exception when check_violation then null; end;
  end loop;
  raise notice 'PASS  10f a contact person is letters and spaces, collapsed and trimmed';

  -- A business name is not a person's name and keeps its own rule.
  insert into public.vendors (name) values ('ZZ 7-Eleven & Co. ' || tag);
  raise notice 'PASS  10g a business name may still contain digits, & and punctuation';
  reset role;
end $$;

rollback;
