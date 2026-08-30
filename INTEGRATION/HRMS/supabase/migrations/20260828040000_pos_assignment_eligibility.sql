-- Phase 9A, part 5: eligibility enforced on the write, on the read, and on the
-- transfer.
--
-- Three independent gates, because each covers a case the others cannot:
--
--   WRITE     a trigger on pos_branch_assignments. Stops an ineligible grant
--             being created at all, including straight through PostgREST with
--             no UI involved.
--
--   READ      has_pos_role() and my_pos_assignments() re-check eligibility on
--             every call. An assignment row that was valid when it was made
--             stops authorizing the moment the employee moves.
--
--   TRANSFER  a trigger on employees revokes incompatible assignments when the
--             position, department or employment status changes -- so the
--             history says what happened, rather than leaving a live-looking
--             row that silently does nothing.

-- Why an assignment was closed. Needed so the audit trail can distinguish "an
-- Administrator revoked this" from "the workforce record made it invalid",
-- without inventing a fake actor for the second case.
alter table public.pos_branch_assignments
  add column if not exists revoked_reason text;

comment on column public.pos_branch_assignments.revoked_reason is
  'Null for a human revocation. Set by the workforce trigger when a transfer, '
  'department change or employment change made the assignment ineligible.';

-- ------------------------------------------------------------- 1. the write

create or replace function public.pos_assignment_requires_eligibility()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  _why text;
begin
  -- Only an ACTIVE assignment needs to be justified. Deactivating one, or
  -- writing history, is always allowed.
  if new.status <> 'active' then
    return new;
  end if;

  -- An UPDATE that leaves an already-active row active and unchanged in the
  -- fields that matter is not a new grant.
  if tg_op = 'UPDATE'
     and old.status = 'active'
     and new.profile_id is not distinct from old.profile_id
     and new.branch_id is not distinct from old.branch_id
     and new.pos_role is not distinct from old.pos_role then
    return new;
  end if;

  if not public.is_eligible_for_system_role(new.profile_id, 'pos', new.pos_role::text) then
    _why := public.describe_pos_ineligibility(new.profile_id, new.pos_role::text);
    raise exception 'POS_ASSIGNMENT_NOT_ELIGIBLE: %',
      coalesce(_why, 'That employee is not eligible for this POS role.');
  end if;

  return new;
end;
$fn$;

-- BEFORE the actor stamp so a rejected grant never reaches the audit trail.
create trigger trg_pos_assignment_requires_eligibility
  before insert or update on public.pos_branch_assignments
  for each row execute function public.pos_assignment_requires_eligibility();

revoke all on function public.pos_assignment_requires_eligibility()
  from public, anon, authenticated, service_role;

-- --------------------------------------------------------------- 2. the read
--
-- The central change of Phase 9A. Every POS RPC in the system routes through
-- has_pos_role(), so adding the eligibility test here makes the whole POS
-- surface fail closed at once: dashboard, till, stock, categories,
-- transactions, reports, audit and requests.
--
-- is_admin() still short-circuits, unchanged. An Administrator's authority has
-- never come from an assignment and does not now.
create or replace function public.has_pos_role(
  _branch_id uuid,
  _roles public.pos_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1
    from public.pos_branch_assignments a
    join public.profiles p on p.id = a.profile_id
    where a.profile_id = (select auth.uid())
      and a.status = 'active'
      and p.status = 'active'
      and a.pos_role = any(_roles)
      and (_branch_id is null or a.branch_id = _branch_id)
      -- Phase 9A: the grant is not enough. The holder must still be somebody
      -- whose job makes them eligible for the role they were granted.
      and public.is_eligible_for_system_role(a.profile_id, 'pos', a.pos_role::text)
  );
$$;

revoke all on function public.has_pos_role(uuid, public.pos_role[]) from public, anon;
grant execute on function public.has_pos_role(uuid, public.pos_role[]) to authenticated;

-- The client's view of its own access, filtered the same way, so navigation
-- and the portal landing fail closed too rather than offering doors that no
-- longer open.
create or replace function public.my_pos_assignments()
returns table (branch_id uuid, pos_role public.pos_role)
language sql
stable
security definer
set search_path = ''
as $$
  select a.branch_id, a.pos_role
  from public.pos_branch_assignments a
  join public.profiles p on p.id = a.profile_id
  where a.profile_id = (select auth.uid())
    and a.status = 'active'
    and p.status = 'active'
    and public.is_eligible_for_system_role(a.profile_id, 'pos', a.pos_role::text);
