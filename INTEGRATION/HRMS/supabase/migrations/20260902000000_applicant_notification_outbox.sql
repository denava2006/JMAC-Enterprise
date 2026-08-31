-- Applicant email notifications: the outbox.
--
-- The app already marked the applicant-facing moments -- application_history
-- carries 'interview_scheduled_email_queued', 'rejection_email_queued' and
-- 'hired_email_queued' -- but nothing ever read them and no email was ever
-- sent. Those events recorded an intention, not a delivery.
--
-- Two rules shape this design.
--
-- 1. A row is enqueued by the DATABASE, in the same transaction as the change
--    that justifies it. Not by React. That means an HR decision and its
--    notification cannot disagree: if the transition committed, the intent to
--    notify committed with it, and if the transition rolled back so did the
--    intent. It also means the recipient is derived here, from the
--    application's own applicant, and a client cannot name one.
--
-- 2. Sending happens LATER, elsewhere. A queue row is a promise to try, not a
--    delivery. Brevo being slow or down must never roll back a hiring
--    decision, so nothing in this file talks to it.
--
-- What is deliberately NOT notified: notes, ratings, interviewer assignment,
-- reviewer comments, rejection_reason, remarks. Those are how HR works, not
-- what an applicant is owed, and several are things an applicant must never
-- see.

-- Guarded so the whole file stays re-runnable; CREATE TYPE has no IF NOT EXISTS.
do $enum$
begin
  if not exists (select 1 from pg_type where typname = 'applicant_notification_status') then
    create type public.applicant_notification_status as enum
      ('pending', 'processing', 'sent', 'failed');
  end if;
end
$enum$;

create table if not exists public.applicant_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  event_type text not null check (event_type in (
    'application_submitted',
    'application_shortlisted',
    'interview_scheduled',
    'interview_rescheduled',
    'interview_cancelled',
    'offer_sent',
    'application_hired',
    'application_rejected',
    'application_closed',
    'deployment_completed'
  )),

  -- What makes THIS notification distinct from another of the same type.
  -- An interview reschedule carries the new time, so moving an interview twice
  -- produces two notifications while saving the same time twice produces one.
  dedupe_key text not null,

  -- Derived server-side from the application's applicant. Never supplied by a
  -- caller: an outbox row that could name its own recipient would be a way to
  -- mail arbitrary addresses through our sender.
  recipient_email text not null,
  recipient_name text not null,

  -- Everything the email needs, snapshotted at enqueue time and applicant-safe
  -- by construction. Sending reads only this, so a later HR edit cannot change
  -- what an already-queued email says, and the sender needs no access to
  -- interviews, ratings or notes.
  payload jsonb not null default '{}'::jsonb,

  status public.applicant_notification_status not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Idempotency. Double clicks, retries, a refreshed page and a re-run RPC all
-- collapse onto the same row.
create unique index if not exists applicant_notification_outbox_once
  on public.applicant_notification_outbox (event_type, dedupe_key);

create index if not exists idx_applicant_notification_outbox_due
  on public.applicant_notification_outbox (status, next_attempt_at)
  where status in ('pending', 'failed');

create index if not exists idx_applicant_notification_outbox_application
  on public.applicant_notification_outbox (application_id);

comment on table public.applicant_notification_outbox is
  'Applicant-facing emails waiting to be sent. Written by triggers in the same '
  'transaction as the change; delivered later by the send-applicant-notifications '
  'function. Contains no HR-internal fields.';

alter table public.applicant_notification_outbox enable row level security;

-- HR can see whether a notification went out; nobody can write one by hand.
-- The triggers below are SECURITY DEFINER and bypass this, which is the point:
-- enqueueing is something the system does, not something a person does.
drop policy if exists applicant_notification_outbox_staff_select
  on public.applicant_notification_outbox;
create policy applicant_notification_outbox_staff_select
  on public.applicant_notification_outbox
  for select using (public.is_active_staff());

drop trigger if exists trg_applicant_notification_outbox_updated_at
  on public.applicant_notification_outbox;
create trigger trg_applicant_notification_outbox_updated_at
  before update on public.applicant_notification_outbox
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------- enqueueing
-- One writer, so every event is shaped the same way and the recipient is
-- always derived rather than passed in.
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
  select ap.email,
         trim(ap.first_name || ' ' || ap.last_name),
         a.reference_code,
         pos.title
    into _email, _name, _ref, _position
  from public.applications a
  join public.applicants ap on ap.id = a.applicant_id
  left join public.job_postings jp on jp.id = a.job_posting_id
  left join public.positions pos on pos.id = jp.position_id
  where a.id = _application_id;

  -- No applicant, no notification. Silently skipping is right here: the
  -- transition itself is valid and must not fail because we cannot email.
  if _email is null or _email = '' then
    return null;
  end if;

  insert into public.applicant_notification_outbox (
    application_id, event_type, dedupe_key, recipient_email, recipient_name, payload)
  values (
    _application_id, _event_type, _dedupe_key, _email, coalesce(_name, _email),
    -- The applicant-safe envelope every email shares, merged with whatever the
    -- specific event adds. Reference code and position are included so the
    -- sender never has to read the application again.
    jsonb_build_object(
      'applicant_name', coalesce(_name, ''),
      'position', coalesce(_position, 'the role you applied for'),
      'reference_code', coalesce(_ref, '')
    ) || coalesce(_payload, '{}'::jsonb))
  on conflict (event_type, dedupe_key) do nothing
  returning id into _id;

  return _id;
end;
$fn$;

