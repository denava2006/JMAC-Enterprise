-- Resume upload failed for every applicant, in both PDF and DOCX.
--
-- Captured from production before changing anything:
--
--   POST /storage/v1/object/resumes/<job>/<uuid>.pdf   -> HTTP 400
--   POST /storage/v1/object/resumes/<job>/<uuid>.docx  -> HTTP 400
--   {"statusCode":"403","error":"Unauthorized",
--    "message":"permission denied for function is_active_staff",
--    "code":"AccessDenied"}
--
-- Identical for both formats, which is what rules out the obvious suspect: the
-- resumes bucket already allows application/pdf and the DOCX type, is private,
-- and caps at 5 MB. Nothing about the file was ever the problem.
--
-- This is the same defect that broke the public Careers page, in the one schema
-- the fix for that did not reach. 20260905010000 retargeted every `{public}`
-- read policy whose qual calls a function anon cannot execute -- but it filtered
-- on `schemaname = 'public'`, and storage policies live in `storage`. So
-- storage.objects kept ten policies of exactly the shape that migration existed
-- to remove.
--
-- Why it breaks an upload rather than a read: Postgres evaluates every
-- applicable policy for the role. `public` includes anon, so an anonymous
-- INSERT into storage.objects must evaluate staff_can_upload_contract and its
-- siblings, and the existence check Storage performs first must evaluate
-- staff_can_read_resume. Any one of them calls is_active_staff(), which anon
-- has no EXECUTE on -- correctly, it is a staff check -- and the whole request
-- fails 42501. The anyone_can_upload_resume policy that should have allowed the
-- write never gets the chance.
--
-- The same reasoning as last time applies to why this is safe rather than a
-- privilege change: a policy whose qual calls a function anon cannot execute
-- can never GRANT anon anything. It can only error. Restricting it to
-- `authenticated` removes no access anyone had, and turns a 400 into the clean
-- refusal it always meant.
--
-- Applicant privacy is unchanged and is the point of the design: resumes stays
-- private, reads stay restricted to active staff, and anonymous callers keep
-- exactly one narrow power -- INSERT into that one bucket, which is what
-- submitting an application is.

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
    join anon_denied d
      on coalesce(pol.qual, '') like '%' || d.proname || '%'
      or coalesce(pol.with_check, '') like '%' || d.proname || '%'
    where pol.schemaname = 'storage'
      and pol.roles::text = '{public}'
  loop
    -- Every command, not just reads. An anonymous INSERT evaluates every INSERT
    -- policy on the table, so a staff upload policy for a different bucket is
    -- just as capable of failing an applicant's resume as the read policy is.
    execute format('alter policy %I on %I.%I to authenticated',
                   r.policyname, r.schemaname, r.tablename);
    n := n + 1;
  end loop;

  raise notice 'retargeted % storage policies from public to authenticated', n;
end $$;

-- Prove it took. If any staff storage policy still applies to anon, an
-- applicant's upload would still 400 and this migration has not done its job.
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
  join anon_denied d
    on coalesce(pol.qual, '') like '%' || d.proname || '%'
    or coalesce(pol.with_check, '') like '%' || d.proname || '%'
  where pol.schemaname = 'storage'
    and pol.roles::text = '{public}';

  if leftover <> 0 then
    raise exception 'still % staff storage policies applying to anon', leftover;
  end if;
end $$;

-- Note for the next reader: the applicant's one power is unchanged and narrow.
-- INSERT into the resumes bucket only (anyone_can_upload_resume); no read, no
-- update, no delete, and every read of a resume still requires active staff.
-- A COMMENT ON storage.objects would say so in the catalogue, but that table is
-- owned by supabase_storage_admin and the comment is not worth the ownership.
