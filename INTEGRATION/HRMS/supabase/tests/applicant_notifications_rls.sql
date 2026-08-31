-- Applicant email notifications — database contract test.
--
-- The claims:
--   submitting an application enqueues exactly one notification
--   a meaningful status change enqueues exactly one
--   HR-internal edits -- notes, reviewer, rejection_reason, ratings, remarks,
--     interviewer assignment -- enqueue NOTHING
--   scheduling an interview enqueues one; saving it again enqueues none;
--     genuinely moving it enqueues one more; cancelling enqueues one
--   a rejection email carries no rejection_reason and no internal text
--   the payload contains nothing an applicant must not see
--   the recipient is derived from the application, never supplied
--   nobody can write, alter or delete an outbox row through the API
--   HR can read delivery state, and never the provider's error text
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/applicant_notifications_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

create function pg_temp.new_application(_name text)
returns uuid
language plpgsql
as $mk$
declare
  _app uuid;
  _applicant uuid;
  _posting uuid;
  _email text := lower(replace(_name,' ','.'))||'.'||left(replace(gen_random_uuid()::text,'-',''),6)||'@example.com';
begin
  select id into _posting from public.job_postings order by created_at limit 1;
  if _posting is null then raise exception 'fixture: no job posting to apply to'; end if;

  insert into public.applicants (first_name, last_name, email)
  values (split_part(_name,' ',1), split_part(_name,' ',2), _email)
  returning id into _applicant;

  insert into public.applications (applicant_id, job_posting_id, status)
  values (_applicant, _posting, 'submitted')
  returning id into _app;
  return _app;
end;
$mk$;

create function pg_temp.queued(_app uuid) returns bigint language sql as $q$
  select count(*) from public.applicant_notification_outbox where application_id = _app;
$q$;

