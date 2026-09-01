-- An anonymous visitor must never be made to evaluate a staff-only predicate.
--
-- The Careers regression was one instance of a defect present on 32 tables.
-- The shape is always the same: a permissive read policy targeted at the
-- `public` role, whose qual calls a helper like is_active_staff(). `public`
-- includes anon, so an anonymous request has to evaluate that call, and anon
-- has no EXECUTE on it -- correctly, since it is a staff check. Evaluating it
-- raises
--
--   42501 permission denied for function is_active_staff
--
-- and the whole request fails. On job_postings that turned the public Careers
-- page into "Couldn't load job postings"; on the other 31 tables it is latent,
-- waiting for the first anonymous query to reach them.
--
-- Why retargeting these policies to `authenticated` is safe rather than a
-- privilege change: a policy whose qual calls a function anon cannot execute
-- can never GRANT anon anything. It can only error. Restricting it to
-- authenticated therefore removes no access anyone actually had -- it converts
-- a 401 into a clean, empty result, which is what "you may not see this" is
-- supposed to look like.
--
-- Checked before writing this: of the affected policies, only two have a qual
-- that is not a bare helper call, and both gate every branch behind a staff
-- check anyway (`is_active_staff() AND ...` on interviews,
-- `is_admin() OR has_pos_role(...)` on pos_payment_attempts). None grants anon
-- anything through an OR, so nothing anonymous is being taken away.
--
-- Deliberately limited to SELECT and ALL policies. Write policies are left
-- exactly as they are: anon cannot reach them anyway, and this fix has no
-- business touching how anything is created.

do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    with anon_denied as (
      select p.oid, p.proname
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public'
        and p.prorettype = 'boolean'::regtype
        and not has_function_privilege('anon', p.oid, 'EXECUTE')
    )
    select distinct pol.schemaname, pol.tablename, pol.policyname
    from pg_policies pol
    join anon_denied d on pol.qual like '%' || d.proname || '%'
    where pol.schemaname = 'public'
      and pol.cmd in ('SELECT', 'ALL')
      and pol.roles::text = '{public}'
  loop
    execute format('alter policy %I on %I.%I to authenticated',
                   r.policyname, r.schemaname, r.tablename);
    n := n + 1;
  end loop;

  raise notice 'retargeted % staff read policies from public to authenticated', n;
end $$;

-- Prove it took. If any staff read policy still applies to anon, an anonymous
-- request to that table would 401 rather than return nothing, and this
-- migration has not done its job.
do $$
declare
  leftover integer;
begin
  with anon_denied as (
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prorettype = 'boolean'::regtype
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
  )
  select count(*) into leftover
  from pg_policies pol
  join anon_denied d on pol.qual like '%' || d.proname || '%'
  where pol.schemaname = 'public'
    and pol.cmd in ('SELECT', 'ALL')
    and pol.roles::text = '{public}';

  if leftover <> 0 then
    raise exception 'still % staff read policies applying to anon', leftover;
  end if;
end $$;
