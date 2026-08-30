-- Phase 9A, part 2: the organisational structure the entitlements hang off.
--
-- The approved design:
--
--   Human Resources          Store Operations          IT
--   ├── HR Manager           ├── POS Manager           └── IT Support
--   └── HR Staff             └── Cashier
--
-- Before this migration the live org could not express the rules at all:
-- there was no Store Operations department, no POS Manager position and no
-- HR Manager position, so nobody could legitimately hold pos:manager or
-- hrms:hr_manager. The existing Sales department already had a Cashier
-- position, but Store Operations is where till work belongs.
--
-- Everything here is idempotent (`on conflict do nothing` / guarded inserts),
-- because this runs against a local database and a production database whose
-- reference data may already differ.
--
-- Nothing here touches an employee. Moving a real person into a new department
-- to make their existing assignment valid would be rewriting history to suit
-- the rules, which is exactly backwards -- see 20260828050000.

-- ------------------------------------------------------------- departments

insert into public.departments (name, description)
select 'Store Operations', 'Branch trading: tills, stock and the sales floor.'
where not exists (select 1 from public.departments where lower(name) = 'store operations');

-- ---------------------------------------------------------------- positions

do $$
declare
  _store_ops uuid;
  _hr uuid;
begin
  select id into _store_ops from public.departments where lower(name) = 'store operations';
  select id into _hr from public.departments where lower(name) = 'human resources';

  if _store_ops is not null then
    insert into public.positions (title, department_id, description)
    select 'POS Manager', _store_ops,
           'Runs a branch: stock, catalogue, transactions, reports and requests.'
    where not exists (
      select 1 from public.positions
       where department_id = _store_ops and lower(title) = 'pos manager');

    insert into public.positions (title, department_id, description)
    select 'Cashier', _store_ops, 'Works a till and looks up their own sales.'
    where not exists (
      select 1 from public.positions
       where department_id = _store_ops and lower(title) = 'cashier');
  end if;

  -- HR Manager had no position, so the existing hr_manager account could never
  -- be made compliant. Phase 9B does that linkage; the position has to exist
  -- first.
  if _hr is not null then
    insert into public.positions (title, department_id, description)
    select 'HR Manager', _hr, 'Approves reference-data changes and owns HR operations.'
    where not exists (
      select 1 from public.positions
       where department_id = _hr and lower(title) = 'hr manager');
  end if;
end $$;

-- ------------------------------------------------------------ entitlements
--
-- Exactly the approved mapping, and nothing else. Every position not named
-- here is eligible for nothing, which is the point: IT Support, Sales
-- Associate, Cleaner and the Sales-department Cashier all grant no POS role.
--
-- The Sales/Cashier position is deliberately NOT granted pos:cashier. Till work
-- belongs to Store Operations under the approved structure, and granting it
-- here purely because the word matches would be title-based authorization
-- wearing a different hat.

do $$
declare
  _store_ops uuid;
  _hr uuid;
  _pos_manager uuid;
  _cashier uuid;
  _hr_manager uuid;
  _hr_staff uuid;
begin
  select id into _store_ops from public.departments where lower(name) = 'store operations';
  select id into _hr from public.departments where lower(name) = 'human resources';

  select id into _pos_manager from public.positions
   where department_id = _store_ops and lower(title) = 'pos manager';
  select id into _cashier from public.positions
   where department_id = _store_ops and lower(title) = 'cashier';
  select id into _hr_manager from public.positions
   where department_id = _hr and lower(title) = 'hr manager';
  select id into _hr_staff from public.positions
   where department_id = _hr and lower(title) = 'hr staff';

  if _pos_manager is not null then
    insert into public.position_system_roles (position_id, system, role_code)
    values (_pos_manager, 'pos', 'manager')
    on conflict (position_id, system, role_code) do nothing;
  end if;

  if _cashier is not null then
    insert into public.position_system_roles (position_id, system, role_code)
    values (_cashier, 'pos', 'cashier')
    on conflict (position_id, system, role_code) do nothing;
  end if;

  -- Configured now, enforced in Phase 9B. Writing them here means the model is
  -- complete and inspectable; Phase 9A's runtime checks read only the pos rows.
  if _hr_manager is not null then
    insert into public.position_system_roles (position_id, system, role_code)
    values (_hr_manager, 'hrms', 'hr_manager')
    on conflict (position_id, system, role_code) do nothing;
  end if;

  if _hr_staff is not null then
    insert into public.position_system_roles (position_id, system, role_code)
    values (_hr_staff, 'hrms', 'hr_staff')
    on conflict (position_id, system, role_code) do nothing;
  end if;
end $$;