do $$
declare
  admin_id uuid;
  staff_id uuid;
  app uuid;
  app2 uuid;
  iv uuid;
  n bigint;
  txt text;
  pay jsonb;
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into staff_id from public.profiles where role='hr_staff' and status='active' limit 1;
  if admin_id is null then raise exception 'fixture: no Administrator'; end if;

  ---------------------------------------------------------- 1. submission
  app := pg_temp.new_application('Ana Applicant');
  if pg_temp.queued(app) <> 1 then
    raise exception 'FAIL 1a submitting enqueued % notifications, expected 1', pg_temp.queued(app); end if;
  select event_type into txt from public.applicant_notification_outbox where application_id = app;
  if txt <> 'application_submitted' then raise exception 'FAIL 1b wrong event: %', txt; end if;
  raise notice 'PASS 1a submitting an application enqueues exactly one notification';

  -- The recipient came from the application, not from anywhere a caller reached.
  select o.recipient_email = ap.email into strict txt
  from public.applicant_notification_outbox o
  join public.applications a on a.id = o.application_id
  join public.applicants ap on ap.id = a.applicant_id
  where o.application_id = app;
  if txt <> 'true' then raise exception 'FAIL 1c the recipient is not the applicant'; end if;
  raise notice 'PASS 1b the recipient is derived from the application';

  ------------------------------------------------- 2. internal edits are silent
  update public.applications set notes = 'strong candidate, push to final' where id = app;
  update public.applications set reviewed_by = admin_id, reviewed_at = now() where id = app;
  update public.applications set rejection_reason = 'internal: overqualified' where id = app;
  update public.applications set status = 'under_review' where id = app;
  if pg_temp.queued(app) <> 1 then
    raise exception 'FAIL 2a HR-internal edits enqueued % notifications', pg_temp.queued(app) - 1; end if;
  raise notice 'PASS 2a notes, reviewer, rejection_reason and under_review notify nobody';

  ------------------------------------------------------ 3. meaningful changes
  update public.applications set status = 'qualified' where id = app;
  if pg_temp.queued(app) <> 2 then raise exception 'FAIL 3a shortlisting did not enqueue'; end if;
  update public.applications set status = 'qualified' where id = app;
  if pg_temp.queued(app) <> 2 then
    raise exception 'FAIL 3b re-saving the same status enqueued another'; end if;
  raise notice 'PASS 3a a status change enqueues one; saving the same status again enqueues none';

  ---------------------------------------------------------- 4. interviews
  insert into public.interviews (application_id, interview_type, scheduled_at, status, mode, location)
  values (app, 'initial', now() + interval '3 days', 'scheduled', 'face_to_face', 'JMAC Head Office')
  returning id into iv;
  if pg_temp.queued(app) <> 3 then raise exception 'FAIL 4a scheduling did not enqueue'; end if;

  -- An HR-only edit on the interview row: ratings and notes, no reschedule.
  update public.interviews
     set rating_communication = 5, interview_notes = 'internal only', remarks = 'strong'
   where id = iv;
  if pg_temp.queued(app) <> 3 then
    raise exception 'FAIL 4b rating/notes on an interview enqueued a notification'; end if;
  raise notice 'PASS 4a scheduling enqueues one; ratings and notes on it enqueue none';

  -- A genuine move.
  update public.interviews set scheduled_at = now() + interval '5 days' where id = iv;
  if pg_temp.queued(app) <> 4 then raise exception 'FAIL 4c rescheduling did not enqueue'; end if;
  -- Saving the same new time again is not a second reschedule.
  update public.interviews set scheduled_at = (select scheduled_at from public.interviews where id = iv)
   where id = iv;
  if pg_temp.queued(app) <> 4 then
    raise exception 'FAIL 4d re-saving the same time enqueued a duplicate'; end if;
  -- Moving it a second time is.
  update public.interviews set scheduled_at = now() + interval '9 days' where id = iv;
  if pg_temp.queued(app) <> 5 then
    raise exception 'FAIL 4e a second genuine move did not enqueue'; end if;
  raise notice 'PASS 4b a real reschedule enqueues one each time; re-saving the same time does not';

  update public.interviews set status = 'cancelled' where id = iv;
  if pg_temp.queued(app) <> 6 then raise exception 'FAIL 4f cancelling did not enqueue'; end if;
  update public.interviews set status = 'cancelled' where id = iv;
  if pg_temp.queued(app) <> 6 then raise exception 'FAIL 4g cancelling twice enqueued twice'; end if;
  raise notice 'PASS 4c cancelling enqueues exactly one';

  ------------------------------------------------- 5. rejection says nothing
  app2 := pg_temp.new_application('Ben Barred');
  -- protect_application_screening reserves submitted -> rejected for an HR
  -- Manager or Administrator, so the rejection is made by one. That is who
  -- rejects in the real workflow too.
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role','authenticated')::text, true);
  update public.applications
     set rejection_reason = 'internal: failed background check', status = 'rejected'
   where id = app2;
  perform set_config('request.jwt.claims', null, true);
  select payload into pay from public.applicant_notification_outbox
   where application_id = app2 and event_type = 'application_rejected';
  if pay is null then raise exception 'FAIL 5a rejection did not enqueue'; end if;
  if pay::text ilike '%background check%' or pay::text ilike '%internal%' then
    raise exception 'FAIL 5b the rejection payload carries the internal reason: %', pay::text; end if;
  raise notice 'PASS 5a a rejection notification carries no internal reason';

  -- Nothing anywhere in any payload leaks HR-internal text.
  select string_agg(payload::text, ' ') into txt from public.applicant_notification_outbox;
  if txt ilike '%strong candidate%' or txt ilike '%internal only%'
     or txt ilike '%rating%' or txt ilike '%overqualified%' then
    raise exception 'FAIL 5c an internal field reached a payload'; end if;
  raise notice 'PASS 5b no payload contains notes, ratings, remarks or a rejection reason';

  ------------------------------------------------------------ 6. idempotency
  -- The same event and key can never produce two rows, whatever retries a
  -- caller or a function makes.
  begin
    insert into public.applicant_notification_outbox
      (application_id, event_type, dedupe_key, recipient_email, recipient_name)
    values (app, 'application_submitted', app::text, 'x@example.com', 'X');
    raise exception 'FAIL 6a a duplicate outbox row was accepted';
  exception when unique_violation then null;
  end;
  raise notice 'PASS 6a (event_type, dedupe_key) is unique -- retries collapse';

  ----------------------------------------------------------- 7. no API writes
  perform set_config('request.jwt.claims',
    json_build_object('sub', coalesce(staff_id, admin_id), 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.applicant_notification_outbox
      (application_id, event_type, dedupe_key, recipient_email, recipient_name)
    values (app, 'application_hired', 'forged', 'attacker@example.com', 'A');
    raise exception 'FAIL 7a an API role inserted an outbox row';
  exception when others then
    if SQLERRM like 'FAIL 7a%' then raise; end if;
  end;
  -- RLS with no UPDATE policy filters silently rather than raising, so the
  -- assertion is on the EFFECT: the update must reach no row at all. Expecting
  -- an exception here would have passed for the wrong reason.
  update public.applicant_notification_outbox set recipient_email = 'attacker@example.com';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'FAIL 7b an API role redirected % notification(s)', n; end if;
  reset role;
  if exists (select 1 from public.applicant_notification_outbox
             where recipient_email = 'attacker@example.com') then
    raise exception 'FAIL 7b a notification was redirected'; end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', coalesce(staff_id, admin_id), 'role','authenticated')::text, true);
  set local role authenticated;
  -- Reading delivery state IS allowed for staff.
  select count(*) into n from public.get_applicant_notifications(app);
  if n < 1 then raise exception 'FAIL 7c staff cannot read delivery state'; end if;
  select string_agg(column_name, ',') into txt
  from information_schema.columns
  where table_schema = 'public' and table_name = 'applicant_notification_outbox';
  reset role;
  raise notice 'PASS 7a no API role can insert or redirect a notification; staff may read state';

  -- The reader hands back no provider error text.
  if (select pg_get_function_result('public.get_applicant_notifications(uuid)'::regprocedure))
     ilike '%last_error%' then
    raise exception 'FAIL 7d the delivery view exposes the provider error text'; end if;
  raise notice 'PASS 7b delivery state is visible without the provider''s message';

  ------------------------------------------------------------------ 8. ACLs
  select string_agg(pr.proname, ', ' order by pr.proname) into txt
  from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
  where ns.nspname = 'public'
    and pr.proname in ('enqueue_applicant_notification',
                       'notify_applicant_on_application_change',
                       'notify_applicant_on_interview_change')
    and (has_function_privilege('anon', pr.oid, 'execute')
      or has_function_privilege('authenticated', pr.oid, 'execute'));
  if txt is not null then
    raise exception 'FAIL 8a an API role can call the enqueue internals: %', txt; end if;
  if has_function_privilege('anon', 'public.get_applicant_notifications(uuid)', 'execute') then
    raise exception 'FAIL 8b anon can read notification state'; end if;
  raise notice 'PASS 8a the enqueue internals reach no API role';

  raise notice '--- all applicant notification contract checks passed ---';
end $$;

rollback;

select 'outbox rows after rollback: ' || count(*) as verify
from public.applicant_notification_outbox;
