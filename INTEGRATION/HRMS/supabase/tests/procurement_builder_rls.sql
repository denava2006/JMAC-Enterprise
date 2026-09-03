-- F4 consolidation — building an order from what was actually asked for.
--
-- The hosted walkthrough found an order that could never be received: Finance
-- built its lines by hand from a POS product dropdown they cannot read, so
-- every line was saved with no product and no destination, and the branch's
-- Deliveries screen stayed empty. These are the claims that stop that
-- happening again.
--
--   an order exists only when somebody meant to save one
--   the product, the branch and the quantity come from the request
--   what is left to order shrinks as orders are raised and returns when they stop
--   what arrived is never un-arrived by paperwork
--   nothing stops, returns or refuses without a reason
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/procurement_builder_rls.sql
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
  req uuid; po uuid; po2 uuid; line uuid; budget uuid;
  n integer; qty integer; txt text;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';
  if admin_id is null or branch_b is null or general_id is null then
    raise exception 'fixture: need an admin, two branches and the General category';
  end if;

  staff   := pg_temp.hire('Fin Staff',    'Finance Staff');
  manager := pg_temp.hire('Fin Manager',  'Finance Manager');
  acct    := pg_temp.hire('Fin Acct',     'Accountant');
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
  values ('ZZ Builder Cola ' || tag, general_id, 85.00, 60.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true);
  insert into public.pos_branch_inventory (branch_id, product_id, quantity_on_hand)
  values (branch_a, product, 0)
  on conflict (branch_id, product_id) do update set quantity_on_hand = 0;

  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.vendors (name, phone) values ('ZZ Builder Supplier ' || tag, '09171234500')
  returning id into vendor;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.review_vendor(vendor, true, 'fixture');
  reset role;

  -- A ceiling for the orders below to be charged to. Staff draft it, the
  -- Manager puts it in force -- the F4.2 maker/checker path, unchanged.
  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.budgets (name, amount, fiscal_year)
  values ('ZZ Procurement Budget ' || tag, 50000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  -- The demand: Cavite-style branch asks for twenty, Finance accepts it.
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 20, 'ZZ running low') into req;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted for procurement');
  reset role;

  -- ======================================================================
  -- 1. The source answers for itself
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  select outstanding into qty from public.get_procurement_source('pos_restock', req);
  if qty <> 20 then raise exception 'FAIL 1a outstanding is %, expected 20', qty; end if;

  select product_id into txt from public.get_procurement_source('pos_restock', req);
  if txt is null or txt <> product::text then
    raise exception 'FAIL 1b the source did not carry its product';
  end if;

  select branch_id into txt from public.get_procurement_source('pos_restock', req);
  if txt is null or txt <> branch_a::text then
    raise exception 'FAIL 1c the source did not carry its branch';
  end if;
  raise notice 'PASS  1a-c the request answers with its own product, branch and outstanding quantity';

  -- Finance reads this without being given the POS catalogue. The whole point.
  select count(*) into n from public.pos_products;
  if n <> 0 then
    raise exception 'FAIL 1d Finance can read the POS catalogue (% rows)', n;
  end if;
  raise notice 'PASS  1d Finance never gains the enterprise catalogue to fulfil one request';
  reset role;

  perform pg_temp.acts_as(cashier); set local role authenticated;
  begin
    perform public.get_procurement_source('pos_restock', req);
    raise exception 'FAIL 1e a cashier read the procurement source';
  exception when insufficient_privilege then
    raise notice 'PASS  1e the procurement source is Finance''s to read';
  end;
  reset role;

  -- ======================================================================
  -- 2. An order exists only when somebody meant to save one
  -- ======================================================================
  select count(*) into n from public.purchase_orders;
  if n <> 0 then raise exception 'FAIL 2a an order existed before anything was saved'; end if;
  raise notice 'PASS  2a opening a builder writes nothing';

  perform pg_temp.acts_as(staff); set local role authenticated;
  -- A failed build leaves nothing behind: no unit cost, no order.
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req, vendor, null, null, 20, null, null, false, budget);
    raise exception 'FAIL 2b an order was built with no unit cost';
  exception when check_violation then null; end;

  select count(*) into n from public.purchase_orders;
  if n <> 0 then raise exception 'FAIL 2b a failed build left % order(s) behind', n; end if;
  raise notice 'PASS  2b a build that fails leaves no half-made order';
  reset role;

  -- ======================================================================
  -- 3. The order inherits what was asked for
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, current_date + 7, 'first tranche', 12, 55.00, null, false, budget)
  into po;

  select count(*) into n from public.purchase_order_items where purchase_order_id = po;
  if n <> 1 then raise exception 'FAIL 3a the order has % lines, expected 1', n; end if;

  select id into line from public.purchase_order_items where purchase_order_id = po;
  select pos_product_id into txt from public.purchase_order_items where id = line;
  if txt is null then
    raise exception 'FAIL 3a the line has no POS product -- this is the defect that broke receiving';
  end if;
  if txt <> product::text then raise exception 'FAIL 3a the line names the wrong product'; end if;

  select destination_branch_id into txt from public.purchase_order_items where id = line;
  if txt is null or txt <> branch_a::text then
    raise exception 'FAIL 3b the line has no destination branch';
  end if;

  select quantity_ordered into qty from public.purchase_order_items where id = line;
  if qty <> 12 then raise exception 'FAIL 3c the line ordered %, expected 12', qty; end if;

  select description into txt from public.purchase_order_items where id = line;
  if txt is null or txt = '' then raise exception 'FAIL 3d the line has no description'; end if;
  raise notice 'PASS  3a-d product, branch, quantity and description all come from the request';

  -- And the source is linked, not copied.
  select count(*) into n from public.purchase_order_sources
   where purchase_order_id = po and pos_inventory_request_id = req;
  if n <> 1 then raise exception 'FAIL 3e the order was not linked to its demand'; end if;
  raise notice 'PASS  3e the order records the demand that caused it';
  reset role;

  -- ======================================================================
  -- 4. What is left to order shrinks, and comes back
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  select outstanding into qty from public.get_procurement_source('pos_restock', req);
  if qty <> 8 then raise exception 'FAIL 4a outstanding is % after ordering 12 of 20', qty; end if;
  raise notice 'PASS  4a ordering 12 of 20 leaves 8 outstanding';

  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req, vendor, null, null, 9, 55.00, null, false, budget);
    raise exception 'FAIL 4b a second order exceeded the request';
  exception when check_violation then
    raise notice 'PASS  4b an order cannot exceed what the branch asked for';
  end;

  -- With no quantity given, the builder defaults to what is left.
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, null, 55.00, null, false, budget) into po2;
  select quantity_ordered into qty from public.purchase_order_items where purchase_order_id = po2;
  if qty <> 8 then raise exception 'FAIL 4c the second order defaulted to %, expected 8', qty; end if;
  raise notice 'PASS  4c a new order defaults to the outstanding quantity, not to 1';

  -- Discarding the draft hands the demand back.
  perform public.discard_purchase_order_draft(po2, 'supplier could not quote');
  select outstanding into qty from public.get_procurement_source('pos_restock', req);
  if qty <> 8 then raise exception 'FAIL 4d discarding did not return the demand (outstanding %)', qty; end if;
  raise notice 'PASS  4d a discarded draft returns its quantity to the outstanding demand';

  begin
    perform public.discard_purchase_order_draft(po, '   ');
    raise exception 'FAIL 4e a draft was discarded with a blank reason';
  exception when check_violation then
    raise notice 'PASS  4e discarding a draft takes a reason, and whitespace is not one';
  end;
  reset role;

  -- ======================================================================
  -- 5. Nothing stops, returns or refuses without a reason
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_purchase_order(po, 'pending_approval');
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_purchase_order(po, 'returned', null);
    raise exception 'FAIL 5a an order was returned with no reason';
  exception when check_violation then null; end;
  begin
    perform public.transition_purchase_order(po, 'rejected', '  ');
    raise exception 'FAIL 5b an order was rejected with a blank reason';
  exception when check_violation then null; end;
  raise notice 'PASS  5a-b returning and rejecting an order both take a real reason';

  -- Approving does not: what an approval means is answered by the approval.
  perform public.transition_purchase_order(po, 'approved');
  raise notice 'PASS  5c approving needs no justification, and is not asked for one';
  reset role;

  -- ======================================================================
  -- 6. The branch can now actually see the delivery
  -- ======================================================================
  --
  -- This is the end of the chain the hosted test never reached.
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select count(*) into n from public.get_branch_deliveries(branch_a);
  if n <> 1 then
    raise exception 'FAIL 6a the destination branch sees % deliveries, expected 1', n;
  end if;
  select quantity_outstanding into qty from public.get_branch_deliveries(branch_a);
  if qty <> 12 then raise exception 'FAIL 6a outstanding shows %, expected 12', qty; end if;
  raise notice 'PASS  6a an approved POS-sourced order reaches the requesting branch';

  select coalesce(sum(quantity_on_hand), 0) into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  if qty <> 0 then raise exception 'FAIL 6b approval moved stock (% on hand)', qty; end if;
  raise notice 'PASS  6b approving an order still moves no stock';
  reset role;

  perform pg_temp.acts_as(mgr_b); set local role authenticated;
  select count(*) into n from public.get_branch_deliveries(branch_a);
  if n <> 0 then raise exception 'FAIL 6c another branch''s manager saw the delivery'; end if;
  reset role;
  perform pg_temp.acts_as(cashier); set local role authenticated;
  select count(*) into n from public.get_branch_deliveries(branch_a);
  if n <> 0 then raise exception 'FAIL 6c a cashier saw the delivery queue'; end if;
  raise notice 'PASS  6c deliveries belong to the destination branch''s manager alone';
  reset role;

  -- ======================================================================
  -- 7. Stopping the rest never un-receives what arrived
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  perform public.receive_procurement_stock(line, 6, 'DR-9001', gen_random_uuid());
  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  if qty <> 6 then raise exception 'FAIL 7a receiving 6 left % on hand', qty; end if;
  reset role;

  -- An ordinary cancellation would claim those six never arrived.
  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_purchase_order(po, 'cancelled', 'changed our mind');
    raise exception 'FAIL 7b a partly delivered order was cancelled outright';
  exception when check_violation then
    raise notice 'PASS  7b an order that has taken delivery cannot simply be cancelled';
  end;

  begin
    perform public.cancel_purchase_order_remainder(po, '');
    raise exception 'FAIL 7c the remainder was stopped with no reason';
  exception when check_violation then null; end;

  perform public.cancel_purchase_order_remainder(po, 'supplier discontinued the line');
  raise notice 'PASS  7c stopping the remainder takes a reason';
  reset role;

  select quantity_cancelled into qty from public.purchase_order_items where id = line;
  if qty <> 6 then raise exception 'FAIL 7d cancelled %, expected 6 (12 ordered - 6 received)', qty; end if;

  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  if qty <> 6 then raise exception 'FAIL 7d stopping the remainder changed stock to %', qty; end if;
  raise notice 'PASS  7d ordered 12, received 6, stopped 6 -- and the 6 on the shelf stay there';

  select status into txt from public.purchase_orders where id = po;
  if txt <> 'closed' then raise exception 'FAIL 7e the order is % after stopping the rest', txt; end if;
  raise notice 'PASS  7e nothing outstanding means the order is finished';

  -- And the stopped quantity is not receivable afterwards.
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  begin
    perform public.receive_procurement_stock(line, 1, 'DR-9002', gen_random_uuid());
    raise exception 'FAIL 7f stopped quantity was received anyway';
  exception when check_violation then
    raise notice 'PASS  7f quantity the company stopped waiting for cannot arrive';
  end;
  reset role;

  -- ======================================================================
  -- 8. A general purchase is a different shape, and moves no stock
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'finance_request', gen_random_uuid(), vendor, null, null, null, null,
      '[{"description":"bond paper","quantity":5,"unit_cost":250}]'::jsonb, false);
    raise exception 'FAIL 8a an order was built from a request that does not exist';
  exception when no_data_found then
    raise notice 'PASS  8a a general order needs a real approved request behind it';
  end;
  reset role;

  -- ======================================================================
  -- 9. Only the maker builds
  -- ======================================================================
  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req, vendor, null, null, 1, 10.00, null, false, budget);
    raise exception 'FAIL 9a the Finance Manager built a purchase order';
  exception when insufficient_privilege then
    raise notice 'PASS  9a building an order is the maker''s work';
  end;
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req, vendor, null, null, 1, 10.00, null, false, budget);
    raise exception 'FAIL 9b the Accountant built a purchase order';
  exception when insufficient_privilege then null; end;
  reset role;

  perform pg_temp.acts_as(admin_id); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req, vendor, null, null, 1, 10.00, null, false, budget);
    raise exception 'FAIL 9c the Administrator built a purchase order';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS  9b-c neither the Accountant nor the Administrator prepares procurement';
  reset role;

  -- ======================================================================
  -- 10. Withdrawing a branch request takes a reason
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 3, 'ZZ another') into req;
  begin
    perform public.cancel_pos_request(req, '   ');
    raise exception 'FAIL 10a a request was withdrawn with a blank reason';
  exception when check_violation then null; end;
  perform public.cancel_pos_request(req, 'ordered from the other branch instead');
  reset role;

  -- Read as the suite owner: pos_inventory_requests is reached through RPCs,
  -- not selected from directly, so a branch manager cannot check their own row.
  select status into txt from public.pos_inventory_requests where id = req;
  if txt <> 'cancelled' then raise exception 'FAIL 10a withdrawal left the request %', txt; end if;
  raise notice 'PASS  10a withdrawing a branch request takes a real reason';

  -- ======================================================================
  -- 11. Where a purchase is delivered, decided when it was asked for
  -- ======================================================================
  --
  -- Finance was previously left to work out where a requester works, at
  -- purchase-order time, from nothing. The branch is now captured when the
  -- request is raised -- and a later transfer must not redirect an order that
  -- was already placed.
  declare
    applicant_id uuid; posting_id uuid; app_id uuid;
    worker uuid; worker_emp uuid; dept_id uuid; pos_id uuid;
    fin_req uuid; gen_po uuid;
  begin
    select p.id, p.department_id into pos_id, dept_id
      from public.positions p where lower(p.title) = 'cashier' limit 1;

    insert into public.applicants (first_name, last_name, email)
    values ('ZZ', 'Deployed ' || tag, 'zz.dep.' || tag || '@jmac-test.invalid')
    returning id into applicant_id;

    insert into public.job_postings (department_id, position_id, description)
    values (dept_id, pos_id, 'ZZ fixture posting')
    returning id into posting_id;

    insert into public.applications (applicant_id, job_posting_id, status)
    values (applicant_id, posting_id, 'deployed')
    returning id into app_id;

    insert into public.employees (first_name, last_name, email, department_id, position_id,
                                  hire_date, employment_status, application_id)
    values ('ZZ', 'Deployed ' || tag, 'zz.dep.' || tag || '@jmac-test.invalid',
            dept_id, pos_id, current_date, 'active', app_id)
    returning id into worker_emp;

    insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                            email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                            created_at, updated_at, confirmation_token, email_change,
                            email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
            'authenticated', 'zz.dep.' || tag || '@jmac-test.invalid',
            crypt('x', gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
    returning id into worker;
    -- Linking a profile to an employee is the Administrator's, as everywhere else.
    perform pg_temp.acts_as(admin_id);
    update public.profiles set employee_id = worker_emp, status = 'active' where id = worker;

    -- Deployed to branch A. Deployment is the authoritative record of where
    -- somebody works, which is the chain POS onboarding already trusts.
    insert into public.deployment_records (application_id, deployment_date, branch_id, deployed_by)
    values (app_id, current_date, branch_a, admin_id);

    perform pg_temp.acts_as(worker); set local role authenticated;
    insert into public.finance_requests (type, title, justification, requester_id, amount)
    values ('purchase', 'ZZ Office materials ' || tag, 'ZZ printer ink', worker, 1500)
    returning id into fin_req;
    reset role;

    select delivery_branch_id into txt from public.finance_requests where id = fin_req;
    if txt is null or txt <> branch_a::text then
      raise exception 'FAIL 11a the request did not capture where the requester works';
    end if;
    raise notice 'PASS  11a a request records the branch its requester was deployed to';

    -- They transfer. The request already placed does not follow them.
    update public.deployment_records set branch_id = branch_b where application_id = app_id;
    select delivery_branch_id into txt from public.finance_requests where id = fin_req;
    if txt <> branch_a::text then
      raise exception 'FAIL 11b a transfer redirected an existing request to %', txt;
    end if;
    raise notice 'PASS  11b transferring afterwards does not redirect a request already raised';

    -- Push it through to approved so it can be procured.
    perform pg_temp.acts_as(worker); set local role authenticated;
    perform public.transition_finance_request(fin_req, 'pending_validation');
    reset role;
    perform pg_temp.acts_as(staff); set local role authenticated;
    perform public.transition_finance_request(fin_req, 'pending_approval');
    reset role;
    perform pg_temp.acts_as(manager); set local role authenticated;
    perform public.transition_finance_request(fin_req, 'approved');
    reset role;

    -- A general purchase: Finance decides what is actually bought.
    perform pg_temp.acts_as(staff); set local role authenticated;
    select public.create_purchase_order_from_source(
      'finance_request', fin_req, vendor, null, 'office materials', null, null,
      '[{"description":"ZZ bond paper","quantity":5,"unit_cost":250},
        {"description":"ZZ ink cartridge","quantity":2,"unit_cost":900}]'::jsonb,
      false) into gen_po;
    reset role;

    select count(*) into n from public.purchase_order_items where purchase_order_id = gen_po;
    if n <> 2 then raise exception 'FAIL 11c the general order has % lines, expected 2', n; end if;

    -- Delivered to where they worked when they asked.
    select delivery_branch_id into txt from public.purchase_orders where id = gen_po;
    if txt is null or txt <> branch_a::text then
      raise exception 'FAIL 11c the order does not inherit the request''s delivery branch';
    end if;
    raise notice 'PASS  11c a general order is delivered where the request was raised';

    -- And it can never become POS stock. Delivery location is not an inventory
    -- destination: the box goes to branch A, the till''s stock does not move.
    select count(*) into n from public.purchase_order_items
     where purchase_order_id = gen_po
       and (pos_product_id is not null or destination_branch_id is not null);
    if n <> 0 then
      raise exception 'FAIL 11d a general purchase line carries a POS inventory destination';
    end if;
    raise notice 'PASS  11d office materials have a delivery address, not an inventory destination';

    -- Which the receiving bridge agrees with, rather than merely being unlikely.
    select id into line from public.purchase_order_items where purchase_order_id = gen_po limit 1;
    perform pg_temp.acts_as(mgr_a); set local role authenticated;
    begin
      perform public.receive_procurement_stock(line, 1, 'DR-9003', gen_random_uuid());
      raise exception 'FAIL 11e a non-stock line was received into POS inventory';
    exception when check_violation then
      raise notice 'PASS  11e a line with no POS product cannot move stock at all';
    end;
    reset role;

    -- A new request now goes to their new branch.
    perform pg_temp.acts_as(worker); set local role authenticated;
    insert into public.finance_requests (type, title, justification, requester_id, amount)
    values ('purchase', 'ZZ Later request ' || tag, 'ZZ after transfer', worker, 100)
    returning id into fin_req;
    reset role;
    select delivery_branch_id into txt from public.finance_requests where id = fin_req;
    if txt <> branch_b::text then
      raise exception 'FAIL 11f a request raised after the transfer went to %', txt;
    end if;
    raise notice 'PASS  11f a request raised after a transfer goes to the new branch';
  end;

end $$;

rollback;
