-- Phase 9A follow-up: a closed POS assignment stays closed.
--
-- Found by the workforce contract suite, check 10a. The eligibility trigger
-- allowed an inactive row to be flipped back to 'active' whenever the holder
-- happened to be eligible again -- so the deliberate act of reactivating an old
-- row could return access that a transfer had taken away, which is precisely
-- what Phase 9A set out to prevent. The automatic path was already safe; this
-- closes the manual one.
--
-- This is not a new philosophy, it is the existing one enforced. From
-- 20260813000000: "Re-granting deliberately does not flip a revoked row back to
-- active: that would overwrite the only record that the access was ever taken
-- away. A second row costs nothing and keeps the sequence readable." The UI has
-- always created a new row to re-grant. Now the database requires it.
--
-- The audit consequence matters too: a resurrected row would read as having
-- been granted on its original date, quietly erasing the gap in between. A new
-- row records a new grant, on the day it happened, by the person who made it.

create or replace function public.pos_assignment_requires_eligibility()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  _why text;
begin
  -- A closed assignment is history. Re-granting means a new row.
  if tg_op = 'UPDATE' and old.status <> 'active' and new.status = 'active' then
    raise exception
      'POS_ASSIGNMENT_CLOSED: that assignment was closed%. Grant a new one instead.',
      case when old.revoked_reason = 'workforce_ineligible'
        then ' because the employee stopped being eligible'
        else '' end;
  end if;

  if new.status <> 'active' then
    return new;
  end if;

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

revoke all on function public.pos_assignment_requires_eligibility()
  from public, anon, authenticated, service_role;
