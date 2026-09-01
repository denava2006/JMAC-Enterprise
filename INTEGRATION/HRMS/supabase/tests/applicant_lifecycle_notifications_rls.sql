-- The applicant notification lifecycle — database contract test.
--
-- applicant_notifications_rls.sql already covers the outbox's own rules: who
-- may read it, that last_error never reaches an applicant, and that the table
-- is RPC-only. This suite covers the other question -- does the RIGHT email get
-- queued at the right moment, exactly once, and does nothing internal leak into
-- it.
--
-- The two halves matter equally. An applicant left in silence between "we have
-- your application" and "you are shortlisted" is a real complaint; an applicant
-- emailed a reviewer's score is a real incident.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/applicant_lifecycle_notifications_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written, and no email is
-- sent: queuing and delivery are separate by design.

begin;

do $$
declare
  admin_id  uuid;
  dept_id   uuid;
  pos_id    uuid;
  job_id    uuid;
  app_id    uuid;
  app_id2   uuid;
  job_id2   uuid;
  appl_id   uuid;
  intv_id   uuid;
  n         integer;
  txt       text;
  pl        jsonb;
  tag       text := left(replace(gen_random_uuid()::text, '-', ''), 8);

begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into dept_id from public.departments order by name limit 1;
  select id into pos_id from public.positions where department_id = dept_id limit 1;
  if pos_id is null then select id into pos_id from public.positions limit 1; end if;

  insert into public.job_postings
    (department_id, position_id, description, requirements, employment_type,
     vacancies, status, posted_by, date_posted, closing_date)
  values (dept_id, pos_id, 'ZZ Notify ' || tag, 'r', 'regular', 1, 'open',
          admin_id, now(), current_date + 7)
  returning id into job_id;

  -- ======================================================================
  -- 1. Submitting queues exactly one "received"
  -- ======================================================================
  set local role anon;
  select application_id, applicant_id into app_id, appl_id
  from public.submit_job_application(
    job_id, 'ZZ', 'Notify', 'zz.notify.' || tag || '@jmac-test.invalid',
    '09171234567', '1 Test St', 'resumes/zz-' || tag || '.pdf', null,
    null, 'Cavite', 'Imus', 'Barangay 1');
  reset role;

  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'application_submitted';
  if n <> 1 then
    raise exception 'FAIL  1a % application_submitted queued, expected 1', n;
  end if;
  raise notice 'PASS  1a submitting queues exactly one received email';

  -- ======================================================================
  -- 2. The screening email -- the gap this phase closed
  -- ======================================================================
  update public.applications set status = 'under_review' where id = app_id;

  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'application_under_review';
  if n <> 1 then
    raise exception 'FAIL  2a % under_review emails queued, expected 1', n;
  end if;
  raise notice 'PASS  2a moving into review queues the screening email';

  -- ======================================================================
  -- 3. Internal edits are silent
  -- ======================================================================
  --
  -- The whole point of gating on a status change. HR works inside this row all
  -- day and the applicant must hear none of it.
  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id;

  update public.applications
     set notes = 'Strong on paper, weak on detail',
         rejection_reason = 'internal only',
         reviewed_by = admin_id,
         reviewed_at = now()
   where id = app_id;

  select count(*) - n into n from public.applicant_notification_outbox
   where application_id = app_id;
  if n <> 0 then
    raise exception 'FAIL  3a editing internal fields queued % emails', n;
  end if;
  raise notice 'PASS  3a editing notes and reasons queues nothing';

  -- Saving the same status again is not a new event either.
  update public.applications set status = 'under_review' where id = app_id;
  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'application_under_review';
  if n <> 1 then
    raise exception 'FAIL  3b re-saving the same status queued % emails', n;
  end if;
  raise notice 'PASS  3b re-saving the same status sends nothing further';

  -- ======================================================================
  -- 4. Shortlist, exactly once
  -- ======================================================================
  update public.applications set status = 'qualified' where id = app_id;
  update public.applications set notes = 'still shortlisted' where id = app_id;

  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'application_shortlisted';
  if n <> 1 then
    raise exception 'FAIL  4a % shortlist emails queued, expected 1', n;
  end if;
  raise notice 'PASS  4a shortlisting emails once, and editing notes after does not repeat it';

  -- ======================================================================
  -- 5. Interviews: scheduled, moved, cancelled
  -- ======================================================================
  insert into public.interviews
    (application_id, interview_type, scheduled_at, status, mode, location, interviewer_id)
  values (app_id, 'initial', now() + interval '3 days', 'scheduled',
          'face_to_face', 'JMAC Head Office', admin_id)
  returning id into intv_id;

  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'interview_scheduled';
  if n <> 1 then
    raise exception 'FAIL  5a % interview_scheduled queued, expected 1', n;
  end if;

  select o.payload into pl from public.applicant_notification_outbox o
   where o.application_id = app_id and o.event_type = 'interview_scheduled';
  if coalesce(pl->>'scheduled_at','') = '' or coalesce(pl->>'scheduled_time','') = '' then
    raise exception 'FAIL  5b the interview email carries no date or time: %', pl;
  end if;
  raise notice 'PASS  5a-b scheduling an interview emails once, with the date and time';

  -- A moved interview is genuinely new information, so it emails again.
  update public.interviews set scheduled_at = now() + interval '5 days' where id = intv_id;
  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'interview_rescheduled';
  if n <> 1 then
    raise exception 'FAIL  5c % reschedule emails queued, expected 1', n;
  end if;

  -- ...but saving the same time again is not a move.
  update public.interviews set location = 'Meeting Room 2' where id = intv_id;
  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'interview_rescheduled';
  if n <> 1 then
    raise exception 'FAIL  5d editing an interview without moving it queued % emails', n;
  end if;
  raise notice 'PASS  5c-d moving an interview emails again; editing it does not';

  -- An interview outcome is internal. What the applicant hears follows from the
  -- APPLICATION's status, which has its own trigger -- so this must be silent.
  select count(*) into n from public.applicant_notification_outbox where application_id = app_id;
  update public.interviews
     set status = 'passed',
         rating_communication = 5,
         rating_technical_skills = 4,
         overall_impression = 'excellent',
         interview_notes = 'internal only',
         recommended_salary = 60000,
         final_remarks = 'strong hire'
   where id = intv_id;
  select count(*) - n into n from public.applicant_notification_outbox where application_id = app_id;
  if n <> 0 then
    raise exception 'FAIL  5e recording an interview outcome queued % emails', n;
  end if;
  raise notice 'PASS  5e an interview rating and remarks email nothing';

  update public.interviews set status = 'cancelled' where id = intv_id;
  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'interview_cancelled';
  if n <> 1 then
    raise exception 'FAIL  5f % cancellation emails queued, expected 1', n;
  end if;
  raise notice 'PASS  5f cancelling an interview emails once';

  -- ======================================================================
  -- 6. Offer and hire stay distinct
  -- ======================================================================
  -- Hiring is gated on a PASSED FINAL interview owned by the actor, which is a
  -- real rule worth satisfying rather than stepping around. Inserted already
  -- passed rather than scheduled, so it queues no interview email of its own --
  -- the trigger only announces an interview that is actually scheduled.
  insert into public.interviews
    (application_id, interview_type, scheduled_at, status, mode, location, interviewer_id)
  values (app_id, 'final', now() - interval '1 day', 'passed',
          'face_to_face', 'JMAC Head Office', admin_id);

  update public.applications set final_interviewer_id = admin_id where id = app_id;
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  update public.applications set status = 'offered' where id = app_id;
  update public.applications set status = 'hired' where id = app_id;

  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'offer_sent';
  if n <> 1 then raise exception 'FAIL  6a % offer emails', n; end if;
  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'application_hired';
  if n <> 1 then raise exception 'FAIL  6b % hired emails', n; end if;
  raise notice 'PASS  6a-b an offer and a hire are two different emails';

  update public.applications set status = 'deployed' where id = app_id;
  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and event_type = 'deployment_completed';
  if n <> 1 then raise exception 'FAIL  6c % deployment emails', n; end if;
  raise notice 'PASS  6c completing deployment emails once';

  -- ======================================================================
  -- 7. Nothing internal is in any payload
  -- ======================================================================
  --
  -- Asserted across every queued row rather than per event, so a future event
  -- that forgets cannot slip through.
  for pl in
    select o.payload from public.applicant_notification_outbox o where o.application_id = app_id
  loop
    txt := pl::text;
    if txt ~* '(rejection_reason|rating_|remarks|overall_impression|interview_notes|recommended_salary|Strong on paper|internal only|excellent|strong hire)' then
      raise exception 'FAIL  7a an applicant payload carries internal data: %', txt;
    end if;
  end loop;
  raise notice 'PASS  7a no queued email carries notes, reasons, ratings or salary';

  -- Every applicant email carries what Track Application needs.
  select count(*) into n from public.applicant_notification_outbox o
   where o.application_id = app_id
     and (coalesce(o.payload->>'reference_code','') = ''
       or coalesce(o.payload->>'position','') = '');
  if n <> 0 then
    raise exception 'FAIL  7b % emails lack a reference code or position', n;
  end if;
  raise notice 'PASS  7b every email carries the reference code and position';

  -- ======================================================================
  -- 8. The full lifecycle, counted
  -- ======================================================================
  select count(*) into n from public.applicant_notification_outbox where application_id = app_id;
  if n <> 9 then
    select string_agg(event_type, ', ' order by created_at) into txt
      from public.applicant_notification_outbox where application_id = app_id;
    raise exception 'FAIL  8a % emails across the lifecycle, expected 9: %', n, txt;
  end if;
  raise notice 'PASS  8a the whole lifecycle queued exactly 9 applicant emails, one per real event';

  -- Delivery is a separate concern: everything is queued, nothing is sent.
  select count(*) into n from public.applicant_notification_outbox
   where application_id = app_id and status <> 'pending';
  if n <> 0 then
    raise exception 'FAIL  8b % rows were not left pending -- queuing sent something', n;
  end if;
  raise notice 'PASS  8b queuing never sends; delivery stays the worker''s job';


  -- ======================================================================
  -- 9. Two interviews, two conversations
  -- ======================================================================
  --
  -- Reported as "the final interview was scheduled but no email arrived". It
  -- had in fact been queued correctly and was delivered by the next cron tick
  -- three minutes later -- the report was written inside the five-minute
  -- window. But the question it raised is worth pinning forever: an applicant
  -- goes through TWO interviews, and the second must never be swallowed by the
  -- dedupe of the first.
  --
  -- The keys are per-interview, not per-application, which is what makes that
  -- true. If anyone ever "simplifies" them to the application id, this fails.
  declare
    iv_initial uuid;
    iv_final   uuid;
    k_initial  text;
    k_final    text;
  begin
    -- A second posting, because (applicant_id, job_posting_id) is unique --
    -- the same guard that refuses a duplicate application in production.
    insert into public.job_postings
      (department_id, position_id, description, requirements, employment_type,
       vacancies, status, posted_by, date_posted, closing_date)
    values (dept_id, pos_id, 'ZZ Two-stage ' || tag, 'r', 'regular', 1, 'open',
            admin_id, now(), current_date + 7)
    returning id into job_id2;

    insert into public.applications (applicant_id, job_posting_id, status, reference_code)
    select applicant_id, job_id2, 'submitted', 'ZZ-TWO-' || tag
      from public.applications where id = app_id
    returning id into app_id2;

    -- Initial interview.
    insert into public.interviews
      (application_id, interview_type, scheduled_at, status, mode, location, interviewer_id)
    values (app_id2, 'initial', now() + interval '2 days', 'scheduled',
            'face_to_face', 'Head Office', admin_id)
    returning id into iv_initial;

    select count(*) into n from public.applicant_notification_outbox
     where application_id = app_id2 and event_type = 'interview_scheduled';
    if n <> 1 then
      raise exception 'FAIL  9a initial interview queued % scheduled emails', n;
    end if;

    -- Saving it again without moving it is not a new event.
    update public.interviews set location = 'Head Office - 5th Floor' where id = iv_initial;
    select count(*) into n from public.applicant_notification_outbox
     where application_id = app_id2 and event_type = 'interview_scheduled';
    if n <> 1 then
      raise exception 'FAIL  9b re-saving the initial interview queued another';
    end if;

    -- Passing it is an internal outcome and says nothing to the applicant here.
    update public.interviews set status = 'passed' where id = iv_initial;
    select count(*) into n from public.applicant_notification_outbox
     where application_id = app_id2 and event_type = 'interview_scheduled';
    if n <> 1 then
      raise exception 'FAIL  9c completing the initial interview queued a schedule email';
    end if;
    raise notice 'PASS  9a-c the initial interview emails once and stays quiet after';

    -- THE CHECK THIS SUITE EXISTS FOR: a second, different interview.
    insert into public.interviews
      (application_id, interview_type, scheduled_at, status, mode, location, interviewer_id)
    values (app_id2, 'final', now() + interval '9 days', 'scheduled',
            'face_to_face', 'Cavite Branch', admin_id)
    returning id into iv_final;

    select count(*) into n from public.applicant_notification_outbox
     where application_id = app_id2 and event_type = 'interview_scheduled';
    if n <> 2 then
      raise exception 'FAIL  9d the final interview did not produce its own email (% total)', n;
    end if;
    raise notice 'PASS  9d the final interview emails too -- the initial does not suppress it';

    -- The two must be told apart by key and by content.
    select dedupe_key into k_initial from public.applicant_notification_outbox
     where application_id = app_id2 and event_type = 'interview_scheduled'
       and payload->>'interview_type' = 'initial';
    select dedupe_key into k_final from public.applicant_notification_outbox
     where application_id = app_id2 and event_type = 'interview_scheduled'
       and payload->>'interview_type' = 'final';

    if k_initial = k_final then
      raise exception 'FAIL  9e both interviews share dedupe key %', k_initial;
    end if;
    if k_initial <> iv_initial::text or k_final <> iv_final::text then
      raise exception 'FAIL  9f a dedupe key is not the interview it describes';
    end if;
    if k_initial = app_id2::text or k_final = app_id2::text then
      raise exception 'FAIL  9g a dedupe key is the application -- the second interview would be lost';
    end if;
    raise notice 'PASS  9e-g each interview is keyed on itself, never on the application';

    -- Re-saving the final one is not a new event either.
    update public.interviews set location = 'Cavite Branch - Store' where id = iv_final;
    select count(*) into n from public.applicant_notification_outbox
     where application_id = app_id2 and event_type = 'interview_scheduled';
    if n <> 2 then
      raise exception 'FAIL  9h re-saving the final interview queued another';
    end if;
    raise notice 'PASS  9h re-saving the final interview queues nothing further';

    -- Each may be moved, and each move is its own notification.
    update public.interviews set scheduled_at = now() + interval '3 days' where id = iv_initial;
    update public.interviews set scheduled_at = now() + interval '10 days' where id = iv_final;
    select count(*) into n from public.applicant_notification_outbox
     where application_id = app_id2 and event_type = 'interview_rescheduled';
    if n <> 2 then
      raise exception 'FAIL  9i % reschedule emails across two interviews, expected 2', n;
    end if;
    raise notice 'PASS  9i moving either interview notifies about that interview';

    -- And each may be cancelled independently.
    update public.interviews set status = 'cancelled' where id = iv_final;
    select count(*) into n from public.applicant_notification_outbox
     where application_id = app_id2 and event_type = 'interview_cancelled';
    if n <> 1 then
      raise exception 'FAIL  9j cancelling the final interview queued % emails', n;
    end if;
    raise notice 'PASS  9j cancelling one interview notifies about that one only';

    -- Nothing in any of it names the interviewer.
    select count(*) into n from public.applicant_notification_outbox
     where application_id = app_id2
       and payload::text like '%' || admin_id::text || '%';
    if n <> 0 then
      raise exception 'FAIL  9k % emails carry the interviewer identity', n;
    end if;
    raise notice 'PASS  9k no interview email names who is running it';
  end;

  raise notice '--- all applicant lifecycle notification checks passed ---';
end $$;

rollback;

select 'outbox rows after rollback: ' || count(*)::text as verify
from public.applicant_notification_outbox;
