-- System Access at position creation, applied atomically with the approval.
--
-- Before this, eligibility could only be configured after a position existed,
-- through the System Access dialog. Creating "HR Staff" therefore meant two
-- steps, and between them the position existed with no entitlement. Worse, for
-- an HR Staff author the position went through change-request approval while
-- the entitlement did not -- so a rejected position could still have left an
-- entitlement row behind if the two were ever applied separately.
--
-- The rule this migration establishes: entitlements travel WITH the position
-- change and are written in the same transaction that writes the position.
-- Reject the request and nothing is written at all.
--
-- One validator, three callers. `assert_entitlement_allowed` is the single
-- place a role code is judged; `apply_position_system_access` is the single
-- place entitlements are written. The System Access dialog, direct creation,
-- and change-request approval all go through them, so none of the three can
-- drift into accepting something the others reject.

-- ---------------------------------------------------------------- validation
create or replace function public.assert_entitlement_allowed(
  _system public.entitlement_system,
  _role_code text
)
returns void
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  -- Named explicitly rather than left to the CHECK constraint, because these
  -- three are the ones somebody will reach for and the generic constraint
  -- error would not explain why they are refused.
  --
  -- 'admin' is an enterprise identity, not something a job title confers.
  -- 'employee' is the baseline every employee already has -- making it an
  -- entitlement would let a position "grant" what nobody can lack, and would
  -- turn the absence of a row from meaningful into ambiguous.
  if lower(coalesce(_role_code, '')) in ('admin', 'administrator', 'employee') then
    raise exception
      'ENTITLEMENT_NOT_GRANTABLE: % is not a grantable role. Administrator is an enterprise identity, and Employee Self-Service is the baseline every position already has.',
      _role_code;
  end if;

  if not (
       (_system = 'hrms' and _role_code in ('hr_manager', 'hr_staff'))
    or (_system = 'pos'  and _role_code in ('manager', 'cashier'))
    or (_system = 'fms'  and _role_code in ('finance_staff', 'finance_manager', 'accountant'))
  ) then
    raise exception 'ENTITLEMENT_INVALID_ROLE: % is not a role in the % system.', _role_code, _system;
  end if;
end;
$fn$;

comment on function public.assert_entitlement_allowed(public.entitlement_system, text) is
  'The single judgement of whether a (system, role_code) pair may be an entitlement. '
  'admin and employee are refused by name.';

