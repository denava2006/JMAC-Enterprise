-- Phase 9B: HR authorization stops being a column and becomes a grant.
--
-- Until now `profiles.role = 'hr_manager'` was, by itself, the whole of HR
-- authorization. Nothing tied it to a job: staff@suite.com and manager@suite.com
-- had no employee record at all, so there was no department, no position, and
-- nothing that could ever make their access wrong. A POS cashier could not be
-- given branch access without a matching position, but an HR Manager needed
-- only a value in a column.
--
-- From here, three things must all hold, and each can fail independently:
--
--   profiles.role          the HR role the account claims          (unchanged enum)
--   an ACTIVE grant        an Administrator said so, explicitly
--   current eligibility    their job still permits that role
--
-- The Administrator is the one exception, and deliberately so: their authority
-- is enterprise identity, not a position, and requiring them to hold a job
-- would make a fresh install unadministrable.
--
-- Closure is one-way, exactly as POS closure is. Losing eligibility closes the
-- grant; regaining the position does not reopen it. Access that comes back by
-- itself, days later, as a side effect of an HR edit, is access nobody
-- authorized.

create table if not exists public.hr_privilege_grants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  -- Text rather than user_role: this names the *privilege* granted, and the
  -- set is deliberately narrower than the role enum. 'admin' and 'employee'
  -- are not grantable here for the same reason they are not entitlements.
  hr_role text not null check (hr_role in ('hr_staff', 'hr_manager')),
  status text not null default 'active' check (status in ('active', 'closed')),
  granted_by uuid references public.profiles(id),
  granted_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live privilege per account. History accumulates; only one row authorizes.
create unique index if not exists hr_privilege_grants_one_active
  on public.hr_privilege_grants (profile_id)
  where status = 'active';

create index if not exists idx_hr_privilege_grants_profile
  on public.hr_privilege_grants (profile_id);

comment on table public.hr_privilege_grants is
  'Explicit, revocable HR privilege. profiles.role names the role; this says an '
  'Administrator granted it and it has not been closed since.';

alter table public.hr_privilege_grants enable row level security;

-- Reading the grant list is ordinary staff work; changing it is not.
drop policy if exists hr_privilege_grants_admin_manage on public.hr_privilege_grants;
create policy hr_privilege_grants_admin_manage on public.hr_privilege_grants
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists hr_privilege_grants_self_select on public.hr_privilege_grants;
create policy hr_privilege_grants_self_select on public.hr_privilege_grants
  for select using (profile_id = (select auth.uid()));

-- ------------------------------------------------------------ eligibility
-- Eligibility describes the JOB, not the account. Phase 9A required
-- profiles.role = 'employee' because POS holders are employees, but that
-- conflated "what this position permits" with "what this account currently is"
-- -- and it made an hr_staff account ineligible for the HR role its own
-- position exists to confer.
--
-- Administrators stay excluded: their authority is global and not derived from
-- a position, and a branch assignment for them would be a second place
-- answering a question is_admin() already answers.
create or replace function public.is_eligible_for_system_role(
  _profile_id uuid,
  _system public.entitlement_system,
  _role_code text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.profiles pr
    join public.employees e on e.id = pr.employee_id
    join public.positions pos on pos.id = e.position_id
    join public.position_system_roles psr
      on psr.position_id = pos.id and psr.system = _system and psr.role_code = _role_code
    where pr.id = _profile_id
      and pr.status = 'active'
      and pr.role <> 'admin'
      and public.employment_permits_operational_work(e.employment_status)
      and e.department_id is not null
      and pos.department_id = e.department_id
  );
$fn$;

revoke all on function public.is_eligible_for_system_role(uuid, public.entitlement_system, text)
  from public, anon;
grant execute on function public.is_eligible_for_system_role(uuid, public.entitlement_system, text)
  to authenticated;

-- ------------------------------------------------------- the HR predicate
-- Everything an HR privilege requires, in one place. is_active_staff() and the
-- others below are thin wrappers, so all 47 policies that call them inherit
-- this without a single policy being rewritten.
create or replace function public.has_hr_privilege(_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.profiles pr
    join public.hr_privilege_grants g
      on g.profile_id = pr.id and g.status = 'active'
    where pr.id = (select auth.uid())
      and pr.status = 'active'
      -- The account must still claim the role it was granted. A profile demoted
      -- to 'employee' stops authorizing even while the grant row survives.
      and pr.role::text = g.hr_role
      and g.hr_role = any (_roles)
      and public.is_eligible_for_system_role(pr.id, 'hrms', g.hr_role)
  );
$fn$;

revoke all on function public.has_hr_privilege(text[]) from public, anon;
grant execute on function public.has_hr_privilege(text[]) to authenticated;

comment on function public.has_hr_privilege(text[]) is
  'Role claimed + granted + still eligible. Does NOT include the Administrator; '
  'callers short-circuit on is_admin() first.';

