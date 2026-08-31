-- profiles.role should default to 'employee', not 'hr_staff'.
--
-- Found while bootstrapping the production Administrator: the invited account
-- appeared as HR Staff, because handle_new_user writes only id, email and
-- full_name and the column defaults did the rest -- role 'hr_staff', status
-- 'inactive'.
--
-- Nothing was exploitable. Phase 9B denies such an account three times over:
-- the status is inactive, has_hr_privilege() requires an active row in
-- hr_privilege_grants, and eligibility requires a position conferring the role.
-- Verified live on the production Administrator: has_hr_privilege() returned
-- false while is_active_staff() was true purely through the is_admin()
-- short-circuit.
--
-- But 'hr_staff' is the wrong thing for an unclassified account to be, and it
-- only stays harmless while all three of those checks hold. A default should
-- be the least-privileged sensible value, so that relaxing any single check
-- later cannot turn a stranger into HR.
--
-- Status is deliberately left at 'inactive': that one IS the right default,
-- because an account nobody has provisioned should not be usable.
--
-- Existing rows are NOT touched. This changes what the next account defaults
-- to, nothing about the accounts that already exist -- the Administrator stays
-- an Administrator, and every provisioning path already sets the role
-- explicitly (create-employee-account writes 'employee';
-- grant_hr_privilege writes the HR role; close_hr_privilege writes 'employee').

alter table public.profiles alter column role set default 'employee';

comment on column public.profiles.role is
  'Enterprise identity. Defaults to the least-privileged value; every '
  'provisioning path sets it explicitly. It names the role but does not confer '
  'HR authority on its own -- see has_hr_privilege().';
