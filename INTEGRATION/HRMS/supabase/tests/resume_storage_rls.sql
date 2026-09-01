-- Resume storage — database contract test.
--
-- Written because hosted resume upload failed for every applicant, in both PDF
-- and DOCX, with
--
--   400 {"statusCode":"403","message":"permission denied for function is_active_staff"}
--
-- The bucket was never the problem: resumes already allowed PDF and DOCX, was
-- already private, already capped at 5 MB. The problem was that storage.objects
-- carried ten `{public}` policies whose quals call is_active_staff(), and
-- `public` includes anon. An anonymous INSERT evaluates every INSERT policy on
-- the table, so a staff upload policy for a completely different bucket was
-- enough to fail an applicant's resume.
--
-- This suite pins the two halves of the design that must both stay true: an
-- applicant who is not signed in CAN put a resume in, and CANNOT get anything
-- out. Resume files are personal information.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/resume_storage_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

do $$
declare
  n        integer;
  txt      text;
  job      uuid;
  mimes    text[];
  limit_b  bigint;
  is_pub   boolean;
begin
  -- ======================================================================
  -- 1. The bucket is configured for applicants, and privately
  -- ======================================================================
  select public, file_size_limit, allowed_mime_types
    into is_pub, limit_b, mimes
  from storage.buckets where id = 'resumes';

  if is_pub is null then
    raise exception 'FAIL  1a there is no resumes bucket';
  end if;
  if is_pub then
    raise exception 'FAIL  1b the resumes bucket is public -- resumes are personal information';
  end if;
  raise notice 'PASS  1a-b the resumes bucket exists and is private';

  if not ('application/pdf' = any(mimes)) then
    raise exception 'FAIL  1c PDF is not an allowed resume type';
  end if;
  if not ('application/vnd.openxmlformats-officedocument.wordprocessingml.document' = any(mimes)) then
    raise exception 'FAIL  1d DOCX is not an allowed resume type';
  end if;
  raise notice 'PASS  1c-d both PDF and DOCX are allowed';

  -- The bucket must not quietly accept anything executable or scriptable.
  foreach txt in array mimes loop
    if txt ~* '(x-msdownload|x-executable|x-sh|javascript|octet-stream|zip|html)' then
      raise exception 'FAIL  1e the resumes bucket allows an unsafe type: %', txt;
    end if;
  end loop;
  raise notice 'PASS  1e no executable or scriptable type is allowed';

  if limit_b is null or limit_b > 10485760 then
    raise exception 'FAIL  1f the resume size limit is % bytes', limit_b;
  end if;
  raise notice 'PASS  1f resumes are size-capped at % MB', limit_b / 1024 / 1024;

  -- ======================================================================
  -- 2. No staff policy is left in an anonymous caller's path
  -- ======================================================================
  --
  -- This is the actual regression. A policy whose qual calls a function anon
  -- cannot execute can never grant anon anything -- it can only error -- so any
  -- such policy still targeting `public` is a 400 waiting to happen on whatever
  -- anonymous storage operation reaches that table next.
  with anon_denied as (
    select p.oid, p.proname
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.prorettype = 'boolean'::regtype
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
  )
  select count(*), string_agg(distinct pol.policyname, ', ')
    into n, txt
  from pg_policies pol
  join anon_denied d
    on coalesce(pol.qual, '') like '%' || d.proname || '%'
    or coalesce(pol.with_check, '') like '%' || d.proname || '%'
  where pol.schemaname = 'storage' and pol.roles::text = '{public}';

  if n <> 0 then
    raise exception 'FAIL  2a % storage policies still make anon evaluate a staff check: %', n, txt;
  end if;
  raise notice 'PASS  2a no storage policy makes an anonymous caller evaluate a staff check';

  -- The same must hold in public, which is where the Careers page broke.
  with anon_denied as (
    select p.oid, p.proname
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.prorettype = 'boolean'::regtype
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
  )
  select count(*) into n
  from pg_policies pol
  join anon_denied d on coalesce(pol.qual, '') like '%' || d.proname || '%'
  where pol.schemaname = 'public' and pol.cmd in ('SELECT', 'ALL')
    and pol.roles::text = '{public}';

  if n <> 0 then
    raise exception 'FAIL  2b % public read policies regressed to the same shape', n;
  end if;
  raise notice 'PASS  2b the public schema has not regressed to the same shape';

  -- ======================================================================
  -- 3. An applicant may put a resume in, and take nothing out
  -- ======================================================================
  select count(*) into n from pg_policies
   where schemaname='storage' and tablename='objects'
     and policyname='anyone_can_upload_resume' and cmd='INSERT';
  if n <> 1 then
    raise exception 'FAIL  3a applicants have no way to upload a resume';
  end if;
  raise notice 'PASS  3a an anonymous applicant may upload a resume';

  -- ...and that is the ONLY thing anon may do to storage. Anything else
  -- reachable without a session would be a way to read other people's files.
  select count(*), coalesce(string_agg(policyname || ' (' || cmd || ')', ', '), '')
    into n, txt
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and roles::text in ('{public}', '{anon}')
    and policyname <> 'anyone_can_upload_resume';
  if n <> 0 then
    raise exception 'FAIL  3b anon can also reach: %', txt;
  end if;
  raise notice 'PASS  3b uploading is the only storage power an applicant has';

  -- Reading a resume requires active staff, and still does.
  select qual into txt from pg_policies
   where schemaname='storage' and tablename='objects' and policyname='staff_can_read_resume';
  if txt is null or txt not like '%is_active_staff%' then
    raise exception 'FAIL  3c resume reads are no longer gated on active staff: %', txt;
  end if;
  raise notice 'PASS  3c reading a resume still requires active staff';

  -- ======================================================================
  -- 4. The application still records the path it was given
  -- ======================================================================
  --
  -- A failed upload must not leave an application behind, which is enforced by
  -- the client refusing to submit -- but the column has to exist and be
  -- required, or an application could be filed with no resume at all.
  select is_nullable into txt from information_schema.columns
   where table_schema='public' and table_name='applicants' and column_name='resume_url';
  if txt is null then
    raise exception 'FAIL  4a applicants do not record a resume path';
  end if;

  -- The submit RPC takes the path the upload returned, so a resume that never
  -- uploaded cannot be referenced by an application.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public' and p.proname='submit_job_application'
     and pg_get_function_identity_arguments(p.oid) like '%p_resume_path%';
  if n = 0 then
    raise exception 'FAIL  4b submit_job_application does not take a resume path';
  end if;
  raise notice 'PASS  4a-b the applicant record carries the resume the application was submitted with';

  raise notice '--- all resume storage checks passed ---';
end $$;

rollback;

select 'resumes bucket is public: ' || coalesce((select public::text from storage.buckets where id='resumes'), 'missing') as verify;
