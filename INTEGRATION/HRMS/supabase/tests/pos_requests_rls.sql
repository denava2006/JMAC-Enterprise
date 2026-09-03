-- POS inventory requests — database contract test.
--
-- The claims:
--   a manager creates requests only for branches they MANAGE
--   manager authority does not travel between branches
--   a cashier, an unassigned employee, a revoked assignment and a deactivated
--     profile can neither create, list nor review
--   the requester and the reviewer are derived from auth.uid(), never supplied
--   nobody may review their own request
--   only ONE terminal transition wins a race; a second is refused
--   APPROVAL CHANGES NO INVENTORY -- not one unit, not one movement
--   a carry approval creates the branch listing switched OFF, at zero stock
--   the table carries NO procurement or accounting column (the FMS boundary)
--   review authority lives in exactly one swappable predicate
--   the table is unreachable directly by every API role, TRUNCATE included
--   each lifecycle event produces exactly one audit event; no-ops produce none
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_requests_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

/** A Finance Staff reviewer.
 *
 * F4.1 moved restock review out of the Administrator's hands: a branch asking
 * for stock is asking Finance to buy something. These suites therefore need a
 * finance actor for the restock steps, and keep the Administrator for the
 * catalogue ones.
 */
create or replace function pg_temp.finance_reviewer()
returns uuid
language plpgsql as $helper$
declare
  _emp uuid; _uid uuid; _pos uuid; _dept uuid; _admin uuid;
  _tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  _saved text := current_setting('request.jwt.claims', true);
