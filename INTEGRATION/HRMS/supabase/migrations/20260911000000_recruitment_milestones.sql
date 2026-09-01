-- The applicant can see their whole journey, and hears when they pass.
--
-- Two gaps, one cause: nothing recorded what happened to an application.
--
-- 1. Passing the initial interview told the applicant nothing. The interview
--    trigger deliberately stays quiet on passed/failed/completed, because what
--    the applicant is told follows from the APPLICATION's status changing. That
--    is right for every other outcome -- but passing an initial interview
--    changes no application status. It sits at interview_scheduled until a final
--    interview is booked, so the one milestone that means "you are through to
--    the next round" was the one nobody was told about.
--
-- 2. Track Application could only show the current interview. application_history
--    existed but only submission and offer responses ever wrote to it, so there
--    was no timeline to show -- earlier stages simply vanished from the
--    applicant's view as the application moved on.
--
-- Both are fixed by recording milestones as they happen and reading them back
-- through a public-safe boundary. Nothing about what HR sees changes, and no
-- rating, note, remark, reviewer or rejection reason is recorded here.

-- application_history.event already has a vocabulary, and it already contains
-- initial_interview_passed -- the event was designed for and never written. The
-- names below are that vocabulary, not a new one. Only the interview lifecycle
-- events it lacks are added: an interview can be moved or called off, and the
-- applicant is entitled to see both.
alter table public.application_history
  drop constraint if exists application_history_event_check;

alter table public.application_history
  add constraint application_history_event_check check (event = any (array[
    'submitted', 'reviewed', 'qualified', 'rejected', 'rejection_email_queued',
    'initial_interview_scheduled', 'initial_interview_started',
    'initial_interview_passed', 'initial_interview_rejected',
    'final_interview_scheduled', 'final_interview_started',
    'final_interview_rejected',
    'hired', 'interview_scheduled_email_queued', 'hired_email_queued',
    'job_offer_prepared', 'offer_accepted', 'offer_declined',
    'application_closed', 'contract_prepared', 'contract_generated',
    'contract_signed', 'deployment_completed',
    -- Added here.
    'initial_interview_rescheduled', 'initial_interview_cancelled',
    'final_interview_passed', 'final_interview_rescheduled',
    'final_interview_cancelled'
  ]));

-- The outbox keeps its own vocabulary of what may be sent. Passing the initial
-- interview is a new applicant-facing email, so it is named here too -- an
-- event the outbox does not recognise is refused rather than silently queued.
alter table public.applicant_notification_outbox
  drop constraint if exists applicant_notification_outbox_event_type_check;

alter table public.applicant_notification_outbox
  add constraint applicant_notification_outbox_event_type_check check (event_type = any (array[
    'application_submitted', 'application_under_review', 'application_shortlisted',
    'interview_scheduled', 'interview_rescheduled', 'interview_cancelled',
    'initial_interview_passed',
    'offer_sent', 'application_hired', 'application_rejected',
    'application_closed', 'deployment_completed'
  ]));

