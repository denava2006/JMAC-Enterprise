-- POS grant lifecycle — database contract test.
--
-- workforce_eligibility_rls.sql already proves the revocation half: a transfer
-- away closes access, the row survives as history, and moving back does not
-- resurrect it. This suite covers the other half, which a real transfer made
-- people doubt:
--
--   * becoming ELIGIBLE must not grant anything, and
--   * there can only ever be one active assignment per person per branch.
--
-- The second one is what keeps "Grant again" from quietly producing two live
-- grants for the same till. The screen now hides that action when an active
-- assignment exists, but a React check is a courtesy -- the invariant has to
-- live in the database, so it is asserted here.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_grant_lifecycle_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.
-- True concurrency is NOT covered here -- see scripts/pos-grant-concurrency.sh.

begin;

create function pg_temp.place(_profile_id uuid, _position_title text, _dept text)
returns void language plpgsql as $helper$
declare
  _dept_id uuid; _position uuid; _employee uuid;
  _saved text := current_setting('request.jwt.claims', true); _admin uuid;
begin
  select d.id into _dept_id from public.departments d where d.name = _dept;
  select po.id into _position from public.positions po
   where po.department_id = _dept_id and po.title = _position_title;
  if _position is null then
    raise exception 'fixture: no % in %', _position_title, _dept;
  end if;

  select p.employee_id into _employee from public.profiles p where p.id = _profile_id;
  if _employee is null then
    insert into public.employees (first_name, last_name, email, department_id, position_id,
                                  employment_status, hire_date)
    select coalesce(split_part(p.full_name,' ',1),'Test'),
           coalesce(nullif(split_part(p.full_name,' ',2),''),'Worker'),
           p.email, _dept_id, _position, 'active', current_date
    from public.profiles p where p.id = _profile_id returning id into _employee;
  else
    update public.employees set department_id=_dept_id, position_id=_position,
           employment_status='active' where id=_employee;
  end if;

  select p.id into _admin from public.profiles p where p.role='admin' and p.status='active' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',_admin,'role','authenticated')::text, true);
  update public.profiles set employee_id=_employee, role='employee', status='active'
   where id=_profile_id;
  perform set_config('request.jwt.claims', coalesce(_saved,''), true);
end;
$helper$;

