import * as React from 'react'
import { formatAddress } from '@/components/AddressFields'
import {
  Mail,
  Phone,
  MapPin,
  Briefcase,
  Building2,
  CalendarDays,
  FileText,
  CheckCircle2,
  Circle,
  Link2,
  MapPinned,
  Lock,
} from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { ResumeViewer } from '@/components/recruitment/ResumeViewer'
import { ScheduleInterviewDialog } from '@/components/interviews/ScheduleInterviewDialog'
import { EvaluateInterviewDialog } from '@/components/interviews/EvaluateInterviewDialog'
import { useAuth } from '@/contexts/AuthContext'
import {
  useInterviewApplicationDetail,
  useConductInterview,
  getInterviewByStage,
  type InterviewRecord,
} from '@/hooks/useInterviews'
import { APPLICATION_STATUS_LABEL, APPLICATION_STATUS_VARIANT, type ApplicationStatus } from '@/lib/applicationStatusLabels'
import { DERIVED_STAGE_LABEL, DERIVED_STAGE_VARIANT, INTERVIEW_MODE_LABEL, deriveStage } from '@/lib/interviewLabels'
import { resolveSubmittedApplicant } from '@/lib/hiring'

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function InfoRow({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm text-foreground">{value}</p>
      </div>
    </div>
  )
}

function Rating({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value ? `${value} / 5` : '—'}</p>
    </div>
  )
}

function TimelineStep({
  label,
  done,
  timestamp,
  performedBy,
  notes,
}: {
  label: string
  done: boolean
  timestamp?: string
  performedBy?: string | null
  notes?: string | null
}) {
  return (
    <li className="flex gap-3">
      <div
        className={
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full ' +
          (done ? 'bg-accent/10 text-accent' : 'bg-muted text-muted-foreground')
        }
      >
        {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
      </div>
      <div>
        <p className={'text-sm font-medium ' + (done ? 'text-foreground' : 'text-muted-foreground')}>{label}</p>
        {timestamp && (
          <p className="text-xs text-muted-foreground">
            {formatDateTime(timestamp)}
            {performedBy ? ` · ${performedBy}` : ''}
          </p>
        )}
        {done && notes && <p className="mt-1 text-xs text-muted-foreground">{notes}</p>}
      </div>
    </li>
  )
}

function ScheduledInterviewCard({ interview }: { interview: InterviewRecord }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
        {formatDateTime(interview.scheduled_at)}
      </div>
      <p className="text-muted-foreground">Assigned Interviewer: {interview.interviewer?.full_name ?? '—'}</p>
      <p className="text-muted-foreground">Format: {interview.mode ? INTERVIEW_MODE_LABEL[interview.mode] : '—'}</p>
      {interview.meeting_link && (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Link2 className="h-3.5 w-3.5" />
          <a href={interview.meeting_link} target="_blank" rel="noreferrer" className="text-secondary underline">
            {interview.meeting_link}
          </a>
        </p>
      )}
      {interview.location && (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <MapPinned className="h-3.5 w-3.5" />
          {interview.location}
        </p>
      )}
      {interview.remarks && <p className="text-muted-foreground">Notes: {interview.remarks}</p>}
    </div>
  )
}

function EvaluationSummary({
  interview,
  stage,
}: {
  interview: InterviewRecord
  stage: 'initial' | 'final'
}) {
  const isRejected = interview.status === 'failed'
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      {stage === 'initial' ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Rating label="Communication" value={interview.rating_communication} />
          <Rating label="Technical Skills" value={interview.rating_technical_skills} />
          <Rating label="Confidence" value={interview.rating_confidence} />
          <Rating label="Experience" value={interview.rating_experience} />
          <Rating label="Problem Solving" value={interview.rating_problem_solving} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Rating label="Technical Evaluation" value={interview.rating_technical_evaluation} />
          <Rating label="Culture Fit" value={interview.rating_culture_fit} />
          <Rating label="Leadership" value={interview.rating_leadership} />
        </div>
      )}

      {stage === 'initial' && interview.overall_impression && (
        <div>
          <p className="text-xs text-muted-foreground">Overall Impression</p>
          <p className="text-sm text-foreground">{interview.overall_impression}</p>
        </div>
      )}
      {stage === 'initial' && interview.interview_notes && (
        <div>
          <p className="text-xs text-muted-foreground">Interview Notes</p>
          <p className="text-sm text-foreground">{interview.interview_notes}</p>
        </div>
      )}
      {stage === 'final' && interview.final_remarks && (
        <div>
          <p className="text-xs text-muted-foreground">Final Remarks</p>
          <p className="text-sm text-foreground">{interview.final_remarks}</p>
        </div>
      )}
      {isRejected && interview.rejection_reason && (
        <div>
          <p className="text-xs text-muted-foreground">Rejection Reason</p>
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
            {interview.rejection_reason}
          </p>
        </div>
      )}
    </div>
  )
}

function DetailsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

function ReadOnlyNotice({ interviewerName }: { interviewerName?: string | null }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Lock className="h-3.5 w-3.5" />
      Only {interviewerName ?? 'the assigned interviewer'} can progress this interview. You have read-only access.
    </p>
  )
}

