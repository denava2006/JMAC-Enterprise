-- Self-service follows employment, in the database too.
--
-- F1 established the rule and applied it to the portal: a person's own
-- attendance, leave and payslips belong to their EMPLOYMENT, not to their role,
-- so being granted HR privilege must not take their own payslip away. The
-- frontend was corrected then. The fifteen RLS policies underneath were not.
--
--   is_active_employee() -> profiles.role = 'employee'
--
-- So the portal was offered and every query behind it came back empty. It went
-- unnoticed because the only accounts with a non-'employee' role that also had
-- employee records were HR's, and nobody opened My Workspace as HR. Finance
-- made it three more accounts, and F3 tripped over it: the request INSERT policy
-- could not confirm the requester was employed, because the requester could not
-- read their own employees row.
--
-- The predicate now asks what every one of its fifteen callers actually means.
-- Nothing widens: each policy that touches personal data is still scoped by
-- my_employee_id(), so this grants a person their own records and nobody
-- else's. The reference-data policies (departments, positions, leave types,
-- work schedules, payroll periods, system settings) are read-only lookups that
-- self-service needs to render at all.
--
-- One case tightens: an account still marked active whose employment no longer
-- permits operational work now loses self-service, where the role check would
-- have kept it. That is the correct answer and matches every other system.
create or replace function public.is_active_employee()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.profiles pr
    join public.employees e on e.id = pr.employee_id
    where pr.id = (select auth.uid())
      and pr.status = 'active'
      and public.employment_permits_operational_work(e.employment_status)
  );
$fn$;

-- Deliberately no grant changes here. create-or-replace keeps the function's
-- existing ACL, and ten {public}-targeted SELECT policies on the careers and
-- resume paths call this predicate: revoking anon's EXECUTE raises 42501 and
-- fails the whole request for every table in scope. resume_storage_rls.sql
-- guards that exact shape, and caught it the moment this migration first tried
-- to tighten the grant.

comment on function public.is_active_employee() is
  'Does the signed-in account have a live employment? Self-service follows '
  'employment rather than role: HR, Finance and POS staff are employees too, '
  'and their own records do not stop existing because they hold a privilege.';

-- ------------------------------------------------------- F3 uses it as well
-- The original wrote the employment check inline. A policy body runs as the
-- CALLER, so that subquery was itself subject to RLS on employees -- which is
-- exactly the rule this migration fixes, and the reason a Finance Staff could
-- not raise a request while a cashier could. Calling the SECURITY DEFINER
-- predicate asks the question once, in one place.
drop policy if exists finance_requests_raise on public.finance_requests;
create policy finance_requests_raise on public.finance_requests
  for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and status = 'draft'
    and public.is_active_employee()
  );

drop policy if exists finance_request_documents_write on storage.objects;
create policy finance_request_documents_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'finance-request-documents'
    and public.is_active_employee()
  );
