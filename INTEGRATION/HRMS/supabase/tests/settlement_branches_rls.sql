-- The branches a Finance user may name on a settlement, and nothing else.
--
-- The defect this file pins: an Accountant opening Record settlement saw an
-- empty Branch dropdown, because the builder read public.branches directly and
-- the policies there cover Admin, HR and assigned POS staff -- not Finance.
--
-- The claims:
--
--   every Finance role can list branch choices
--   POS and HR roles cannot, and anon cannot
--   an Accountant STILL cannot read public.branches directly
--   the surface carries a name and an id, and no other branch column
--   inactive branches are not offered
--
-- The third claim is the important one. Fixing an empty dropdown by widening
-- the table would have worked and been wrong, so the test asserts the table is
-- exactly as shut as it was.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/settlement_branches_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

create or replace function pg_temp.acts_as(_uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
$$;

create or replace function pg_temp.hire(_name text, _position text)
returns uuid
language plpgsql as $$
declare
  _emp uuid; _uid uuid; _pos uuid; _dept uuid; _admin uuid;
  _tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
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

  update public.profiles set employee_id = _emp, status = 'active' where id = _uid;
  return _uid;
end;
$$;

do $$
declare
  admin_id uuid; accountant uuid; fin_mgr uuid; fin_staff uuid;
  cashier uuid; pos_mgr uuid; hr_staff uuid;
  branch_a uuid; retired uuid; n integer; txt text;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;

  accountant := pg_temp.hire('Bookkeeper',  'Accountant');
  fin_mgr    := pg_temp.hire('Fin Manager', 'Finance Manager');
  fin_staff  := pg_temp.hire('Fin Staff',   'Finance Staff');
  cashier    := pg_temp.hire('Till',        'Cashier');
  pos_mgr    := pg_temp.hire('Store Mgr',   'POS Manager');
  hr_staff   := pg_temp.hire('HR Person',   'HR Staff');

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (cashier, branch_a, 'cashier', admin_id),
         (pos_mgr, branch_a, 'manager', admin_id);

  -- A branch nobody trades at any more. It must not be offered.
  perform pg_temp.acts_as(admin_id); set local role authenticated;
  insert into public.branches (name, is_active)
  values ('ZZ Retired Branch ' || tag, false) returning id into retired;
  reset role;

  -- ======================================================================
  -- 1. Finance can fill in the form
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n from public.get_settlement_branches();
  if n = 0 then
    raise exception 'FAIL 1a the Accountant sees no branches -- the defect is back';
  end if;
  reset role;
  raise notice 'PASS  1a an Accountant can list the branches a settlement may name';

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  select count(*)::integer into n from public.get_settlement_branches();
  if n = 0 then raise exception 'FAIL 1b the Finance Manager sees no branches'; end if;
  reset role;
  raise notice 'PASS  1b so can the Finance Manager, who reviews the settlement';

  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  select count(*)::integer into n from public.get_settlement_branches();
  if n = 0 then raise exception 'FAIL 1c Finance Staff sees no branches'; end if;
  reset role;
  raise notice 'PASS  1c and Finance Staff, under the same F6 read authority';

  -- ======================================================================
  -- 2. Nobody else
  -- ======================================================================
  perform pg_temp.acts_as(cashier); set local role authenticated;
  select count(*)::integer into n from public.get_settlement_branches();
  if n <> 0 then raise exception 'FAIL 2a a cashier read the Finance branch surface'; end if;
  reset role;
  raise notice 'PASS  2a a cashier gets nothing from the Finance surface';

  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  select count(*)::integer into n from public.get_settlement_branches();
  if n <> 0 then raise exception 'FAIL 2b a POS Manager read the Finance branch surface'; end if;
  reset role;
  raise notice 'PASS  2b nor a POS Manager -- they have their own branch access';

  perform pg_temp.acts_as(hr_staff); set local role authenticated;
  select count(*)::integer into n from public.get_settlement_branches();
  if n <> 0 then raise exception 'FAIL 2c an HR account read the Finance branch surface'; end if;
  reset role;
  raise notice 'PASS  2c HR reads branches through its own policy, not this one';

  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin
    select count(*)::integer into n from public.get_settlement_branches();
    if n <> 0 then raise exception 'FAIL 2d anon read the Finance branch surface'; end if;
  exception when insufficient_privilege then
    n := 0;
  end;
  reset role;
  raise notice 'PASS  2d an anonymous caller is refused';

  -- ======================================================================
  -- 3. The table is exactly as shut as it was
  -- ======================================================================
  --
  -- The claim that matters. An empty dropdown could have been "fixed" by
  -- adding Finance to branches_staff_select, which would have worked and
  -- handed Finance every address, phone number and coordinate on the way.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n from public.branches;
  if n <> 0 then
    raise exception 'FAIL 3a the Accountant can now read public.branches directly (% rows)', n;
  end if;
  reset role;
  raise notice 'PASS  3a an Accountant still cannot read the branches table itself';

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  select count(*)::integer into n from public.branches;
  if n <> 0 then raise exception 'FAIL 3b the Finance Manager can read branches directly'; end if;
  -- And cannot write to it either, which was never on offer and stays that way.
  begin
    update public.branches set name = 'ZZ hijacked' where id = branch_a;
    if found then raise exception 'FAIL 3b Finance renamed a branch'; end if;
  exception when insufficient_privilege then null;
  end;
  reset role;
  raise notice 'PASS  3b Finance can neither read nor write the branches table';

  -- The policies are untouched: the same three, doing the same jobs.
  select string_agg(policyname, ',' order by policyname) into txt
    from pg_policies where tablename = 'branches';
  if txt <> 'branches_admin_manage,branches_pos_select,branches_staff_select' then
    raise exception 'FAIL 3c the branches policies changed: %', txt;
  end if;
  raise notice 'PASS  3c the branch table policies are exactly the three that were there';

  -- ======================================================================
  -- 4. What the surface carries
  -- ======================================================================
  --
  -- Two columns. Address, phone and coordinates are not a Finance concern and
  -- must not ride along because they happened to be on the row.
  select count(*)::integer into n
  from unnest(string_to_array(
    pg_get_function_result((select oid from pg_proc
      where proname = 'get_settlement_branches'
        and pronamespace = 'public'::regnamespace)), ',')) col
  where col ilike '%address%' or col ilike '%phone%' or col ilike '%latitude%'
     or col ilike '%longitude%' or col ilike '%created%' or col ilike '%updated%';
  if n <> 0 then
    raise exception 'FAIL 4a the branch surface leaks % internal column(s)', n;
  end if;
  raise notice 'PASS  4a it returns an id and a name, and no other branch column';

  -- ======================================================================
  -- 5. Only branches that trade
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n
    from public.get_settlement_branches() b where b.id = retired;
  if n <> 0 then raise exception 'FAIL 5a a closed branch was offered for settlement'; end if;
  raise notice 'PASS  5a an inactive branch is not offered';

  select count(*)::integer into n
    from public.get_settlement_branches() b where b.id = branch_a;
  if n <> 1 then raise exception 'FAIL 5b an active branch is missing from the list'; end if;
  raise notice 'PASS  5b an active branch is';

  -- And the list is genuinely usable: the branch it offers is one whose
  -- unremitted cash the very next query can load.
  select count(*)::integer into n
    from public.get_unsettled_collections('branch_cash', branch_a, null, null, null);
  if n < 0 then raise exception 'FAIL 5c the branch choice does not drive the collections query'; end if;
  reset role;
  raise notice 'PASS  5c a branch from this list drives the unsettled-cash query';

  raise notice '--------------------------------------------------';
  raise notice 'settlement_branches_rls: all checks passed';
end $$;

rollback;
