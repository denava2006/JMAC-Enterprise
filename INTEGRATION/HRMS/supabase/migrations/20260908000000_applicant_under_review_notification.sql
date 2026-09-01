-- Tell an applicant when their application actually starts being reviewed.
--
-- Every other applicant-visible transition already emails: submitted,
-- shortlisted, interview scheduled/rescheduled/cancelled, offered, hired,
-- rejected, closed, deployed. under_review was the one deliberate omission,
-- and the reason is written into the trigger it was omitted from:
--
--   -- under_review and interview_scheduled are covered elsewhere or are
--   -- internal: 'under_review' says only that somebody opened it.
--
-- That was a fair reading when the status was set incidentally. It is the wrong
-- reading now: under_review is an authoritative, applicant-visible status that
-- Track Application already displays, and the gap between "we have your
-- application" and "you are shortlisted" is exactly the silence applicants
-- complain about. HR moving an application into review is a real decision, and
-- the applicant is entitled to know it happened.
--
-- Nothing else about the model changes. No new status is invented: under_review
-- has existed in application_status from the beginning, so the screening email
-- maps onto the state that already means screening.
--
-- The dedupe key is the application id, so an application that goes back into
-- review after a detour emails once in total. Interview reschedules remain the
-- one event keyed on something that changes, because a moved interview is
-- genuinely new information.

-- The outbox whitelists which events may exist, which is why this migration
-- starts here: the trigger below would otherwise queue a row the table refuses.
-- Keeping the list closed is deliberate -- an event with no template would be
-- an email nobody wrote.
alter table public.applicant_notification_outbox
  drop constraint if exists applicant_notification_outbox_event_type_check;
alter table public.applicant_notification_outbox
  add constraint applicant_notification_outbox_event_type_check check (
    event_type = any (array[
      'application_submitted',
      'application_under_review',
      'application_shortlisted',
      'interview_scheduled',
      'interview_rescheduled',
      'interview_cancelled',
      'offer_sent',
      'application_hired',
      'application_rejected',
      'application_closed',
      'deployment_completed'
    ])
  );

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
    when 'under_review' then
      -- The screening email. Says that review has started and nothing about
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
$fn$;
