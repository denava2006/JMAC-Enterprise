import * as React from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { AlertCircle, ArrowLeft, FileText, Upload, X, Briefcase, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { AddressFields, type AddressValue } from '@/components/AddressFields'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { employmentTypeLabel } from '@/lib/jobPostingLabels'
import { RESPONSE_WINDOW_DAYS } from '@/lib/applicationSla'
import {
  usePublicJobPosting,
  useSubmitApplication,
  isAcceptingApplications,
  validateResumeFile,
  validateGovernmentIdFile,
} from '@/hooks/usePublicCareers'

// Letters with single spaces, hyphens, or apostrophes between them — no digits,
// no other symbols, and no leading/trailing or doubled-up separators.
const nameRegex = /^[A-Za-z]+(?:[ '-][A-Za-z]+)*$/
const nameField = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(100)
    .regex(nameRegex, `${label} can only contain letters, spaces, hyphens, and apostrophes`)

// Philippine mobile numbers only: exactly 11 digits, starting with 09.
const phoneRegex = /^09\d{9}$/

const applicationSchema = z.object({
  firstName: nameField('First name'),
  middleName: nameField('Middle name'),
  lastName: nameField('Last name'),
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  phone: z
    .string()
    .min(1, 'Phone number is required')
    .regex(phoneRegex, 'Enter a valid Philippine mobile number (11 digits, starting with 09)'),
  // The administrative parts come from the location list; only the street
  // line is typed. Kept in the same schema so one submit handler validates
  // the whole form.
  province: z.string().trim().min(1, 'Province is required'),
  city: z.string().trim().min(1, 'City or municipality is required'),
  barangay: z.string().trim().min(1, 'Barangay is required'),
  address: z.string().trim().min(1, 'Residential address is required').max(500),
  coverLetter: z.string().max(2000, 'Cover letter cannot exceed 2,000 characters').optional(),
  // Checked here so the applicant is told before they submit, and again by the
  // database, which is what actually decides it. Real date arithmetic in both
  // places: somebody born on 2 September 2008 is 18 on 2 September 2026 and
  // seventeen the day before, which subtracting years would get wrong.
  birthDate: z
    .string()
    .min(1, 'Date of birth is required')
    .refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a valid date')
    .refine((value) => {
      const dob = new Date(value)
      const eighteenth = new Date(dob.getFullYear() + 18, dob.getMonth(), dob.getDate())
      return eighteenth <= new Date()
    }, 'Applicants must be at least 18 years old.'),
})
type ApplicationFormValues = z.infer<typeof applicationSchema>

/** The latest date of birth that is already 18 today, as yyyy-mm-dd for the
 *  date input's `max`. Computed from the real calendar rather than by
 *  subtracting 18 from the year. */
function eighteenYearsAgoISO(): string {
  const now = new Date()
  const d = new Date(now.getFullYear() - 18, now.getMonth(), now.getDate())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const eighteenYearsAgo = eighteenYearsAgoISO()

/** Strips everything but digits and caps the length at 11, as the user types —
 * so letters, +, -, /, *, ., (), and spaces can never even be entered. */
function sanitizePhoneInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 11)
}

/** Same idea as sanitizePhoneInput, for names: digits and symbols can never be
 * typed in at all, rather than only being caught by the schema on submit. */
function sanitizeNameInput(raw: string): string {
  return raw.replace(/[^A-Za-z '-]/g, '').slice(0, 100)
}

function formatFileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One dropzone, used for both documents.
 *
 *  Parameterised rather than copied, because the two must not drift: an ID and
 *  a CV accept different types and are stored in different buckets, and the
 *  quickest way to file a resume as somebody's proof of identity is two
 *  near-identical components that slowly converge. */
function FileDropzone({
  file,
  onSelect,
  error,
  inputId,
  label,
  hint,
  accept,
  validate,
}: {
  file: File | null
  onSelect: (file: File | null, error: string | null) => void
  error: string | null
  inputId: string
  label: string
  hint: string
  accept: string
  validate: (file: File) => string | null
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = React.useState(false)

  const handleFiles = (files: FileList | null) => {
    const picked = files?.[0]
    if (!picked) return
    const validationError = validate(picked)
    onSelect(validationError ? null : picked, validationError)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>
        {label} <span className="text-destructive">*</span>
      </Label>
      {file ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-card px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-secondary" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
              <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onSelect(null, null)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Remove selected ${label}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragActive(false)
            handleFiles(e.dataTransfer.files)
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center gap-2 rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors',
            dragActive ? 'border-secondary bg-secondary/5' : 'border-input hover:border-secondary/50',
            error && 'border-destructive'
          )}
        >
          <Upload className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-foreground">
            <span className="font-medium text-secondary">Click to upload</span> or drag and drop
          </p>
          <p className="text-xs text-muted-foreground">{hint}</p>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={accept}
            className="sr-only"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function ApplyPageSkeleton() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="mt-6 h-8 w-2/3" />
      <Skeleton className="mt-8 h-96 w-full" />
    </div>
  )
}

export default function ApplyPage() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const { data: posting, isLoading } = usePublicJobPosting(jobId)
  const submitApplication = useSubmitApplication()

  const [resumeFile, setResumeFile] = React.useState<File | null>(null)
  const [governmentIdFile, setGovernmentIdFile] = React.useState<File | null>(null)
  const [governmentIdError, setGovernmentIdError] = React.useState<string | null>(null)
  const [resumeError, setResumeError] = React.useState<string | null>(null)
  const [submitError, setSubmitError] = React.useState<string | null>(null)

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ApplicationFormValues>({ resolver: zodResolver(applicationSchema) })
  const phoneField = register('phone')

  if (isLoading) return <ApplyPageSkeleton />

  if (!posting) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 px-4 py-24 text-center sm:px-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Briefcase className="h-8 w-8" />
        </div>
        <h1 className="font-display text-2xl font-bold text-foreground">Job posting not found</h1>
        <Button asChild>
          <Link to="/careers">Browse open positions</Link>
        </Button>
      </div>
    )
  }

  if (!isAcceptingApplications(posting)) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 px-4 py-24 text-center sm:px-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Briefcase className="h-8 w-8" />
        </div>
        <h1 className="font-display text-2xl font-bold text-foreground">Applications Closed</h1>
        <p className="max-w-md text-muted-foreground">
          "{posting.position_title ?? 'This position'}" is no longer accepting applications. Take a look at our
          other open roles.
        </p>
        <Button asChild>
          <Link to="/careers">Browse open positions</Link>
        </Button>
      </div>
    )
  }

  const onSubmit = async (values: ApplicationFormValues) => {
    setSubmitError(null)
    if (!resumeFile) {
      setResumeError('Please attach your resume to continue.')
      return
    }
    if (!governmentIdFile) {
      setGovernmentIdError('Please attach a valid government ID to continue.')
      return
    }

    try {
      const submitted = await submitApplication.mutateAsync({
        jobPostingId: posting.id,
        firstName: values.firstName,
        middleName: values.middleName,
        lastName: values.lastName,
        email: values.email,
        phone: values.phone,
        address: values.address,
        province: values.province,
        city: values.city,
        barangay: values.barangay,
        coverLetter: values.coverLetter,
        birthDate: values.birthDate,
        resumeFile,
        governmentIdFile,
      })
      navigate('/careers/application-success', {
        replace: true,
        state: {
          jobTitle: posting.position_title ?? undefined,
          referenceCode: submitted?.reference_code,
          email: values.email,
        },
      })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="mx-auto max-w-2xl px-4 py-16 sm:px-6"
    >
      <Link
        to={`/careers/${posting.id}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to job details
      </Link>

      <div className="mt-6">
        <h1 className="font-display text-2xl font-bold text-foreground sm:text-3xl">Apply for this role</h1>
        <Card className="mt-4">
          <CardContent className="flex flex-col gap-1.5 p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              {posting.department_name && <Badge variant="secondary">{posting.department_name}</Badge>}
              <Badge variant="outline">{employmentTypeLabel(posting.employment_type)}</Badge>
            </div>
            <p className="font-display text-base font-semibold text-foreground">
              {posting.position_title ?? 'Open Position'}
            </p>
          </CardContent>
        </Card>
      </div>

      <form className="mt-8 flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        {submitError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="firstName">
              First name <span className="text-destructive">*</span>
            </Label>
            <Controller
              control={control}
              name="firstName"
              render={({ field }) => (
                <Input
                  id="firstName"
                  invalid={!!errors.firstName}
                  placeholder="Juan"
                  value={field.value ?? ''}
                  onBlur={field.onBlur}
                  onChange={(e) => field.onChange(sanitizeNameInput(e.target.value))}
                />
              )}
            />
            {errors.firstName && <p className="text-xs text-destructive">{errors.firstName.message}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="middleName">
              Middle name <span className="text-destructive">*</span>
            </Label>
            <Controller
              control={control}
              name="middleName"
              render={({ field }) => (
                <Input
                  id="middleName"
                  invalid={!!errors.middleName}
                  placeholder="Santos"
                  value={field.value ?? ''}
                  onBlur={field.onBlur}
                  onChange={(e) => field.onChange(sanitizeNameInput(e.target.value))}
                />
              )}
            />
            {errors.middleName && <p className="text-xs text-destructive">{errors.middleName.message}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lastName">
              Last name <span className="text-destructive">*</span>
            </Label>
            <Controller
              control={control}
              name="lastName"
              render={({ field }) => (
                <Input
                  id="lastName"
                  invalid={!!errors.lastName}
                  placeholder="Dela Cruz"
                  value={field.value ?? ''}
                  onBlur={field.onBlur}
                  onChange={(e) => field.onChange(sanitizeNameInput(e.target.value))}
                />
              )}
            />
            {errors.lastName && <p className="text-xs text-destructive">{errors.lastName.message}</p>}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">
            Email address <span className="text-destructive">*</span>
          </Label>
          <Input
            id="email"
            type="email"
            invalid={!!errors.email}
            {...register('email')}
            placeholder="juan.delacruz@email.com"
          />
          {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="phone">
            Phone number <span className="text-destructive">*</span>
          </Label>
          <Input
            id="phone"
            type="tel"
            inputMode="numeric"
            maxLength={11}
            invalid={!!errors.phone}
            {...phoneField}
            onChange={(e) => {
              e.target.value = sanitizePhoneInput(e.target.value)
              phoneField.onChange(e)
            }}
            placeholder="09XXXXXXXXX"
          />
          {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="birthDate">
            Date of birth <span className="text-destructive">*</span>
          </Label>
          <Input
            id="birthDate"
            type="date"
            invalid={!!errors.birthDate}
            {...register('birthDate')}
            // The picker itself stops at somebody's eighteenth birthday, so the
            // common case never becomes an error message. It is a courtesy, not
            // the rule: the schema checks it again and the database decides it.
            max={eighteenYearsAgo}
          />
          <p className="text-xs text-muted-foreground">You must be at least 18 years old to apply.</p>
          {errors.birthDate && <p className="text-xs text-destructive">{errors.birthDate.message}</p>}
        </div>

        <AddressFields
          value={{
            province: watch('province') ?? '',
            city: watch('city') ?? '',
            barangay: watch('barangay') ?? '',
            street: watch('address') ?? '',
          }}
          onChange={(next: AddressValue) => {
            setValue('province', next.province, { shouldValidate: true })
            setValue('city', next.city, { shouldValidate: true })
            setValue('barangay', next.barangay, { shouldValidate: true })
            setValue('address', next.street, { shouldValidate: true })
          }}
          errors={{
            province: errors.province?.message,
            city: errors.city?.message,
            barangay: errors.barangay?.message,
            street: errors.address?.message,
          }}
        />

        <FileDropzone
          inputId="resume"
          label="Resume / CV"
          hint="PDF, DOC, or DOCX — max 5 MB"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          validate={validateResumeFile}
          file={resumeFile}
          error={resumeError}
          onSelect={(file, error) => {
            setResumeFile(file)
            setResumeError(error)
          }}
        />

        {/* Separate from the CV, and stored separately. A resume is not proof
            of identity and must never end up filed as one. */}
        <FileDropzone
          inputId="governmentId"
          label="Valid Government ID"
          hint="PDF, JPG, or PNG — max 5 MB"
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          validate={(file) => validateGovernmentIdFile(file)}
          file={governmentIdFile}
          error={governmentIdError}
          onSelect={(file, error) => {
            setGovernmentIdFile(file)
            setGovernmentIdError(error)
          }}
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="coverLetter">Cover letter</Label>
          <Textarea
            id="coverLetter"
            invalid={!!errors.coverLetter}
            maxLength={2000}
            {...register('coverLetter')}
            placeholder="Tell us why you're a great fit for this role (optional)"
            rows={5}
          />
          {errors.coverLetter && <p className="text-xs text-destructive">{errors.coverLetter.message}</p>}
        </div>

        <div className="mt-2 flex items-start gap-2.5 rounded-md border border-secondary/30 bg-secondary/5 px-3 py-2.5 text-sm">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-secondary" />
          <p className="text-muted-foreground">
            Our HR team reviews every application within{' '}
            <span className="font-medium text-foreground">{RESPONSE_WINDOW_DAYS} days</span>. You'll get a reference
            number after submitting so you can check your status any time.
          </p>
        </div>

        <Button type="submit" size="lg" loading={isSubmitting || submitApplication.isPending}>
          {isSubmitting || submitApplication.isPending ? 'Submitting application…' : 'Submit Application'}
        </Button>
      </form>
    </motion.div>
  )
}