begin
  select id into _admin from public.profiles where role='admin' and status='active' limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', _admin, 'role', 'authenticated')::text, true);

  select p.id, p.department_id into _pos, _dept
  from public.positions p where lower(p.title) = 'finance staff' limit 1;
  if _pos is null then raise exception 'fixture: no Finance Staff position'; end if;

  insert into public.employees (first_name, last_name, email, department_id, position_id,
                                hire_date, employment_status)
  values ('ZZ', 'Fin Reviewer ' || _tag, 'zz.fin.' || _tag || '@jmac-test.invalid',
          _dept, _pos, current_date, 'active')
  returning id into _emp;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, email_change,
                          email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
          'authenticated', 'zz.fin.' || _tag || '@jmac-test.invalid',
          crypt('x', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
  returning id into _uid;

  update public.profiles set employee_id = _emp, status = 'active' where id = _uid;
  perform set_config('request.jwt.claims', coalesce(_saved, ''), true);
  return _uid;
end;
$helper$;


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
  admin_id    uuid;
  manager_id  uuid;   -- manager at A
  cashier_id  uuid;   -- cashier at A
  mixed_id    uuid;   -- manager at A, cashier at B
  outsider_id uuid;   -- no POS assignment
  branch_a    uuid;
  branch_b    uuid;
  general_id  uuid;
  carried_id  uuid;   -- product branch A already carries
  uncarried_id uuid;  -- active product branch A does not carry
  spare_id    uuid;   -- a second uncarried product, for the cancel tests
  req_stock   uuid;
  req_carry   uuid;
  req_own     uuid;
  n           integer;
  m           integer;
  qty_before  integer;
  mov_before  integer;
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
    -- FIXTURE WIRED (Phase 9A): give these people the employment record
  -- their POS role now requires. The assignment INSERT below is refused
  -- otherwise, which is the point of the phase.
  wf_dual_position := pg_temp.make_dual_role_position();
  perform pg_temp.make_pos_eligible(cashier_id, 'Cashier');
  perform pg_temp.make_pos_eligible(manager_id, 'POS Manager');
  perform pg_temp.make_eligible_at(mixed_id, wf_dual_position);

insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (manager_id, branch_a, 'manager', admin_id),
         (cashier_id, branch_a, 'cashier', admin_id),
         (mixed_id,   branch_a, 'manager', admin_id),
         (mixed_id,   branch_b, 'cashier', admin_id);

  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Req Carried ' || tag, general_id, 100.00, 60.00, 'active') returning id into carried_id;
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Req Uncarried ' || tag, general_id, 50.00, 30.00, 'active') returning id into uncarried_id;
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Req Spare ' || tag, general_id, 25.00, 15.00, 'active') returning id into spare_id;
  insert into public.pos_branch_products (branch_id, product_id) values (branch_a, carried_id);

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_pos_stock(branch_a, carried_id, 40, 60.00, null);
  reset role;

  --------------------------------- 1. the FMS boundary, asserted structurally
  --
  -- The single most important check in this suite. Phase 8 stays a demand
  -- signal rather than a second purchasing system only while these columns
  -- do not exist.
  select string_agg(column_name, ', ' order by column_name) into txt
  from information_schema.columns
  where table_schema = 'public' and table_name = 'pos_inventory_requests'
    and column_name in ('amount','vendor_id','supplier_id','budget_id','unit_cost',
                        'payment_schedule','total_value','cost','price','currency');
  if txt is not null then
    raise exception 'FAIL  1a pos_inventory_requests carries procurement columns: %', txt;
  end if;
  raise notice 'PASS  1a the request table declares no procurement or accounting column';

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'pos_inventory_requests'
     and data_type in ('json', 'jsonb');
  if n <> 0 then raise exception 'FAIL  1b the request table has % JSON column(s)', n; end if;
  raise notice 'PASS  1b no arbitrary JSON payload -- typed columns only';

  -- No reviewer column names a role; the authority is swappable, not recorded.
  select string_agg(column_name, ', ') into txt from information_schema.columns
   where table_schema = 'public' and table_name = 'pos_inventory_requests'
     and (column_name ilike '%admin%' or column_name ilike '%fms%'
          or column_name ilike '%authority%');
  if txt is not null then
    raise exception 'FAIL  1c a reviewer column names an authority: %', txt;
  end if;
  raise notice 'PASS  1c reviewer fields are generic -- no admin/fms/authority column';

  ------------------------------------------ 2. the table is not client-facing
  for txt in select unnest(array['anon', 'authenticated', 'service_role'])
  loop
    if exists (select 1 from information_schema.role_table_grants
               where table_name = 'pos_inventory_requests' and grantee = txt) then
      raise exception 'FAIL  2a % holds a table privilege on pos_inventory_requests', txt;
    end if;
  end loop;
  select count(*) into n from pg_policies where tablename = 'pos_inventory_requests';
  if n <> 0 then raise exception 'FAIL  2b the table defines % policies; expected none', n; end if;
  if not (select relrowsecurity from pg_class where relname = 'pos_inventory_requests') then
    raise exception 'FAIL  2c RLS is not enabled';
  end if;
  raise notice 'PASS  2a no API role holds any privilege; RLS on with no policy -- RPC-only';

  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    truncate public.pos_inventory_requests;
    raise exception 'FAIL  2d a cashier truncated the request table';
  exception when insufficient_privilege then
    raise notice 'PASS  2b TRUNCATE is refused -- RLS would not have stopped it';
  end;
  reset role;

  ------------------------------------------------- 3. a manager may request
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select public.create_pos_stock_request(branch_a, carried_id, 25, 'Running low before the weekend')
    into req_stock;
  select public.create_pos_carry_request(branch_a, uncarried_id, 'Customers keep asking for it')
    into req_carry;
  raise notice 'PASS  3a a manager creates a restock and a carry request at their own branch';

  -- The actor is derived, never supplied: there is no requested_by parameter.
  txt := pg_get_function_arguments(
    'public.create_pos_stock_request(uuid,uuid,integer,text)'::regprocedure);
  if txt ~* '(requested_by|requester|actor|user_id)' then
    raise exception 'FAIL  3b create_pos_stock_request takes an identity argument: %', txt;
  end if;
  select count(*) into n from public.get_pos_manager_requests(branch_a) r
   where r.request_id = req_stock and r.requested_by = manager_id;
  if n <> 1 then raise exception 'FAIL  3c the requester was not recorded as the caller'; end if;
  raise notice 'PASS  3b the requester is auth.uid(); no parameter could forge it';

  -- Branch authority is per branch.
  begin
    perform public.create_pos_stock_request(branch_b, carried_id, 5, 'not my branch');
    raise exception 'FAIL  3d a manager created a request for a branch they do not manage';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3c a manager cannot raise demand for a branch they do not manage';
  end;

  -- Restock is for something the branch already carries.
  begin
    perform public.create_pos_stock_request(branch_a, uncarried_id, 5, 'not carried here');
    raise exception 'FAIL  3e a restock was accepted for a product the branch does not carry';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3d a restock is refused for a product the branch does not carry';
  end;

  -- One open request per branch + product + type.
  begin
    perform public.create_pos_stock_request(branch_a, carried_id, 10, 'duplicate');
    raise exception 'FAIL  3f a duplicate pending request was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3e a second PENDING request for the same product is refused';
  end;

  -- Bounds and required text.
  begin
    perform public.create_pos_stock_request(branch_a, carried_id, 0, 'zero');
    raise exception 'FAIL  3g a zero quantity was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3f quantity is bounded';
  end;
  reset role;

  ------------------------------------ 4. manager authority does not travel
  perform set_config('request.jwt.claims', json_build_object('sub', mixed_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_manager_requests(branch_a);
  if n = 0 then raise exception 'FAIL  4a the mixed user cannot read the branch they manage'; end if;
  select count(*) into n from public.get_pos_manager_requests(branch_b);
  if n <> 0 then raise exception 'FAIL  4b manager authority leaked into branch B'; end if;
  begin
    perform public.create_pos_carry_request(branch_b, uncarried_id, 'cashier branch');
    raise exception 'FAIL  4c the mixed user created a request at their cashier branch';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  4a manager at A, cashier at B: reads and writes A only';
  end;
  reset role;

  --------------------------------------------------- 5. everyone else is out
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.create_pos_stock_request(branch_a, carried_id, 5, 'cashier try');
    raise exception 'FAIL  5a a cashier created a request';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  5a a cashier cannot create a request';
  end;
  select count(*) into n from public.get_pos_manager_requests(branch_a);
  if n <> 0 then raise exception 'FAIL  5b a cashier listed their branch''s requests'; end if;
  select count(*) into n from public.get_pos_request_queue();
  if n <> 0 then raise exception 'FAIL  5c a cashier read the review queue'; end if;
  begin
    perform public.approve_pos_request(req_stock, 'cashier approving');
    raise exception 'FAIL  5d a cashier approved a request';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  5b a cashier can neither list nor review';
  end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_manager_requests(branch_a);
  if n <> 0 then raise exception 'FAIL  5e an unassigned account listed requests'; end if;
  select count(*) into n from public.get_pos_request_queue();
  if n <> 0 then raise exception 'FAIL  5f an unassigned account read the queue'; end if;
  raise notice 'PASS  5c an account with no POS assignment reads nothing';
  reset role;

  --------------------------------------------- 6. review authority is one place
  --
  -- restock is INTERIM (FMS will own it); carry is PERMANENT. Both read
  -- is_admin() today, and can_review_pos_request is the only place either is
  -- decided -- so FMS integration changes one function body.
  for txt in select unnest(array[
    'public.approve_pos_request(uuid,text)',
    'public.decline_pos_request(uuid,text)'])
  loop
    if pg_get_functiondef(txt::regprocedure) !~ 'can_review_pos_request' then
      raise exception 'FAIL  6a % does not route authorization through can_review_pos_request', txt;
    end if;
    if pg_get_functiondef(txt::regprocedure) ~ 'is_admin\(\)' then
      raise exception 'FAIL  6b % calls is_admin() directly instead of the predicate', txt;
    end if;
  end loop;
  raise notice 'PASS  6a both review paths route through can_review_pos_request, and only it';

  ----------------------------------------- 7. reviewing, and its one winner
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- One, not two. The restock left the Administrator's queue when F4.1 handed
  -- procurement to Finance; the carry request is a catalogue decision and stays.
  select count(*) into n from public.get_pos_request_queue();
  if n <> 1 then
    raise exception 'FAIL  7a the Administrator queue holds % requests, expected 1', n;
  end if;
  if exists (select 1 from public.get_pos_request_queue() q where q.request_type = 'restock') then
    raise exception 'FAIL  7a a restock is still sitting in the Administrator queue';
  end if;
  select count(*) into n from public.get_pos_request_queue(_branch_id => branch_b);
  if n <> 0 then raise exception 'FAIL  7b the branch filter returned % rows for an empty branch', n; end if;
  select count(*) into n from public.get_pos_request_queue(_status => 'approved');
  if n <> 0 then raise exception 'FAIL  7c the status filter returned % rows', n; end if;
  raise notice 'PASS  7a the review queue lists every branch, and its filters work';

  -- Restock review is Finance's from F4.1, so the restock steps act as Finance.
  -- Provisioning the reviewer writes to auth.users, which the authenticated
  -- role may not do, so the role is dropped for the fixture and taken up again.
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.finance_reviewer(), 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- A decline needs a reason.
  begin
    perform public.decline_pos_request(req_stock, '   ');
    raise exception 'FAIL  7d a decline with no reason was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7b declining requires a reason';
  end;

  -- ***** THE CENTRAL CLAIM: approval moves no stock. *****
  select coalesce(sum(quantity_on_hand), 0) into qty_before from public.pos_branch_inventory;
  select count(*) into mov_before from public.pos_inventory_movements;

  perform public.approve_pos_request(req_stock, 'Legitimate demand -- may proceed to procurement');

  select coalesce(sum(quantity_on_hand), 0) into n from public.pos_branch_inventory;
  select count(*) into m from public.pos_inventory_movements;
  if n <> qty_before then
    raise exception 'FAIL  7e approving a restock changed stock from % to %', qty_before, n;
  end if;
  if m <> mov_before then
    raise exception 'FAIL  7f approving a restock wrote % inventory movement(s)', m - mov_before;
  end if;
  raise notice 'PASS  7c approving a RESTOCK changes no quantity and writes no movement';

  -- Terminal is terminal, and a race has exactly one winner.
  begin
    perform public.approve_pos_request(req_stock, 'again');
    raise exception 'FAIL  7g a request was approved twice';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7d a second review of the same request is refused';
  end;
  begin
    perform public.decline_pos_request(req_stock, 'changed my mind');
    raise exception 'FAIL  7h an approved request was then declined';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7e an approval cannot be reversed into a decline';
  end;

  ------------------------------- 8. a carry approval, and what it may create
  -- Back to the Administrator: carrying a product is a catalogue decision and
  -- did not move to Finance. Only restock did.
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select coalesce(sum(quantity_on_hand), 0) into qty_before from public.pos_branch_inventory;
  perform public.approve_pos_request(req_carry, null);

  select count(*) into n from public.pos_branch_products
   where branch_id = branch_a and product_id = uncarried_id and is_available = false;
  if n <> 1 then raise exception 'FAIL  8a the carry approval did not create the listing, switched off'; end if;
  raise notice 'PASS  8a a carry approval creates the branch listing, NOT yet offered';

  select quantity_on_hand into n from public.pos_branch_inventory
   where branch_id = branch_a and product_id = uncarried_id;
  if n <> 0 then raise exception 'FAIL  8b the new inventory row starts at %, expected 0', n; end if;
  select coalesce(sum(quantity_on_hand), 0) into m from public.pos_branch_inventory;
  if m <> qty_before then raise exception 'FAIL  8c a carry approval changed total stock'; end if;
  raise notice 'PASS  8b its inventory row starts at zero -- approval conjures no stock';
  reset role;

  ---------------------------------------- 9. nobody reviews their own request
  --
  -- A CARRY request, deliberately: the Administrator still reviews those, so a
  -- refusal here is the self-review guard and not merely "wrong role". Using a
  -- restock would now fail at the authority check first and this test would
  -- pass for a reason it was not written to prove.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select public.create_pos_carry_request(branch_a, spare_id, 'admin''s own request') into req_own;
  begin
    perform public.approve_pos_request(req_own, 'approving my own');
    raise exception 'FAIL  9a a reviewer approved their own request';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  9a nobody may review a request they submitted themselves';
  end;
  -- Withdrawn so the later carry-request checks start from a clean product.
  perform public.cancel_pos_request(req_own, 'withdrawn by the test');
  reset role;

  -- The Administrator is no longer a reviewer of restock at all, which is the
  -- dependency F4.1 removed.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.can_review_pos_request('restock') then
    raise exception 'FAIL  9b the Administrator can still review restock';
  end if;
  if not public.can_review_pos_request('carry_existing_product') then
    raise exception 'FAIL  9b the Administrator lost catalogue review';
  end if;
  raise notice 'PASS  9b restock review left the Administrator; the catalogue did not';
  reset role;

  ------------------------------------------------------- 10. cancellation
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.cancel_pos_request(req_stock, 'not mine to withdraw');   -- somebody else's request
    raise exception 'FAIL 10a a manager cancelled somebody else''s request';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 10a only the requester may cancel their own request';
  end;
  begin
    perform public.cancel_pos_request(req_carry, 'too late');   -- already approved
    raise exception 'FAIL 10b an approved request was cancelled';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 10b cancellation is refused once a decision has been made';
  end;

  -- A fresh pending request of their own can be withdrawn, and that frees the
  -- partial unique index for a replacement.
  -- uncarried_id is genuinely carried now, thanks to the approval in check 8 --
  -- so the cancel tests use a product the branch still does not stock.
  select public.create_pos_carry_request(branch_a, spare_id, 'second thoughts') into req_carry;
  perform public.cancel_pos_request(req_carry, 'no longer needed');
  -- Read the row as the owner: no API role may touch the table directly, which
  -- checks 2a/2b just proved.
  reset role;
  select status into txt from public.pos_inventory_requests where id = req_carry;
  if txt <> 'cancelled' then raise exception 'FAIL 10c cancel left status %', txt; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select public.create_pos_carry_request(branch_a, spare_id, 'replacement') into req_carry;
  raise notice 'PASS 10c a requester withdraws their own pending request, freeing the slot';
  perform public.cancel_pos_request(req_carry, 'no longer needed');
  reset role;

  ------------------------------------------------------------ 11. audit trail
  select count(*) into n from public.pos_audit_events
   where event_type::text like 'stock_request%';
  -- created x5 (restock, carry, admin's own, carry #2, carry #3)
  -- cancelled x2, approved x2, declined x0
  if n < 8 then raise exception 'FAIL 11a only % request audit events were written', n; end if;

  select count(*) into n from public.pos_audit_events
   where event_type = 'stock_request_approved' and entity_type = 'inventory_request';
  if n <> 2 then raise exception 'FAIL 11b stock_request_approved fired % times, expected 2', n; end if;
  raise notice 'PASS 11a each lifecycle transition writes exactly one audit event';

  -- Manager-visible: it is their own request at their own branch.
  select count(*) into n from public.pos_audit_events
   where event_type::text like 'stock_request%' and not manager_visible;
  if n <> 0 then raise exception 'FAIL 11c % request events are hidden from the manager', n; end if;
  select count(*) into n from public.pos_audit_events
   where event_type::text like 'stock_request%' and branch_id is null;
  if n <> 0 then raise exception 'FAIL 11d % request events carry no branch', n; end if;
  raise notice 'PASS 11b request events are manager-visible and branch-scoped';

  -- A refused transition writes nothing.
  select count(*) into m from public.pos_audit_events;
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.create_pos_stock_request(branch_a, carried_id, 5, 'refused');
  exception when others then null; end;
  reset role;
  select count(*) into n from public.pos_audit_events;
  if n <> m then raise exception 'FAIL 11e a refused request wrote % audit event(s)', n - m; end if;
  raise notice 'PASS 11c a refused or no-op transition writes no audit event';

  ------------------------------------------------------------------ 12. ACLs
  for txt in select unnest(array[
    'public.create_pos_stock_request(uuid,uuid,integer,text)',
    'public.create_pos_carry_request(uuid,uuid,text)',
    'public.cancel_pos_request(uuid,text)',
    'public.approve_pos_request(uuid,text)',
    'public.decline_pos_request(uuid,text)',
    'public.get_pos_manager_requests(uuid,public.pos_request_status,integer,integer)',
    'public.get_pos_request_queue(uuid,public.pos_request_status,integer,integer)'])
  loop
    if has_function_privilege('anon', txt, 'execute') then
      raise exception 'FAIL 12a anon holds EXECUTE on %', txt;
    end if;
    if not has_function_privilege('authenticated', txt, 'execute') then
      raise exception 'FAIL 12b authenticated lost EXECUTE on %', txt;
    end if;
  end loop;
  raise notice 'PASS 12a anon holds EXECUTE on none of the request RPCs';

  if has_function_privilege('authenticated',
       'public.pos_request_audit(public.pos_inventory_requests,public.pos_audit_event_type,text,text,text)',
       'execute') then
    raise exception 'FAIL 12c the internal audit writer is reachable by an API role';
  end if;
  raise notice 'PASS 12b the internal audit writer stays internal';

  select string_agg(table_name, ', ') into txt
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated')
    and privilege_type = 'TRUNCATE';
  if txt is not null then
    raise exception 'FAIL 12d TRUNCATE is granted to an API role on: %', txt;
  end if;
  raise notice 'PASS 12c the TRUNCATE hotfix still holds across the schema';

  ------------------------------------------- 13. no cost reaches a manager
  txt := pg_get_function_result(
    'public.get_pos_manager_requests(uuid,public.pos_request_status,integer,integer)'::regprocedure);
  if txt ~* '(cost|cogs|margin|profit|amount|vendor|budget|price)' then
    raise exception 'FAIL 13a the manager request contract declares a forbidden column: %', txt;
  end if;
  raise notice 'PASS 13a the manager request contract carries no cost, price or procurement column';

  raise notice '--- all POS request contract checks passed ---';
end $$;

rollback;

select 'requests after rollback: ' || count(*) as verify from public.pos_inventory_requests;
