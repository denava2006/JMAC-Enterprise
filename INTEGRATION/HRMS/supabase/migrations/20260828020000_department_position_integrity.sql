-- Phase 9A, part 3: a position must belong to the department it is filed under.
--
-- `employees` and `job_postings` each carry department_id and position_id as
-- two INDEPENDENT foreign keys. Nothing connected them, so
--
--     department = IT, position = Cashier
--
-- was accepted by the database. Only React prevented it, by filtering the
-- position list to the chosen department (CreateEmployeePage.tsx). Anything
-- reaching PostgREST directly bypassed that entirely.
--
-- A CHECK constraint cannot do the cross-table lookup, so this is a trigger.
--
-- Checked before writing: zero existing violations across 5 employees and
-- 3 job postings, and every position has a non-null department_id. So this
-- goes on without a remediation pass.
--
-- Null semantics are preserved deliberately: the schema allows an employee or
-- a posting with no position yet (a draft posting, an employee mid-setup), and
-- this only fires when BOTH sides are present. It does not invent a
-- requirement the schema never had.

create or replace function public.enforce_position_department_pairing()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  _position_department uuid;
  _position_title text;
  _department_name text;
begin
  if new.position_id is null or new.department_id is null then
    return new;
  end if;

  -- Unchanged rows are not re-validated: an UPDATE that touches neither column
  -- should not fail because of data that predates this rule.
  if tg_op = 'UPDATE'
     and new.position_id is not distinct from old.position_id
     and new.department_id is not distinct from old.department_id then
    return new;
  end if;

  select p.department_id, p.title into _position_department, _position_title
  from public.positions p where p.id = new.position_id;

  if _position_department is distinct from new.department_id then
    select d.name into _department_name from public.departments d where d.id = new.department_id;
    raise exception
      'POSITION_DEPARTMENT_MISMATCH: % is not a position in %',
      coalesce(_position_title, 'that position'),
      coalesce(_department_name, 'that department');
  end if;

  return new;
end;
$fn$;

create trigger trg_employees_position_department_pairing
  before insert or update on public.employees
  for each row execute function public.enforce_position_department_pairing();

create trigger trg_job_postings_position_department_pairing
  before insert or update on public.job_postings
  for each row execute function public.enforce_position_department_pairing();

-- The pairing must also hold from the other direction: moving a position to a
-- different department would silently invalidate every employee filed under it.
-- Rather than cascading a change nobody asked for, refuse it while anyone is
-- still in that position -- the HR action is to move the people first.
create or replace function public.guard_position_department_move()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  _holders integer;
begin
  if new.department_id is not distinct from old.department_id then
    return new;
  end if;

  select count(*) into _holders from public.employees e where e.position_id = new.id;
  if _holders > 0 then
    raise exception
      'POSITION_DEPARTMENT_IN_USE: % employee(s) hold this position; move them before moving the position',
      _holders;
  end if;

  return new;
end;
$fn$;

create trigger trg_positions_department_move
  before update on public.positions
  for each row execute function public.guard_position_department_move();

revoke all on function public.enforce_position_department_pairing() from public, anon, authenticated, service_role;
revoke all on function public.guard_position_department_move() from public, anon, authenticated, service_role;
