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

/** The extension a stored resume gets, decided by its VALIDATED type rather
 *  than by whatever the file was called. A filename is applicant-supplied
 *  text: "cv.pdf.exe" would otherwise be stored as an .exe object. */
const EXTENSION_FOR_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

/** Storage tells us why it refused. These are the two reasons an applicant can
 *  do something about; everything else stays generic, because the detail would
 *  be about our bucket rather than about their file. */
function describeUploadFailure(message: string): string {
  const text = message.toLowerCase()
  if (text.includes('exceeded') || text.includes('too large') || text.includes('payload')) {
    return `Resume is too large. Maximum size is ${MAX_RESUME_BYTES / (1024 * 1024)} MB.`
  }
  if (text.includes('mime') || text.includes('content type') || text.includes('not supported')) {
    return 'Unsupported file type. Upload a PDF or DOCX.'
  }
  return 'We could not upload your resume. Please try again.'
}

/** A government ID is a scan or a photograph. Word documents are deliberately
 *  not accepted: an ID is not something you author. */
const ID_EXTENSION_FOR_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

const MAX_ID_BYTES = 5 * 1024 * 1024

/** Exactly what Create Employee offers, so an application's answer transfers
 *  onto the employee record without translation. */
export const APPLICANT_GENDER_OPTIONS = ['Male', 'Female', 'Other'] as const

export function validateGovernmentIdFile(file: File | undefined | null): string | null {
  if (!file) return 'Please attach a valid government ID.'
  if (!ID_EXTENSION_FOR_TYPE[file.type]) {
    return 'Unsupported file type. Upload a PDF, JPG or PNG.'
  }
  if (file.size > MAX_ID_BYTES) {
    return `Government ID is too large — the maximum size is ${MAX_ID_BYTES / (1024 * 1024)} MB.`
  }
  return null
}

/**
 * The ID goes into its own private bucket.
 *
 * Kept apart from resumes on purpose. It is sensitive identity information with
 * a different audience and a different retention question, and mixing the two
 * is how a CV ends up filed as somebody's proof of identity. The applicant can
 * write here and nothing else: no listing, no reading back, no replacing.
 */
async function uploadGovernmentId(jobPostingId: string, file: File): Promise<string> {
  const rejection = validateGovernmentIdFile(file)
  if (rejection) throw new Error(rejection)

  const extension = ID_EXTENSION_FOR_TYPE[file.type]
  if (!extension) throw new Error('Unsupported file type. Upload a PDF, JPG or PNG.')

  // Generated end to end, like the resume path: nothing the applicant typed
  // reaches the object name, and upsert:false means a collision is refused
  // rather than quietly overwriting somebody's ID.
  const path = `${jobPostingId}/${crypto.randomUUID()}.${extension}`

  const { error } = await supabase.storage.from('government-ids').upload(path, file, {
    contentType: file.type,
    upsert: false,
  })

  if (error) {
    console.error('Government ID upload failed:', error.message)
    throw new Error('We could not upload your government ID. Please try again.')
  }
  return path
}

async function uploadResume(jobPostingId: string, file: File): Promise<string> {
  // Re-checked here even though the form checks too: this is the last point
  // before the file leaves the browser, and the type decides the stored name.
  const rejection = validateResumeFile(file)
  if (rejection) throw new Error(rejection)

  const extension = EXTENSION_FOR_TYPE[file.type]
  if (!extension) throw new Error('Unsupported file type. Upload a PDF or DOCX.')

  // The whole object name is generated: a job id we already trust, and a fresh
  // uuid. Nothing an applicant typed reaches the path, so two people uploading
  // "resume.pdf" cannot collide and neither can overwrite the other -- and
  // upsert:false means a repeat would be refused rather than silently replace.
  const path = `${jobPostingId}/${crypto.randomUUID()}.${extension}`

  const { error } = await supabase.storage.from('resumes').upload(path, file, {
    contentType: file.type,
    upsert: false,
  })

  if (error) {
    // The technical reason is worth keeping, but only where a developer looks.
    console.error('Resume upload failed:', error.message)
    throw new Error(describeUploadFailure(error.message))
  }
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
  birthDate: string
  gender: string
  nationality: string
  resumeFile: File
  governmentIdFile: File
}

const FRIENDLY_APPLICATION_ERRORS: Record<string, string> = {
  JOB_NOT_FOUND: 'This job posting could not be found.',
  JOB_CLOSED: 'This job posting is no longer accepting applications.',
  DUPLICATE_APPLICATION: 'You’ve already applied to this job with this email address.',
  // The rule, in the applicant's words. The server decides it -- the form
  // checks too, but a modified request is refused all the same.
  UNDERAGE_APPLICANT: 'Applicants must be at least 18 years old.',
  BIRTH_DATE_REQUIRED: 'Please enter your date of birth.',
  BIRTH_DATE_INVALID: 'Please check your date of birth.',
  GOVERNMENT_ID_REQUIRED: 'Please attach a valid government ID.',
  RESUME_REQUIRED: 'Please attach your resume.',
  GENDER_REQUIRED: 'Please select your gender.',
  GENDER_INVALID: 'Please select your gender.',
  NATIONALITY_REQUIRED: 'Please enter your nationality.',
}

export function useSubmitApplication() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: SubmitApplicationInput) => {
      const resumePath = await uploadResume(input.jobPostingId, input.resumeFile)
      const governmentIdPath = await uploadGovernmentId(input.jobPostingId, input.governmentIdFile)

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
        p_birth_date: input.birthDate,
        p_government_id_path: governmentIdPath,
        p_gender: input.gender,
        p_nationality: input.nationality,
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
