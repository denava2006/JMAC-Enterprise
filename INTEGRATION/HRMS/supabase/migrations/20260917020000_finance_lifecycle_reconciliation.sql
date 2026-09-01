-- FMS F1 — finance access arrives with the job.
--
-- The same two lifecycle events that already establish HR privilege and POS
-- assignments now establish finance privilege too: linking an account to an
-- employee, and that employee's position changing. Adding a third call to the
-- existing triggers rather than adding a third pair of triggers, so the order
-- these run in stays visible in one place.
--
-- Sign-in is deliberately not on that list. Reconciling on every authorization
-- check would mean an Administrator's manual revoke undoing itself on the
-- revoked person's next page load.

create or replace function public.reconcile_hr_privilege_on_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.employee_id is not null
     and new.employee_id is distinct from coalesce(old.employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and new.status = 'active' then
    perform public.reconcile_hr_privilege(new.id);
    perform public.reconcile_pos_access(new.id);
    perform public.reconcile_finance_privilege(new.id);
  end if;
  return new;
end;
$fn$;

create or replace function public.reconcile_hr_privilege_on_transfer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _profile uuid;
begin
  if new.position_id is not distinct from old.position_id then
    return new;
  end if;

  select id into _profile from public.profiles where employee_id = new.id and status = 'active';
  if _profile is not null then
    -- Each is responsible for its own system, and each declines when the new
    -- position entitles nothing there. A move from Finance Staff to POS Manager
    -- closes one and opens the other without either knowing about the other.
    perform public.reconcile_hr_privilege(_profile);
    perform public.reconcile_pos_access(_profile);
    perform public.reconcile_finance_privilege(_profile);
  end if;
  return new;
end;
$fn$;
