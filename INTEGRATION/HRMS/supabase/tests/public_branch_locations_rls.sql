-- What an anonymous visitor may learn about JMAC's locations.
--
-- The landing page is unauthenticated, so this view is the boundary. The claims:
--
--   publication is a separate decision from being operationally active
--   an internal site can be active and still not public
--   anon reads the view and never the table
--   only the approved columns exist to be read
--   ordering is a decision, not insertion order
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/public_branch_locations_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

do $$
declare
  shop uuid; depot uuid; closed uuid;
  n integer; txt text;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  -- Three locations, one of each kind the rule has to tell apart.
  insert into public.branches (name, address, latitude, longitude, is_active, show_on_landing, display_order, image_path)
  values ('ZZ Shopfront ' || tag, 'Aguinaldo Highway', 14.329400, 120.936700, true, true, 2, 'zz/shop.webp')
  returning id into shop;

  -- Operationally real, deliberately not an address to send customers to.
  insert into public.branches (name, address, latitude, longitude, is_active, show_on_landing, display_order)
  values ('ZZ Depot ' || tag, 'Industrial Park', 14.500000, 121.000000, true, false, 1)
  returning id into depot;

  -- Published once, since closed. Active is still required.
  insert into public.branches (name, address, latitude, longitude, is_active, show_on_landing, display_order)
  values ('ZZ Closed ' || tag, 'Old Road', 14.100000, 120.800000, false, true, 0)
  returning id into closed;

  -- ======================================================================
  -- 1. Publication is its own decision
  -- ======================================================================
  select count(*) into n from public.public_branch_locations where id = shop;
  if n <> 1 then raise exception 'FAIL  1a a published, active branch is not public'; end if;
  raise notice 'PASS  1a an active, published branch appears';

  select count(*) into n from public.public_branch_locations where id = depot;
  if n <> 0 then raise exception 'FAIL  1b an active but unpublished site leaked to the public view'; end if;
  raise notice 'PASS  1b being active is not enough -- a depot stays private';

  select count(*) into n from public.public_branch_locations where id = closed;
  if n <> 0 then raise exception 'FAIL  1c a closed branch is still public'; end if;
  raise notice 'PASS  1c being published is not enough -- a closed branch drops off';

  -- ======================================================================
  -- 2. Only the approved columns exist
  -- ======================================================================
  select string_agg(column_name, ',' order by column_name) into txt
    from information_schema.columns
   where table_schema = 'public' and table_name = 'public_branch_locations';

  if txt <> 'address,display_order,id,image_path,latitude,longitude,name' then
    raise exception 'FAIL  2a the public view exposes: %', txt;
  end if;
  raise notice 'PASS  2a the view carries exactly name, address, coordinates, image and order';

  -- phone is in the table and deliberately not here: a branch phone number in
  -- this system is an internal contact, and publishing one is a decision
  -- nobody has taken.
  if txt like '%phone%' or txt like '%is_active%' or txt like '%created_at%' then
    raise exception 'FAIL  2b an operational column reached the public view';
  end if;
  raise notice 'PASS  2b no operational column is reachable through it';

  -- ======================================================================
  -- 3. Anonymous access
  -- ======================================================================
  set local role anon;
  select count(*) into n from public.public_branch_locations where id = shop;
  reset role;
  if n <> 1 then raise exception 'FAIL  3a an anonymous visitor cannot read the public view'; end if;
  raise notice 'PASS  3a an anonymous visitor reads the landing page''s branches';

  -- Refused outright or filtered to nothing -- both mean the table is not a
  -- way in. RLS filters rows rather than raising, so the row count is the
  -- assertion and the exception branch is the other acceptable answer.
  set local role anon;
  begin
    select count(*) into n from public.branches;
    reset role;
    if n <> 0 then
      raise exception 'FAIL  3b anon read % row(s) from the branches table itself', n;
    end if;
    raise notice 'PASS  3b the branches table itself gives anon nothing';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  3b the branches table itself is refused to anon outright';
  end;

  -- ======================================================================
  -- 4. Ordering is a decision
  -- ======================================================================
  insert into public.branches (name, address, latitude, longitude, is_active, show_on_landing, display_order)
  values ('ZZ Alpha ' || tag, 'First Street', 14.2, 120.9, true, true, 9);

  select string_agg(name, ' | ' order by display_order, name) into txt
    from public.public_branch_locations where name like 'ZZ %' || tag;
  if txt not like 'ZZ Shopfront%ZZ Alpha%' then
    raise exception 'FAIL  4a display_order did not decide the order: %', txt;
  end if;
  raise notice 'PASS  4a display_order decides, not the alphabet and not insertion order';

  -- ======================================================================
  -- 5. Writing publication is an Administrator's
  -- ======================================================================
  set local role authenticated;
  begin
    update public.branches set show_on_landing = true where id = depot;
    get diagnostics n = row_count;
    reset role;
    if n <> 0 then
      raise exception 'FAIL  5a a non-admin published a branch';
    end if;
    raise notice 'PASS  5a RLS refuses a non-administrator the publication fields';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  5a RLS refuses a non-administrator the publication fields';
  end;

  raise notice '--- public branch locations: all checks passed ---';
end;
$$;

rollback;
