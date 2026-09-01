-- The public Careers page — database contract test.
--
-- This exists because the public path broke in production in a way no test
-- covered: an anonymous request to /careers returned
--
--   401 {"code":"42501","message":"permission denied for function is_active_staff"}
--
-- A staff RLS policy on job_postings targeted the `public` role, which includes
-- anon, so an anonymous visitor had to evaluate a function they are not allowed
-- to call. Every existing suite tested signed-in roles, so nothing noticed.
--
-- The checks below are therefore written from the anonymous visitor's seat, and
-- they care about two opposite things: an open posting MUST be readable by a
-- stranger, and everything else about the organisation must NOT be.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/public_careers_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

do $$
declare
  admin_id   uuid;
  dept_id    uuid;
  pos_id     uuid;
  open_id    uuid;
  closed_id  uuid;
  expired_id uuid;
  draft_id   uuid;
  n          integer;
  txt        text;
  rec        record;
  tag        text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  ------------------------------------------------------------------ fixtures
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into dept_id from public.departments order by name limit 1;
  select id into pos_id from public.positions where department_id = dept_id limit 1;
  if pos_id is null then
    select id into pos_id from public.positions limit 1;
  end if;
  if admin_id is null or dept_id is null or pos_id is null then
    raise exception 'fixture: need an admin, a department and a position';
  end if;

  -- Four postings covering every visibility state the enum allows.
  insert into public.job_postings
    (department_id, position_id, description, requirements, employment_type,
     vacancies, status, posted_by, date_posted, closing_date)
  values (dept_id, pos_id, 'ZZ Open ' || tag, 'ZZ Reqs ' || tag, 'regular',
          5, 'open', admin_id, now(), current_date + 7)
  returning id into open_id;

  insert into public.job_postings
    (department_id, position_id, description, requirements, employment_type,
     vacancies, status, posted_by, date_posted, closing_date)
  values (dept_id, pos_id, 'ZZ Closed ' || tag, 'r', 'regular',
          1, 'closed', admin_id, now(), current_date + 7)
  returning id into closed_id;

  -- Open, but its own closing date has passed. HR has not got round to
  -- flipping the status, and the public must not see it regardless.
  insert into public.job_postings
    (department_id, position_id, description, requirements, employment_type,
     vacancies, status, posted_by, date_posted, closing_date)
  values (dept_id, pos_id, 'ZZ Expired ' || tag, 'r', 'regular',
          1, 'open', admin_id, now() - interval '30 days', current_date - 1)
  returning id into expired_id;

  insert into public.job_postings
    (department_id, position_id, description, requirements, employment_type,
     vacancies, status, posted_by, date_posted, closing_date)
  values (dept_id, pos_id, 'ZZ Draft ' || tag, 'r', 'regular',
          1, 'draft', admin_id, now(), current_date + 7)
  returning id into draft_id;

  -- ======================================================================
  -- 1. A stranger can see an open posting, and everything the page needs
  -- ======================================================================
  set local role anon;

  select count(*) into n from public.get_public_job_postings() p where p.id = open_id;
  if n <> 1 then
    raise exception 'FAIL  1a an anonymous visitor cannot see an open posting';
  end if;
  raise notice 'PASS  1a an anonymous visitor can read an open, current posting';

  select * into rec from public.get_public_job_postings() p where p.id = open_id;

  if coalesce(rec.department_name, '') = '' then
    raise exception 'FAIL  1b no department name';
  end if;
  if coalesce(rec.position_title, '') = '' then
    raise exception 'FAIL  1c no position title';
  end if;
  if rec.description not like 'ZZ Open%' then
    raise exception 'FAIL  1d description is %', rec.description;
  end if;
  if rec.requirements not like 'ZZ Reqs%' then
    raise exception 'FAIL  1e requirements are %', rec.requirements;
  end if;
  if rec.employment_type <> 'regular' then
    raise exception 'FAIL  1f employment type is %', rec.employment_type;
  end if;
  if rec.vacancies <> 5 then
    raise exception 'FAIL  1g vacancies are %', rec.vacancies;
  end if;
  if rec.closing_date <> current_date + 7 then
    raise exception 'FAIL  1h closing date is %', rec.closing_date;
  end if;
  if rec.date_posted is null then
    raise exception 'FAIL  1i no posted date';
  end if;
  raise notice 'PASS  1b-i every field the Careers page needs is present';

  -- The detail route must work for the same visitor.
  select count(*) into n from public.get_public_job_posting(open_id);
  if n <> 1 then
    raise exception 'FAIL  1j the job detail route cannot read an open posting';
  end if;
  raise notice 'PASS  1j the job detail route works anonymously';

  -- ======================================================================
  -- 2. Everything else stays hidden
  -- ======================================================================
  select count(*) into n from public.get_public_job_postings() p where p.id = closed_id;
  if n <> 0 then
    raise exception 'FAIL  2a a closed posting is public';
  end if;
  raise notice 'PASS  2a a closed posting is hidden';

  select count(*) into n from public.get_public_job_postings() p where p.id = expired_id;
  if n <> 0 then
    raise exception 'FAIL  2b a posting past its closing date is public';
  end if;
  raise notice 'PASS  2b a posting past its closing date is hidden';

  select count(*) into n from public.get_public_job_postings() p where p.id = draft_id;
  if n <> 0 then
    raise exception 'FAIL  2c a draft posting is public';
  end if;
  raise notice 'PASS  2c a draft posting is hidden';

  -- Knowing the uuid must not be enough for any of them.
  select count(*) into n from public.get_public_job_posting(closed_id);
  if n <> 0 then raise exception 'FAIL  2d a closed posting is readable by id'; end if;
  select count(*) into n from public.get_public_job_posting(expired_id);
  if n <> 0 then raise exception 'FAIL  2e an expired posting is readable by id'; end if;
  select count(*) into n from public.get_public_job_posting(draft_id);
  if n <> 0 then raise exception 'FAIL  2f a draft posting is readable by id'; end if;
  raise notice 'PASS  2d-f guessing a uuid does not reveal a hidden posting';

  -- ======================================================================
  -- 3. The organisation is not public
  -- ======================================================================
  --
  -- The old page resolved names by embedding departments(name) and
  -- positions(title), which only worked because anon could read both tables in
  -- full. An applicant browsing jobs should not be able to enumerate the
  -- company's structure.
  select count(*) into n from public.departments;
  if n <> 0 then
    raise exception 'FAIL  3a an anonymous visitor read % departments', n;
  end if;
  raise notice 'PASS  3a the departments table is not anonymously readable';

  select count(*) into n from public.positions;
  if n <> 0 then
    raise exception 'FAIL  3b an anonymous visitor read % positions', n;
  end if;
  raise notice 'PASS  3b the positions table is not anonymously readable';

  -- The postings table itself is no longer part of the public surface: the
  -- function is. Reading it directly must yield nothing rather than erroring,
  -- so a stray query fails safely instead of 401-ing the page.
  select count(*) into n from public.job_postings;
  if n <> 0 then
    raise exception 'FAIL  3c an anonymous visitor read % job postings directly', n;
  end if;
  raise notice 'PASS  3c the job_postings table is not anonymously readable';

  select count(*) into n from public.employees;
  if n <> 0 then
    raise exception 'FAIL  3d an anonymous visitor read % employees', n;
  end if;
  select count(*) into n from public.profiles;
  if n <> 0 then
    raise exception 'FAIL  3e an anonymous visitor read % profiles', n;
  end if;
  select count(*) into n from public.applications;
  if n <> 0 then
    raise exception 'FAIL  3f an anonymous visitor read % applications', n;
  end if;
  select count(*) into n from public.applicants;
  if n <> 0 then
    raise exception 'FAIL  3g an anonymous visitor read % applicants', n;
  end if;
  raise notice 'PASS  3d-g employees, profiles, applications and applicants stay private';

  -- ======================================================================
  -- 4. The public payload carries no HR metadata
  -- ======================================================================
  --
  -- Asserted on the function's own signature rather than on a row, so adding a
  -- column to the return type later trips this immediately.
  reset role;
  select string_agg(a.attname, ',' order by a.attnum) into txt
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  cross join lateral unnest(p.proallargtypes, p.proargnames) with ordinality as u(t, name, ord)
  join lateral (select u.name as attname, u.ord as attnum) a on true
  where ns.nspname = 'public' and p.proname = 'get_public_job_postings';

  if txt like '%posted_by%' or txt like '%created_at%' or txt like '%updated_at%'
     or txt like '%department_id%' or txt like '%position_id%' then
    raise exception 'FAIL  4a the public payload exposes HR metadata: %', txt;
  end if;
  raise notice 'PASS  4a the public payload carries no creator, timestamps or internal ids';

  -- ======================================================================
  -- 5. A stranger cannot change anything
  -- ======================================================================
  set local role anon;
  begin
    insert into public.job_postings
      (department_id, position_id, description, employment_type, vacancies, status, posted_by)
    values (dept_id, pos_id, 'ZZ Hostile', 'regular', 1, 'open', admin_id);
    raise exception 'FAIL  5a an anonymous visitor created a job posting';
  exception when insufficient_privilege or check_violation then
    raise notice 'PASS  5a an anonymous visitor cannot create a job posting';
  when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  5a an anonymous visitor cannot create a job posting';
  end;

  begin
    update public.job_postings set status = 'closed' where id = open_id;
    if found then
      raise exception 'FAIL  5b an anonymous visitor closed a posting';
    end if;
    raise notice 'PASS  5b an anonymous visitor cannot change a posting';
  exception when insufficient_privilege then
    raise notice 'PASS  5b an anonymous visitor cannot change a posting';
  when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  5b an anonymous visitor cannot change a posting';
  end;
  reset role;

  -- ======================================================================
  -- 6. HR still sees everything it manages
  -- ======================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.job_postings
   where id in (open_id, closed_id, expired_id, draft_id);
  if n <> 4 then
    raise exception 'FAIL  6a an Administrator sees only % of 4 postings', n;
  end if;
  raise notice 'PASS  6a an Administrator still sees drafts, closed and expired postings';

  select count(*) into n from public.departments;
  if n = 0 then
    raise exception 'FAIL  6b an Administrator cannot read departments';
  end if;
  select count(*) into n from public.positions;
  if n = 0 then
    raise exception 'FAIL  6c an Administrator cannot read positions';
  end if;
  raise notice 'PASS  6b-c management still reads the reference tables';
  reset role;

  raise notice '--- all public careers contract checks passed ---';
end $$;

rollback;

select 'job postings after rollback: ' || count(*)::text as verify from public.job_postings;
