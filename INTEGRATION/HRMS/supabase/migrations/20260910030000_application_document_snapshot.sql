-- The resume belongs to the application too.
--
-- 20260910000000 gave an application its own copy of the identity it was
-- submitted with, because the applicants row is rewritten by every new
-- submission and was reaching backwards through history. The same statement
-- rewrites two more columns:
--
--   update applicants set ... resume_url = p_resume_path,
--                             cover_letter = coalesce(p_cover_letter, cover_letter)
--
-- so an application opened in HR shows whatever CV the person most recently
-- uploaded -- not the one it was actually submitted with. An interviewer
-- reading a candidate's file therefore reads the wrong document, and the
-- contract print, the deployment sheet and the interview drawer all inherit it.
--
-- Same defect, same fix. Left out of the first migration only because the
-- reported symptom was the name.

alter table public.applications
  add column if not exists applicant_resume_url   text,
  add column if not exists applicant_cover_letter text;

comment on column public.applications.applicant_resume_url is
  'The CV submitted WITH this application. Immutable: a later application by '
  'the same person must not replace it. Read this, not applicants.resume_url.';

update public.applications a
set applicant_resume_url   = coalesce(a.applicant_resume_url,   ap.resume_url),
    applicant_cover_letter = coalesce(a.applicant_cover_letter, ap.cover_letter)
from public.applicants ap
where ap.id = a.applicant_id
  and a.applicant_resume_url is null;

-- ----------------------------------------------- submitting records them too
create or replace function public.submit_job_application(
  p_job_posting_id uuid,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_phone text,
  p_address text,
  p_resume_path text,
  p_cover_letter text default null,
  p_middle_name text default null,
  p_province text default null,
  p_city text default null,
  p_barangay text default null
)
returns table(application_id uuid, applicant_id uuid, reference_code text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status job_posting_status;
  v_closing_date date;
  v_applicant_id uuid;
  v_application_id uuid;
  v_reference_code text;
begin
  select status, closing_date into v_status, v_closing_date
  from job_postings where id = p_job_posting_id;

  if not found then
    raise exception 'JOB_NOT_FOUND';
  end if;

  if v_status <> 'open' or (v_closing_date is not null and v_closing_date < current_date) then
    raise exception 'JOB_CLOSED';
  end if;

  select id into v_applicant_id from applicants where email = p_email;

  if v_applicant_id is null then
    insert into applicants (
      first_name, middle_name, last_name, email, phone,
      address, province, city, barangay, resume_url, cover_letter)
    values (
      p_first_name, p_middle_name, p_last_name, p_email, p_phone,
      p_address, p_province, p_city, p_barangay, p_resume_path, p_cover_letter)
    returning id into v_applicant_id;
  else
    if exists (
      select 1 from applications
      where applications.applicant_id = v_applicant_id
        and applications.job_posting_id = p_job_posting_id
    ) then
      raise exception 'DUPLICATE_APPLICATION';
    end if;

    -- The contact record still moves forward, because the newest submission is
    -- the best current address for reaching this person. What changed is that
    -- this no longer decides what OLDER applications say: each one carries its
    -- own snapshot, written below and never updated.
    update applicants
    set first_name = p_first_name,
        middle_name = p_middle_name,
        last_name = p_last_name,
        phone = p_phone,
        address = p_address,
        province = coalesce(p_province, province),
        city = coalesce(p_city, city),
        barangay = coalesce(p_barangay, barangay),
        resume_url = p_resume_path,
        cover_letter = coalesce(p_cover_letter, cover_letter),
        updated_at = now()
    where id = v_applicant_id;
  end if;

  insert into applications (
    applicant_id, job_posting_id,
    applicant_first_name, applicant_middle_name, applicant_last_name,
    applicant_email, applicant_phone,
    applicant_province, applicant_city, applicant_barangay, applicant_address,
    applicant_resume_url, applicant_cover_letter)
  values (
    v_applicant_id, p_job_posting_id,
    p_first_name, p_middle_name, p_last_name,
    p_email, p_phone,
    p_province, p_city, p_barangay, p_address,
    p_resume_path, p_cover_letter)
  returning id, applications.reference_code into v_application_id, v_reference_code;

  insert into application_history (application_id, event)
  values (v_application_id, 'submitted');

  return query select v_application_id, v_applicant_id, v_reference_code;
end;
$function$;

-- ------------------------------------------------ they are immutable as well
create or replace function public.protect_application_identity_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if (select auth.uid()) is null then
    -- Migrations, seeds and service-role repair run without a session.
    return new;
  end if;

  if new.applicant_first_name   is distinct from old.applicant_first_name
  or new.applicant_middle_name  is distinct from old.applicant_middle_name
  or new.applicant_last_name    is distinct from old.applicant_last_name
  or new.applicant_email        is distinct from old.applicant_email
  or new.applicant_phone        is distinct from old.applicant_phone
  or new.applicant_province     is distinct from old.applicant_province
  or new.applicant_city         is distinct from old.applicant_city
  or new.applicant_barangay     is distinct from old.applicant_barangay
  or new.applicant_address      is distinct from old.applicant_address
  or new.applicant_resume_url   is distinct from old.applicant_resume_url
  or new.applicant_cover_letter is distinct from old.applicant_cover_letter then
    raise exception 'An application records what was submitted and cannot be edited. Correct the employee record instead.';
  end if;

  return new;
end;
$fn$;
