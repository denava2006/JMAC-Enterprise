-- Procurement margin protection — database contract test.
--
-- The business gap: Finance types a supplier unit cost by hand, and nothing
-- compared it with what the destination branch actually charges. A product
-- selling for 30.00 at Cavite could be bought at 35.00, silently.
--
-- The claims:
--
--   the price used is the DESTINATION branch's, never another branch's
--   VAT is not revenue -- the basis is the pre-VAT line price, not the customer total
--   cost below price submits, cost equal to price submits with zero margin
--   cost above price cannot be submitted, by the RPC or by a direct UPDATE
--   no price, or a zero price, is a refusal and not a comparison against 0.00
--   a draft may still be saved -- a draft is not a commitment
--   the price is re-checked at APPROVAL, because it may have moved since
--   validating a margin moves no stock and reserves no money
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/procurement_margin_rls.sql
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
  admin_id uuid; staff uuid; manager uuid; mgr_a uuid;
  branch_a uuid; branch_b uuid; general_id uuid;
  product uuid; unpriced uuid; freebie uuid;
  vendor uuid; budget uuid;
  req uuid; req_unpriced uuid; req_free uuid;
  po uuid; n integer; price numeric; snap numeric; st text;
  qty_before integer; qty_after integer; moves_before integer; moves_after integer;
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

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (mgr_a, branch_a, 'manager', admin_id);

  perform pg_temp.acts_as(admin_id);

  -- The brief's product. Enterprise default 80.00, but branch A overrides to
  -- 30.00 -- so anything reading the default instead of the override would see
  -- a price that makes a 35.00 cost look fine.
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Margin Cola ' || tag, general_id, 80.00, 20.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available, selling_price_override)
  values (branch_a, product, true, 30.00);
  -- Branch B carries the same product far dearer. It must never be consulted.
  insert into public.pos_branch_products (branch_id, product_id, is_available, selling_price_override)
  values (branch_b, product, true, 500.00);

  -- Carried for now, so a request can legitimately be raised for it. Branch A
  -- stops carrying it further down, between the request and the order, which is
  -- how a POS-sourced line comes to have no branch price in real life.
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Unpriced ' || tag, general_id, 40.00, 10.00, 'active') returning id into unpriced;
  insert into public.pos_branch_products (branch_id, product_id, is_available, selling_price_override)
  values (branch_a, unpriced, true, 40.00);

  -- Carried, but at zero. Must refuse rather than compare a cost against 0.00.
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Zero Priced ' || tag, general_id, 0, 0, 'active') returning id into freebie;
  insert into public.pos_branch_products (branch_id, product_id, is_available, selling_price_override)
  values (branch_a, freebie, true, 0);

  -- VAT as this system actually models it: a branch fee of type percent,
  -- applied on top of the line subtotal at checkout. 30.00 + 12% = 33.60 to the
  -- customer; 30.00 is what JMAC earns on the product.
  insert into public.branch_pos_settings (branch_id, fees)
  values (branch_a, '[{"id":"vat","name":"VAT","type":"percent","value":12,"enabled":true}]'::jsonb)
  on conflict (branch_id) do update
    set fees = '[{"id":"vat","name":"VAT","type":"percent","value":12,"enabled":true}]'::jsonb;

  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.vendors (name, phone) values ('ZZ Margin Supplier ' || tag, '09171234501')
  returning id into vendor;
  insert into public.budgets (name, amount, fiscal_year)
  values ('ZZ Margin Budget ' || tag, 500000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.review_vendor(vendor, true, 'fixture');
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product,  20, 'ZZ running low') into req;
  select public.create_pos_stock_request(branch_a, unpriced, 10, 'ZZ never priced') into req_unpriced;
  select public.create_pos_stock_request(branch_a, freebie,  10, 'ZZ zero priced') into req_free;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted for procurement');
  perform public.approve_pos_request(req_unpriced, 'Accepted for procurement');
  perform public.approve_pos_request(req_free, 'Accepted for procurement');
  reset role;

  -- The branch drops it. The approved request still names the product, and now
  -- there is no price at that branch to judge a purchase against.
  perform pg_temp.acts_as(admin_id);
  delete from public.pos_branch_inventory where branch_id = branch_a and product_id = unpriced;
  delete from public.pos_branch_products  where branch_id = branch_a and product_id = unpriced;

  -- ======================================================================
  -- 1. The price the guard uses is the destination branch's
  -- ======================================================================
  price := public.pos_branch_selling_price(branch_a, product);
  if price is distinct from 30.00 then
    raise exception 'FAIL  1a branch A price is %, expected 30.00 (the override, not the 80.00 default)', price;
  end if;
  raise notice 'PASS  1a the branch override wins over the enterprise default';

  price := public.pos_branch_selling_price(branch_b, product);
  if price is distinct from 500.00 then
    raise exception 'FAIL  1b branch B price is %, expected 500.00', price;
  end if;
  raise notice 'PASS  1b a different branch has a different price, and they do not mix';

  price := public.pos_branch_selling_price(branch_a, unpriced);
  if price is not null then
    raise exception 'FAIL  1c a product the branch does not carry returned %, expected null', price;
  end if;
  raise notice 'PASS  1c no row means no price, not the enterprise default';

  -- ======================================================================
  -- 2. The builder is told the price, from the same function
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  select branch_selling_price into price from public.get_procurement_source('pos_restock', req);
  if price is distinct from 30.00 then
    raise exception 'FAIL  2a the builder was told %, expected 30.00', price;
  end if;
  raise notice 'PASS  2a the builder reads the destination branch price server-side';
  reset role;

  -- ======================================================================
  -- 3. Cost below the price submits
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 5, 20.00, null, true, budget) into po;
  reset role;

  select status::text into st from public.purchase_orders where id = po;
  if st <> 'pending_approval' then
    raise exception 'FAIL  3a a 20.00 cost against a 30.00 price did not submit (status %)', st;
  end if;
  raise notice 'PASS  3a cost 20.00 against price 30.00 submits';

  select selling_price_snapshot into snap from public.purchase_order_items where purchase_order_id = po;
  if snap is distinct from 30.00 then
    raise exception 'FAIL  3b the snapshot is %, expected 30.00', snap;
  end if;
  raise notice 'PASS  3b submission records the price it was judged against';

  -- ======================================================================
  -- 4. Cost EQUAL to the price submits -- zero margin is allowed
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 5, 30.00, null, true, budget) into po;
  reset role;
  select status::text into st from public.purchase_orders where id = po;
  if st <> 'pending_approval' then
    raise exception 'FAIL  4a a zero-margin order was refused (status %)', st;
  end if;
  raise notice 'PASS  4a zero margin is a warning on the screen, not a refusal on the server';

  -- ======================================================================
  -- 5. Cost ABOVE the price cannot be submitted
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req, vendor, null, null, 5, 35.00, null, true, budget);
    reset role;
    raise exception 'FAIL  5a a 35.00 cost against a 30.00 price was submitted';
  exception when check_violation then
    reset role;
    raise notice 'PASS  5a cost 35.00 against price 30.00 is refused at submission';
  end;

  -- And it left nothing behind: the whole build is one transaction.
  select count(*) into n
    from public.purchase_orders o
    join public.purchase_order_items i on i.purchase_order_id = o.id
   where i.pos_product_id = product and o.status = 'pending_approval' and i.unit_cost = 35.00;
  if n <> 0 then
    raise exception 'FAIL  5b a refused submission left % submitted order(s) behind', n;
  end if;
  raise notice 'PASS  5b a refused submission leaves no order behind';

  -- ======================================================================
  -- 6. VAT is not revenue
  -- ======================================================================
  --
  -- The customer pays 33.60 for this product. A cost of 32.00 looks fine
  -- against that number and is a 2.00 loss against the real one.
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req, vendor, null, null, 5, 32.00, null, true, budget);
    reset role;
    raise exception 'FAIL  6a a 32.00 cost passed against a VAT-inclusive 33.60';
  exception when check_violation then
    reset role;
    raise notice 'PASS  6a the margin basis is the pre-VAT 30.00, not the 33.60 the customer pays';
  end;

  -- ======================================================================
  -- 7. No price, and a zero price, are refusals
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req_unpriced, vendor, null, null, 5, 1.00, null, true, budget);
    reset role;
    raise exception 'FAIL  7a an unpriced product was procured';
  exception when check_violation then
    reset role;
    raise notice 'PASS  7a a branch with no price for the product refuses procurement';
  end;

  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req_free, vendor, null, null, 5, 1.00, null, true, budget);
    reset role;
    raise exception 'FAIL  7b a zero-priced product was procured';
  exception when check_violation then
    reset role;
    raise notice 'PASS  7b a zero selling price is refused, not compared against';
  end;

  -- ======================================================================
  -- 8. A draft is not a commitment
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 5, 35.00, null, false, budget) into po;
  reset role;
  select status::text into st from public.purchase_orders where id = po;
  if st <> 'draft' then
    raise exception 'FAIL  8a a bad-margin draft could not be saved (status %)', st;
  end if;
  raise notice 'PASS  8a a draft saves with an unresolved margin -- a draft buys nothing';

  -- ...but submitting that same draft is refused.
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.transition_purchase_order(po, 'pending_approval', null);
    reset role;
    raise exception 'FAIL  8b the bad-margin draft was submitted';
  exception when check_violation then
    reset role;
    raise notice 'PASS  8b submitting that draft is where the rule bites';
  end;

  -- ======================================================================
  -- 9. A direct UPDATE cannot get round it
  -- ======================================================================
  --
  -- The enforcement claim. A manipulated client, or any future caller that
  -- moves the status without calling the RPC, meets the same rule -- which is
  -- why the guard is a trigger on the row rather than a branch inside the
  -- transition function.
  begin
    update public.purchase_orders set status = 'pending_approval' where id = po;
    raise exception 'FAIL  9a a direct UPDATE submitted a negative-margin order';
  exception when check_violation then
    raise notice 'PASS  9a a direct UPDATE bypassing the RPC is refused too';
  end;

  -- ======================================================================
  -- 10. The price is re-checked at approval
  -- ======================================================================
  --
  -- Submitted at a healthy margin; the branch then cuts the price below cost.
  -- The company commits at approval, so approval is where it must be caught.
  perform pg_temp.acts_as(staff); set local role authenticated;
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 5, 28.00, null, true, budget) into po;
  reset role;

  select selling_price_snapshot into snap from public.purchase_order_items where purchase_order_id = po;
  if snap is distinct from 30.00 then
    raise exception 'FAIL 10a submitted snapshot is %, expected 30.00', snap;
  end if;
  raise notice 'PASS 10a submitted at 28.00 against 30.00, snapshot kept';

  perform pg_temp.acts_as(admin_id);
  update public.pos_branch_products set selling_price_override = 25.00
   where branch_id = branch_a and product_id = product;

  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_purchase_order(po, 'approved', null);
    reset role;
    raise exception 'FAIL 10b approval proceeded after the price fell below the cost';
  exception when check_violation then
    reset role;
    raise notice 'PASS 10b approval is refused once the price falls below the submitted cost';
  end;

  -- The submission-time price is still on the line, which is what lets the
  -- reviewer see that it MOVED rather than only that it is wrong now.
  select selling_price_snapshot into snap from public.purchase_order_items where purchase_order_id = po;
  if snap is distinct from 30.00 then
    raise exception 'FAIL 10c the refused approval rewrote the snapshot to %', snap;
  end if;
  raise notice 'PASS 10c a refused approval does not rewrite what was validated before';

  -- Put the price back; the same approval now goes through and re-snapshots.
  perform pg_temp.acts_as(admin_id);
  update public.pos_branch_products set selling_price_override = 31.00
   where branch_id = branch_a and product_id = product;

  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'approved', null);
  reset role;

  select selling_price_snapshot into snap from public.purchase_order_items where purchase_order_id = po;
  if snap is distinct from 31.00 then
    raise exception 'FAIL 10d approval snapshot is %, expected the 31.00 it committed against', snap;
  end if;
  raise notice 'PASS 10d approval records the price the company actually committed against';

  -- ======================================================================
  -- 11. The reviewer sees the same arithmetic
  -- ======================================================================
  perform pg_temp.acts_as(manager); set local role authenticated;
  select current_selling_price into price from public.get_purchase_order_margins(po);
  if price is distinct from 31.00 then
    raise exception 'FAIL 11a the reviewer was told %, expected the current 31.00', price;
  end if;
  select count(*) into n from public.get_purchase_order_margins(po);
  if n <> 1 then raise exception 'FAIL 11b expected one POS line, got %', n; end if;
  raise notice 'PASS 11a-b the approver reads cost, current price and snapshot for every POS line';
  reset role;

  -- ======================================================================
  -- 12. Validating a margin is not a stock or money movement
  -- ======================================================================
  select quantity_on_hand into qty_before from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  select count(*) into moves_before from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;

  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req, vendor, null, null, 1, 999.00, null, true, budget);
  exception when check_violation then null; end;
  reset role;

  select quantity_on_hand into qty_after from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  select count(*) into moves_after from public.pos_inventory_movements
   where branch_id = branch_a and product_id = product;

  if qty_before is distinct from qty_after then
    raise exception 'FAIL 12a stock moved from % to % while validating a margin', qty_before, qty_after;
  end if;
  if moves_before <> moves_after then
    raise exception 'FAIL 12b % stock movement(s) were written by a margin check', moves_after - moves_before;
  end if;
  raise notice 'PASS 12a-b validating a margin moves no stock and writes no movement';

  -- ======================================================================
  -- 13. The quantity guard is untouched
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.create_purchase_order_from_source(
      'pos_restock', req, vendor, null, null, 9999, 20.00, null, true, budget);
    reset role;
    raise exception 'FAIL 13a ordering more than was requested was allowed';
  exception when check_violation then
    reset role;
    raise notice 'PASS 13a the outstanding-quantity guard still refuses an over-order';
  end;

  raise notice '--- procurement margin: all checks passed ---';
end;
$$;

rollback;
