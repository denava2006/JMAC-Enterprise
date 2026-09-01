import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

/**
 * The public Careers data.
 *
 * These used to query job_postings directly and embed departments(name) and
 * positions(title). That failed anonymously with
 *
 *   401 {"code":"42501","message":"permission denied for function is_active_staff"}
 *
 * because a staff RLS policy on job_postings targeted the `public` role, which
 * includes anon, so an anonymous request had to evaluate a function it is not
 * allowed to call. It also only ever worked because anon could read the WHOLE
 * departments and positions tables.
 *
 * Both are gone. The public surface is now two functions that return exactly
 * the applicant-safe fields and decide visibility server-side, so the shape
 * here is deliberately NOT the job_postings row: there is no posted_by, no
 * created_at, no HR metadata to leak onto a public page by accident.
 */
export interface PublicJobPosting {
  id: string
  department_name: string | null
  position_title: string | null
  description: string | null
  requirements: string | null
  employment_type: string | null
  vacancies: number | null
  status: string
  closing_date: string | null
  date_posted: string | null
}

const QUERY_KEY = ['public-job-postings']

/**
 * Postings the public may see.
 *
 * The server already restricts this to open postings that have not passed
 * their closing date, so there is no client-side filtering to forget.
 */
export function usePublicOpenJobPostings() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_public_job_postings')
      if (error) throw error
      return (data ?? []) as PublicJobPosting[]
    },
    staleTime: 60_000,
  })
}

export function usePublicJobPosting(jobId: string | undefined) {
  return useQuery({
    queryKey: [...QUERY_KEY, jobId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_public_job_posting', { _id: jobId as string })
      if (error) throw error
      // The function applies the same visibility rule as the list, so a draft,
      // closed or expired posting comes back as no rows rather than as data.
      const rows = (data ?? []) as PublicJobPosting[]
      return rows[0] ?? null
    },
    enabled: !!jobId,
    staleTime: 60_000,
  })
}

/**
 * Department names for the Careers filter, derived from the postings already
 * on screen.
 *
 * The filter used to load the entire departments table anonymously, which
 * exposed the company's org structure to anyone who opened the page. Every
 * department worth filtering by is one that has a visible posting, so the
 * postings are the better source and no extra request is needed.
 */
export function departmentsFromPostings(postings: PublicJobPosting[] | undefined): string[] {
  const names = new Set<string>()
  for (const p of postings ?? []) {
    if (p.department_name) names.add(p.department_name)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/** True once a posting's own closing date has passed, even if HR hasn't flipped its status to 'closed' yet. */
export function isPastClosingDate(closingDate: string | null): boolean {
  if (!closingDate) return false
  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return closingDate < todayIso
}

export function isAcceptingApplications(posting: Pick<PublicJobPosting, 'status' | 'closing_date'>): boolean {
  return posting.status === 'open' && !isPastClosingDate(posting.closing_date)
}

const ALLOWED_RESUME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]
const MAX_RESUME_BYTES = 5 * 1024 * 1024

export function validateResumeFile(file: File): string | null {
  if (!ALLOWED_RESUME_TYPES.includes(file.type)) {
    return 'Only PDF, DOC, or DOCX files are accepted.'
  }
  if (file.size > MAX_RESUME_BYTES) {
    return 'File is too large — the maximum size is 5 MB.'
  }
  return null
}

async function uploadResume(jobPostingId: string, file: File): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? 'pdf'
  const path = `${jobPostingId}/${crypto.randomUUID()}.${extension}`
  const { error } = await supabase.storage.from('resumes').upload(path, file, {
    contentType: file.type,
    upsert: false,
  })
  if (error) throw new Error('Could not upload your resume. Please try again.')
  return path
}

export interface SubmitApplicationInput {
  jobPostingId: string
  firstName: string
  middleName: string
  lastName: string
  email: string
  phone: string
  address: string
  province: string
  city: string
  barangay: string
  coverLetter?: string
  resumeFile: File
}

const FRIENDLY_APPLICATION_ERRORS: Record<string, string> = {
  JOB_NOT_FOUND: 'This job posting could not be found.',
  JOB_CLOSED: 'This job posting is no longer accepting applications.',
  DUPLICATE_APPLICATION: 'You’ve already applied to this job with this email address.',
}

export function useSubmitApplication() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: SubmitApplicationInput) => {
      const resumePath = await uploadResume(input.jobPostingId, input.resumeFile)

      const { data, error } = await supabase.rpc('submit_job_application', {
        p_job_posting_id: input.jobPostingId,
        p_first_name: input.firstName,
        p_middle_name: input.middleName || undefined,
        p_last_name: input.lastName,
        p_email: input.email,
        p_phone: input.phone,
        p_address: input.address,
        p_province: input.province,
        p_city: input.city,
        p_barangay: input.barangay,
        p_resume_path: resumePath,
        p_cover_letter: input.coverLetter || undefined,
      })

      if (error) {
        const friendly = FRIENDLY_APPLICATION_ERRORS[error.message]
        throw new Error(friendly ?? 'We couldn’t submit your application. Please try again.')
      }

      return data?.[0] ?? null
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}
