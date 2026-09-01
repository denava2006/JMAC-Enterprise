import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Enums } from '@/lib/database.types'

/** One row from lookup_application(). Applicants are not Auth users — every
 * call carries the reference code plus the email the application was submitted
 * with, and the RPC does the matching server-side. */
export interface ApplicationTrackingRecord {
  reference_code: string
  status: Enums<'application_status'>
  submitted_at: string
  applicant_name: string
  position_title: string | null
  department_name: string | null
  position_employment_type: Enums<'employment_type'> | null
  interview_type: Enums<'interview_type'> | null
  interview_scheduled_at: string | null
  interview_mode: string | null
  interview_location: string | null
  interview_meeting_link: string | null
  interview_status: Enums<'interview_status'> | null
  offer_id: string | null
  offer_status: Enums<'offer_status'> | null
  offer_employment_type: Enums<'employment_type'> | null
  offer_salary: number | null
  offer_currency: string | null
  offer_start_date: string | null
  offer_working_hours: string | null
  offer_working_days: string | null
  offer_benefits: string | null
  offer_additional_compensation: string | null
  contract_id: string | null
  contract_status: Enums<'contract_status'> | null
  contract_start_date: string | null
  contract_signed_at: string | null
  contract_file_path: string | null
  contract_company_policies: string | null
  contract_terms: string | null
  contract_additional_notes: string | null
  deployment_date: string | null
  deployment_branch: string | null
  deployment_work_location: string | null
  deployment_schedule_name: string | null
  deployment_schedule_start: string | null
  deployment_schedule_end: string | null
  deployment_schedule_days: number[] | null
  deployment_remarks: string | null
  employee_number: string | null
  employee_email: string | null
  employee_hire_date: string | null
  employee_position: string | null
  employee_department: string | null
  employee_basic_salary: number | null
  employee_currency: string | null
  employee_employment_type: Enums<'employment_type'> | null
  employee_employment_status: Enums<'employment_status'> | null
  employee_benefits: string | null
  account_email: string | null
  account_activated_at: string | null
  documents: ApplicantDocument[]
}

export interface ApplicantDocument {
  document_type: string
  file_path: string
  uploaded_at: string
}

export interface ApplicantCredentials {
  referenceCode: string
  email: string
}

const TRACKING_KEY = ['application-tracking']

export function useApplicationTracking(credentials: ApplicantCredentials | null) {
  return useQuery({
    queryKey: [...TRACKING_KEY, credentials?.referenceCode, credentials?.email],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('lookup_application', {
        p_reference_code: credentials!.referenceCode,
        p_email: credentials!.email,
      })
      if (error) throw new Error('We couldn’t check that application. Please try again.')
      const row = (data as unknown as ApplicationTrackingRecord[] | null)?.[0] ?? null
      if (!row) {
        throw new Error('No application matches that reference number and email address.')
      }
      return row
    },
    enabled: !!credentials,
    retry: false,
  })
}

/** One step on the applicant's journey. Names and times only -- the RPC behind
 *  this returns nothing else, and there is nothing else worth showing. */
export interface ApplicationMilestone {
  event: string
  occurred_at: string
}

/** What each milestone is called on the applicant's screen.
 *
 *  An explicit map, not a prettified event name. The stored vocabulary is HR's
 *  ('reviewed', 'job_offer_prepared'); what the applicant reads should be plain
 *  and about them. An event with no entry here is not rendered at all, so a
 *  milestone added later cannot leak internal wording by simply existing. */
export const MILESTONE_LABEL: Record<string, string> = {
  submitted: 'Application Submitted',
  reviewed: 'Under Review',
  qualified: 'Shortlisted',
  initial_interview_scheduled: 'Initial Interview Scheduled',
  initial_interview_rescheduled: 'Initial Interview Rescheduled',
  initial_interview_passed: 'Initial Interview Passed',
  initial_interview_cancelled: 'Initial Interview Cancelled',
  final_interview_scheduled: 'Final Interview Scheduled',
  final_interview_rescheduled: 'Final Interview Rescheduled',
  final_interview_cancelled: 'Final Interview Cancelled',
  job_offer_prepared: 'Offer Sent',
  offer_accepted: 'Offer Accepted',
  offer_declined: 'Offer Declined',
  hired: 'Hired',
  deployment_completed: 'Deployed',
  rejected: 'Not Moving Forward',
  application_closed: 'Application Closed',
}

/**
 * The applicant's own timeline.
 *
 * A separate call from useApplicationTracking on purpose. That one answers
 * "where is my application now" and carries offer, contract and employment
 * detail; this one answers "how did it get here" and carries nothing but event
 * names and dates. Keeping them apart means the timeline can never inherit the
 * wider result by accident.
 */
