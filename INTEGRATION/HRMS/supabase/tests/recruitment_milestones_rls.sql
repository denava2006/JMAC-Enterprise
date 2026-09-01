-- Recruitment milestones and application data — database contract test.
--
-- Two gaps this covers:
--
--   An applicant who passed their initial interview was told nothing. The
--   interview trigger stays quiet on outcomes because the APPLICATION's status
--   drives the emails -- but passing an initial interview changes no status, so
--   that one milestone had no voice.
--
--   Track Application could only show the current interview. Nothing wrote
--   application_history except submission, so the earlier stages of a journey
--   simply disappeared from the applicant's view.
--
-- Plus the two things an application must now carry: a date of birth that
-- proves the applicant is 18, and a government ID that is not their resume.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/recruitment_milestones_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

do $$
declare
  admin_id uuid;
  dept_id  uuid;
  pos_id   uuid;
  job_a    uuid;
  app      uuid;
  iv       uuid;
  fiv      uuid;
  n        integer;
  txt      text;
  tag      text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  email    text := 'zz.milestone.' || left(replace(gen_random_uuid()::text,'-',''),8) || '@jmac-test.invalid';
  adult    date := (current_date - interval '18 years')::date;
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into dept_id from public.departments order by name limit 1;
  select id into pos_id from public.positions where department_id = dept_id limit 1;
  if pos_id is null then select id into pos_id from public.positions limit 1; end if;

  insert into public.job_postings
    (department_id, position_id, description, requirements, employment_type,
     vacancies, status, posted_by, date_posted, closing_date)
  values (dept_id, pos_id, 'ZZ Milestones ' || tag, 'r', 'regular', 1, 'open',
          admin_id, now(), current_date + 7)
  returning id into job_a;

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  -- ======================================================================
  -- 1. An application needs a date of birth, and the applicant must be 18
  -- ======================================================================
  begin
    perform public.submit_job_application(
      job_a, 'ZZ', 'NoDob', 'zz.nodob.' || tag || '@jmac-test.invalid', '0917',
      'Addr', 'resumes/' || tag || '-r.pdf', null, null, 'Cavite', 'Imus', 'B1',
      null, 'government-ids/' || tag || '-id.pdf');
    raise exception 'FAIL  1a an application was accepted with no date of birth';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1a a date of birth is required';
  end;

  -- One day short. Year subtraction would have let this through from January.
  begin
    perform public.submit_job_application(
      job_a, 'ZZ', 'Underage', 'zz.under.' || tag || '@jmac-test.invalid', '0917',
      'Addr', 'resumes/' || tag || '-r2.pdf', null, null, 'Cavite', 'Imus', 'B1',
      (adult + interval '1 day')::date, 'government-ids/' || tag || '-id2.pdf');
    raise exception 'FAIL  1b somebody one day short of 18 was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1b one day short of 18 is refused, by real date arithmetic';
  end;

  -- ======================================================================
  -- 2. A government ID is required, and is not the resume
  -- ======================================================================
  begin
    perform public.submit_job_application(
      job_a, 'ZZ', 'NoId', 'zz.noid.' || tag || '@jmac-test.invalid', '0917',
      'Addr', 'resumes/' || tag || '-r3.pdf', null, null, 'Cavite', 'Imus', 'B1',
      adult, null);
    raise exception 'FAIL  2a an application was accepted with no government ID';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a a government ID is required';
  end;

  -- The same file offered as both. This is how a CV ends up filed as proof of
  -- identity, which is worse than having no ID at all: it looks verified.
  begin
    perform public.submit_job_application(
      job_a, 'ZZ', 'SameFile', 'zz.same.' || tag || '@jmac-test.invalid', '0917',
      'Addr', 'resumes/' || tag || '-dup.pdf', null, null, 'Cavite', 'Imus', 'B1',
      adult, 'resumes/' || tag || '-dup.pdf');
    raise exception 'FAIL  2b the resume was accepted as the government ID';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2b a resume cannot stand in as the government ID';
  end;

  -- ======================================================================
  -- 3. Exactly 18 is accepted, and the data is snapshotted
  -- ======================================================================
  select application_id into app from public.submit_job_application(
    job_a, 'ZZ', 'Milestone', email, '09171234567',
    'Blk 7 Lot 3', 'resumes/' || tag || '-cv.pdf', null, 'Mid',
    'Cavite', 'Dasmariñas', 'Santa Maria', adult,
    'government-ids/' || tag || '-id.pdf');
  raise notice 'PASS  3a somebody exactly 18 today may apply';

  select applicant_birth_date::text into txt from public.applications where id = app;
  if txt <> adult::text then
    raise exception 'FAIL  3b the date of birth was not recorded: %', txt;
  end if;
  select applicant_government_id_path into txt from public.applications where id = app;
  if txt is null or txt = '' then
    raise exception 'FAIL  3c the government ID path was not recorded';
  end if;
  raise notice 'PASS  3b-c both are recorded on the application snapshot';

  -- Immutable, like the rest of the snapshot.
  begin
    update public.applications set applicant_birth_date = '1990-01-01' where id = app;
    raise exception 'FAIL  3d the submitted date of birth was editable';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3d the submitted date of birth cannot be edited';
  end;

  -- ======================================================================
  -- 4. The journey is recorded as it happens
  -- ======================================================================
  update public.applications set status = 'under_review' where id = app;
  update public.applications set status = 'qualified' where id = app;

  insert into public.interviews (application_id, interview_type, scheduled_at, status, interviewer_id)
  values (app, 'initial', now() + interval '1 day', 'scheduled', admin_id)
  returning id into iv;

  select string_agg(event, ' > ' order by created_at) into txt
    from public.application_history where application_id = app;
  if txt <> 'submitted > reviewed > qualified > initial_interview_scheduled' then
    raise exception 'FAIL  4a the timeline reads: %', txt;
  end if;
  raise notice 'PASS  4a every stage so far is on the timeline';

  -- ======================================================================
  -- 5. Passing the initial interview tells the applicant
  -- ======================================================================
  update public.interviews set status = 'passed' where id = iv;

  select count(*) into n from public.applicant_notification_outbox
   where application_id = app and event_type = 'initial_interview_passed';
  if n <> 1 then
    raise exception 'FAIL  5a passing the initial interview queued % emails', n;
  end if;
  raise notice 'PASS  5a passing the initial interview sends exactly one email';

  -- Re-saving the evaluation -- correcting a rating, adding a note -- must not
  -- send it again. The dedupe key is the interview itself.
  update public.interviews set rating_communication = 5 where id = iv;
  update public.interviews set interview_notes = 'strong candidate' where id = iv;
  update public.interviews set overall_impression = 'recommended' where id = iv;

  select count(*) into n from public.applicant_notification_outbox
   where application_id = app and event_type = 'initial_interview_passed';
  if n <> 1 then
    raise exception 'FAIL  5b re-saving the evaluation sent % emails', n;
  end if;
  select count(*) into n from public.application_history
   where application_id = app and event = 'initial_interview_passed';
  if n <> 1 then
    raise exception 'FAIL  5c re-saving recorded the milestone % times', n;
  end if;
  raise notice 'PASS  5b-c re-saving an evaluation neither re-sends nor re-records';

  -- Nothing about the evaluation travels with it.
  select o.payload::text into txt from public.applicant_notification_outbox o
   where o.application_id = app and o.event_type = 'initial_interview_passed';
  if txt ilike '%strong candidate%' or txt ilike '%recommended%'
     or txt ilike '%rating%' or txt ilike '%5%' and txt ilike '%communication%' then
    raise exception 'FAIL  5d the email payload carries evaluation detail: %', txt;
  end if;
  raise notice 'PASS  5d the email carries no rating, note or impression';

  -- ======================================================================
  -- 6. Passing the FINAL interview does not
  -- ======================================================================
  --
  -- What the applicant hears next is the outcome -- offered, hired, or not
  -- moving forward -- and each has its own email. A "you passed" in between
  -- would promise a result nobody has decided yet.
  insert into public.interviews (application_id, interview_type, scheduled_at, status, interviewer_id)
  values (app, 'final', now() + interval '3 days', 'scheduled', admin_id)
  returning id into fiv;
  update public.interviews set status = 'passed' where id = fiv;

  select count(*) into n from public.applicant_notification_outbox
   where application_id = app
     and event_type = 'initial_interview_passed'
     and dedupe_key = fiv::text;
  if n <> 0 then
    raise exception 'FAIL  6a passing the final interview sent a pass email';
  end if;
  raise notice 'PASS  6a passing the final interview sends no separate email';

  -- ======================================================================
  -- 7. The applicant can read their own timeline, and only that
  -- ======================================================================
  update public.applications set status = 'hired' where id = app;
  update public.applications set status = 'deployed' where id = app;

  select a.reference_code into txt from public.applications a where a.id = app;

  set local role anon;
  select string_agg(event, ' > ' order by occurred_at) into txt
    from public.lookup_application_milestones(txt, email);
  reset role;

  if txt not like 'submitted > reviewed > qualified > initial_interview_scheduled > initial_interview_passed%' then
    raise exception 'FAIL  7a the applicant timeline reads: %', txt;
  end if;
  if txt not like '%hired%' or txt not like '%deployment_completed%' then
    raise exception 'FAIL  7b the later stages are missing: %', txt;
  end if;
  raise notice 'PASS  7a-b the applicant sees the whole journey, not just the latest step';

  -- Internal events are not on it. final_interview_passed is recorded for HR
  -- but is deliberately absent from what the applicant is shown.
  if txt like '%final_interview_passed%' then
    raise exception 'FAIL  7c an internal milestone reached the applicant';
  end if;
  raise notice 'PASS  7c internal milestones stay internal';

  -- ======================================================================
  -- 8. The timeline is not a way to read somebody else's application
  -- ======================================================================
  select a.reference_code into txt from public.applications a where a.id = app;
  set local role anon;
  select count(*) into n from public.lookup_application_milestones(txt, 'someone.else@example.com');
  reset role;
  if n <> 0 then
    raise exception 'FAIL  8a the wrong email returned % milestones', n;
  end if;
  raise notice 'PASS  8a the reference code alone is not enough';

  raise notice '--- all recruitment milestone checks passed ---';
end $$;

rollback;

select 'history rows after rollback: ' || count(*)::text as verify from public.application_history;
