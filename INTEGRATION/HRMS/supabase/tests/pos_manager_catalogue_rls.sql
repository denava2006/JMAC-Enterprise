-- POS Manager catalogue authority — database contract test.
--
-- A manager could not put a product on their own shelves. Adding something the
-- company already sells, creating something it does not, naming a category to
-- file it under -- each needed an Administrator, so a new branch could not open
-- without somebody else driving.
--
-- The authority added is shaped around one question: what does THIS branch
-- sell, and for how much. These checks are mostly about where it stops --
-- another branch, and cost.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_manager_catalogue_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

create or replace function pg_temp.acts_as(_uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  admin_id   uuid;
  mgr_uid    uuid;
  cash_uid   uuid;
  branch_a   uuid;
  branch_b   uuid;
  ops_dept   uuid;
  mgr_pos    uuid;
  cash_pos   uuid;
  general    uuid;
  product    uuid;
  other_prod uuid;
  new_prod   uuid;
  cat        uuid;
  emp        uuid;
  n          integer;
  txt        text;
  tag        text := left(replace(gen_random_uuid()::text, '-', ''), 8);

  function_missing boolean;
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into general from public.pos_product_categories where lower(name)='general' limit 1;

  select p.id, p.department_id into mgr_pos, ops_dept from public.positions p
    join public.position_system_roles r on r.position_id=p.id and r.system='pos' and r.role_code='manager' limit 1;
  select p.id into cash_pos from public.positions p
    join public.position_system_roles r on r.position_id=p.id and r.system='pos' and r.role_code='cashier' limit 1;

  if admin_id is null or branch_a is null or branch_b is null or general is null
     or mgr_pos is null or cash_pos is null then
    raise exception 'fixture: need an admin, two branches, a General category, a manager position and a cashier position';
  end if;

  -- A manager at branch A, and a cashier at branch A.
  insert into public.employees (first_name, last_name, email, department_id, position_id,
                                hire_date, employment_status)
  values ('ZZ', 'Mgr ' || tag, 'zz.mgr.' || tag || '@jmac-test.invalid', ops_dept, mgr_pos,
          current_date, 'active') returning id into emp;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
          'zz.mgr.' || tag || '@jmac-test.invalid', crypt('x', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
  returning id into mgr_uid;
  update public.profiles set employee_id = emp, role='employee', status='active' where id = mgr_uid;
  delete from public.pos_branch_assignments where profile_id = mgr_uid;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, status)
  values (mgr_uid, branch_a, 'manager', 'active');

  insert into public.employees (first_name, last_name, email, department_id, position_id,
                                hire_date, employment_status)
  values ('ZZ', 'Cash ' || tag, 'zz.cash.' || tag || '@jmac-test.invalid', ops_dept, cash_pos,
          current_date, 'active') returning id into emp;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
          'zz.cash.' || tag || '@jmac-test.invalid', crypt('x', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
  returning id into cash_uid;
  update public.profiles set employee_id = emp, role='employee', status='active' where id = cash_uid;
  delete from public.pos_branch_assignments where profile_id = cash_uid;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, status)
  values (cash_uid, branch_a, 'cashier', 'active');

  -- A product the company already sells, carried nowhere yet.
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Existing ' || tag, general, 50, 30, 'active') returning id into product;

  -- ======================================================================
  -- 1. A manager may carry an existing product
  -- ======================================================================
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  perform public.add_pos_product_to_branch(branch_a, product);
  reset role;

  select count(*) into n from public.pos_branch_products
   where branch_id = branch_a and product_id = product and is_available = false;
  if n <> 1 then
    raise exception 'FAIL  1a carrying the product produced % rows with offered=false', n;
  end if;
  raise notice 'PASS  1a a manager may carry an existing product, not offered yet';

  -- Carrying is not stocking.
  select count(*) into n from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product and quantity_on_hand <> 0;
  if n <> 0 then
    raise exception 'FAIL  1b carrying a product created stock';
  end if;
  raise notice 'PASS  1b carrying a product creates no inventory';

  -- ======================================================================
  -- 2. Not at somebody else's branch
  -- ======================================================================
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Other ' || tag, general, 20, 10, 'active') returning id into other_prod;

  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  begin
    perform public.add_pos_product_to_branch(branch_b, other_prod);
    reset role;
    raise exception 'FAIL  2a a manager stocked a branch they do not manage';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a a manager cannot carry a product at another branch';
  end;

  -- ======================================================================
  -- 3. A manager may create a product
  -- ======================================================================
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  new_prod := public.create_pos_product_for_branch(branch_a, 'ZZ Created ' || tag, general, 75);
  reset role;

  select count(*) into n from public.pos_branch_products
   where branch_id = branch_a and product_id = new_prod and is_available = false;
  if n <> 1 then
    raise exception 'FAIL  3a the created product was not carried at the branch, unoffered';
  end if;

  select count(*) into n from public.pos_branch_inventory
   where product_id = new_prod and quantity_on_hand <> 0;
  if n <> 0 then
    raise exception 'FAIL  3b creating a product created stock';
  end if;
  raise notice 'PASS  3a-b creating a product carries it, offered false, with no stock';

  -- Cost is not something a manager sets, so it stays at the default.
  select default_unit_cost into txt from public.pos_products where id = new_prod;
  if txt::numeric <> 0 then
    raise exception 'FAIL  3c a manager-created product has a cost of %', txt;
  end if;
  raise notice 'PASS  3c the product carries no cost -- that belongs to whoever buys it';

  -- ======================================================================
  -- 4. The same product is not invented twice
  -- ======================================================================
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  begin
    -- Different case and spacing: the same shelf item.
    perform public.create_pos_product_for_branch(branch_a, '  zz created ' || tag || '  ', general, 90);
    reset role;
    raise exception 'FAIL  4a a duplicate product was created';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like 'POS_PRODUCT_EXISTS:%' then
      raise exception 'FAIL  4a refused with the wrong reason: %', sqlerrm;
    end if;
    raise notice 'PASS  4a a duplicate is refused, naming the product that already exists';
  end;

  -- ======================================================================
  -- 5. Price is the branch's; cost is nobody's business here
  -- ======================================================================
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  perform public.set_pos_branch_selling_price(branch_a, product, 65);
  reset role;

  select selling_price_override into txt from public.pos_branch_products
   where branch_id = branch_a and product_id = product;
  if txt::numeric <> 65 then
    raise exception 'FAIL  5a the branch price is %', txt;
  end if;

  -- The company-wide price is untouched.
  select default_selling_price into txt from public.pos_products where id = product;
  if txt::numeric <> 50 then
    raise exception 'FAIL  5b the global price was changed to %', txt;
  end if;
  raise notice 'PASS  5a-b a manager sets their branch price, not the company''s';

  -- And the cost is still the cost.
  select default_unit_cost into txt from public.pos_products where id = product;
  if txt::numeric <> 30 then
    raise exception 'FAIL  5c the cost changed to %', txt;
  end if;
  raise notice 'PASS  5c setting a price does not touch cost';

  -- Another branch's price is not theirs to set.
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_b, product, false);

  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  begin
    perform public.set_pos_branch_selling_price(branch_b, product, 5);
    reset role;
    raise exception 'FAIL  5d a manager priced another branch';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  5d a manager cannot price a branch they do not manage';
  end;

  -- ======================================================================
  -- 6. Categories: a manager may name a shelf
  -- ======================================================================
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  cat := public.create_pos_category('ZZ Shelf ' || tag);
  reset role;

  if cat is null then raise exception 'FAIL  6a the category was not created'; end if;
  raise notice 'PASS  6a a manager may create a category';

  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  begin
    perform public.create_pos_category('  zz shelf ' || tag || ' ');
    reset role;
    raise exception 'FAIL  6b a duplicate category was created';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  6b case and spacing do not make a second shelf';
  end;

  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  perform public.rename_pos_category(cat, 'ZZ Renamed ' || tag);
  reset role;
  select name into txt from public.pos_product_categories where id = cat;
  if txt <> 'ZZ Renamed ' || tag then
    raise exception 'FAIL  6c the rename did not take: %', txt;
  end if;
  raise notice 'PASS  6c a manager may rename a category';

  -- ======================================================================
  -- 7. A cashier may not
  -- ======================================================================
  perform pg_temp.acts_as(cash_uid);
  set local role authenticated;
  begin
    perform public.create_pos_category('ZZ Cashier Shelf ' || tag);
    reset role;
    raise exception 'FAIL  7a a cashier created a category';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7a a cashier may not create a category';
  end;

  perform pg_temp.acts_as(cash_uid);
  set local role authenticated;
  begin
    perform public.create_pos_product_for_branch(branch_a, 'ZZ Cashier Product ' || tag, general, 10);
    reset role;
    raise exception 'FAIL  7b a cashier created a product';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7b a cashier may not create a product';
  end;

  -- ======================================================================
  -- 8. Stock is still not something anyone types
  -- ======================================================================
  --
  -- The whole point of the request/receive split: a manager says what they
  -- need, and the number of units on a shelf changes only when units arrive.
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  begin
    update public.pos_branch_inventory set quantity_on_hand = 500
     where branch_id = branch_a and product_id = product;
    get diagnostics n = row_count;
    reset role;
    if n <> 0 then
      raise exception 'FAIL  8a a manager set the stock level directly on % row(s)', n;
    end if;
    raise notice 'PASS  8a a manager cannot type a stock level';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  8a a manager cannot type a stock level';
  end;

  raise notice '--- all POS manager catalogue checks passed ---';
end $$;

rollback;

select 'products after rollback: ' || count(*)::text as verify from public.pos_products;
