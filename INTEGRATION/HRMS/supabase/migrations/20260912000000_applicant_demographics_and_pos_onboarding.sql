-- Gender and nationality on the application, and POS access that arrives with
-- the job.
--
-- Two more places onboarding asked somebody to redo work:
--
--   Create Employee asked HR for a gender and a nationality the applicant was
--   never given the chance to state, so HR either guessed or asked.
--
--   An employee hired into a POS Manager position -- a position whose
--   entitlement mapping already says pos:manager -- got a login, self-service,
--   and no till. HR privilege had just been made automatic; POS had not, and
--   the two are the same problem.

-- ------------------------------------------------------------- the snapshot
alter table public.applications
  add column if not exists applicant_gender text,
  add column if not exists applicant_nationality text;

comment on column public.applications.applicant_gender is
  'As stated on this application. Immutable, like the rest of the snapshot. '
  'Same values the employee record uses -- there is one vocabulary, not two.';

create or replace function public.protect_application_identity_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  if new.applicant_first_name         is distinct from old.applicant_first_name
  or new.applicant_middle_name        is distinct from old.applicant_middle_name
  or new.applicant_last_name          is distinct from old.applicant_last_name
  or new.applicant_email              is distinct from old.applicant_email
  or new.applicant_phone              is distinct from old.applicant_phone
  or new.applicant_province           is distinct from old.applicant_province
  or new.applicant_city               is distinct from old.applicant_city
  or new.applicant_barangay           is distinct from old.applicant_barangay
  or new.applicant_address            is distinct from old.applicant_address
  or new.applicant_resume_url         is distinct from old.applicant_resume_url
  or new.applicant_cover_letter       is distinct from old.applicant_cover_letter
  or new.applicant_birth_date         is distinct from old.applicant_birth_date
  or new.applicant_government_id_path is distinct from old.applicant_government_id_path
  or new.applicant_gender             is distinct from old.applicant_gender
  or new.applicant_nationality        is distinct from old.applicant_nationality then
    raise exception 'An application records what was submitted and cannot be edited. Correct the employee record instead.';
  end if;

  return new;
end;
$fn$;

-- ------------------------------------------------------------- submitting
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
  p_government_id_path text default null,
  p_gender text default null,
  p_nationality text default null
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

  if p_gender is null or btrim(p_gender) = '' then
    raise exception 'GENDER_REQUIRED';
  end if;

  -- The same three the employee form offers. Checked here rather than by a
  -- CHECK constraint so existing employee rows, which were never constrained,
  -- are left exactly as they are.
  if btrim(p_gender) not in ('Male', 'Female', 'Other') then
    raise exception 'GENDER_INVALID';
  end if;

  if p_nationality is null or btrim(p_nationality) = '' then
    raise exception 'NATIONALITY_REQUIRED';
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
    applicant_birth_date, applicant_government_id_path,
    applicant_gender, applicant_nationality)
  values (
    v_applicant_id, p_job_posting_id,
    p_first_name, p_middle_name, p_last_name,
    p_email, p_phone,
    p_province, p_city, p_barangay, p_address,
    p_resume_path, p_cover_letter,
    p_birth_date, btrim(p_government_id_path),
    btrim(p_gender), btrim(p_nationality))
  returning id, applications.reference_code into v_application_id, v_reference_code;

  return query select v_application_id, v_applicant_id, v_reference_code;
end;
$function$;

-- Every earlier overload goes, for the same reason as before: one that predates
-- a required field would still accept an application without it.
drop function if exists public.submit_job_application(
  uuid, text, text, text, text, text, text, text, text, text, text, text, date, text);

revoke all on function public.submit_job_application(
  uuid, text, text, text, text, text, text, text, text, text, text, text, date, text, text, text)
  from public;
grant execute on function public.submit_job_application(
  uuid, text, text, text, text, text, text, text, text, text, text, text, date, text, text, text)
  to anon, authenticated;

