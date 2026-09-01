-- Application identity — database contract test.
--
-- Written after a real application was renamed by a later one. APP-2026-0003
-- was submitted by Clark Kint De Nava and then displayed "ZZ CronCheck" in HR
-- detail, in Track Application, and in the Create Employee handoff -- which
-- carried the wrong name into an actual employee record.
--
-- The cause was that submit_job_application finds an applicant by email and
-- rewrites that row, while `applications` held no identity of its own. One
-- shared, mutable row, read by all of history. Every application by that person
-- silently became whatever the most recent one said.
--
-- So the scenario below is the bug itself, written down: two applications, one
-- email, different names. The first must never change.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/application_identity_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

do $$
declare
  admin_id  uuid;
  dept_id   uuid;
  pos_id    uuid;
  job_a     uuid;
  job_b     uuid;
  app_a     uuid;
  app_b     uuid;
  person    uuid;
  person_b  uuid;
  n         integer;
  txt       text;
  ref_a     text;
  tag       text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  shared    text := 'zz.same.' || left(replace(gen_random_uuid()::text,'-',''),8) || '@jmac-test.invalid';
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into dept_id from public.departments order by name limit 1;
  select id into pos_id from public.positions where department_id = dept_id limit 1;
  if pos_id is null then select id into pos_id from public.positions limit 1; end if;

  insert into public.job_postings
    (department_id, position_id, description, requirements, employment_type,
     vacancies, status, posted_by, date_posted, closing_date)
  values (dept_id, pos_id, 'ZZ Ident A ' || tag, 'r', 'regular', 1, 'open',
          admin_id, now(), current_date + 7)
  returning id into job_a;

  insert into public.job_postings
    (department_id, position_id, description, requirements, employment_type,
     vacancies, status, posted_by, date_posted, closing_date)
  values (dept_id, pos_id, 'ZZ Ident B ' || tag, 'r', 'regular', 1, 'open',
          admin_id, now(), current_date + 7)
  returning id into job_b;

  -- ======================================================================
  -- 1. Application A: the genuine one
  -- ======================================================================
  set local role anon;
  select application_id, applicant_id into app_a, person
  from public.submit_job_application(
    job_a, 'Clark Kint', 'De Nava', shared, '09171112222',
    'Blk 5 Lot 9, Real Subdivision',
    'resumes/zz-' || tag || '-a.pdf', null,
    'Ong', 'Cavite', 'Dasmariñas', 'Santa Maria',
    (current_date - interval '18 years')::date, 'government-ids/zz-' || tag || '-a.pdf', 'Male', 'Filipino');
  reset role;

  select applicant_first_name || '|' || coalesce(applicant_middle_name,'') || '|' || applicant_last_name
    into txt from public.applications where id = app_a;
  if txt <> 'Clark Kint|Ong|De Nava' then
    raise exception 'FAIL  1a A did not snapshot its own name: %', txt;
  end if;
  raise notice 'PASS  1a an application records the name it was submitted with';

  select applicant_province || '|' || applicant_city || '|' || applicant_barangay
    into txt from public.applications where id = app_a;
  if txt <> 'Cavite|Dasmariñas|Santa Maria' then
    raise exception 'FAIL  1b A did not snapshot its own address: %', txt;
  end if;
  raise notice 'PASS  1b it records the address and contact submitted with it';

  -- ======================================================================
  -- 2. Application B: the same person, a different name
  -- ======================================================================
  --
  -- Exactly what happened in production, deliberately reproduced.
  set local role anon;
  select application_id, applicant_id into app_b, person_b
  from public.submit_job_application(
    job_b, 'ZZ', 'CronCheck', shared, '09179998888',
    'Blk 1 Lot 2, Test Subdivision',
    'resumes/zz-' || tag || '-b.pdf', null,
    null, 'Cavite', 'Imus', 'Barangay 1',
    (current_date - interval '18 years')::date, 'government-ids/zz-' || tag || '-b.pdf', 'Male', 'Filipino');
  reset role;

  -- The person record is deliberately reused: it is the same human being.
  if person_b is distinct from person then
    raise exception 'FAIL  2a the same email produced two applicant records';
  end if;
  raise notice 'PASS  2a one email is still one person -- the record is reused';

  -- THE CHECK THIS SUITE EXISTS FOR.
  select applicant_first_name || '|' || coalesce(applicant_middle_name,'') || '|' || applicant_last_name
    into txt from public.applications where id = app_a;
  if txt <> 'Clark Kint|Ong|De Nava' then
    raise exception 'FAIL  2b submitting B renamed A to: %', txt;
  end if;
  raise notice 'PASS  2b submitting B does not rename A';

  select applicant_province || '|' || applicant_city || '|' || applicant_barangay
    into txt from public.applications where id = app_a;
  if txt <> 'Cavite|Dasmariñas|Santa Maria' then
    raise exception 'FAIL  2c submitting B rewrote A''s address to: %', txt;
  end if;
  select applicant_phone into txt from public.applications where id = app_a;
  if txt <> '09171112222' then
    raise exception 'FAIL  2d submitting B rewrote A''s phone to: %', txt;
  end if;
  raise notice 'PASS  2c-d B does not rewrite A''s address or contact number';

  -- The CV is part of what was submitted. An interviewer opening A must read
  -- the document A arrived with, not whatever this person uploaded last.
  select applicant_resume_url into txt from public.applications where id = app_a;
  if txt <> 'resumes/zz-' || tag || '-a.pdf' then
    raise exception 'FAIL  2f submitting B replaced A''s resume with: %', txt;
  end if;
  raise notice 'PASS  2f an application keeps the CV it was submitted with';

  -- B is itself, too.
  select applicant_first_name || '|' || applicant_last_name into txt
    from public.applications where id = app_b;
  if txt <> 'ZZ|CronCheck' then
    raise exception 'FAIL  2e B did not record its own name: %', txt;
  end if;
  raise notice 'PASS  2e B records its own identity, distinct from A';

  -- ======================================================================
  -- 3. Deleting B leaves A alone
  -- ======================================================================
  delete from public.applicant_notification_outbox where application_id = app_b;
  delete from public.application_history where application_id = app_b;
  delete from public.applications where id = app_b;

  select applicant_first_name || '|' || applicant_last_name into txt
    from public.applications where id = app_a;
  if txt <> 'Clark Kint|De Nava' then
    raise exception 'FAIL  3a deleting B changed A to: %', txt;
  end if;
  raise notice 'PASS  3a deleting B leaves A untouched';

  -- ======================================================================
  -- 4. The snapshot cannot be edited in passing
  -- ======================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  begin
    update public.applications set applicant_first_name = 'Someone Else' where id = app_a;
    raise exception 'FAIL  4a the submitted identity was editable';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  4a the submitted identity cannot be edited';
  end;

  -- Ordinary work on the application still succeeds.
  update public.applications set notes = 'reviewed' where id = app_a;
  raise notice 'PASS  4b ordinary updates to the application still work';

  -- ======================================================================
  -- 5. Emails greet the application, not the latest contact record
  -- ======================================================================
  --
  -- The corruption reached applicants' inboxes too: later emails for the
  -- genuine application were addressed to "ZZ CronCheck".
  update public.applications set status = 'under_review' where id = app_a;

  select o.payload->>'applicant_name' into txt
    from public.applicant_notification_outbox o
   where o.application_id = app_a and o.event_type = 'application_under_review';
  if txt <> 'Clark Kint De Nava' then
    raise exception 'FAIL  5a the email greets "%", not the person who applied', txt;
  end if;
  raise notice 'PASS  5a an email greets whoever submitted THAT application';

  -- ======================================================================
  -- 6. Track Application shows the applicant their own name
  -- ======================================================================
  --
  -- The applicant-facing page, and the one place an outsider saw the wrong
  -- name: she entered her own reference code and was greeted as someone else.
  -- Read the reference code as staff: an applicant knows it from her own
  -- email, but anon cannot select the row it came from -- which is the point.
  select a.reference_code into ref_a from public.applications a where a.id = app_a;

  set local role anon;
  select applicant_name into txt from public.lookup_application(ref_a, shared);
  reset role;
  if txt is distinct from 'Clark Kint De Nava' then
    raise exception 'FAIL  6a Track Application greets "%"', txt;
  end if;
  raise notice 'PASS  6a Track Application greets whoever submitted that application';

  raise notice '--- all application identity checks passed ---';
end $$;

rollback;

select 'applications after rollback: ' || count(*)::text as verify from public.applications;
