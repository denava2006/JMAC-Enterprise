-- FMS F1 — the finance grant, and the lifecycle that maintains it.
--
-- Mirrors hr_privilege_grants deliberately. Three systems now answer the same
-- question the same way, so somebody reading one understands all three: the
-- position confers eligibility, an explicit grant confers access, and neither
-- is enough alone.

-- ------------------------------------------------------- the finance registry
-- Finance needs somewhere to be hired into. The department and its positions
-- are created only if absent, so an organisation that already named them keeps
-- its own rows and ids.
insert into public.departments (name, description)
select 'Finance', 'Budgets, procurement, payments and accounting.'
where not exists (select 1 from public.departments where lower(name) = 'finance');

insert into public.positions (title, department_id, description)
select v.title, d.id, v.description
from (values
  ('Finance Staff',   'Validates requests and prepares procurement.'),
  ('Finance Manager', 'Owns budgets and gives final financial approval.'),
  ('Accountant',      'Processes payments and maintains the ledger.')
) as v(title, description)
join public.departments d on lower(d.name) = 'finance'
where not exists (select 1 from public.positions p where lower(p.title) = lower(v.title));

-- What each position entitles its holder to. The authority for finance access,
-- exactly as it is for HR and POS -- and read from this mapping rather than
-- from a position's title, so renaming a position never silently changes who
-- can approve a payment.
insert into public.position_system_roles (position_id, system, role_code)
select p.id, 'fms'::public.entitlement_system, v.role_code
from (values
  ('Finance Staff',   'finance_staff'),
  ('Finance Manager', 'finance_manager'),
  ('Accountant',      'accountant')
) as v(title, role_code)
join public.positions p on lower(p.title) = lower(v.title)
where not exists (
  select 1 from public.position_system_roles r
  where r.position_id = p.id and r.system = 'fms'
);

-- ------------------------------------------------------------- the grant
create table if not exists public.finance_privilege_grants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  -- Text rather than user_role: this names the PRIVILEGE granted. The profile's
  -- role is a separate column that must agree with it, and the two are written
  -- together so a role can never authorize without a grant behind it.
  finance_role text not null
    check (finance_role in ('finance_staff', 'finance_manager', 'accountant')),
  status text not null default 'active' check (status in ('active', 'closed')),
  granted_by uuid references public.profiles(id),
  granted_at timestamptz not null default now(),
  closed_at timestamptz,
  -- Load-bearing, not commentary. It is what separates a closure the system
  -- made -- a transfer, employment ending -- from a person deciding this
  -- account should not have finance access. Only the former may be reversed
  -- automatically.
  closed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Segregation of duties, enforced by the database rather than by the code that
-- writes to it. Relaxing this has to be a migration somebody signs off.
create unique index if not exists finance_privilege_grants_one_active
  on public.finance_privilege_grants (profile_id)
  where status = 'active';

create index if not exists finance_privilege_grants_profile_idx
  on public.finance_privilege_grants (profile_id);

alter table public.finance_privilege_grants enable row level security;

-- Administrators manage grants; a person may see their own history and nobody
-- else's. TO authenticated on both, never the default PUBLIC.
drop policy if exists finance_privilege_grants_admin_manage on public.finance_privilege_grants;
create policy finance_privilege_grants_admin_manage on public.finance_privilege_grants
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists finance_privilege_grants_self_select on public.finance_privilege_grants;
create policy finance_privilege_grants_self_select on public.finance_privilege_grants
  for select to authenticated
  using (profile_id = (select auth.uid()));

drop trigger if exists trg_set_updated_at on public.finance_privilege_grants;
create trigger trg_set_updated_at
  before update on public.finance_privilege_grants
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------ the question
create or replace function public.has_finance_privilege(_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.profiles pr
    join public.finance_privilege_grants g
      on g.profile_id = pr.id and g.status = 'active'
    where pr.id = (select auth.uid())
      and pr.status = 'active'
      -- The account must still claim the role it was granted. A profile demoted
      -- to 'employee' stops authorizing even while the grant row survives.
      and pr.role::text = g.finance_role
      and g.finance_role = any (_roles)
      and public.is_eligible_for_system_role(pr.id, 'fms', g.finance_role)
  );
$fn$;

/** Anyone who works in Finance. The equivalent of is_active_staff for HR, and
 *  deliberately separate from it -- finance access grants no HR data. */
create or replace function public.is_active_finance()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.has_finance_privilege(
    array['finance_staff', 'finance_manager', 'accountant']);
$fn$;