$$;

revoke all on function public.my_pos_assignments() from public, anon;
grant execute on function public.my_pos_assignments() to authenticated;

-- Same for has_pos_access(), which gates the portal itself.
create or replace function public.has_pos_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1
    from public.pos_branch_assignments a
    join public.profiles p on p.id = a.profile_id
    where a.profile_id = (select auth.uid())
      and a.status = 'active'
      and p.status = 'active'
      and public.is_eligible_for_system_role(a.profile_id, 'pos', a.pos_role::text)
  );
$$;

revoke all on function public.has_pos_access() from public, anon;
grant execute on function public.has_pos_access() to authenticated;

-- ----------------------------------------------------------- 3. the transfer
--
-- When somebody's job changes, their POS assignments are re-evaluated and any
-- that no longer hold are closed. This is what makes
--
--     Cashier -> transferred to IT  =>  POS access gone
--
-- true in the data and not merely in the read path.
--
-- The row is set to 'inactive' with a revoked_reason, never deleted: the
-- history of who had what, and why it ended, is the whole point of an audit
-- trail.
--
-- Critically, a move BACK to an eligible position does not resurrect anything.
-- Nothing in this function ever sets status to 'active'. Restoring access
-- requires an Administrator to grant a new assignment, which is a deliberate
-- security requirement rather than an oversight -- silently returning old
-- access to somebody who has been elsewhere is exactly the failure mode this
-- phase exists to close.
create or replace function public.revoke_ineligible_pos_assignments()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  _profile_id uuid;
  _row record;
begin
  if new.position_id is not distinct from old.position_id
     and new.department_id is not distinct from old.department_id
     and new.employment_status is not distinct from old.employment_status then
    return new;
  end if;

  select id into _profile_id from public.profiles where employee_id = new.id;
  if _profile_id is null then
    return new;
  end if;

  for _row in
    select a.id, a.pos_role
    from public.pos_branch_assignments a
    where a.profile_id = _profile_id and a.status = 'active'
  loop
    if not public.is_eligible_for_system_role(_profile_id, 'pos', _row.pos_role::text) then
      update public.pos_branch_assignments
         set status = 'inactive',
             revoked_reason = 'workforce_ineligible'
       where id = _row.id and status = 'active';
    end if;
  end loop;

  return new;
end;
$fn$;

-- AFTER, so the employee row is already updated when eligibility is evaluated.
create trigger trg_employees_revoke_ineligible_pos
  after update on public.employees
  for each row execute function public.revoke_ineligible_pos_assignments();

revoke all on function public.revoke_ineligible_pos_assignments()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------ truthful audit copy
--
-- The Phase 7C assignment trigger already emits assignment_revoked on any
-- active -> inactive transition, so an automatic revocation is recorded without
-- a new event type. What it could not say is WHY. It now reads revoked_reason,
-- which the workforce trigger sets and a human revocation leaves null.
--
-- No fake actor is invented. auth.uid() remains whoever made the employment
-- change -- truthfully, they caused it -- and when there is no authenticated
-- actor at all (a migration, a fixture) pos_audit_write skips the event, as it
-- has since Phase 7C.
create or replace function public.pos_audit_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _target text;
begin
  select coalesce(nullif(btrim(p.full_name), ''), 'Unknown') into _target
  from public.profiles p where p.id = new.profile_id;

  if tg_op = 'INSERT' and new.status = 'active' then
    perform public.pos_audit_write(
      'assignment_granted', 'branch_assignment', new.id, new.branch_id, _target,
      'POS access granted', null, new.pos_role::text);
  elsif tg_op = 'UPDATE' and old.status = 'active' and new.status <> 'active' then
    perform public.pos_audit_write(
      'assignment_revoked', 'branch_assignment', new.id, new.branch_id, _target,
      case when new.revoked_reason = 'workforce_ineligible'
        then 'POS access closed automatically: the employee is no longer eligible for this role'
        else 'POS access revoked' end,
      old.pos_role::text, null);
  end if;
  return null;
end;
$fn$;

revoke all on function public.pos_audit_assignment()
  from public, anon, authenticated, service_role;
