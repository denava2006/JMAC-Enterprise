-- An application must remember who submitted it.
--
-- APP-2026-0003 was submitted by Clark Kint De Nava and later displayed "ZZ
-- CronCheck" everywhere -- HR detail, Track Application, and the Create
-- Employee handoff, which carried the wrong name into a real employee record.
--
-- The cause is in submit_job_application. An applicant is found by email and
-- then REWRITTEN:
--
--   select id into v_applicant_id from applicants where email = p_email;
--   ...
--   update applicants set first_name = p_first_name, last_name = p_last_name,
--                         phone = p_phone, address = p_address, ...
--
-- and `applications` holds no identity of its own -- only applicant_id. So a
-- second application from the same address retroactively renames every earlier
-- application by that person. One shared row, mutated, read by all of history.
--
-- The evidence is exact. applicants.updated_at is 09:10:15.914731, the moment a
-- second application was submitted on that email, and the notification outbox
-- -- which snapshots the name at enqueue time -- reads:
--
--   08:32:42  application_submitted     Clark Kint De Nava
--   08:33:43  application_shortlisted   Clark Kint De Nava
--   08:34:51  interview_scheduled       Clark Kint De Nava
--   10:01:49  interview_scheduled       ZZ CronCheck
--
-- Nothing was wrong with the submission. The model let a later write reach
-- backwards.
--
-- The fix is that an application keeps its own copy of what was submitted.
-- applicants stays as the reusable contact record a person may update; the
-- snapshot is what every historical view reads. Reusing an applicant by email
-- is still allowed and is still correct -- it is the rewriting that was wrong.

-- ---------------------------------------------------------------- the snapshot
alter table public.applications
  add column if not exists applicant_first_name  text,
  add column if not exists applicant_middle_name text,
  add column if not exists applicant_last_name   text,
  add column if not exists applicant_email       text,
  add column if not exists applicant_phone       text,
  add column if not exists applicant_province    text,
  add column if not exists applicant_city        text,
  add column if not exists applicant_barangay    text,
  add column if not exists applicant_address     text;

comment on column public.applications.applicant_first_name is
  'What this application was submitted with. Immutable: a later application by '
  'the same person must never change it. Read this, not applicants.';

-- ------------------------------------------------------------- the backfill
-- Existing applications take today's applicant values, which is the best
-- available answer for every row except the one we know was overwritten.
update public.applications a
set applicant_first_name  = coalesce(a.applicant_first_name,  ap.first_name),
    applicant_middle_name = coalesce(a.applicant_middle_name, ap.middle_name),
    applicant_last_name   = coalesce(a.applicant_last_name,   ap.last_name),
    applicant_email       = coalesce(a.applicant_email,       ap.email),
    applicant_phone       = coalesce(a.applicant_phone,       ap.phone),
    applicant_province    = coalesce(a.applicant_province,    ap.province),
    applicant_city        = coalesce(a.applicant_city,        ap.city),
    applicant_barangay    = coalesce(a.applicant_barangay,    ap.barangay),
    applicant_address     = coalesce(a.applicant_address,     ap.address)
from public.applicants ap
where ap.id = a.applicant_id
  and a.applicant_first_name is null;

-- ------------------------------------------------- submitting takes a snapshot
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
    applicant_province, applicant_city, applicant_barangay, applicant_address)
  values (
    v_applicant_id, p_job_posting_id,
    p_first_name, p_middle_name, p_last_name,
    p_email, p_phone,
    p_province, p_city, p_barangay, p_address)
  returning id, applications.reference_code into v_application_id, v_reference_code;

  insert into application_history (application_id, event)
  values (v_application_id, 'submitted');

  return query select v_application_id, v_applicant_id, v_reference_code;
end;
$function$;

-- ------------------------------------------------- the snapshot is immutable
-- A snapshot that anything may edit is not a snapshot. HR corrections belong on
-- the employee record; correcting an application's submitted identity is a
-- deliberate act, not a side effect of some other save.
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

  if new.applicant_first_name  is distinct from old.applicant_first_name
  or new.applicant_middle_name is distinct from old.applicant_middle_name
  or new.applicant_last_name   is distinct from old.applicant_last_name
  or new.applicant_email       is distinct from old.applicant_email
  or new.applicant_phone       is distinct from old.applicant_phone
  or new.applicant_province    is distinct from old.applicant_province
  or new.applicant_city        is distinct from old.applicant_city
  or new.applicant_barangay    is distinct from old.applicant_barangay
  or new.applicant_address     is distinct from old.applicant_address then
    raise exception 'An application records what was submitted and cannot be edited. Correct the employee record instead.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_protect_application_identity on public.applications;
create trigger trg_protect_application_identity
  before update on public.applications
  for each row execute function public.protect_application_identity_snapshot();

-- ------------------------------------------------- notifications use it too
-- The greeting on every future email comes from the application, so an old
-- application keeps greeting the person who submitted it.
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

  return _id;
end;
$fn$;

revoke all on function public.enqueue_applicant_notification(uuid, text, text, jsonb) from public, anon, authenticated;
