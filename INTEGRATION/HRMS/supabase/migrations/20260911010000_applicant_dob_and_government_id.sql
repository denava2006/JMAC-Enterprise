-- Date of birth and a valid government ID, collected once by the applicant.
--
-- HR was retyping a birth date the applicant could have given at application
-- time, and asking a new hire to upload an ID they had already provided. Both
-- belong to the application, and both are recorded on its immutable snapshot so
-- a later application by the same person cannot rewrite them.
--
-- The ID is sensitive personal information and is treated as such: its own
-- private bucket, a generated object path, no public URL, and anonymous access
-- narrowed to the single thing an applicant needs -- putting their own file in.
-- They cannot list, read, replace or remove anything, including their own.

-- ------------------------------------------------------------ the snapshot
alter table public.applications
  add column if not exists applicant_birth_date date,
  add column if not exists applicant_government_id_path text;

comment on column public.applications.applicant_birth_date is
  'Date of birth as given on this application. Immutable, like the rest of the '
  'snapshot. Never returned by Track Application.';

comment on column public.applications.applicant_government_id_path is
  'Object path in the private government-ids bucket. A path, never a URL: the '
  'bucket is private and access is granted per request to staff.';

-- ------------------------------------------------- the snapshot stays fixed
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

  if new.applicant_first_name        is distinct from old.applicant_first_name
  or new.applicant_middle_name       is distinct from old.applicant_middle_name
  or new.applicant_last_name         is distinct from old.applicant_last_name
  or new.applicant_email             is distinct from old.applicant_email
  or new.applicant_phone             is distinct from old.applicant_phone
  or new.applicant_province          is distinct from old.applicant_province
  or new.applicant_city              is distinct from old.applicant_city
  or new.applicant_barangay          is distinct from old.applicant_barangay
  or new.applicant_address           is distinct from old.applicant_address
  or new.applicant_resume_url        is distinct from old.applicant_resume_url
  or new.applicant_cover_letter      is distinct from old.applicant_cover_letter
  or new.applicant_birth_date        is distinct from old.applicant_birth_date
  or new.applicant_government_id_path is distinct from old.applicant_government_id_path then
    raise exception 'An application records what was submitted and cannot be edited. Correct the employee record instead.';
  end if;

  return new;
end;
$fn$;

-- --------------------------------------------------------- the private bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'government-ids', 'government-ids', false, 5242880,
  -- A photograph or a scan. Nothing that can execute.
  array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The narrowest thing that lets an applicant submit: put a file in, nothing
-- else. No SELECT, so they cannot list the bucket or read back anyone's ID --
-- including their own. No UPDATE or DELETE, so an uploaded ID cannot be
-- replaced or removed by whoever knows the path.
drop policy if exists "applicant_can_upload_government_id" on storage.objects;
create policy "applicant_can_upload_government_id"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'government-ids');

-- Reading is HR's, and only while they are active staff. Mirrors
-- staff_can_read_resume, which is the same trust boundary.
-- TO authenticated, not the default PUBLIC. PUBLIC includes anon, Postgres
-- evaluates every applicable policy, and anon cannot execute is_active_staff()
-- -- so a public-targeted policy raises 42501 and fails the whole request, for
-- every bucket, not just this one. That is the same mistake that once broke
-- resume uploads on the careers page.
drop policy if exists "staff_can_read_government_id" on storage.objects;
create policy "staff_can_read_government_id"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'government-ids' and public.is_active_staff());

-- ------------------------------------------------------------ submitting
-- p_birth_date and p_government_id_path are required. They are added at the end
-- so the existing 12-argument signature keeps working for anything already
-- calling it, and the old one is dropped below -- an application without an ID
-- or a date of birth is no longer a complete application.
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
  p_barangay text default null,
  p_birth_date date default null,
  p_government_id_path text default null
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

  if p_birth_date is null then
    raise exception 'BIRTH_DATE_REQUIRED';
  end if;

  -- Real date arithmetic, not year subtraction. Somebody born on 2 September
  -- 2008 is 18 on 2 September 2026 and 17 the day before; comparing years alone
  -- would admit them from January. Exactly 18 today passes.
  if p_birth_date > (current_date - interval '18 years') then
    raise exception 'UNDERAGE_APPLICANT';
  end if;

  -- A future date, or one implying an implausible age, is a malformed request
  -- rather than an underage applicant.
  if p_birth_date < (current_date - interval '100 years') then
    raise exception 'BIRTH_DATE_INVALID';
  end if;

  if p_government_id_path is null or btrim(p_government_id_path) = '' then
    raise exception 'GOVERNMENT_ID_REQUIRED';
  end if;

  if p_resume_path is null or btrim(p_resume_path) = '' then
    raise exception 'RESUME_REQUIRED';
  end if;

  -- The two documents are different documents. Accepting the same object as
  -- both is how a resume ends up filed as somebody's proof of identity.
  if btrim(p_government_id_path) = btrim(p_resume_path) then
    raise exception 'GOVERNMENT_ID_REQUIRED';
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
    applicant_resume_url, applicant_cover_letter,
    applicant_birth_date, applicant_government_id_path)
  values (
    v_applicant_id, p_job_posting_id,
    p_first_name, p_middle_name, p_last_name,
    p_email, p_phone,
    p_province, p_city, p_barangay, p_address,
    p_resume_path, p_cover_letter,
    p_birth_date, btrim(p_government_id_path))
  returning id, applications.reference_code into v_application_id, v_reference_code;

  -- The 'submitted' milestone is recorded by the applications INSERT trigger,
  -- which covers every path into this table rather than just this one. Writing
  -- it here as well put the stage on the applicant's timeline twice.

  return query select v_application_id, v_applicant_id, v_reference_code;
end;
$function$;

-- Every older overload goes. Each would still accept an application with no
-- government ID and no date of birth -- which is exactly what this migration
-- exists to prevent -- and an overload nobody remembers is the kind of door
-- that stays open for years. The 8-argument one predates province/city/barangay
-- and was still callable by anon.
drop function if exists public.submit_job_application(
  uuid, text, text, text, text, text, text, text, text, text, text, text);
drop function if exists public.submit_job_application(
  uuid, text, text, text, text, text, text, text);

revoke all on function public.submit_job_application(
  uuid, text, text, text, text, text, text, text, text, text, text, text, date, text)
  from public;
grant execute on function public.submit_job_application(
  uuid, text, text, text, text, text, text, text, text, text, text, text, date, text)
  to anon, authenticated;
