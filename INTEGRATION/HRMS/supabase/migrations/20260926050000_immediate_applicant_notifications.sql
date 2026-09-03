-- Applicant notifications: dispatched on commit, swept by cron
--
-- The outbox was never the problem. Production shows seven notifications for
-- one applicant queued between 18:40:02 and 18:42:46 and every one of them
-- sent between 18:45:03 and 18:45:06 -- first attempt, accepted by Brevo
-- immediately. They were not slow to send. They were waiting for the worker,
-- and the worker only ran every five minutes.
--
-- So the queue stays exactly as it is, and gains a nudge: the moment an
-- enqueue commits, the worker is asked to run. Cron keeps its five minutes and
-- becomes what it should always have been -- the sweep that catches whatever
-- the nudge missed, rather than the only thing that ever delivers.
--
-- Two properties this must not break, and does not.
--
-- Nothing is sent before the HR transaction commits. net.http_post does not
-- make an HTTP call; it inserts a row into net.http_request_queue, and pg_net's
-- background worker picks that row up afterwards. The insert is part of the
-- caller's transaction, so a rolled-back HR decision takes the queued
-- invocation down with it. An applicant cannot be told they were shortlisted
-- by a transaction that never happened.
--
-- And an HR status change never depends on this working. The call is wrapped:
-- if pg_net is absent, misconfigured or refuses, the enqueue still commits and
-- cron delivers on its next pass. The worst case is the behaviour we have
-- today.

-- ------------------------------------------------------ when the worker ran
--
-- Third timestamp in the story. created_at says when HR acted, sent_at says
-- when the provider accepted it, and the gap between them was previously
-- unattributable -- there was no way to tell a slow worker from a slow Brevo.
alter table public.applicant_notification_outbox
  add column if not exists claimed_at timestamptz;

comment on column public.applicant_notification_outbox.claimed_at is
  'When a worker claimed this row for sending. created_at -> claimed_at is queue wait; claimed_at -> sent_at is provider time.';

