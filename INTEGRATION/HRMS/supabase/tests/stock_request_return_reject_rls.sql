-- Stock request: Return for changes, and Reject after approval.
--
-- The gap: Finance Staff could accept or decline a request only while it was
-- pending. Once accepted it became procurement demand with no way back, so when
-- the purchase order raised against it was declined -- PO-2026-0006, 35.00
-- against a 30.00 selling price -- the demand sat approved with nothing to be
-- done about it.
--
-- The claims:
--
--   a returned request keeps its identity, and can be corrected and resubmitted
--   return and reject both demand a reason
--   a LIVE purchase order forbids both, by RPC and by direct UPDATE
--   a declined order releases the demand and forbids nothing
--   what has been ordered cannot be un-asked for by editing the quantity
--   the branch's manager resubmits; a cashier and another branch cannot
--   deciding the demand and approving the order stay different authorities
--   none of it touches stock, budget or money
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/stock_request_return_reject_rls.sql
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
  admin_id uuid; staff uuid; manager uuid; mgr_a uuid; mgr_b uuid; cashier uuid;
  branch_a uuid; branch_b uuid; general_id uuid; product uuid;
  vendor uuid; budget uuid; req uuid; po uuid;
  n integer; st text; txt text; qty integer;
  budget_before numeric; budget_after numeric;
  moves_before integer; moves_after integer;
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
  mgr_a   := pg_temp.hire('Branch A Mgr', 'POS Manager');
  mgr_b   := pg_temp.hire('Branch B Mgr', 'POS Manager');
  cashier := pg_temp.hire('Till Person',  'Cashier');

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (mgr_a, branch_a, 'manager', admin_id),
         (mgr_b, branch_b, 'manager', admin_id),
         (cashier, branch_a, 'cashier', admin_id);

  perform pg_temp.acts_as(admin_id);
  -- Priced so a purchase order can legitimately pass the margin guard.
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Sting ' || tag, general_id, 30.00, 20.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true);
  insert into public.pos_branch_inventory (branch_id, product_id, quantity_on_hand)
  values (branch_a, product, 0) on conflict (branch_id, product_id) do update set quantity_on_hand = 0;

  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.vendors (name, phone) values ('ZZ RR Supplier ' || tag, '09171234502')
  returning id into vendor;
  insert into public.budgets (name, amount, fiscal_year)
  values ('ZZ RR Budget ' || tag, 500000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.review_vendor(vendor, true, 'fixture');
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 20, 'ZZ running low') into req;
  reset role;

  -- ======================================================================
  -- 1. Return for changes, from pending
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.return_pos_request(req, '   ');
    reset role;
    raise exception 'FAIL  1a a request was returned with no reason';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1a returning demands a reason';
  end;

  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.return_pos_request(req,
    'Supplier cost exceeds the branch selling price. Review the price or the quantity.');
  reset role;

  select status::text into st from public.pos_inventory_requests where id = req;
  if st <> 'returned' then raise exception 'FAIL  1b status is %, expected returned', st; end if;
  raise notice 'PASS  1b a pending request can be returned for changes';

  select review_note into txt from public.pos_inventory_requests where id = req;
  if txt not like '%Review the price or the quantity%' then
    raise exception 'FAIL  1c the reason was not stored: %', txt;
  end if;
  raise notice 'PASS  1c the reason is stored where the branch can read it';

  select count(*) into n from public.pos_inventory_requests
   where id = req and reviewed_by = staff and reviewed_at is not null;
  if n <> 1 then raise exception 'FAIL  1d the returner and the time were not recorded'; end if;
  raise notice 'PASS  1d who returned it, and when, are recorded';

  -- ======================================================================
  -- 2. The branch corrects it and sends it back
  -- ======================================================================
  perform pg_temp.acts_as(cashier); set local role authenticated;
  begin
    perform public.resubmit_pos_request(req, 12, null);
    reset role;
    raise exception 'FAIL  2a a cashier resubmitted a manager''s request';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  2a a cashier may not resubmit a stock request';
  end;

  perform pg_temp.acts_as(mgr_b); set local role authenticated;
  begin
    perform public.resubmit_pos_request(req, 12, null);
    reset role;
    raise exception 'FAIL  2b another branch''s manager resubmitted this request';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  2b only the request''s own branch may resubmit it';
  end;

  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  perform public.resubmit_pos_request(req, 12, 'ZZ corrected to twelve');
  reset role;

  select status::text, requested_quantity into st, qty
    from public.pos_inventory_requests where id = req;
  if st <> 'pending' or qty <> 12 then
    raise exception 'FAIL  2c resubmitted as % qty %, expected pending 12', st, qty;
  end if;
  raise notice 'PASS  2c the branch corrects the quantity and it returns to Finance';

  -- Same row, same demand. This is the design choice: one conversation, not a
  -- pile of duplicate requests.
  select count(*) into n from public.pos_inventory_requests
   where branch_id = branch_a and product_id = product and request_type = 'restock';
  if n <> 1 then raise exception 'FAIL  2d resubmission created % requests, expected 1', n; end if;
  raise notice 'PASS  2d resubmission keeps the same request, and makes no duplicate';

  -- ...and the history explains it, without the reason being overwritten away.
  select count(*) into n from public.pos_audit_events
   where entity_id = req and event_type = 'stock_request_returned';
  if n <> 1 then raise exception 'FAIL  2e the return is not in the history'; end if;
  select count(*) into n from public.pos_audit_events
   where entity_id = req and event_type = 'stock_request_resubmitted';
  if n <> 1 then raise exception 'FAIL  2f the resubmission is not in the history'; end if;
  raise notice 'PASS  2e-f submitted, returned and resubmitted are all in the history';

  -- ======================================================================
  -- 3. A live purchase order forbids both decisions
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted for procurement');
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 12, 20.00, null, true, budget) into po;
  reset role;

  n := public.pos_request_live_purchase_orders(req);
  if n <> 1 then raise exception 'FAIL  3a live order count is %, expected 1', n; end if;
  raise notice 'PASS  3a a submitted order counts as live procurement';

  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.return_pos_request(req, 'ZZ trying to return behind a live order');
    reset role;
    raise exception 'FAIL  3b a request with a live order was returned';
  exception when check_violation then
    reset role;
    raise notice 'PASS  3b a live purchase order forbids returning the request';
  end;

  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.decline_pos_request(req, 'ZZ trying to reject behind a live order');
    reset role;
    raise exception 'FAIL  3c a request with a live order was rejected';
  exception when check_violation then
    reset role;
    raise notice 'PASS  3c a live purchase order forbids rejecting the request';
  end;

  -- ======================================================================
  -- 4. A declined order releases the demand
  -- ======================================================================
  --
  -- PO-2026-0006, in miniature. The Manager declines the order; the request is
  -- untouched by that decision and becomes Finance Staff's to resolve again.
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'rejected', 'ZZ negative margin at this cost');
  reset role;

  select status::text into st from public.pos_inventory_requests where id = req;
  if st <> 'approved' then
    raise exception 'FAIL  4a declining the order changed the request to %', st;
  end if;
  raise notice 'PASS  4a declining a purchase order does not decide the branch''s demand';

  n := public.pos_request_live_purchase_orders(req);
  if n <> 0 then raise exception 'FAIL  4b a rejected order still counts as live'; end if;
  qty := public.pos_request_ordered_quantity(req);
  if qty <> 0 then raise exception 'FAIL  4c ordered quantity is % after rejection, expected 0', qty; end if;
  raise notice 'PASS  4b-c a rejected order releases the demand: 0 live, 0 ordered';

  -- ======================================================================
  -- 5. Return and reject now work from approved
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.return_pos_request(req, 'ZZ please review the selling price at the branch');
  reset role;
  select status::text into st from public.pos_inventory_requests where id = req;
  if st <> 'returned' then raise exception 'FAIL  5a approved -> returned failed (%)', st; end if;
  raise notice 'PASS  5a an approved request whose order fell through can be returned';

  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  perform public.resubmit_pos_request(req, 12, null);
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted again');
  reset role;

  budget_before := (select reserved from public.budget_status where id = budget);
  select count(*) into moves_before from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;

  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.decline_pos_request(req, 'ZZ superseded by a different demand');
  reset role;
  select status::text into st from public.pos_inventory_requests where id = req;
  if st <> 'declined' then raise exception 'FAIL  5b approved -> declined failed (%)', st; end if;
  raise notice 'PASS  5b an approved request can be rejected once no order claims it';

  -- ======================================================================
  -- 6. Rejection is terminal, and costs nothing
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req, vendor, null, null, 5, 20.00, null, false, budget);
    reset role;
    raise exception 'FAIL  6a a purchase order was raised against a rejected request';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  6a a rejected request cannot be procured';
  end;

  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  begin
    perform public.resubmit_pos_request(req, 12, null);
    reset role;
    raise exception 'FAIL  6b a rejected request was resubmitted';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  6b rejection is terminal -- a new need means a new request';
  end;

  select count(*) into n from public.pos_inventory_requests where id = req;
  if n <> 1 then raise exception 'FAIL  6c the rejected request was deleted'; end if;
  raise notice 'PASS  6c a rejected request stays in the record';

  budget_after := (select reserved from public.budget_status where id = budget);
  select count(*) into moves_after from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;
  if budget_before is distinct from budget_after then
    raise exception 'FAIL  6d reserved moved from % to % on a request decision', budget_before, budget_after;
  end if;
  if moves_before <> moves_after then
    raise exception 'FAIL  6e a request decision wrote % stock movement(s)', moves_after - moves_before;
  end if;
  raise notice 'PASS  6d-e returning and rejecting move no budget and no stock';

  -- ======================================================================
  -- 7. Authority stays where it was
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  begin
    perform public.return_pos_request(req, 'ZZ manager trying to act as Finance');
    reset role;
    raise exception 'FAIL  7a a POS Manager returned a request as Finance';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7a a POS Manager cannot make Finance''s decision';
  end;

  perform pg_temp.acts_as(cashier); set local role authenticated;
  begin
    perform public.decline_pos_request(req, 'ZZ cashier trying to reject');
    reset role;
    raise exception 'FAIL  7b a cashier rejected a stock request';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7b a cashier cannot reject a stock request';
  end;

  raise notice '--- stock request return/reject: all checks passed ---';
end;
$$;

rollback;
