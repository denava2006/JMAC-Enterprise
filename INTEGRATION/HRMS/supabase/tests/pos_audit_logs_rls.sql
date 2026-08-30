-- POS operational audit — database contract test.
--
-- The claims:
--   the table is unreachable directly by every API role, in every operation
--   TRUNCATE is refused for employee, cashier, manager and admin alike
--   the log is append-only: no UPDATE, no DELETE, even for the owner
--   a manager reads manager-visible events at branches they MANAGE, only
--   manager authority does not travel between branches
--   a cashier, an unassigned employee, a revoked assignment and a deactivated
--     profile read nothing
--   an administrator reads branch and global events, and can scope to either
--   every event type has exactly ONE emitter -- no duplicates, no storms
--   a category reorder is one event; a category delete is one event
--   ordinary checkout, receiving and adjustment write NO audit event
--   actor, branch and visibility cannot be forged
--   snapshots survive a rename
--   the manager reader references no cost, COGS, profit, margin, valuation,
--     administrator column, or the enterprise audit_logs table
--   the TRUNCATE hotfix holds, now and for future tables
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_audit_logs_rls.sql
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
  wf_dual_position uuid;
  admin_id    uuid;
  manager_id  uuid;   -- manager at A
  cashier_id  uuid;   -- cashier at A
  mixed_id    uuid;   -- manager at A, cashier at B
  outsider_id uuid;   -- no POS assignment
  branch_a    uuid;
  branch_b    uuid;
  general_id  uuid;
  cat_id      uuid;
  cat2_id     uuid;
  prod_id     uuid;
  n           integer;
  m           integer;
  txt         text;
  tag         text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  ------------------------------------------------------------------ fixtures
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';

  select id into manager_id from public.profiles
    where role = 'employee' and status = 'active' order by created_at, id limit 1;
  select id into cashier_id from public.profiles
    where role = 'employee' and status = 'active' and id <> manager_id order by created_at, id limit 1;
  select id into mixed_id from public.profiles
    where role = 'hr_staff' and status = 'active' order by created_at, id limit 1;
  select id into outsider_id from public.profiles
    where role = 'hr_manager' and status = 'active' order by created_at, id limit 1;

  if admin_id is null or branch_b is null or manager_id is null or cashier_id is null
     or mixed_id is null or outsider_id is null or general_id is null then
    raise exception 'fixture: need an admin, two branches, two employees, hr_staff, hr_manager, General';
  end if;

  delete from public.pos_branch_assignments;

  -- First as the table owner, with no authenticated actor. The writer skips
  -- rather than inventing a "system" actor -- Phase 7C audits people, and a
  -- fabricated actor is a lie a future FMS integration would have to unpick.
  -- Measured as a delta, not an absolute count: the suite must pass against a
  -- database that already holds real history, not only against a fresh one.
  select count(*) into m from public.pos_audit_events;
    -- FIXTURE WIRED (Phase 9A): give these people the employment record
  -- their POS role now requires. The assignment INSERT below is refused
  -- otherwise, which is the point of the phase.
  perform pg_temp.make_pos_eligible(cashier_id, 'Cashier');

insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (cashier_id, branch_a, 'cashier', admin_id);
  select count(*) into n from public.pos_audit_events;
  if n <> m then
    raise exception 'FAIL  0a owner-context fixture work wrote % event(s); expected none', n - m;
  end if;
  raise notice 'PASS  0a database-owner work with no authenticated actor writes no event';

  -- Now as an authenticated Administrator, which is the real path.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  -- FIXTURE WIRED (Phase 9A): the second grant needs eligible holders too.
  -- mixed_id is granted both roles, so it holds a position configured for both.
  wf_dual_position := pg_temp.make_dual_role_position();
  perform pg_temp.make_pos_eligible(manager_id, 'POS Manager');
  perform pg_temp.make_eligible_at(mixed_id, wf_dual_position);

  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (manager_id, branch_a, 'manager', admin_id),
         (mixed_id,   branch_a, 'manager', admin_id),
         (mixed_id,   branch_b, 'cashier', admin_id);
  reset role;

  select count(*) into n from public.pos_audit_events
   where event_type = 'assignment_granted' and actor_id = admin_id and created_at >= now();
  if n <> 3 then raise exception 'FAIL  0b assignment_granted fired % times, expected 3', n; end if;
  raise notice 'PASS  0b granting POS access writes exactly one event per grant';

  -- Revocation fires on the active -> inactive transition, once.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.pos_branch_assignments set status = 'inactive'
   where profile_id = mixed_id and branch_id = branch_b;
  update public.pos_branch_assignments set status = 'inactive'
   where profile_id = mixed_id and branch_id = branch_b;   -- already inactive
  -- Phase 9A: a closed assignment cannot be reactivated -- re-granting
  -- creates a NEW row, which is the product's behaviour and not a test
  -- workaround (see 20260828060000).
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  select a.profile_id, a.branch_id, a.pos_role, a.created_by
    from public.pos_branch_assignments a
   where a.profile_id = mixed_id and a.branch_id = branch_b
   order by a.created_at desc limit 1;
  reset role;
  select count(*) into n from public.pos_audit_events
   where event_type = 'assignment_revoked' and created_at >= now();
  if n <> 1 then
    raise exception 'FAIL  0c assignment_revoked fired % times; re-saving an inactive row must not re-fire', n;
  end if;
  raise notice 'PASS  0c revocation fires once, on the transition, not on every update';

  ------------------------------------------- 1. the table is not client-facing
  --
  -- Asserted against the catalog. This project has been caught six times by
  -- assuming a REVOKE line did what it read like.
  for txt in select unnest(array['anon', 'authenticated', 'service_role'])
  loop
    if exists (select 1 from information_schema.role_table_grants
               where table_name = 'pos_audit_events' and grantee = txt) then
      raise exception 'FAIL  1a % holds a table privilege on pos_audit_events', txt;
    end if;
  end loop;
  raise notice 'PASS  1a no API role holds any privilege on pos_audit_events';

  select count(*) into n from pg_policies where tablename = 'pos_audit_events';
  if n <> 0 then raise exception 'FAIL  1b pos_audit_events defines % policies; it should define none', n; end if;
  if not (select relrowsecurity from pg_class where relname = 'pos_audit_events') then
    raise exception 'FAIL  1c RLS is not enabled on pos_audit_events';
  end if;
  raise notice 'PASS  1b RLS is on and no policy exists -- reads are RPC-only by construction';

  -- The writer and every trigger function are internal.
  for txt in select unnest(array[
    'public.pos_audit_write(public.pos_audit_event_type,public.pos_audit_entity_type,uuid,uuid,text,text,text,text,text,text)',
    'public.pos_audit_branch_settings()', 'public.pos_audit_assignment()',
    'public.pos_audit_branch_product()', 'public.pos_audit_threshold()',
    'public.pos_audit_product()', 'public.pos_audit_category()',
    'public.pos_audit_events_are_append_only()', 'public.pos_audit_events_no_truncate()'])
  loop
    if has_function_privilege('authenticated', txt, 'execute')
       or has_function_privilege('anon', txt, 'execute') then
      raise exception 'FAIL  1d an API role can execute the internal routine %', txt;
    end if;
  end loop;
  raise notice 'PASS  1c no API role can execute the writer or any audit trigger function';

  ------------------------------------------------------- 2. append-only
  begin
    update public.pos_audit_events set admin_description = 'tampered';
    raise exception 'FAIL  2a the audit log accepted an UPDATE';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a the audit log refuses UPDATE, even for the table owner';
  end;

  begin
    delete from public.pos_audit_events;
    raise exception 'FAIL  2b the audit log accepted a DELETE';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2b the audit log refuses DELETE, even for the table owner';
  end;

  begin
    truncate public.pos_audit_events;
    raise exception 'FAIL  2c the audit log accepted a TRUNCATE';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2c the audit log refuses TRUNCATE -- RLS would not have stopped it';
  end;

  ----------------------------- 3. the TRUNCATE hotfix, on the wider schema
  select string_agg(table_name, ', ' order by table_name) into txt
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated')
    and privilege_type = 'TRUNCATE';
  if txt is not null then
    raise exception 'FAIL  3a TRUNCATE is still granted to an API role on: %', txt;
  end if;
  raise notice 'PASS  3a no public table grants TRUNCATE to anon or authenticated';

  select d.defaclacl::text into txt
  from pg_default_acl d join pg_namespace ns on ns.oid = d.defaclnamespace
  where ns.nspname = 'public' and d.defaclobjtype = 'r'
    and pg_get_userbyid(d.defaclrole) = 'postgres';
  if txt ~ 'anon=[a-zA-Z]*D' or txt ~ 'authenticated=[a-zA-Z]*D' then
    raise exception 'FAIL  3b default privileges would re-grant TRUNCATE on the next table: %', txt;
  end if;
  raise notice 'PASS  3b default privileges no longer hand TRUNCATE to future tables';

  -- And the specific tables the review found wide open.
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    truncate public.audit_logs;
    raise exception 'FAIL  3c a cashier truncated the enterprise audit trail';
  exception when insufficient_privilege then
    raise notice 'PASS  3c a cashier can no longer truncate the enterprise audit trail';
  end;
  begin
    truncate public.pos_branch_assignments;
    raise exception 'FAIL  3d a cashier truncated every POS assignment';
  exception when insufficient_privilege then
    raise notice 'PASS  3d a cashier can no longer truncate pos_branch_assignments';
  end;
  reset role;

  ------------------------------------------ 4. one emitter per event type
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.pos_product_categories (name, is_active, sort_order)
  values ('ZZ Audit A ' || tag, true, 80) returning id into cat_id;
  insert into public.pos_product_categories (name, is_active, sort_order)
  values ('ZZ Audit B ' || tag, true, 81) returning id into cat2_id;
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Audit Prod ' || tag, cat_id, 100.00, 60.00, 'active') returning id into prod_id;
  insert into public.pos_branch_products (branch_id, product_id) values (branch_a, prod_id);
  reset role;

  select count(*) into n from public.pos_audit_events where event_type = 'category_created'
    and entity_id in (cat_id, cat2_id);
  if n <> 2 then raise exception 'FAIL  4a category_created fired % times for 2 categories', n; end if;
  select count(*) into n from public.pos_audit_events where event_type = 'product_created' and entity_id = prod_id;
  if n <> 1 then raise exception 'FAIL  4b product_created fired % times for one product', n; end if;
  select count(*) into n from public.pos_audit_events where event_type = 'branch_product_added' and entity_id = prod_id;
  if n <> 1 then raise exception 'FAIL  4c branch_product_added fired % times', n; end if;
  raise notice 'PASS  4a creating a category, a product and a branch listing writes exactly one event each';

  -- No-ops write nothing.
  select count(*) into m from public.pos_audit_events;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.pos_products set name = name where id = prod_id;
  update public.pos_branch_products set is_available = is_available
   where branch_id = branch_a and product_id = prod_id;
  reset role;
  select count(*) into n from public.pos_audit_events;
  if n <> m then raise exception 'FAIL  4d a no-op update wrote % new event(s)', n - m; end if;
  raise notice 'PASS  4b an update that changes nothing writes nothing';

  -- Two independent changes on one row produce two distinct events, not one
  -- blurred one and not a duplicate pair.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.pos_branch_products
     set is_available = false, selling_price_override = 85.00
   where branch_id = branch_a and product_id = prod_id;
  reset role;
  select count(*) into n from public.pos_audit_events where event_type = 'product_stopped' and entity_id = prod_id;
  select count(*) into m from public.pos_audit_events where event_type = 'branch_selling_price_changed' and entity_id = prod_id;
  if n <> 1 or m <> 1 then
    raise exception 'FAIL  4e one UPDATE produced stopped=% price=%, expected 1 and 1', n, m;
  end if;
  raise notice 'PASS  4c two changes in one UPDATE write one event each, not a blur and not a duplicate';

  ------------------------------------------- 5. no storms, no silent losses
  select count(*) into m from public.pos_audit_events;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.reorder_pos_category(cat2_id, -1);
  reset role;
  select count(*) into n from public.pos_audit_events;
  if n - m <> 1 then
    raise exception 'FAIL  5a a reorder that rewrote every category wrote % events, expected 1', n - m;
  end if;
  select count(*) into n from public.pos_audit_events
   where event_type = 'category_updated' and entity_id in (cat_id, cat2_id);
  if n <> 0 then raise exception 'FAIL  5b the reorder leaked % per-row category_updated events', n; end if;
  raise notice 'PASS  5a a reorder writes exactly one event, and no per-row storm';

  -- A delete that moves products writes one event, not one per product.
  select count(*) into m from public.pos_audit_events;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.delete_pos_category(cat_id, general_id);
  reset role;
  select count(*) into n from public.pos_audit_events;
  if n - m <> 1 then
    raise exception 'FAIL  5c a category delete that moved a product wrote % events, expected 1', n - m;
  end if;
  select admin_new_value into txt from public.pos_audit_events
   where event_type = 'category_deleted' and entity_id = cat_id;
  -- Suppression must not become silent loss: the aggregate says what moved.
  if txt not like '%1 product(s) moved to%' then
    raise exception 'FAIL  5d the delete event does not record the bulk move: %', txt;
  end if;
  raise notice 'PASS  5b a category delete writes one aggregate event that records the bulk move';

  ------------------------- 6. the domain ledgers are not duplicated here
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  reset role;
  select count(*) into m from public.pos_audit_events;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_pos_stock(branch_a, prod_id, 20, 60.00, null);
  perform public.adjust_pos_stock(branch_a, prod_id, -1, 'damaged', null);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  -- The product is stopped at this branch; offer it so the till can sell it.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.pos_branch_products set is_available = true
   where branch_id = branch_a and product_id = prod_id;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.checkout_pos_sale(branch_a,
    jsonb_build_array(jsonb_build_object('product_id', prod_id, 'quantity', 2)),
    'cash', gen_random_uuid(), null, 1000);
  reset role;

  select count(*) into n from public.pos_audit_events;
  -- Only the product_offered event above is new. Receiving, adjusting and
  -- selling add nothing: pos_inventory_movements and pos_sales already record
  -- them with a trusted actor, and a parallel event would grow at transaction
  -- volume while saying less.
  if n - m <> 1 then
    raise exception 'FAIL  6a receive + adjust + checkout wrote % events, expected only the 1 offer change', n - m;
  end if;
  raise notice 'PASS  6a ordinary receiving, adjustment and checkout write no POS audit event';

  -- But the threshold, which is configuration rather than movement, does.
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_low_stock_threshold(branch_a, prod_id, 9);
  reset role;
  select count(*) into n from public.pos_audit_events
   where event_type = 'low_stock_threshold_changed' and entity_id = prod_id;
  if n <> 1 then raise exception 'FAIL  6b threshold change wrote % events, expected 1', n; end if;
  raise notice 'PASS  6b a low-stock level change IS audited -- configuration, not movement';

  --------------------------------------- 7. actor, role and branch integrity
  select count(*) into n from public.pos_audit_events
   where event_type = 'low_stock_threshold_changed' and entity_id = prod_id
     and actor_id = manager_id
     and actor_enterprise_role = 'employee'
     and actor_pos_role = 'manager'
     and branch_id = branch_a;
  if n <> 1 then
    raise exception 'FAIL  7a the manager''s threshold event did not record employee/manager at branch A';
  end if;
  raise notice 'PASS  7a actor_enterprise_role and actor_pos_role are recorded separately and correctly';

  -- An Administrator holds no POS assignment, so actor_pos_role is null --
  -- which a single conflated role column could not express.
  select count(*) into n from public.pos_audit_events
   where event_type = 'product_created' and actor_enterprise_role = 'admin' and actor_pos_role is null;
  if n <> 1 then raise exception 'FAIL  7b an administrator event did not record admin with a null POS role'; end if;
  raise notice 'PASS  7b an Administrator records enterprise role admin and no POS role';

  -- Global catalogue events are not filed under a branch they did not happen at.
  select count(*) into n from public.pos_audit_events
   where event_type in ('product_created','category_created','category_deleted','category_reordered')
     and branch_id is not null;
  if n <> 0 then raise exception 'FAIL  7c % enterprise-wide events were filed under a branch', n; end if;
  raise notice 'PASS  7c enterprise-wide events carry no branch -- no invented scope';

  ------------------------------------------------------------ 8. snapshots
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  -- Rename and re-cost in one statement: the rename is recorded with both
  -- values, the buying cost only as a fact.
  update public.pos_products
     set name = 'ZZ Renamed Later ' || tag, default_unit_cost = 77.00
   where id = prod_id;
  reset role;
  select count(*) into n from public.pos_audit_events
   where event_type = 'branch_product_added' and entity_id = prod_id
     and entity_name_snapshot like 'ZZ Audit Prod%';
  if n <> 1 then raise exception 'FAIL  8a a later rename rewrote an older event''s snapshot'; end if;
  raise notice 'PASS  8a renaming a product does not rewrite what older events say';

  ------------------------------------------------- 9. the manager's reader
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.get_pos_manager_audit_events(branch_a);
  if n = 0 then raise exception 'FAIL  9a a manager reads nothing at the branch they manage'; end if;
  raise notice 'PASS  9a a manager reads their own branch''s events';

  select count(*) into n from public.get_pos_manager_audit_events(branch_a) e
   where e.event_type::text in (
     'assignment_granted','assignment_revoked','product_created','product_updated',
     'product_archived','product_restored','category_created','category_updated',
     'category_archived','category_restored','category_reordered','category_deleted');
  if n <> 0 then raise exception 'FAIL  9b % administrator-only events reached the manager reader', n; end if;
  raise notice 'PASS  9b not one administrator-only event type reaches the manager reader';

  -- The one intentionally money-bearing safe value: a SELLING price.
  select e.old_value || ' -> ' || e.new_value into txt
  from public.get_pos_manager_audit_events(branch_a) e
  where e.event_type = 'branch_selling_price_changed';
  if txt <> 'Default -> 85.00' then
    raise exception 'FAIL  9c the selling-price event reads "%", expected "Default -> 85.00"', txt;
  end if;
  if txt ~* '(cost|cogs|margin|profit)' then
    raise exception 'FAIL  9d the selling-price event carries cost or margin data';
  end if;
  raise notice 'PASS  9c branch_selling_price_changed shows the selling price, and nothing else';

  select count(*) into n from public.get_pos_manager_audit_events(branch_b);
  if n <> 0 then raise exception 'FAIL  9e a manager at A read branch B'; end if;
  raise notice 'PASS  9d a manager reads no branch but their own';

  reset role;
  ------------------------ 10. manager authority does not travel between branches
  perform set_config('request.jwt.claims', json_build_object('sub', mixed_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_manager_audit_events(branch_a);
  if n = 0 then raise exception 'FAIL 10a the mixed user cannot read the branch they manage'; end if;
  select count(*) into n from public.get_pos_manager_audit_events(branch_b);
  if n <> 0 then raise exception 'FAIL 10b manager authority leaked into branch B, where they only cashier'; end if;
  raise notice 'PASS 10a manager at A, cashier at B reads A and nothing at B';

  ------------------------------------------------ 11. everyone else is out
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_manager_audit_events(branch_a);
  if n <> 0 then raise exception 'FAIL 11a a cashier read the audit log for their own branch'; end if;
  begin
    select count(*) into n from public.pos_audit_events;
    raise exception 'FAIL 11b a cashier read pos_audit_events directly';
  exception when insufficient_privilege then
    raise notice 'PASS 11a a cashier reads neither the RPC nor the table';
  end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_manager_audit_events(branch_a);
  if n <> 0 then raise exception 'FAIL 11c an account with no POS assignment read the audit log'; end if;
  raise notice 'PASS 11b an account with no POS assignment reads nothing';

  reset role;
  update public.pos_branch_assignments set status = 'inactive'
   where profile_id = manager_id and branch_id = branch_a;
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_manager_audit_events(branch_a);
  if n <> 0 then raise exception 'FAIL 11d a deactivated assignment still read the audit log'; end if;
  raise notice 'PASS 11c deactivating the assignment closes the audit log immediately';

  reset role;
  -- Phase 9A: a closed assignment cannot be reactivated -- re-granting
  -- creates a NEW row, which is the product's behaviour and not a test
  -- workaround (see 20260828060000).
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  select a.profile_id, a.branch_id, a.pos_role, a.created_by
    from public.pos_branch_assignments a
   where a.profile_id = manager_id and a.branch_id = branch_a
   order by a.created_at desc limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.profiles set status = 'inactive' where id = manager_id;
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_manager_audit_events(branch_a);
  if n <> 0 then raise exception 'FAIL 11e a deactivated profile still read the audit log'; end if;
  raise notice 'PASS 11d a live assignment on a deactivated profile grants nothing';
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.profiles set status = 'active' where id = manager_id;

  ------------------------------------------ 12. the administrator's reader
  set local role authenticated;
  select count(*) into n from public.get_admin_pos_audit_events();
  if n = 0 then raise exception 'FAIL 12a an administrator read no events at all'; end if;

  select count(*) into n from public.get_admin_pos_audit_events(_global_only => true) e
   where e.branch_id is not null;
  if n <> 0 then raise exception 'FAIL 12b the global scope returned branch-scoped events'; end if;

  select count(*) into n from public.get_admin_pos_audit_events(_branch_id => branch_a) e
   where e.branch_id is distinct from branch_a;
  if n <> 0 then raise exception 'FAIL 12c scoping to a branch returned other branches'' events'; end if;
  raise notice 'PASS 12a an administrator can scope to all POS, one branch, or the global events';

  select count(*) into n from public.get_admin_pos_audit_events() e where e.manager_visible;
  select count(*) into m from public.get_admin_pos_audit_events() e where not e.manager_visible;
  if n = 0 or m = 0 then
    raise exception 'FAIL 12d the administrator view is missing one visibility class (vis=%, admin-only=%)', n, m;
  end if;
  raise notice 'PASS 12b an administrator sees both manager-visible and administrator-only events';
  reset role;

  --------------------------------- 13. paging is deterministic and clamped
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_admin_pos_audit_events(_limit => 2);
  if n <> 2 then raise exception 'FAIL 13a a page of 2 returned % rows', n; end if;
  select e.total_count::integer into m from public.get_admin_pos_audit_events(_limit => 2) e limit 1;
  if m <= 2 then raise exception 'FAIL 13b total_count is %, which cannot be the unpaged total', m; end if;
  select count(*) into n from public.get_admin_pos_audit_events(_limit => 100000);
  if n > 100 then raise exception 'FAIL 13c an oversized page was not clamped: % rows', n; end if;
  -- No row appears on both page 1 and page 2.
  select count(*) into n from (
    select e.event_id from public.get_admin_pos_audit_events(_limit => 2, _offset => 0) e
    intersect
    select e.event_id from public.get_admin_pos_audit_events(_limit => 2, _offset => 2) e
  ) dup;
  if n <> 0 then raise exception 'FAIL 13d % row(s) appeared on two consecutive pages', n; end if;
  raise notice 'PASS 13a paging is clamped, reports the true total, and does not repeat rows';
  reset role;

  ------------------------------------------------ 14. no cost, structurally
  --
  -- Not a keyword filter over stored text -- that is not a boundary. This
  -- asserts that the manager reader's DEFINITION never touches a cost-bearing
  -- column, an administrator-only column, or the enterprise audit table. If it
  -- cannot reference them, it cannot leak them.
  txt := pg_get_functiondef(
    'public.get_pos_manager_audit_events(uuid,date,date,public.pos_audit_event_type,uuid,public.pos_audit_entity_type,integer,integer)'::regprocedure);
  if txt ~* '(admin_description|admin_old_value|admin_new_value|default_unit_cost|average_unit_cost|unit_cost_snapshot|total_cogs|line_cogs|audit_logs)' then
    raise exception 'FAIL 14a the manager reader references a forbidden column or table';
  end if;
  raise notice 'PASS 14a the manager reader''s definition touches no cost, admin or enterprise-audit source';

  -- Its declared result carries none of them either.
  txt := pg_get_function_result(
    'public.get_pos_manager_audit_events(uuid,date,date,public.pos_audit_event_type,uuid,public.pos_audit_entity_type,integer,integer)'::regprocedure);
  if txt ~* '(cost|cogs|margin|profit|manager_visible|description)' then
    raise exception 'FAIL 14b the manager reader declares a forbidden column: %', txt;
  end if;
  raise notice 'PASS 14b the manager result declares no cost, COGS, margin or profit column';

  -- And no writer ever put a cost value into a manager-readable field.
  select count(*) into n from public.pos_audit_events
   where manager_visible
     and (coalesce(safe_old_value,'') ~* '(cogs|margin|profit|buying)'
       or coalesce(safe_new_value,'') ~* '(cogs|margin|profit|buying)');
  if n <> 0 then raise exception 'FAIL 14c % manager-visible event(s) carry cost-shaped values', n; end if;
  raise notice 'PASS 14c no manager-visible event carries a cost-shaped value';

  -- The buying-cost change was recorded as a fact, without the numbers.
  select admin_new_value into txt from public.pos_audit_events
   where event_type = 'product_updated' and admin_new_value like '%buying cost%' limit 1;
  if txt is null then raise exception 'FAIL 14d a buying-cost change was not recorded at all'; end if;
  if txt ~ '\d+\.\d\d' and txt !~ 'selling price' then
    raise exception 'FAIL 14e the buying-cost change recorded a value: %', txt;
  end if;
  raise notice 'PASS 14d a buying-cost change is recorded as a fact, never as a number';

  ------------------------------------------------------ 15. visibility integrity
  -- The constraint, not the writer, is the last line of defence.
  begin
    insert into public.pos_audit_events (
      branch_id, event_type, entity_type, actor_id, actor_name_snapshot,
      actor_enterprise_role, manager_visible, admin_description, safe_new_value)
    values (branch_a, 'assignment_granted', 'branch_assignment', admin_id, 'x',
            'admin', true, 'forged', 'leak');
    raise exception 'FAIL 15a an administrator-only event was stored as manager-visible';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 15a the taxonomy constraint refuses a forged manager_visible flag';
  end;

  begin
    insert into public.pos_audit_events (
      branch_id, event_type, entity_type, actor_id, actor_name_snapshot,
      actor_enterprise_role, manager_visible, admin_description, safe_new_value)
    values (null, 'product_offered', 'branch_product', admin_id, 'x',
            'admin', true, 'branchless', 'leak');
    raise exception 'FAIL 15b a manager-visible event was stored with no branch';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 15b a manager-visible event cannot exist without a branch to scope it to';
  end;

  raise notice '--- all POS audit contract checks passed ---';
end $$;

rollback;

select 'audit events after rollback: ' || count(*) as verify from public.pos_audit_events;
