import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Mail,
  Phone,
  MapPin,
  Briefcase,
  Building2,
  CheckCircle2,
  Circle,
  Inbox,
  Printer,
  Lock,
} from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
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
import { formatAddress } from '@/components/AddressFields'
import { ResumeViewer } from '@/components/recruitment/ResumeViewer'
import { JobOfferDialog } from '@/components/deployment/JobOfferDialog'
import { ContractDialog } from '@/components/deployment/ContractDialog'
import { SigningDialog } from '@/components/deployment/SigningDialog'
import { DeploymentFormDialog } from '@/components/deployment/DeploymentFormDialog'
import { useApplicationHistory } from '@/hooks/useRecruitment'
import { useWorkSchedules } from '@/hooks/useWorkSchedules'
import {
  useDeploymentApplicationDetail,
  useGenerateContract,
  useCloseUnresponsiveOffer,
  useCloseDeclinedApplication,
  getLatestOffer,
  getLatestContract,
  getFinalInterview,
  getDeploymentRecord,
} from '@/hooks/useDeployment'
import { APPLICATION_STATUS_LABEL, APPLICATION_STATUS_VARIANT, type ApplicationStatus } from '@/lib/applicationStatusLabels'
import { EMPLOYMENT_TYPE_LABEL } from '@/lib/jobPostingLabels'
import { formatMoney, type CurrencyCode } from '@/lib/currency'
import {
  DEPLOYMENT_STAGE_LABEL,
  DEPLOYMENT_STAGE_VARIANT,
  OFFER_STATUS_LABEL,
  OFFER_STATUS_VARIANT,
  CONTRACT_STATUS_LABEL,
  CONTRACT_STATUS_VARIANT,
  deriveDeploymentStage,
} from '@/lib/deploymentLabels'
import { RESPONSE_WINDOW_DAYS, daysSince, isAwaitingResponseTooLong } from '@/lib/applicationSla'
import { resolveSubmittedApplicant } from '@/lib/hiring'

const HISTORY_EVENT_LABEL: Record<string, string> = {
  submitted: 'Application Submitted',
  reviewed: 'Application Reviewed',
  qualified: 'Qualified',
  rejected: 'Rejected',
  initial_interview_scheduled: 'Initial Interview Scheduled',
  initial_interview_started: 'Initial Interview Started',
  initial_interview_passed: 'Passed Initial Interview',
  initial_interview_rejected: 'Rejected (Initial Interview)',
  final_interview_scheduled: 'Final Interview Scheduled',
  final_interview_started: 'Final Interview Started',
  final_interview_rejected: 'Rejected (Final Interview)',
  hired: 'Hired',
  job_offer_prepared: 'Job Offer Prepared',
  offer_accepted: 'Offer Accepted',
  offer_declined: 'Offer Declined',
  application_closed: 'Application Closed',
  contract_prepared: 'Employment Contract Prepared',
  contract_generated: 'Contract Generated',
  contract_signed: 'Contract Signed',
  deployment_completed: 'Employee Deployed Successfully',
  pending_employee_record_created: 'Pending Employee Record Created',
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  )
}

function Rating({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value ? `${value} / 5` : '—'}</p>
    </div>
  )
}

