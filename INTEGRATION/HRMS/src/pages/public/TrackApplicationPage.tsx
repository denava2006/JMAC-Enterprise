import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  Briefcase,
  Building2,
  CalendarClock,
  CheckCircle2,
  Check,
  Clock,
  Download,
  ExternalLink,
  FileText,
  IdCard,
  KeyRound,
  LogOut,
  MapPin,
  Paperclip,
  Search,
  Video,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { toast } from '@/components/ui/sonner'
import {
  useApplicationTracking,
  useApplicationMilestones,
  MILESTONE_LABEL,
  type ApplicationMilestone,
  useRespondToOfferAsApplicant,
  useApplicantFileDownload,
  APPLICANT_STATUS_COPY,
  type ApplicantCredentials,
  type ApplicationTrackingRecord,
} from '@/hooks/useApplicantPortal'
import { formatMoney } from '@/lib/currency'
import { EMPLOYMENT_TYPE_LABEL, EMPLOYMENT_TYPE_SHORT_LABEL } from '@/lib/jobPostingLabels'
import { EMPLOYMENT_STATUS_LABEL } from '@/lib/employeeLabels'
import { formatScheduleTime, formatWorkingDays } from '@/lib/attendanceCalculations'
import { RESPONSE_WINDOW_DAYS, daysRemaining } from '@/lib/applicationSla'
import { OFFER_DECLINE_REASONS } from '@/lib/deploymentLabels'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { loadApplicantSession, saveApplicantSession, clearApplicantSession } from '@/lib/applicantSession'

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  )
}