-- --------------------------------------------------- establishing the grant
create or replace function public.reconcile_finance_privilege(_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _entitled text;
  _active   record;
  _blocked  boolean;
begin
  select psr.role_code into _entitled
  from public.profiles pr
  join public.employees e on e.id = pr.employee_id
  join public.positions pos on pos.id = e.position_id
  join public.position_system_roles psr
    on psr.position_id = pos.id and psr.system = 'fms'
  where pr.id = _profile_id
    and pr.status = 'active'
    and pr.role <> 'admin'
    and public.employment_permits_operational_work(e.employment_status)
  limit 1;

  select * into _active
  from public.finance_privilege_grants
  where profile_id = _profile_id and status = 'active'
  limit 1;

  -- Nothing to establish. Closing a grant when the position no longer entitles
  -- it belongs to close_ineligible_finance_grants, on the employees trigger --
  -- two things racing to close the same row helps nobody.
  if _entitled is null then
    return;
  end if;

  if _active.id is not null then
    if _active.finance_role = _entitled then
      return; -- already correct
    end if;

    -- A promotion, or a move between finance positions. Closed rather than
    -- deleted: who could approve what, and when, is worth keeping.
    update public.finance_privilege_grants
       set status = 'closed', closed_at = now(),
           closed_reason = 'position_changed', updated_at = now()
     where id = _active.id;
  else
    -- An Administrator's decision outlives a page refresh. Only the system's
    -- own closures may be reversed; anything else was somebody deciding, and
    -- re-granting on the next lifecycle event would quietly overrule them.
    select exists (
      select 1 from public.finance_privilege_grants
      where profile_id = _profile_id
        and status = 'closed'
        and coalesce(closed_reason, '') not in ('workforce_ineligible', 'position_changed')
    ) into _blocked;

    if _blocked then
      return;
    end if;
  end if;

  if not public.is_eligible_for_system_role(_profile_id, 'fms', _entitled) then
    return;
  end if;

  -- Written together: the role names it, the grant authorizes it, and
  -- has_finance_privilege requires both to agree.
  update public.profiles set role = _entitled::public.user_role where id = _profile_id;

  insert into public.finance_privilege_grants (profile_id, finance_role, granted_by)
  values (_profile_id, _entitled, (select auth.uid()));

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values ((select auth.uid()), 'Finance Privilege Granted', 'finance_privilege_grants',
          _profile_id,
          jsonb_build_object('profile_id', _profile_id, 'finance_role', _entitled,
                             'source', 'position entitlement'));
end;
$fn$;

revoke all on function public.reconcile_finance_privilege(uuid) from public, anon, authenticated;

-- ------------------------------------------------------- removing the grant
create or replace function public.close_ineligible_finance_grants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  g record;
begin
  for g in
    select fg.id, fg.finance_role, pr.id as profile_id
    from public.finance_privilege_grants fg
    join public.profiles pr on pr.id = fg.profile_id
    where fg.status = 'active' and pr.employee_id = new.id
  loop
    if not public.is_eligible_for_system_role(g.profile_id, 'fms', g.finance_role) then
      update public.finance_privilege_grants
         set status = 'closed',
             closed_at = now(),
             closed_reason = 'workforce_ineligible',
             updated_at = now()
       where id = g.id;

      -- Back to the baseline every employee has. Their login, their record and
      -- their self-service are untouched.
      update public.profiles set role = 'employee' where id = g.profile_id;
    end if;
  end loop;
  return new;
end;
$fn$;

drop trigger if exists trg_close_ineligible_finance_grants on public.employees;
create trigger trg_close_ineligible_finance_grants
  after update of position_id, department_id, employment_status on public.employees
  for each row execute function public.close_ineligible_finance_grants();

-- ------------------------------------------------------- an Administrator's
create or replace function public.grant_finance_privilege(
  _profile_id uuid,
  _finance_role text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an Administrator can grant finance privilege.';
  end if;

  if _finance_role not in ('finance_staff', 'finance_manager', 'accountant') then
    raise exception 'FINANCE_GRANT_INVALID_ROLE: % is not a finance role.', _finance_role;
  end if;

  if not public.is_eligible_for_system_role(_profile_id, 'fms', _finance_role) then
    raise exception 'FINANCE_GRANT_NOT_ELIGIBLE: %',
      public.describe_ineligibility(_profile_id, 'fms', _finance_role);
  end if;

  -- The index would refuse this anyway; raising here gives the reason rather
  -- than a constraint name.
  if exists (select 1 from public.finance_privilege_grants
              where profile_id = _profile_id and status = 'active') then
    raise exception 'FINANCE_GRANT_EXISTS: that account already holds a finance role.';
  end if;

  update public.profiles set role = _finance_role::public.user_role where id = _profile_id;

  insert into public.finance_privilege_grants (profile_id, finance_role, granted_by)
  values (_profile_id, _finance_role, (select auth.uid()))
  returning id into _id;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values ((select auth.uid()), 'Finance Privilege Granted', 'finance_privilege_grants', _id,
          jsonb_build_object('profile_id', _profile_id, 'finance_role', _finance_role));

  return _id;
end;
$fn$;

create or replace function public.close_finance_privilege(
  _profile_id uuid,
  _reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an Administrator can close finance privilege.';
  end if;

  update public.finance_privilege_grants
     set status = 'closed', closed_at = now(),
         closed_reason = coalesce(nullif(trim(_reason), ''), 'revoked'), updated_at = now()
   where profile_id = _profile_id and status = 'active'
   returning id into _id;

  if _id is null then
    raise exception 'That account holds no active finance privilege.';
  end if;

  update public.profiles set role = 'employee' where id = _profile_id;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values ((select auth.uid()), 'Finance Privilege Closed', 'finance_privilege_grants', _id,
          jsonb_build_object('profile_id', _profile_id, 'reason', _reason));
end;
$fn$;

revoke all on function public.grant_finance_privilege(uuid, text) from public, anon;
revoke all on function public.close_finance_privilege(uuid, text) from public, anon;
revoke all on function public.has_finance_privilege(text[]) from public, anon;
revoke all on function public.is_active_finance() from public, anon;
grant execute on function public.grant_finance_privilege(uuid, text) to authenticated;
grant execute on function public.close_finance_privilege(uuid, text) to authenticated;
grant execute on function public.has_finance_privilege(text[]) to authenticated;
grant execute on function public.is_active_finance() to authenticated;

comment on table public.finance_privilege_grants is
  'Who may act in Finance, and who may not any more. Exactly one active grant '
  'per profile: Finance Staff validates, Finance Manager approves, the '
  'Accountant pays -- one person holding two of those is the control removed.';
