-- System Access at position creation — database contract test.
--
-- The claims:
--   a position created with no System Access has NO entitlement rows, which is
--     exactly what "Employee Self-Service only" means -- 'employee' is never
--     written as an entitlement
--   HR Staff and HR Manager entitlements save, and each replaces rather than
--     accumulates within its system
--   POS cashier / manager still save the same way, and setting one system
--     leaves the others untouched
--   'admin', 'administrator' and 'employee' are refused by name
--   a role from the wrong system, an unknown system, and a malformed shape are
--     all refused
--   a malformed proposal is refused at SUBMISSION, so a reviewer never sees a
--     request that cannot be applied
--   an APPROVED position request creates the position and its eligibility in
--     one transaction
--   a REJECTED position request leaves NO position and NO entitlement residue
--   the shared writer is callable by no API role
--   only an HR Manager or Administrator may create a position directly
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/position_system_access_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

-- Phase 9B: an HR account is no longer a role on a bare profile. It needs a
-- workforce identity -- an employee in Human Resources holding the position
-- that confers the role -- and an explicit grant. A fixture that skips any of
-- that is refused by is_active_staff(), which is the rule working, not a bug.
create function pg_temp.new_account(_name text, _role public.user_role)
returns uuid
language plpgsql
as $mk$
declare
  _uid uuid := gen_random_uuid();
  _email text := lower(replace(_name,' ','.'))||'.'||left(replace(gen_random_uuid()::text,'-',''),6)||'@example.com';
  _dept uuid;
  _pos uuid;
  _emp uuid;
begin
  insert into auth.users (id, email) values (_uid, _email);
  insert into public.profiles (id, full_name, email, role, status)
  values (_uid, _name, _email, _role, 'active')
  on conflict (id) do update set role = excluded.role, status = 'active', full_name = excluded.full_name;

  if _role in ('hr_staff', 'hr_manager') then
    select id into _dept from public.departments where lower(name) = 'human resources';
    select id into _pos from public.positions
     where department_id = _dept
       and lower(title) = case _role when 'hr_manager' then 'hr manager' else 'hr staff' end;
    if _dept is null or _pos is null then
      raise exception 'fixture: Human Resources / % position is missing', _role;
    end if;

    insert into public.employees (first_name, last_name, email, department_id, position_id,
                                  employment_status, hire_date)
    values ('ZZ', _name, _email, _dept, _pos, 'active', current_date)
    returning id into _emp;

    update public.profiles set employee_id = _emp where id = _uid;

    -- An HR-entitled position may already have granted automatically when the
    -- account was linked. One active grant per account is the rule, so the
    -- fixture makes sure it is starting from none.
    delete from public.hr_privilege_grants where profile_id = _uid;

    insert into public.hr_privilege_grants (profile_id, hr_role, status)
    values (_uid, _role::text, 'active');
  end if;

  return _uid;
end;
$mk$;

do $$
declare
  admin_id uuid;
  hrm_id uuid;
  staff_id uuid;
  it_dept uuid;
  hr_dept uuid;
  ops_dept uuid;
  pid uuid;
  req uuid;
  n int;
  txt text;
