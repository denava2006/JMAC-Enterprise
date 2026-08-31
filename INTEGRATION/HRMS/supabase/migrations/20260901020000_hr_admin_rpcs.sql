-- The Administrator's controls for HR privilege.
--
-- Candidate selection happens here, not in React. A list filtered in the
-- browser is a list that can be unfiltered in the browser, and the grant path
-- must refuse anything these would not have offered anyway -- which it does,
-- because the trigger re-checks eligibility whatever the client sends.

-- Who could be given an HR role: employees whose position confers one and who
-- do not already hold a live grant. Identity and org placement only -- no
-- salary, no personal data. An account may or may not exist yet; both cases
-- are offered, because provisioning handles each.
create or replace function public.get_hr_account_candidates(_hr_role text default null)
returns table (
  employee_id uuid,
  profile_id uuid,
  full_name text,
  email text,
  employee_number text,
  department_name text,
  position_title text,
  eligible_roles text[],
  has_account boolean,
  account_role text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    e.id,
    pr.id,
    coalesce(pr.full_name, e.first_name || ' ' || e.last_name),
    e.email,
    e.employee_number,
    d.name,
    pos.title,
    array_agg(psr.role_code order by psr.role_code),
    (pr.id is not null),
    pr.role::text
  from public.employees e
  join public.departments d on d.id = e.department_id
  join public.positions pos on pos.id = e.position_id and pos.department_id = e.department_id
  join public.position_system_roles psr
    on psr.position_id = pos.id and psr.system = 'hrms'
  left join public.profiles pr on pr.employee_id = e.id
  where public.is_admin()
    and public.employment_permits_operational_work(e.employment_status)
    and (_hr_role is null or psr.role_code = _hr_role)
    -- Somebody already holding a live grant is not a candidate for another.
    and not exists (
      select 1 from public.hr_privilege_grants g
      join public.profiles p2 on p2.id = g.profile_id
      where p2.employee_id = e.id and g.status = 'active')
  group by e.id, pr.id, pr.full_name, e.first_name, e.last_name, e.email,
           e.employee_number, d.name, pos.title, pr.role
  order by d.name, pos.title, e.last_name;
$fn$;

revoke all on function public.get_hr_account_candidates(text) from public, anon;
grant execute on function public.get_hr_account_candidates(text) to authenticated;

-- The HR Accounts screen: every account that holds or held HR privilege, with
-- the workforce facts that decide whether it still authorizes.
create or replace function public.get_hr_accounts()
returns table (
  profile_id uuid,
  full_name text,
  email text,
  account_role text,
  account_status text,
  employee_id uuid,
  department_name text,
  position_title text,
  employment_status text,
  hr_role text,
  grant_status text,
  granted_at timestamptz,
  closed_at timestamptz,
  closed_reason text,
  currently_eligible boolean,
  authorizes_now boolean,
  last_login_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    pr.id,
    pr.full_name,
    pr.email,
    pr.role::text,
    pr.status::text,
    e.id,
    d.name,
    pos.title,
    e.employment_status::text,
    g.hr_role,
    g.status,
    g.granted_at,
    g.closed_at,
    g.closed_reason,
    coalesce(public.is_eligible_for_system_role(pr.id, 'hrms', g.hr_role), false),
    (g.status = 'active'
      and pr.status = 'active'
      and pr.role::text = g.hr_role
      and public.is_eligible_for_system_role(pr.id, 'hrms', g.hr_role)),
    pr.last_login_at
  from public.hr_privilege_grants g
  join public.profiles pr on pr.id = g.profile_id
  left join public.employees e on e.id = pr.employee_id
  left join public.departments d on d.id = e.department_id
  left join public.positions pos on pos.id = e.position_id
  where public.is_admin()
  order by (g.status = 'active') desc, pr.full_name;
$fn$;

revoke all on function public.get_hr_accounts() from public, anon;
grant execute on function public.get_hr_accounts() to authenticated;

-- Grant HR privilege to an account that already exists.
--
-- This is the *upgrade* path: the employee already has an Employee
-- Self-Service login, and it stays the same auth user and the same profile.
-- Creating a second account for the same person is the thing this prevents --
-- see the uniqueness assertion in the contract suite.
create or replace function public.grant_hr_privilege(_profile_id uuid, _hr_role text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an Administrator can grant HR privilege.';
  end if;
  if _hr_role not in ('hr_staff', 'hr_manager') then
    raise exception 'HR_GRANT_INVALID_ROLE: % is not an HR role.', _hr_role;
  end if;

  -- The trigger enforces this too; raising here gives the reason rather than a
  -- constraint name.
  if not public.is_eligible_for_system_role(_profile_id, 'hrms', _hr_role) then
    raise exception 'HR_GRANT_NOT_ELIGIBLE: %',
      public.describe_ineligibility(_profile_id, 'hrms', _hr_role);
  end if;

  if exists (select 1 from public.hr_privilege_grants
              where profile_id = _profile_id and status = 'active') then
    raise exception 'HR_GRANT_EXISTS: that account already holds HR privilege.';
  end if;

  -- profiles.role names the role; the grant authorizes it. Both must agree, so
  -- they are written together.
  update public.profiles set role = _hr_role::public.user_role where id = _profile_id;

  insert into public.hr_privilege_grants (profile_id, hr_role, granted_by)
  values (_profile_id, _hr_role, (select auth.uid()))
  returning id into _id;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values ((select auth.uid()), 'HR Privilege Granted', 'hr_privilege_grants', _id,
          jsonb_build_object('profile_id', _profile_id, 'hr_role', _hr_role));

  return _id;
end;
$fn$;

revoke all on function public.grant_hr_privilege(uuid, text) from public, anon;
grant execute on function public.grant_hr_privilege(uuid, text) to authenticated;

-- Close it. The account keeps working as Employee Self-Service: losing HR
-- authority is not losing employment.
create or replace function public.close_hr_privilege(_profile_id uuid, _reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an Administrator can close HR privilege.';
  end if;

  update public.hr_privilege_grants
     set status = 'closed', closed_at = now(),
         closed_reason = coalesce(nullif(trim(_reason), ''), 'revoked'), updated_at = now()
   where profile_id = _profile_id and status = 'active'
   returning id into _id;

  if _id is null then
    raise exception 'That account holds no active HR privilege.';
  end if;

  -- Back to the baseline every employee has. Their login, their record and
  -- their self-service access are untouched.
  update public.profiles set role = 'employee' where id = _profile_id;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values ((select auth.uid()), 'HR Privilege Closed', 'hr_privilege_grants', _id,
          jsonb_build_object('profile_id', _profile_id, 'reason', _reason));
end;
$fn$;

revoke all on function public.close_hr_privilege(uuid, text) from public, anon;
grant execute on function public.close_hr_privilege(uuid, text) to authenticated;
