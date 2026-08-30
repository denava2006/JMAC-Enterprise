-- POS access — database contract test.
--
-- Phase 2A adds an Administrator-only screen for granting and revoking
-- pos_branch_assignments. It ships with no migration, which is only a
-- defensible decision if the guarantees it leans on are actually in the
-- database rather than merely in the UI. This file is that proof, and it is
-- re-runnable so a later slice cannot quietly remove one of them.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_access_rls.sql
--
-- Everything happens inside one transaction that is rolled back at the end.
-- Nothing is written. A failed expectation raises, which with ON_ERROR_STOP=1
-- exits non-zero.
--
-- Fixtures are derived from whatever accounts exist rather than hard-coded
-- ids, so this runs against demo data or real data. It needs one active
-- Administrator, one active HR Staff, one other active non-admin account, and
-- two active branches.

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

-- Mint a complete, compliant POS worker: auth user, profile and employment
-- record. Needed because the demo database has only two employee-role accounts
-- and Phase 9A requires a real employment record per POS holder.
create function pg_temp.make_new_pos_worker(_name text, _position_title text)
returns uuid
language plpgsql
as $mk$
declare
  _uid uuid := gen_random_uuid();
  _dept uuid;
  _position uuid;
  _employee uuid;
  _email text := lower(replace(_name, ' ', '.')) || '.' ||
                 left(replace(gen_random_uuid()::text, '-', ''), 6) || '@example.com';
begin
  select d.id into _dept from public.departments d where d.name = 'Store Operations';
  select po.id into _position from public.positions po
   where po.department_id = _dept and po.title = _position_title;

  -- A trigger on auth.users creates the profile row, so this updates it rather
  -- than inserting a second one.
  insert into auth.users (id, email) values (_uid, _email);
  insert into public.employees (first_name, last_name, email, department_id, position_id,
                                employment_status, hire_date)
  values (split_part(_name,' ',1), coalesce(nullif(split_part(_name,' ',2),''),'Worker'),
          _email, _dept, _position, 'active', current_date)
  returning id into _employee;

  insert into public.profiles (id, employee_id, full_name, email, role, status)
  values (_uid, _employee, _name, _email, 'employee', 'active')
  on conflict (id) do update
    set employee_id = excluded.employee_id, full_name = excluded.full_name,
        role = 'employee', status = 'active';
  return _uid;
end;
$mk$;

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
  admin_id   uuid;
  staff_id   uuid;
  decoy_id   uuid;
  wf_dual_position uuid;
  worker_id  uuid;
  branch_a   uuid;
  branch_b   uuid;
  grant_id   uuid;
  n          integer;
  b          boolean;
  actor      uuid;
  role_now   text;
