-- Phase 9A, part 1: what a job makes you eligible to hold.
--
-- The problem this closes, observed live: Jerome Castillo, department IT,
-- position IT Support, held POS **manager** at Cavite Branch. Nothing in the
-- database objected, because nothing in the authorization path had ever read
-- an employment record. `has_pos_role()` looked at the assignment row and
-- `profiles.status`, and that was all.
--
-- ---------------------------------------------------------------------------
-- THREE LAYERS, DELIBERATELY NOT COLLAPSED
--
--   profiles.role                    enterprise / HR identity
--   pos_branch_assignments.pos_role  the ACTUAL branch POS authorization
--   position_system_roles            ELIGIBILITY ONLY -- this table
--
-- This layer never grants anything. It decides who may be *given* something.
-- An employee with a Cashier position and no assignment has no POS access at
-- all; an employee with an assignment but the wrong position stops having it.
-- Both facts have to be true for anything to work.
--
-- Nothing here is added to profiles.role. There is no 'pos_manager' or
-- 'cashier' enterprise role, and there must not be: a job title is not an
-- authorization identity.
--
-- ---------------------------------------------------------------------------
-- WHY role_code IS text AND NOT AN ENUM
--
-- The three systems have three different role enums, and FMS's lives in a
-- different Supabase project entirely (verified read-only: its own user_role
-- enum of employee | finance_staff | finance_manager | accountant |
-- administrator, on its own profiles table). A single enum could not span
-- them. The CHECK constraint below gives the same safety an enum would --
-- a typo is rejected by the database -- while letting each system keep its own
-- vocabulary. Extending it is a forward migration, never a free-text edit.
--
-- Position TITLES are never compared. `positions.title = 'Cashier'` is not an
-- authorization test: titles are display data, they get renamed, and two
-- departments may legitimately use the same word.

create type public.entitlement_system as enum ('hrms', 'pos', 'fms');

create table public.position_system_roles (
  id uuid primary key default gen_random_uuid(),
  position_id uuid not null references public.positions(id) on delete cascade,
  system public.entitlement_system not null,
  role_code text not null,

  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One row per (position, system, role). A position may hold several roles in
  -- one system, but only where an Administrator has configured each one
  -- explicitly -- there is no implicit "manager implies cashier".
  unique (position_id, system, role_code),

  -- Stable configuration, validated by the database.
  --
  -- 'admin' is absent on purpose: the enterprise Administrator is an exception
  -- that must never be reachable by holding a job.
  -- 'employee' is absent on purpose: Employee Self-Service is the baseline and
  -- needs no entitlement.
  -- The fms codes are reserved so Phase 9C has somewhere to write; Phase 9A
  -- enforces POS only.
  constraint position_system_roles_valid_code check (
       (system = 'hrms' and role_code in ('hr_manager', 'hr_staff'))
    or (system = 'pos'  and role_code in ('manager', 'cashier'))
    or (system = 'fms'  and role_code in ('finance_staff', 'finance_manager', 'accountant'))
  )
);

comment on table public.position_system_roles is
  'Which system roles a job position makes an employee ELIGIBLE to hold. '
  'Eligibility only -- the actual authorization stays in profiles.role, '
  'pos_branch_assignments.pos_role and (later) FMS. Phase 9A enforces the '
  'pos rows at runtime; hrms and fms rows are configuration for later phases.';

create index position_system_roles_position_idx
  on public.position_system_roles (position_id, system);
create index position_system_roles_lookup_idx
  on public.position_system_roles (system, role_code, position_id);

create trigger trg_position_system_roles_updated_at
  before update on public.position_system_roles
  for each row execute function public.set_updated_at();

-- Configuration is an Administrator's, like the positions it hangs off.
-- Reading it is open to active staff, who need it to understand why a person
-- is or is not offered in the assignment picker.
alter table public.position_system_roles enable row level security;

create policy position_system_roles_admin_manage on public.position_system_roles
  for all using (public.is_admin()) with check (public.is_admin());
create policy position_system_roles_staff_select on public.position_system_roles
  for select using (public.is_active_staff());

-- ACL incident 6: RLS never filters TRUNCATE. 20260826030000 fixed the default
-- privileges, but state it locally so the intent is greppable from this file.
revoke truncate, delete on table public.position_system_roles from anon, authenticated;
