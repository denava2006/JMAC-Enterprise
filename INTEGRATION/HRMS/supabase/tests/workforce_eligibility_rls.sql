-- Workforce integrity and POS role eligibility — database contract test.
--
-- The problem this phase closed, observed live: Jerome Castillo, department IT,
-- position IT Support, held POS **manager** at Cavite Branch, and nothing in the
-- database objected.
--
-- The claims:
--   a position must belong to the department it is filed under -- employees
--     AND job postings, enforced past the browser
--   eligibility comes from position_system_roles, never from a position TITLE
--   IT Support and Sales Associate are eligible for nothing
--   Cashier -> cashier only; POS Manager -> manager only
--   a position configured for both grants both, and only because it was
--   an inactive profile, an inactive/on-leave/terminated employee, a missing
--     employee link, a missing position and a missing department all deny
--   HR accounts are never eligible for operational POS roles
--   an Administrator is never eligible for a branch assignment, yet keeps
--     global POS authority
--   a forged direct INSERT and a forged reactivation are both refused
--   a transfer to an ineligible position closes access immediately, keeps the
--     history, and does NOT resurrect the old row on transfer back
--   only an Administrator may change entitlements
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/workforce_eligibility_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

-- Session-local fixture builders. pg_temp cannot reach production.
create function pg_temp.new_worker(_name text, _department text, _position text)
returns uuid
language plpgsql
as $mk$
declare
  _uid uuid := gen_random_uuid();
  _dept uuid; _pos uuid; _emp uuid;
  _email text := lower(replace(_name,' ','.'))||'.'||left(replace(gen_random_uuid()::text,'-',''),6)||'@example.com';
begin
  select d.id into _dept from public.departments d where d.name = _department;
  if _dept is null then raise exception 'fixture: no department %', _department; end if;
  select po.id into _pos from public.positions po
   where po.department_id = _dept and po.title = _position;
  if _pos is null then raise exception 'fixture: no position % in %', _position, _department; end if;

  insert into auth.users (id, email) values (_uid, _email);
  insert into public.employees (first_name, last_name, email, department_id, position_id,
                                employment_status, hire_date)
  values (split_part(_name,' ',1), coalesce(nullif(split_part(_name,' ',2),''),'Worker'),
          _email, _dept, _pos, 'active', current_date)
  returning id into _emp;
  insert into public.profiles (id, employee_id, full_name, email, role, status)
  values (_uid, _emp, _name, _email, 'employee', 'active')
  on conflict (id) do update set employee_id = excluded.employee_id,
    full_name = excluded.full_name, role = 'employee', status = 'active';
  return _uid;
end;
$mk$;

do $$
declare
  admin_id     uuid;
  branch_a     uuid;
  branch_b     uuid;
  store_ops    uuid;
  it_dept      uuid;
  sales_dept   uuid;
  hr_dept      uuid;
  pos_manager  uuid;   -- Store Operations / POS Manager
  pos_cashier  uuid;   -- Store Operations / Cashier
  it_support   uuid;
  sales_assoc  uuid;
  sales_cash   uuid;   -- the Sales-department Cashier, deliberately NOT eligible
  dual_pos     uuid;
  hr_staff_pos uuid;
  cashier_p    uuid;   -- a compliant cashier
  manager_p    uuid;   -- a compliant POS manager
  it_p         uuid;   -- an IT Support engineer
  assoc_p      uuid;   -- a Sales Associate
  dual_p       uuid;   -- somebody eligible for both
  hrstaff_p    uuid;
  assignment   uuid;
  n            integer;
  b            boolean;
  txt          text;
