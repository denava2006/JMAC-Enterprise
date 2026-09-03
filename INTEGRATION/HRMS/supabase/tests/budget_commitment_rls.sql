-- What a budget is holding, and when it starts holding it.
--
-- Before this, a POS restock order had no relationship to a budget at all: a
-- branch could be sent twenty crates against a ceiling that knew nothing about
-- it. These are the claims that fix carries.
--
--   nothing is reserved until a Finance Manager approves the order
--   a general purchase reserves once, at the request, and never twice
--   stopping units releases their money; receiving them does not spend it
--   the ceiling never moves
--   two approvals cannot spend the same headroom
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/budget_commitment_rls.sql
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
  admin_id uuid; staff uuid; manager uuid; worker uuid; mgr_a uuid;
  branch_a uuid; general_id uuid; product uuid; vendor uuid; cat_id uuid;
  budget uuid; small uuid; req uuid; po uuid; po_b uuid; line uuid; fin_req uuid;
  ceiling numeric; reserved numeric; spent numeric; available numeric;
  n integer; qty integer; txt text;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';

  staff   := pg_temp.hire('Fin Staff',    'Finance Staff');
  manager := pg_temp.hire('Fin Manager',  'Finance Manager');
  worker  := pg_temp.hire('Requester',    'Cashier');
  mgr_a   := pg_temp.hire('Branch A Mgr', 'POS Manager');

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (mgr_a, branch_a, 'manager', admin_id);

  perform pg_temp.acts_as(admin_id);
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Commit Cola ' || tag, general_id, 85.00, 60.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true);
  insert into public.pos_branch_inventory (branch_id, product_id, quantity_on_hand)
  values (branch_a, product, 0)
  on conflict (branch_id, product_id) do update set quantity_on_hand = 0;

  select id into cat_id from public.finance_categories where kind='expense' and is_active limit 1;

  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.vendors (name, phone) values ('ZZ Commit Supplier ' || tag, '09171234511')
  returning id into vendor;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Commit Budget ' || tag, cat_id, 50000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.review_vendor(vendor, true, 'fixture');
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  -- ======================================================================
  -- 1. The ceiling starts whole
  -- ======================================================================
  select bs.amount, bs.reserved, bs.spent, bs.remaining into ceiling, reserved, spent, available
    from public.budget_status bs where bs.id = budget;
  if ceiling <> 50000 then raise exception 'FAIL 1a ceiling is %', ceiling; end if;
  if reserved <> 0 then raise exception 'FAIL 1a reserved is % before anything', reserved; end if;
  if available <> 50000 then raise exception 'FAIL 1a available is %', available; end if;
  raise notice 'PASS  1a a new ceiling holds nothing: 50000 approved, 0 reserved, 50000 available';

  -- ======================================================================
  -- 2. Nothing commits before the Manager approves
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 20, 'ZZ running low') into req;
  reset role;

  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 0 then raise exception 'FAIL 2a a stock request reserved %', reserved; end if;
  raise notice 'PASS  2a asking for stock reserves nothing -- a branch names crates, not pesos';

  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted for procurement');
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, current_date + 7, null, 20, 65.00, null, false, budget) into po;
  reset role;

  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 0 then raise exception 'FAIL 2b a draft order reserved %', reserved; end if;
  raise notice 'PASS  2b a drafted order reserves nothing';

  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_purchase_order(po, 'pending_approval');
  reset role;

  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 0 then raise exception 'FAIL 2c a submitted order reserved %', reserved; end if;
  raise notice 'PASS  2c submitting for approval reserves nothing either';

  -- ======================================================================
  -- 3. Approval is what commits the money
  -- ======================================================================
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'approved');
  reset role;

  select bs.amount, bs.reserved, bs.spent, bs.remaining into ceiling, reserved, spent, available
    from public.budget_status bs where bs.id = budget;
  if reserved <> 1300 then raise exception 'FAIL 3a reserved is %, expected 1300 (20 x 65)', reserved; end if;
  if ceiling <> 50000 then raise exception 'FAIL 3a the ceiling moved to %', ceiling; end if;
  if spent <> 0 then raise exception 'FAIL 3a spent is %, and nothing has been paid', spent; end if;
  if available <> 48700 then raise exception 'FAIL 3a available is %, expected 48700', available; end if;
  raise notice 'PASS  3a approving commits 1300: ceiling 50000 unchanged, spent 0, available 48700';

  -- Derived, not accumulated -- so a retry cannot add it twice.
  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_purchase_order(po, 'approved');
  exception when others then null; end;
  reset role;
  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 1300 then raise exception 'FAIL 3b a repeated approval made reserved %', reserved; end if;
  raise notice 'PASS  3b approving again does not reserve a second time';

  -- ======================================================================
  -- 4. Receiving moves stock, not money
  -- ======================================================================
  select id into line from public.purchase_order_items where purchase_order_id = po;

  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  perform public.receive_procurement_stock(line, 6, 'DR-8001', gen_random_uuid());
  reset role;

  select bs.reserved, bs.spent into reserved, spent from public.budget_status bs where bs.id = budget;
  if reserved <> 1300 then raise exception 'FAIL 4a a partial receipt changed reserved to %', reserved; end if;
  if spent <> 0 then raise exception 'FAIL 4a a partial receipt spent %', spent; end if;
  raise notice 'PASS  4a receiving 6 of 20 moves stock and leaves the money committed';

  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  perform public.receive_procurement_stock(line, 14, 'DR-8002', gen_random_uuid());
  reset role;

  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  if qty <> 20 then raise exception 'FAIL 4b stock on hand is %, expected 20', qty; end if;

  select bs.reserved, bs.spent into reserved, spent from public.budget_status bs where bs.id = budget;
  if reserved <> 1300 then raise exception 'FAIL 4b full receipt changed reserved to %', reserved; end if;
  if spent <> 0 then raise exception 'FAIL 4b full receipt spent %', spent; end if;
  raise notice 'PASS  4b receiving all 20 still spends nothing -- received is not paid';

  -- ======================================================================
  -- 5. Fulfillment is visible without closing the order
  -- ======================================================================
  select status, quantity_received, quantity_outstanding into txt, n, qty
    from public.purchase_order_status where id = po;
  if txt <> 'approved' then raise exception 'FAIL 5a the order closed itself (%)', txt; end if;
  if n <> 20 then raise exception 'FAIL 5a received reads %', n; end if;
  if qty <> 0 then raise exception 'FAIL 5a outstanding reads %, expected 0', qty; end if;
  raise notice 'PASS  5a a fully received order stays approved, and reports 20 received, 0 outstanding';

  -- ======================================================================
  -- 6. Closing files the paperwork; it does not pay
  -- ======================================================================
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'closed');
  reset role;

  select bs.reserved, bs.spent into reserved, spent from public.budget_status bs where bs.id = budget;
  if reserved <> 1300 then raise exception 'FAIL 6a closing changed reserved to %', reserved; end if;
  if spent <> 0 then raise exception 'FAIL 6a closing spent %', spent; end if;
  raise notice 'PASS  6a a closed order keeps its money committed, and spends none of it';

  -- ======================================================================
  -- 7. A general purchase reserves once, at the request
  -- ======================================================================
  perform pg_temp.acts_as(worker); set local role authenticated;
  insert into public.finance_requests (type, title, justification, requester_id, amount, budget_id)
  values ('purchase', 'ZZ Office chairs ' || tag, 'ZZ seating', worker, 5000, budget)
  returning id into fin_req;
  perform public.transition_finance_request(fin_req, 'pending_validation');
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_finance_request(fin_req, 'pending_approval');
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_finance_request(fin_req, 'approved');
  reset role;

  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 6300 then raise exception 'FAIL 7a reserved is %, expected 6300', reserved; end if;
  raise notice 'PASS  7a an approved request adds its own 5000: reserved 6300';

  -- The order raised from it must not reserve the same money again.
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'finance_request', fin_req, vendor, null, null, null, null,
      '[{"description":"ZZ chairs","quantity":10,"unit_cost":500}]'::jsonb, false, budget);
    raise exception 'FAIL 7b an order from a request took a budget of its own';
  exception when check_violation then
    raise notice 'PASS  7b an order from a request is refused a second budget outright';
  end;

  select public.create_purchase_order_from_source(
    'finance_request', fin_req, vendor, null, null, null, null,
    '[{"description":"ZZ chairs","quantity":10,"unit_cost":500}]'::jsonb, false, null) into po_b;
  perform public.transition_purchase_order(po_b, 'pending_approval');
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po_b, 'approved');
  reset role;

  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 6300 then
    raise exception 'FAIL 7c approving the order double-reserved: % (expected 6300)', reserved;
  end if;
  raise notice 'PASS  7c approving that order reserves nothing further -- 5000 is committed once';

  -- ======================================================================
  -- 8. Stopping units releases their money; the received ones keep theirs
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 20, 'ZZ second run') into req;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 20, 65.00, null, true, budget) into po;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'approved');
  reset role;

  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 7600 then raise exception 'FAIL 8a reserved is %, expected 7600', reserved; end if;

  select id into line from public.purchase_order_items where purchase_order_id = po;
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  perform public.receive_procurement_stock(line, 6, 'DR-8003', gen_random_uuid());
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.cancel_purchase_order_remainder(po, 'supplier discontinued the line');
  reset role;

  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  -- 6300 from before, plus 6 x 65 = 390 for the units actually retained.
  if reserved <> 6690 then
    raise exception 'FAIL 8b reserved is %, expected 6690 (6300 + 6 x 65)', reserved;
  end if;
  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  if qty <> 26 then raise exception 'FAIL 8b stock is %, expected 26', qty; end if;
  raise notice 'PASS  8b stopping 14 releases 910 and keeps 390 -- the 6 that arrived stay on the shelf';

  -- ======================================================================
  -- 9. Cancelling an untouched order releases all of it
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 4, 'ZZ third run') into req;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 4, 65.00, null, true, budget) into po;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'approved');
  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 6950 then raise exception 'FAIL 9a reserved is %, expected 6950', reserved; end if;

  perform public.transition_purchase_order(po, 'cancelled', 'branch overstocked after all');
  reset role;

  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 6690 then
    raise exception 'FAIL 9a cancelling left reserved at %, expected 6690', reserved;
  end if;
  raise notice 'PASS  9a cancelling an order releases every peso it was holding';

  -- ======================================================================
  -- 10. A budget cannot be overspent
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Tiny Budget ' || tag, cat_id, 1000, extract(year from current_date)::integer)
  returning id into small;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.review_budget(small, true, 'fixture');
  reset role;

  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 20, 'ZZ too big') into req;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 20, 65.00, null, true, small) into po;
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_purchase_order(po, 'approved');
    raise exception 'FAIL 10a a 1300 order was approved against a 1000 ceiling';
  exception when check_violation then
    if sqlerrm not like '%enough available funds%' then raise; end if;
    raise notice 'PASS  10a approval is refused when the budget cannot cover the order';
  end;
  reset role;

  select status into txt from public.purchase_orders where id = po;
  if txt <> 'pending_approval' then
    raise exception 'FAIL 10b the refused order moved to %', txt;
  end if;
  select bs.reserved into reserved from public.budget_status bs where bs.id = small;
  if reserved <> 0 then
    raise exception 'FAIL 10b the refused approval still reserved %', reserved;
  end if;
  raise notice 'PASS  10b a refused approval reserves nothing and leaves the status alone';

  -- ======================================================================
  -- 11. A POS order cannot reach approval with no funding at all
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 2, 'ZZ unfunded') into req;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 2, 65.00, null, false, null) into po;
  begin
    perform public.transition_purchase_order(po, 'pending_approval');
    raise exception 'FAIL 11a an unfunded POS order was submitted';
  exception when check_violation then
    raise notice 'PASS  11a a POS order names its budget before it can be submitted';
  end;
  reset role;

  -- ======================================================================
  -- 12. The ceiling never moved through any of it
  -- ======================================================================
  select bs.amount, bs.spent into ceiling, spent from public.budget_status bs where bs.id = budget;
  if ceiling <> 50000 then raise exception 'FAIL 12a the ceiling is now %', ceiling; end if;
  if spent <> 0 then raise exception 'FAIL 12a spent is %, with no payment phase built', spent; end if;
  raise notice 'PASS  12a after approvals, receipts, stops, cancellations and a close: ceiling 50000, spent 0';

  -- ======================================================================
  -- 13. Two approvals cannot spend the same headroom
  -- ======================================================================
  --
  -- Structural, and honest about why. Genuinely proving this needs two
  -- concurrent sessions racing the same budget row, which a single-transaction
  -- suite cannot stage. What it can do is hold the mechanism in place: the
  -- check takes a row lock on the budget, so a second approval blocks until
  -- the first has committed and then recomputes against the new figure. Delete
  -- the lock and both would read the same stale headroom and both would pass.
  select prosrc into txt from pg_proc where proname = 'guard_purchase_order_budget';
  if txt is null then raise exception 'FAIL 13a the budget guard is gone'; end if;
  if txt !~* 'for update' then
    raise exception 'FAIL 13a the budget check no longer locks the budget row';
  end if;
  if position('for update' in lower(txt)) > position('budget_status' in lower(txt)) then
    raise exception 'FAIL 13a the lock is taken after the available figure is read';
  end if;
  raise notice 'PASS  13a the available figure is read under a row lock, not before one';
end $$;

rollback;
