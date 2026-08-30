-- POS catalogue — database contract test.
--
-- Phase 3 makes products and categories enterprise-level and serves the
-- branch-facing catalogue through SECURITY DEFINER RPCs rather than table
-- reads. The claims that matter are: only an Administrator administers the
-- catalogue, a POS Manager may toggle availability at their own branch and
-- nothing else, and cost never reaches a POS caller. This proves each of them.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_catalogue_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

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
  admin_id     uuid;
  outsider_id  uuid;
  cashier_id   uuid;
  manager_id   uuid;
  branch_a     uuid;
  branch_b     uuid;
  general_id   uuid;
  drinks_id    uuid;
  snacks_id    uuid;
  cola_id      uuid;
  bar_id       uuid;
  n            integer;
  txt          text;
  -- Fixture names are suffixed so the test never collides with real catalogue
  -- rows. It runs against whatever data exists, and 'Drinks' is exactly the
  -- kind of name a real system already has.
  tag          text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  ------------------------------------------------------------------ fixtures
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  -- The POS roles must be plain employees. An hr_staff account also satisfies
  -- is_active_staff(), which carries its own read access to branches and
  -- reference data, so using one here would mask exactly the branch-visibility
  -- question checks 5d/5e ask.
  select id into cashier_id from public.profiles
    where role = 'employee' and status = 'active' order by created_at limit 1;
  select id into manager_id from public.profiles
    where role = 'employee' and status = 'active' and id <> cashier_id order by created_at limit 1;
  select id into outsider_id from public.profiles
    where role <> 'admin' and status = 'active' and id not in (cashier_id, manager_id) limit 1;

  if admin_id is null or branch_b is null then
    raise exception 'fixture: need an active admin and two active branches';
  end if;
  if cashier_id is null or manager_id is null then
    raise exception 'fixture: need two active employee accounts to stand in for POS staff';
  end if;
  if outsider_id is null then
    raise exception 'fixture: need a third non-admin account with no POS access';
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

  select id into general_id from public.pos_product_categories where normalized_name = 'general';
  if general_id is null then raise exception 'fixture: the permanent General category is missing'; end if;

  --------------------------------------------------- 1. admin administers
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.pos_product_categories (name, sort_order)
    values ('ZZ Test Drinks ' || tag, 900) returning id into drinks_id;
  insert into public.pos_product_categories (name, sort_order)
    values ('ZZ Test Snacks ' || tag, 901) returning id into snacks_id;
  raise notice 'PASS  1a administrator creates categories';

  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Test Cola ' || tag, drinks_id, 85.00, 60.00, 'active') returning id into cola_id;
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Test Bar ' || tag, snacks_id, 20.00, 12.00, 'archived') returning id into bar_id;
  raise notice 'PASS  1b administrator creates products';

  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, cola_id, true),
         (branch_b, cola_id, true),
         (branch_a, bar_id, true);
  raise notice 'PASS  1c administrator assigns branch availability';

  ------------------------------------------- 2. the General category is fixed
  begin
    update public.pos_product_categories set name = 'Miscellaneous' where id = general_id;
    raise exception 'FAIL  2a General was renamed';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a General cannot be renamed';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.pos_product_categories set is_active = false where id = general_id;
    raise exception 'FAIL  2b General was archived';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2b General cannot be archived';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.delete_pos_category(general_id, drinks_id);
    raise exception 'FAIL  2c General was deleted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2c General cannot be deleted';
  end;

  --------------------------------------------- 3. category name uniqueness
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.pos_product_categories (name) values ('  zz test drinks ' || tag || '  ');
    raise exception 'FAIL  3  a case/space variant duplicate category was accepted';
  exception when unique_violation then
    raise notice 'PASS  3  a duplicate category name is rejected regardless of case or padding';
  end;

  ---------------------------------------- 4. deleting a category needs a home
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.delete_pos_category(drinks_id, null);
    raise exception 'FAIL  4a a category holding products was deleted with nowhere to put them';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  4a deleting a category holding products requires a replacement';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.delete_pos_category(snacks_id, general_id);
  select category_id into txt from public.pos_products where id = bar_id;
  if txt::uuid <> general_id then
    raise exception 'FAIL  4b products were not reassigned to the replacement category';
  end if;
  raise notice 'PASS  4b deleting a category reassigns its products to the replacement';

  reset role;

  ------------------------------------------------- 5. cashier catalogue read
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.get_pos_catalogue(branch_a) where product_id = cola_id;
  if n <> 1 then raise exception 'FAIL  5a cashier cannot see the active product at their own branch'; end if;
  raise notice 'PASS  5a cashier reads their own branch catalogue';

  select count(*) into n from public.get_pos_catalogue(branch_a) where product_id = bar_id;
  if n <> 0 then raise exception 'FAIL  5b an ARCHIVED product appears in the POS catalogue'; end if;
  raise notice 'PASS  5b an ARCHIVED product is absent from the POS catalogue';

  select count(*) into n from public.get_pos_categories();
  if n < 1 then raise exception 'FAIL  5c cashier cannot read categories'; end if;
  raise notice 'PASS  5c cashier reads active categories';

  ----------------------------------- 5d. the branch row itself is readable
  -- Without this a cashier can hold an assignment to a branch whose row they
  -- cannot read, and every screen that needs the branch (the catalogue, and
  -- later the receipt) resolves to nothing. Added after driving the app as a
  -- manager exposed it -- see 20260825050000.
  select count(*) into n from public.branches where id = branch_a;
  if n <> 1 then raise exception 'FAIL  5d cashier cannot read the branch they are assigned to'; end if;
  raise notice 'PASS  5d cashier can read the branch they are assigned to';

  select count(*) into n from public.branches where id = branch_b;
  if n <> 0 then raise exception 'FAIL  5e cashier can read a branch they are NOT assigned to'; end if;
  raise notice 'PASS  5e cashier cannot read a branch they are not assigned to';

  --------------------------------------------- 6. wrong branch is refused
  select count(*) into n from public.get_pos_catalogue(branch_b);
  if n <> 0 then raise exception 'FAIL  6  cashier read % rows from a branch they are not assigned to', n; end if;
  raise notice 'PASS  6  cashier cannot read another branch''s catalogue';

  ------------------------------------- 7. cashier cannot administer anything
  select count(*) into n from public.pos_products;
  if n <> 0 then raise exception 'FAIL  7a cashier can read the product master directly'; end if;
  select count(*) into n from public.pos_product_categories;
  if n <> 0 then raise exception 'FAIL  7b cashier can read the category table directly'; end if;
  raise notice 'PASS  7a cashier cannot read the product master table';
  raise notice 'PASS  7b cashier cannot read the category table';

  begin
    insert into public.pos_products (name, category_id, default_selling_price)
    values ('ZZ Contraband ' || tag, general_id, 1);
    raise exception 'FAIL  7c cashier created a product';
  exception when insufficient_privilege then
    raise notice 'PASS  7c cashier cannot create a product';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.pos_branch_products set is_available = false where product_id = cola_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL  7d cashier toggled branch availability'; end if;
  raise notice 'PASS  7d cashier cannot toggle branch availability';

  reset role;

  ------------------------------------------------------- 8. the POS manager
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.pos_branch_products set is_available = false
    where branch_id = branch_a and product_id = cola_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL  8a POS manager could not toggle availability at their own branch'; end if;
  raise notice 'PASS  8a POS manager toggles availability at their own branch';

  select count(*) into n from public.get_pos_catalogue(branch_a) where product_id = cola_id;
  if n <> 0 then raise exception 'FAIL  8b an UNAVAILABLE product still appears in the catalogue'; end if;
  raise notice 'PASS  8b an unavailable branch product disappears from that branch''s catalogue';

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.pos_branch_products set is_available = true
    where branch_id = branch_a and product_id = cola_id;

  -- Another branch is none of their business.
  update public.pos_branch_products set is_available = false
    where branch_id = branch_b and product_id = cola_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL  8c POS manager changed ANOTHER branch''s availability'; end if;
  raise notice 'PASS  8c POS manager cannot change another branch''s availability';

  -- Pricing is not theirs, even at their own branch.
  begin
    update public.pos_branch_products set selling_price_override = 1
      where branch_id = branch_a and product_id = cola_id;
    raise exception 'FAIL  8d POS manager set a branch selling price';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  8d POS manager cannot set a branch selling price';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.pos_products;
  if n <> 0 then raise exception 'FAIL  8e POS manager can read the product master directly'; end if;
  raise notice 'PASS  8e POS manager cannot read the product master table';

  begin
    insert into public.pos_product_categories (name) values ('ZZ Manager Category ' || tag);
    raise exception 'FAIL  8f POS manager created a global category';
  exception when insufficient_privilege then
    raise notice 'PASS  8f POS manager cannot create a global category';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.delete_pos_category(drinks_id, general_id);
    raise exception 'FAIL  8g POS manager deleted a global category';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  8g POS manager cannot delete a global category';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.reorder_pos_category(drinks_id, 1);
    raise exception 'FAIL  8h POS manager reordered global categories';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  8h POS manager cannot reorder global categories';
  end;

  reset role;

  ------------------------------------------- 9. no POS access reaches nothing
  perform set_config('request.jwt.claims', json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_categories();
  if n <> 0 then raise exception 'FAIL  9a an account with no POS access read % categories', n; end if;
  select count(*) into n from public.get_pos_catalogue(branch_a);
  if n <> 0 then raise exception 'FAIL  9b an account with no POS access read the catalogue'; end if;
  raise notice 'PASS  9  an account with no POS access reads neither categories nor catalogue';
  reset role;

  --------------------------------- 10. cost never leaves the catalogue RPC
  --
  -- Asserted against the function's declared result type rather than a sample
  -- row: a future edit that adds a cost column would be caught even if no row
  -- happened to expose it.
  txt := pg_get_function_result('public.get_pos_catalogue(uuid)'::regprocedure);
  if txt ~* '(cost|margin|cogs|profit)' then
    raise exception 'FAIL 10a the catalogue RPC exposes a cost-like column: %', txt;
  end if;
  raise notice 'PASS 10a the catalogue RPC declares no cost, margin, COGS or profit column';

  txt := pg_get_function_result('public.get_pos_categories()'::regprocedure);
  if txt ~* '(cost|margin|cogs|profit)' then
    raise exception 'FAIL 10b the categories RPC exposes a cost-like column: %', txt;
  end if;
  raise notice 'PASS 10b the categories RPC declares no cost-like column';

  ------------------------------------------------- 11. deactivation closes it
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set status = 'inactive' where id = cashier_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_catalogue(branch_a);
  if n <> 0 then raise exception 'FAIL 11  a deactivated account still reads the catalogue'; end if;
  raise notice 'PASS 11  a deactivated account reads no catalogue, assignment notwithstanding';
  reset role;

  ------------------------------------------------------------- 12. anon/none
  set local role anon;
  begin
    perform public.get_pos_categories();
    raise exception 'FAIL 12  anon executed the categories RPC';
  exception when insufficient_privilege then
    raise notice 'PASS 12  anon may not execute the catalogue RPCs';
  end;
  reset role;

  ------------------------------------------------ 13. no stock in Phase 3
  select count(*) into n from information_schema.columns
  where table_schema = 'public'
    and table_name in ('pos_products', 'pos_branch_products')
    and column_name in ('stock', 'quantity', 'stock_on_hand', 'low_stock_threshold');
  if n <> 0 then
    raise exception 'FAIL 13  Phase 3 introduced a stock column; inventory belongs to Phase 4';
  end if;
  raise notice 'PASS 13  Phase 3 carries no stock column -- inventory stays Phase 4''s';

  raise notice '--- all POS catalogue contract checks passed ---';
end $$;

rollback;

select 'products after rollback: ' || count(*)::text as verify from public.pos_products;