-- ------------------------------------------------------------------- writing
-- `_access` is one role per system, keyed by system:
--   {"hrms": "hr_staff", "pos": null, "fms": null}
--
-- A key that is present replaces that system's entitlements for the position.
-- A key that is ABSENT is left alone, so a caller can set POS without
-- disturbing HRMS. Null clears the system.
--
-- One role per system is what the creation form offers. The System Access
-- dialog still writes per-role through set_position_entitlement, so a position
-- that legitimately needs two roles in one system can still be configured
-- there -- this function is not the only door, just the simple one.
create or replace function public.apply_position_system_access(
  _position_id uuid,
  _access jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _system text;
  _role text;
begin
  -- Deliberately NO authorization check here. This is the shared writer; every
  -- caller authorizes first, and it is never granted to an API role.
  if _access is null or jsonb_typeof(_access) <> 'object' then
    return;
  end if;

  if not exists (select 1 from public.positions where id = _position_id) then
    raise exception 'That position does not exist';
  end if;

  for _system in select jsonb_object_keys(_access) loop
    if _system not in ('hrms', 'pos', 'fms') then
      raise exception 'ENTITLEMENT_UNKNOWN_SYSTEM: % is not an enterprise system.', _system;
    end if;

    if jsonb_typeof(_access -> _system) not in ('string', 'null') then
      raise exception 'ENTITLEMENT_INVALID_SHAPE: % must be a single role name or null.', _system;
    end if;

    _role := _access ->> _system;

    -- Replace this system's entitlements for the position. Clearing first is
    -- what makes the call idempotent and keeps "one role per system" true.
    delete from public.position_system_roles
     where position_id = _position_id and system = _system::public.entitlement_system;

    if _role is not null and _role <> '' then
      perform public.assert_entitlement_allowed(_system::public.entitlement_system, _role);
      insert into public.position_system_roles (position_id, system, role_code, created_by)
      values (_position_id, _system::public.entitlement_system, _role, (select auth.uid()))
      on conflict (position_id, system, role_code) do nothing;
    end if;
  end loop;
end;
$fn$;

revoke all on function public.apply_position_system_access(uuid, jsonb) from public, anon, authenticated;

comment on function public.apply_position_system_access(uuid, jsonb) is
  'Shared entitlement writer. Internal: callers authorize first and it is granted to no API role.';

-- Route the existing per-role editor through the same validator, so the dialog
-- and the creation form cannot disagree about what is grantable.
create or replace function public.set_position_entitlement(
  _position_id uuid,
  _system public.entitlement_system,
  _role_code text,
  _granted boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an Administrator can change position eligibility';
  end if;
  if not exists (select 1 from public.positions where id = _position_id) then
    raise exception 'That position does not exist';
  end if;

  if _granted then
    perform public.assert_entitlement_allowed(_system, _role_code);
    insert into public.position_system_roles (position_id, system, role_code, created_by)
    values (_position_id, _system, _role_code, (select auth.uid()))
    on conflict (position_id, system, role_code) do nothing;
  else
    delete from public.position_system_roles
     where position_id = _position_id and system = _system and role_code = _role_code;
  end if;
end;
$fn$;

revoke all on function public.set_position_entitlement(
  uuid, public.entitlement_system, text, boolean) from public, anon;
grant execute on function public.set_position_entitlement(
  uuid, public.entitlement_system, text, boolean) to authenticated;

-- --------------------------------------------- carry access through approval
alter table public.change_requests
  add column if not exists system_access jsonb;

comment on column public.change_requests.system_access is
  'Proposed position eligibility, applied atomically when the request is approved. '
  'Null means the request does not touch eligibility.';

-- Reject a malformed proposal at submission rather than at approval, so a
-- reviewer is never shown a request that cannot be applied.
create or replace function public.validate_change_request_system_access()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  _system text;
  _role text;
begin
  if new.system_access is null then
    return new;
  end if;

  if new.target_table <> 'positions' then
    raise exception 'SYSTEM_ACCESS_NOT_APPLICABLE: only a position request can carry system access.';
  end if;
  if jsonb_typeof(new.system_access) <> 'object' then
    raise exception 'ENTITLEMENT_INVALID_SHAPE: system access must be an object.';
  end if;

  for _system in select jsonb_object_keys(new.system_access) loop
    if _system not in ('hrms', 'pos', 'fms') then
      raise exception 'ENTITLEMENT_UNKNOWN_SYSTEM: % is not an enterprise system.', _system;
    end if;
    if jsonb_typeof(new.system_access -> _system) not in ('string', 'null') then
      raise exception 'ENTITLEMENT_INVALID_SHAPE: % must be a single role name or null.', _system;
    end if;
    _role := new.system_access ->> _system;
    if _role is not null and _role <> '' then
      perform public.assert_entitlement_allowed(_system::public.entitlement_system, _role);
    end if;
  end loop;

  return new;
end;
$fn$;

drop trigger if exists trg_change_requests_validate_system_access on public.change_requests;
create trigger trg_change_requests_validate_system_access
  before insert or update on public.change_requests
  for each row execute function public.validate_change_request_system_access();

-- ------------------------------------------------------- atomic direct create
-- The direct path (Administrator or HR Manager). Position and entitlements in
-- one transaction, so the two-step window never exists.
create or replace function public.create_position_with_access(
  _title text,
  _department_id uuid,
  _description text,
  _access jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
begin
  -- Same gate the direct table write already had: reference data is written by
  -- an HR Manager or an Administrator, everyone else submits for approval.
  if not public.is_hr_manager_or_admin() then
    raise exception 'Only an HR Manager or Administrator can create a position directly.';
  end if;

  insert into public.positions (title, department_id, description)
  values (_title, _department_id, nullif(_description, ''))
  returning id into _id;

  perform public.apply_position_system_access(_id, _access);
  return _id;
end;
$fn$;

revoke all on function public.create_position_with_access(text, uuid, text, jsonb) from public, anon;
grant execute on function public.create_position_with_access(text, uuid, text, jsonb) to authenticated;
