import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import type { Tables } from '@/lib/database.types'
import type { InterviewType } from '@/lib/enums'
import { toast } from '@/components/ui/sonner'
import { APPLICATION_STATUS_LABEL } from '@/lib/applicationStatusLabels'

const NOTIFICATION_LOG_ONLY_NOTE = 'No email provider is configured yet — this is logged only, not delivered.'

const INTERVIEW_QUEUE_SELECT = `
  *,
  applicants (id, first_name, last_name, email, phone, address, province, city, barangay, resume_url, cover_letter),
  job_postings (id, department_id, position_id, departments (name), positions (title)),
  reviewer:profiles!applications_reviewed_by_fkey (full_name),
  final_interviewer:profiles!applications_final_interviewer_id_fkey (id, full_name),
  interviews (*, interviewer:profiles!interviews_interviewer_id_fkey (full_name))
`

export type InterviewRecord = Tables<'interviews'> & { interviewer: { full_name: string } | null }

export type InterviewApplication = Tables<'applications'> & {
  applicants: Pick<
    Tables<'applicants'>,
    'id' | 'first_name' | 'last_name' | 'email' | 'phone' | 'address' | 'province' | 'city' | 'barangay' | 'resume_url' | 'cover_letter'
  > | null
  job_postings:
    | (Pick<Tables<'job_postings'>, 'id' | 'department_id' | 'position_id'> & {
        departments: { name: string } | null
        positions: { title: string } | null
      })
    | null
  reviewer: { full_name: string } | null
  final_interviewer: { id: string; full_name: string } | null
  interviews: InterviewRecord[]
}

export function getInterviewByStage(interviews: InterviewRecord[], stage: InterviewType) {
  return interviews.find((i) => i.interview_type === stage) ?? null
}

const LIST_KEY = ['interview-applications']
const STATS_KEY = ['interview-stats']

/** HR Managers available to take a final interview. HR Staff picks one of these
 * when passing an applicant out of the initial round — the final interview is
 * theirs to run, so there is nobody else to assign it to. */
export interface FinalInterviewerOption {
  id: string
  full_name: string
  email: string
  /** True for an Administrator standing in because no HR Manager exists. */
  isFallback: boolean
}

/**
 * Who may run the final interview.
 *
 * An HR Manager normally, and an Administrator as a fallback. This asked only
 * for hr_manager, which produced a production dead end: with no HR Manager on
 * the system an initial interview could not be passed at all, so recruitment
 * stopped at the first candidate.
 *
 * The database has always allowed both -- protect_final_interviewer_assignment
 * accepts `role in ('hr_manager','admin') and status = 'active'` -- so this is
 * the screen catching up with the rule, not the rule being widened. HR Staff
 * remain excluded on both sides.
 *
 * Administrators are listed last and marked, so a real HR Manager is the
 * obvious choice whenever one exists.
 */
export function useAvailableFinalInterviewers() {
  return useQuery({
    queryKey: ['available-final-interviewers'],
    queryFn: async (): Promise<FinalInterviewerOption[]> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, role')
        .in('role', ['hr_manager', 'admin'])
        .eq('status', 'active')
        .order('full_name')
      if (error) throw error

      const rows = (data ?? []) as { id: string; full_name: string; email: string; role: string }[]
      return rows
        .map((r) => ({
          id: r.id,
          full_name: r.full_name,
          email: r.email,
          isFallback: r.role === 'admin',
        }))
        .sort((a, b) =>
          a.isFallback === b.isFallback
            ? a.full_name.localeCompare(b.full_name)
            : a.isFallback
              ? 1
              : -1
        )
    },
  })
}

// Applicants rejected during Recruitment screening (status='rejected', no interview
// ever scheduled) never entered this module's pipeline and must not show up here.
function belongsInInterviewQueue(row: InterviewApplication) {
  return row.status !== 'rejected' || row.interviews.length > 0
}

/** Whose queue this applicant is in.
 *
 * Once HR Staff nominates an HR Manager for the final round, the applicant
 * leaves HR Staff's queue and appears in that manager's — and in no other
 * manager's. Before the hand-off they're HR Staff's, since scheduling and
 * running the initial interview is HR Staff's work.
 *
 * Administrators see everything, as everywhere else. */
