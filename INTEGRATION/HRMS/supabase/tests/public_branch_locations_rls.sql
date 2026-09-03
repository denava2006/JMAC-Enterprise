-- The public branch surface, and what it refuses to carry.
--
-- The landing page reads this as an anonymous visitor. The claims:
--
--   anon can read active branches through the view
--   anon still cannot read the branches table
--   an archived branch disappears from the public list
--   the view carries no operational column, now or after a schema change
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/public_branch_locations_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

do $$
declare
  admin_id uuid;
  live_id  uuid;
  dead_id  uuid;
  n        integer;
  txt      text;
  tag      text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  if admin_id is null then raise exception 'fixture: need an active administrator'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  insert into public.branches (name, address, latitude, longitude, is_active)
  values ('ZZ Public ' || tag, '1 Test Street', 14.5995, 120.9842, true)
  returning id into live_id;

  insert into public.branches (name, address, latitude, longitude, is_active)
  values ('ZZ Archived ' || tag, '2 Old Road', 10.3157, 123.8854, false)
  returning id into dead_id;

  -- ======================================================================
  -- 1. An anonymous visitor can read the public list
  -- ======================================================================
  --
  -- The claims are cleared, not just the role. A real anonymous request
  -- carries no JWT at all, and leaving an administrator's sub in
  -- request.jwt.claims while switching to the anon role leaves is_admin()
  -- true -- which the {public}-targeted branches_admin_manage policy then
  -- honours. That would test the fixture rather than the boundary.
  perform set_config('request.jwt.claims', '', true);
  set local role anon;

  select count(*) into n from public.public_branch_locations where id = live_id;
  if n <> 1 then raise exception 'FAIL 1a anon cannot see an active branch (% rows)', n; end if;
  raise notice 'PASS  1a an anonymous visitor reads active branches';

  select name into txt from public.public_branch_locations where id = live_id;
  if txt is null or txt not like 'ZZ Public%' then
    raise exception 'FAIL 1b the view did not carry the branch name';
  end if;
  select address into txt from public.public_branch_locations where id = live_id;
  if txt <> '1 Test Street' then raise exception 'FAIL 1b the view did not carry the address'; end if;
  raise notice 'PASS  1b name, address and coordinates are what it carries';

  -- ======================================================================
  -- 2. The table itself stays shut
  -- ======================================================================
  --
  -- The view is the authorization boundary. If the table were readable the
  -- view would be decoration.
  select count(*) into n from public.branches;
  if n <> 0 then
    raise exception 'FAIL 2a anon read % row(s) from the branches table itself', n;
  end if;
  raise notice 'PASS  2a the branches table remains closed to the public';

  -- ======================================================================
  -- 3. An archived branch is not a public location
  -- ======================================================================
  select count(*) into n from public.public_branch_locations where id = dead_id;
  if n <> 0 then raise exception 'FAIL 3a an archived branch is publicly listed'; end if;
  raise notice 'PASS  3a archiving a branch removes it from the public list';
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  -- Flipping it back is all it takes to publish it again -- one switch, the
  -- one the back office already maintains.
  update public.branches set is_active = true where id = dead_id;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  select count(*) into n from public.public_branch_locations where id = dead_id;
  if n <> 1 then raise exception 'FAIL 3b reinstating a branch did not republish it'; end if;
  raise notice 'PASS  3b reinstating it publishes it again, with no second switch';
  reset role;

  -- ======================================================================
  -- 4. Nothing operational rides along
  -- ======================================================================
  --
  -- Asserted against the view's own column list rather than against one row: a
  -- column that does not exist cannot leak, and this also catches a future
  -- `select *` rewrite that would quietly publish whatever branches gains next.
  select string_agg(column_name, ', ' order by column_name) into txt
    from information_schema.columns
   where table_schema = 'public' and table_name = 'public_branch_locations';
  if txt <> 'address, id, latitude, longitude, name' then
    raise exception 'FAIL 4a the public view exposes: %', txt;
  end if;
  raise notice 'PASS  4a the public view carries exactly name, address and coordinates';

  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'public_branch_locations'
     and column_name in ('phone', 'is_active', 'created_at', 'updated_at');
  if n <> 0 then
    raise exception 'FAIL 4b an operational column reached the public view';
  end if;
  raise notice 'PASS  4b no contact, state or administrative column is published';

  -- ======================================================================
  -- 5. Read only
  -- ======================================================================
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin
    insert into public.public_branch_locations (id, name, address, latitude, longitude)
    values (gen_random_uuid(), 'ZZ Injected', 'nowhere', 0, 0);
    raise exception 'FAIL 5a anon wrote through the public view';
  exception when insufficient_privilege or feature_not_supported then
    raise notice 'PASS  5a the public surface is read-only';
  end;
  reset role;
end $$;

rollback;