-- ----------------------------------------------- the predicates themselves
-- Signatures are unchanged on purpose: 47 policies and 9 routines call these,
-- and rewriting them all would be a far larger change than the one intended.
create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.is_admin() or public.has_hr_privilege(array['hr_staff', 'hr_manager']);
$fn$;

create or replace function public.is_hr_manager_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.is_admin() or public.has_hr_privilege(array['hr_manager']);
$fn$;

create or replace function public.is_hr_staff_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.is_admin() or public.has_hr_privilege(array['hr_staff']);
$fn$;

revoke all on function public.is_active_staff() from public, anon;
grant execute on function public.is_active_staff() to authenticated;
revoke all on function public.is_hr_manager_or_admin() from public, anon;
grant execute on function public.is_hr_manager_or_admin() to authenticated;
revoke all on function public.is_hr_staff_or_admin() from public, anon;
grant execute on function public.is_hr_staff_or_admin() to authenticated;

-- ---------------------------------------------------------------- closure
-- The POS rule, applied to HR: drift closes access, and only an Administrator
-- reopens it. This fires on the employee row because that is where a transfer,
-- a resignation or a leave of absence actually lands.
create or replace function public.close_ineligible_hr_grants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  g record;
begin
  for g in
    select hg.id, hg.hr_role, pr.id as profile_id
    from public.hr_privilege_grants hg
    join public.profiles pr on pr.id = hg.profile_id
    where hg.status = 'active' and pr.employee_id = new.id
  loop
    if not public.is_eligible_for_system_role(g.profile_id, 'hrms', g.hr_role) then
      update public.hr_privilege_grants
         set status = 'closed',
             closed_at = now(),
             closed_reason = 'workforce_ineligible',
             updated_at = now()
       where id = g.id;
    end if;
  end loop;
  return new;
end;
$fn$;

drop trigger if exists trg_employees_close_ineligible_hr on public.employees;
create trigger trg_employees_close_ineligible_hr
  after update on public.employees
  for each row execute function public.close_ineligible_hr_grants();

-- Removing a position's HRMS entitlement closes every grant it was supporting.
create or replace function public.close_hr_grants_for_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if old.system <> 'hrms' then
    return old;
  end if;

  update public.hr_privilege_grants hg
     set status = 'closed', closed_at = now(),
         closed_reason = 'entitlement_removed', updated_at = now()
   where hg.status = 'active'
     and hg.hr_role = old.role_code
     and exists (
       select 1 from public.profiles pr
       join public.employees e on e.id = pr.employee_id
       where pr.id = hg.profile_id and e.position_id = old.position_id
     );
  return old;
end;
$fn$;

drop trigger if exists trg_entitlement_close_hr_grants on public.position_system_roles;
create trigger trg_entitlement_close_hr_grants
  after delete on public.position_system_roles
  for each row execute function public.close_hr_grants_for_entitlement();

-- A closed grant is never reopened in place. Grant a new one, deliberately.
create or replace function public.no_hr_grant_resurrection()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'UPDATE' and old.status = 'closed' and new.status = 'active' then
    raise exception
      'HR_GRANT_CLOSED: that privilege was closed%. Grant a new one instead.',
      case when old.closed_reason = 'workforce_ineligible'
        then ' because the employee stopped being eligible'
        when old.closed_reason = 'entitlement_removed'
        then ' because the position stopped conferring it'
        else '' end;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_hr_grants_no_resurrection on public.hr_privilege_grants;
create trigger trg_hr_grants_no_resurrection
  before update on public.hr_privilege_grants
  for each row execute function public.no_hr_grant_resurrection();

-- A grant may only be created for somebody the job actually permits.
create or replace function public.hr_grant_requires_eligibility()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.status = 'active'
     and not public.is_eligible_for_system_role(new.profile_id, 'hrms', new.hr_role) then
    raise exception 'HR_GRANT_NOT_ELIGIBLE: %',
      public.describe_ineligibility(new.profile_id, 'hrms', new.hr_role);
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_hr_grants_require_eligibility on public.hr_privilege_grants;
create trigger trg_hr_grants_require_eligibility
  before insert or update on public.hr_privilege_grants
  for each row execute function public.hr_grant_requires_eligibility();

drop trigger if exists trg_hr_grants_updated_at on public.hr_privilege_grants;
create trigger trg_hr_grants_updated_at
  before update on public.hr_privilege_grants
  for each row execute function public.set_updated_at();

revoke all on function public.close_ineligible_hr_grants() from public, anon, authenticated;
revoke all on function public.close_hr_grants_for_entitlement() from public, anon, authenticated;
revoke all on function public.no_hr_grant_resurrection() from public, anon, authenticated;
revoke all on function public.hr_grant_requires_eligibility() from public, anon, authenticated;