function isInMyInterviewQueue(row: InterviewApplication, role: string | undefined, profileId: string | undefined): boolean {
  if (role === 'admin') return true
  if (role === 'hr_manager') return row.final_interviewer_id === profileId
  return row.final_interviewer_id === null
}

export function useInterviewApplications() {
  const { profile } = useAuth()
  return useQuery({
    queryKey: [...LIST_KEY, profile?.id, profile?.role],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('applications')
        .select(INTERVIEW_QUEUE_SELECT)
        .in('status', ['qualified', 'interview_scheduled', 'hired', 'rejected'])
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data as unknown as InterviewApplication[])
        .filter(belongsInInterviewQueue)
        .filter((row) => isInMyInterviewQueue(row, profile?.role, profile?.id))
    },
    enabled: !!profile,
  })
}

export function useInterviewApplicationDetail(applicationId: string | undefined) {
  return useQuery({
    queryKey: [...LIST_KEY, applicationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('applications')
        .select(INTERVIEW_QUEUE_SELECT)
        .eq('id', applicationId as string)
        .maybeSingle()
      if (error) throw error
      return data as unknown as InterviewApplication | null
    },
    enabled: !!applicationId,
  })
}

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function startOfTomorrow() {
  const d = new Date()
  d.setHours(24, 0, 0, 0)
  return d.toISOString()
}

export function useInterviewStats() {
  return useQuery({
    queryKey: STATS_KEY,
    queryFn: async () => {
      const count = (query: PromiseLike<{ count: number | null }>) => query.then((r) => r.count ?? 0)
      const todayStart = startOfToday()
      const todayEnd = startOfTomorrow()
      const [scheduledCount, initialTodayCount, finalTodayCount, underInterviewCount, hiredCount, rejectedCount] =
        await Promise.all([
          count(supabase.from('interviews').select('*', { count: 'exact', head: true }).eq('status', 'scheduled')),
          count(
            supabase
              .from('interviews')
              .select('*', { count: 'exact', head: true })
              .eq('interview_type', 'initial')
              .eq('status', 'scheduled')
              .gte('scheduled_at', todayStart)
              .lt('scheduled_at', todayEnd)
          ),
          count(
            supabase
              .from('interviews')
              .select('*', { count: 'exact', head: true })
              .eq('interview_type', 'final')
              .eq('status', 'scheduled')
              .gte('scheduled_at', todayStart)
              .lt('scheduled_at', todayEnd)
          ),
          count(supabase.from('interviews').select('*', { count: 'exact', head: true }).eq('status', 'completed')),
          count(supabase.from('applications').select('*', { count: 'exact', head: true }).eq('status', 'hired')),
          count(supabase.from('interviews').select('*', { count: 'exact', head: true }).eq('status', 'failed')),
        ])
      return { scheduledCount, initialTodayCount, finalTodayCount, underInterviewCount, hiredCount, rejectedCount }
    },
  })
}

function useInvalidateInterviews() {
  const queryClient = useQueryClient()
  return (applicationId: string) => {
    queryClient.invalidateQueries({ queryKey: LIST_KEY })
    queryClient.invalidateQueries({ queryKey: STATS_KEY })
    queryClient.invalidateQueries({ queryKey: ['application-history', applicationId] })
  }
}

export interface ScheduleInterviewInput {
  applicationId: string
  stage: InterviewType
  scheduledAt: string
  mode: 'online' | 'face_to_face'
  meetingLink?: string
  location?: string
  notes?: string
}

/** The HR staff member who schedules an interview automatically becomes its
 * assigned interviewer — there is no manual assignment. The RLS policy
 * interviews_insert_owner enforces this server-side regardless of what the
 * client sends (self-assign only, and a final interview can only be inserted
 * by whoever owns the corresponding initial interview). */