begin
  select id into it_dept from public.departments where name = 'IT';
  select id into hr_dept from public.departments where name = 'Human Resources';
  select id into ops_dept from public.departments where name = 'Store Operations';
  if it_dept is null or hr_dept is null or ops_dept is null then
    raise exception 'fixture: expected IT, Human Resources and Store Operations departments';
  end if;

  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  if admin_id is null then raise exception 'fixture: no active Administrator'; end if;
  hrm_id   := pg_temp.new_account('ZZ Access Manager', 'hr_manager');
  staff_id := pg_temp.new_account('ZZ Access Staff', 'hr_staff');

  ---------------------------------------------------------- 1. the HR registry
  -- The seeded mappings this task was to complete.
  select count(*) into n
  from public.position_system_roles psr
  join public.positions p on p.id = psr.position_id
  join public.departments d on d.id = p.department_id
  where d.name = 'Human Resources' and p.title = 'HR Staff'
    and psr.system = 'hrms' and psr.role_code = 'hr_staff';
  if n <> 1 then raise exception 'FAIL 1a HR Staff is not mapped to hrms:hr_staff'; end if;

  select count(*) into n
  from public.position_system_roles psr
  join public.positions p on p.id = psr.position_id
  join public.departments d on d.id = p.department_id
  where d.name = 'Human Resources' and p.title = 'HR Manager'
    and psr.system = 'hrms' and psr.role_code = 'hr_manager';
  if n <> 1 then raise exception 'FAIL 1b HR Manager is not mapped to hrms:hr_manager'; end if;
  raise notice 'PASS 1a HR Staff and HR Manager carry their hrms entitlements';

  -- Nothing else acquired one. Title text must never imply eligibility: the
  -- Sales department also has a position titled "Cashier", and it is not
  -- eligible for anything.
  select coalesce(string_agg(p.title || '/' || d.name, ', '), '') into txt
  from public.position_system_roles psr
  join public.positions p on p.id = psr.position_id
  join public.departments d on d.id = p.department_id
  where (d.name, p.title) not in
    (('Human Resources','HR Staff'), ('Human Resources','HR Manager'),
     ('Store Operations','Cashier'), ('Store Operations','POS Manager'),
     -- FMS F1. Listed one by one on purpose: this check exists so that a new
     -- entitlement has to be declared here by somebody, rather than appearing
     -- in the registry unnoticed.
     ('Finance','Finance Staff'), ('Finance','Finance Manager'),
     ('Finance','Accountant'));
  if txt <> '' then raise exception 'FAIL 1c unexpected positions hold entitlements: %', txt; end if;

  -- Minted here rather than assumed. This previously read the Sales
  -- department's own "Cashier", which an Administrator later deleted through
  -- the app -- leaving the count trivially 0 and the assertion passing without
  -- testing anything.
  declare
    same_title uuid;
  begin
    insert into public.positions (title, department_id)
    select 'Cashier', d.id from public.departments d where d.name = 'Sales'
    returning id into same_title;
    if same_title is null then
      raise exception 'FAIL 1c fixture: no Sales department to file a same-titled position under';
    end if;
    select count(*) into n from public.position_system_roles where position_id = same_title;
    if n <> 0 then
      raise exception 'FAIL 1c a same-titled Cashier in another department gained POS eligibility';
    end if;
    delete from public.positions where id = same_title;
  end;
  raise notice 'PASS 1b IT Support, Cleaner, Sales Associate and a same-titled Cashier hold nothing';

  ------------------------------------------------- 2. Employee is the baseline
  insert into public.positions (title, department_id) values ('ZZ Probe Plain', it_dept) returning id into pid;
  perform public.apply_position_system_access(pid, null);
  select count(*) into n from public.position_system_roles where position_id = pid;
  if n <> 0 then raise exception 'FAIL 2a a position with no access got % rows', n; end if;

  perform public.apply_position_system_access(pid, '{"hrms":null,"pos":null,"fms":null}'::jsonb);
  select count(*) into n from public.position_system_roles where position_id = pid;
  if n <> 0 then raise exception 'FAIL 2b explicit "None" wrote % rows', n; end if;

  -- The absence of a row is the meaning. If 'employee' were ever written the
  -- distinction between "no privileged access" and "configured" would vanish.
  select count(*) into n from public.position_system_roles where role_code = 'employee';
  if n <> 0 then raise exception 'FAIL 2c an employee entitlement row exists'; end if;
  raise notice 'PASS 2a no access means no rows -- Employee Self-Service is never an entitlement';

  ------------------------------------------------------- 3. saving each role
  perform public.apply_position_system_access(pid, '{"hrms":"hr_staff"}'::jsonb);
  select string_agg(system||':'||role_code, ',') into txt
    from public.position_system_roles where position_id = pid;
  if txt <> 'hrms:hr_staff' then raise exception 'FAIL 3a hr_staff not saved, got %', txt; end if;

  perform public.apply_position_system_access(pid, '{"hrms":"hr_manager"}'::jsonb);
  select string_agg(system||':'||role_code, ',') into txt
    from public.position_system_roles where position_id = pid;
  if txt <> 'hrms:hr_manager' then
    raise exception 'FAIL 3b changing the HRMS role should replace, got %', txt; end if;
  raise notice 'PASS 3a hr_staff and hr_manager save, and one replaces the other';

  perform public.apply_position_system_access(pid, '{"pos":"cashier"}'::jsonb);
  select string_agg(system||':'||role_code, ', ' order by system) into txt
    from public.position_system_roles where position_id = pid;
  if txt <> 'hrms:hr_manager, pos:cashier' then
    raise exception 'FAIL 3c setting POS disturbed HRMS, got %', txt; end if;

  perform public.apply_position_system_access(pid, '{"pos":"manager"}'::jsonb);
  select string_agg(role_code, ',') into txt
    from public.position_system_roles where position_id = pid and system = 'pos';
  if txt <> 'manager' then raise exception 'FAIL 3d pos manager not saved, got %', txt; end if;
  raise notice 'PASS 3b cashier and manager save; each system is set independently';

  ----------------------------------------------------------- 4. what is refused
  begin
    perform public.apply_position_system_access(pid, '{"hrms":"admin"}'::jsonb);
    raise exception 'FAIL 4a admin was accepted as an entitlement';
  exception when others then
    if SQLERRM not like 'ENTITLEMENT_NOT_GRANTABLE%' then raise; end if;
  end;
  begin
    perform public.apply_position_system_access(pid, '{"hrms":"administrator"}'::jsonb);
    raise exception 'FAIL 4b administrator was accepted';
  exception when others then
    if SQLERRM not like 'ENTITLEMENT_NOT_GRANTABLE%' then raise; end if;
  end;
  begin
    perform public.apply_position_system_access(pid, '{"hrms":"employee"}'::jsonb);
    raise exception 'FAIL 4c employee was accepted as an entitlement';
  exception when others then
    if SQLERRM not like 'ENTITLEMENT_NOT_GRANTABLE%' then raise; end if;
  end;
  raise notice 'PASS 4a admin, administrator and employee are refused by name';

  begin
    perform public.apply_position_system_access(pid, '{"pos":"hr_staff"}'::jsonb);
    raise exception 'FAIL 4d a role from another system was accepted';
  exception when others then
    if SQLERRM not like 'ENTITLEMENT_INVALID_ROLE%' then raise; end if;
  end;
  begin
    perform public.apply_position_system_access(pid, '{"payroll":"x"}'::jsonb);
    raise exception 'FAIL 4e an unknown system was accepted';
  exception when others then
    if SQLERRM not like 'ENTITLEMENT_UNKNOWN_SYSTEM%' then raise; end if;
  end;
  begin
    perform public.apply_position_system_access(pid, '{"hrms":["hr_staff","hr_manager"]}'::jsonb);
    raise exception 'FAIL 4f an array of roles was accepted for one system';
  exception when others then
    if SQLERRM not like 'ENTITLEMENT_INVALID_SHAPE%' then raise; end if;
  end;
  raise notice 'PASS 4b wrong system, unknown system and malformed shape are refused';

  delete from public.positions where id = pid;

  --------------------------------------- 5. refused at submission, not approval
  perform set_config('request.jwt.claims',
    json_build_object('sub', staff_id, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.change_requests (target_table, operation, payload, summary, requested_by, system_access)
    values ('positions', 'create',
            jsonb_build_object('title','ZZ Bad', 'department_id', it_dept),
            'ZZ bad request', staff_id, '{"hrms":"admin"}'::jsonb);
    raise exception 'FAIL 5a a request proposing admin was queued';
  exception when others then
    if SQLERRM not like 'ENTITLEMENT_NOT_GRANTABLE%' then raise; end if;
  end;
  begin
    insert into public.change_requests (target_table, operation, payload, summary, requested_by, system_access)
    values ('departments', 'create', jsonb_build_object('name','ZZ Dept'),
            'ZZ dept', staff_id, '{"hrms":"hr_staff"}'::jsonb);
    raise exception 'FAIL 5b system access was allowed on a non-position request';
  exception when others then
    if SQLERRM not like 'SYSTEM_ACCESS_NOT_APPLICABLE%' then raise; end if;
  end;
  reset role;
  raise notice 'PASS 5a a malformed proposal is refused at submission, before any review';

  ------------------------------------------- 6. approval applies both, atomically
  perform set_config('request.jwt.claims',
    json_build_object('sub', staff_id, 'role','authenticated')::text, true);
  set local role authenticated;
  insert into public.change_requests (target_table, operation, payload, summary, requested_by, system_access)
  values ('positions', 'create',
          jsonb_build_object('title','ZZ Requested HR', 'department_id', hr_dept),
          'Create position: ZZ Requested HR', staff_id, '{"hrms":"hr_staff"}'::jsonb)
  returning id into req;
  reset role;

  -- Nothing exists yet: a pending request is a proposal, not a change.
  select count(*) into n from public.positions where title = 'ZZ Requested HR';
  if n <> 0 then raise exception 'FAIL 6a a pending request already created the position'; end if;
  raise notice 'PASS 6a a pending request writes neither the position nor its eligibility';

  perform set_config('request.jwt.claims',
    json_build_object('sub', hrm_id, 'role','authenticated')::text, true);
  set local role authenticated;
  perform public.approve_change_request(req);
  reset role;

  select id into pid from public.positions where title = 'ZZ Requested HR';
  if pid is null then raise exception 'FAIL 6b approval did not create the position'; end if;
  select string_agg(system||':'||role_code, ',') into txt
    from public.position_system_roles where position_id = pid;
  if txt <> 'hrms:hr_staff' then
    raise exception 'FAIL 6c approval did not apply the eligibility, got %', coalesce(txt,'(none)'); end if;
  raise notice 'PASS 6b approval creates the position AND its eligibility together';

  ------------------------------------------------ 7. rejection leaves no residue
  perform set_config('request.jwt.claims',
    json_build_object('sub', staff_id, 'role','authenticated')::text, true);
  set local role authenticated;
  insert into public.change_requests (target_table, operation, payload, summary, requested_by, system_access)
  values ('positions', 'create',
          jsonb_build_object('title','ZZ Rejected HR', 'department_id', hr_dept),
          'Create position: ZZ Rejected HR', staff_id, '{"hrms":"hr_manager"}'::jsonb)
  returning id into req;
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('sub', hrm_id, 'role','authenticated')::text, true);
  set local role authenticated;
  perform public.reject_change_request(req, 'Not needed');
  reset role;

  select count(*) into n from public.positions where title = 'ZZ Rejected HR';
  if n <> 0 then raise exception 'FAIL 7a a rejected request created the position'; end if;
  -- The residue this design exists to prevent: an entitlement whose position
  -- was never approved.
  select count(*) into n
  from public.position_system_roles psr
  left join public.positions p on p.id = psr.position_id
  where p.id is null;
  if n <> 0 then raise exception 'FAIL 7b % orphaned entitlement rows exist', n; end if;
  select count(*) into n from public.position_system_roles psr
   join public.positions p on p.id = psr.position_id
   where p.title = 'ZZ Rejected HR';
  if n <> 0 then raise exception 'FAIL 7c a rejected request left an entitlement'; end if;
  raise notice 'PASS 7a a rejected request leaves no position and no entitlement residue';

  --------------------------------------------------- 8. direct creation, gated
  perform set_config('request.jwt.claims',
    json_build_object('sub', staff_id, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.create_position_with_access('ZZ Forbidden', it_dept, null, '{"hrms":"hr_manager"}'::jsonb);
    raise exception 'FAIL 8a HR Staff created a position directly';
  exception when others then
    if SQLERRM not like 'Only an HR Manager%' then raise; end if;
  end;
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role','authenticated')::text, true);
  set local role authenticated;
  pid := public.create_position_with_access('ZZ Direct Cashier', ops_dept, 'made directly',
                                            '{"pos":"cashier"}'::jsonb);
  reset role;
  select string_agg(system||':'||role_code, ',') into txt
    from public.position_system_roles where position_id = pid;
  if txt <> 'pos:cashier' then raise exception 'FAIL 8b direct creation lost the access, got %', coalesce(txt,'(none)'); end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role','authenticated')::text, true);
  set local role authenticated;
  pid := public.create_position_with_access('ZZ Direct Plain', it_dept, null, null);
  reset role;
  select count(*) into n from public.position_system_roles where position_id = pid;
  if n <> 0 then raise exception 'FAIL 8c a plain position gained % rows', n; end if;
  raise notice 'PASS 8a direct creation is HR-Manager/Administrator only, and carries access atomically';

  ------------------------------------------------------------------- 9. ACLs
  -- Enumerated from pg_proc, not hand-listed. The Phase 9A version of this
  -- check named its routines individually, so when this task added
  -- assert_entitlement_allowed and validate_change_request_system_access they
  -- reached production still carrying PostgreSQL's default PUBLIC EXECUTE and
  -- nothing failed. The count assertion below breaks the next time this set
  -- changes, which is the point.
  select count(*) into n
  from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
  where ns.nspname = 'public'
    and pr.proname in ('assert_entitlement_allowed', 'apply_position_system_access',
                       'create_position_with_access', 'validate_change_request_system_access');
  if n <> 4 then
    raise exception 'FAIL 9a expected 4 system-access routines, found % -- update this check', n;
  end if;

  -- Nothing in this area is reachable by anon, whatever its shape.
  select string_agg(pr.proname, ', ' order by pr.proname) into txt
  from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
  where ns.nspname = 'public'
    and pr.proname in ('assert_entitlement_allowed', 'apply_position_system_access',
                       'create_position_with_access', 'validate_change_request_system_access')
    and has_function_privilege('anon', pr.oid, 'execute');
  if txt is not null then
    raise exception 'FAIL 9b anon holds EXECUTE on: %', txt;
  end if;

  -- The shared writer and the trigger function authorize nothing themselves, so
  -- no API role may call them either. Every caller checks first.
  select string_agg(pr.proname, ', ' order by pr.proname) into txt
  from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
  where ns.nspname = 'public'
    and pr.proname in ('apply_position_system_access', 'validate_change_request_system_access')
    and has_function_privilege('authenticated', pr.oid, 'execute');
  if txt is not null then
    raise exception 'FAIL 9c an internal routine is callable by authenticated: %', txt;
  end if;

  if not has_function_privilege('authenticated', 'public.create_position_with_access(text,uuid,text,jsonb)', 'execute') then
    raise exception 'FAIL 9d authenticated lost create_position_with_access';
  end if;
  if has_function_privilege('anon', 'public.approve_change_request(uuid)', 'execute') then
    raise exception 'FAIL 9e anon can approve change requests';
  end if;
  raise notice 'PASS 9a nothing in the system-access surface is reachable by anon; internals reach no API role';

  ------------------------------------------ 10. HR authorization after 9B
  -- This check used to assert the opposite: that HR still authorized on
  -- profiles.role alone, which was the deliberate 9A boundary. Phase 9B removed
  -- that boundary, so the check now asserts the rule that replaced it -- a
  -- claimed role, an explicit grant, and current eligibility, all three.
  perform set_config('request.jwt.claims',
    json_build_object('sub', staff_id, 'role','authenticated')::text, true);
  set local role authenticated;
  if not public.is_active_staff() then
    raise exception 'FAIL 10a a properly provisioned HR Staff account cannot authorize';
  end if;
  if public.is_hr_manager_or_admin() then
    raise exception 'FAIL 10b HR Staff authorized as an HR Manager';
  end if;
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('sub', hrm_id, 'role','authenticated')::text, true);
  set local role authenticated;
  if not public.is_hr_manager_or_admin() then
    raise exception 'FAIL 10c a properly provisioned HR Manager cannot approve';
  end if;
  reset role;
  raise notice 'PASS 10a HR authorization needs role + grant + eligibility, and HR Staff is not an HR Manager';

  -- Closing the grant is enough on its own: the profile still says hr_manager
  -- and the position still confers it, but nobody granted it any more.
  update public.hr_privilege_grants
     set status = 'closed', closed_at = now(), closed_reason = 'test'
   where profile_id = hrm_id and status = 'active';
  perform set_config('request.jwt.claims',
    json_build_object('sub', hrm_id, 'role','authenticated')::text, true);
  set local role authenticated;
  if public.is_hr_manager_or_admin() or public.is_active_staff() then
    raise exception 'FAIL 10d a closed grant still authorized';
  end if;
  reset role;

  -- And it cannot simply be switched back on.
  begin
    update public.hr_privilege_grants set status = 'active'
     where profile_id = hrm_id and status = 'closed';
    raise exception 'FAIL 10e a closed grant was reopened in place';
  exception when others then
    if SQLERRM not like 'HR_GRANT_CLOSED%' then raise; end if;
  end;
  raise notice 'PASS 10b closing the grant revokes HR authority, and it cannot be reopened in place';

  -- The Administrator needs none of it: no employee, no position, no grant.
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role','authenticated')::text, true);
  set local role authenticated;
  if not public.is_active_staff() or not public.is_hr_manager_or_admin() then
    raise exception 'FAIL 10f the Administrator lost access in the HR cutover';
  end if;
  reset role;
  if (select employee_id from public.profiles where id = admin_id) is not null then
    raise exception 'FAIL 10g this Administrator has an employee link; the check proves nothing';
  end if;
  raise notice 'PASS 10c the Administrator authorizes with no employee record at all';

  raise notice '--- all position system access contract checks passed ---';
end $$;

rollback;

select 'positions after rollback: ' || count(*) as verify from public.positions where title like 'ZZ %';
