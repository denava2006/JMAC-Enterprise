-- POS transaction history — database contract test.
--
-- The claims:
--   a cashier sees their own sales and nobody else's, even at the same branch
--   a manager sees their branch, and only branches they manage
--   manager authority does not travel between branches
--   an administrator sees everything, still without cost
--   a receipt is authorised by who asks, never by knowing the id
--   no POS-facing function declares a cost column
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_transactions_rls.sql
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
  wf_dual_position uuid;
  admin_id     uuid;
  cashier_a    uuid;   -- cashier at branch A
  cashier_b    uuid;   -- a second cashier at the SAME branch
  mixed_id     uuid;   -- manager at A, cashier at B
  outsider_id  uuid;
  branch_a     uuid;
  branch_b     uuid;
  general_id   uuid;
  cola_id      uuid;
  sale_a       uuid;
  sale_b       uuid;
  sale_mixed_b uuid;
  n            integer;
  txt          text;
  tag          text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  ------------------------------------------------------------------ fixtures
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';

  select id into cashier_a from public.profiles
    where role = 'employee' and status = 'active' order by created_at, id limit 1;
  select id into cashier_b from public.profiles
    where role = 'employee' and status = 'active' and id <> cashier_a order by created_at, id limit 1;
  -- A third non-admin stands in for the mixed-role user; hr_staff is fine here
  -- because POS roles come from assignments, not from the HR role.
  select id into mixed_id from public.profiles
    where role = 'hr_staff' and status = 'active' order by created_at, id limit 1;
  select id into outsider_id from public.profiles
    where role = 'hr_manager' and status = 'active' order by created_at, id limit 1;

  if admin_id is null or branch_b is null or cashier_a is null or cashier_b is null
     or mixed_id is null or outsider_id is null or general_id is null then
    raise exception 'fixture: need an admin, two branches, two employees, hr_staff, hr_manager, General';
  end if;

  delete from public.pos_branch_assignments;
    -- FIXTURE WIRED (Phase 9A): give these people the employment record
  -- their POS role now requires. The assignment INSERT below is refused
  -- otherwise, which is the point of the phase.
  wf_dual_position := pg_temp.make_dual_role_position();
  perform pg_temp.make_pos_eligible(cashier_a, 'Cashier');
  perform pg_temp.make_pos_eligible(cashier_b, 'Cashier');
  perform pg_temp.make_eligible_at(mixed_id, wf_dual_position);

insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (cashier_a, branch_a, 'cashier', admin_id),
         (cashier_b, branch_a, 'cashier', admin_id),   -- same branch as cashier_a
         (mixed_id,  branch_a, 'manager', admin_id),   -- manages A
         (mixed_id,  branch_b, 'cashier', admin_id);   -- but only cashiers at B

  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Tx Cola ' || tag, general_id, 100.00, 0, 'active') returning id into cola_id;
  insert into public.pos_branch_products (branch_id, product_id)
  values (branch_a, cola_id), (branch_b, cola_id);

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_pos_stock(branch_a, cola_id, 100, 60.00, null);
  perform public.receive_pos_stock(branch_b, cola_id, 100, 60.00, null);
  reset role;

  -- Three sales: two cashiers at branch A, and the mixed user at branch B.
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.checkout_pos_sale(branch_a,
    jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 1)),
    'cash', gen_random_uuid(), null, 1000);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.checkout_pos_sale(branch_a,
    jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 2)),
    'cash', gen_random_uuid(), null, 1000);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', mixed_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.checkout_pos_sale(branch_b,
    jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 3)),
    'cash', gen_random_uuid(), null, 1000);
  reset role;

  select id into sale_a from public.pos_sales where cashier_id = cashier_a;
  select id into sale_b from public.pos_sales where cashier_id = cashier_b;
  select id into sale_mixed_b from public.pos_sales
    where cashier_id = mixed_id and branch_id = branch_b;

  ------------------------------------------- 1. a cashier's list is their own
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_a, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.get_my_transactions();
  if n <> 1 then raise exception 'FAIL  1a cashier A sees % sales, expected only their own 1', n; end if;
  raise notice 'PASS  1a a cashier sees exactly their own sales';

  select count(*) into n from public.get_my_transactions() t where t.sale_id = sale_b;
  if n <> 0 then raise exception 'FAIL  1b cashier A can see cashier B''s sale at the same branch'; end if;
  raise notice 'PASS  1b two cashiers at ONE branch do not share history';

  -- Nothing they could pass would widen it: the function has no such parameter.
  txt := pg_get_function_arguments('public.get_my_transactions(timestamptz,timestamptz,integer,integer)'::regprocedure);
  if txt ~* '(cashier|profile|user|_id\s)' then
    raise exception 'FAIL  1c get_my_transactions takes an identity argument: %', txt;
  end if;
  raise notice 'PASS  1c get_my_transactions takes no identity argument at all';

  ---------------------------------- 2. a cashier reaches no branch-wide view
  select count(*) into n from public.get_branch_transactions(branch_a);
  if n <> 0 then raise exception 'FAIL  2  a cashier read the branch-wide list'; end if;
  raise notice 'PASS  2  a cashier gets nothing from the branch-wide list';

  reset role;

  ------------------------------------------- 3. the manager sees their branch
  perform set_config('request.jwt.claims', json_build_object('sub', mixed_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.get_branch_transactions(branch_a);
  if n <> 2 then raise exception 'FAIL  3a the manager sees % sales at their branch, expected both cashiers'' 2', n; end if;
  raise notice 'PASS  3a a manager sees every cashier''s sales at the branch they manage';

  -- item_count is UNITS, not lines. Cashier B sold two of one product on a
  -- single line; a line count would report 1 and understate the day.
  select t.item_count into n from public.get_branch_transactions(branch_a) t
   where t.sale_id = sale_b;
  if n <> 2 then raise exception 'FAIL  3b item_count reported % for a 2-unit line, expected 2', n; end if;
  raise notice 'PASS  3b item_count counts units sold, not lines on the sale';

  ------------------- 4. manager authority does not travel to another branch
  select count(*) into n from public.get_branch_transactions(branch_b);
  if n <> 0 then raise exception 'FAIL  4a manager authority leaked into branch B, where they only cashier'; end if;
  raise notice 'PASS  4a a manager at A gets nothing branch-wide at B, where they are a cashier';

  select count(*) into n from public.get_my_transactions();
  if n <> 1 then raise exception 'FAIL  4b the mixed user sees % of their own sales, expected 1', n; end if;
  select count(*) into n from public.get_my_transactions() t where t.sale_id = sale_mixed_b;
  if n <> 1 then raise exception 'FAIL  4c the mixed user cannot see their own branch-B sale'; end if;
  raise notice 'PASS  4b their own branch-B sale is still theirs, on their own list';

  reset role;

  -------------------------------------------- 5. no POS access sees nothing
  perform set_config('request.jwt.claims', json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_my_transactions();
  if n <> 0 then raise exception 'FAIL  5a an account with no POS access read transactions'; end if;
  select count(*) into n from public.get_branch_transactions(branch_a);
  if n <> 0 then raise exception 'FAIL  5b an account with no POS access read a branch list'; end if;
  select count(*) into n from public.get_admin_transactions();
  if n <> 0 then raise exception 'FAIL  5c a non-admin read the admin list'; end if;
  raise notice 'PASS  5  an account with no POS access reads no transactions at all';
  reset role;

  ------------------------------------------------- 6. the administrator sees all
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_admin_transactions();
  if n <> 3 then raise exception 'FAIL  6a the administrator sees % sales, expected 3', n; end if;
  select count(*) into n from public.get_admin_transactions(branch_b);
  if n <> 1 then raise exception 'FAIL  6b filtering the admin list by branch returned %, expected 1', n; end if;
  raise notice 'PASS  6  an administrator sees every branch, and may filter to one';
  reset role;

  ---------------------------------------------------- 7. receipts are authorised
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.get_sale_detail(sale_a) is null then
    raise exception 'FAIL  7a a cashier cannot open their own receipt';
  end if;
  raise notice 'PASS  7a a cashier may open their own receipt';

  begin
    perform public.get_sale_detail(sale_b);
    raise exception 'FAIL  7b a cashier opened a colleague''s receipt by id';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7b knowing the id is not enough -- a colleague''s receipt is refused';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.get_sale_detail(gen_random_uuid());
    raise exception 'FAIL  7c a made-up sale id returned a receipt';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm <> 'That receipt is not available' then
      raise exception 'FAIL  7d a missing id answers differently from a forbidden one: %', sqlerrm;
    end if;
    raise notice 'PASS  7c a missing id and a forbidden one give the same answer -- no probing';
  end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', mixed_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.get_sale_detail(sale_b) is null then
    raise exception 'FAIL  7e a manager cannot open a receipt from the branch they manage';
  end if;
  raise notice 'PASS  7d a manager may open any receipt from the branch they manage';

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.get_sale_detail(sale_a);
    raise exception 'FAIL  7f an account with no POS access opened a receipt';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7e an account with no POS access cannot open a receipt';
  end;
  reset role;

  ------------------------------------------------ 8. no cost in any signature
  for txt in
    select pg_get_function_result(p.oid)
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('get_my_transactions', 'get_branch_transactions', 'get_admin_transactions')
  loop
    if txt ~* '(unit_cost|line_cogs|total_cogs|average_unit_cost|margin|gross_profit|net_profit)' then
      raise exception 'FAIL  8a a transaction function declares a cost column: %', txt;
    end if;
  end loop;
  raise notice 'PASS  8a no transaction function declares cost, COGS, margin or profit';

  -- Including the administrator's. Transactions is an operational module.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select (public.get_sale_detail(sale_a))::text into txt;
  if txt ~* '(cost|cogs|margin|profit)' then
    raise exception 'FAIL  8b an administrator''s receipt carries cost';
  end if;
  raise notice 'PASS  8b even an administrator''s receipt carries no cost';
  reset role;

  ------------------------------------------------------------- 9. paging
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_admin_transactions(null, null, null, 2, 0);
  if n <> 2 then raise exception 'FAIL  9a a page of 2 returned %', n; end if;
  select count(*) into n from public.get_admin_transactions(null, null, null, 2, 2);
  if n <> 1 then raise exception 'FAIL  9b the second page returned %, expected the remaining 1', n; end if;
  select total_count into n from public.get_admin_transactions(null, null, null, 2, 0) limit 1;
  if n <> 3 then raise exception 'FAIL  9c the page reported a total of %, expected 3', n; end if;
  raise notice 'PASS  9a paging returns the page, and the true total alongside it';

  -- An unbounded limit is not on offer.
  select count(*) into n from public.get_admin_transactions(null, null, null, 100000, 0);
  if n > 100 then raise exception 'FAIL  9d the page size was not clamped (% rows)', n; end if;
  raise notice 'PASS  9b an oversized page request is clamped by the server';
  reset role;

  ---------------------------------------- 10. revoked and deactivated lose it
  update public.pos_branch_assignments set status = 'inactive'
    where profile_id = mixed_id and branch_id = branch_a;
  perform set_config('request.jwt.claims', json_build_object('sub', mixed_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_branch_transactions(branch_a);
  if n <> 0 then raise exception 'FAIL 10a a revoked manager still reads the branch list'; end if;
  raise notice 'PASS 10a a revoked assignment loses the branch list';
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set status = 'inactive' where id = cashier_a;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  -- Their own sales remain theirs -- get_my_transactions keys on auth.uid(),
  -- not on POS access -- but the receipt path and every branch view are gone.
  begin
    perform public.get_sale_detail(sale_b);
    raise exception 'FAIL 10b a deactivated account opened somebody else''s receipt';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 10b a deactivated account still cannot reach another''s receipt';
  end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set status = 'active' where id = cashier_a;
  reset role;

  ------------------------------------------------- 11. my_pos_assignments()
  perform set_config('request.jwt.claims', json_build_object('sub', mixed_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.my_pos_assignments();
  -- One was revoked in step 10; the cashier role at B remains.
  if n <> 1 then raise exception 'FAIL 11a my_pos_assignments returned % rows, expected 1 active', n; end if;
  select a.pos_role::text into txt from public.my_pos_assignments() a;
  if txt <> 'cashier' then raise exception 'FAIL 11b the surviving assignment is %, expected cashier', txt; end if;
  raise notice 'PASS 11a my_pos_assignments returns only ACTIVE (branch, role) pairs';

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.my_pos_assignments();
  if n <> 0 then raise exception 'FAIL 11c an administrator has % assignment rows, expected none', n; end if;
  raise notice 'PASS 11b an administrator holds no assignments -- their reach is the role, not a row';
  reset role;

  ------------------------------------------------------------- 12. the ACLs
  select count(*) into n from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('my_pos_assignments', 'get_my_transactions', 'get_branch_transactions',
                      'get_admin_transactions', 'get_sale_detail')
    and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception 'FAIL 12a % transaction functions are executable by anon', n; end if;
  raise notice 'PASS 12a anon holds EXECUTE on none of them';

  if has_function_privilege('authenticated', 'public.pos_sale_receipt(uuid)', 'execute') then
    raise exception 'FAIL 12b the internal receipt helper is reachable by a signed-in account';
  end if;
  raise notice 'PASS 12b the internal Phase 5 receipt helper is still not directly reachable';

  select count(*) into n from information_schema.role_table_grants
  where table_schema = 'public' and table_name in ('pos_sales', 'pos_sale_items')
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  if n <> 0 then raise exception 'FAIL 12c anon/authenticated hold % write grants on the sale tables', n; end if;
  raise notice 'PASS 12c the sale tables remain unwritable outside checkout';

  raise notice '--- all POS transaction contract checks passed ---';
end $$;

rollback;

select 'sales after rollback: ' || count(*)::text as verify from public.pos_sales;