-- ------------------------------------------------------------- the recorder
create or replace function public.record_application_milestone(
  _application_id uuid,
  _event text,
  _occurred_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  -- interview_scheduled has no milestone of its own here: the interviews
  -- trigger records which interview was booked, which is what the applicant
  -- actually sees. A null event means "nothing to record", not an error.
  if _event is null then
    return;
  end if;

  -- Milestones are facts about the application, not about who looked at it, so
  -- no actor and no notes. `notes` on this table carries HR's own commentary
  -- elsewhere and must never be populated by this path.
  insert into public.application_history (application_id, event, created_at)
  values (_application_id, _event, _occurred_at);
end;
$fn$;

revoke all on function public.record_application_milestone(uuid, text, timestamptz)
  from public, anon, authenticated;

-- --------------------------------------------------- application milestones
create or replace function public.notify_applicant_on_application_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- A new application. Restored explicitly: rewriting this function from a
  -- partial read once dropped this branch, and the applicant stopped being
  -- told their application had arrived at all.
  if tg_op = 'INSERT' then
    perform public.record_application_milestone(new.id, 'submitted');
    perform public.enqueue_applicant_notification(
      new.id, 'application_submitted', new.id::text,
      jsonb_build_object('status_label', 'Application received'));
    return new;
  end if;

  -- Only a STATUS change is applicant-facing. Editing notes, assigning a
  -- reviewer or recording a rejection_reason changes this row too, and none of
  -- that is the applicant's business.
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Recorded for every status the applicant is entitled to see, whether or not
  -- it also sends an email. The timeline is the record of what happened; the
  -- outbox is the record of what was sent. They are not the same thing.
  --
  -- Mapped onto the vocabulary application_history already uses rather than a
  -- parallel set of status_* names.
  perform public.record_application_milestone(new.id, case new.status
    when 'under_review' then 'reviewed'
    when 'qualified'    then 'qualified'
    when 'offered'      then 'job_offer_prepared'
    when 'hired'        then 'hired'
    when 'rejected'     then 'rejected'
    when 'closed'       then 'application_closed'
    when 'deployed'     then 'deployment_completed'
    else null
  end);

  case new.status
    when 'under_review' then
      -- Applicant-safe only. The email says the application is being read, not
      -- what the review found: scores, remarks and reviewer identity all live
      -- on this row and none of them travel.
      perform public.enqueue_applicant_notification(
        new.id, 'application_under_review', new.id::text,
        jsonb_build_object('status_label', 'Under review'));
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
      -- interview_scheduled is covered by the interviews trigger, which knows
      -- the date and place. Emitting it here too would email twice.
      null;
  end case;

  return new;
end;
$function$;

-- ----------------------------------------------------- interview milestones
create or replace function public.notify_applicant_on_interview_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  _details jsonb;
  _stage text;
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

  -- 'initial' / 'final', used to name the milestone. The applicant is told
  -- which interview moved; they are never told who moved it.
  _stage := coalesce(new.interview_type::text, 'interview');

  if tg_op = 'INSERT' then
    if new.status = 'scheduled' then
      perform public.record_application_milestone(new.application_id, _stage || '_interview_scheduled');
      perform public.enqueue_applicant_notification(
        new.application_id, 'interview_scheduled', new.id::text,
        _details || jsonb_build_object('status_label', 'Interview scheduled'));
    end if;
    return new;
  end if;

  -- A moved interview. The time is part of the key, so moving it twice sends
  -- twice and saving the same time again sends once.
  if new.scheduled_at is distinct from old.scheduled_at and new.status <> 'cancelled' then
    perform public.record_application_milestone(new.application_id, _stage || '_interview_rescheduled');
    perform public.enqueue_applicant_notification(
      new.application_id, 'interview_rescheduled',
      new.id::text || '@' || extract(epoch from new.scheduled_at)::bigint::text,
      _details || jsonb_build_object('status_label', 'Interview rescheduled'));
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform public.record_application_milestone(new.application_id, _stage || '_interview_cancelled');
    perform public.enqueue_applicant_notification(
      new.application_id, 'interview_cancelled', new.id::text,
      _details || jsonb_build_object('status_label', 'Interview cancelled'));
  end if;

  -- Passing the INITIAL interview is the one outcome no other trigger reports.
  -- The application stays at interview_scheduled until a final interview is
  -- booked, so without this the applicant is left waiting with no word between
  -- attending the interview and being invited to the next one.
  --
  -- Keyed on the interview itself, so re-saving an evaluation -- correcting a
  -- rating, adding a note -- cannot send it a second time.
  if new.interview_type = 'initial'
     and new.status = 'passed'
     and old.status is distinct from 'passed' then
    perform public.record_application_milestone(new.application_id, 'initial_interview_passed');
    perform public.enqueue_applicant_notification(
      new.application_id, 'initial_interview_passed', new.id::text,
      jsonb_build_object('status_label', 'Initial interview passed'));
  end if;

  -- Passing the FINAL interview stays silent on purpose. What the applicant
  -- hears next is the outcome -- offered, hired, or not moving forward -- and
  -- each of those has its own email from the application's status. A "you
  -- passed" note in between would promise a result that has not been decided.
  if new.interview_type = 'final'
     and new.status = 'passed'
     and old.status is distinct from 'passed' then
    perform public.record_application_milestone(new.application_id, 'final_interview_passed');
  end if;

  return new;
end;
$function$;

-- ------------------------------------------------------------- the backfill
-- Existing applications have a real history; it was simply never written down.
-- Every row below comes from a timestamp that already exists somewhere else --
-- the application, its interviews, its offers, its outbox. Nothing is invented,
-- and an application with no evidence for a stage gets no row for it.
insert into public.application_history (application_id, event, created_at)
select a.id, 'submitted', a.created_at
from public.applications a
where not exists (
  select 1 from public.application_history h
  where h.application_id = a.id and h.event = 'submitted');

-- What the applicant was actually told, and when. The outbox is the only record
-- of the earlier stages for applications that predate this migration.
insert into public.application_history (application_id, event, created_at)
select o.application_id,
       case o.event_type
         when 'application_under_review' then 'reviewed'
         when 'application_shortlisted'  then 'qualified'
         when 'offer_sent'               then 'job_offer_prepared'
         when 'application_hired'        then 'hired'
         when 'application_rejected'     then 'rejected'
         when 'application_closed'       then 'application_closed'
         when 'deployment_completed'     then 'deployment_completed'
       end,
       o.created_at
from public.applicant_notification_outbox o
where o.event_type in (
        'application_under_review', 'application_shortlisted', 'offer_sent',
        'application_hired', 'application_rejected', 'application_closed',
        'deployment_completed')
  and not exists (
    select 1 from public.application_history h
    where h.application_id = o.application_id
      and h.event = case o.event_type
            when 'application_under_review' then 'reviewed'
            when 'application_shortlisted'  then 'qualified'
            when 'offer_sent'               then 'job_offer_prepared'
            when 'application_hired'        then 'hired'
            when 'application_rejected'     then 'rejected'
            when 'application_closed'       then 'application_closed'
            when 'deployment_completed'     then 'deployment_completed'
          end);

-- Interviews carry their own timestamps.
insert into public.application_history (application_id, event, created_at)
select i.application_id, i.interview_type::text || '_interview_scheduled', i.created_at
from public.interviews i
where not exists (
  select 1 from public.application_history h
  where h.application_id = i.application_id
    and h.event = i.interview_type::text || '_interview_scheduled');

insert into public.application_history (application_id, event, created_at)
select i.application_id, i.interview_type::text || '_interview_passed', i.updated_at
from public.interviews i
where i.status = 'passed'
  and not exists (
    select 1 from public.application_history h
    where h.application_id = i.application_id
      and h.event = i.interview_type::text || '_interview_passed');

insert into public.application_history (application_id, event, created_at)
select i.application_id, i.interview_type::text || '_interview_cancelled', i.updated_at
from public.interviews i
where i.status = 'cancelled'
  and not exists (
    select 1 from public.application_history h
    where h.application_id = i.application_id
      and h.event = i.interview_type::text || '_interview_cancelled');

-- ------------------------------------------------- the applicant's timeline
-- A separate boundary from lookup_application, which answers "where is my
-- application now". This answers "how did it get here", and is kept apart so
-- the milestone list can never accidentally inherit that function's much wider
-- result -- which carries salary, contract and employee detail.
create or replace function public.lookup_application_milestones(
  p_reference_code text,
  p_email text
)
returns table(event text, occurred_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select h.event, h.created_at
  from public.application_history h
  join public.applications a on a.id = h.application_id
  join public.applicants ap on ap.id = a.applicant_id
  where a.reference_code = upper(trim(p_reference_code))
    and lower(coalesce(a.applicant_email, ap.email)) = lower(trim(p_email))
    -- An explicit allow-list, not an exclusion list. A milestone added later
    -- has to be named here before an applicant can see it, so no future event
    -- can leak by simply existing.
    and h.event in (
      'submitted', 'reviewed', 'qualified', 'job_offer_prepared',
      'offer_accepted', 'offer_declined', 'hired', 'rejected',
      'application_closed', 'deployment_completed',
      'initial_interview_scheduled', 'initial_interview_rescheduled',
      'initial_interview_passed', 'initial_interview_cancelled',
      'final_interview_scheduled', 'final_interview_rescheduled',
      'final_interview_cancelled')
    -- Deliberately absent: *_started, *_rejected, rejection_email_queued,
    -- contract_* and the *_email_queued rows. They are HR's working record of
    -- what was done internally, not milestones the applicant is owed.

  order by h.created_at;
$function$;

revoke all on function public.lookup_application_milestones(text, text) from public;
grant execute on function public.lookup_application_milestones(text, text) to anon, authenticated;

comment on function public.lookup_application_milestones(text, text) is
  'Applicant-safe milestone timeline for Track Application. Reference code plus '
  'email, the same pair lookup_application requires. Returns event names and '
  'times only -- never ratings, notes, reviewers or rejection reasons.';
