-- Local/demo seed data. Runs automatically on `supabase db reset` (and once
-- after the very first `supabase start`) — never against the remote project.
--
-- Gives a fresh checkout a working login and enough reference data to explore
-- the app immediately, without pre-filling employees/attendance/payroll —
-- those are much better shown live during a demo than faked in advance.

-- ---- Admin login (admin@suite.com / Admin123) ----
-- handle_new_user() auto-creates a matching `profiles` row for every new
-- auth.users insert (defaulting role/status), so this seeds the auth user
-- first and then promotes that row to an active admin.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, last_sign_in_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000001',
  'authenticated', 'authenticated',
  'admin@suite.com',
  crypt('Admin123', gen_salt('bf')),
  now(), now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Administrator"}',
  now(), now(),
  '', '', '', ''
);

-- trg_protect_admin_accounts deliberately blocks ever promoting a row to
-- role='admin' via UPDATE (privilege-escalation guard) -- there is no
-- legitimate app-level path to create the very first admin, so bootstrapping
-- one here means briefly stepping around that guard on purpose.
alter table public.profiles disable trigger trg_protect_admin_accounts;
update public.profiles
set full_name = 'Administrator', role = 'admin', status = 'active'
where id = 'a0000000-0000-0000-0000-000000000001';
alter table public.profiles enable trigger trg_protect_admin_accounts;

-- ---- HR Manager + HR Staff logins, so the approval hand-off is demoable ----
-- (manager@suite.com / HrManager123, staff@suite.com / HrStaff123)
-- HR Staff generates payroll and files leave requests; only the HR Manager can
-- review/release payroll or approve/reject leave. Unlike the admin bootstrap
-- above, no trigger has to be stepped around -- protect_admin_accounts() only
-- guards the 'admin' role.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, last_sign_in_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated',
    'manager@suite.com',
    crypt('HrManager123', gen_salt('bf')),
    now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Maria Manager"}',
    now(), now(),
    '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000003',
    'authenticated', 'authenticated',
    'staff@suite.com',
    crypt('HrStaff123', gen_salt('bf')),
    now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Sam Staff"}',
    now(), now(),
    '', '', '', ''
  );

update public.profiles
set full_name = 'Maria Manager', role = 'hr_manager', status = 'active'
where id = 'a0000000-0000-0000-0000-000000000002';

update public.profiles
set full_name = 'Sam Staff', role = 'hr_staff', status = 'active'
where id = 'a0000000-0000-0000-0000-000000000003';

-- ---- Reference data: departments, positions, salary grades ----
insert into public.departments (id, name, description)
select v.id, v.name, v.description
from (values
  ('d0000000-0000-0000-0000-000000000001'::uuid, 'Human Resources', 'People operations, recruitment, and employee relations'),
  ('d0000000-0000-0000-0000-000000000002'::uuid, 'Sales', 'Customer-facing sales and account management'),
  ('d0000000-0000-0000-0000-000000000003'::uuid, 'IT', 'Engineering and technical support'),
  ('d0000000-0000-0000-0000-000000000004'::uuid, 'Maintenance', 'Facilities and equipment maintenance')
) as v(id, name, description)
where not exists (select 1 from public.departments d where lower(d.name) = lower(v.name))
on conflict (id) do nothing;

-- Resolved by department NAME, so a position lands in the migration-created
-- department when one already exists rather than pointing at an id that was
-- never inserted.
insert into public.positions (id, title, department_id, description)
select v.id, v.title, d.id, v.description
from (values
  ('e0000000-0000-0000-0000-000000000001'::uuid, 'HR Staff', 'Human Resources', 'Handles recruitment, onboarding, and employee records'),
  ('e0000000-0000-0000-0000-000000000002'::uuid, 'Sales Associate', 'Sales', 'Front-line sales representative'),
  ('e0000000-0000-0000-0000-000000000003'::uuid, 'Cashier', 'Sales', 'Point-of-sale and transaction handling'),
  ('e0000000-0000-0000-0000-000000000004'::uuid, 'IT Support', 'IT', 'Technical support and systems maintenance'),
  ('e0000000-0000-0000-0000-000000000005'::uuid, 'Cleaner', 'Maintenance', 'General facilities upkeep')
) as v(id, title, department, description)
join public.departments d on lower(d.name) = lower(v.department)
where not exists (select 1 from public.positions p where lower(p.title) = lower(v.title))
on conflict (id) do nothing;

-- Bands must not overlap (salary_grades_no_overlap), and bounds are
-- inclusive, so each band stops just short of the next one's floor.
insert into public.salary_grades (id, grade_name, min_salary, max_salary) values
  ('f0000000-0000-0000-0000-000000000001', 'Grade 1', 15000, 19999.99),
  ('f0000000-0000-0000-0000-000000000002', 'Grade 2', 20000, 27999.99),
  ('f0000000-0000-0000-0000-000000000003', 'Grade 3', 28000, 40000)
on conflict (id) do nothing;

