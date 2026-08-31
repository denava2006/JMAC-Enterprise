-- Give existing HR accounts the workforce identity the new rule requires.
--
-- 20260901000000 made HR authorization depend on a linked employee, an eligible
-- position and an explicit grant. Applied on its own it signs out every HR
-- account that predates it -- verified, not assumed: immediately after that
-- migration, is_active_staff() returned false for both staff@suite.com and
-- manager@suite.com while the Administrator was unaffected.
--
-- So this is the other half of the cutover, and it must run with it.
--
-- For each active HR account with no employee record, it creates one in Human
-- Resources under the position matching the role the account already holds,
-- links the profile to it, and records an explicit grant. That is not inventing
-- a person: the account belongs to somebody who already does this job, and the
-- new model simply requires that fact to exist as a row. Nothing about who they
-- are or what they may do changes -- only whether the database can see it.
--
-- Accounts that are already linked get the grant alone, and only if their
-- position genuinely confers the role. An HR account sitting on an ineligible
-- position is left closed deliberately: an Administrator must move them or
-- grant again, which is the whole point of the phase.
--
-- Idempotent, and a no-op on any database with no standalone HR accounts --
-- which is every production database today, since production has no users.

do $$
declare
  _hr_dept uuid;
  _pos uuid;
  _p record;
  _emp uuid;
  _created int := 0;
  _granted int := 0;
  _skipped int := 0;
begin
  select id into _hr_dept from public.departments where lower(name) = 'human resources' limit 1;

  for _p in
    select pr.id, pr.email, pr.full_name, pr.role::text as role, pr.employee_id
    from public.profiles pr
    where pr.status = 'active'
      and pr.role in ('hr_staff', 'hr_manager')
  loop
    -- 1. A workforce identity, if they have none.
    if _p.employee_id is null then
      if _hr_dept is null then
        raise exception
          'HR backfill: % has no employee record and there is no Human Resources department to file one under', _p.email;
      end if;

      select id into _pos
        from public.positions
       where department_id = _hr_dept
         and lower(title) = case _p.role when 'hr_manager' then 'hr manager' else 'hr staff' end
       limit 1;
      if _pos is null then
        raise exception 'HR backfill: no % position exists in Human Resources', _p.role;
      end if;

      -- An existing employee row with this email is theirs; reuse rather than
      -- create a second person for the same address.
      select id into _emp from public.employees where lower(email) = lower(_p.email) limit 1;

      if _emp is null then
        insert into public.employees (
          first_name, last_name, email, department_id, position_id,
          employment_status, employment_type, hire_date)
        values (
          split_part(coalesce(nullif(trim(_p.full_name), ''), _p.email), ' ', 1),
          nullif(trim(substring(coalesce(nullif(trim(_p.full_name), ''), _p.email)
                                from position(' ' in coalesce(nullif(trim(_p.full_name), ''), _p.email) || ' '))), ''),
          _p.email, _hr_dept, _pos, 'active', 'regular', current_date)
        returning id into _emp;
        _created := _created + 1;
      else
        -- Make the existing record match the role the account already holds.
        update public.employees
           set department_id = _hr_dept, position_id = _pos
         where id = _emp
           and (department_id is distinct from _hr_dept or position_id is distinct from _pos);
      end if;

      update public.profiles set employee_id = _emp where id = _p.id;
    end if;

    -- 2. The explicit grant, but only where the job actually confers the role.
    if public.is_eligible_for_system_role(_p.id, 'hrms', _p.role) then
      insert into public.hr_privilege_grants (profile_id, hr_role, status, granted_by)
      select _p.id, _p.role, 'active', null
      where not exists (
        select 1 from public.hr_privilege_grants
         where profile_id = _p.id and status = 'active');
      _granted := _granted + 1;
    else
      _skipped := _skipped + 1;
      raise warning
        'HR backfill: % keeps no privilege -- %', _p.email,
        public.describe_ineligibility(_p.id, 'hrms', _p.role);
    end if;
  end loop;

  raise notice 'HR backfill: % employee record(s) created, % grant(s) recorded, % left without privilege',
    _created, _granted, _skipped;
end $$;
