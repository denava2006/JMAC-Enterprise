-- The public Careers page could not load any job posting.
--
-- Captured anonymously against production before changing anything:
--
--   GET /rest/v1/job_postings?select=*,departments(name),positions(title)
--   401 {"code":"42501","message":"permission denied for function is_active_staff"}
--
-- The cause is policy targeting, not the data. job_postings carries two
-- permissive SELECT policies: anon_view_open_postings (roles {anon}, qual
-- status = 'open') and job_postings_select_staff (roles {public}, qual
-- is_active_staff()). `public` INCLUDES anon, so an anonymous request has to
-- evaluate the staff policy too -- and anon has no EXECUTE on is_active_staff,
-- which is correct and deliberate. Evaluating it raises 42501 and the whole
-- request fails, so the anon policy that would have allowed the row never gets
-- the chance. Postgres ORs permissive policies but does not promise to
-- short-circuit past one that errors; departments happened to survive the same
-- shape, job_postings did not.
--
-- The posting itself was fine: status open, department and position set,
-- closing date in the future.
--
-- Two things are fixed here, and the second is the more important one.

-- ---------------------------------------------------------------------------
-- 1. A dedicated public read path.
--
-- The old query reached the table directly and embedded departments(name) and
-- positions(title), which only worked because anon could read the WHOLE of both
-- HR reference tables -- anon_view_departments and anon_view_positions were
-- both `using (true)`. An applicant browsing jobs should not be able to
-- enumerate the company's org structure.
--
-- So the public surface becomes one function returning exactly the applicant-
-- safe fields, and the tables stop being anonymously readable at all. Nothing
-- about who created a posting, reviewed it, or any other HR metadata leaves the
-- database: posted_by, created_at and updated_at are deliberately absent.
create or replace function public.get_public_job_postings()
returns table (
  id uuid,
  department_name text,
  position_title text,
  description text,
  requirements text,
  employment_type text,
  vacancies integer,
  status text,
  closing_date date,
  date_posted timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  -- Visibility is decided HERE, not in React. A posting is public only while
  -- it is open and its own closing date has not passed. 'draft' and 'closed'
  -- are excluded by the status test; a null closing date means the posting has
  -- no deadline rather than an expired one, so it stays visible.
  select j.id,
         d.name,
         p.title,
         j.description,
         j.requirements,
         j.employment_type::text,
         j.vacancies,
         j.status::text,
         j.closing_date,
         j.date_posted
  from public.job_postings j
  -- LEFT JOIN so a posting is never silently hidden because a reference row is
  -- missing; the page already falls back to a generic title.
  left join public.departments d on d.id = j.department_id
  left join public.positions p on p.id = j.position_id
  where j.status = 'open'
    and (j.closing_date is null or j.closing_date >= current_date)
  order by j.date_posted desc nulls last;
$fn$;

revoke all on function public.get_public_job_postings() from public;
grant execute on function public.get_public_job_postings() to anon, authenticated;

comment on function public.get_public_job_postings() is
  'The public Careers list. Applicant-safe fields only; visibility (open, not '
  'past its closing date) is decided server-side.';

-- One posting, by id, under exactly the same visibility rule -- so knowing the
-- uuid of a draft or closed posting reveals nothing.
create or replace function public.get_public_job_posting(_id uuid)
returns table (
  id uuid,
  department_name text,
  position_title text,
  description text,
  requirements text,
  employment_type text,
  vacancies integer,
  status text,
  closing_date date,
  date_posted timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select j.id,
         d.name,
         p.title,
         j.description,
         j.requirements,
         j.employment_type::text,
         j.vacancies,
         j.status::text,
         j.closing_date,
         j.date_posted
  from public.job_postings j
  left join public.departments d on d.id = j.department_id
  left join public.positions p on p.id = j.position_id
  where j.id = _id
    and j.status = 'open'
    and (j.closing_date is null or j.closing_date >= current_date);
$fn$;

revoke all on function public.get_public_job_posting(uuid) from public;
grant execute on function public.get_public_job_posting(uuid) to anon, authenticated;

comment on function public.get_public_job_posting(uuid) is
  'One public job posting. Same visibility rule as the list, so a draft or '
  'closed posting cannot be reached by guessing its id.';

-- ---------------------------------------------------------------------------
-- 2. Stop exposing the HR reference tables to anonymous visitors.
--
-- These were `using (true)`: every department and every position, readable by
-- anyone on the internet. The Careers page needed them only to resolve names
-- for the embedded select, which the RPC above now does server-side.
drop policy if exists anon_view_departments on public.departments;
drop policy if exists anon_view_positions on public.positions;

-- job_postings likewise: the public path no longer touches the table.
drop policy if exists anon_view_open_postings on public.job_postings;

-- ---------------------------------------------------------------------------
-- 3. Staff policies stop applying to anonymous visitors.
--
-- Even with the anon policies gone, a `{public}` policy still forces anon to
-- evaluate is_active_staff() on any direct read, which errors rather than
-- simply denying. Retargeting them to `authenticated` means an anonymous
-- request to these tables gets a clean empty result instead of a 42501, so a
-- future page that queries them by mistake fails visibly and safely.
--
-- Only read paths are retargeted. Insert, update and delete policies are left
-- exactly as they are -- job creation is not part of this bug.
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('job_postings', 'departments', 'positions')
      and cmd in ('SELECT', 'ALL')
      and roles::text = '{public}'
  loop
    execute format('alter policy %I on %I.%I to authenticated',
                   r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;