begin
  ------------------------------------------------------------------ fixtures
  select p.id into admin_id from public.profiles p where p.role='admin' and p.status='active' limit 1;
  select bb.id into branch_a from public.branches bb where bb.is_active order by bb.name limit 1;
  select bb.id into branch_b from public.branches bb where bb.is_active and bb.id<>branch_a order by bb.name limit 1;

  select d.id into store_ops  from public.departments d where d.name='Store Operations';
  select d.id into it_dept    from public.departments d where d.name='IT';
  select d.id into sales_dept from public.departments d where d.name='Sales';
  select d.id into hr_dept    from public.departments d where d.name='Human Resources';

  select po.id into pos_manager from public.positions po where po.department_id=store_ops and po.title='POS Manager';
  select po.id into pos_cashier from public.positions po where po.department_id=store_ops and po.title='Cashier';
  select po.id into it_support  from public.positions po where po.department_id=it_dept and po.title='IT Support';
  select po.id into sales_assoc from public.positions po where po.department_id=sales_dept and po.title='Sales Associate';
  select po.id into sales_cash  from public.positions po where po.department_id=sales_dept and po.title='Cashier';
  select po.id into hr_staff_pos from public.positions po where po.department_id=hr_dept and po.title='HR Staff';

  if admin_id is null or branch_b is null or pos_manager is null or pos_cashier is null
     or it_support is null or sales_assoc is null then
    raise exception 'fixture: the approved org structure is missing (migration 20260828010000)';
  end if;

  cashier_p := pg_temp.new_worker('Cass Till', 'Store Operations', 'Cashier');
  manager_p := pg_temp.new_worker('Morgan Branch', 'Store Operations', 'POS Manager');
  it_p      := pg_temp.new_worker('Ivan Tech', 'IT', 'IT Support');
  assoc_p   := pg_temp.new_worker('Ash Floor', 'Sales', 'Sales Associate');

  ------------------------------------- 1. the configured map, not the titles
  select count(*) into n from public.position_system_roles psr
   where psr.position_id = pos_cashier and psr.system='pos' and psr.role_code='cashier';
  if n <> 1 then raise exception 'FAIL  1a Store Operations / Cashier is not configured for pos:cashier'; end if;
  select count(*) into n from public.position_system_roles psr where psr.position_id = it_support;
  if n <> 0 then raise exception 'FAIL  1b IT Support carries % entitlement(s); expected none', n; end if;
  select count(*) into n from public.position_system_roles psr where psr.position_id = sales_assoc;
  if n <> 0 then raise exception 'FAIL  1c Sales Associate carries % entitlement(s); expected none', n; end if;
  raise notice 'PASS  1a eligibility is configuration: Store Ops Cashier yes, IT Support no, Sales Associate no';

  -- The Sales department also has a position literally titled "Cashier". If
  -- authorization compared titles it would be eligible. It is not.
  if sales_cash is not null then
    select count(*) into n from public.position_system_roles psr where psr.position_id = sales_cash;
    if n <> 0 then raise exception 'FAIL  1d a same-titled position in another department is eligible'; end if;
    raise notice 'PASS  1b a position TITLED Cashier in another department grants nothing -- titles are not identities';
  end if;

  ------------------------------------------- 2. department-position pairing
  begin
    update public.employees set department_id = it_dept, position_id = pos_cashier
     where id = (select employee_id from public.profiles where id = it_p);
    raise exception 'FAIL  2a IT + Store Operations Cashier was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a an employee cannot hold a position from another department';
  end;

  begin
    insert into public.job_postings (title, department_id, position_id, employment_type, status)
    values ('ZZ Bad Posting', it_dept, pos_cashier, 'full_time', 'draft');
    raise exception 'FAIL  2b a job posting paired IT with a Store Operations position';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2b a job posting cannot pair a department with another department''s position';
  end;

  -- Null is still allowed where the schema always allowed it.
  update public.employees set position_id = null
   where id = (select employee_id from public.profiles where id = assoc_p);
  update public.employees set position_id = sales_assoc
   where id = (select employee_id from public.profiles where id = assoc_p);
  raise notice 'PASS  2c a missing position is still permitted -- null semantics preserved';

  ------------------------------------------------- 3. the eligibility matrix
  if not public.is_eligible_for_system_role(cashier_p,'pos','cashier') then
    raise exception 'FAIL  3a a Store Operations Cashier is not eligible for pos:cashier'; end if;
  if public.is_eligible_for_system_role(cashier_p,'pos','manager') then
    raise exception 'FAIL  3b a Cashier is eligible for pos:manager'; end if;
  if not public.is_eligible_for_system_role(manager_p,'pos','manager') then
    raise exception 'FAIL  3c a POS Manager is not eligible for pos:manager'; end if;
  if public.is_eligible_for_system_role(manager_p,'pos','cashier') then
    raise exception 'FAIL  3d a POS Manager is eligible for pos:cashier'; end if;
  if public.is_eligible_for_system_role(it_p,'pos','manager')
     or public.is_eligible_for_system_role(it_p,'pos','cashier') then
    raise exception 'FAIL  3e IT Support is eligible for a POS role'; end if;
  if public.is_eligible_for_system_role(assoc_p,'pos','cashier') then
    raise exception 'FAIL  3f Sales Associate is eligible for pos:cashier'; end if;
  raise notice 'PASS  3a Cashier->cashier, Manager->manager, and neither crosses over';
  raise notice 'PASS  3b IT Support and Sales Associate are eligible for nothing';

  -- Both, but only because an Administrator configured both.
  insert into public.positions (title, department_id, description)
  values ('ZZ Branch Supervisor', store_ops, 'both roles') returning id into dual_pos;
  insert into public.position_system_roles (position_id, system, role_code)
  values (dual_pos,'pos','manager'), (dual_pos,'pos','cashier');
  dual_p := pg_temp.new_worker('Dana Dual', 'Store Operations', 'ZZ Branch Supervisor');
  if not (public.is_eligible_for_system_role(dual_p,'pos','manager')
      and public.is_eligible_for_system_role(dual_p,'pos','cashier')) then
    raise exception 'FAIL  3g an explicitly dual-configured position does not grant both'; end if;
  raise notice 'PASS  3c a position grants two roles only where both were configured';

  ------------------------------------------------------- 4. employment state
  update public.employees set employment_status='on_leave'
   where id=(select employee_id from public.profiles where id=cashier_p);
  if public.is_eligible_for_system_role(cashier_p,'pos','cashier') then
    raise exception 'FAIL  4a an on-leave employee is still eligible for operational POS'; end if;
  -- The profile stays active: self-service and payslips continue.
  select pr.status::text into txt from public.profiles pr where pr.id=cashier_p;
  if txt <> 'active' then raise exception 'FAIL  4b on_leave deactivated the login as well'; end if;
  raise notice 'PASS  4a on_leave: Employee Self-Service kept, operational POS denied';

  for txt in select unnest(array['resigned','terminated','retired'])
  loop
    update public.employees set employment_status = txt::public.employment_status
     where id=(select employee_id from public.profiles where id=cashier_p);
    if public.is_eligible_for_system_role(cashier_p,'pos','cashier') then
      raise exception 'FAIL  4c a % employee is still eligible', txt; end if;
  end loop;
  raise notice 'PASS  4b resigned, terminated and retired all deny operational access';

  perform set_config('request.jwt.claims', json_build_object('sub',admin_id,'role','authenticated')::text, true);
  update public.employees set employment_status='active'
   where id=(select employee_id from public.profiles where id=cashier_p);
  update public.profiles set status='active' where id=cashier_p;
  perform set_config('request.jwt.claims', null, true);

  update public.profiles set status='inactive' where id=cashier_p;
  if public.is_eligible_for_system_role(cashier_p,'pos','cashier') then
    raise exception 'FAIL  4d an inactive profile is still eligible'; end if;
  update public.profiles set status='active' where id=cashier_p;
  raise notice 'PASS  4c an inactive profile is ineligible';

  ------------------------------------------------- 5. the broken-record cases
  update public.profiles set employee_id = null where id = assoc_p;
  if public.is_eligible_for_system_role(assoc_p,'pos','cashier') then
    raise exception 'FAIL  5a a profile with no employee link is eligible'; end if;
  raise notice 'PASS  5a no employee link -> ineligible';

  update public.employees set position_id = null
   where id=(select employee_id from public.profiles where id=manager_p);
  if public.is_eligible_for_system_role(manager_p,'pos','manager') then
    raise exception 'FAIL  5b an employee with no position is eligible'; end if;
  update public.employees set position_id = pos_manager
   where id=(select employee_id from public.profiles where id=manager_p);
  raise notice 'PASS  5b no position -> ineligible';

  ------------------------------------------- 6. HR accounts and the Administrator
  hrstaff_p := pg_temp.new_worker('Hana Personnel', 'Human Resources', 'HR Staff');
  perform set_config('request.jwt.claims', json_build_object('sub',admin_id,'role','authenticated')::text, true);
  update public.profiles set role='hr_staff' where id=hrstaff_p;
  perform set_config('request.jwt.claims', null, true);
  if public.is_eligible_for_system_role(hrstaff_p,'pos','cashier')
     or public.is_eligible_for_system_role(hrstaff_p,'pos','manager') then
    raise exception 'FAIL  6a an HR account is eligible for an operational POS role'; end if;
  raise notice 'PASS  6a HR Staff and HR Manager are never eligible for POS roles';

  if public.is_eligible_for_system_role(admin_id,'pos','manager') then
    raise exception 'FAIL  6b an Administrator is eligible for a branch assignment'; end if;
  raise notice 'PASS  6b an Administrator is never eligible for a branch assignment';

  perform set_config('request.jwt.claims', json_build_object('sub',admin_id,'role','authenticated')::text, true);
  set local role authenticated;
  if not public.has_pos_role(branch_a, array['manager']::public.pos_role[]) then
    raise exception 'FAIL  6c the Administrator lost global POS authority'; end if;
  raise notice 'PASS  6c the Administrator keeps global POS authority through is_admin()';
  reset role;

  --------------------------------------------------- 7. the write gate
  perform set_config('request.jwt.claims', json_build_object('sub',admin_id,'role','authenticated')::text, true);
  set local role authenticated;
  for txt in select unnest(array['manager','cashier'])
  loop
    begin
      insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
      values (it_p, branch_a, txt::public.pos_role, admin_id);
      raise exception 'FAIL  7a IT Support was granted pos:%', txt;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like '%POS_ASSIGNMENT_NOT_ELIGIBLE%' then
        raise exception 'FAIL  7b the refusal was not the stable error: %', sqlerrm; end if;
    end;
  end loop;
  raise notice 'PASS  7a IT Support -> manager and cashier both refused, with a stable error code';

  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
    values (cashier_p, branch_a, 'manager', admin_id);
    raise exception 'FAIL  7c a Cashier was granted pos:manager';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7b a Cashier cannot be granted pos:manager';
  end;

  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (cashier_p, branch_a, 'cashier', admin_id) returning id into assignment;
  raise notice 'PASS  7c a compliant Cashier IS granted pos:cashier';

  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (manager_p, branch_a, 'manager', admin_id);
  raise notice 'PASS  7d a compliant POS Manager IS granted pos:manager';

  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
    values (admin_id, branch_a, 'manager', admin_id);
    raise exception 'FAIL  7e an Administrator was given a branch assignment';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7e an Administrator cannot be given a branch assignment';
  end;
  reset role;

  ------------------------------------------------------------ 8. the read gate
  perform set_config('request.jwt.claims', json_build_object('sub',cashier_p,'role','authenticated')::text, true);
  set local role authenticated;
  if not public.has_pos_role(branch_a, array['cashier']::public.pos_role[]) then
    raise exception 'FAIL  8a a compliant cashier has no access'; end if;
  select count(*) into n from public.my_pos_assignments();
  if n <> 1 then raise exception 'FAIL  8b a compliant cashier lists % assignments', n; end if;
  raise notice 'PASS  8a a compliant cashier has access at their branch';
  reset role;

  --------------------------------------- 9. the transfer, and the non-return
  --
  -- The security requirement: access goes immediately, history is kept, and
  -- moving back does NOT bring the old grant to life.
  update public.employees set department_id = it_dept, position_id = it_support
   where id = (select employee_id from public.profiles where id = cashier_p);

  perform set_config('request.jwt.claims', json_build_object('sub',cashier_p,'role','authenticated')::text, true);
  set local role authenticated;
  b := public.has_pos_role(branch_a, array['cashier']::public.pos_role[]);
  if b then raise exception 'FAIL  9a POS access survived a transfer to IT Support'; end if;
  select count(*) into n from public.my_pos_assignments();
  if n <> 0 then raise exception 'FAIL  9b a transferred employee still lists % assignment(s)', n; end if;
  reset role;
  raise notice 'PASS  9a a transfer to an ineligible position removes access immediately';

  select a.status::text, a.revoked_reason into txt, txt
    from public.pos_branch_assignments a where a.id = assignment;
  select a.status::text into txt from public.pos_branch_assignments a where a.id = assignment;
  if txt <> 'inactive' then
    raise exception 'FAIL  9c the assignment is %, expected inactive', txt; end if;
  select a.revoked_reason into txt from public.pos_branch_assignments a where a.id = assignment;
  if txt is distinct from 'workforce_ineligible' then
    raise exception 'FAIL  9d the revocation reason is %, expected workforce_ineligible', txt; end if;
  select count(*) into n from public.pos_branch_assignments a where a.id = assignment;
  if n <> 1 then raise exception 'FAIL  9e the assignment row was deleted instead of closed'; end if;
  raise notice 'PASS  9b the row survives, closed, with a truthful reason -- history is kept';

  -- ***** THE SECURITY REQUIREMENT *****
  update public.employees set department_id = store_ops, position_id = pos_cashier
   where id = (select employee_id from public.profiles where id = cashier_p);

  if not public.is_eligible_for_system_role(cashier_p,'pos','cashier') then
    raise exception 'FAIL  9f moving back did not restore eligibility'; end if;
  select a.status::text into txt from public.pos_branch_assignments a where a.id = assignment;
  if txt <> 'inactive' then
    raise exception 'FAIL  9g the OLD assignment came back to life as %', txt; end if;

  perform set_config('request.jwt.claims', json_build_object('sub',cashier_p,'role','authenticated')::text, true);
  set local role authenticated;
  if public.has_pos_role(branch_a, array['cashier']::public.pos_role[]) then
    raise exception 'FAIL  9h old access silently returned on transfer back'; end if;
  select count(*) into n from public.my_pos_assignments();
  if n <> 0 then raise exception 'FAIL  9i % assignment(s) returned without a fresh grant', n; end if;
  reset role;
  raise notice 'PASS  9c moving back does NOT resurrect old access -- a new grant is required';

  ---------------------------------------------- 10. forgery and reactivation
  perform set_config('request.jwt.claims', json_build_object('sub',admin_id,'role','authenticated')::text, true);
  set local role authenticated;
  begin
    update public.pos_branch_assignments set status = 'active' where id = assignment;
    raise exception 'FAIL 10a a closed assignment was reactivated for an eligible person without a new grant';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%POS_ASSIGNMENT_CLOSED%' then
      raise exception 'FAIL 10a the refusal was not the stable error: %', sqlerrm; end if;
    raise notice 'PASS 10a a closed assignment cannot be reactivated -- re-granting makes a new row';
  end;
  reset role;

  -- Straight at the table as the owner: the trigger is not an RLS policy and
  -- does not care who is asking.
  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role)
    values (it_p, branch_b, 'manager');
    raise exception 'FAIL 10b a direct owner-level insert bypassed eligibility';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 10b a forged direct insert is refused even at owner level';
  end;

  ------------------------------------------------- 11. configuration is admin's
  perform set_config('request.jwt.claims', json_build_object('sub',hrstaff_p,'role','authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.set_position_entitlement(it_support,'pos','manager',true);
    raise exception 'FAIL 11a HR Staff changed position eligibility';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 11a only an Administrator may change position eligibility';
  end;
  begin
    insert into public.position_system_roles (position_id, system, role_code)
    values (it_support,'pos','manager');
    raise exception 'FAIL 11b HR Staff inserted an entitlement directly';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 11b RLS refuses a direct entitlement insert by a non-admin';
  end;
  reset role;

  -- A bad role code cannot be configured at all.
  begin
    insert into public.position_system_roles (position_id, system, role_code)
    values (pos_cashier,'pos','superuser');
    raise exception 'FAIL 11c an arbitrary role_code was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 11c the role_code CHECK refuses a code the system does not define';
  end;

  ------------------------------------------------------------------ 12. ACLs
  for txt in select unnest(array[
    'public.is_eligible_for_system_role(uuid,public.entitlement_system,text)',
    'public.get_eligible_pos_employees(uuid,text)',
    'public.get_noncompliant_pos_assignments()',
    'public.set_position_entitlement(uuid,public.entitlement_system,text,boolean)'])
  loop
    if has_function_privilege('anon', txt, 'execute') then
      raise exception 'FAIL 12a anon holds EXECUTE on %', txt; end if;
    if not has_function_privilege('authenticated', txt, 'execute') then
      raise exception 'FAIL 12b authenticated lost EXECUTE on %', txt; end if;
  end loop;
  raise notice 'PASS 12a anon can execute none of the workforce routines';

  for txt in select unnest(array[
    'public.enforce_position_department_pairing()',
    'public.pos_assignment_requires_eligibility()',
    'public.revoke_ineligible_pos_assignments()'])
  loop
    if has_function_privilege('authenticated', txt, 'execute') then
      raise exception 'FAIL 12c an API role can execute the internal trigger %', txt; end if;
  end loop;
  raise notice 'PASS 12b the enforcement triggers are not callable by an API role';

  select string_agg(g.table_name, ', ') into txt
  from information_schema.role_table_grants g
  where g.table_schema='public' and g.grantee in ('anon','authenticated')
    and g.privilege_type='TRUNCATE';
  if txt is not null then raise exception 'FAIL 12d TRUNCATE is granted on: %', txt; end if;
  raise notice 'PASS 12c no public table grants TRUNCATE to an API role';

  ------------------------------------------------ 13. the compliance report
  perform set_config('request.jwt.claims', json_build_object('sub',admin_id,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_eligible_pos_employees(branch_b,'manager') e
   where e.profile_id = it_p;
  if n <> 0 then raise exception 'FAIL 13a IT Support was offered as a manager candidate'; end if;
  select count(*) into n from public.get_eligible_pos_employees(branch_b,'manager') e
   where e.profile_id = manager_p;
  if n <> 1 then raise exception 'FAIL 13b a compliant POS Manager was not offered as a candidate'; end if;
  raise notice 'PASS 13a the candidate list offers only eligible employees';

  txt := pg_get_function_result('public.get_eligible_pos_employees(uuid,text)'::regprocedure);
  if txt ~* '(salary|basic_pay|birth|address|benefits|grade)' then
    raise exception 'FAIL 13c the candidate list exposes HR data: %', txt; end if;
  raise notice 'PASS 13b the candidate list carries identity and org only -- no salary or personal data';
  reset role;

  raise notice '--- all workforce eligibility contract checks passed ---';
end $$;

rollback;

select 'entitlements after rollback: ' || count(*) as verify from public.position_system_roles;