begin
  ------------------------------------------------------------------ fixtures
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into staff_id from public.profiles where role = 'hr_staff' and status = 'active' limit 1;
  -- order by, so the same account is chosen on every run: without it Postgres
  -- may return a different row each time and the test's assumptions about that
  -- account's existing assignments quietly stop holding.
  select id into worker_id from public.profiles
    where role not in ('admin') and status = 'active'
      and id <> coalesce(staff_id, '00000000-0000-0000-0000-000000000000'::uuid)
    order by created_at, id
    limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;

  if admin_id is null then raise exception 'fixture: no active admin profile'; end if;
  if staff_id is null then raise exception 'fixture: no active hr_staff profile'; end if;
  if worker_id is null then raise exception 'fixture: no other active non-admin profile'; end if;
  if branch_b is null then raise exception 'fixture: need two active branches'; end if;

  -- Start from a genuinely known state. Deactivating leaves the old rows
  -- behind, which then show up in the "sees only their own" count and collide
  -- with the partial unique index on re-grant. Deleting is safe: this whole
  -- transaction is rolled back.
  delete from public.pos_branch_assignments;

  -- Somebody else's assignment, so "sees only their own" is a real claim rather
  -- than a count of one in an otherwise empty table.
  -- FIXTURE WIRED (Phase 9A): the decoy assignment needs a genuinely eligible
  -- holder. It deliberately does NOT go to staff_id -- check 2 below relies on
  -- that account still being HR Staff, and Phase 9A makes HR accounts
  -- permanently ineligible for operational POS roles.
  decoy_id := pg_temp.make_new_pos_worker('Decoy Manager', 'POS Manager');
  -- worker_id is granted both cashier and manager across this suite, so they
  -- hold a position configured for both. This suite is about WHO MAY GRANT --
  -- every refusal here must be about privilege, not eligibility, or the checks
  -- would pass for the wrong reason. (Note the ordering: the eligibility
  -- trigger is BEFORE INSERT and therefore fires ahead of the RLS WITH CHECK,
  -- so an ineligible target masks a privilege denial.)
  wf_dual_position := pg_temp.make_dual_role_position();
  perform pg_temp.make_eligible_at(worker_id, wf_dual_position);

  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (decoy_id, branch_b, 'manager', admin_id);

  ------------------------------------------------------- 1. admin may grant
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (worker_id, branch_a, 'cashier', admin_id)
  returning id into grant_id;
  raise notice 'PASS  1  administrator may grant POS access';

  reset role;

  ------------------------------------------------- 2. HR staff may not grant
  perform set_config('request.jwt.claims', json_build_object('sub', staff_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role)
    values (worker_id, branch_b, 'manager');
    raise exception 'FAIL  2  HR Staff was allowed to grant POS access';
  exception when insufficient_privilege then
    raise notice 'PASS  2  HR Staff may not grant POS access';
  end;
  reset role;

  --------------------------------------- 3. the assignee may not grant/escalate
  perform set_config('request.jwt.claims', json_build_object('sub', worker_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role)
    values (worker_id, branch_b, 'manager');
    raise exception 'FAIL  3a a POS user granted themselves access at another branch';
  exception when insufficient_privilege then
    raise notice 'PASS  3a a POS user may not grant themselves access';
  end;

  -- Re-establish: the caught exception rolled back the subtransaction.
  perform set_config('request.jwt.claims', json_build_object('sub', worker_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.pos_branch_assignments set pos_role = 'manager' where profile_id = worker_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL  3b a POS user escalated their own role (% rows)', n; end if;
  raise notice 'PASS  3b a POS user may not escalate their own role';

  --------------------------------------------------- 4. visibility is self-only
  select count(*) into n from public.pos_branch_assignments;
  if n <> 1 then raise exception 'FAIL  4a assignee sees % rows, expected only their own', n; end if;
  select count(*) into n from public.pos_branch_assignments a where a.profile_id <> worker_id;
  if n <> 0 then raise exception 'FAIL  4b assignee can see somebody else''s assignment'; end if;
  raise notice 'PASS  4  a POS user sees only their own assignment, not other people''s';

  ------------------------------------------------------- 5. branch/role scoping
  if not public.has_pos_access() then raise exception 'FAIL  5a assigned user has no POS access'; end if;
  if not public.has_pos_role(branch_a, array['cashier']::public.pos_role[]) then
    raise exception 'FAIL  5b cashier refused at their own branch';
  end if;
  if public.has_pos_role(branch_b, array['cashier']::public.pos_role[]) then
    raise exception 'FAIL  5c cashier admitted at a branch they are not assigned to';
  end if;
  if public.has_pos_role(branch_a, array['manager']::public.pos_role[]) then
    raise exception 'FAIL  5d cashier admitted as a manager';
  end if;
  select count(*) into n from public.my_pos_branches();
  if n <> 1 then raise exception 'FAIL  5e my_pos_branches returned % rows, expected 1', n; end if;
  raise notice 'PASS  5  branch and role scoping hold (own branch yes, other branch no, other role no)';

  reset role;

  ------------------------------------------- 6. an administrator is unscoped
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  if not public.has_pos_access() then raise exception 'FAIL  6a administrator has no POS access'; end if;
  if not public.has_pos_role(branch_b, array['cashier']::public.pos_role[]) then
    raise exception 'FAIL  6b administrator refused at a branch';
  end if;
  select count(*) into n from public.my_pos_branches();
  if n <> 0 then
    raise exception 'FAIL  6c administrator is branch-scoped (% rows); callers read empty as "all"', n;
  end if;
  raise notice 'PASS  6  administrator reaches every branch and is not branch-scoped';

  ------------------------------------------------- 7. revoke keeps the history
  update public.pos_branch_assignments set status = 'inactive' where id = grant_id;
  select count(*) into n from public.pos_branch_assignments where id = grant_id;
  if n <> 1 then raise exception 'FAIL  7  revoking deleted the assignment row'; end if;
  raise notice 'PASS  7  revoking sets status inactive and keeps the row';

  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', worker_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.has_pos_access() then raise exception 'FAIL  7b a revoked assignment still grants access'; end if;
  raise notice 'PASS  7b a revoked assignment grants nothing';
  reset role;

  ------------------------------------ 8. re-grant is a new row, not a revival
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (worker_id, branch_a, 'manager', admin_id);

  select count(*) into n from public.pos_branch_assignments where profile_id = worker_id and branch_id = branch_a;
  if n <> 2 then raise exception 'FAIL  8a expected 2 rows after re-grant, found %', n; end if;
  select count(*) into n from public.pos_branch_assignments
    where profile_id = worker_id and branch_id = branch_a and status = 'inactive';
  if n <> 1 then raise exception 'FAIL  8b the revoked row was overwritten instead of kept'; end if;
  raise notice 'PASS  8  re-granting adds a new row and preserves the revoked one';

  --------------------------------- 9. only one ACTIVE row per person + branch
  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
    values (worker_id, branch_a, 'cashier', admin_id);
    raise exception 'FAIL  9  a second active assignment was allowed at the same branch';
  exception when unique_violation then
    raise notice 'PASS  9  a second active assignment at the same branch is refused';
  end;

  reset role;

  ------------------------------------------------------------------------------
  -- 10. THE ONE TO KEEP: deactivating the account closes the till.
  --
  --   inactive profile + active pos_branch_assignment
  --     -> has_pos_access()  = false
  --     -> my_pos_branches() = no rows
  --
  -- has_pos_role() joins profiles and requires status = 'active', so
  -- deactivating an account revokes its POS access without anyone having to
  -- remember to revoke the assignment separately. The assignment row is
  -- deliberately left active here -- that is the whole point of the check.
  ------------------------------------------------------------------------------
  update public.profiles set status = 'inactive' where id = worker_id;

  perform set_config('request.jwt.claims', json_build_object('sub', worker_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.pos_branch_assignments
    where profile_id = worker_id and status = 'active';
  if n < 1 then raise exception 'FAIL 10  precondition: expected a live assignment to test against'; end if;

  b := public.has_pos_access();
  if b then
    raise exception 'FAIL 10a inactive profile with an active assignment still has POS access';
  end if;

  select count(*) into n from public.my_pos_branches();
  if n <> 0 then
    raise exception 'FAIL 10b inactive profile still lists % POS branch(es)', n;
  end if;
  raise notice 'PASS 10  inactive profile + active assignment -> no access, no branches';

  reset role;

  -- Restore the account: check 12 below grants a fresh assignment, and Phase 9A
  -- refuses to grant one to a deactivated profile -- correctly, but that is
  -- check 10's subject, not check 12's.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.profiles set status = 'active' where id = worker_id;

  ------------------------------------------- 11. the helpers are not public
  set local role anon;
  begin
    perform public.has_pos_access();
    raise exception 'FAIL 11  anon may execute has_pos_access()';
  exception when insufficient_privilege then
    raise notice 'PASS 11  anon may not execute the POS helper functions';
  end;
  reset role;

  ------------------------------------------------------- 12. the actor stamp
  --
  -- created_by must be what the database saw, not what the caller sent
  -- (20260825010000_pos_assignment_actor_is_the_caller.sql).
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- Deliberately lie about the grantor.
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (worker_id, branch_b, 'cashier', staff_id)
  returning created_by into actor;
  if actor <> admin_id then
    raise exception 'FAIL 12a a client-supplied created_by (%) was stored instead of auth.uid() (%)', actor, admin_id;
  end if;
  raise notice 'PASS 12a a client-supplied created_by is overwritten with the caller';

  -- Omit it entirely.
  update public.pos_branch_assignments set status = 'inactive'
    where profile_id = worker_id and branch_id = branch_b and status = 'active';
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role)
  values (worker_id, branch_b, 'cashier')
  returning created_by into actor;
  if actor <> admin_id then
    raise exception 'FAIL 12b an omitted created_by was stored as %, expected the caller', actor;
  end if;
  raise notice 'PASS 12b an omitted created_by is filled in with the caller';

  -- And it cannot be rewritten afterwards.
  update public.pos_branch_assignments set created_by = staff_id
    where profile_id = worker_id and branch_id = branch_b and status = 'active';
  select a.created_by into actor from public.pos_branch_assignments a
    where a.profile_id = worker_id and a.branch_id = branch_b and a.status = 'active';
  if actor <> admin_id then
    raise exception 'FAIL 12c created_by was rewritten by an update to %', actor;
  end if;
  raise notice 'PASS 12c created_by cannot be rewritten by a later update';

  reset role;

  -- A non-administrator is still refused outright: the stamp hardens the audit
  -- trail, it does not widen who may write.
  perform set_config('request.jwt.claims', json_build_object('sub', staff_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.pos_branch_assignments (profile_id, branch_id, pos_role)
    values (worker_id, branch_a, 'cashier');
    raise exception 'FAIL 12d the actor trigger let a non-administrator insert';
  exception when insufficient_privilege then
    raise notice 'PASS 12d a non-administrator is still refused';
  end;
  reset role;

  ------------------------------------------------ 13. audit trail is writable
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.audit_logs (actor_id, action, table_name, record_id)
  values (admin_id, 'POS Access Granted', 'pos_branch_assignments', grant_id);
  raise notice 'PASS 13  an administrator may record the change in audit_logs';
  reset role;

  select current_user into role_now;
  raise notice '--- all POS access contract checks passed (running as %) ---', role_now;
end $$;

rollback;

-- Guard against a future edit that drops the rollback: if this prints anything
-- other than the count the file started with, the test wrote to the database.
select 'assignments after rollback: ' || count(*)::text as verify
from public.pos_branch_assignments;
