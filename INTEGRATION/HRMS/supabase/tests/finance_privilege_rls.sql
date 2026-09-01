-- Finance authorization — database contract test (FMS F1).
--
-- Finance people are employees who hold a finance privilege. The rules are the
-- ones HR and POS already follow, plus one that is specific to money:
--
--   Exactly one active finance role. Finance Staff validates, Finance Manager
--   approves, the Accountant pays and posts. One person holding two of those
--   carries a payment from validation to disbursement with nobody else in the
--   room. That is not a convenience question -- it is the control the chain
--   exists to provide, and it is enforced by an index so that removing it takes
--   a migration rather than a line of application code.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/finance_privilege_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

create or replace function pg_temp.acts_as(_uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
$$;

/** Hire somebody into a position and give them a login. */
create or replace function pg_temp.hire(_name text, _position text)
returns uuid
language plpgsql as $$
declare
  _emp uuid;
  _uid uuid;
  _pos uuid;
  _dept uuid;
  _admin uuid;
  _tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  -- Provisioning is an administrative act, and the profile triggers say so.
  -- Stated here rather than left to whatever the previous check happened to
  -- leave the session acting as.
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

  -- Linking the account to the employee is the provisioning event. Everything
  -- the lifecycle does, it does from here.
  update public.profiles set employee_id = _emp, status = 'active' where id = _uid;
  return _uid;
end;
$$;

do $$
declare
  admin_id uuid;
  staff    uuid;
  manager  uuid;
  acct     uuid;
  outsider uuid;
  emp_id   uuid;
  n        integer;
  txt      text;
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  if admin_id is null then raise exception 'fixture: need an active administrator'; end if;

  -- ======================================================================
  -- 1. The registry knows what a finance position entitles
  -- ======================================================================
  select count(*) into n from public.position_system_roles r
   join public.positions p on p.id = r.position_id
   where r.system = 'fms';
  if n <> 3 then
    raise exception 'FAIL  1a the fms registry has % entries, expected 3', n;
  end if;
  raise notice 'PASS  1a Finance Staff, Finance Manager and Accountant are registered for fms';

  -- ======================================================================
  -- 2. Hiring into Finance establishes the privilege
  -- ======================================================================
  staff := pg_temp.hire('Fin Staff', 'Finance Staff');

  select count(*) into n from public.finance_privilege_grants
   where profile_id = staff and status = 'active' and finance_role = 'finance_staff';
  if n <> 1 then
    raise exception 'FAIL  2a provisioning produced % active finance grants, expected 1', n;
  end if;

  select role::text into txt from public.profiles where id = staff;
  if txt <> 'finance_staff' then
    raise exception 'FAIL  2b the profile role is %, not the granted one', txt;
  end if;
  raise notice 'PASS  2a-b hiring into Finance grants the role the position entitles';

  perform pg_temp.acts_as(staff);
  set local role authenticated;
  if not public.has_finance_privilege(array['finance_staff']) then
    raise exception 'FAIL  2c a provisioned Finance Staff cannot act';
  end if;
  if public.has_finance_privilege(array['finance_manager', 'accountant']) then
    raise exception 'FAIL  2d Finance Staff authorized as manager or accountant';
  end if;
  reset role;
  raise notice 'PASS  2c-d they authorize as themselves and as nobody else';

  -- ======================================================================
  -- 3. Exactly one active finance role. The whole point.
  -- ======================================================================
  begin
    insert into public.finance_privilege_grants (profile_id, finance_role)
    values (staff, 'accountant');
    raise exception 'FAIL  3a a second active finance role was created';
  exception when unique_violation then
    raise notice 'PASS  3a a second active finance role is refused by the database';
  end;

  -- Not merely avoided by the caller: refused even by a direct insert, which is
  -- what makes it an invariant rather than a convention.
  perform pg_temp.acts_as(admin_id);
  set local role authenticated;
  begin
    perform public.grant_finance_privilege(staff, 'finance_manager');
    reset role;
    raise exception 'FAIL  3b an Administrator stacked a second finance role';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3b even an Administrator cannot stack finance roles';
  end;

  -- ======================================================================
  -- 4. The role alone authorizes nothing
  -- ======================================================================
  update public.finance_privilege_grants
     set status = 'closed', closed_at = now(), closed_reason = 'workforce_ineligible'
   where profile_id = staff and status = 'active';
  update public.profiles set role = 'finance_manager' where id = staff;

  perform pg_temp.acts_as(staff);
  set local role authenticated;
  if public.has_finance_privilege(array['finance_manager']) then
    raise exception 'FAIL  4a a claimed finance role authorized with no grant';
  end if;
  reset role;
  raise notice 'PASS  4a profiles.role alone does not authorize -- a grant is required';

  -- ======================================================================
  -- 5. Promotion closes one and opens the next
  -- ======================================================================
  manager := pg_temp.hire('Fin Mgr', 'Finance Staff');
  select employee_id into emp_id from public.profiles where id = manager;

  update public.employees
     set position_id = (select id from public.positions where lower(title) = 'finance manager')
   where id = emp_id;

  select count(*) into n from public.finance_privilege_grants
   where profile_id = manager and status = 'active';
  if n <> 1 then
    raise exception 'FAIL  5a after promotion there are % active grants, expected 1', n;
  end if;

  select finance_role into txt from public.finance_privilege_grants
   where profile_id = manager and status = 'active';
  if txt <> 'finance_manager' then
    raise exception 'FAIL  5b the promoted grant is for %', txt;
  end if;

  -- The old one is closed, not deleted.
  select count(*) into n from public.finance_privilege_grants
   where profile_id = manager and status = 'closed' and finance_role = 'finance_staff';
  if n <> 1 then
    raise exception 'FAIL  5c the previous grant was discarded rather than closed';
  end if;
  raise notice 'PASS  5a-c promotion closes one grant and opens the next, keeping the history';

  -- ======================================================================
  -- 6. Leaving Finance closes it; employment continues
  -- ======================================================================
  update public.employees
     set position_id = (select id from public.positions where lower(title) = 'cashier'),
         department_id = (select department_id from public.positions where lower(title) = 'cashier')
   where id = emp_id;

  select count(*) into n from public.finance_privilege_grants
   where profile_id = manager and status = 'active';
  if n <> 0 then
    raise exception 'FAIL  6a finance privilege survived a move out of Finance';
  end if;

  select count(*) into n from public.profiles pr join public.employees e on e.id = pr.employee_id
   where pr.id = manager and pr.status = 'active' and e.employment_status = 'active';
  if n <> 1 then
    raise exception 'FAIL  6b losing finance privilege disturbed the employment record';
  end if;
  raise notice 'PASS  6a-b moving out of Finance closes the privilege, not the job';

  -- ======================================================================
  -- 7. An Administrator's revoke survives a transfer
  -- ======================================================================
  acct := pg_temp.hire('Fin Acct', 'Accountant');
  select employee_id into emp_id from public.profiles where id = acct;

  perform pg_temp.acts_as(admin_id);
  set local role authenticated;
  perform public.close_finance_privilege(acct, 'revoked by administrator');
  reset role;

  -- The sequence that restores a system closure.
  update public.employees
     set position_id = (select id from public.positions where lower(title) = 'cashier'),
         department_id = (select department_id from public.positions where lower(title) = 'cashier')
   where id = emp_id;
  update public.employees
     set position_id = (select id from public.positions where lower(title) = 'accountant'),
         department_id = (select department_id from public.positions where lower(title) = 'accountant')
   where id = emp_id;

  select count(*) into n from public.finance_privilege_grants
   where profile_id = acct and status = 'active';
  if n <> 0 then
    raise exception 'FAIL  7a a transfer undid an Administrator''s revocation';
  end if;
  raise notice 'PASS  7a a revoked finance account stays revoked across transfers';

  -- ======================================================================
  -- 8. Finance is not HR, and not POS
  -- ======================================================================
  outsider := pg_temp.hire('Fin Outsider', 'Finance Staff');

  perform pg_temp.acts_as(outsider);
  set local role authenticated;
  if public.is_active_staff() then
    raise exception 'FAIL  8a finance privilege granted HR data access';
  end if;
  if public.has_pos_access() then
    raise exception 'FAIL  8b finance privilege granted POS access';
  end if;
  if not public.is_active_finance() then
    raise exception 'FAIL  8c a Finance Staff is not recognised as finance';
  end if;
  reset role;
  raise notice 'PASS  8a-c finance access is finance access -- not HR, not the till';

  -- ======================================================================
  -- 9. Employment ending closes it
  -- ======================================================================
  -- Ending somebody's employment is HR's act, not the departing person's.
  perform pg_temp.acts_as(admin_id);
  select employee_id into emp_id from public.profiles where id = outsider;
  update public.employees set employment_status = 'resigned' where id = emp_id;

  select count(*) into n from public.finance_privilege_grants
   where profile_id = outsider and status = 'active';
  if n <> 0 then
    raise exception 'FAIL  9a finance privilege survived the employment ending';
  end if;
  raise notice 'PASS  9a employment ending closes the finance privilege';

  -- ======================================================================
  -- 10. Administrators grant; nobody else does
  -- ======================================================================
  perform pg_temp.acts_as(staff);
  set local role authenticated;
  begin
    perform public.grant_finance_privilege(staff, 'accountant');
    reset role;
    raise exception 'FAIL 10a a non-administrator granted finance privilege';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 10a only an Administrator grants finance privilege';
  end;

  -- And the reconciliation itself is reachable by no API role at all.
  if has_function_privilege('anon', 'public.reconcile_finance_privilege(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.reconcile_finance_privilege(uuid)', 'execute') then
    raise exception 'FAIL 10b an API role can call the finance reconciliation directly';
  end if;
  raise notice 'PASS 10b the reconciliation is reachable by no API role';

  raise notice '--- all finance privilege checks passed ---';
end $$;

rollback;

select 'finance grants after rollback: ' || count(*)::text as verify
from public.finance_privilege_grants;
