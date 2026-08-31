-- Explain a refusal for any system, not just POS.
--
-- describe_pos_ineligibility() answered only for POS, and one of its branches
-- ("HR accounts administer people; they are not eligible for operational POS
-- roles") described the profiles.role = 'employee' rule that 20260901000000
-- replaced. Every reason except the last line is identical across systems, so
-- they are stated once here and the POS entry point delegates.

create or replace function public.describe_ineligibility(
  _profile_id uuid,
  _system public.entitlement_system,
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
  _what text := case _system when 'pos' then 'POS' when 'hrms' then 'HR' else 'Finance' end;
begin
  select * into _pr from public.profiles where id = _profile_id;
  if _pr.id is null then return 'That account no longer exists.'; end if;
  if _pr.status <> 'active' then return 'The account is deactivated.'; end if;
  if _pr.role = 'admin' then
    return 'Administrators hold authority globally and are never granted a position-derived role.';
  end if;
  if _pr.employee_id is null then
    return 'This account is not linked to an employee record.';
  end if;

  select * into _e from public.employees where id = _pr.employee_id;
  if _e.id is null then return 'The linked employee record is missing.'; end if;
  if not public.employment_permits_operational_work(_e.employment_status) then
    return 'The employee is ' || _e.employment_status::text || ', so ' || _what || ' access is closed.';
  end if;
  if _e.position_id is null then return 'The employee has no position on record.'; end if;
  if _e.department_id is null then return 'The employee has no department on record.'; end if;

  select * into _pos from public.positions where id = _e.position_id;
  if _pos.department_id is distinct from _e.department_id then
    return 'The employee''s position no longer belongs to their department.';
  end if;

  return _pos.title || ' is not eligible for ' || _what || ' ' ||
         coalesce(nullif(_role_code, ''), '(unspecified)') || '.';
end;
$fn$;

revoke all on function public.describe_ineligibility(uuid, public.entitlement_system, text)
  from public, anon;
grant execute on function public.describe_ineligibility(uuid, public.entitlement_system, text)
  to authenticated;

-- Signature preserved: pos_assignment_requires_eligibility and the POS screens
-- keep calling this, and keep getting POS wording.
create or replace function public.describe_pos_ineligibility(_profile_id uuid, _role_code text)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.describe_ineligibility(_profile_id, 'pos', _role_code);
$fn$;

revoke all on function public.describe_pos_ineligibility(uuid, text) from public, anon;
grant execute on function public.describe_pos_ineligibility(uuid, text) to authenticated;
