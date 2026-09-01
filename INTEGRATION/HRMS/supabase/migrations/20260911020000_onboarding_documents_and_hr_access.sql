-- Onboarding carries what the applicant already gave, and grants the access
-- their position already implies.
--
-- Two pieces of onboarding friction, both of which made somebody redo work the
-- system had already done:
--
--   The government ID collected at application time was left on the
--   application. A new hire was asked to upload the same document again.
--
--   An employee hired INTO an HR position -- a position whose entitlement
--   mapping already says hrms:hr_staff -- got a login with no HR access, and an
--   Administrator had to go and grant by hand what the position had already
--   decided.

-- ------------------------------------------------ the ID follows the person
create or replace function public.attach_application_documents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id_path text;
begin
  if new.application_id is null then
    return new;
  end if;

  select a.applicant_government_id_path into _id_path
  from public.applications a
  where a.id = new.application_id;

  if _id_path is null or btrim(_id_path) = '' then
    return new;
  end if;

  -- The file is not copied. The employee document points at the object the
  -- applicant uploaded, which is already in a private bucket only staff can
  -- read -- duplicating it would mean two copies of somebody's ID to secure
  -- and delete instead of one.
  --
  -- Filed under its own type. The resume is a recruitment document and stays
  -- one; an ID mislabelled as a CV, or the reverse, is worse than a missing
  -- document because it looks checked.
  insert into public.employee_documents (employee_id, document_type, file_url, uploaded_by)
  values (new.id, 'Government ID', _id_path, (select auth.uid()))
  on conflict do nothing;

  return new;
end;
$fn$;

drop trigger if exists trg_attach_application_documents on public.employees;
create trigger trg_attach_application_documents
  after insert on public.employees
  for each row execute function public.attach_application_documents();

comment on function public.attach_application_documents() is
  'Files the government ID submitted with the hired application against the new '
  'employee. Points at the existing private object rather than copying it.';

-- --------------------------------------------- access follows the position
--
-- position_system_roles is the authority, exactly as it is for POS and for the
-- eligibility check every manual grant already passes. Nothing here reads a
-- position TITLE: renaming "HR Staff" to "People Operations Staff" must not
-- silently change who can reach HRMS.
create or replace function public.reconcile_hr_privilege(_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _entitled text;
  _active   record;
  _blocked  boolean;
begin
  -- What this account's current position entitles it to, if anything.
  select psr.role_code into _entitled
  from public.profiles pr
  join public.employees e on e.id = pr.employee_id
  join public.positions pos on pos.id = e.position_id
  join public.position_system_roles psr
    on psr.position_id = pos.id and psr.system = 'hrms'
  where pr.id = _profile_id
    and pr.status = 'active'
    and pr.role <> 'admin'
    and public.employment_permits_operational_work(e.employment_status)
  limit 1;

  select * into _active
  from public.hr_privilege_grants
  where profile_id = _profile_id and status = 'active'
  limit 1;

  -- Nothing to establish. Removing access when the position no longer entitles
  -- it is close_ineligible_hr_grants' job, on the employees trigger -- doing it
  -- here as well would mean two things racing to close the same grant.
  if _entitled is null then
    return;
  end if;

  if _active.id is not null then
    if _active.hr_role = _entitled then
      return; -- already correct
    end if;

    -- A promotion or a transfer between HR positions. Exactly one grant is
    -- current at a time, and the old one is closed rather than deleted so the
    -- history of who could do what, and when, survives.
    update public.hr_privilege_grants
       set status = 'closed', closed_at = now(),
           closed_reason = 'position_changed', updated_at = now()
     where id = _active.id;
  else
    -- An Administrator's decision outlives a page refresh.
    --
    -- Only the system's own closures may be reversed automatically. Anything
    -- else was a person deciding this account should not have HR access, and
    -- re-granting it on the next lifecycle event would quietly overrule them.
    select exists (
      select 1 from public.hr_privilege_grants
      where profile_id = _profile_id
        and status = 'closed'
        and coalesce(closed_reason, '') not in ('workforce_ineligible', 'position_changed')
    ) into _blocked;

    if _blocked then
      return;
    end if;
  end if;

  if not public.is_eligible_for_system_role(_profile_id, 'hrms', _entitled) then
    return;
  end if;

  -- profiles.role names the role; the grant authorizes it. Written together,
  -- exactly as grant_hr_privilege does -- an account naming a role it has no
  -- grant for authorizes nothing, and has_hr_privilege requires both.
  update public.profiles set role = _entitled::public.user_role where id = _profile_id;

  insert into public.hr_privilege_grants (profile_id, hr_role, granted_by)
  values (_profile_id, _entitled, (select auth.uid()));

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values ((select auth.uid()), 'HR Privilege Granted', 'hr_privilege_grants',
          _profile_id,
          jsonb_build_object('profile_id', _profile_id, 'hr_role', _entitled,
                             'source', 'position entitlement'));
end;
$fn$;

revoke all on function public.reconcile_hr_privilege(uuid) from public, anon, authenticated;

comment on function public.reconcile_hr_privilege(uuid) is
  'Establishes the HR privilege this account''s position entitles it to. Runs on '
  'lifecycle events only -- provisioning and transfer -- never on sign-in, so an '
  'Administrator''s manual revocation is not undone by the next page load.';

-- ------------------------------------------------------- when it runs
-- Provisioning: the moment a profile is linked to an employee.
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
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_reconcile_hr_privilege_on_link on public.profiles;
create trigger trg_reconcile_hr_privilege_on_link
  after update of employee_id on public.profiles
  for each row execute function public.reconcile_hr_privilege_on_link();

-- Transfer or promotion: the employee's position changes.
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
  end if;
  return new;
end;
$fn$;

-- After close_ineligible_hr_grants, which runs on the same table: a move OUT of
-- an HR position closes the old grant, and a move INTO one establishes the new.
drop trigger if exists trg_reconcile_hr_privilege_on_transfer on public.employees;
create trigger trg_reconcile_hr_privilege_on_transfer
  after update of position_id on public.employees
  for each row execute function public.reconcile_hr_privilege_on_transfer();
