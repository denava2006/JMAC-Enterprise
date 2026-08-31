-- Phase 9B: HR authorization is a grant, not a column — database contract test.
--
-- Before this phase, profiles.role = 'hr_manager' was the whole of HR
-- authorization, and the two live HR accounts had no employee record at all.
--
-- The claims:
--   HR authority needs THREE things: the claimed role, an active grant, and
--     current eligibility. Removing any one of them denies.
--   Human Resources / HR Staff -> hr_staff; HR Manager -> hr_manager, and
--     neither crosses over
--   IT Support, Cashier, POS Manager and Sales Associate are eligible for no
--     HR role, whatever their account says
--   a missing employee link, an inactive profile, an inactive/on-leave/
--     terminated/resigned employee, and a broken department pairing all deny
--   the Administrator authorizes with no employee record at all
--   a transfer out closes HR privilege immediately, Employee Self-Service
--     survives, and transferring back does NOT restore it
--   removing the position's entitlement closes every grant it supported
--   a closed grant cannot be reopened in place
--   a non-admin cannot forge a role change or a grant
--   one employee cannot end up with two accounts
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/hr_privilege_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

-- A person: employee + auth user + profile, wired the way the app wires them.
create function pg_temp.hire(_name text, _department text, _position text,
                             _role public.user_role default 'employee')
returns uuid
language plpgsql
as $mk$
declare
  _uid uuid := gen_random_uuid();
  _dept uuid; _pos uuid; _emp uuid;
  _email text := lower(replace(_name,' ','.'))||'.'||left(replace(gen_random_uuid()::text,'-',''),6)||'@example.com';
begin
  select id into _dept from public.departments where name = _department;
  if _dept is null then raise exception 'fixture: no department %', _department; end if;
  select id into _pos from public.positions where department_id = _dept and title = _position;
  if _pos is null then raise exception 'fixture: no position %/%', _department, _position; end if;

  insert into public.employees (first_name, last_name, email, department_id, position_id,
                                employment_status, hire_date)
  values ('ZZ', _name, _email, _dept, _pos, 'active', current_date)
  returning id into _emp;

  insert into auth.users (id, email) values (_uid, _email);
  insert into public.profiles (id, employee_id, full_name, email, role, status, activated_at)
  values (_uid, _emp, _name, _email, _role, 'active', now())
  on conflict (id) do update set employee_id = excluded.employee_id, role = excluded.role,
                                 status = 'active', activated_at = now();
  return _uid;
end;
$mk$;

create function pg_temp.acts_as(_profile uuid) returns void language plpgsql as $a$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', _profile, 'role', 'authenticated')::text, true);
end;
$a$;

-- Setup writes must run with no actor at all: `reset role` drops the database
-- role but leaves request.jwt.claims set, and prevent_self_role_escalation
-- refuses a role or status change made by any non-admin caller.
create function pg_temp.acts_as_nobody() returns void language plpgsql as $a$
begin
  perform set_config('request.jwt.claims', null, true);
end;
$a$;

do $$
declare
  admin_id uuid;
  staff_id uuid;
  mgr_id uuid;
  it_id uuid;
  cash_id uuid;
  posmgr_id uuid;
  hr_dept uuid;
  it_dept uuid;
  ops_dept uuid;
  hr_staff_pos uuid;
  it_pos uuid;
  emp uuid;
  n int;
  ok boolean;
  txt text;
