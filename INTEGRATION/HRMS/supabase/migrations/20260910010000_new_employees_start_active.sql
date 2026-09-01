-- A new employee starts Active. Always.
--
-- Create Employee offered a status dropdown with Active, Resigned, Terminated
-- and Retired, so somebody could be hired directly into "resigned". Those are
-- lifecycle transitions -- things that happen TO an employee over time, each
-- with its own action, its own reason and its own audit trail. None of them is
-- a state a person can be created in, and offering them invited a record whose
-- history begins at its end.
--
-- Enforced here rather than by removing the dropdown, because a removed
-- dropdown is a hidden field, not a rule: a modified request could still send
-- 'terminated'. The screen stops asking AND the database stops accepting.
--
-- Existing employees are untouched. This governs creation only, so the retired
-- and resigned people already on record keep their status and their history.

create or replace function public.force_new_employee_active()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  -- Seeds, migrations and service-role imports run without a session and may
  -- legitimately create historical records in a terminal state.
  if (select auth.uid()) is null then
    return new;
  end if;

  if new.employment_status is distinct from 'active' then
    -- Corrected rather than refused. A request asking to create somebody
    -- already resigned is a confused request, not a hostile one, and the
    -- useful outcome is the employee existing correctly.
    new.employment_status := 'active';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_force_new_employee_active on public.employees;
create trigger trg_force_new_employee_active
  before insert on public.employees
  for each row execute function public.force_new_employee_active();

comment on function public.force_new_employee_active() is
  'A new employee is Active. Resigned, terminated and retired are lifecycle '
  'transitions that may only follow creation, never replace it.';
