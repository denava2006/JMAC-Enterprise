-- POS Manager modules — database contract test.
--
-- The Manager portal gained Products and POS Settings. Both are built on
-- primitives that already existed, and this suite pins the boundaries those
-- two screens now sit against -- the ones that decide whether "a manager runs
-- their branch" quietly becomes "a manager runs the enterprise".
--
-- Existing suites already cover the neighbouring ground: pos_requests_rls
-- proves a manager may raise demand only at their own branch and that
-- approving a restock moves no stock, and pos_catalogue_rls proves a cashier
-- can reach none of it and that the till's catalogue declares no cost column.
-- Nothing here repeats those.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_manager_modules_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

create function pg_temp.make_manager(_profile_id uuid, _branch_id uuid)
returns void language plpgsql as $helper$
declare
  _dept uuid; _position uuid; _employee uuid; _admin uuid;
  _saved text := current_setting('request.jwt.claims', true);
begin
  select d.id into _dept from public.departments d where d.name = 'Store Operations';
  select po.id into _position from public.positions po
   where po.department_id = _dept and po.title = 'POS Manager';
  select p.employee_id into _employee from public.profiles p where p.id = _profile_id;
  if _employee is null then
    insert into public.employees (first_name, last_name, email, department_id, position_id,
                                  employment_status, hire_date)
    select coalesce(split_part(p.full_name,' ',1),'Test'),
           coalesce(nullif(split_part(p.full_name,' ',2),''),'Worker'),
           p.email, _dept, _position, 'active', current_date
    from public.profiles p where p.id = _profile_id returning id into _employee;
  else
    update public.employees set department_id=_dept, position_id=_position,
           employment_status='active' where id=_employee;
  end if;
  select p.id into _admin from public.profiles p where p.role='admin' and p.status='active' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',_admin,'role','authenticated')::text, true);
  update public.profiles set employee_id=_employee, role='employee', status='active'
   where id=_profile_id;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (_profile_id, _branch_id, 'manager', _admin);
  perform set_config('request.jwt.claims', coalesce(_saved,''), true);
end;
$helper$;

