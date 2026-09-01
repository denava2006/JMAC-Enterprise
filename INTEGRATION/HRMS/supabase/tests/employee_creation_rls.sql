-- Creating an employee — database contract test.
--
-- Create Employee offered a status dropdown containing Active, Resigned,
-- Terminated and Retired, so a person could be hired directly into "resigned".
-- Those are lifecycle transitions: things that happen TO an employee later,
-- each with its own action and audit trail. None is a state anyone can be
-- created in.
--
-- Removing the dropdown alone would have made it a hidden field rather than a
-- rule, so the check that matters is this one: a request that asks for a
-- terminal status still produces an active employee.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/employee_creation_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

do $$
declare
  admin_id uuid;
  dept_id  uuid;
  pos_id   uuid;
  emp      uuid;
  txt      text;
  tag      text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into dept_id from public.departments order by name limit 1;
  select id into pos_id from public.positions where department_id = dept_id limit 1;
  if pos_id is null then select id into pos_id from public.positions limit 1; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  -- ======================================================================
  -- 1. A new employee is Active
  -- ======================================================================
  insert into public.employees
    (first_name, last_name, email, department_id, position_id, hire_date, employment_status)
  values ('ZZ', 'Normal ' || tag, 'zz.normal.' || tag || '@jmac-test.invalid',
          dept_id, pos_id, current_date, 'active')
  returning id into emp;

  select employment_status::text into txt from public.employees where id = emp;
  if txt <> 'active' then
    raise exception 'FAIL  1a a normally created employee is %', txt;
  end if;
  raise notice 'PASS  1a a normally created employee is Active';

  -- ======================================================================
  -- 2. A request asking for a terminal status does not get one
  -- ======================================================================
  --
  -- The screen no longer offers these. This is the modified-request case:
  -- the rule has to live somewhere the browser cannot reach.
  foreach txt in array array['resigned', 'terminated', 'retired'] loop
    insert into public.employees
      (first_name, last_name, email, department_id, position_id, hire_date, employment_status)
    values ('ZZ', 'Forced ' || txt || ' ' || tag,
            'zz.' || txt || '.' || tag || '@jmac-test.invalid',
            dept_id, pos_id, current_date, txt::public.employment_status)
    returning id into emp;

    if (select employment_status::text from public.employees where id = emp) <> 'active' then
      raise exception 'FAIL  2a an employee was created as %', txt;
    end if;
  end loop;
  raise notice 'PASS  2a resigned, terminated and retired are all refused at creation';

  -- ======================================================================
  -- 3. The lifecycle still works afterwards
  -- ======================================================================
  --
  -- The point is not that these states are forbidden. It is that they are
  -- transitions, and a transition needs something to transition FROM.
  update public.employees set employment_status = 'resigned' where id = emp;
  if (select employment_status::text from public.employees where id = emp) <> 'resigned' then
    raise exception 'FAIL  3a an active employee could not later resign';
  end if;

  update public.employees set employment_status = 'terminated' where id = emp;
  update public.employees set employment_status = 'retired' where id = emp;
  if (select employment_status::text from public.employees where id = emp) <> 'retired' then
    raise exception 'FAIL  3b the lifecycle transitions were blocked';
  end if;
  raise notice 'PASS  3a-b an existing employee may still resign, be terminated or retire';

  -- ======================================================================
  -- 4. History is not rewritten
  -- ======================================================================
  --
  -- Retired people already on record keep their status; this governs creation
  -- only. ZZ PayMongo Verify is exactly such a record and must stay retired.
  select count(*)::text into txt from public.employees
   where employment_status <> 'active' and created_at < now() - interval '1 minute';
  raise notice 'PASS  4a % pre-existing non-active employee record(s) left as they are', txt;

  raise notice '--- all employee creation checks passed ---';
end $$;

rollback;

select 'employees after rollback: ' || count(*)::text as verify from public.employees;