revoke all on function public.enqueue_applicant_notification(uuid, text, text, jsonb)
  from public, anon, authenticated;

-- ------------------------------------------------- application transitions
create or replace function public.notify_applicant_on_application_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    perform public.enqueue_applicant_notification(
      new.id, 'application_submitted', new.id::text,
      jsonb_build_object('status_label', 'Application received'));
    return new;
  end if;

  -- Only a STATUS change is applicant-facing. Editing notes, assigning a
  -- reviewer or recording a rejection_reason changes this row too, and none of
  -- those are the applicant's business.
  if new.status is not distinct from old.status then
    return new;
  end if;

  case new.status
    when 'qualified' then
      perform public.enqueue_applicant_notification(
        new.id, 'application_shortlisted', new.id::text,
        jsonb_build_object('status_label', 'Shortlisted'));
    when 'offered' then
      perform public.enqueue_applicant_notification(
        new.id, 'offer_sent', new.id::text,
        jsonb_build_object('status_label', 'Job offer available'));
    when 'hired' then
      perform public.enqueue_applicant_notification(
        new.id, 'application_hired', new.id::text,
        jsonb_build_object('status_label', 'Hired'));
    when 'rejected' then
      -- Deliberately carries no reason. rejection_reason is HR's record, and
      -- an applicant-facing reason field does not exist in this workflow.
      perform public.enqueue_applicant_notification(
        new.id, 'application_rejected', new.id::text,
        jsonb_build_object('status_label', 'Not moving forward'));
    when 'closed' then
      perform public.enqueue_applicant_notification(
        new.id, 'application_closed', new.id::text,
        jsonb_build_object('status_label', 'Application closed'));
    when 'deployed' then
      perform public.enqueue_applicant_notification(
        new.id, 'deployment_completed', new.id::text,
        jsonb_build_object('status_label', 'Onboarding complete'));
    else
      -- under_review and interview_scheduled are covered elsewhere or are
      -- internal: 'under_review' says only that somebody opened it.
      null;
  end case;

  return new;
end;
$fn$;

drop trigger if exists trg_applications_notify_applicant on public.applications;
create trigger trg_applications_notify_applicant
  after insert or update on public.applications
  for each row execute function public.notify_applicant_on_application_change();

-- --------------------------------------------------- interview transitions
create or replace function public.notify_applicant_on_interview_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _details jsonb;
begin
  -- Applicant-safe only. Ratings, remarks, interview_notes, recommended_salary
  -- and rejection_reason all live on this row and none of them go anywhere.
  _details := jsonb_build_object(
    'scheduled_at', to_char(new.scheduled_at at time zone 'Asia/Manila', 'FMDay, FMDD FMMonth YYYY'),
    'scheduled_time', to_char(new.scheduled_at at time zone 'Asia/Manila', 'FMHH12:MI AM'),
    'interview_type', coalesce(new.interview_type::text, ''),
    'mode', coalesce(new.mode::text, ''),
    'location', coalesce(new.location, ''),
    'meeting_link', coalesce(new.meeting_link, ''));

  if tg_op = 'INSERT' then
    if new.status = 'scheduled' then
      perform public.enqueue_applicant_notification(
        new.application_id, 'interview_scheduled', new.id::text,
        _details || jsonb_build_object('status_label', 'Interview scheduled'));
    end if;
    return new;
  end if;

  -- A moved interview. The time is part of the key, so moving it twice sends
  -- twice and saving the same time again sends once.
  if new.scheduled_at is distinct from old.scheduled_at and new.status <> 'cancelled' then
    perform public.enqueue_applicant_notification(
      new.application_id, 'interview_rescheduled',
      new.id::text || '@' || extract(epoch from new.scheduled_at)::bigint::text,
      _details || jsonb_build_object('status_label', 'Interview rescheduled'));
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform public.enqueue_applicant_notification(
      new.application_id, 'interview_cancelled', new.id::text,
      _details || jsonb_build_object('status_label', 'Interview cancelled'));
  end if;

  -- passed / failed / completed are internal outcomes. What the applicant is
  -- told follows from the APPLICATION's status changing, which has its own
  -- trigger -- so an interview outcome never emails twice.
  return new;
end;
$fn$;

drop trigger if exists trg_interviews_notify_applicant on public.interviews;
create trigger trg_interviews_notify_applicant
  after insert or update on public.interviews
  for each row execute function public.notify_applicant_on_interview_change();

revoke all on function public.notify_applicant_on_application_change()
  from public, anon, authenticated;
revoke all on function public.notify_applicant_on_interview_change()
  from public, anon, authenticated;

-- --------------------------------------------------------- HR visibility
-- What HR sees on an application: whether each notification went out, without
-- the recipient's address being editable or the payload being writable.
create or replace function public.get_applicant_notifications(_application_id uuid)
returns table (
  id uuid,
  event_type text,
  status text,
  attempts integer,
  created_at timestamptz,
  sent_at timestamptz,
  -- Deliberately NOT last_error: a provider message can name internals, and
  -- "Failed" plus a timestamp is what HR needs in order to act.
  has_error boolean
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select o.id, o.event_type, o.status::text, o.attempts, o.created_at, o.sent_at,
         (o.last_error is not null)
  from public.applicant_notification_outbox o
  where o.application_id = _application_id
    and public.is_active_staff()
  order by o.created_at desc;
$fn$;

revoke all on function public.get_applicant_notifications(uuid) from public, anon;
grant execute on function public.get_applicant_notifications(uuid) to authenticated;