do $$
declare
  admin_id  uuid;
  manager   uuid;
  branch_a  uuid;
  branch_b  uuid;
  general   uuid;
  prod      uuid;
  n         integer;
  qty       integer;
  txt       text;
  tag       text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into general from public.pos_product_categories where normalized_name='general';
  select id into manager from public.profiles
   where role='employee' and status='active' order by created_at, id limit 1;
  if admin_id is null or branch_a is null or branch_b is null or general is null or manager is null then
    raise exception 'fixture: need an admin, two branches, General and an employee';
  end if;

  delete from public.pos_branch_assignments;
  perform pg_temp.make_manager(manager, branch_a);

  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Mgr ' || tag, general, 100.00, 60.00, 'active') returning id into prod;
  insert into public.pos_branch_products (branch_id, product_id, is_available, selling_price_override)
  values (branch_a, prod, true, null);

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_pos_stock(branch_a, prod, 10, 60.00, null);
  reset role;

  -- From here on, act as the manager.
  perform set_config('request.jwt.claims',
    json_build_object('sub', manager, 'role', 'authenticated')::text, true);

  -- ======================================================================
  -- 1. The enterprise catalogue is not the manager's to write
  -- ======================================================================
  --
  -- pos_products has no branch column: a row created here is sold by every
  -- branch, and it carries default_unit_cost, which is a cost field a manager
  -- must never set or see. This is why Products offers a carry REQUEST rather
  -- than a create form.
  set local role authenticated;
  begin
    insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
    values ('ZZ Hostile ' || tag, general, 10, 5, 'active');
    raise exception 'FAIL  1a a manager created an enterprise product';
  exception when insufficient_privilege then
    raise notice 'PASS  1a a manager cannot create an enterprise product';
  when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1a a manager cannot create an enterprise product';
  end;

  begin
    insert into public.pos_product_categories (name, normalized_name, sort_order)
    values ('ZZ Hostile Cat ' || tag, 'zz-hostile-' || tag, 99);
    raise exception 'FAIL  1b a manager created an enterprise category';
  exception when insufficient_privilege then
    raise notice 'PASS  1b a manager cannot create an enterprise category';
  when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1b a manager cannot create an enterprise category';
  end;

  begin
    update public.pos_products set name = 'ZZ Renamed' where id = prod;
    if found then
      raise exception 'FAIL  1c a manager renamed an enterprise product';
    end if;
    raise notice 'PASS  1c a manager cannot rename an enterprise product';
  exception when insufficient_privilege then
    raise notice 'PASS  1c a manager cannot rename an enterprise product';
  when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1c a manager cannot rename an enterprise product';
  end;
  reset role;

  -- ======================================================================
  -- 2. Availability yes, price no
  -- ======================================================================
  --
  -- The one write the Products page offers, and the one it deliberately shows
  -- as read-only text instead of an input.
  set local role authenticated;
  update public.pos_branch_products set is_available = false
   where branch_id = branch_a and product_id = prod;
  select is_available into txt from public.pos_branch_products
   where branch_id = branch_a and product_id = prod;
  reset role;
  if txt <> 'false' then
    raise exception 'FAIL  2a a manager could not stop offering a product at their own branch';
  end if;
  raise notice 'PASS  2a a manager may stop and resume offering a product at their branch';

  set local role authenticated;
  begin
    update public.pos_branch_products set selling_price_override = 1.00
     where branch_id = branch_a and product_id = prod;
    raise exception 'FAIL  2b a manager set a branch selling price';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2b a manager cannot set a branch selling price';
  end;
  reset role;

  -- Another branch's listing is not theirs to touch, whatever they send.
  set local role authenticated;
  update public.pos_branch_products set is_available = false where branch_id = branch_b;
  reset role;
  select count(*) into n from public.pos_branch_products
   where branch_id = branch_b and is_available = false;
  if n <> 0 then
    raise exception 'FAIL  2c a manager changed % rows at a branch they do not manage', n;
  end if;
  raise notice 'PASS  2c a manager cannot change another branch''s listings';

  -- ======================================================================
  -- 3. Quantity moves only through inventory operations
  -- ======================================================================
  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = prod;

  set local role authenticated;
  begin
    update public.pos_branch_inventory set quantity_on_hand = 500
     where branch_id = branch_a and product_id = prod;
  exception when insufficient_privilege then
    -- Stronger than a policy refusal: the table grants no UPDATE to an API
    -- role at all, so there is no row-level rule to get wrong.
    null;
  end;
  reset role;

  select quantity_on_hand into n from public.pos_branch_inventory
   where branch_id = branch_a and product_id = prod;
  if n <> qty then
    raise exception 'FAIL  3a a manager set stock directly: % -> %', qty, n;
  end if;
  raise notice 'PASS  3a a manager cannot type a new stock number';

  set local role authenticated;
  begin
    perform public.receive_pos_stock(branch_a, prod, 100, 10.00, 'hostile');
    raise exception 'FAIL  3b a manager received stock directly';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3b a manager cannot receive stock';
  when insufficient_privilege then
    raise notice 'PASS  3b a manager cannot receive stock';
  end;

  begin
    perform public.adjust_pos_stock(branch_a, prod, 100, 'correction', 'hostile');
    raise exception 'FAIL  3c a manager adjusted stock directly';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3c a manager cannot adjust stock';
  when insufficient_privilege then
    raise notice 'PASS  3c a manager cannot adjust stock';
  end;
  reset role;

  select quantity_on_hand into n from public.pos_branch_inventory
   where branch_id = branch_a and product_id = prod;
  if n <> qty then
    raise exception 'FAIL  3d stock moved to % despite every path being refused', n;
  end if;
  raise notice 'PASS  3d stock is unchanged after every direct attempt';

  -- ======================================================================
  -- 4. The Products page's data source
  -- ======================================================================
  set local role authenticated;
  select count(*) into n from public.get_branch_catalogue_management(branch_a);
  if n = 0 then
    raise exception 'FAIL  4a a manager cannot read their own branch catalogue';
  end if;
  raise notice 'PASS  4a a manager reads their own branch catalogue';

  select count(*) into n from public.get_branch_catalogue_management(branch_b);
  if n <> 0 then
    raise exception 'FAIL  4b a manager read % rows from another branch catalogue', n;
  end if;
  raise notice 'PASS  4b a manager reads nothing from a branch they do not manage';
  reset role;

  -- Cost cannot leak from a screen whose source has no cost column.
  select string_agg(u.name, ',') into txt
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  cross join lateral unnest(p.proallargtypes, p.proargnames) with ordinality as u(t, name, ord)
  where ns.nspname = 'public' and p.proname = 'get_branch_catalogue_management';
  if txt ~* '(cost|cogs|margin|profit)' then
    raise exception 'FAIL  4c the branch catalogue RPC exposes %', txt;
  end if;
  raise notice 'PASS  4c the branch catalogue RPC declares no cost, COGS, margin or profit';

  -- ======================================================================
  -- 5. Manager reports stay operational
  -- ======================================================================
  for txt in
    select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname='public' and p.proname like 'get_pos_manager_report%'
  loop
    declare _cols text;
    begin
      select string_agg(u.name, ',') into _cols
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
      cross join lateral unnest(p.proallargtypes, p.proargnames) with ordinality as u(t, name, ord)
      where ns.nspname='public' and p.proname = txt;
      if _cols ~* '(cost|cogs|margin|profit)' then
        raise exception 'FAIL  5a % exposes %', txt, _cols;
      end if;
    end;
  end loop;
  raise notice 'PASS  5a no manager report RPC declares cost, COGS, margin or profit';

  -- The Administrator keeps the financial view; this is not a global removal.
  select string_agg(u.name, ',') into txt
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  cross join lateral unnest(p.proallargtypes, p.proargnames) with ordinality as u(t, name, ord)
  where ns.nspname='public' and p.proname = 'get_admin_pos_report_summary';
  if txt !~* '(cost|cogs|margin|profit)' then
    raise exception 'FAIL  5b the Administrator report lost its financial columns: %', txt;
  end if;
  raise notice 'PASS  5b the Administrator report keeps cost and margin';

  -- ======================================================================
  -- 6. POS Settings is readable, not writable
  -- ======================================================================
  insert into public.branch_pos_settings (branch_id, fees)
  values (branch_a, jsonb_build_array(jsonb_build_object(
    'id','f1','name','Service Charge','type','percent','value',10,'enabled',true)))
  on conflict (branch_id) do update set fees = excluded.fees;
  insert into public.branch_pos_settings (branch_id, fees)
  values (branch_b, '[]'::jsonb)
  on conflict (branch_id) do update set fees = excluded.fees;

  set local role authenticated;
  select count(*) into n from public.branch_pos_settings where branch_id = branch_a;
  if n <> 1 then
    raise exception 'FAIL  6a a manager cannot read their own branch settings';
  end if;
  raise notice 'PASS  6a a manager reads their own branch POS settings';

  select count(*) into n from public.branch_pos_settings where branch_id = branch_b;
  if n <> 0 then
    raise exception 'FAIL  6b a manager read another branch''s settings';
  end if;
  raise notice 'PASS  6b a manager cannot read another branch''s settings';

  -- Fees decide what every customer pays. That authority stays with an
  -- Administrator, exactly as branch selling prices do.
  update public.branch_pos_settings set fees = '[]'::jsonb where branch_id = branch_a;
  reset role;
  select jsonb_array_length(fees) into n from public.branch_pos_settings where branch_id = branch_a;
  if n <> 1 then
    raise exception 'FAIL  6c a manager changed their branch fees';
  end if;
  raise notice 'PASS  6c a manager cannot change what customers are charged';

  raise notice '--- all POS manager module checks passed ---';
end $$;

rollback;

select 'branch products after rollback: ' || count(*)::text as verify
from public.pos_branch_products;