export function useScheduleInterview() {
  const { profile } = useAuth()
  const invalidate = useInvalidateInterviews()
  return useMutation({
    mutationFn: async (input: ScheduleInterviewInput) => {
      const { error: insertError } = await supabase.from('interviews').insert({
        application_id: input.applicationId,
        interview_type: input.stage,
        scheduled_at: input.scheduledAt,
        interviewer_id: profile?.id,
        mode: input.mode,
        meeting_link: input.meetingLink || null,
        location: input.location || null,
        remarks: input.notes || null,
        status: 'scheduled',
      })
      if (insertError) throw insertError

      if (input.stage === 'initial') {
        const { error: appError } = await supabase
          .from('applications')
          .update({ status: 'interview_scheduled' })
          .eq('id', input.applicationId)
        if (appError) throw appError
      }

      await supabase.from('application_history').insert([
        {
          application_id: input.applicationId,
          event: input.stage === 'initial' ? 'initial_interview_scheduled' : 'final_interview_scheduled',
          actor_id: profile?.id,
        },
        {
          application_id: input.applicationId,
          event: 'interview_scheduled_email_queued',
          notes: NOTIFICATION_LOG_ONLY_NOTE,
          actor_id: profile?.id,
        },
      ])
    },
    onSuccess: (_data, { applicationId }) => {
      invalidate(applicationId)
      toast.success('Interview scheduled')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useConductInterview() {
  const { profile } = useAuth()
  const invalidate = useInvalidateInterviews()
  return useMutation({
    mutationFn: async ({
      interviewId,
      applicationId,
      stage,
    }: {
      interviewId: string
      applicationId: string
      stage: InterviewType
    }) => {
      const { error } = await supabase.from('interviews').update({ status: 'completed' }).eq('id', interviewId)
      if (error) throw error

      await supabase.from('application_history').insert({
        application_id: applicationId,
        event: stage === 'initial' ? 'initial_interview_started' : 'final_interview_started',
        actor_id: profile?.id,
      })
    },
    onSuccess: (_data, { applicationId }) => invalidate(applicationId),
    onError: (error) => toast.error(error.message),
  })
}

export interface InitialEvaluationInput {
  interviewId: string
  applicationId: string
  decision: 'passed' | 'failed'
  ratings: {
    communication?: number
    technicalSkills?: number
    confidence?: number
    experience?: number
    problemSolving?: number
  }
  overallImpression?: string
  interviewNotes?: string
  rejectionReason?: string
  /** Required when passing: the HR Manager who will run the final interview. */
  finalInterviewerId?: string
}

export function useSubmitInitialEvaluation() {
  const { profile } = useAuth()
  const invalidate = useInvalidateInterviews()
  return useMutation({
    mutationFn: async (input: InitialEvaluationInput) => {
      const { error: interviewError } = await supabase
        .from('interviews')
        .update({
          status: input.decision,
          rating_communication: input.ratings.communication ?? null,
          rating_technical_skills: input.ratings.technicalSkills ?? null,
          rating_confidence: input.ratings.confidence ?? null,
          rating_experience: input.ratings.experience ?? null,
          rating_problem_solving: input.ratings.problemSolving ?? null,
          overall_impression: input.overallImpression || null,
          interview_notes: input.interviewNotes || null,
          rejection_reason: input.decision === 'failed' ? input.rejectionReason : null,
        })
        .eq('id', input.interviewId)
      if (interviewError) throw interviewError

      if (input.decision === 'failed') {
        const { error: appError } = await supabase
          .from('applications')
          .update({ status: 'rejected', rejection_reason: input.rejectionReason })
          .eq('id', input.applicationId)
        if (appError) throw appError

        await supabase.from('application_history').insert([
          {
            application_id: input.applicationId,
            event: 'initial_interview_rejected',
            notes: input.rejectionReason,
            actor_id: profile?.id,
          },
          {
            application_id: input.applicationId,
            event: 'rejection_email_queued',
            notes: NOTIFICATION_LOG_ONLY_NOTE,
            actor_id: profile?.id,
          },
        ])
      } else {
        // Hand the applicant off: from here the final round belongs to the
        // nominated HR Manager, and the interviews_insert_owner policy will
        // only let that person schedule it.
        const { error: assignError } = await supabase
          .from('applications')
          .update({ final_interviewer_id: input.finalInterviewerId })
          .eq('id', input.applicationId)
        if (assignError) throw assignError

        await supabase.from('application_history').insert([
          {
            application_id: input.applicationId,
            event: 'initial_interview_passed',
            actor_id: profile?.id,
          },
          {
            application_id: input.applicationId,
            event: 'final_interview_assigned',
            actor_id: profile?.id,
          },
        ])
      }
    },
    onSuccess: (_data, { applicationId, decision }) => {
      invalidate(applicationId)
      toast.success(decision === 'passed' ? 'Applicant passed the initial interview' : 'Applicant rejected')
    },
    onError: (error) => toast.error(error.message),
  })
}

export interface FinalEvaluationInput {
  interviewId: string
  applicationId: string
  decision: 'passed' | 'failed'
  ratings: {
    technicalEvaluation?: number
    cultureFit?: number
    leadership?: number
  }
  finalRemarks?: string
  rejectionReason?: string
}

export function useSubmitFinalEvaluation() {
  const { profile } = useAuth()
  const invalidate = useInvalidateInterviews()
  return useMutation({
    mutationFn: async (input: FinalEvaluationInput) => {
      const { error: interviewError } = await supabase
        .from('interviews')
        .update({
          status: input.decision,
          rating_technical_evaluation: input.ratings.technicalEvaluation ?? null,
          rating_culture_fit: input.ratings.cultureFit ?? null,
          rating_leadership: input.ratings.leadership ?? null,
          final_remarks: input.finalRemarks || null,
          rejection_reason: input.decision === 'failed' ? input.rejectionReason : null,
        })
        .eq('id', input.interviewId)
      if (interviewError) throw interviewError

      if (input.decision === 'failed') {
        const { error: appError } = await supabase
          .from('applications')
          .update({ status: 'rejected', rejection_reason: input.rejectionReason })
          .eq('id', input.applicationId)
        if (appError) throw appError

        await supabase.from('application_history').insert([
          {
            application_id: input.applicationId,
            event: 'final_interview_rejected',
            notes: input.rejectionReason,
            actor_id: profile?.id,
          },
          {
            application_id: input.applicationId,
            event: 'rejection_email_queued',
            notes: NOTIFICATION_LOG_ONLY_NOTE,
            actor_id: profile?.id,
          },
        ])
      } else {
        const { error: appError } = await supabase
          .from('applications')
          .update({ status: 'hired' })
          .eq('id', input.applicationId)
        if (appError) throw appError

        await supabase.from('application_history').insert([
          { application_id: input.applicationId, event: 'hired', actor_id: profile?.id },
          {
            application_id: input.applicationId,
            event: 'hired_email_queued',
            notes: NOTIFICATION_LOG_ONLY_NOTE,
            actor_id: profile?.id,
          },
        ])
      }
    },
    onSuccess: (_data, { applicationId, decision }) => {
      invalidate(applicationId)
      toast.success(decision === 'passed' ? 'Applicant hired — ready for Deployment' : 'Applicant rejected')
    },
    onError: (error) => toast.error(error.message),
  })
}

/** Live toasts for HR staff who have the Interview Management page open. */
export function useInterviewRealtimeAlerts() {
  const queryClient = useQueryClient()

  React.useEffect(() => {
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: LIST_KEY })
      queryClient.invalidateQueries({ queryKey: STATS_KEY })
    }

    const channel = supabase
      .channel('interview-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'interviews' }, () => {
        refresh()
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'applications' }, (payload) => {
        const oldStatus = (payload.old as { status?: string } | null)?.status
        const newStatus = (payload.new as { status?: string } | null)?.status
        const relevant: string[] = ['interview_scheduled', 'hired', 'rejected']
        if (newStatus && oldStatus && newStatus !== oldStatus && relevant.includes(newStatus)) {
          const label = APPLICATION_STATUS_LABEL[newStatus as keyof typeof APPLICATION_STATUS_LABEL] ?? newStatus
          toast.info(`Application status changed to ${label}`)
        }
        refresh()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])
}