export function useApplicationMilestones(credentials: ApplicantCredentials | null) {
  return useQuery({
    queryKey: [...TRACKING_KEY, 'milestones', credentials?.referenceCode, credentials?.email],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('lookup_application_milestones', {
        p_reference_code: credentials!.referenceCode,
        p_email: credentials!.email,
      })
      if (error) throw new Error('We couldn’t load your application history.')
      return (data as unknown as ApplicationMilestone[] | null) ?? []
    },
    enabled: !!credentials,
    retry: false,
  })
}

const FRIENDLY_RESPONSE_ERRORS: Record<string, string> = {
  NOT_FOUND: 'No application matches that reference number and email address.',
  NO_OFFER: 'There’s no job offer on this application yet.',
  ALREADY_RESPONDED: 'You’ve already responded to this offer.',
  INVALID_DECISION: 'That response isn’t valid.',
  DECLINE_REASON_REQUIRED: 'Please tell us why you’re declining.',
}

export function useRespondToOfferAsApplicant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      credentials,
      decision,
      declineReason,
      declineNotes,
    }: {
      credentials: ApplicantCredentials
      decision: 'accepted' | 'declined'
      /** Required when declining — HR has no other way to learn why a
       * candidate they'd chosen said no. Ignored on accept. */
      declineReason?: string
      declineNotes?: string
    }) => {
      const { error } = await supabase.rpc('respond_to_job_offer', {
        p_reference_code: credentials.referenceCode,
        p_email: credentials.email,
        p_decision: decision,
        p_decline_reason: decision === 'declined' ? declineReason : undefined,
        p_decline_notes: decision === 'declined' ? declineNotes : undefined,
      })
      if (error) {
        throw new Error(FRIENDLY_RESPONSE_ERRORS[error.message] ?? 'We couldn’t record your response. Please try again.')
      }
      return decision
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TRACKING_KEY })
    },
  })
}

/** Opens one of the applicant's own files — their signed contract, or a
 * document HR filed against their employee record.
 *
 * Both buckets are private and readable only by HR, so the browser can't fetch
 * them directly. The applicant-file Edge Function re-checks the reference code
 * and email server-side and returns a signed URL that expires in a couple of
 * minutes; nothing durable is handed to the browser. */
export function useApplicantFileDownload() {
  return useMutation({
    mutationFn: async ({
      credentials,
      bucket,
      path,
    }: {
      credentials: ApplicantCredentials
      bucket: 'contracts' | 'employee-documents'
      path: string
    }) => {
      const { data, error } = await supabase.functions.invoke<{ path?: string; error?: string }>('applicant-file', {
        body: { referenceCode: credentials.referenceCode, email: credentials.email, bucket, path },
      })
      if (error || !data?.path) {
        throw new Error(data?.error ?? 'We couldn’t open that file. Please try again.')
      }
      // The function returns only the signed path — the origin is ours to
      // supply, since the one it sees is the internal gateway's.
      return new URL(data.path, import.meta.env.VITE_SUPABASE_URL).toString()
    },
    onSuccess: (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
  })
}

/** Plain-language status for the applicant. The internal labels
 * (applicationStatusLabels.ts) are written for HR and leak process detail an
 * applicant shouldn't be reading. */
export const APPLICANT_STATUS_COPY: Record<Enums<'application_status'>, { label: string; detail: string }> = {
  submitted: {
    label: 'Application Received',
    detail: 'We’ve received your application and it’s waiting to be screened.',
  },
  under_review: {
    label: 'Under Review',
    detail: 'Our HR team is reviewing your application.',
  },
  qualified: {
    label: 'Shortlisted',
    detail: 'You’ve been shortlisted. We’ll be in touch to arrange an interview.',
  },
  interview_scheduled: {
    label: 'Interview Scheduled',
    detail: 'Your interview details are below — please make a note of the date and time.',
  },
  offered: {
    label: 'Job Offer',
    detail: 'Congratulations — you’ve received a job offer. Review it below and let us know your decision.',
  },
  hired: {
    label: 'Offer Stage',
    detail: 'You’ve passed the interview process. Your job offer is being prepared.',
  },
  deployed: {
    label: 'Welcome Aboard',
    detail: 'Your onboarding is complete. Welcome to the team!',
  },
  rejected: {
    label: 'Not Successful',
    detail: 'Thank you for your interest. We won’t be moving forward with this application.',
  },
  closed: {
    label: 'Closed',
    detail: 'This application has been closed.',
  },
}