export function InterviewDetailsSheet({
  applicationId,
  open,
  onOpenChange,
}: {
  applicationId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { profile } = useAuth()
  const { data: application, isLoading } = useInterviewApplicationDetail(applicationId ?? undefined)
  const conductInterview = useConductInterview()

  const [scheduleDialogStage, setScheduleDialogStage] = React.useState<'initial' | 'final' | null>(null)
  const [evaluateDialogStage, setEvaluateDialogStage] = React.useState<'initial' | 'final' | null>(null)

  if (!application && !isLoading) return null

  // The identity this application was submitted with, never the
  // applicant master -- that row moves with the person's newest
  // application and would rewrite this screen's history.
  const applicant = resolveSubmittedApplicant(application, application?.applicants)
  const jobPosting = application?.job_postings
  const initial = application ? getInterviewByStage(application.interviews, 'initial') : null
  const final = application ? getInterviewByStage(application.interviews, 'final') : null
  const stage = application ? deriveStage(application.status as ApplicationStatus, initial, final) : null

  // The initial round belongs to whoever scheduled it; the final round belongs
  // to the HR Manager they handed it off to at initial-evaluation time. Everyone
  // else is read-only. The backend (interviews_insert_owner /
  // interviews_update_owner RLS + protect_interview_ownership trigger) enforces
  // both regardless of what the UI shows.
  const isOwner = initial ? initial.interviewer_id === profile?.id : true
  const isFinalOwner = application?.final_interviewer_id === profile?.id
  const finalInterviewerName = application?.final_interviewer?.full_name ?? null

  const onConduct = (interview: InterviewRecord, interviewStage: 'initial' | 'final') => {
    if (!applicationId) return
    conductInterview.mutate({ interviewId: interview.id, applicationId, stage: interviewStage })
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent>
          {isLoading || !application || !stage ? (
            <SheetBody>
              <DetailsSkeleton />
            </SheetBody>
          ) : (
            <>
              <SheetHeader className="gap-1 p-5">
                <div className="flex items-center gap-2">
                  <SheetTitle>
                    {applicant?.first_name} {applicant?.last_name}
                  </SheetTitle>
                  <Badge variant={APPLICATION_STATUS_VARIANT[application.status]}>
                    {APPLICATION_STATUS_LABEL[application.status]}
                  </Badge>
                </div>
                <SheetDescription>Applied for {jobPosting?.positions?.title ?? 'a position'}</SheetDescription>
              </SheetHeader>

              <SheetBody className="p-5">
                <div className="flex flex-col gap-5">
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Personal Information
                    </h3>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <InfoRow icon={Mail} label="Email" value={applicant?.email ?? '—'} />
                      <InfoRow icon={Phone} label="Phone" value={applicant?.phone ?? '—'} />
                      <InfoRow icon={MapPin} label="Address" value={formatAddress({ street: applicant?.address ?? '', barangay: applicant?.barangay ?? '', city: applicant?.city ?? '', province: applicant?.province ?? '' }) || '—'} />
                    </div>
                  </section>

                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Application Information
                    </h3>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <InfoRow icon={Briefcase} label="Applied Position" value={jobPosting?.positions?.title ?? '—'} />
                      <InfoRow icon={Building2} label="Department" value={jobPosting?.departments?.name ?? '—'} />
                      <InfoRow icon={CalendarDays} label="Date Applied" value={formatDateTime(application.created_at)} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Resume</Label>
                      <ResumeViewer resumePath={applicant?.resume_url ?? null} />
                    </div>
                    {applicant?.cover_letter && (
                      <div className="flex flex-col gap-1.5">
                        <Label className="flex items-center gap-1.5">
                          <FileText className="h-3.5 w-3.5" />
                          Cover Letter
                        </Label>
                        <p className="whitespace-pre-line rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground">
                          {applicant.cover_letter}
                        </p>
                      </div>
                    )}
                  </section>

                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Recruitment Summary
                    </h3>
                    <div className="grid grid-cols-2 gap-4 text-sm text-muted-foreground">
                      <span>Reviewer: {application.reviewer?.full_name ?? '—'}</span>
                      <span>Date Qualified: {application.reviewed_at ? formatDateTime(application.reviewed_at) : '—'}</span>
                    </div>
                  </section>

                  <section className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Interview Stage
                      </h3>
                      <Badge variant={DERIVED_STAGE_VARIANT[stage]}>{DERIVED_STAGE_LABEL[stage]}</Badge>
                    </div>
                    <ol className="flex flex-col gap-4">
                      <TimelineStep
                        label="Initial Interview Scheduled"
                        done={!!initial}
                        timestamp={initial?.created_at}
                        performedBy={initial?.interviewer?.full_name}
                        notes={initial?.remarks}
                      />
                      <TimelineStep
                        label="Initial Interview Completed"
                        done={!!initial && (initial.status === 'passed' || initial.status === 'failed')}
                        timestamp={
                          initial && (initial.status === 'passed' || initial.status === 'failed') ? initial.updated_at : undefined
                        }
                        performedBy={initial?.interviewer?.full_name}
                        notes={initial?.interview_notes ?? initial?.rejection_reason}
                      />
                      <TimelineStep
                        label="Final Interview Scheduled"
                        done={!!final}
                        timestamp={final?.created_at}
                        performedBy={final?.interviewer?.full_name}
                        notes={final?.remarks}
                      />
                      <TimelineStep
                        label="Final Interview Completed"
                        done={!!final && (final.status === 'passed' || final.status === 'failed')}
                        timestamp={final && (final.status === 'passed' || final.status === 'failed') ? final.updated_at : undefined}
                        performedBy={final?.interviewer?.full_name}
                        notes={final?.final_remarks ?? final?.rejection_reason}
                      />
                      <TimelineStep
                        label="Hiring Decision"
                        done={application.status === 'hired' || application.status === 'rejected'}
                        timestamp={
                          application.status === 'hired' || application.status === 'rejected'
                            ? application.updated_at
                            : undefined
                        }
                        performedBy={
                          application.status === 'hired'
                            ? final?.interviewer?.full_name
                            : (final ?? initial)?.interviewer?.full_name
                        }
                        notes={application.status === 'rejected' ? application.rejection_reason : undefined}
                      />
                    </ol>
                  </section>

                  {(stage === 'initial_interview_scheduled' || stage === 'under_initial_interview') && initial && (
                    <section className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Scheduled Initial Interview
                      </h3>
                      <ScheduledInterviewCard interview={initial} />
                    </section>
                  )}

                  {(stage === 'final_interview_scheduled' || stage === 'under_final_interview') && final && (
                    <section className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Scheduled Final Interview
                      </h3>
                      <ScheduledInterviewCard interview={final} />
                    </section>
                  )}

                  {initial && (initial.status === 'passed' || initial.status === 'failed') && (
                    <section className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Initial Interview Evaluation
                      </h3>
                      <EvaluationSummary interview={initial} stage="initial" />
                    </section>
                  )}

                  {final && (final.status === 'passed' || final.status === 'failed') && (
                    <section className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Final Interview Evaluation
                      </h3>
                      <EvaluationSummary interview={final} stage="final" />
                    </section>
                  )}
                </div>
              </SheetBody>

              <SheetFooter className="p-5">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Back
                </Button>

                {stage === 'waiting_for_initial_schedule' && (
                  <Button type="button" onClick={() => setScheduleDialogStage('initial')}>
                    Schedule Initial Interview
                  </Button>
                )}

                {stage === 'initial_interview_scheduled' && initial && isOwner && (
                  <Button type="button" loading={conductInterview.isPending} onClick={() => onConduct(initial, 'initial')}>
                    Conduct Interview
                  </Button>
                )}
                {stage === 'initial_interview_scheduled' && initial && !isOwner && (
                  <ReadOnlyNotice interviewerName={initial.interviewer?.full_name} />
                )}

                {stage === 'under_initial_interview' && isOwner && (
                  <Button type="button" onClick={() => setEvaluateDialogStage('initial')}>
                    Continue Evaluation
                  </Button>
                )}
                {stage === 'under_initial_interview' && !isOwner && (
                  <ReadOnlyNotice interviewerName={initial?.interviewer?.full_name} />
                )}

                {stage === 'passed_initial_interview' &&
                  (isFinalOwner ? (
                    <Button type="button" onClick={() => setScheduleDialogStage('final')}>
                      Schedule Final Interview
                    </Button>
                  ) : (
                    <ReadOnlyNotice interviewerName={finalInterviewerName} />
                  ))}

                {stage === 'final_interview_scheduled' &&
                  final &&
                  (isFinalOwner ? (
                    <Button type="button" loading={conductInterview.isPending} onClick={() => onConduct(final, 'final')}>
                      Conduct Interview
                    </Button>
                  ) : (
                    <ReadOnlyNotice interviewerName={final.interviewer?.full_name ?? finalInterviewerName} />
                  ))}

                {stage === 'under_final_interview' &&
                  (isFinalOwner ? (
                    <Button type="button" onClick={() => setEvaluateDialogStage('final')}>
                      Continue Evaluation
                    </Button>
                  ) : (
                    <ReadOnlyNotice interviewerName={final?.interviewer?.full_name ?? finalInterviewerName} />
                  ))}
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      {applicationId && scheduleDialogStage && (
        <ScheduleInterviewDialog
          open={!!scheduleDialogStage}
          onOpenChange={(o) => !o && setScheduleDialogStage(null)}
          applicationId={applicationId}
          stage={scheduleDialogStage}
        />
      )}

      {applicationId && evaluateDialogStage && (evaluateDialogStage === 'initial' ? initial : final) && (
        <EvaluateInterviewDialog
          open={!!evaluateDialogStage}
          onOpenChange={(o) => !o && setEvaluateDialogStage(null)}
          applicationId={applicationId}
          interviewId={(evaluateDialogStage === 'initial' ? initial : final)!.id}
          stage={evaluateDialogStage}
        />
      )}
    </>
  )
}
