-- Onboarding entitlements — database contract test.
--
-- Hosted testing found a POS Manager with an active employment record, a
-- working login and self-service, and no till. HR privilege had just been made
-- to follow the position automatically; POS had not, and they are the same
-- problem: position_system_roles already says what the job may reach.
--
-- POS differs in one way that matters. Access is granted AT A BRANCH, so there
-- is no such thing as a branchless cashier -- and guessing a branch would put
-- somebody on a till nobody assigned them to.
--
-- Also covers what the applicant now supplies once: a government ID that
-- follows them into employment, and the gender and nationality HR used to ask
-- for a second time.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/onboarding_entitlements_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

do $$
declare
  admin_id  uuid;
  hr_dept   uuid;
  ops_dept  uuid;
  cash_pos  uuid;
  mgr_pos   uuid;
  it_pos    uuid;
  branch_a  uuid;
  uid       uuid;
  emp       uuid;
  app       uuid;
  job       uuid;
  n         integer;
  txt       text;
  tag       text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  adult     date := (current_date - interval '18 years')::date;
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;

  select p.id, p.department_id into cash_pos, ops_dept
    from public.positions p
    join public.position_system_roles r on r.position_id = p.id and r.system='pos' and r.role_code='cashier'
   limit 1;
  select p.id into mgr_pos
    from public.positions p
    join public.position_system_roles r on r.position_id = p.id and r.system='pos' and r.role_code='manager'
   limit 1;
  select p.id, p.department_id into it_pos, hr_dept from public.positions p
   where not exists (select 1 from public.position_system_roles r where r.position_id = p.id)
   limit 1;

  if admin_id is null or branch_a is null or cash_pos is null or mgr_pos is null or it_pos is null then
    raise exception 'fixture: need an admin, a branch, a cashier position, a POS manager position and one unmapped position';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  -- ======================================================================
  -- 1. An application carries gender, nationality and a government ID
  -- ======================================================================
  insert into public.job_postings
    (department_id, position_id, description, requirements, employment_type,
     vacancies, status, posted_by, date_posted, closing_date)
  values (ops_dept, cash_pos, 'ZZ Onboarding ' || tag, 'r', 'regular', 1, 'open',
          admin_id, now(), current_date + 7)
  returning id into job;

  begin
    perform public.submit_job_application(
      job, 'ZZ', 'NoGender', 'zz.nog.' || tag || '@jmac-test.invalid', '0917',
      'Addr', 'resumes/' || tag || '.pdf', null, null, 'Cavite', 'Imus', 'B1',
      adult, 'government-ids/' || tag || '.pdf', null, 'Filipino');
    raise exception 'FAIL  1a an application was accepted with no gender';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1a gender is required';
  end;

  begin
    perform public.submit_job_application(
      job, 'ZZ', 'BadGender', 'zz.badg.' || tag || '@jmac-test.invalid', '0917',
      'Addr', 'resumes/' || tag || '2.pdf', null, null, 'Cavite', 'Imus', 'B1',
      adult, 'government-ids/' || tag || '2.pdf', 'Helicopter', 'Filipino');
    raise exception 'FAIL  1b an unrecognised gender was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1b only the values the employee record uses are accepted';
  end;

  begin
    perform public.submit_job_application(
      job, 'ZZ', 'NoNat', 'zz.non.' || tag || '@jmac-test.invalid', '0917',
      'Addr', 'resumes/' || tag || '3.pdf', null, null, 'Cavite', 'Imus', 'B1',
      adult, 'government-ids/' || tag || '3.pdf', 'Male', null);
    raise exception 'FAIL  1c an application was accepted with no nationality';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1c nationality is required';
  end;

  select application_id into app from public.submit_job_application(
    job, 'ZZ', 'Cashier ' || tag, 'zz.cash.' || tag || '@jmac-test.invalid',
    '09171234567', 'Blk 1', 'resumes/' || tag || '-cv.pdf', null, 'Mid',
    'Cavite', 'Imus', 'Barangay 1', adult,
    'government-ids/' || tag || '-id.pdf', 'Male', 'Filipino');

  select applicant_gender || '|' || applicant_nationality into txt
    from public.applications where id = app;
  if txt <> 'Male|Filipino' then
    raise exception 'FAIL  1d the snapshot recorded: %', txt;
  end if;
  raise notice 'PASS  1d both are recorded on the application snapshot';

  begin
    update public.applications set applicant_gender = 'Female' where id = app;
    raise exception 'FAIL  1e the submitted gender was editable';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  1e the submitted gender cannot be edited';
  end;

  -- ======================================================================
  -- 2. The government ID follows the person into employment
  -- ======================================================================
  insert into public.employees
    (first_name, last_name, email, department_id, position_id, hire_date,
     employment_status, application_id)
  values ('ZZ', 'Cashier ' || tag, 'zz.cash.' || tag || '@jmac-test.invalid',
          ops_dept, cash_pos, current_date, 'active', app)
  returning id into emp;

  select count(*) into n from public.employee_documents
   where employee_id = emp and document_type = 'Government ID';
  if n <> 1 then
    raise exception 'FAIL  2a the hired applicant has % government ID documents, expected 1', n;
  end if;
  raise notice 'PASS  2a the ID submitted with the application is already filed';

  -- It points at the object the applicant uploaded. Not a copy: two copies of
  -- somebody's ID is two things to secure and two to delete.
  select file_url into txt from public.employee_documents
   where employee_id = emp and document_type = 'Government ID';
  if txt <> 'government-ids/' || tag || '-id.pdf' then
    raise exception 'FAIL  2b the document points at: %', txt;
  end if;
  raise notice 'PASS  2b it references the original object rather than copying it';

  -- And it is not the resume.
  if txt like 'resumes/%' then
    raise exception 'FAIL  2c the resume was filed as the government ID';
  end if;
  raise notice 'PASS  2c the resume is not filed as proof of identity';

  -- HR may still add more documents; nothing here forbids a second one.
  insert into public.employee_documents (employee_id, document_type, file_url)
  values (emp, 'Government ID', 'employee-documents/' || tag || '-second.pdf');
  select count(*) into n from public.employee_documents where employee_id = emp;
  if n <> 2 then
    raise exception 'FAIL  2d a second document could not be added';
  end if;
  raise notice 'PASS  2d an additional ID may still be attached when needed';

  -- ======================================================================
  -- 3. POS access needs a branch, and refuses to invent one
  -- ======================================================================
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, email_change,
                          email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
          'authenticated', 'zz.pos.' || tag || '@jmac-test.invalid', crypt('x', gen_salt('bf')),
          now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
  returning id into uid;

  update public.profiles set employee_id = emp, role = 'employee', status = 'active'
   where id = uid;

  -- No deployment record yet, so no branch is known.
  select count(*) into n from public.pos_branch_assignments where profile_id = uid;
  if n <> 0 then
    raise exception 'FAIL  3a a POS assignment was created with no branch';
  end if;
  raise notice 'PASS  3a no deployment branch means no POS assignment -- none is invented';

  -- ======================================================================
  -- 4. Deployment supplies the branch, and access follows
  -- ======================================================================
  insert into public.deployment_records (application_id, branch_id, deployment_date)
  values (app, branch_a, current_date);

  select count(*) into n from public.pos_branch_assignments
   where profile_id = uid and status = 'active' and branch_id = branch_a;
  if n <> 1 then
    raise exception 'FAIL  4a deployment produced % active assignments, expected 1', n;
  end if;

  select pos_role::text into txt from public.pos_branch_assignments
   where profile_id = uid and status = 'active';
  if txt <> 'cashier' then
    raise exception 'FAIL  4b the assignment is for %, not the position held', txt;
  end if;
  raise notice 'PASS  4a-b deploying a cashier to a branch establishes cashier access there';

  -- ======================================================================
  -- 5. A promotion moves the assignment, and leaves exactly one
  -- ======================================================================
  update public.employees set position_id = mgr_pos where id = emp;

  select count(*) into n from public.pos_branch_assignments
   where profile_id = uid and status = 'active';
  if n <> 1 then
    raise exception 'FAIL  5a after promotion there are % active assignments, expected 1', n;
  end if;

  select pos_role::text into txt from public.pos_branch_assignments
   where profile_id = uid and status = 'active';
  if txt <> 'manager' then
    raise exception 'FAIL  5b the promoted assignment is still %', txt;
  end if;

  -- The old one is closed, not deleted: who could sell where, and when.
  select count(*) into n from public.pos_branch_assignments
   where profile_id = uid and status <> 'active';
  if n < 1 then
    raise exception 'FAIL  5c the previous assignment was discarded rather than closed';
  end if;
  raise notice 'PASS  5a-c promotion moves the assignment and keeps the history';

  -- ======================================================================
  -- 6. Moving off POS work removes it
  -- ======================================================================
  update public.employees set position_id = it_pos, department_id = hr_dept where id = emp;

  select count(*) into n from public.pos_branch_assignments
   where profile_id = uid and status = 'active';
  if n <> 0 then
    raise exception 'FAIL  6a POS access survived a move to a non-POS position';
  end if;

  -- Employment, and therefore self-service, is untouched.
  select count(*) into n from public.profiles pr join public.employees e on e.id = pr.employee_id
   where pr.id = uid and pr.status = 'active' and e.employment_status = 'active';
  if n <> 1 then
    raise exception 'FAIL  6b losing POS access disturbed the employment record';
  end if;
  raise notice 'PASS  6a-b moving off POS work revokes the till, not the job';

  -- ======================================================================
  -- 7. An Administrator's revocation is not undone by a transfer
  -- ======================================================================
  update public.employees set position_id = mgr_pos, department_id = ops_dept where id = emp;
  select count(*) into n from public.pos_branch_assignments
   where profile_id = uid and status = 'active';
  if n <> 1 then
    raise exception 'FAIL  7a moving back did not restore POS access';
  end if;

  -- Now a person decides otherwise.
  update public.pos_branch_assignments
     set status = 'inactive', revoked_reason = 'revoked by administrator'
   where profile_id = uid and status = 'active';

  -- The same sequence that restores a system closure.
  update public.employees set position_id = it_pos, department_id = hr_dept where id = emp;
  update public.employees set position_id = mgr_pos, department_id = ops_dept where id = emp;

  select count(*) into n from public.pos_branch_assignments
   where profile_id = uid and status = 'active';
  if n <> 0 then
    raise exception 'FAIL  7b a transfer undid an Administrator''s revocation';
  end if;
  raise notice 'PASS  7a-b a revoked till stays revoked, while a system closure is reversible';

  raise notice '--- all onboarding entitlement checks passed ---';
end $$;

rollback;

select 'pos assignments after rollback: ' || count(*)::text as verify
from public.pos_branch_assignments;
