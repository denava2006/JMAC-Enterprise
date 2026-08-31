-- Complete the workforce entitlement registry for HRMS.
--
-- Phase 9A seeded Store Operations outright but added HR positions only when a
-- Human Resources department already existed:
--
--   if _hr is not null then ... insert 'HR Manager' ...
--
-- Locally that held, so HR Staff and HR Manager already carry their hrms
-- entitlements. Production has no Human Resources department at all, so the
-- guard did nothing and neither position exists there. This migration closes
-- that gap the same way Phase 9A closed the POS one: create the department when
-- it is missing, then the two positions, then the entitlements.
--
-- Every step is idempotent and matches on lower(name)/lower(title), so a
-- database that already has "Human Resources" -- or "human resources" -- gains
-- nothing but the missing rows.
--
-- What this migration deliberately does NOT do: change how HR authorization is
-- decided. is_active_staff() and is_hr_manager_or_admin() still read
-- profiles.role. This makes HR eligibility *configurable*; enforcing it at
-- runtime is Phase 9B and needs the account-linkage work. Doing it here would
-- sign out every existing HR account the moment it shipped.

do $$
declare
  _hr uuid;
  _staff uuid;
  _manager uuid;
begin
  select id into _hr from public.departments where lower(name) = 'human resources' limit 1;

  if _hr is null then
    insert into public.departments (name, description)
    values ('Human Resources', 'Owns workforce records, recruitment, and HR operations.')
    returning id into _hr;
  end if;

  -- Positions. A position must belong to its own department -- the Phase 9A
  -- pairing trigger enforces that for employees, and eligibility requires it.
  select id into _staff
    from public.positions where department_id = _hr and lower(title) = 'hr staff' limit 1;
  if _staff is null then
    insert into public.positions (title, department_id, description)
    values ('HR Staff', _hr, 'Maintains employee records and day-to-day HR workflows.')
    returning id into _staff;
  end if;

  select id into _manager
    from public.positions where department_id = _hr and lower(title) = 'hr manager' limit 1;
  if _manager is null then
    insert into public.positions (title, department_id, description)
    values ('HR Manager', _hr, 'Approves reference-data changes and owns HR operations.')
    returning id into _manager;
  end if;

  -- Entitlements. Eligibility only: holding the position makes an account
  -- *permitted* to carry the role, never granted it.
  insert into public.position_system_roles (position_id, system, role_code)
  values (_staff, 'hrms', 'hr_staff')
  on conflict (position_id, system, role_code) do nothing;

  insert into public.position_system_roles (position_id, system, role_code)
  values (_manager, 'hrms', 'hr_manager')
  on conflict (position_id, system, role_code) do nothing;
end $$;

-- No entitlement is written for any other position. IT Support, Cleaner, Sales
-- Associate and the Sales-department Cashier stay deliberately empty: an
-- absent row is what "Employee Self-Service only" means, and 'employee' is
-- never itself an entitlement.
