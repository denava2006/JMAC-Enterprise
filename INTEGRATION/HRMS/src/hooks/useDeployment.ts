import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import type { Tables } from '@/lib/database.types'
import type { InterviewType } from '@/lib/enums'
import { toast } from '@/components/ui/sonner'
import { deriveDeploymentStage } from '@/lib/deploymentLabels'

const DEPLOYMENT_QUEUE_SELECT = `
  *,
  applicant_first_name, applicant_middle_name, applicant_last_name,
  applicant_email, applicant_phone, applicant_province, applicant_city,
  applicant_barangay, applicant_address,
  applicant_resume_url, applicant_cover_letter,
  applicants (id, first_name, last_name, email, phone, address, province, city, barangay, resume_url, cover_letter),
  job_postings (id, department_id, position_id, employment_type, departments (name), positions (title)),
  job_offers (
    *,
    salary_grades (grade_name),
    preparer:profiles!job_offers_prepared_by_fkey (full_name),
    employment_contracts (*, signer:profiles!employment_contracts_signed_by_fkey (full_name))
  ),
  interviews (*, interviewer:profiles!interviews_interviewer_id_fkey (full_name)),
  deployment_records (*, deployer:profiles!deployment_records_deployed_by_fkey (full_name))
`

export type ContractRecord = Tables<'employment_contracts'> & { signer: { full_name: string } | null }

export type JobOfferRecord = Tables<'job_offers'> & {
  salary_grades: { grade_name: string } | null
  preparer: { full_name: string } | null
  employment_contracts: ContractRecord[]
}

export type InterviewRecord = Tables<'interviews'> & { interviewer: { full_name: string } | null }

export type DeploymentRecordRow = Tables<'deployment_records'> & { deployer: { full_name: string } | null }

export type DeploymentApplication = Tables<'applications'> & {
  applicants: Pick<
    Tables<'applicants'>,
    'id' | 'first_name' | 'last_name' | 'email' | 'phone' | 'address' | 'province' | 'city' | 'barangay' | 'resume_url' | 'cover_letter'
  > | null
  job_postings:
    | (Pick<Tables<'job_postings'>, 'id' | 'department_id' | 'position_id' | 'employment_type'> & {
        departments: { name: string } | null
        positions: { title: string } | null
      })
    | null
  job_offers: JobOfferRecord[]
  interviews: InterviewRecord[]
  // application_id carries its own UNIQUE constraint, so PostgREST treats this
  // as a one-to-one relation (a single row or null) rather than an array —
  // unlike job_offers/interviews, which are genuinely one-to-many.
  deployment_records: DeploymentRecordRow | null
}

function byCreatedAtDesc<T extends { created_at: string }>(rows: T[] | null | undefined): T[] {
  return [...(rows ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function getLatestOffer(app: DeploymentApplication): JobOfferRecord | null {
  return byCreatedAtDesc(app.job_offers)[0] ?? null
}

export function getLatestContract(offer: JobOfferRecord | null): ContractRecord | null {
  if (!offer) return null
  return byCreatedAtDesc(offer.employment_contracts)[0] ?? null
}

export function getFinalInterview(app: DeploymentApplication): InterviewRecord | null {
  return (app.interviews ?? []).find((i) => i.interview_type === ('final' as InterviewType)) ?? null
}

export function getDeploymentRecord(app: DeploymentApplication): DeploymentRecordRow | null {
  return app.deployment_records ?? null
}

const LIST_KEY = ['deployment-applications']

// 'rejected' applicants never reach Deployment. 'closed' ones do appear: an
// applicant who declines leaves a decision HR still has to acknowledge, and
// dropping the row on decline made candidates seem to vanish mid-pipeline.
export function useDeploymentApplications() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('applications')
        .select(DEPLOYMENT_QUEUE_SELECT)
        .in('status', ['hired', 'offered', 'deployed', 'closed'])
        .order('created_at', { ascending: false })
      if (error) throw error
      return data as unknown as DeploymentApplication[]
    },
  })
}

export function useDeploymentApplicationDetail(applicationId: string | undefined) {
  return useQuery({
    queryKey: [...LIST_KEY, applicationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('applications')
        .select(DEPLOYMENT_QUEUE_SELECT)
        .eq('id', applicationId as string)
        .maybeSingle()
      if (error) throw error
      return data as unknown as DeploymentApplication | null
    },
    enabled: !!applicationId,
  })
}