function TimelineStep({ label, done, timestamp }: { label: string; done: boolean; timestamp?: string | null }) {
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
        {timestamp && <p className="text-xs text-muted-foreground">{formatDateTime(timestamp)}</p>}
      </div>
    </li>
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

export function DeploymentDetailsSheet({
  applicationId,
  open,
  onOpenChange,
}: {
  applicationId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const { data: application, isLoading } = useDeploymentApplicationDetail(applicationId ?? undefined)
  const { data: history } = useApplicationHistory(applicationId ?? undefined)
  const generateContract = useGenerateContract()
  const { data: workSchedules } = useWorkSchedules()

  const [offerDialogOpen, setOfferDialogOpen] = React.useState(false)
  const [contractDialogOpen, setContractDialogOpen] = React.useState(false)
  const [signingDialogOpen, setSigningDialogOpen] = React.useState(false)
  const [deploymentDialogOpen, setDeploymentDialogOpen] = React.useState(false)
  const [closeConfirmOpen, setCloseConfirmOpen] = React.useState(false)
  const closeUnresponsive = useCloseUnresponsiveOffer()
  const closeDeclined = useCloseDeclinedApplication()

  if (!application && !isLoading) return null

  // The identity this application was submitted with, never the
  // applicant master -- that row moves with the person's newest
  // application and would rewrite this screen's history.
  const applicant = resolveSubmittedApplicant(application, application?.applicants)
  const jobPosting = application?.job_postings
  const offer = application ? getLatestOffer(application) : null
  const contract = application ? getLatestContract(offer) : null
  const finalInterview = application ? getFinalInterview(application) : null
  const deploymentRecord = application ? getDeploymentRecord(application) : null

  // The deployment date is the offer's start date, not a separate choice —
  // this is only used to warn when the contract was signed after that day.
  const contractSignedDate = contract?.signed_at ? contract.signed_at.slice(0, 10) : null

  const deploymentSchedule =
    workSchedules?.find((s) => s.id === deploymentRecord?.work_schedule_id) ?? null

  // How long the applicant has had the offer, measured from when it was sent.
  const offerDaysWaited = offer ? daysSince(offer.created_at) : 0
  const offerIsOverdue = !!offer && offer.status === 'pending' && isAwaitingResponseTooLong(offer.created_at)

  const stage = application
    ? deriveDeploymentStage({
        applicationStatus: application.status as ApplicationStatus,
        offerStatus: offer?.status ?? null,
        contractStatus: contract?.status ?? null,
        hasDeploymentRecord: !!deploymentRecord,
      })
    : null

  const onGenerateAndPrint = () => {
    if (!applicationId || !contract) return
    generateContract.mutate(
      { applicationId, contractId: contract.id },
      {
        onSuccess: () => {
          navigate(`/dashboard/deployment/${applicationId}/contract`)
        },
      }
    )
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
                <SheetDescription>{jobPosting?.positions?.title ?? 'a position'}</SheetDescription>
              </SheetHeader>

              <SheetBody className="p-5">
                <div className="flex flex-col gap-5">
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Applicant Summary
                    </h3>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <InfoRow icon={Mail} label="Email" value={applicant?.email ?? '—'} />
                      <InfoRow icon={Phone} label="Phone" value={applicant?.phone ?? '—'} />
                      <InfoRow icon={MapPin} label="Address" value={formatAddress({ street: applicant?.address ?? '', barangay: applicant?.barangay ?? '', city: applicant?.city ?? '', province: applicant?.province ?? '' }) || '—'} />
                      <InfoRow icon={Briefcase} label="Position" value={jobPosting?.positions?.title ?? '—'} />
                      <InfoRow icon={Building2} label="Department" value={jobPosting?.departments?.name ?? '—'} />
                    </div>
                  </section>

                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Interview Result
                    </h3>
                    {finalInterview ? (
                      <div className="rounded-lg border border-border p-3">
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                          <Rating label="Technical Evaluation" value={finalInterview.rating_technical_evaluation} />
                          <Rating label="Culture Fit" value={finalInterview.rating_culture_fit} />
                          <Rating label="Leadership" value={finalInterview.rating_leadership} />
                        </div>
                        {finalInterview.final_remarks && (
                          <div className="mt-3">
                            <Field label="Final Remarks" value={finalInterview.final_remarks} />
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No final interview evaluation on file.</p>
                    )}
                    <div className="flex flex-col gap-1.5">
                      <Label>Resume</Label>
                      <ResumeViewer resumePath={applicant?.resume_url ?? null} />
                    </div>
                  </section>

                  <section className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Deployment Stage
                      </h3>
                      <Badge variant={DEPLOYMENT_STAGE_VARIANT[stage]}>{DEPLOYMENT_STAGE_LABEL[stage]}</Badge>
                    </div>
                    <ol className="flex flex-col gap-4">
                      <TimelineStep label="Job Offer Prepared" done={!!offer} timestamp={offer?.created_at} />
                      <TimelineStep
                        label="Offer Accepted"
                        done={offer?.status === 'accepted'}
                        timestamp={offer?.status === 'accepted' ? offer.responded_at : undefined}
                      />
                      <TimelineStep label="Employment Contract Prepared" done={!!contract} timestamp={contract?.created_at} />
                      <TimelineStep
                        label="Contract Generated"
                        done={contract?.status === 'printed' || contract?.status === 'signed'}
                        timestamp={contract && contract.status !== 'draft' ? contract.updated_at : undefined}
                      />
                      <TimelineStep
                        label="Contract Signed"
                        done={contract?.status === 'signed'}
                        timestamp={contract?.status === 'signed' ? contract.signed_at : undefined}
                      />
                      <TimelineStep
                        label="Deployment Completed"
                        done={!!deploymentRecord}
                        timestamp={deploymentRecord?.created_at}
                      />
                    </ol>
                  </section>

                  {offer && (
                    <section className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Offer Information
                      </h3>
                      <div className="rounded-lg border border-border p-3">
                        <div className="mb-3 flex items-center justify-between">
                          <Badge variant={OFFER_STATUS_VARIANT[offer.status]}>{OFFER_STATUS_LABEL[offer.status]}</Badge>
                          <span className="text-xs text-muted-foreground">Prepared by {offer.preparer?.full_name ?? '—'}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="Employment Type" value={EMPLOYMENT_TYPE_LABEL[offer.employment_type]} />
                          <Field label="Salary" value={formatMoney(offer.proposed_salary, offer.currency as CurrencyCode)} />
                          <Field label="Salary Grade" value={offer.salary_grades?.grade_name ?? '—'} />
                          <Field label="Start Date" value={formatDate(offer.start_date)} />
                          <Field label="Working Hours" value={offer.working_hours ?? '—'} />
                          <Field label="Working Days" value={offer.working_days ?? '—'} />
                        </div>

                        {/* The one thing worth having from a candidate who
                          * said no. Offers declined before this was collected
                          * simply have nothing here. */}
                        {offer.status === 'declined' && offer.decline_reason && (
                          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                            <p className="text-xs text-muted-foreground">Why they declined</p>
                            <p className="text-sm font-medium text-foreground">{offer.decline_reason}</p>
                            {offer.decline_notes && (
                              <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{offer.decline_notes}</p>
                            )}
                          </div>
                        )}
                      </div>
                    </section>
                  )}

                  {contract && (
                    <section className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Contract Information
                      </h3>
                      <div className="rounded-lg border border-border p-3">
                        <div className="mb-3 flex items-center justify-between">
                          <Badge variant={CONTRACT_STATUS_VARIANT[contract.status]}>
                            {CONTRACT_STATUS_LABEL[contract.status]}
                          </Badge>
                          {contract.status !== 'draft' && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/dashboard/deployment/${applicationId}/contract`)}
                            >
                              <Printer className="h-3.5 w-3.5" />
                              View / Print
                            </Button>
                          )}
                        </div>
                        {contract.status === 'signed' && (
                          <div className="grid grid-cols-2 gap-3">
                            <Field label="Signed By" value={contract.signer?.full_name ?? '—'} />
                            <Field label="Signing Date" value={formatDate(contract.signed_at)} />
                          </div>
                        )}
                        {contract.signing_notes && (
                          <div className="mt-3 border-t border-border pt-3">
                            <Field label="Signing Notes" value={contract.signing_notes} />
                          </div>
                        )}
                      </div>
                    </section>
                  )}

                  {deploymentRecord && (
                    <section className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Deployment Details
                      </h3>
                      <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
                        <Field label="Deployment Date" value={formatDate(deploymentRecord.deployment_date)} />
                        <Field label="Assigned Branch" value={deploymentRecord.assigned_branch ?? '—'} />
                        <Field label="Work Location" value={deploymentRecord.work_location ?? '—'} />
                        <Field label="Work Schedule" value={deploymentSchedule?.name ?? '—'} />
                        <Field label="Deployed By" value={deploymentRecord.deployer?.full_name ?? '—'} />
                      </div>
                    </section>
                  )}

                  <section className="flex flex-col gap-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Activity History
                    </h3>
                    <ol className="flex flex-col gap-4">
                      {history?.map((entry) => (
                        <li key={entry.id} className="flex gap-3">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                            <Inbox className="h-3.5 w-3.5" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-foreground">
                              {HISTORY_EVENT_LABEL[entry.event] ?? entry.event}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatDateTime(entry.created_at)}
                              {entry.actor?.full_name ? ` · ${entry.actor.full_name}` : ''}
                            </p>
                            {entry.notes && <p className="mt-1 text-xs text-muted-foreground">{entry.notes}</p>}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                </div>
              </SheetBody>

              <SheetFooter className="p-5">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Back
                </Button>

                {stage === 'pending_offer' && (
                  <Button type="button" onClick={() => setOfferDialogOpen(true)}>
                    Prepare Job Offer
                  </Button>
                )}

                {/* Accepting or declining is the applicant's decision, made from
                  * the tracking portal (/track) — HR only watches for it here.
                  * Once the response window lapses HR can close it out, so an
                  * unanswered offer can't hold a requisition open forever. */}
                {stage === 'awaiting_offer_response' && offer && (
                  offerIsOverdue ? (
                    <div className="flex flex-col items-end gap-2">
                      <p className="text-xs text-warning">
                        No response for {offerDaysWaited} days — past the {RESPONSE_WINDOW_DAYS}-day window.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        className="text-destructive hover:text-destructive"
                        loading={closeUnresponsive.isPending}
                        onClick={() => setCloseConfirmOpen(true)}
                      >
                        Close — No Response
                      </Button>
                    </div>
                  ) : (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Lock className="h-3.5 w-3.5" />
                      Waiting for the applicant to respond ({offerDaysWaited} of {RESPONSE_WINDOW_DAYS} days).
                    </p>
                  )
                )}

                {stage === 'offer_accepted' && (
                  <Button type="button" onClick={() => setContractDialogOpen(true)}>
                    Prepare Employment Contract
                  </Button>
                )}

                {stage === 'contract_draft' && (
                  <Button type="button" loading={generateContract.isPending} onClick={onGenerateAndPrint}>
                    Generate &amp; Print Contract
                  </Button>
                )}

                {stage === 'contract_ready' && (
                  <Button type="button" onClick={() => setSigningDialogOpen(true)}>
                    Record Signing
                  </Button>
                )}

                {stage === 'contract_signed' && (
                  <Button type="button" onClick={() => setDeploymentDialogOpen(true)}>
                    Complete Deployment
                  </Button>
                )}

                {stage === 'offer_declined' &&
                  (application.status === 'closed' ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Lock className="h-3.5 w-3.5" />
                      The applicant declined this offer and the application is closed.
                    </p>
                  ) : (
                    <div className="flex flex-col items-end gap-2">
                      <p className="text-xs text-warning">
                        The applicant declined this offer. Close the application when you&apos;ve finished with it.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        className="text-destructive hover:text-destructive"
                        loading={closeDeclined.isPending}
                        onClick={() => applicationId && closeDeclined.mutate({ applicationId })}
                      >
                        Close Application
                      </Button>
                    </div>
                  ))}

                {stage === 'deployed' && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock className="h-3.5 w-3.5" />
                    Deployment complete — this record is locked.
                  </p>
                )}
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      {applicationId && jobPosting && (
        <JobOfferDialog
          open={offerDialogOpen}
          onOpenChange={setOfferDialogOpen}
          applicationId={applicationId}
          positionTitle={jobPosting.positions?.title ?? 'this position'}
          departmentName={jobPosting.departments?.name ?? '—'}
          employmentType={jobPosting.employment_type}
        />
      )}

      {applicationId && offer && (
        <ContractDialog
          open={contractDialogOpen}
          onOpenChange={setContractDialogOpen}
          applicationId={applicationId}
          applicantName={`${applicant?.first_name ?? ''} ${applicant?.last_name ?? ''}`.trim()}
          positionTitle={jobPosting?.positions?.title ?? '—'}
          departmentName={jobPosting?.departments?.name ?? '—'}
          offer={offer}
        />
      )}

      {applicationId && contract && (
        <SigningDialog
          open={signingDialogOpen}
          onOpenChange={setSigningDialogOpen}
          applicationId={applicationId}
          contractId={contract.id}
        />
      )}

      {applicationId && jobPosting && (
        <DeploymentFormDialog
          open={deploymentDialogOpen}
          onOpenChange={setDeploymentDialogOpen}
          applicationId={applicationId}
          startDate={offer?.start_date}
          contractSignedDate={contractSignedDate}
          offerWorkScheduleId={offer?.work_schedule_id}
          employmentType={jobPosting.employment_type}
        />
      )}

      <AlertDialog open={closeConfirmOpen} onOpenChange={setCloseConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close this offer for no response?</AlertDialogTitle>
            <AlertDialogDescription>
              {applicant?.first_name} {applicant?.last_name} hasn't responded in {offerDaysWaited} days. This closes the
              application so the role can be filled by someone else. It can't be undone — if they get in touch
              afterwards, they'd need to be re-offered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (applicationId && offer) {
                  closeUnresponsive.mutate({ applicationId, offerId: offer.id, daysWaited: offerDaysWaited })
                }
                setCloseConfirmOpen(false)
              }}
            >
              Close Application
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
