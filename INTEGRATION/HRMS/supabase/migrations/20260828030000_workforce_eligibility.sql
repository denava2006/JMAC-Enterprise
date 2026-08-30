-- Phase 9A, part 4: the eligibility predicate, and why an assignment alone is
-- no longer enough.
--
-- Two facts must BOTH hold for POS access:
--
--   1. an active pos_branch_assignments row      -- somebody granted it
--   2. the employee's CURRENT position is        -- they are still the person
--      configured for that role                     who should have it
--
-- Before Phase 9A only (1) was checked, which is how an IT Support engineer
-- came to be a POS Manager. Checking (2) at READ time is what makes a transfer
-- take effect immediately, with no Administrator action and no revocation.

-- Employment states that permit operational work.
--
-- on_leave is deliberately excluded. The existing
-- sync_account_with_employment_status trigger keeps the PROFILE active while
-- somebody is on leave -- correctly, so they keep Employee Self-Service and
-- their payslips -- but somebody on leave should not be ringing up sales.
-- Terminated, resigned and retired already lose the profile itself.
create or replace function public.employment_permits_operational_work(
  _status public.employment_status
)
returns boolean
language sql
immutable
set search_path = ''
as $$ select _status = 'active' $$;

-- ------------------------------------------------------------- the predicate
--
-- Every condition, in one place, used by both the write gate and the read path
-- so the two cannot drift.
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
as $$
  select exists (
    select 1
    from public.profiles pr
    join public.employees e on e.id = pr.employee_id
    join public.positions pos on pos.id = e.position_id
    join public.position_system_roles psr
      on psr.position_id = pos.id
     and psr.system = _system
     and psr.role_code = _role_code
    where pr.id = _profile_id
      and pr.status = 'active'
      -- An enterprise/HR identity is not an operational one. HR Staff and HR
      -- Managers administer people; they do not work tills. And an
      -- Administrator must never hold a branch assignment at all -- their
      -- authority comes from is_admin(), which this deliberately does not
      -- short-circuit.
      and pr.role = 'employee'
      and public.employment_permits_operational_work(e.employment_status)
      -- The join to positions already requires a position; this requires the
      -- department too, and requires the pair to still be valid. A position
      -- moved out from under an employee stops authorizing.
      and e.department_id is not null
      and pos.department_id = e.department_id
  );
$$;

comment on function public.is_eligible_for_system_role(uuid, public.entitlement_system, text) is
  'Whether a profile MAY hold a system role, from their current employment '
  'record. Eligibility only -- it grants nothing. Administrators are '
  'deliberately ineligible: their authority is is_admin(), and they must never '
  'hold a POS branch assignment.';

revoke all on function public.is_eligible_for_system_role(uuid, public.entitlement_system, text)
  from public, anon;
grant execute on function public.is_eligible_for_system_role(uuid, public.entitlement_system, text)
  to authenticated;

-- ------------------------------------------------- why somebody is ineligible
--
-- The compliance screen has to explain itself. Returns null when eligible.
create or replace function public.describe_pos_ineligibility(
  _profile_id uuid,
  _role_code text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  _pr public.profiles%rowtype;
  _e public.employees%rowtype;
  _pos public.positions%rowtype;
begin
  select * into _pr from public.profiles where id = _profile_id;
  if _pr.id is null then return 'That account no longer exists.'; end if;
  if _pr.status <> 'active' then return 'The account is deactivated.'; end if;
  if _pr.role = 'admin' then
    return 'Administrators hold POS authority globally and are never assigned to a branch.';
  end if;
  if _pr.role <> 'employee' then
    return 'HR accounts administer people; they are not eligible for operational POS roles.';
  end if;
  if _pr.employee_id is null then return 'This account is not linked to an employee record.'; end if;

  select * into _e from public.employees where id = _pr.employee_id;
  if _e.id is null then return 'The linked employee record is missing.'; end if;
  if not public.employment_permits_operational_work(_e.employment_status) then
    return 'The employee is ' || _e.employment_status::text || ', so operational access is closed.';
  end if;
  if _e.position_id is null then return 'The employee has no position on record.'; end if;
  if _e.department_id is null then return 'The employee has no department on record.'; end if;

  select * into _pos from public.positions where id = _e.position_id;
  if _pos.department_id is distinct from _e.department_id then
    return 'The employee''s position no longer belongs to their department.';
  end if;

  if not exists (
    select 1 from public.position_system_roles psr
     where psr.position_id = _e.position_id and psr.system = 'pos' and psr.role_code = _role_code
  ) then
    return _pos.title || ' is not eligible for POS ' ||
           case when _role_code = 'manager' then 'Manager' else 'Cashier' end || '.';
  end if;

  return null;
end;
$fn$;

revoke all on function public.describe_pos_ineligibility(uuid, text) from public, anon;
grant execute on function public.describe_pos_ineligibility(uuid, text) to authenticated;