do $$
declare
  admin_id  uuid;
  worker    uuid;
  branch_a  uuid;
  branch_b  uuid;
  emp_id    uuid;
  first_id  uuid;
  n         integer;
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into worker from public.profiles
   where role = 'employee' and status = 'active' order by created_at, id limit 1;
  if admin_id is null or branch_a is null or branch_b is null or worker is null then
    raise exception 'fixture: need an admin, two branches and an employee';
  end if;

  delete from public.pos_branch_assignments;

  -- ======================================================================
  -- 1. Eligibility is not access
  -- ======================================================================
  --
  -- The report that started this: an employee transferred into POS Manager,
  -- the workspace showed the new position, and signing in still produced only
  -- Employee Self-Service. That is correct, and this is the check that says so.
  perform pg_temp.place(worker, 'POS Manager', 'Store Operations');

  if not public.is_eligible_for_system_role(worker, 'pos', 'manager') then
    raise exception 'FAIL  1a a POS Manager is not eligible for pos:manager';
  end if;
  raise notice 'PASS  1a transferring into POS Manager confers eligibility';

  select count(*) into n from public.pos_branch_assignments where profile_id = worker;
  if n <> 0 then
    raise exception 'FAIL  1b the transfer created % assignment(s) by itself', n;
  end if;
  raise notice 'PASS  1b the transfer grants no access on its own';

  perform set_config('request.jwt.claims',
    json_build_object('sub', worker, 'role', 'authenticated')::text, true);
  if public.has_pos_access() then
    raise exception 'FAIL  1c an eligible employee has POS access with no assignment';
  end if;
  select count(*) into n from public.my_pos_assignments();
  if n <> 0 then
    raise exception 'FAIL  1d the till would offer % branches with no grant', n;
  end if;
  raise notice 'PASS  1c-d eligible but ungranted means no POS access and no branches';

  -- ======================================================================
  -- 2. An explicit grant is what turns eligibility into access
  -- ======================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (worker, branch_a, 'manager', admin_id)
  returning id into first_id;

  perform set_config('request.jwt.claims',
    json_build_object('sub', worker, 'role', 'authenticated')::text, true);
  if not public.has_pos_access() then
    raise exception 'FAIL  2a an explicit grant did not produce POS access';
  end if;
  select count(*) into n from public.my_pos_assignments();
  if n <> 1 then
    raise exception 'FAIL  2b the till offers % branches, expected 1', n;
  end if;
  raise notice 'PASS  2a-b an explicit grant produces exactly one branch of access';

  -- ======================================================================
  -- 3. One active assignment per person per branch
  -- ======================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
    values (worker, branch_a, 'manager', admin_id);
    raise exception 'FAIL  3a a second active assignment was accepted';
  exception when unique_violation then
    raise notice 'PASS  3a a second active assignment at the same branch is refused';
  end;

  -- Changing the role does not make it a different grant: it is still the same
  -- person at the same till.
  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
    values (worker, branch_a, 'cashier', admin_id);
    raise exception 'FAIL  3b a second active assignment slipped through as another role';
  exception when unique_violation then
    raise notice 'PASS  3b the invariant is per person and branch, not per role';
  when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3b a second active assignment is refused';
  end;

  -- A different branch is a different grant, and must still be allowed.
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (worker, branch_b, 'manager', admin_id);
  select count(*) into n from public.pos_branch_assignments
   where profile_id = worker and status = 'active';
  if n <> 2 then
    raise exception 'FAIL  3c % active assignments across two branches, expected 2', n;
  end if;
  raise notice 'PASS  3c the same person may hold one grant at each of two branches';

  delete from public.pos_branch_assignments where profile_id = worker and branch_id = branch_b;

  -- ======================================================================
  -- 4. Revoked history plus a live grant
  -- ======================================================================
  --
  -- This is the state that made the screen look like it held duplicate
  -- accounts: one revoked row and one active row for the same person and
  -- branch. Both are legitimate, and a THIRD active row must still be refused.
  update public.pos_branch_assignments
     set status = 'inactive', revoked_reason = 'test revocation'
   where id = first_id;

  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (worker, branch_a, 'manager', admin_id);

  select count(*) into n from public.pos_branch_assignments
   where profile_id = worker and branch_id = branch_a;
  if n <> 2 then
    raise exception 'FAIL  4a expected 2 history rows, found %', n;
  end if;
  select count(*) into n from public.pos_branch_assignments
   where profile_id = worker and branch_id = branch_a and status = 'active';
  if n <> 1 then
    raise exception 'FAIL  4b expected exactly 1 active row, found %', n;
  end if;
  raise notice 'PASS  4a-b a revoked row and an active row coexist as history';

  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
    values (worker, branch_a, 'manager', admin_id);
    raise exception 'FAIL  4c a third active row was accepted';
  exception when unique_violation then
    raise notice 'PASS  4c re-granting again while active is still refused';
  end;

  -- ======================================================================
  -- 5. Lifecycle still gates a NEW grant
  -- ======================================================================
  --
  -- Not just eligibility: an employee who has left must not be grantable at
  -- all, even at a branch where they never had access.
  delete from public.pos_branch_assignments where profile_id = worker;

  select employee_id into emp_id from public.profiles where id = worker;
  update public.employees set employment_status = 'resigned' where id = emp_id;

  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
    values (worker, branch_a, 'manager', admin_id);
    raise exception 'FAIL  5a a resigned employee was granted POS access';
  exception when unique_violation then
    raise exception 'FAIL  5a a resigned employee was granted POS access';
  when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  5a a resigned employee cannot be granted POS access';
  end;

  update public.employees set employment_status = 'active' where id = emp_id;

  -- An account that has been deactivated is refused for the same reason.
  update public.profiles set status = 'inactive' where id = worker;
  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
    values (worker, branch_a, 'manager', admin_id);
    raise exception 'FAIL  5b a deactivated account was granted POS access';
  exception when unique_violation then
    raise exception 'FAIL  5b a deactivated account was granted POS access';
  when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  5b a deactivated account cannot be granted POS access';
  end;

  raise notice '--- all POS grant lifecycle checks passed ---';
end $$;

rollback;

select 'assignments after rollback: ' || count(*)::text as verify
from public.pos_branch_assignments;
