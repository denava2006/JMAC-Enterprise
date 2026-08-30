-- Branch POS settings — database contract test.
--
-- Phase 2B put a branch's fee schedule and payment QR behind RLS, and put the
-- QR image in a private bucket reached only through a signed URL. Both claims
-- are only worth as much as the policies behind them, so this file exercises
-- them as the actual roles.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_branch_settings_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written. A failed
-- expectation raises, which with ON_ERROR_STOP=1 exits non-zero.

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
  admin_id    uuid;
  outsider_id uuid;   -- an active account with no POS access at all
  cashier_id  uuid;
  manager_id  uuid;
  branch_a    uuid;
  branch_b    uuid;
  qr_a        text;
  qr_b        text;
  n           integer;
  bad_fees    jsonb;
begin
  ------------------------------------------------------------------ fixtures
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;

  -- Deterministic, and employees rather than HR staff: an hr_staff account
  -- also satisfies is_active_staff() and carries its own reference-data access.
  select id into cashier_id from public.profiles
    where role = 'employee' and status = 'active' order by created_at, id limit 1;
  select id into manager_id from public.profiles
    where role = 'employee' and status = 'active' and id <> cashier_id
    order by created_at, id limit 1;
  select id into outsider_id from public.profiles
    where role <> 'admin' and status = 'active' and id not in (cashier_id, manager_id)
    order by created_at, id limit 1;

  if admin_id is null or branch_b is null then
    raise exception 'fixture: need an active admin and two active branches';
  end if;
  if outsider_id is null then
    raise exception 'fixture: need three active non-admin accounts';
  end if;

  -- Known starting point: only the assignments this test creates. Deleting
  -- rather than deactivating, so a pre-existing row for the same person and
  -- branch cannot collide with the partial unique index when the test restores
  -- an assignment later. The transaction is rolled back regardless.
  delete from public.pos_branch_assignments;

    -- FIXTURE WIRED (Phase 9A): give these people the employment record
  -- their POS role now requires. The assignment INSERT below is refused
  -- otherwise, which is the point of the phase.
  perform pg_temp.make_pos_eligible(cashier_id, 'Cashier');
  perform pg_temp.make_pos_eligible(manager_id, 'POS Manager');

insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (cashier_id, branch_a, 'cashier', admin_id),
         (manager_id, branch_a, 'manager', admin_id);

  -- Settings on both branches, so a cross-branch read has something to fail at.
  insert into public.branch_pos_settings (branch_id, fees, payment_qr_path)
  values
    (branch_a,
     jsonb_build_array(jsonb_build_object(
       'id', 'fee-a', 'name', 'Service Charge', 'type', 'percent', 'value', 10, 'enabled', true)),
     branch_a::text || '/qr-a.png'),
    (branch_b, '[]'::jsonb, branch_b::text || '/qr-b.png');

  qr_a := branch_a::text || '/qr-a.png';
  qr_b := branch_b::text || '/qr-b.png';

  insert into storage.objects (bucket_id, name, owner_id)
  values ('pos-payment-qr', qr_a, admin_id::text),
         ('pos-payment-qr', qr_b, admin_id::text);

  ------------------------------------------------------------ 1. administrator
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.branch_pos_settings;
  if n <> 2 then raise exception 'FAIL  1a admin reads % settings rows, expected 2', n; end if;
  raise notice 'PASS  1a administrator reads every branch''s settings';

  update public.branch_pos_settings
    set fees = jsonb_build_array(jsonb_build_object(
      'id', 'fee-x', 'name', 'Packaging', 'type', 'fixed', 'value', 5, 'enabled', true))
    where branch_id = branch_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL  1b admin could not write settings'; end if;
  raise notice 'PASS  1b administrator may write settings';

  reset role;

  --------------------------------------------------------------- 2. POS manager
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.branch_pos_settings where branch_id = branch_a;
  if n <> 1 then raise exception 'FAIL  2a POS manager cannot read their own branch settings'; end if;
  raise notice 'PASS  2a POS manager reads their own branch''s settings';

  select count(*) into n from public.branch_pos_settings where branch_id = branch_b;
  if n <> 0 then raise exception 'FAIL  2b POS manager can read ANOTHER branch''s settings'; end if;
  raise notice 'PASS  2b POS manager cannot read another branch''s settings';

  update public.branch_pos_settings set fees = '[]'::jsonb where branch_id = branch_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL  2c POS manager modified branch settings (% rows)', n; end if;
  raise notice 'PASS  2c POS manager may not modify settings';

  begin
    insert into public.branch_pos_settings (branch_id, fees) values (branch_b, '[]'::jsonb);
    raise exception 'FAIL  2d POS manager inserted settings for another branch';
  exception when insufficient_privilege then
    raise notice 'PASS  2d POS manager may not create settings';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.branch_pos_settings where branch_id = branch_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL  2e POS manager deleted branch settings'; end if;
  raise notice 'PASS  2e POS manager may not delete settings';

  reset role;

  ------------------------------------------------------------------ 3. cashier
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.branch_pos_settings where branch_id = branch_a;
  if n <> 1 then raise exception 'FAIL  3a cashier cannot read their own branch settings'; end if;
  raise notice 'PASS  3a cashier reads their own branch''s settings';

  select count(*) into n from public.branch_pos_settings where branch_id = branch_b;
  if n <> 0 then raise exception 'FAIL  3b cashier can read another branch''s settings'; end if;
  raise notice 'PASS  3b cashier cannot read another branch''s settings';

  update public.branch_pos_settings set fees = '[]'::jsonb where branch_id = branch_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL  3c cashier modified branch settings'; end if;
  raise notice 'PASS  3c cashier may not modify settings';

  reset role;

  --------------------------------------------- 4. no POS access sees nothing
  perform set_config('request.jwt.claims', json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.branch_pos_settings;
  if n <> 0 then raise exception 'FAIL  4  an account with no POS access read % settings rows', n; end if;
  raise notice 'PASS  4  an account with no POS access sees no settings at all';
  reset role;

  ------------------------------------ 5. revoked assignment loses visibility
  update public.pos_branch_assignments set status = 'inactive'
    where profile_id = cashier_id and status = 'active';

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.branch_pos_settings;
  if n <> 0 then raise exception 'FAIL  5  a revoked cashier still reads settings'; end if;
  raise notice 'PASS  5  a revoked assignment sees no settings';
  reset role;

  --------------------------------- 6. deactivated account loses visibility
  -- The assignment stays ACTIVE on purpose: this proves the profile check in
  -- has_pos_role() is what closes the door, matching the guarantee pinned in
  -- pos_access_rls.sql check 10.
  -- As the administrator: prevent_self_role_escalation() reads auth.uid(), and
  -- resetting the Postgres role does not clear the JWT claim left by the last
  -- check.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.profiles set status = 'inactive' where id = manager_id;

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.branch_pos_settings;
  if n <> 0 then raise exception 'FAIL  6  a deactivated account with a live assignment still reads settings'; end if;
  raise notice 'PASS  6  deactivated profile + active assignment -> no settings visible';
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.profiles set status = 'active' where id = manager_id;

  ------------------------------------------------------- 7. fee validation
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- valid: fixed
  update public.branch_pos_settings
    set fees = jsonb_build_array(jsonb_build_object(
      'id', 'f1', 'name', 'Packaging', 'type', 'fixed', 'value', 25, 'enabled', true))
    where branch_id = branch_a;
  raise notice 'PASS  7a a valid FIXED fee is accepted';

  -- valid: percent
  update public.branch_pos_settings
    set fees = jsonb_build_array(jsonb_build_object(
      'id', 'f2', 'name', 'Service Charge', 'type', 'percent', 'value', 12.5, 'enabled', true))
    where branch_id = branch_a;
  raise notice 'PASS  7b a valid PERCENT fee is accepted';

  -- valid: empty
  update public.branch_pos_settings set fees = '[]'::jsonb where branch_id = branch_a;
  raise notice 'PASS  7c an empty fee list is accepted';

  reset role;

  -- Each rejection runs as admin; the point is the CHECK constraint, not
  -- authorization, so a failure here means malformed data would have been
  -- stored even when written by someone entitled to write.
  bad_fees := jsonb_build_array(jsonb_build_object(
    'id', 'f3', 'name', 'Bad', 'type', 'percent', 'value', -1, 'enabled', true));
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.branch_pos_settings set fees = bad_fees where branch_id = branch_a;
    raise exception 'FAIL  7d a NEGATIVE fee value was accepted';
  exception when check_violation then
    raise notice 'PASS  7d a negative fee value is rejected';
  end;

  bad_fees := jsonb_build_array(jsonb_build_object(
    'id', 'f4', 'name', 'Bad', 'type', 'surcharge', 'value', 5, 'enabled', true));
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.branch_pos_settings set fees = bad_fees where branch_id = branch_a;
    raise exception 'FAIL  7e an UNSUPPORTED fee type was accepted';
  exception when check_violation then
    raise notice 'PASS  7e an unsupported fee type is rejected';
  end;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.branch_pos_settings set fees = '{"not":"an array"}'::jsonb where branch_id = branch_a;
    raise exception 'FAIL  7f a non-array fees value was accepted';
  exception when check_violation then
    raise notice 'PASS  7f a non-array fees value is rejected';
  end;

  bad_fees := jsonb_build_array(jsonb_build_object(
    'id', 'f5', 'name', '', 'type', 'fixed', 'value', 5, 'enabled', true));
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.branch_pos_settings set fees = bad_fees where branch_id = branch_a;
    raise exception 'FAIL  7g a nameless fee was accepted';
  exception when check_violation then
    raise notice 'PASS  7g a nameless fee is rejected';
  end;

  bad_fees := jsonb_build_array(jsonb_build_object(
    'id', 'f6', 'name', 'Too much', 'type', 'percent', 'value', 150, 'enabled', true));
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.branch_pos_settings set fees = bad_fees where branch_id = branch_a;
    raise exception 'FAIL  7h a percentage over 100 was accepted';
  exception when check_violation then
    raise notice 'PASS  7h a percentage over 100 is rejected';
  end;

  bad_fees := jsonb_build_array(jsonb_build_object(
    'id', 'f7', 'name', 'Stringy', 'type', 'fixed', 'value', '5', 'enabled', true));
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.branch_pos_settings set fees = bad_fees where branch_id = branch_a;
    raise exception 'FAIL  7i a non-numeric fee value was accepted';
  exception when check_violation then
    raise notice 'PASS  7i a string fee value is rejected rather than coerced';
  end;

  ----------------------------------------- 8. QR path must match its branch
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.branch_pos_settings set payment_qr_path = qr_b where branch_id = branch_a;
    raise exception 'FAIL  8  a branch was pointed at ANOTHER branch''s QR object';
  exception when check_violation then
    raise notice 'PASS  8  a QR path outside the branch''s own folder is rejected';
  end;

  reset role;

  ------------------------------------------------------------ 9. QR storage
  -- Restore an active assignment for the cashier: step 5 revoked it.
  -- Phase 9A: a closed assignment cannot be reactivated -- re-granting
  -- creates a NEW row, which is the product's behaviour and not a test
  -- workaround (see 20260828060000).
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  select a.profile_id, a.branch_id, a.pos_role, a.created_by
    from public.pos_branch_assignments a
   where a.profile_id = cashier_id and a.branch_id = branch_a
   order by a.created_at desc limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from storage.objects where bucket_id = 'pos-payment-qr' and name = qr_a;
  if n <> 1 then raise exception 'FAIL  9a assigned cashier cannot read their branch''s QR object'; end if;
  raise notice 'PASS  9a an assigned cashier can read their own branch''s QR object';

  select count(*) into n from storage.objects where bucket_id = 'pos-payment-qr' and name = qr_b;
  if n <> 0 then raise exception 'FAIL  9b cashier can read ANOTHER branch''s QR object'; end if;
  raise notice 'PASS  9b a cashier cannot read another branch''s QR object';

  begin
    insert into storage.objects (bucket_id, name, owner_id)
    values ('pos-payment-qr', branch_a::text || '/sneaky.png', cashier_id::text);
    raise exception 'FAIL  9c a cashier uploaded a QR object';
  exception when insufficient_privilege then
    raise notice 'PASS  9c a cashier may not upload a QR object';
  end;

  reset role;

  -- Deletion cannot be exercised from SQL: storage.protect_delete() is a
  -- statement-level trigger that refuses any direct DELETE on storage.objects
  -- and tells the caller to use the Storage API. What SQL can still prove is
  -- that the only DELETE policy on this bucket demands is_admin(), so no
  -- non-administrator has a path to one. End-to-end deletion is covered by
  -- browser verification instead.
  select count(*) into n
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname = 'pos_payment_qr_admin_delete'
    and cmd = 'DELETE'
    and qual like '%is_admin()%';
  if n <> 1 then raise exception 'FAIL  9d the QR delete policy does not require is_admin()'; end if;
  raise notice 'PASS  9d the only QR delete policy requires an administrator';

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into storage.objects (bucket_id, name, owner_id)
    values ('pos-payment-qr', branch_a::text || '/manager.png', manager_id::text);
    raise exception 'FAIL  9e a POS manager uploaded a QR object';
  exception when insufficient_privilege then
    raise notice 'PASS  9e a POS manager may not upload a QR object';
  end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from storage.objects where bucket_id = 'pos-payment-qr';
  if n <> 0 then raise exception 'FAIL  9f an account with no POS access read % QR objects', n; end if;
  raise notice 'PASS  9f an account with no POS access sees no QR objects';
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into storage.objects (bucket_id, name, owner_id)
  values ('pos-payment-qr', branch_b::text || '/new.png', admin_id::text);
  raise notice 'PASS  9g an administrator may upload a QR object';

  update storage.objects set name = branch_b::text || '/replaced.png'
    where bucket_id = 'pos-payment-qr' and name = branch_b::text || '/new.png';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL  9h administrator could not replace a QR object'; end if;
  raise notice 'PASS  9h an administrator may replace a QR object';

  reset role;

  ------------------------------------------------------- 10. bucket is private
  select count(*) into n from storage.buckets where id = 'pos-payment-qr' and public = false;
  if n <> 1 then raise exception 'FAIL 10  the pos-payment-qr bucket is not private'; end if;
  raise notice 'PASS 10  the pos-payment-qr bucket is private (signed URLs only)';

  ---------------------------------------------------------- 11. anon sees none
  set local role anon;
  select count(*) into n from public.branch_pos_settings;
  if n <> 0 then raise exception 'FAIL 11  anon read % settings rows', n; end if;
  raise notice 'PASS 11  anon reads no settings';
  reset role;

  raise notice '--- all branch POS settings contract checks passed ---';
end $$;

rollback;

select 'settings rows after rollback: ' || count(*)::text as verify
from public.branch_pos_settings;
