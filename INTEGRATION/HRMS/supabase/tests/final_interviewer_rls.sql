-- Who may run a final interview — database contract test.
--
-- Written after a production dead end: hosted JMAC has no HR Manager, and the
-- evaluation screen offered only HR Managers, so no initial interview could be
-- passed and recruitment stopped at the first candidate.
--
-- The database was never the problem. protect_final_interviewer_assignment has
-- always accepted `role in ('hr_manager','admin') and status = 'active'`, so an
-- Administrator was always assignable and the screen simply never offered it.
-- This suite pins that rule from both sides, so the fallback cannot be removed
-- by accident and cannot quietly widen to HR Staff.
--
-- Note what the fallback is NOT: it is not "anyone may run a final interview
-- when HR is short-staffed". An Administrator is the enterprise HR authority
-- and needs no employee record; HR Staff remain excluded whether or not an HR
-- Manager exists.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/final_interviewer_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

do $$
declare
  admin_id   uuid;
  staff_id   uuid;
  mgr_id     uuid;
  dept_id    uuid;
  pos_id     uuid;
  job_id     uuid;
  app_id     uuid;
  n          integer;
  txt        text;
  tag        text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into dept_id from public.departments order by name limit 1;
  select id into pos_id from public.positions where department_id = dept_id limit 1;
  if pos_id is null then select id into pos_id from public.positions limit 1; end if;
  if admin_id is null then raise exception 'fixture: need an active administrator'; end if;

  -- The Administrator is the bootstrap authority and is not an employee. That
  -- is the case the dead end involved, so it is the case this suite uses.
  if (select employee_id from public.profiles where id = admin_id) is not null then
    raise notice 'note: this administrator happens to have an employee link';
  end if;

  insert into public.job_postings
    (department_id, position_id, description, requirements, employment_type,
     vacancies, status, posted_by, date_posted, closing_date)
  values (dept_id, pos_id, 'ZZ FinalInt ' || tag, 'r', 'regular', 1, 'open',
          admin_id, now(), current_date + 7)
  returning id into job_id;

  set local role anon;
  select application_id into app_id from public.submit_job_application(
    job_id, 'ZZ', 'Final', 'zz.final.' || tag || '@jmac-test.invalid',
    '09171234567', '1 Test St', 'resumes/zz-' || tag || '.pdf', null,
    null, 'Cavite', 'Imus', 'Barangay 1',
    (current_date - interval '18 years')::date, 'government-ids/zz-' || tag || '.pdf');
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  -- ======================================================================
  -- 1. The hosted scenario: no HR Manager, an Administrator assigns itself
  -- ======================================================================
  select count(*) into n from public.profiles
   where role = 'hr_manager' and status = 'active';
  raise notice 'note: % active HR Manager(s) on this database', n;

  update public.applications set final_interviewer_id = admin_id where id = app_id;

  select final_interviewer_id into txt from public.applications where id = app_id;
  if txt is distinct from admin_id::text then
    raise exception 'FAIL  1a an Administrator could not be assigned the final interview';
  end if;
  raise notice 'PASS  1a an Administrator may be the final interviewer';

  -- ...and needs no employee record to be one. The column is a profiles FK, so
  -- there is nothing to fake and no bootstrap rule to bend.
  if (select employee_id from public.profiles where id = admin_id) is null then
    raise notice 'PASS  1b an Administrator with no employee link is still assignable';
  else
    raise notice 'SKIP  1b this administrator has an employee link';
  end if;

  -- ======================================================================
  -- 2. The fallback does not widen to HR Staff
  -- ======================================================================
  --
  -- The whole point of a fallback is that it is narrow. Being short of HR
  -- Managers must not promote HR Staff into the decision.
  select id into staff_id from public.profiles
   where role = 'hr_staff' and status = 'active' and id <> admin_id limit 1;

  if staff_id is null then
    -- Mint one rather than skip: this is the check that matters most.
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            confirmation_token, recovery_token,
                            email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
            'authenticated', 'authenticated', 'zz.staff.' || tag || '@jmac-test.invalid',
            extensions.crypt('x', extensions.gen_salt('bf')), now(), now(), now(),
            '', '', '', '')
    returning id into staff_id;
    update public.profiles set role = 'hr_staff', status = 'active' where id = staff_id;
  end if;

  begin
    update public.applications set final_interviewer_id = staff_id where id = app_id;
    raise exception 'FAIL  2a HR Staff was accepted as a final interviewer';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a HR Staff cannot be a final interviewer, however short-staffed HR is';
  end;

  -- ======================================================================
  -- 3. Inactive and ineligible accounts stay out
  -- ======================================================================
  update public.profiles set role = 'hr_manager', status = 'inactive' where id = staff_id;
  begin
    update public.applications set final_interviewer_id = staff_id where id = app_id;
    raise exception 'FAIL  3a an inactive HR Manager was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3a an inactive HR Manager cannot be a final interviewer';
  end;

  -- An ordinary employee is not a candidate either.
  update public.profiles set role = 'employee', status = 'active' where id = staff_id;
  begin
    update public.applications set final_interviewer_id = staff_id where id = app_id;
    raise exception 'FAIL  3b an ordinary employee was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3b an ordinary employee cannot be a final interviewer';
  end;

  -- ======================================================================
  -- 4. An active HR Manager remains the normal answer
  -- ======================================================================
  update public.profiles set role = 'hr_manager', status = 'active' where id = staff_id;
  mgr_id := staff_id;

  -- Reassignment away from an existing assignee is Administrator-only, and we
  -- are the Administrator, so this is the supported path.
  update public.applications set final_interviewer_id = mgr_id where id = app_id;
  select final_interviewer_id into txt from public.applications where id = app_id;
  if txt is distinct from mgr_id::text then
    raise exception 'FAIL  4a an active HR Manager could not be assigned';
  end if;
  raise notice 'PASS  4a an active HR Manager is assignable, and is the normal choice';

  -- ======================================================================
  -- 5. The fallback carries the workflow, not just the assignment
  -- ======================================================================
  --
  -- Assigning an Administrator is only useful if the rest of hiring follows.
  update public.applications set final_interviewer_id = admin_id where id = app_id;

  insert into public.interviews
    (application_id, interview_type, scheduled_at, status, mode, location, interviewer_id)
  values (app_id, 'final', now() + interval '2 days', 'scheduled',
          'face_to_face', 'JMAC Head Office', admin_id);

  select count(*) into n from public.interviews
   where application_id = app_id and interview_type = 'final' and interviewer_id = admin_id;
  if n <> 1 then
    raise exception 'FAIL  5a an Administrator could not be recorded as the interviewer';
  end if;
  raise notice 'PASS  5a a final interview can be scheduled with an Administrator running it';

  update public.interviews set status = 'passed'
   where application_id = app_id and interview_type = 'final';

  -- protect_interview_ownership requires the passed final interview to belong
  -- to whoever hires. As the Administrator fallback, that is us.
  update public.applications set status = 'offered' where id = app_id;
  update public.applications set status = 'hired' where id = app_id;

  select status::text into txt from public.applications where id = app_id;
  if txt <> 'hired' then
    raise exception 'FAIL  5b hiring did not complete under the fallback: %', txt;
  end if;
  raise notice 'PASS  5b the offer and hire steps complete under the Administrator fallback';

  -- ======================================================================
  -- 6. The applicant is never told who ran the interview
  -- ======================================================================
  --
  -- The fallback is an internal staffing detail. Emails already carry only the
  -- applicant-safe envelope, and this makes sure the interviewer never leaks
  -- into one.
  select count(*) into n from public.applicant_notification_outbox o
   where o.application_id = app_id
     and (o.payload::text ilike '%administrator%'
       or o.payload::text ilike '%fallback%'
       or o.payload::text like '%' || admin_id::text || '%');
  if n <> 0 then
    raise exception 'FAIL  6a % applicant emails mention the interviewer or the fallback', n;
  end if;
  raise notice 'PASS  6a no applicant email mentions the interviewer or that a fallback was used';

  raise notice '--- all final interviewer checks passed ---';
end $$;

rollback;

select 'applications after rollback: ' || count(*)::text as verify from public.applications;