function LookupForm({ onSubmit, isLoading }: { onSubmit: (c: ApplicantCredentials) => void; isLoading: boolean }) {
  const [searchParams] = useSearchParams()
  const [referenceCode, setReferenceCode] = React.useState(searchParams.get('ref') ?? '')
  const [email, setEmail] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!referenceCode.trim() || !email.trim()) {
      setError('Enter both your reference number and the email you applied with.')
      return
    }
    setError(null)
    onSubmit({ referenceCode: referenceCode.trim().toUpperCase(), email: email.trim() })
  }

  return (
    <Card>
      <CardContent className="p-6">
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reference_code">
              Reference Number <span className="text-destructive">*</span>
            </Label>
            <Input
              id="reference_code"
              autoComplete="off"
              placeholder="APP-2026-0001"
              className="font-mono"
              value={referenceCode}
              onChange={(e) => setReferenceCode(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="applicant_email">
              Email Address <span className="text-destructive">*</span>
            </Label>
            <Input
              id="applicant_email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Use the same email you applied with.</p>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" loading={isLoading} className="mt-1">
            <Search className="h-4 w-4" />
            Track Application
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * The whole journey, not just where it is now.
 *
 * Track Application used to show the current interview and nothing else, so
 * every earlier stage disappeared as the application moved on -- an applicant
 * who had been shortlisted and interviewed saw only the latest appointment,
 * with no evidence any of the rest had happened.
 *
 * Every row here comes from a recorded timestamp. Nothing is inferred from the
 * current status, so a stage that genuinely has no record simply is not shown
 * rather than being drawn as though it had occurred.
 */
function JourneyCard({ milestones, isLoading }: { milestones: ApplicationMilestone[]; isLoading: boolean }) {
  // An unrecognised event is dropped rather than prettified: the stored names
  // are HR's vocabulary, and guessing a label for one would eventually put
  // internal wording in front of an applicant.
  const steps = milestones.filter((m) => MILESTONE_LABEL[m.event])

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-muted-foreground">Loading your application history…</p>
        </CardContent>
      </Card>
    )
  }
  if (steps.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your application journey</CardTitle>
      </CardHeader>
      <CardContent className="pb-6">
        <ol className="flex flex-col">
          {steps.map((step, index) => {
            const isLast = index === steps.length - 1
            return (
              <li key={`${step.event}-${step.occurred_at}`} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success"
                    aria-hidden="true"
                  >
                    <Check className="h-3 w-3" />
                  </span>
                  {/* The line joins one step to the next, so the last one has none. */}
                  {!isLast && <span className="w-px flex-1 bg-border" />}
                </div>
                <div className={isLast ? 'pb-0' : 'pb-5'}>
                  <p className="text-sm font-medium text-foreground">{MILESTONE_LABEL[step.event]}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(step.occurred_at)}</p>
                </div>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}

function InterviewCard({ record }: { record: ApplicationTrackingRecord }) {
  if (!record.interview_scheduled_at) return null
  const isOnline = record.interview_mode === 'online'
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-6">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-secondary" />
          <h2 className="font-display text-base font-semibold text-foreground">
            {record.interview_type === 'final' ? 'Final Interview' : 'Initial Interview'}
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Date & Time" value={formatDateTime(record.interview_scheduled_at)} />
          <Field label="Format" value={isOnline ? 'Online' : 'Face-to-face'} />
        </div>
        {isOnline && record.interview_meeting_link && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">Meeting Link</p>
            <Button asChild variant="outline" size="sm" className="self-start">
              <a href={record.interview_meeting_link} target="_blank" rel="noreferrer noopener">
                <Video className="h-4 w-4" />
                Join Meeting
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
        )}
        {!isOnline && record.interview_location && (
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Location</p>
              <p className="text-sm text-foreground">{record.interview_location}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function OfferCard({
  record,
  credentials,
}: {
  record: ApplicationTrackingRecord
  credentials: ApplicantCredentials
}) {
  const respond = useRespondToOfferAsApplicant()
  const [confirmDecline, setConfirmDecline] = React.useState(false)
  const [declineReason, setDeclineReason] = React.useState('')
  const [declineNotes, setDeclineNotes] = React.useState('')
  const [declineError, setDeclineError] = React.useState('')
  if (!record.offer_id) return null

  const isPending = record.offer_status === 'pending'

  const submit = (decision: 'accepted' | 'declined') => {
    respond.mutate(
      { credentials, decision, declineReason, declineNotes },
      {
        onSuccess: () =>
          toast.success(decision === 'accepted' ? 'Offer accepted — welcome aboard!' : 'Offer declined.'),
        onError: (e) => toast.error(e.message),
      }
    )
  }

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-secondary" />
              <h2 className="font-display text-base font-semibold text-foreground">Your Job Offer</h2>
            </div>
            {record.offer_status === 'accepted' && <Badge variant="success">Accepted</Badge>}
            {record.offer_status === 'declined' && <Badge variant="muted">Declined</Badge>}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Position" value={record.position_title ?? '—'} />
            <Field label="Department" value={record.department_name ?? '—'} />
            <Field
              label="Employment Type"
              value={record.offer_employment_type ? EMPLOYMENT_TYPE_LABEL[record.offer_employment_type] : '—'}
            />
            <Field label="Salary" value={record.offer_salary != null ? formatMoney(record.offer_salary) : '—'} />
            <Field label="Start Date" value={formatDate(record.offer_start_date)} />
            <Field label="Working Days" value={record.offer_working_days ?? '—'} />
            <Field label="Working Hours" value={record.offer_working_hours ?? '—'} />
          </div>

          {record.offer_additional_compensation && (
            <div>
              <p className="text-xs text-muted-foreground">Additional Compensation</p>
              <p className="whitespace-pre-line text-sm text-foreground">{record.offer_additional_compensation}</p>
            </div>
          )}

          {isPending ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Please respond within {RESPONSE_WINDOW_DAYS} days. If we don't hear back, HR may close this offer and
                move on to other candidates.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={respond.isPending}
                onClick={() => setConfirmDecline(true)}
              >
                Decline Offer
              </Button>
              <Button type="button" variant="accent" loading={respond.isPending} onClick={() => submit('accepted')}>
                <CheckCircle2 className="h-4 w-4" />
                Accept Offer
              </Button>
              </div>
            </div>
          ) : (
            <p className="border-t border-border pt-4 text-xs text-muted-foreground">
              You've already responded to this offer. Contact HR if you need to change anything.
            </p>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmDecline}
        onOpenChange={(open) => {
          setConfirmDecline(open)
          if (!open) {
            setDeclineReason('')
            setDeclineNotes('')
            setDeclineError('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Decline this job offer?</AlertDialogTitle>
            <AlertDialogDescription>
              This can’t be undone — HR will be notified and will close your application. If you’re unsure, contact HR
              before declining.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* One question, because it's the only thing HR learns from a
            * candidate they'd already chosen. The notes are optional. */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="decline_reason">
                Reason <span className="text-destructive">*</span>
              </Label>
              <Select
                value={declineReason}
                onValueChange={(v) => {
                  setDeclineReason(v)
                  setDeclineError('')
                }}
              >
                <SelectTrigger id="decline_reason" invalid={!!declineError}>
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  {OFFER_DECLINE_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {declineError && <p className="text-xs text-destructive">{declineError}</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="decline_notes">Anything else? (optional)</Label>
              <Textarea
                id="decline_notes"
                rows={3}
                value={declineNotes}
                onChange={(e) => setDeclineNotes(e.target.value)}
              />
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                if (!declineReason) {
                  // Keeps the dialog open — AlertDialogAction closes it otherwise.
                  e.preventDefault()
                  setDeclineError('Select a reason so HR knows why.')
                  return
                }
                submit('declined')
                setConfirmDecline(false)
              }}
            >
              Confirm Decline
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Long-form contract text — folded away by default so the card stays readable,
 * but present in full rather than summarised, because this is the applicant's
 * copy of what they signed. */
function ContractText({ title, body }: { title: string; body: string | null }) {
  if (!body) return null
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-foreground">{title}</summary>
      <p className="whitespace-pre-line border-t border-border px-4 py-3 text-sm text-muted-foreground">{body}</p>
    </details>
  )
}

function ContractCard({
  record,
  credentials,
}: {
  record: ApplicationTrackingRecord
  credentials: ApplicantCredentials
}) {
  const download = useApplicantFileDownload()
  if (!record.contract_id) return null

  const isSigned = record.contract_status === 'signed'

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-secondary" />
            <h2 className="font-display text-base font-semibold text-foreground">Employment Contract</h2>
          </div>
          <Badge variant={isSigned ? 'success' : 'warning'}>{isSigned ? 'Signed' : 'Being Prepared'}</Badge>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Contract Start Date" value={formatDate(record.contract_start_date)} />
          <Field label="Signed On" value={record.contract_signed_at ? formatDateTime(record.contract_signed_at) : '—'} />
        </div>

        {record.contract_file_path && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            loading={download.isPending}
            onClick={() =>
              download.mutate(
                { credentials, bucket: 'contracts', path: record.contract_file_path! },
                { onError: (e) => toast.error(e.message) }
              )
            }
          >
            <Download className="h-4 w-4" />
            Download Your Copy
          </Button>
        )}

        <ContractText title="Company Policies" body={record.contract_company_policies} />
        <ContractText title="Terms &amp; Conditions" body={record.contract_terms} />
        <ContractText title="Additional Notes" body={record.contract_additional_notes} />
      </CardContent>
    </Card>
  )
}

function OnboardingCard({ record }: { record: ApplicationTrackingRecord }) {
  if (!record.deployment_date) return null

  const scheduleHours =
    record.deployment_schedule_start && record.deployment_schedule_end
      ? `${formatScheduleTime(record.deployment_schedule_start)} – ${formatScheduleTime(record.deployment_schedule_end)}`
      : '—'

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-6">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-secondary" />
          <h2 className="font-display text-base font-semibold text-foreground">Where You&apos;re Reporting</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="First Day" value={formatDate(record.deployment_date)} />
          <Field label="Branch" value={record.deployment_branch ?? '—'} />
          <Field label="Work Location" value={record.deployment_work_location ?? '—'} />
          <Field label="Shift" value={record.deployment_schedule_name ?? '—'} />
          <Field label="Working Hours" value={scheduleHours} />
          <Field
            label="Working Days"
            value={record.deployment_schedule_days ? formatWorkingDays(record.deployment_schedule_days) : '—'}
          />
        </div>
        {record.deployment_remarks && (
          <div>
            <p className="text-xs text-muted-foreground">Notes from HR</p>
            <p className="whitespace-pre-line text-sm text-foreground">{record.deployment_remarks}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function EmployeeRecordCard({
  record,
  credentials,
}: {
  record: ApplicationTrackingRecord
  credentials: ApplicantCredentials
}) {
  const download = useApplicantFileDownload()
  if (!record.employee_number) return null


  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-6">
        <div className="flex items-center gap-2">
          <IdCard className="h-4 w-4 text-secondary" />
          <h2 className="font-display text-base font-semibold text-foreground">Your Employee Record</h2>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Employee Number" value={<span className="font-mono">{record.employee_number}</span>} />
          <Field label="Date Hired" value={formatDate(record.employee_hire_date)} />
          <Field label="Position" value={record.employee_position ?? '—'} />
          <Field label="Department" value={record.employee_department ?? '—'} />
          <Field
            label="Basic Salary"
            value={record.employee_basic_salary != null ? formatMoney(record.employee_basic_salary) : '—'}
          />
          <Field
            label="Employment Type"
            value={record.employee_employment_type ? EMPLOYMENT_TYPE_LABEL[record.employee_employment_type] : '—'}
          />
          <Field
            label="Employment Status"
            value={record.employee_employment_status ? EMPLOYMENT_STATUS_LABEL[record.employee_employment_status] : '—'}
          />
          <Field label="Work Email" value={record.employee_email ?? '—'} />
        </div>

        {record.employee_benefits && (
          <div>
            <p className="text-xs text-muted-foreground">Benefits</p>
            <p className="whitespace-pre-line text-sm text-foreground">{record.employee_benefits}</p>
          </div>
        )}

        {/* The password itself is never shown here — HR hands it over directly,
          * and this page is reachable with nothing but a reference code. */}
        {record.account_email && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
            <p className="flex items-center gap-2 font-display text-sm font-semibold text-foreground">
              <KeyRound className="h-4 w-4 text-accent" />
              Your Employee Account Is Ready
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Sign in at the employee portal with <span className="font-medium text-foreground">{record.account_email}</span>.
              HR will give you your starting password — you&apos;ll be asked to change it after your first sign-in.
            </p>
            {record.account_activated_at && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Created {formatDateTime(record.account_activated_at)}
              </p>
            )}
          </div>
        )}

        {record.documents.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Paperclip className="h-3.5 w-3.5" />
              Documents On File
            </p>
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {record.documents.map((doc) => (
                <li key={doc.file_path} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <div>
                    <p className="text-sm text-foreground">{doc.document_type}</p>
                    <p className="text-xs text-muted-foreground">Filed {formatDate(doc.uploaded_at)}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      download.mutate(
                        { credentials, bucket: 'employee-documents', path: doc.file_path },
                        { onError: (e) => toast.error(e.message) }
                      )
                    }
                  >
                    <Download className="h-4 w-4" />
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StatusResult({
  credentials,
  onSignOut,
}: {
  credentials: ApplicantCredentials
  onSignOut: () => void
}) {
  const { data: record, isLoading, error } = useApplicationTracking(credentials)
  const { data: milestones, isLoading: milestonesLoading } = useApplicationMilestones(credentials)

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (error || !record) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertCircle className="h-6 w-6" />
          </div>
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : 'No application matches those details.'}
          </p>
          <Button variant="outline" onClick={onSignOut}>
            Try Again
          </Button>
        </CardContent>
      </Card>
    )
  }

  const copy = APPLICANT_STATUS_COPY[record.status]

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-xs text-muted-foreground">{record.reference_code}</p>
              <h1 className="font-display text-xl font-bold text-foreground">{record.applicant_name}</h1>
              <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" />
                {record.position_title ?? 'Position'} · {record.department_name ?? 'Department'}
                {record.position_employment_type && (
                  <>
                    {' · '}
                    <span className="font-medium text-foreground">
                      {EMPLOYMENT_TYPE_SHORT_LABEL[record.position_employment_type]}
                    </span>
                  </>
                )}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>

          <div className="rounded-lg border border-secondary/30 bg-secondary/5 p-4">
            <p className="font-display text-base font-semibold text-foreground">{copy.label}</p>
            <p className="mt-1 text-sm text-muted-foreground">{copy.detail}</p>

            {/* Set expectations while it's still being screened, so a quiet
              * week doesn't read as being ignored. */}
            {record.status === 'submitted' && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {daysRemaining(record.submitted_at) > 0
                  ? `We aim to respond within ${RESPONSE_WINDOW_DAYS} days of applying — about ${daysRemaining(record.submitted_at)} day${daysRemaining(record.submitted_at) === 1 ? '' : 's'} left.`
                  : `We aim to respond within ${RESPONSE_WINDOW_DAYS} days. Yours is taking a little longer — thank you for your patience.`}
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">Submitted {formatDateTime(record.submitted_at)}</p>
        </CardContent>
      </Card>

      {/* The current interview keeps its own card -- it is the thing an
          applicant most often opens this page for. The journey sits alongside
          it rather than replacing it. */}
      <InterviewCard record={record} />
      <JourneyCard milestones={milestones ?? []} isLoading={milestonesLoading} />
      <OfferCard record={record} credentials={credentials} />
      <ContractCard record={record} credentials={credentials} />
      <OnboardingCard record={record} />
      <EmployeeRecordCard record={record} credentials={credentials} />
    </div>
  )
}

export default function TrackApplicationPage() {
  // Held in sessionStorage rather than component state so browsing to Careers
  // or Home and coming back doesn't sign the applicant out. Still tab-scoped
  // and expiring — see lib/applicantSession.ts for why not localStorage.
  const [credentials, setCredentialsState] = React.useState<ApplicantCredentials | null>(loadApplicantSession)

  const setCredentials = React.useCallback((next: ApplicantCredentials | null) => {
    if (next) saveApplicantSession(next)
    else clearApplicantSession()
    setCredentialsState(next)
  }, [])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-12 sm:px-6">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <h1 className="font-display text-2xl font-bold text-foreground sm:text-3xl">Track Your Application</h1>
        <p className="mt-2 text-muted-foreground">
          Enter the reference number from your confirmation screen to see where your application stands, view interview
          details, and respond to a job offer.
        </p>
      </motion.div>

      {credentials ? (
        <StatusResult credentials={credentials} onSignOut={() => setCredentials(null)} />
      ) : (
        <LookupForm onSubmit={setCredentials} isLoading={false} />
      )}
    </div>
  )
}