-- ---- Staff accounts, employees and POS reference data ----
--
-- The database contract suites in supabase/tests need an admin, HR manager, HR
-- staff, a couple of ordinary employee accounts, two branches and a product
-- category to work with. Those used to exist only as accumulated local state,
-- so a fresh `supabase db reset` produced a database where fourteen suites
-- could not run at all -- they bail with 'fixture: need ...'. Seeding them here
-- makes the whole suite reproducible from a clean checkout.
--
-- (worker1@suite.com / worker2@suite.com / worker3@suite.com, Worker123)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, last_sign_in_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
select
  '00000000-0000-0000-0000-000000000000',
  v.id, 'authenticated', 'authenticated', v.email,
  crypt('Worker123', gen_salt('bf')),
  now(), now(),
  '{"provider":"email","providers":["email"]}',
  jsonb_build_object('full_name', v.full_name),
  now(), now(), '', '', '', ''
from (values
  ('a0000000-0000-0000-0000-000000000004'::uuid, 'worker1@suite.com', 'Wendy Worker'),
  ('a0000000-0000-0000-0000-000000000005'::uuid, 'worker2@suite.com', 'Walter Worker'),
  ('a0000000-0000-0000-0000-000000000006'::uuid, 'worker3@suite.com', 'Wanda Worker')
) as v(id, email, full_name)
where not exists (select 1 from auth.users u where u.id = v.id);

update public.profiles p
set full_name = v.full_name, role = 'employee', status = 'active'
from (values
  ('a0000000-0000-0000-0000-000000000004'::uuid, 'Wendy Worker'),
  ('a0000000-0000-0000-0000-000000000005'::uuid, 'Walter Worker'),
  ('a0000000-0000-0000-0000-000000000006'::uuid, 'Wanda Worker')
) as v(id, full_name)
where p.id = v.id;

-- Employee records for the first two, linked to their accounts. Created active,
-- which is the only state a new employee has (force_new_employee_active()).
insert into public.employees (
  id, first_name, last_name, email, department_id, position_id,
  employment_type, employment_status, hire_date)
select v.id, v.first_name, v.last_name, v.email, d.id, pos.id,
       'regular', 'active', current_date - 90
from (values
  ('c0000000-0000-0000-0000-000000000001'::uuid, 'Wendy', 'Worker', 'worker1@suite.com', 'Cashier'),
  ('c0000000-0000-0000-0000-000000000002'::uuid, 'Walter', 'Worker', 'worker2@suite.com', 'Sales Associate'),
  -- HR privilege is only ever granted to somebody whose POSITION allows it, so
  -- the HR accounts need real employee records sitting in HR positions.
  ('c0000000-0000-0000-0000-000000000003'::uuid, 'Maria', 'Manager', 'manager@suite.com', 'HR Manager'),
  ('c0000000-0000-0000-0000-000000000004'::uuid, 'Sam', 'Staff', 'staff@suite.com', 'HR Staff')
) as v(id, first_name, last_name, email, position_title)
join public.positions pos on lower(pos.title) = lower(v.position_title)
join public.departments d on d.id = pos.department_id
where not exists (select 1 from public.employees e where e.email = v.email);

update public.profiles p
set employee_id = e.id
from public.employees e
where lower(e.email) = lower(
        (select u.email from auth.users u where u.id = p.id))
  and p.employee_id is null;

-- The default catalogue category every POS suite expects to find.
insert into public.pos_product_categories (name, description, sort_order)
select 'General', 'Default catalogue category.', 0
where not exists (
  select 1 from public.pos_product_categories c where lower(c.name) = 'general');

-- One open job posting, so the recruitment suites have something to apply to.
insert into public.job_postings (
  department_id, position_id, description, requirements,
  employment_type, vacancies, status, posted_by, date_posted, closing_date)
select d.id, pos.id,
       'Seed posting for local development and the recruitment contract tests.',
       'None.', 'regular', 1, 'open',
       'a0000000-0000-0000-0000-000000000001', now(), current_date + 30
from public.positions pos
join public.departments d on d.id = pos.department_id
where lower(pos.title) = 'cashier'
  and not exists (select 1 from public.job_postings j where j.status = 'open');

-- ---- HR access ----
--
-- The position makes somebody ELIGIBLE; an explicit, auditable grant is what
-- actually gives access, and one is never implied by the other. Both HR
-- accounts therefore need a grant row before has_hr_privilege() will say yes --
-- without one they can sign in and see nothing, which is what a fresh reset
-- produced and why the notification suite could not read delivery state.
insert into public.hr_privilege_grants (profile_id, hr_role, status, granted_by, granted_at)
select p.id, p.role::text, 'active', 'a0000000-0000-0000-0000-000000000001', now()
from public.profiles p
where p.role::text in ('hr_manager', 'hr_staff')
  and p.status = 'active'
  and not exists (
    select 1 from public.hr_privilege_grants g
    where g.profile_id = p.id and g.status = 'active');
