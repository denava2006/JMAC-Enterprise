-- Track Application shows the applicant their own name.
--
-- lookup_application is what an applicant sees after entering their reference
-- code, and it built the name from the applicants row:
--
--   concat_ws(' ', ap.first_name, ap.last_name)
--
-- That row is rewritten by every later submission on the same email, so the
-- person checking APP-2026-0003 was shown a name that was not hers. Of all the
-- places the corruption surfaced, this is the one an outsider saw.
--
-- The identity now comes from the application's own snapshot, matching what HR
-- detail, the interview drawer and the Create Employee hand-off already read.
-- Everything else about the function is unchanged.

CREATE OR REPLACE FUNCTION public.lookup_application(p_reference_code text, p_email text)
 RETURNS TABLE(reference_code text, status application_status, submitted_at timestamp with time zone, applicant_name text, position_title text, department_name text, position_employment_type employment_type, interview_type interview_type, interview_scheduled_at timestamp with time zone, interview_mode text, interview_location text, interview_meeting_link text, interview_status interview_status, offer_id uuid, offer_status offer_status, offer_employment_type employment_type, offer_salary numeric, offer_currency text, offer_start_date date, offer_working_hours text, offer_working_days text, offer_benefits text, offer_additional_compensation text, contract_id uuid, contract_status contract_status, contract_start_date date, contract_signed_at timestamp with time zone, contract_file_path text, contract_company_policies text, contract_terms text, contract_additional_notes text, deployment_date date, deployment_branch text, deployment_work_location text, deployment_schedule_name text, deployment_schedule_start time without time zone, deployment_schedule_end time without time zone, deployment_schedule_days smallint[], deployment_remarks text, employee_number text, employee_email text, employee_hire_date date, employee_position text, employee_department text, employee_basic_salary numeric, employee_currency text, employee_employment_type employment_type, employee_employment_status employment_status, employee_benefits text, account_email text, account_activated_at timestamp with time zone, documents jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    a.reference_code,
    a.status,
    a.created_at,
    -- The name THIS application was submitted under. Reading the applicants
    -- row here is why a real applicant, checking her own reference code,
    -- was greeted by somebody else's name.
    concat_ws(' ', coalesce(a.applicant_first_name, ap.first_name),
                   coalesce(a.applicant_last_name, ap.last_name)),
    pos.title,
    dep.name,
    jp.employment_type,
    i.interview_type,
    i.scheduled_at,
    i.mode,
    i.location,
    i.meeting_link,
    i.status,
    o.id,
    o.status,
    o.employment_type,
    o.proposed_salary,
    o.currency,
    o.start_date,
    o.working_hours,
    o.working_days,
    o.benefits,
    o.additional_compensation,
    c.id,
    c.status,
    c.start_date,
    c.signed_at,
    c.contract_file_url,
    c.company_policies,
    c.terms,
    c.additional_notes,
    d.deployment_date,
    coalesce(br.name, d.assigned_branch),
    coalesce(wl.name, d.work_location),
    ws.name,
    ws.start_time,
    ws.end_time,
    ws.working_days,
    d.remarks,
    e.employee_number,
    e.email,
    e.hire_date,
    epos.title,
    edep.name,
    e.basic_salary,
    e.currency,
    e.employment_type,
    e.employment_status,
    e.benefits,
    pr.email,
    pr.activated_at,
    coalesce(docs.items, '[]'::jsonb)
  from public.applications a
  join public.applicants ap on ap.id = a.applicant_id
  left join public.job_postings jp on jp.id = a.job_posting_id
  left join public.positions pos on pos.id = jp.position_id
  left join public.departments dep on dep.id = jp.department_id
  -- Only the interview the applicant still needs to attend, newest first.
  left join lateral (
    select * from public.interviews
    where application_id = a.id and status in ('scheduled','completed')
    order by scheduled_at desc limit 1
  ) i on true
  left join lateral (
    select * from public.job_offers
    where application_id = a.id
    order by created_at desc limit 1
  ) o on true
  left join lateral (
    select * from public.employment_contracts
    where job_offer_id = o.id
    order by created_at desc limit 1
  ) c on true
  left join public.deployment_records d on d.application_id = a.id
  left join public.branches br on br.id = d.branch_id
  left join public.work_locations wl on wl.id = d.work_location_id
  left join public.work_schedules ws on ws.id = d.work_schedule_id
  left join public.employees e on e.application_id = a.id
  left join public.positions epos on epos.id = e.position_id
  left join public.departments edep on edep.id = e.department_id
  left join public.profiles pr on pr.employee_id = e.id
  left join lateral (
    select jsonb_agg(
             jsonb_build_object(
               'document_type', ed.document_type,
               'file_path', ed.file_url,
               'uploaded_at', ed.uploaded_at
             ) order by ed.uploaded_at
           ) as items
    from public.employee_documents ed
    where ed.employee_id = e.id
  ) docs on true
  where a.reference_code = upper(trim(p_reference_code))
    and lower(ap.email) = lower(trim(p_email));
$function$
