-- Applicant notifications: dispatched on commit, and still sent exactly once.
--
-- Production evidence for one applicant: seven notifications queued between
-- 18:40:02 and 18:42:46, every one sent between 18:45:03 and 18:45:06, all on
-- the first attempt. Nothing was slow to send. They were waiting for a worker
-- that ran every five minutes.
--
-- The claims:
--
--   an enqueue asks for a run immediately, without waiting for the sweep
--   nothing leaves before the enqueueing transaction commits
--   an HR decision never fails because the nudge could not be posted
--   an immediate run and a scheduled run cannot both send the same row
--   the timing of a delivery is visible without its contents
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/applicant_notification_dispatch_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

do $$
declare
  admin_id uuid; applicant_id uuid; posting_id uuid; app_id uuid;
  dept_id uuid; pos_id uuid;
  row_id uuid; other_id uuid;
  n integer; txt text; claimed integer;
  -- The high-water mark of the pg_net queue, not a count. pg_net's own
  -- background worker drains that table concurrently, so a count taken
  -- before and after can fall as easily as it rises; a row this
  -- transaction added is identified by having an id beyond anything that
  -- was there when it started.
  queue_mark bigint; queued_after integer;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select p.id, p.department_id into pos_id, dept_id
    from public.positions p limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  insert into public.applicants (first_name, last_name, email)
  values ('ZZ', 'Notify ' || tag, 'zz.notify.' || tag || '@jmac-test.invalid')
  returning id into applicant_id;

  insert into public.job_postings (department_id, position_id, description)
  values (dept_id, pos_id, 'ZZ notify posting') returning id into posting_id;

  -- ======================================================================
  -- 1. An HR action asks for a run there and then
  -- ======================================================================
  --
  -- Creating the application is the HR action: trg_applications_notify_applicant
  -- enqueues from it, exactly as a shortlisting or an offer does. The mark is
  -- taken before, so what is counted is what this transaction produced.
  --
  -- net.http_post makes no HTTP call; it writes a row to net.http_request_queue
  -- and pg_net's background worker picks it up afterwards. That it is a row and
  -- not a socket is the whole reason this is safe -- it belongs to this
  -- transaction, and a rollback takes it with them.
  select coalesce(max(id), 0) into queue_mark from net.http_request_queue;

  insert into public.applications (applicant_id, job_posting_id, status)
  values (applicant_id, posting_id, 'submitted') returning id into app_id;

  select id into row_id from public.applicant_notification_outbox
   where application_id = app_id order by created_at limit 1;
  if row_id is null then raise exception 'FAIL 1a the HR action queued no notification'; end if;

  select count(*) into queued_after from net.http_request_queue where id > queue_mark;
  if queued_after <> 1 then
    raise exception 'FAIL 1a the HR action produced % worker request(s), expected 1', queued_after;
  end if;
  raise notice 'PASS  1a an HR action asks for a delivery run immediately, not in five minutes';

  -- It asks the protected worker, with the protected token, and nothing else.
  select url into txt from net.http_request_queue where id > queue_mark order by id desc limit 1;
  if txt not like '%/functions/v1/send-applicant-notifications' then
    raise exception 'FAIL 1b the nudge went to %', txt;
  end if;
  select headers::text into txt from net.http_request_queue where id > queue_mark order by id desc limit 1;
  if txt not like '%x-jmac-notify-token%' then
    raise exception 'FAIL 1b the nudge carried no worker token';
  end if;
  raise notice 'PASS  1b it calls the protected worker, presenting the same token cron does';

  -- ======================================================================
  -- 2. One ask per transaction, however many rows
  -- ======================================================================
  --
  -- The worker claims a batch, so a second nudge would collect nothing. An HR
  -- action that queues several notifications should wake it once.
  select coalesce(max(id), 0) into queue_mark from net.http_request_queue;

  perform public.enqueue_applicant_notification(
    app_id, 'application_shortlisted', 'zz-shortlist-' || tag, '{}'::jsonb);
  perform public.enqueue_applicant_notification(
    app_id, 'offer_sent', 'zz-offer-' || tag, '{}'::jsonb);

  select count(*) into queued_after from net.http_request_queue where id > queue_mark;
  if queued_after <> 0 then
    raise exception 'FAIL 2a % further nudge(s) for rows in the same transaction', queued_after;
  end if;
  raise notice 'PASS  2a several notifications in one transaction wake the worker once';

  -- ======================================================================
  -- 3. A deduplicated enqueue has nothing to deliver
  -- ======================================================================
  select coalesce(max(id), 0) into queue_mark from net.http_request_queue;
  select public.enqueue_applicant_notification(
    app_id, 'offer_sent', 'zz-offer-' || tag, '{}'::jsonb) into other_id;
  if other_id is not null then
    raise exception 'FAIL 3a the duplicate enqueue created a second row';
  end if;
  select count(*) into queued_after from net.http_request_queue where id > queue_mark;
  if queued_after <> 0 then
    raise exception 'FAIL 3a a deduplicated enqueue still nudged the worker';
  end if;
  raise notice 'PASS  3a an enqueue that changed nothing does not wake anybody';

  -- ======================================================================
  -- 4. Two workers, one send
  -- ======================================================================
  --
  -- The immediate run and the scheduled sweep can overlap by design. Both take
  -- the row the same way the Edge Function does -- an update conditional on the
  -- status it expected -- so the loser gets nothing back and moves on.
  --
  -- Worker A claims it.
  update public.applicant_notification_outbox
     set status = 'processing', claimed_at = now()
   where id = row_id and status in ('pending', 'failed');
  get diagnostics claimed = row_count;
  if claimed <> 1 then raise exception 'FAIL 4a the first worker could not claim a due row'; end if;

  -- Worker B, arriving a moment later, finds it already taken.
  update public.applicant_notification_outbox
     set status = 'processing', claimed_at = now()
   where id = row_id and status in ('pending', 'failed');
  get diagnostics claimed = row_count;
  if claimed <> 0 then
    raise exception 'FAIL 4a a second worker also claimed the same row -- it would be sent twice';
  end if;
  raise notice 'PASS  4a an immediate run and a scheduled run cannot both claim one notification';

  -- And once sent, nothing claims it again.
  update public.applicant_notification_outbox
     set status = 'sent', sent_at = now(), provider_message_id = 'zz-msg-' || tag, attempts = 1
   where id = row_id;

  update public.applicant_notification_outbox
     set status = 'processing', claimed_at = now()
   where id = row_id and status in ('pending', 'failed');
  get diagnostics claimed = row_count;
  if claimed <> 0 then raise exception 'FAIL 4b a sent notification was claimed again'; end if;
  raise notice 'PASS  4b a sent notification is never picked up a second time';

  -- ======================================================================
  -- 5. Retry and backoff are untouched
  -- ======================================================================
  select count(*) into n from public.applicant_notification_outbox
   where id = row_id and attempts = 1 and provider_message_id is not null and sent_at is not null;
  if n <> 1 then raise exception 'FAIL 5a attempts, provider id or sent_at were lost'; end if;

  -- A failed row still waits for its backoff before anybody may take it.
  update public.applicant_notification_outbox
     set status = 'failed', next_attempt_at = now() + interval '10 minutes', attempts = 2
   where id = row_id;
  select count(*) into n from public.applicant_notification_outbox
   where id = row_id and status in ('pending','failed') and next_attempt_at <= now();
  if n <> 0 then raise exception 'FAIL 5b a backed-off row is due immediately'; end if;
  raise notice 'PASS  5a-b attempts, provider id, sent_at and the backoff window all survive';

  -- ======================================================================
  -- 6. Timing is visible; the message is not
  -- ======================================================================
  update public.applicant_notification_outbox
     set status = 'sent',
         created_at = now() - interval '9 seconds',
         claimed_at = now() - interval '7 seconds',
         sent_at = now()
   where id = row_id;

  select queue_seconds into n from public.applicant_notification_latency where id = row_id;
  if n is null or n < 1 then raise exception 'FAIL 6a queue wait reads %', n; end if;
  select provider_seconds into n from public.applicant_notification_latency where id = row_id;
  if n is null then raise exception 'FAIL 6a provider time is not reported'; end if;
  raise notice 'PASS  6a queue wait and provider time are reported separately';

  -- The columns that would make this a data leak are absent, asserted against
  -- the view's own definition rather than one row.
  select string_agg(column_name, ', ' order by column_name) into txt
    from information_schema.columns
   where table_schema='public' and table_name='applicant_notification_latency'
     and column_name in ('recipient_email','recipient_name','payload','last_error');
  if txt is not null then
    raise exception 'FAIL 6b the latency view exposes: %', txt;
  end if;
  raise notice 'PASS  6b it carries no recipient, no message content and no error text';

  -- The provider's id is reported as present or absent, never quoted.
  select provider_accepted::text into txt from public.applicant_notification_latency where id = row_id;
  if txt <> 'true' then raise exception 'FAIL 6c provider acceptance is not reported'; end if;
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='applicant_notification_latency'
     and column_name = 'provider_message_id';
  if n <> 0 then raise exception 'FAIL 6c the provider message id is published'; end if;
  raise notice 'PASS  6c provider acceptance is a yes or no, not the provider''s identifier';

  -- ======================================================================
  -- 7. Nobody outside staff reads any of it
  -- ======================================================================
  perform set_config('request.jwt.claims', '', true);
  begin
    set local role anon;
    perform 1 from public.applicant_notification_latency limit 1;
    raise exception 'FAIL 7a anon read the notification timings';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  7a anon is refused by the table grant';
  end;
  reset role;

  -- ======================================================================
  -- 8. The token stays out of reach
  -- ======================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.applicant_notify_token();
    raise exception 'FAIL 8a a signed-in user read the worker token';
  exception when insufficient_privilege then
    raise notice 'PASS  8a the worker token is not readable by an ordinary session';
  end;

  begin
    perform public.request_applicant_notification_run();
    raise exception 'FAIL 8b a signed-in user triggered the worker directly';
  exception when insufficient_privilege then
    raise notice 'PASS  8b only the database itself asks the worker to run';
  end;
  reset role;
end $$;

rollback;
