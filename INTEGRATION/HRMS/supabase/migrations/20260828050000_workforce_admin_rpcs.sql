-- Phase 9A, part 6: the three reads the Administrator's screens need.
--
-- All are RPCs rather than table queries, so the candidate list, the
-- configuration and the compliance report are all decided by the database. The
-- POS Access page must not fetch every profile and hide the invalid ones in
-- React -- a list that is filtered on the client is a list that can be unfiltered
-- on the client.

-- --------------------------------------------- who may be given a POS role
--
-- Branch -> POS Role -> Eligible Employee. The branch is not a filter on
-- eligibility (eligibility is a property of the person's job, not of where
-- they would work) but it is used to exclude somebody who already holds an
-- active assignment there, which would only produce a duplicate.
--
-- Safe fields only: identity, contact, and where they sit in the org. No
-- salary, no basic pay, no birth date, no address.
create or replace function public.get_eligible_pos_employees(
  _branch_id uuid,
  _role_code text
)
returns table (
  profile_id uuid,
  employee_id uuid,
  full_name text,
  email text,
  employee_number text,
  department_name text,
  position_title text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    pr.id, e.id, pr.full_name, pr.email, e.employee_number, d.name, pos.title
  from public.profiles pr
  join public.employees e on e.id = pr.employee_id
  join public.positions pos on pos.id = e.position_id
  join public.departments d on d.id = e.department_id
  where public.is_admin()
    and public.is_eligible_for_system_role(pr.id, 'pos', _role_code)
    and not exists (
      select 1 from public.pos_branch_assignments a
       where a.profile_id = pr.id and a.branch_id = _branch_id and a.status = 'active'
    )
  order by pr.full_name;
$fn$;

revoke all on function public.get_eligible_pos_employees(uuid, text) from public, anon;
grant execute on function public.get_eligible_pos_employees(uuid, text) to authenticated;

-- ------------------------------------------------ what is currently broken
--
-- Active assignments whose holder is no longer eligible, with the reason in
-- words. Inactive history is excluded: it is not a problem to fix, and listing
-- it would bury the rows that are.
create or replace function public.get_noncompliant_pos_assignments()
returns table (
  assignment_id uuid,
  profile_id uuid,
  full_name text,
  branch_id uuid,
  branch_name text,
  pos_role public.pos_role,
  department_name text,
  position_title text,
  reason text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    a.id, a.profile_id, pr.full_name, a.branch_id, b.name, a.pos_role,
    coalesce(d.name, '—'), coalesce(pos.title, '—'),
    public.describe_pos_ineligibility(a.profile_id, a.pos_role::text)
  from public.pos_branch_assignments a
  join public.profiles pr on pr.id = a.profile_id
  join public.branches b on b.id = a.branch_id
  left join public.employees e on e.id = pr.employee_id
  left join public.departments d on d.id = e.department_id
  left join public.positions pos on pos.id = e.position_id
  where public.is_admin()
    and a.status = 'active'
    and not public.is_eligible_for_system_role(a.profile_id, 'pos', a.pos_role::text)
  order by pr.full_name, b.name;
$fn$;

revoke all on function public.get_noncompliant_pos_assignments() from public, anon;
grant execute on function public.get_noncompliant_pos_assignments() to authenticated;

-- ------------------------------------------------- the entitlement editor
--
-- Every position with the roles it currently grants, for the Positions screen.
create or replace function public.get_position_entitlements()
returns table (
  position_id uuid,
  position_title text,
  department_id uuid,
  department_name text,
  system public.entitlement_system,
  role_code text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select pos.id, pos.title, d.id, d.name, psr.system, psr.role_code
  from public.positions pos
  join public.departments d on d.id = pos.department_id
  left join public.position_system_roles psr on psr.position_id = pos.id
  where public.is_active_staff()
  order by d.name, pos.title, psr.system, psr.role_code;
$fn$;

revoke all on function public.get_position_entitlements() from public, anon;
grant execute on function public.get_position_entitlements() to authenticated;

-- Grant or remove one entitlement. Administrator only, and the CHECK
-- constraint on the table validates the code -- there is no path here that
-- accepts an arbitrary string.
--
-- Removing an entitlement does NOT retroactively revoke assignments: they stop
-- authorizing immediately through has_pos_role(), and the compliance report
-- shows them so the Administrator can close them deliberately. Silently
-- cascading a configuration edit into mass revocation would be worse.
create or replace function public.set_position_entitlement(
  _position_id uuid,
  _system public.entitlement_system,
  _role_code text,
  _granted boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an Administrator can change position eligibility';
  end if;
  if not exists (select 1 from public.positions where id = _position_id) then
    raise exception 'That position does not exist';
  end if;

  if _granted then
    insert into public.position_system_roles (position_id, system, role_code, created_by)
    values (_position_id, _system, _role_code, (select auth.uid()))
    on conflict (position_id, system, role_code) do nothing;
  else
    delete from public.position_system_roles
     where position_id = _position_id and system = _system and role_code = _role_code;
  end if;
end;
$fn$;

revoke all on function public.set_position_entitlement(
  uuid, public.entitlement_system, text, boolean) from public, anon;
grant execute on function public.set_position_entitlement(
  uuid, public.entitlement_system, text, boolean) to authenticated;