/** Derived client-side from the same list the table already renders — every
 * stat here is a count over pipeline stage, which needs the offer/contract/
 * deployment chain per applicant that a single separate count query per stat
 * can't express cleanly. */
export function useDeploymentStats(applications: DeploymentApplication[] | undefined) {
  return React.useMemo(() => {
    const stats = {
      pendingOffersCount: 0,
      awaitingOfferResponseCount: 0,
      contractsReadyCount: 0,
      waitingForSignatureCount: 0,
      readyForDeploymentCount: 0,
      deployedTodayCount: 0,
    }
    if (!applications) return stats

    const todayStr = new Date().toISOString().slice(0, 10)
    for (const app of applications) {
      const offer = getLatestOffer(app)
      const contract = getLatestContract(offer)
      const deployment = getDeploymentRecord(app)
      const stage = deriveDeploymentStage({
        applicationStatus: app.status,
        offerStatus: offer?.status ?? null,
        contractStatus: contract?.status ?? null,
        hasDeploymentRecord: !!deployment,
      })
      if (stage === 'pending_offer') stats.pendingOffersCount++
      else if (stage === 'awaiting_offer_response') stats.awaitingOfferResponseCount++
      else if (stage === 'contract_draft') stats.contractsReadyCount++
      else if (stage === 'contract_ready') stats.waitingForSignatureCount++
      else if (stage === 'contract_signed') stats.readyForDeploymentCount++

      if (deployment && deployment.deployment_date === todayStr) stats.deployedTodayCount++
    }
    return stats
  }, [applications])
}

function useInvalidateDeployment() {
  const queryClient = useQueryClient()
  return (applicationId: string) => {
    queryClient.invalidateQueries({ queryKey: LIST_KEY })
    queryClient.invalidateQueries({ queryKey: ['application-history', applicationId] })
    // A deployment reaching 'deployed' status is exactly what makes it show up
    // as a pending employee record in the Employee module (see usePendingEmployees).
    queryClient.invalidateQueries({ queryKey: ['pending-employees'] })
  }
}

export interface PrepareJobOfferInput {
  applicationId: string
  employmentType: 'regular' | 'part_time'
  salaryGradeId?: string
  proposedSalary: number
  currency: 'PHP' | 'USD'
  workScheduleId: string
  workingHours?: string
  workingDays?: string
  startDate: string
  additionalCompensation?: string
  notes?: string
}