-- --------------------------------------------------------- one way to call it
--
-- The URL and the token assembly lived inside the cron job's command string.
-- Now that two callers need them, they live here instead: a second copy in an
-- enqueue path is a second thing to update when the project ref changes.
create or replace function public.request_applicant_notification_run()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _url text := 'https://joffopwzqmlqpsrbivfq.supabase.co/functions/v1/send-applicant-notifications';
begin
  -- Best-effort by construction. This is a nudge; cron is the guarantee, and
  -- an HR decision must never fail because a queue nudge could not be posted.
  begin
    perform net.http_post(
      url := _url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        -- The same protected token the scheduled run presents. Read from Vault
        -- at call time, never stored in a job definition and never sent
        -- anywhere near a browser.
        'x-jmac-notify-token', public.applicant_notify_token()
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  exception when others then
    -- Deliberately swallowed, and deliberately noticed. The row is committed
    -- and due; the next sweep takes it.
    raise notice 'applicant notification nudge could not be posted (%): the scheduled sweep will deliver', sqlerrm;
  end;
end;
$fn$;

revoke all on function public.request_applicant_notification_run() from public, anon, authenticated;

comment on function public.request_applicant_notification_run() is
  'Asks the delivery worker to run now. Transactional: the request is queued with the caller''s transaction and only leaves after it commits.';

-- ------------------------------------------------- enqueue, then ask for a run
--
-- Reproduced whole because create-or-replace takes the whole body. The only
-- change is the nudge at the end, and the one-per-transaction guard around it:
-- an HR action that enqueues several notifications should wake the worker once,
-- not once per row. The worker claims a batch, so one call collects them all.
create or replace function public.enqueue_applicant_notification(
  _application_id uuid,
  _event_type text,
  _dedupe_key text,
  _payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _email text;
  _name text;
  _ref text;
  _position text;
  _id uuid;
begin
  select coalesce(a.applicant_email, ap.email),
         btrim(coalesce(a.applicant_first_name, ap.first_name) || ' ' ||
               coalesce(a.applicant_last_name, ap.last_name)),
         a.reference_code,
         pos.title
    into _email, _name, _ref, _position
  from public.applications a
  join public.applicants ap on ap.id = a.applicant_id
  left join public.job_postings jp on jp.id = a.job_posting_id
  left join public.positions pos on pos.id = jp.position_id
  where a.id = _application_id;

  if _email is null or _email = '' then
    return null;
  end if;

  insert into public.applicant_notification_outbox (
    application_id, event_type, dedupe_key, recipient_email, recipient_name, payload)
  values (
    _application_id, _event_type, _dedupe_key, _email, coalesce(_name, _email),
    jsonb_build_object(
      'applicant_name', coalesce(_name, ''),
      'position', coalesce(_position, 'the role you applied for'),
      'reference_code', coalesce(_ref, '')
    ) || coalesce(_payload, '{}'::jsonb))
  on conflict (event_type, dedupe_key) do nothing
  returning id into _id;

  -- Only for a row that was actually created. A deduplicated enqueue has
  -- nothing new to deliver, and waking the worker for it is noise.
  if _id is not null
     and coalesce(current_setting('jmac.notify_nudged', true), '') <> 'on' then
    perform set_config('jmac.notify_nudged', 'on', true);
    perform public.request_applicant_notification_run();
  end if;

  return _id;
end;
$fn$;

-- --------------------------------------------------------------- the sweep
--
-- Still every five minutes, now calling the shared function so there is one
-- definition of where the worker lives and how it is authorised.
--
-- Its job has changed even though its schedule has not. It used to be the
-- delivery mechanism; it is now the recovery one -- the thing that catches a
-- nudge that never arrived, a retry whose backoff has expired, and anything
-- enqueued by a path that does not go through the function above.
do $$
declare
  _job text := 'applicant-notification-delivery';
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed; skipping schedule';
    return;
  end if;

  perform cron.unschedule(_job)
   where exists (select 1 from cron.job where jobname = _job);

  perform cron.schedule(_job, '*/5 * * * *',
    'select public.request_applicant_notification_run();');
end $$;

-- ------------------------------------------------------------ observability
--
-- Where the time actually goes, without any of what the message said.
--
-- No recipient address, no name, no payload, no provider key: those are the
-- things this view exists to avoid needing. It carries the three timestamps
-- and the two gaps between them, so "was that slow because of us or because of
-- Brevo" has an answer that does not involve opening an applicant's record.
create or replace view public.applicant_notification_latency
with (security_invoker = on) as
  select
    o.id,
    o.event_type,
    o.status,
    o.attempts,
    o.created_at as queued_at,
    o.claimed_at as worker_started_at,
    o.sent_at,
    -- How long it sat waiting for a worker. This is the number that was five
    -- minutes and should now be seconds.
    extract(epoch from (o.claimed_at - o.created_at))::numeric(10,2) as queue_seconds,
    -- How long the provider took once we asked. This was never the problem,
    -- and now it can be shown rather than assumed.
    extract(epoch from (o.sent_at - o.claimed_at))::numeric(10,2) as provider_seconds,
    extract(epoch from (o.sent_at - o.created_at))::numeric(10,2) as total_seconds,
    -- Present or absent only. The id itself is the provider's, not ours to
    -- scatter around a dashboard.
    (o.provider_message_id is not null) as provider_accepted,
    o.next_attempt_at,
    o.updated_at
  from public.applicant_notification_outbox o;

comment on view public.applicant_notification_latency is
  'Delivery timing for applicant notifications: queued, claimed, sent, and the gaps between. Carries no recipient, no message content and no provider identifier.';

-- security_invoker is on, so the outbox's own policy decides who sees a row --
-- applicant_notification_outbox_staff_select, is_active_staff(). The view adds
-- no visibility of its own; it removes columns. Somebody who could not read the
-- outbox cannot read its timings either.
revoke all on public.applicant_notification_latency from anon, public;
grant select on public.applicant_notification_latency to authenticated;