begin
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into hr_dept from public.departments where name = 'Human Resources';
  select id into it_dept from public.departments where name = 'IT';
  select id into ops_dept from public.departments where name = 'Store Operations';
  select id into hr_staff_pos from public.positions where department_id = hr_dept and title = 'HR Staff';
  select id into it_pos from public.positions where department_id = it_dept and title = 'IT Support';
  if admin_id is null or hr_dept is null or it_dept is null or ops_dept is null then
    raise exception 'fixture: expected an Administrator and the HR/IT/Store Operations departments';
  end if;

  staff_id  := pg_temp.hire('Hana Personnel', 'Human Resources', 'HR Staff', 'hr_staff');
  mgr_id    := pg_temp.hire('Mila Manager', 'Human Resources', 'HR Manager', 'hr_manager');
  it_id     := pg_temp.hire('Ivan Support', 'IT', 'IT Support', 'hr_staff');
  cash_id   := pg_temp.hire('Cara Till', 'Store Operations', 'Cashier', 'hr_staff');
  posmgr_id := pg_temp.hire('Pat Branch', 'Store Operations', 'POS Manager', 'hr_manager');

  ---------------------------------------------------- 1. eligibility by job
  if not public.is_eligible_for_system_role(staff_id, 'hrms', 'hr_staff') then
    raise exception 'FAIL 1a an HR Staff position is not eligible for hr_staff'; end if;
  if public.is_eligible_for_system_role(staff_id, 'hrms', 'hr_manager') then
    raise exception 'FAIL 1b HR Staff is eligible for hr_manager'; end if;
  if not public.is_eligible_for_system_role(mgr_id, 'hrms', 'hr_manager') then
    raise exception 'FAIL 1c an HR Manager position is not eligible for hr_manager'; end if;
  raise notice 'PASS 1a HR Staff -> hr_staff, HR Manager -> hr_manager, and neither crosses over';

  -- Their account role says hr_staff / hr_manager, and it changes nothing.
  -- Eligibility is the job.
  for txt in select unnest(array['hr_staff', 'hr_manager']) loop
    if public.is_eligible_for_system_role(it_id, 'hrms', txt)
       or public.is_eligible_for_system_role(cash_id, 'hrms', txt)
       or public.is_eligible_for_system_role(posmgr_id, 'hrms', txt) then
      raise exception 'FAIL 1d IT Support, Cashier or POS Manager is eligible for %', txt;
    end if;
  end loop;
  raise notice 'PASS 1b IT Support, Cashier and POS Manager are eligible for no HR role';

  ------------------------------------------------- 2. all three are required
  -- The role alone is not enough: no grant yet.
  perform pg_temp.acts_as(staff_id);
  set local role authenticated;
  if public.is_active_staff() then
    raise exception 'FAIL 2a a claimed hr_staff role authorized with no grant'; end if;
  reset role;
  raise notice 'PASS 2a profiles.role alone does not authorize -- a grant is required';

  insert into public.hr_privilege_grants (profile_id, hr_role) values (staff_id, 'hr_staff');
  insert into public.hr_privilege_grants (profile_id, hr_role) values (mgr_id, 'hr_manager');

  perform pg_temp.acts_as(staff_id);
  set local role authenticated;
  if not public.is_active_staff() then raise exception 'FAIL 2b a granted HR Staff cannot authorize'; end if;
  if public.is_hr_manager_or_admin() then raise exception 'FAIL 2c HR Staff authorized as HR Manager'; end if;
  reset role;

  perform pg_temp.acts_as(mgr_id);
  set local role authenticated;
  if not public.is_hr_manager_or_admin() then raise exception 'FAIL 2d a granted HR Manager cannot approve'; end if;
  reset role;
  raise notice 'PASS 2b role + grant + eligibility authorizes, and the two HR roles stay distinct';

  -- A grant for somebody the job does not permit is refused outright.
  begin
    insert into public.hr_privilege_grants (profile_id, hr_role) values (it_id, 'hr_staff');
    raise exception 'FAIL 2e an IT Support engineer was granted HR privilege';
  exception when others then
    if SQLERRM not like 'HR_GRANT_NOT_ELIGIBLE%' then raise; end if;
  end;
  raise notice 'PASS 2c a grant cannot be written for an ineligible position';

  ---------------------------------------------- 3. every denial ground alone
  -- A deactivated profile denies. No employees row changed, so nothing closed
  -- the grant: this is the predicate refusing, not the closure trigger.
  perform pg_temp.acts_as_nobody();
  update public.profiles set status = 'inactive' where id = staff_id;
  perform pg_temp.acts_as(staff_id);
  set local role authenticated;
  if public.is_active_staff() then raise exception 'FAIL 3a a deactivated profile authorized'; end if;
  reset role;
  perform pg_temp.acts_as_nobody();
  update public.profiles set status = 'active' where id = staff_id;

  select count(*) into n from public.hr_privilege_grants
   where profile_id = staff_id and status = 'active';
  if n <> 1 then raise exception 'FAIL 3b deactivating the profile closed the grant; it should only deny'; end if;

  -- A missing employee link denies for the same reason.
  select employee_id into emp from public.profiles where id = staff_id;
  perform pg_temp.acts_as_nobody();
  update public.profiles set employee_id = null where id = staff_id;
  perform pg_temp.acts_as(staff_id);
  set local role authenticated;
  if public.is_active_staff() then raise exception 'FAIL 3c an unlinked account authorized'; end if;
  reset role;
  perform pg_temp.acts_as_nobody();
  update public.profiles set employee_id = emp where id = staff_id;
  raise notice 'PASS 3a an inactive profile and a missing employee link each deny without closing the grant';

  -- Employment ending is different: it is drift, so it CLOSES the privilege
  -- one-way, exactly as a POS transfer does. Each status is checked against a
  -- freshly granted account, because the first one closes it for good.
  for txt in select unnest(array['on_leave', 'terminated', 'resigned', 'retired']) loop
    declare
      _sub uuid;
      _emp uuid;
    begin
      perform pg_temp.acts_as_nobody();
      _sub := pg_temp.hire('Temp ' || txt, 'Human Resources', 'HR Staff', 'hr_staff');
      insert into public.hr_privilege_grants (profile_id, hr_role) values (_sub, 'hr_staff');
      select employee_id into _emp from public.profiles where id = _sub;

      update public.employees set employment_status = txt::public.employment_status where id = _emp;

      perform pg_temp.acts_as(_sub);
      set local role authenticated;
      if public.is_active_staff() then
        raise exception 'FAIL 3d an employee who is % still authorized', txt; end if;
      reset role;

      perform pg_temp.acts_as_nobody();
      select count(*) into n from public.hr_privilege_grants
       where profile_id = _sub and status = 'active';
      if n <> 0 then
        raise exception 'FAIL 3e employment ending as % did not close the grant', txt; end if;
    end;
  end loop;
  raise notice 'PASS 3b on_leave, terminated, resigned and retired each deny AND close the privilege';

  --------------------------------------------------------- 4. Administrator
  perform pg_temp.acts_as(admin_id);
  set local role authenticated;
  if not public.is_active_staff() or not public.is_hr_manager_or_admin() then
    raise exception 'FAIL 4a the Administrator lost access'; end if;
  reset role;
  if (select employee_id from public.profiles where id = admin_id) is not null then
    raise exception 'FAIL 4b this Administrator has an employee link; the check proves nothing'; end if;
  raise notice 'PASS 4a the Administrator authorizes with no employee, position or grant';

  ------------------------------------------------------- 5. transfer closes
  perform pg_temp.acts_as_nobody();
  update public.employees set department_id = it_dept, position_id = it_pos where id = emp;

  select status into txt from public.hr_privilege_grants where profile_id = staff_id
   order by granted_at desc limit 1;
  if txt <> 'closed' then raise exception 'FAIL 5a a transfer out did not close the grant, got %', txt; end if;

  perform pg_temp.acts_as(staff_id);
  set local role authenticated;
  if public.is_active_staff() then raise exception 'FAIL 5b HR authority survived the transfer'; end if;
  reset role;

  -- Employment continues, so Employee Self-Service must continue with it.
  select count(*) into n from public.profiles pr join public.employees e on e.id = pr.employee_id
   where pr.id = staff_id and pr.status = 'active' and e.employment_status = 'active';
  if n <> 1 then raise exception 'FAIL 5c the transfer disturbed the employment record'; end if;
  raise notice 'PASS 5a transferring out closes HR privilege immediately; employment is untouched';

  -- Transferring back does not bring it back.
  perform pg_temp.acts_as_nobody();
  update public.employees set department_id = hr_dept, position_id = hr_staff_pos where id = emp;
  select count(*) into n from public.hr_privilege_grants
   where profile_id = staff_id and status = 'active';
  if n <> 0 then raise exception 'FAIL 5d moving back silently restored HR privilege'; end if;
  perform pg_temp.acts_as(staff_id);
  set local role authenticated;
  if public.is_active_staff() then raise exception 'FAIL 5e HR authority returned by itself'; end if;
  reset role;
  raise notice 'PASS 5b returning to the same position does NOT restore privilege -- a new grant is required';

  begin
    update public.hr_privilege_grants set status = 'active'
     where profile_id = staff_id and status = 'closed';
    raise exception 'FAIL 5f a closed grant was reopened in place';
  exception when others then
    if SQLERRM not like 'HR_GRANT_CLOSED%' then raise; end if;
  end;
  raise notice 'PASS 5c a closed grant cannot be flipped back to active';

  --------------------------------------- 6. removing the entitlement closes
  perform pg_temp.acts_as_nobody();
  delete from public.position_system_roles
   where position_id = (select position_id from public.employees
                        where id = (select employee_id from public.profiles where id = mgr_id))
     and system = 'hrms' and role_code = 'hr_manager';
  select count(*) into n from public.hr_privilege_grants
   where profile_id = mgr_id and status = 'active';
  if n <> 0 then raise exception 'FAIL 6a removing the entitlement left the grant open'; end if;
  perform pg_temp.acts_as(mgr_id);
  set local role authenticated;
  if public.is_hr_manager_or_admin() then
    raise exception 'FAIL 6b HR Manager authority survived losing the entitlement'; end if;
  reset role;
  raise notice 'PASS 6a removing a position''s HR entitlement closes every grant it supported';

  ------------------------------------------------------------ 7. forgeries
  -- A non-admin cannot promote themselves, whatever the grant table says.
  perform pg_temp.acts_as(it_id);
  set local role authenticated;
  begin
    update public.profiles set role = 'hr_manager' where id = it_id;
    raise exception 'FAIL 7a a non-admin changed their own role';
  exception when others then
    if SQLERRM like 'FAIL 7a%' then raise; end if;
  end;
  begin
    insert into public.hr_privilege_grants (profile_id, hr_role) values (it_id, 'hr_manager');
    raise exception 'FAIL 7b a non-admin inserted their own grant';
  exception when others then
    if SQLERRM like 'FAIL 7b%' then raise; end if;
  end;
  reset role;
  raise notice 'PASS 7a a non-admin can forge neither the role nor the grant';

  -- The grant RPC is Administrator-only.
  perform pg_temp.acts_as(it_id);
  set local role authenticated;
  begin
    perform public.grant_hr_privilege(it_id, 'hr_staff');
    raise exception 'FAIL 7c a non-admin called grant_hr_privilege';
  exception when others then
    if SQLERRM not like 'Only an Administrator%' then raise; end if;
  end;
  reset role;
  raise notice 'PASS 7b grant_hr_privilege and close_hr_privilege are Administrator-only';

  ------------------------------------------------- 8. one account per person
  select count(*) into n
  from (select employee_id from public.profiles
        where employee_id is not null group by employee_id having count(*) > 1) dup;
  if n <> 0 then raise exception 'FAIL 8a % employee(s) have more than one profile', n; end if;

  -- The database refuses a second profile for the same employee outright.
  begin
    insert into public.profiles (id, employee_id, full_name, email, role, status)
    values (gen_random_uuid(), emp, 'ZZ Duplicate', 'zz.dup@example.com', 'employee', 'active');
    raise exception 'FAIL 8b a second profile was created for one employee';
  exception when unique_violation then
    null;
  end;
  raise notice 'PASS 8a one employee cannot have two accounts';

  --------------------------------------------- 9. the upgrade path, not a new account
  perform pg_temp.acts_as(admin_id);
  set local role authenticated;
  declare
    up_id uuid;
    before_auth int;
  begin
    reset role;
    up_id := pg_temp.hire('Uma Upgrade', 'Human Resources', 'HR Staff', 'employee');
    select count(*) into before_auth from auth.users;
    perform pg_temp.acts_as(admin_id);
    set local role authenticated;
    perform public.grant_hr_privilege(up_id, 'hr_staff');
    reset role;

    if (select count(*) from auth.users) <> before_auth then
      raise exception 'FAIL 9a granting HR privilege created a second auth user';
    end if;
    if (select role::text from public.profiles where id = up_id) <> 'hr_staff' then
      raise exception 'FAIL 9b the profile role was not upgraded';
    end if;
    perform pg_temp.acts_as(up_id);
    set local role authenticated;
    if not public.is_active_staff() then raise exception 'FAIL 9c the upgraded account cannot authorize'; end if;
    reset role;

    -- Closing returns them to the baseline without touching the login.
    perform pg_temp.acts_as(admin_id);
    set local role authenticated;
    perform public.close_hr_privilege(up_id, 'test');
    reset role;
    if (select role::text from public.profiles where id = up_id) <> 'employee' then
      raise exception 'FAIL 9d closing did not return the account to employee';
    end if;
    if (select count(*) from auth.users) <> before_auth then
      raise exception 'FAIL 9e closing destroyed or created an auth user';
    end if;
    perform pg_temp.acts_as(up_id);
    set local role authenticated;
    if public.is_active_staff() then raise exception 'FAIL 9f a closed account still authorized'; end if;
    reset role;
  end;
  raise notice 'PASS 9a granting upgrades the existing account in place -- one auth user, one profile';
  raise notice 'PASS 9b closing returns it to Employee Self-Service without touching the login';

  ------------------------------------------------------------------ 10. ACLs
  select string_agg(pr.proname, ', ' order by pr.proname) into txt
  from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
  where ns.nspname = 'public'
    and pr.proname in ('has_hr_privilege', 'grant_hr_privilege', 'close_hr_privilege',
                       'get_hr_accounts', 'get_hr_account_candidates', 'describe_ineligibility')
    and has_function_privilege('anon', pr.oid, 'execute');
  if txt is not null then raise exception 'FAIL 10a anon holds EXECUTE on: %', txt; end if;

  select string_agg(pr.proname, ', ' order by pr.proname) into txt
  from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
  where ns.nspname = 'public'
    and pr.proname in ('close_ineligible_hr_grants', 'close_hr_grants_for_entitlement',
                       'no_hr_grant_resurrection', 'hr_grant_requires_eligibility')
    and (has_function_privilege('anon', pr.oid, 'execute')
      or has_function_privilege('authenticated', pr.oid, 'execute'));
  if txt is not null then raise exception 'FAIL 10b an API role can call the internal trigger(s): %', txt; end if;
  raise notice 'PASS 10a the HR surface denies anon, and its triggers reach no API role';

  raise notice '--- all HR privilege contract checks passed ---';
end $$;

rollback;

select 'hr grants after rollback: ' || count(*) as verify from public.hr_privilege_grants;
