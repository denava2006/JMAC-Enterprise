import * as React from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check, FileText, Sparkles, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { MoneyInput } from '@/components/MoneyInput'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/sonner'
import { useDepartments } from '@/hooks/useDepartments'
import { usePositions } from '@/hooks/usePositions'
import { useSalaryGrades } from '@/hooks/useSalaryGrades'
import { useWorkSchedules } from '@/hooks/useWorkSchedules'
import { formatScheduleTime, formatWorkingDays } from '@/lib/attendanceCalculations'
import {
  useApplicationForEmployeeCreation,
  useCreateEmployee,
  useCreateEmployeeAccount,
  useUploadEmployeeDocument,
  validateEmployeeDocumentFile,
} from '@/hooks/useEmployees'
import { EMPLOYMENT_TYPE_LABEL, EMPLOYMENT_TYPE_SHORT_LABEL } from '@/lib/jobPostingLabels'
import { DEFAULT_CURRENCY } from '@/lib/currency'
import { AddressFields, formatAddress, type AddressValue } from '@/components/AddressFields'
import { CIVIL_STATUS_OPTIONS, DOCUMENT_TYPE_OPTIONS, EMPLOYMENT_STATUS_LABEL } from '@/lib/employeeLabels'
import { importedFields } from '@/lib/hiring'
import type { EmploymentStatus } from '@/lib/enums'

// Letters with single spaces, hyphens, or apostrophes between them — no digits,
// no other symbols, and no leading/trailing or doubled-up separators.
const nameRegex = /^[A-Za-z]+(?:[ '-][A-Za-z]+)*$/
const nameField = (label: string) =>
  z.string().trim().min(1, `${label} is required`).max(100).regex(nameRegex, `${label} can only contain letters, spaces, hyphens, and apostrophes`)
const optionalNameField = (label: string) =>
  z
    .string()
    .trim()
    .max(100)
    .regex(nameRegex, `${label} can only contain letters, spaces, hyphens, and apostrophes`)
    .optional()
    .or(z.literal(''))

const phoneRegex = /^09\d{9}$/

function sanitizePhoneInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 11)
}

/** Digits and symbols can never be typed into a name field at all, rather than
 * only being caught by the schema on submit. */
function sanitizeNameInput(raw: string): string {
  return raw.replace(/[^A-Za-z '-]/g, '').slice(0, 100)
}

function todayISODate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const MINIMUM_HIRING_AGE = 18

/** Latest birth date that still makes someone MINIMUM_HIRING_AGE today — used
 * as the date input's `max` so the picker can't even offer a younger date. */
function latestEligibleBirthDate(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - MINIMUM_HIRING_AGE)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const employeeSchema = z.object({
  firstName: nameField('First name'),
  middleName: optionalNameField('Middle name'),
  lastName: nameField('Last name'),
  gender: z.string().min(1, 'Gender is required'),
  birthDate: z
    .string()
    .min(1, 'Birth date is required')
    .refine((v) => v <= latestEligibleBirthDate(), `Employee must be at least ${MINIMUM_HIRING_AGE} years old`),
  civilStatus: z.string().min(1, 'Civil status is required'),
  nationality: z.string().trim().min(1, 'Nationality is required').max(100),
  phone: z.string().min(1, 'Phone number is required').regex(phoneRegex, 'Enter a valid mobile number (11 digits, starting with 09)'),
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  province: z.string().trim().min(1, 'Province is required'),
  city: z.string().trim().min(1, 'City or municipality is required'),
  barangay: z.string().trim().min(1, 'Barangay is required'),
  address: z.string().trim().min(1, 'Residential address is required').max(500),

  departmentId: z.string().min(1, 'Department is required'),
  positionId: z.string().min(1, 'Position is required'),
  employmentType: z.enum(['regular', 'part_time']),
  salaryGradeId: z.string().optional(),
  basicSalary: z.string().min(1, 'Basic salary is required'),
  currency: z.literal('PHP'),
  hireDate: z.string().min(1, 'Date hired is required'),
  employmentStatus: z.string().min(1, 'Employment status is required'),
  workScheduleId: z.string().min(1, 'Work schedule is required'),
})
type EmployeeFormValues = z.infer<typeof employeeSchema>

const STEP_FIELDS: (keyof EmployeeFormValues)[][] = [
  ['firstName', 'middleName', 'lastName', 'gender', 'birthDate', 'civilStatus', 'nationality', 'phone', 'email', 'province', 'city', 'barangay', 'address'],
  ['departmentId', 'positionId', 'employmentType', 'salaryGradeId', 'basicSalary', 'currency', 'hireDate', 'employmentStatus', 'workScheduleId'],
  [],
  [],
]

const STEPS = ['Personal Information', 'Employment Information', 'Documents', 'Review'] as const

interface StagedDocument {
  id: string
  documentType: string
  file: File
}

function formatFileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function StepIndicator({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => (
        <React.Fragment key={label}>
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                i < step ? 'bg-accent text-accent-foreground' : i === step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              )}
            >
              {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <span className={cn('hidden text-sm sm:inline', i === step ? 'font-medium text-foreground' : 'text-muted-foreground')}>{label}</span>
          </div>
          {i < STEPS.length - 1 && <div className={cn('h-px w-6 sm:w-10', i < step ? 'bg-accent' : 'bg-border')} />}
        </React.Fragment>
      ))}
    </div>
  )
}


function PersonalInfoSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="Importing applicant information">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <Skeleton className="h-16 w-full" />
    </div>
  )
}

export default function CreateEmployeePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const applicationId = searchParams.get('applicationId') ?? undefined
  const { data: departments } = useDepartments()
  const { data: positions } = usePositions()
  const { data: salaryGrades } = useSalaryGrades()
  const { data: workSchedules } = useWorkSchedules()
  const { data: applicationData, isLoading: isImportingApplicant } = useApplicationForEmployeeCreation(applicationId)
  const createEmployee = useCreateEmployee()
  const createAccount = useCreateEmployeeAccount()
  const uploadDocument = useUploadEmployeeDocument()

  const [step, setStep] = React.useState(0)
  const [autoFilledFields, setAutoFilledFields] = React.useState<Set<string>>(new Set())
  const [staged, setStaged] = React.useState<StagedDocument[]>([])
  const [pendingDocType, setPendingDocType] = React.useState<string>(DOCUMENT_TYPE_OPTIONS[0])
  const [pendingFile, setPendingFile] = React.useState<File | null>(null)
  const [pendingFileError, setPendingFileError] = React.useState<string | null>(null)
  const [sendInviteNow, setSendInviteNow] = React.useState(true)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Mirrored into a ref so submitEmployee always reads the checkbox's latest
  // value even if an earlier, stale onSubmit closure ends up being the one
  // that actually runs (submittingRef below guards against it running twice).
  const sendInviteNowRef = React.useRef(sendInviteNow)
  React.useEffect(() => {
    sendInviteNowRef.current = sendInviteNow
  }, [sendInviteNow])

  const {
    register,
    control,
    handleSubmit,
    trigger,
    watch,
    setValue,
    reset,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeSchema),
    defaultValues: {
      province: '',
      city: '',
      barangay: '',
      employmentType: 'regular',
      currency: DEFAULT_CURRENCY,
      hireDate: todayISODate(),
      employmentStatus: 'active',
    },
  })

  // Deployment already collected this person's personal information — and, via
  // the accepted job offer, already decided their department/position/employment
  // type/salary — once. Step 1 and Step 2 just verify those instead of asking HR
  // to retype them (and risk Employee Management disagreeing with what Deployment
  // actually offered).
  const importedApplicantRef = React.useRef(false)
  React.useEffect(() => {
    const applicant = applicationData?.applicant
    if (!applicant || importedApplicantRef.current) return
    importedApplicantRef.current = true

    const jobPosting = applicationData.job_postings
    const offer = applicationData.latestOffer

    reset({
      ...getValues(),
      firstName: applicant.first_name,
      middleName: applicant.middle_name,
      lastName: applicant.last_name,
      phone: applicant.phone,
      email: applicant.email,
      address: applicant.address,
      province: applicant.province,
      city: applicant.city,
      barangay: applicant.barangay,
      ...(jobPosting?.department_id ? { departmentId: jobPosting.department_id } : {}),
      ...(jobPosting?.position_id ? { positionId: jobPosting.position_id } : {}),
      ...(offer
        ? {
            employmentType: offer.employment_type,
            salaryGradeId: offer.salary_grade_id ?? undefined,
            basicSalary: String(offer.proposed_salary),
          }
        : {}),
      // Whichever shift the deployment confirmed (falling back to the offer's).
      ...(applicationData.workScheduleId ? { workScheduleId: applicationData.workScheduleId } : {}),
    })
    setAutoFilledFields(
      new Set([
        ...importedFields(applicant),
        ...(jobPosting?.department_id ? (['departmentId'] as const) : []),
        ...(jobPosting?.position_id ? (['positionId'] as const) : []),
        ...(offer ? (['employmentType', 'salaryGradeId', 'basicSalary'] as const) : []),
        ...(applicationData.workScheduleId ? (['workScheduleId'] as const) : []),
      ])
    )
    toast.success(
      offer
        ? 'Applicant and job offer information imported successfully.'
        : 'Applicant information imported successfully.'
    )
  }, [applicationData, reset, getValues])

  const clearAutoFilled = (field: string) =>
    setAutoFilledFields((prev) => {
      if (!prev.has(field)) return prev
      const next = new Set(prev)
      next.delete(field)
      return next
    })
  const autoFillClass = (field: string) => (autoFilledFields.has(field) ? 'border-warning/60 bg-warning/5 ring-1 ring-warning/30' : undefined)

  const departmentId = watch('departmentId')
  const filteredPositions = React.useMemo(
    () => positions?.filter((p) => p.department_id === departmentId),
    [positions, departmentId]
  )

  const goNext = async () => {
    const fields = STEP_FIELDS[step]
    const valid = fields.length === 0 || (await trigger(fields))
    if (valid) setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }
  const goBack = () => setStep((s) => Math.max(s - 1, 0))

  const handlePendingFile = (files: FileList | null) => {
    const picked = files?.[0]
    if (!picked) return
    const validationError = validateEmployeeDocumentFile(picked)
    setPendingFileError(validationError)
    setPendingFile(validationError ? null : picked)
  }

  const addStagedDocument = () => {
    if (!pendingFile) return
    setStaged((prev) => [...prev, { id: crypto.randomUUID(), documentType: pendingDocType, file: pendingFile }])
    setPendingFile(null)
    setPendingFileError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeStagedDocument = (id: string) => setStaged((prev) => prev.filter((d) => d.id !== id))

  const submittingRef = React.useRef(false)

  const onSubmit = async (values: EmployeeFormValues) => {
    if (submittingRef.current) return
    submittingRef.current = true
    try {
      await submitEmployee(values)
    } finally {
      submittingRef.current = false
    }
  }

  const submitEmployee = async (values: EmployeeFormValues) => {
    const employee = await createEmployee.mutateAsync({
      applicationId,
      firstName: values.firstName,
      middleName: values.middleName || undefined,
      lastName: values.lastName,
      gender: values.gender,
      birthDate: values.birthDate,
      civilStatus: values.civilStatus,
      nationality: values.nationality,
      phone: values.phone,
      email: values.email,
      address: values.address,
      province: values.province,
      city: values.city,
      barangay: values.barangay,
      departmentId: values.departmentId,
      positionId: values.positionId,
      employmentType: values.employmentType,
      salaryGradeId: values.salaryGradeId || undefined,
      basicSalary: Number(values.basicSalary),
      currency: DEFAULT_CURRENCY,
      hireDate: values.hireDate,
      employmentStatus: values.employmentStatus as EmploymentStatus,
      workScheduleId: values.workScheduleId,
    })

    for (const doc of staged) {
      await uploadDocument.mutateAsync({ employeeId: employee.id, documentType: doc.documentType, file: doc.file })
    }

    if (sendInviteNowRef.current) {
      await createAccount.mutateAsync({
        employeeId: employee.id,
        email: values.email,
        fullName: `${values.firstName} ${values.lastName}`,
      })
    }

    navigate(`/dashboard/employees/${employee.id}`)
  }

  const selectedDepartment = departments?.find((d) => d.id === departmentId)
  const selectedPosition = filteredPositions?.find((p) => p.id === watch('positionId'))
  // Regular and part-time resources are not interchangeable: the database
  // refuses a mismatched pairing, so the options are narrowed to the ones that
  // will actually be accepted.
  // A hire that came through recruitment carries the type from the job
  // posting they applied to. HR confirms it here but cannot change it — that
  // would mean hiring them into a different job than the one advertised, and
  // the database refuses the mismatch anyway.
  const inheritedEmploymentType = applicationData?.latestOffer?.employment_type ?? null

  const employmentType = watch('employmentType')
  const assignableGrades = React.useMemo(
    () => (salaryGrades ?? []).filter((g) => g.employment_type === employmentType),
    [salaryGrades, employmentType]
  )
  const assignableSchedules = React.useMemo(
    () => (workSchedules ?? []).filter((s) => s.employment_type === employmentType),
    [workSchedules, employmentType]
  )

  const selectedGrade = assignableGrades.find((g) => g.id === watch('salaryGradeId'))
  const selectedSchedule = assignableSchedules.find((s) => s.id === watch('workScheduleId'))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">Create Employee</h2>
          <p className="text-sm text-muted-foreground">Add a new employee record to JMAC Enterprise.</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard/employees">
            <ArrowLeft className="h-4 w-4" />
            Back to Employees
          </Link>
        </Button>
      </div>

      <StepIndicator step={step} />

      <Card>
        <CardContent className="p-6">
          {/* Not a <form>: the footer's last button swaps between type="button"
           * ("Next") and would-be type="submit" ("Create Employee") at the same
           * DOM position as `step` changes, which raced with native form
           * submission (the click that lands on "Next" could still trigger a
           * submit if React swaps the button's type before the browser's
           * default-action phase reads it). Submitting via handleSubmit(onSubmit)
           * directly from that button's onClick sidesteps native submit entirely. */}
          <div>
            {step === 0 && (isImportingApplicant && applicationId ? (
              <PersonalInfoSkeleton />
            ) : (
              <div className="flex flex-col gap-4">
                {applicationId && (
                  <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">
                    <Sparkles className="h-4 w-4 shrink-0" />
                    <span>Personal information was imported from this applicant's job application. Review and correct anything that needs it.</span>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="firstName" className="flex items-center gap-1.5">
                      First Name <span className="text-destructive">*</span>
                      {autoFilledFields.has('firstName') && <Badge variant="warning" className="px-1.5 py-0 text-[10px] font-normal">Auto-filled</Badge>}
                    </Label>
                    <Controller
                      control={control}
                      name="firstName"
                      render={({ field }) => (
                        <Input
                          id="firstName"
                          autoComplete="off"
                          invalid={!!errors.firstName}
                          className={autoFillClass('firstName')}
                          value={field.value ?? ''}
                          onBlur={field.onBlur}
                          onChange={(e) => field.onChange(sanitizeNameInput(e.target.value))}
                          onFocus={() => clearAutoFilled('firstName')}
                        />
                      )}
                    />
                    {errors.firstName && <p className="text-xs text-destructive">{errors.firstName.message}</p>}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="middleName" className="flex items-center gap-1.5">
                      Middle Name
                      {autoFilledFields.has('middleName') && <Badge variant="warning" className="px-1.5 py-0 text-[10px] font-normal">Auto-filled</Badge>}
                    </Label>
                    <Controller
                      control={control}
                      name="middleName"
                      render={({ field }) => (
                        <Input
                          id="middleName"
                          autoComplete="off"
                          invalid={!!errors.middleName}
                          className={autoFillClass('middleName')}
                          value={field.value ?? ''}
                          onBlur={field.onBlur}
                          onChange={(e) => field.onChange(sanitizeNameInput(e.target.value))}
                          onFocus={() => clearAutoFilled('middleName')}
                        />
                      )}
                    />
                    {errors.middleName && <p className="text-xs text-destructive">{errors.middleName.message}</p>}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="lastName" className="flex items-center gap-1.5">
                      Last Name <span className="text-destructive">*</span>
                      {autoFilledFields.has('lastName') && <Badge variant="warning" className="px-1.5 py-0 text-[10px] font-normal">Auto-filled</Badge>}
                    </Label>
                    <Controller
                      control={control}
                      name="lastName"
                      render={({ field }) => (
                        <Input
                          id="lastName"
                          autoComplete="off"
                          invalid={!!errors.lastName}
                          className={autoFillClass('lastName')}
                          value={field.value ?? ''}
                          onBlur={field.onBlur}
                          onChange={(e) => field.onChange(sanitizeNameInput(e.target.value))}
                          onFocus={() => clearAutoFilled('lastName')}
                        />
                      )}
                    />
                    {errors.lastName && <p className="text-xs text-destructive">{errors.lastName.message}</p>}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>
                      Gender <span className="text-destructive">*</span>
                    </Label>
                    <Controller
                      control={control}
                      name="gender"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger invalid={!!errors.gender}>
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Male">Male</SelectItem>
                            <SelectItem value="Female">Female</SelectItem>
                            <SelectItem value="Other">Other</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {errors.gender && <p className="text-xs text-destructive">{errors.gender.message}</p>}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="birthDate">
                      Birth Date <span className="text-destructive">*</span>
                    </Label>
                    <Input id="birthDate" type="date" max={latestEligibleBirthDate()} invalid={!!errors.birthDate} {...register('birthDate')} />
                    {errors.birthDate && <p className="text-xs text-destructive">{errors.birthDate.message}</p>}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>
                      Civil Status <span className="text-destructive">*</span>
                    </Label>
                    <Controller
                      control={control}
                      name="civilStatus"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger invalid={!!errors.civilStatus}>
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent>
                            {CIVIL_STATUS_OPTIONS.map((v) => (
                              <SelectItem key={v} value={v}>
                                {v}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {errors.civilStatus && <p className="text-xs text-destructive">{errors.civilStatus.message}</p>}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="nationality">
                      Nationality <span className="text-destructive">*</span>
                    </Label>
                    <Input id="nationality" autoComplete="off" invalid={!!errors.nationality} {...register('nationality')} placeholder="Filipino" />
                    {errors.nationality && <p className="text-xs text-destructive">{errors.nationality.message}</p>}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="phone" className="flex items-center gap-1.5">
                      Contact Number <span className="text-destructive">*</span>
                      {autoFilledFields.has('phone') && <Badge variant="warning" className="px-1.5 py-0 text-[10px] font-normal">Auto-filled</Badge>}
                    </Label>
                    <Controller
                      control={control}
                      name="phone"
                      render={({ field }) => (
                        <Input
                          id="phone"
                          autoComplete="off"
                          inputMode="numeric"
                          placeholder="09171234567"
                          invalid={!!errors.phone}
                          className={autoFillClass('phone')}
                          value={field.value ?? ''}
                          onChange={(e) => field.onChange(sanitizePhoneInput(e.target.value))}
                          onBlur={field.onBlur}
                          onFocus={() => clearAutoFilled('phone')}
                        />
                      )}
                    />
                    {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="email" className="flex items-center gap-1.5">
                      Email Address <span className="text-destructive">*</span>
                      {autoFilledFields.has('email') && <Badge variant="warning" className="px-1.5 py-0 text-[10px] font-normal">Auto-filled</Badge>}
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="off"
                      invalid={!!errors.email}
                      className={autoFillClass('email')}
                      {...register('email')}
                      onFocus={() => clearAutoFilled('email')}
                    />
                    {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
                  </div>
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
                    clearAutoFilled('address')
                  }}
                  errors={{
                    province: errors.province?.message,
                    city: errors.city?.message,
                    barangay: errors.barangay?.message,
                    street: errors.address?.message,
                  }}
                />
              </div>
            ))}

            {step === 1 && (
              <div className="flex flex-col gap-4">
                {applicationData?.latestOffer && (
                  <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">
                    <Sparkles className="h-4 w-4 shrink-0" />
                    <span>Department, position, and salary were imported from this applicant's accepted job offer. Review and correct anything that needs it.</span>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>
                      Department <span className="text-destructive">*</span>
                    </Label>
                    <Controller
                      control={control}
                      name="departmentId"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(v) => {
                            field.onChange(v)
                            setValue('positionId', '')
                          }}
                        >
                          <SelectTrigger invalid={!!errors.departmentId}>
                            <SelectValue placeholder="Select department" />
                          </SelectTrigger>
                          <SelectContent>
                            {departments?.map((d) => (
                              <SelectItem key={d.id} value={d.id}>
                                {d.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {errors.departmentId && <p className="text-xs text-destructive">{errors.departmentId.message}</p>}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>
                      Position <span className="text-destructive">*</span>
                    </Label>
                    <Controller
                      control={control}
                      name="positionId"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange} disabled={!departmentId}>
                          <SelectTrigger invalid={!!errors.positionId}>
                            <SelectValue placeholder={departmentId ? 'Select position' : 'Select a department first'} />
                          </SelectTrigger>
                          <SelectContent>
                            {filteredPositions?.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {errors.positionId && <p className="text-xs text-destructive">{errors.positionId.message}</p>}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>Employment Type</Label>
                    <Controller
                      control={control}
                      name="employmentType"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          disabled={inheritedEmploymentType !== null}
                          onValueChange={(v) => {
                            field.onChange(v)
                            // Anything picked under the previous type is no
                            // longer assignable.
                            setValue('salaryGradeId', '')
                            setValue('workScheduleId', '')
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Employment Status</Label>
                    <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-muted/40 px-3">
                      <Badge variant="success" className="px-1.5 py-0 text-[10px] font-normal">
                        {EMPLOYMENT_STATUS_LABEL.active}
                      </Badge>
                      <span className="text-xs text-muted-foreground">New employees always start here</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Resigned, terminated and retired are recorded later, from the employee&apos;s record.
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1.5">
                    Work Schedule <span className="text-destructive">*</span>
                    {autoFilledFields.has('workScheduleId') && (
                      <Badge variant="warning" className="px-1.5 py-0 text-[10px] font-normal">Auto-filled</Badge>
                    )}
                  </Label>
                  <Controller
                    control={control}
                    name="workScheduleId"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(v) => {
                          field.onChange(v)
                          clearAutoFilled('workScheduleId')
                        }}
                      >
                        <SelectTrigger invalid={!!errors.workScheduleId} className={autoFillClass('workScheduleId')}>
                          <SelectValue
                            placeholder={
                              assignableSchedules.length
                                ? 'Select a shift'
                                : `No ${EMPLOYMENT_TYPE_SHORT_LABEL[employmentType]} work schedules configured`
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {assignableSchedules.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                              {s.is_default ? ' (default)' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {errors.workScheduleId ? (
                    <p className="text-xs text-destructive">{errors.workScheduleId.message}</p>
                  ) : selectedSchedule ? (
                    <p className="text-xs text-muted-foreground">
                      {formatWorkingDays(selectedSchedule.working_days)} ·{' '}
                      {formatScheduleTime(selectedSchedule.start_time)} – {formatScheduleTime(selectedSchedule.end_time)}
                      {' · '}late, undertime, and overtime are measured against this shift
                    </p>
                  ) : null}
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>Salary Grade (optional)</Label>
                    <Controller
                      control={control}
                      name="salaryGradeId"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger>
                            <SelectValue placeholder="None" />
                          </SelectTrigger>
                          <SelectContent>
                                      {assignableGrades.map((g) => (
                              <SelectItem key={g.id} value={g.id}>
                                {g.grade_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="hireDate">
                      Date Hired <span className="text-destructive">*</span>
                    </Label>
                    <Input id="hireDate" type="date" invalid={!!errors.hireDate} {...register('hireDate')} />
                    {errors.hireDate && <p className="text-xs text-destructive">{errors.hireDate.message}</p>}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="basicSalary">
                      Basic Salary <span className="text-destructive">*</span>
                    </Label>
                    <Controller
                      control={control}
                      name="basicSalary"
                      render={({ field }) => (
                        <MoneyInput
                          id="basicSalary"
                          invalid={!!errors.basicSalary}
                          value={field.value ?? ''}
                          onValueChange={field.onChange}
                        />
                      )}
                    />
                    {errors.basicSalary && <p className="text-xs text-destructive">{errors.basicSalary.message}</p>}
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  Upload any employee documents now, or skip this step and add them later from the employee's details page.
                </p>

                <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
                    <Select value={pendingDocType} onValueChange={setPendingDocType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DOCUMENT_TYPE_OPTIONS.map((v) => (
                          <SelectItem key={v} value={v}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button type="button" variant="outline" disabled={!pendingFile} onClick={addStagedDocument}>
                      Add Document
                    </Button>
                  </div>

                  {pendingFile ? (
                    <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-card px-3 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-secondary" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{pendingFile.name}</p>
                          <p className="text-xs text-muted-foreground">{formatFileSize(pendingFile.size)}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPendingFile(null)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Remove selected file"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => fileInputRef.current?.click()}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInputRef.current?.click()}
                      className={cn(
                        'flex cursor-pointer flex-col items-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center transition-colors',
                        'border-input hover:border-secondary/50',
                        pendingFileError && 'border-destructive'
                      )}
                    >
                      <Upload className="h-5 w-5 text-muted-foreground" />
                      <p className="text-sm text-foreground">
                        <span className="font-medium text-secondary">Click to upload</span> a file
                      </p>
                      <p className="text-xs text-muted-foreground">PDF, DOC, DOCX, JPG, or PNG — max 10 MB</p>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png"
                        className="sr-only"
                        onChange={(e) => handlePendingFile(e.target.files)}
                      />
                    </div>
                  )}
                  {pendingFileError && <p className="text-xs text-destructive">{pendingFileError}</p>}
                </div>

                {staged.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {staged.map((doc) => (
                      <div key={doc.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <FileText className="h-4 w-4 shrink-0 text-secondary" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground">{doc.documentType}</p>
                            <p className="truncate text-xs text-muted-foreground">{doc.file.name}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeStagedDocument(doc.id)}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label="Remove document"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {step === 3 && (
              <div className="flex flex-col gap-5">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Personal Information</h3>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                    <ReviewField label="Name" value={`${watch('firstName')} ${watch('middleName') ? watch('middleName') + ' ' : ''}${watch('lastName')}`} />
                    <ReviewField label="Gender" value={watch('gender')} />
                    <ReviewField label="Birth Date" value={watch('birthDate')} />
                    <ReviewField label="Civil Status" value={watch('civilStatus')} />
                    <ReviewField label="Nationality" value={watch('nationality')} />
                    <ReviewField label="Contact Number" value={watch('phone')} />
                    <ReviewField label="Email" value={watch('email')} />
                    <ReviewField
                      label="Address"
                      value={formatAddress({
                        province: watch('province'),
                        city: watch('city'),
                        barangay: watch('barangay'),
                        street: watch('address'),
                      })}
                    />
                  </div>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employment Information</h3>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                    <ReviewField label="Department" value={selectedDepartment?.name} />
                    <ReviewField label="Position" value={selectedPosition?.title} />
                    <ReviewField label="Employment Type" value={EMPLOYMENT_TYPE_LABEL[watch('employmentType')]} />
                    <ReviewField label="Employment Status" value={EMPLOYMENT_STATUS_LABEL[watch('employmentStatus') as EmploymentStatus]} />
                    <ReviewField label="Salary Grade" value={selectedGrade?.grade_name ?? 'None'} />
                    <ReviewField label="Basic Salary" value={watch('basicSalary') ? `${watch('currency')} ${watch('basicSalary')}` : undefined} />
                    <ReviewField label="Date Hired" value={watch('hireDate')} />
                    <ReviewField label="Work Schedule" value={selectedSchedule?.name} />
                  </div>
                </div>
                {staged.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Documents</h3>
                    <p className="text-sm text-foreground">{staged.length} document{staged.length === 1 ? '' : 's'} ready to upload</p>
                  </div>
                )}

                <label className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={sendInviteNow}
                    onChange={(e) => setSendInviteNow(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-input"
                  />
                  <span>
                    <span className="font-medium text-foreground">Create login now.</span>{' '}
                    <span className="text-muted-foreground">
                      A setup link is emailed to {watch('email') || 'their email'}; they choose their own password
                      from it. You can create this later instead from the employee's details page.
                    </span>
                  </span>
                </label>
              </div>
            )}

            <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
              <Button type="button" variant="outline" onClick={goBack} disabled={step === 0}>
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              {step < STEPS.length - 1 ? (
                <Button type="button" onClick={goNext}>
                  Next
                  <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <Button type="button" loading={isSubmitting || createEmployee.isPending} onClick={handleSubmit(onSubmit)}>
                  Create Employee
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ReviewField({ label, value }: { label: string; value: string | undefined | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-foreground">{value || '—'}</p>
    </div>
  )
}