export function usePrepareJobOffer() {
  const { profile } = useAuth()
  const invalidate = useInvalidateDeployment()
  return useMutation({
    mutationFn: async (input: PrepareJobOfferInput) => {
      const { error: offerError } = await supabase.from('job_offers').insert({
        application_id: input.applicationId,
        employment_type: input.employmentType,
        salary_grade_id: input.salaryGradeId || null,
        proposed_salary: input.proposedSalary,
        currency: input.currency,
        work_schedule_id: input.workScheduleId,
        working_hours: input.workingHours || null,
        working_days: input.workingDays || null,
        start_date: input.startDate,
        additional_compensation: input.additionalCompensation || null,
        notes: input.notes || null,
        prepared_by: profile?.id,
        status: 'pending',
      })
      if (offerError) throw offerError

      const { error: appError } = await supabase
        .from('applications')
        .update({ status: 'offered' })
        .eq('id', input.applicationId)
      if (appError) throw appError

      await supabase.from('application_history').insert({
        application_id: input.applicationId,
        event: 'job_offer_prepared',
        actor_id: profile?.id,
      })
    },
    onSuccess: (_data, { applicationId }) => {
      invalidate(applicationId)
      toast.success('Job Offer Prepared')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useRespondToOffer() {
  const { profile } = useAuth()
  const invalidate = useInvalidateDeployment()
  return useMutation({
    mutationFn: async ({
      applicationId,
      offerId,
      decision,
    }: {
      applicationId: string
      offerId: string
      decision: 'accepted' | 'declined'
    }) => {
      const { error: offerError } = await supabase
        .from('job_offers')
        .update({ status: decision, responded_at: new Date().toISOString() })
        .eq('id', offerId)
      if (offerError) throw offerError

      if (decision === 'declined') {
        const { error: appError } = await supabase
          .from('applications')
          .update({ status: 'closed' })
          .eq('id', applicationId)
        if (appError) throw appError

        await supabase.from('application_history').insert([
          { application_id: applicationId, event: 'offer_declined', actor_id: profile?.id },
          { application_id: applicationId, event: 'application_closed', actor_id: profile?.id },
        ])
      } else {
        await supabase.from('application_history').insert({
          application_id: applicationId,
          event: 'offer_accepted',
          actor_id: profile?.id,
        })
      }
    },
    onSuccess: (_data, { applicationId, decision }) => {
      invalidate(applicationId)
      toast.success(decision === 'accepted' ? 'Offer Accepted' : 'Offer Declined')
    },
    onError: (error) => toast.error(error.message),
  })
}

/** Closes out an offer the applicant never answered. Since responding is now
 * the applicant's own action (via the tracking portal), without this an
 * unanswered offer would keep a requisition open forever. Only offered after
 * RESPONSE_WINDOW_DAYS — see DeploymentDetailsSheet. */
export function useCloseUnresponsiveOffer() {
  const { profile } = useAuth()
  const invalidate = useInvalidateDeployment()
  return useMutation({
    mutationFn: async ({
      applicationId,
      offerId,
      daysWaited,
    }: {
      applicationId: string
      offerId: string
      daysWaited: number
    }) => {
      const { error: offerError } = await supabase
        .from('job_offers')
        .update({ status: 'declined', responded_at: new Date().toISOString() })
        .eq('id', offerId)
        .eq('status', 'pending') // never overwrite a response that just landed
      if (offerError) throw offerError

      const { error: appError } = await supabase
        .from('applications')
        .update({ status: 'closed' })
        .eq('id', applicationId)
      if (appError) throw appError

      await supabase.from('application_history').insert([
        {
          application_id: applicationId,
          event: 'offer_declined',
          notes: `Closed by HR — no response after ${daysWaited} days.`,
          actor_id: profile?.id,
        },
        { application_id: applicationId, event: 'application_closed', actor_id: profile?.id },
      ])
    },
    onSuccess: (_data, { applicationId }) => {
      invalidate(applicationId)
      toast.success('Offer closed — the applicant did not respond in time.')
    },
    onError: (error) => toast.error(error.message),
  })
}

/** HR's acknowledgement of a declined offer. The applicant's decision already
 * stands on the offer itself; this is the deliberate step that ends the
 * application and removes it from the active pipeline. */
export function useCloseDeclinedApplication() {
  const { profile } = useAuth()
  const invalidate = useInvalidateDeployment()
  return useMutation({
    mutationFn: async ({ applicationId }: { applicationId: string }) => {
      const { error } = await supabase.from('applications').update({ status: 'closed' }).eq('id', applicationId)
      if (error) throw error

      await supabase.from('application_history').insert({
        application_id: applicationId,
        event: 'application_closed',
        notes: 'Closed by HR after the applicant declined the offer.',
        actor_id: profile?.id,
      })
    },
    onSuccess: (_data, { applicationId }) => {
      invalidate(applicationId)
      toast.success('Application closed.')
    },
    onError: (error) => toast.error(error.message),
  })
}

export interface PrepareContractInput {
  applicationId: string
  offerId: string
  startDate?: string | null
  companyPolicies?: string
  terms?: string
  additionalNotes?: string
}

export function usePrepareContract() {
  const { profile } = useAuth()
  const invalidate = useInvalidateDeployment()
  return useMutation({
    mutationFn: async (input: PrepareContractInput) => {
      const { error: contractError } = await supabase.from('employment_contracts').insert({
        job_offer_id: input.offerId,
        start_date: input.startDate || null,
        company_policies: input.companyPolicies || null,
        terms: input.terms || null,
        additional_notes: input.additionalNotes || null,
        status: 'draft',
      })
      if (contractError) throw contractError

      await supabase.from('application_history').insert({
        application_id: input.applicationId,
        event: 'contract_prepared',
        actor_id: profile?.id,
      })
    },
    onSuccess: (_data, { applicationId }) => {
      invalidate(applicationId)
      toast.success('Employment contract prepared')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useGenerateContract() {
  const { profile } = useAuth()
  const invalidate = useInvalidateDeployment()
  return useMutation({
    mutationFn: async ({ applicationId, contractId }: { applicationId: string; contractId: string }) => {
      const { error } = await supabase.from('employment_contracts').update({ status: 'printed' }).eq('id', contractId)
      if (error) throw error

      await supabase.from('application_history').insert({
        application_id: applicationId,
        event: 'contract_generated',
        actor_id: profile?.id,
      })
    },
    onSuccess: (_data, { applicationId }) => {
      invalidate(applicationId)
      toast.success('Contract Generated')
    },
    onError: (error) => toast.error(error.message),
  })
}

const ALLOWED_CONTRACT_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png']
const MAX_CONTRACT_FILE_BYTES = 10 * 1024 * 1024

export function validateContractFile(file: File): string | null {
  if (!ALLOWED_CONTRACT_FILE_TYPES.includes(file.type)) {
    return 'Only PDF, JPG, or PNG files are accepted.'
  }
  if (file.size > MAX_CONTRACT_FILE_BYTES) {
    return 'File is too large — the maximum size is 10 MB.'
  }
  return null
}

async function uploadContractFile(contractId: string, file: File): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? 'pdf'
  const path = `${contractId}/${crypto.randomUUID()}.${extension}`
  const { error } = await supabase.storage.from('contracts').upload(path, file, {
    contentType: file.type,
    upsert: false,
  })
  if (error) throw new Error('Could not upload the signed contract file. Please try again.')
  return path
}

export interface RecordSigningInput {
  applicationId: string
  contractId: string
  signedAt: string
  signingNotes?: string
  contractFile?: File
}

export function useRecordContractSigning() {
  const { profile } = useAuth()
  const invalidate = useInvalidateDeployment()
  return useMutation({
    mutationFn: async (input: RecordSigningInput) => {
      const contractFileUrl = input.contractFile ? await uploadContractFile(input.contractId, input.contractFile) : undefined

      const { error } = await supabase
        .from('employment_contracts')
        .update({
          status: 'signed',
          signed_at: input.signedAt,
          signed_by: profile?.id,
          signing_notes: input.signingNotes || null,
          ...(contractFileUrl ? { contract_file_url: contractFileUrl } : {}),
        })
        .eq('id', input.contractId)
      if (error) throw error

      await supabase.from('application_history').insert({
        application_id: input.applicationId,
        event: 'contract_signed',
        actor_id: profile?.id,
      })
    },
    onSuccess: (_data, { applicationId }) => {
      invalidate(applicationId)
      toast.success('Contract Signed')
    },
    onError: (error) => toast.error(error.message),
  })
}

export interface CompleteDeploymentInput {
  applicationId: string
  deploymentDate: string
  branchId: string
  workLocationId: string
  workScheduleId: string
  assignedBranch?: string
  workLocation?: string
  remarks?: string
}

export function useCompleteDeployment() {
  const { profile } = useAuth()
  const invalidate = useInvalidateDeployment()
  return useMutation({
    mutationFn: async (input: CompleteDeploymentInput) => {
      const { error: deploymentError } = await supabase.from('deployment_records').insert({
        application_id: input.applicationId,
        deployment_date: input.deploymentDate,
        branch_id: input.branchId,
        work_location_id: input.workLocationId,
        work_schedule_id: input.workScheduleId,
        assigned_branch: input.assignedBranch || null,
        work_location: input.workLocation || null,
        remarks: input.remarks || null,
        deployed_by: profile?.id,
      })
      if (deploymentError) throw deploymentError

      const { error: appError } = await supabase
        .from('applications')
        .update({ status: 'deployed' })
        .eq('id', input.applicationId)
      if (appError) throw appError

      await supabase.from('application_history').insert([
        { application_id: input.applicationId, event: 'deployment_completed', actor_id: profile?.id },
        { application_id: input.applicationId, event: 'pending_employee_record_created', actor_id: profile?.id },
      ])
      // No employees row exists yet at this point (see usePendingEmployees) — the
      // application itself is the only record to anchor this audit entry to.
      await supabase.from('audit_logs').insert({
        actor_id: profile?.id,
        action: 'Pending Employee Record Created',
        table_name: 'applications',
        record_id: input.applicationId,
      })
    },
    onSuccess: (_data, { applicationId }) => {
      invalidate(applicationId)
      toast.success('Employee Deployed Successfully')
      toast.success('Pending employee record created.')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useContractFileSignedUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ['contract-file-signed-url', path],
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('contracts').createSignedUrl(path as string, 300)
      if (error) throw error
      return data.signedUrl
    },
    enabled: !!path,
    staleTime: 4 * 60 * 1000,
  })
}

/** Live toasts for HR staff who have the Deployment page open. */
export function useDeploymentRealtimeAlerts() {
  const queryClient = useQueryClient()

  React.useEffect(() => {
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: LIST_KEY })
    }

    const channel = supabase
      .channel('deployment-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_offers' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employment_contracts' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployment_records' }, refresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'applications' }, refresh)
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])
}