-- ------------------------------------------------------- POS access at hire
--
-- The HR equivalent of this landed last week; this is the same rule for the
-- till. position_system_roles is the authority in both cases, and neither reads
-- a position's title: renaming "Cashier" must not decide who can take money.
--
-- POS access differs from HR access in one way that matters -- it is granted AT
-- A BRANCH. There is no such thing as a branchless cashier, so if the branch is
-- not known this does nothing at all rather than inventing one.
create or replace function public.reconcile_pos_access(_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _entitled text;
  _branch   uuid;
  _active   record;
  _blocked  boolean;
begin
  select psr.role_code into _entitled
  from public.profiles pr
  join public.employees e on e.id = pr.employee_id
  join public.positions pos on pos.id = e.position_id
  join public.position_system_roles psr
    on psr.position_id = pos.id and psr.system = 'pos'
  where pr.id = _profile_id
    and pr.status = 'active'
    and pr.role <> 'admin'
    and public.employment_permits_operational_work(e.employment_status)
  limit 1;

  if _entitled is null then
    -- Removing access when the position no longer entitles it is
    -- revoke_ineligible_pos_assignments' job, on the employees trigger.
    return;
  end if;

  -- Where they work, from the deployment that placed them there. Deployment is
  -- the authoritative record of the branch: it is the step where somebody
  -- actually decided.
  select d.branch_id into _branch
  from public.profiles pr
  join public.employees e on e.id = pr.employee_id
  join public.deployment_records d on d.application_id = e.application_id
  where pr.id = _profile_id and d.branch_id is not null
  limit 1;

  if _branch is null then
    -- Deliberately silent and empty-handed. A POS assignment with a guessed
    -- branch would let somebody sell at a till nobody put them at, and an
    -- assignment with no branch is not a thing this schema can express.
    raise notice 'reconcile_pos_access: no deployment branch for profile %, POS entitlement not established', _profile_id;
    return;
  end if;

  select * into _active
  from public.pos_branch_assignments
  where profile_id = _profile_id and status = 'active'
  limit 1;

  if _active.id is not null then
    if _active.pos_role::text = _entitled and _active.branch_id = _branch then
      return; -- already correct
    end if;

    -- A promotion, or a move to another branch. Closed rather than deleted:
    -- who could sell where, and when, is worth keeping.
    update public.pos_branch_assignments
       set status = 'inactive', revoked_reason = 'position_changed', updated_at = now()
     where id = _active.id;
  else
    -- An Administrator's revocation outlives a page refresh, exactly as it does
    -- for HR privilege. Only the system's own closures may be reversed.
    select exists (
      select 1 from public.pos_branch_assignments
      where profile_id = _profile_id
        and status <> 'active'
        and coalesce(revoked_reason, '') not in ('workforce_ineligible', 'position_changed')
    ) into _blocked;

    if _blocked then
      return;
    end if;
  end if;

  if not public.is_eligible_for_system_role(_profile_id, 'pos', _entitled) then
    return;
  end if;

  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, status, created_by)
  values (_profile_id, _branch, _entitled::public.pos_role, 'active', (select auth.uid()))
  on conflict (profile_id, branch_id) where (status = 'active') do nothing;
end;
$fn$;

revoke all on function public.reconcile_pos_access(uuid) from public, anon, authenticated;

comment on function public.reconcile_pos_access(uuid) is
  'Establishes the POS assignment this account''s position and deployment branch '
  'entitle it to. Lifecycle events only -- never sign-in -- so a manual '
  'revocation is not undone by the next page load. No branch, no assignment.';

-- ------------------------------------------------------------- when it runs
-- Alongside the HR reconciliation, on the same events.
create or replace function public.reconcile_hr_privilege_on_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.employee_id is not null
     and new.employee_id is distinct from coalesce(old.employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and new.status = 'active' then
    perform public.reconcile_hr_privilege(new.id);
    perform public.reconcile_pos_access(new.id);
  end if;
  return new;
end;
$fn$;

create or replace function public.reconcile_hr_privilege_on_transfer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _profile uuid;
begin
  if new.position_id is not distinct from old.position_id then
    return new;
  end if;

  select id into _profile from public.profiles where employee_id = new.id and status = 'active';
  if _profile is not null then
    perform public.reconcile_hr_privilege(_profile);
    perform public.reconcile_pos_access(_profile);
  end if;
  return new;
end;
$fn$;

-- Deployment is usually recorded BEFORE the employee exists, so the branch is
-- often unknown at link time and known here. Both paths run the same function,
-- which is idempotent -- whichever happens last establishes the assignment.
create or replace function public.reconcile_pos_access_on_deployment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _profile uuid;
begin
  if new.branch_id is null then
    return new;
  end if;

  select pr.id into _profile
  from public.employees e
  join public.profiles pr on pr.employee_id = e.id and pr.status = 'active'
  where e.application_id = new.application_id
  limit 1;

  if _profile is not null then
    perform public.reconcile_pos_access(_profile);
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_reconcile_pos_access_on_deployment on public.deployment_records;
create trigger trg_reconcile_pos_access_on_deployment
  after insert or update of branch_id on public.deployment_records
  for each row execute function public.reconcile_pos_access_on_deployment();
