-- ===========================================================================
-- F6A fix: the branches a settlement may name
-- ===========================================================================
--
-- The defect, found in hosted acceptance: an Accountant opening Record
-- settlement saw an empty Branch dropdown. Not a UI bug -- the builder asked
-- for branches through the generic HR/Admin hook, which reads public.branches
-- directly, and the policies on that table are:
--
--   branches_admin_manage   is_admin()
--   branches_staff_select   is_active_staff()  -- admin or HR staff/manager
--   branches_pos_select     has_pos_role(id, [manager, cashier])
--
-- None of which an Accountant satisfies. RLS was doing its job; the query had
-- no business being asked.
--
-- The wrong fix is to widen branches_staff_select to include Finance. That
-- table carries address, phone, coordinates and configuration, and a Finance
-- user filling in a settlement needs a name to pick from -- nothing else. So
-- this is a function that answers exactly the question being asked, and no
-- more of it.
--
-- Read-only by construction: a function returning two columns cannot be
-- written through, and no policy on branches changes here.

create or replace function public.get_settlement_branches()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select b.id, b.name
  from public.branches b
  -- The same Finance read authority F6 uses everywhere else: Finance Staff,
  -- Finance Manager, Accountant, plus Administrator oversight. One gate rather
  -- than a second opinion about who Finance is.
  where public.can_read_finance_master()
    and b.is_active
  order by b.name;
$fn$;

comment on function public.get_settlement_branches() is
  'Active branch names for Finance settlement forms. Two columns only -- no '
  'address, phone, coordinates or configuration -- and no write path. Exists '
  'because Finance cannot read public.branches directly, and should not.';

revoke all on function public.get_settlement_branches() from public, anon;
grant execute on function public.get_settlement_branches() to authenticated;
