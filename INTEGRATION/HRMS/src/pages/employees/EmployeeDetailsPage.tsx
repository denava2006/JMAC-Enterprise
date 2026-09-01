import * as React from 'react'
import { formatAddress } from '@/components/AddressFields'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRightLeft, Briefcase, Building2, Cake, Calendar, CheckCircle2, Globe, IdCard, KeyRound, Mail, MapPin, Pencil, Phone, Users2, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EditPersonalInfoDialog } from '@/components/employees/EditPersonalInfoDialog'
import { EditEmploymentInfoDialog } from '@/components/employees/EditEmploymentInfoDialog'
import { TransferEmployeeDialog } from '@/components/employees/TransferEmployeeDialog'
import { EmployeeSystemAccess } from '@/components/employees/EmployeeSystemAccess'
import { EmployeeDocumentsTab } from '@/components/employees/EmployeeDocumentsTab'
import { AdjustLeaveBalanceDialog } from '@/components/leave/AdjustLeaveBalanceDialog'
import {
  useEmployeeDetail,
  useEmployeeHistory,
  useEmployeeAuditLog,
  useCreateEmployeeAccount,
  useSendPasswordReset,
  useSetEmployeeAccountStatus,
} from '@/hooks/useEmployees'
import { useEmployeeAttendanceSummary, type EmployeeAttendanceSummary } from '@/hooks/useAttendance'
import { useEmployeeLeaveSummary, type EmployeeLeaveSummary } from '@/hooks/useLeave'
import { EMPLOYMENT_TYPE_LABEL } from '@/lib/jobPostingLabels'
import { EMPLOYMENT_STATUS_LABEL, EMPLOYMENT_STATUS_VARIANT, EMPLOYEE_HISTORY_EVENT_LABEL } from '@/lib/employeeLabels'
import { formatMoney, type CurrencyCode } from '@/lib/currency'
import { formatHoursAsDuration } from '@/lib/attendanceCalculations'

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function Field({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm text-foreground">{value || '—'}</p>
      </div>
    </div>
  )
}

function TimelineStep({ label, timestamp, actor }: { label: string; timestamp: string; actor?: string }) {
  return (
    <li className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
        <CheckCircle2 className="h-3.5 w-3.5" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">
          {formatDateTime(timestamp)}
          {actor ? ` · ${actor}` : ''}
        </p>
      </div>
    </li>
  )
}

/** The default every employee login is created with and reset to. Documented
 * rather than emailed because the app runs on a per-deployer local stack with
 * no reachable mailbox — see create-employee-account. */

/** Employee ID, email, and password in one place. HR reads these out to the
 * employee; having them in three different places is how people end up being
 * told the wrong one. */
function CredentialsPanel({
  employeeNumber,
  email,
  hasOwnPassword,
}: {
  employeeNumber: string
  email: string
  /** True once the employee has set a password of their own, which HR does not
   * know. Showing the default at that point is worse than showing nothing —
   * it's an answer that no longer works. */
  hasOwnPassword?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4">
      <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <IdCard className="h-3.5 w-3.5" />
        Sign-in details
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">Employee ID</p>
          <p className="font-mono text-sm text-foreground">{employeeNumber}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Email</p>
          <p className="text-sm break-all text-foreground">{email}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Password</p>
          <p className="text-sm text-muted-foreground">
            {hasOwnPassword ? 'Known only to the employee' : 'Not set yet'}
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {hasOwnPassword
          ? 'Nobody else can see it. Send a reset link if they cannot get in.'
          : 'They set their own from the link in their setup email; there is no password to hand over.'}
      </p>
    </div>
  )
}

function DetailsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  )
}

export default function EmployeeDetailsPage() {
  const { employeeId } = useParams<{ employeeId: string }>()
  const { data: employee, isLoading } = useEmployeeDetail(employeeId)
  const { data: history } = useEmployeeHistory(employeeId)
  const { data: auditLog } = useEmployeeAuditLog(employeeId)
  const createAccount = useCreateEmployeeAccount()
  const sendReset = useSendPasswordReset()
  const setAccountStatus = useSetEmployeeAccountStatus()

  const [editPersonalOpen, setEditPersonalOpen] = React.useState(false)
  const [editEmploymentOpen, setEditEmploymentOpen] = React.useState(false)
  const [transferOpen, setTransferOpen] = React.useState(false)

  if (isLoading || !employee) {
    return <DetailsSkeleton />
  }

  const currency = (employee.currency as CurrencyCode) ?? 'PHP'
  const account = employee.profiles

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard/employees">
            <ArrowLeft className="h-4 w-4" />
            Back to Employees
          </Link>
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary font-display text-xl font-bold text-primary-foreground">
              {employee.first_name[0]}
              {employee.last_name[0]}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-xl font-semibold text-foreground">
                  {employee.first_name} {employee.middle_name ? `${employee.middle_name} ` : ''}
                  {employee.last_name}
                </h2>
                <Badge variant={EMPLOYMENT_STATUS_VARIANT[employee.employment_status]}>
                  {EMPLOYMENT_STATUS_LABEL[employee.employment_status]}
                </Badge>
              </div>
              <p className="font-mono text-sm text-muted-foreground">{employee.employee_number}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="personal">
        <TabsList>
          <TabsTrigger value="personal">Personal</TabsTrigger>
          <TabsTrigger value="employment">Employment</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="attendance">Attendance</TabsTrigger>
          <TabsTrigger value="leave">Leave</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="personal">
          <Card>
            <CardContent className="flex flex-col gap-4 p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Personal Information</h3>
                <Button variant="outline" size="sm" onClick={() => setEditPersonalOpen(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                <Field icon={Mail} label="Email" value={employee.email} />
                <Field icon={Phone} label="Contact Number" value={employee.phone ?? ''} />
                <Field icon={MapPin} label="Address" value={formatAddress({ street: employee.address ?? '', barangay: employee.barangay ?? '', city: employee.city ?? '', province: employee.province ?? '' })} />
                <Field icon={Cake} label="Birth Date" value={formatDate(employee.birth_date)} />
                <Field icon={Users2} label="Civil Status" value={employee.civil_status ?? ''} />
                <Field icon={Globe} label="Nationality" value={employee.nationality ?? ''} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="employment">
          <Card>
            <CardContent className="flex flex-col gap-4 p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employment Information</h3>
                <div className="flex items-center gap-2">
                  {/* Separate from Edit on purpose: a position decides which
                      systems its holder may be assigned to, so moving somebody
                      is its own deliberate act rather than one dropdown among
                      the pay fields. */}
                  <Button variant="outline" size="sm" onClick={() => setTransferOpen(true)}>
                    <ArrowRightLeft className="h-3.5 w-3.5" />
                    Transfer or promote
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditEmploymentOpen(true)}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                <Field icon={Building2} label="Department" value={employee.departments?.name ?? ''} />
                <Field icon={Briefcase} label="Position" value={employee.positions?.title ?? ''} />
                <Field icon={Briefcase} label="Employment Type" value={EMPLOYMENT_TYPE_LABEL[employee.employment_type]} />
                <Field icon={Calendar} label="Date Hired" value={formatDate(employee.hire_date)} />
                <Field icon={Wallet} label="Salary Grade" value={employee.salary_grades?.grade_name ?? 'None'} />
                <Field icon={Wallet} label="Basic Salary" value={formatMoney(employee.basic_salary, currency)} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="account">
          <Card>
            <CardContent className="flex flex-col gap-4 p-6">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Account Information</h3>
              {!account ? (
                <div className="flex flex-col items-start gap-3">
                  <p className="text-sm text-muted-foreground">
                    No account has been created for this employee yet. Creating one emails them a setup link;
                    they choose their own password from it.
                  </p>
                  <CredentialsPanel
                    employeeNumber={employee.employee_number}
                    email={employee.email}
                  />
                  <Button
                    loading={createAccount.isPending}
                    onClick={() =>
                      createAccount.mutate({
                        employeeId: employee.id,
                        email: employee.email,
                        fullName: `${employee.first_name} ${employee.last_name}`,
                      })
                    }
                  >
                    Create account
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
                    <Field icon={Mail} label="Email" value={account.email} />
                    <div>
                      <p className="text-xs text-muted-foreground">Account Status</p>
                      <Badge variant={account.status === 'active' ? 'success' : 'muted'}>
                        {account.status === 'active' ? 'Active' : 'Disabled'}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Activation Status</p>
                      <Badge variant={account.activated_at ? 'success' : 'warning'}>
                        {account.activated_at ? 'Active' : 'Awaiting setup'}
                      </Badge>
                    </div>
                    <Field icon={Calendar} label="Last Login" value={formatDateTime(account.last_login_at)} />
                  </div>
                  {/* Restated after creation too: this is the page HR opens
                    * when an employee says they can't get in. */}
                  <CredentialsPanel
                    employeeNumber={employee.employee_number}
                    email={account.email}
                    hasOwnPassword={!!account.activated_at}
                  />

                  <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                    {/* A link, not a password. HR starts the flow; only the
                        employee ever learns the result. */}
                    <Button
                      variant="outline"
                      loading={sendReset.isPending}
                      onClick={() => sendReset.mutate({ email: account.email, activated: !!account.activated_at })}
                    >
                      <KeyRound className="h-4 w-4" />
                      {account.activated_at ? 'Send password reset' : 'Resend setup link'}
                    </Button>
                    {account.status === 'active' ? (
                      <Button
                        variant="outline"
                        className="text-destructive hover:text-destructive"
                        loading={setAccountStatus.isPending}
                        onClick={() => setAccountStatus.mutate({ profileId: account.id, employeeId: employee.id, status: 'inactive' })}
                      >
                        Disable Account
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        loading={setAccountStatus.isPending}
                        onClick={() => setAccountStatus.mutate({ profileId: account.id, employeeId: employee.id, status: 'active' })}
                      >
                        Activate Account
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="mt-2 flex flex-col gap-3 border-t border-border pt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  System Access
                </h3>
                <EmployeeSystemAccess
                  profileId={account?.id ?? null}
                  positionId={employee.position_id}
                  employmentStatus={employee.employment_status}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="documents">
          <Card>
            <CardContent className="p-6">
              <EmployeeDocumentsTab employeeId={employee.id} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="attendance">
          <Card>
            <CardContent className="p-6">
              <EmployeeAttendanceSummaryTab employeeId={employee.id} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="leave">
          <Card>
            <CardContent className="p-6">
              <EmployeeLeaveSummaryTab employeeId={employee.id} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="timeline">
          <Card>
            <CardContent className="p-6">
              {history && history.length > 0 ? (
                <ol className="flex flex-col gap-4">
                  {history.map((entry) => (
                    <TimelineStep
                      key={entry.id}
                      label={EMPLOYEE_HISTORY_EVENT_LABEL[entry.event] ?? entry.event}
                      timestamp={entry.created_at}
                      actor={entry.actor?.full_name}
                    />
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">No timeline events yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardContent className="p-6">
              {auditLog && auditLog.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditLog.map((entry) => {
                      const date = new Date(entry.created_at)
                      return (
                        <TableRow key={entry.id}>
                          <TableCell>{entry.actor?.full_name ?? 'System'}</TableCell>
                          <TableCell>{entry.action}</TableCell>
                          <TableCell>{date.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })}</TableCell>
                          <TableCell>{date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">No audit log entries yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <EditPersonalInfoDialog open={editPersonalOpen} onOpenChange={setEditPersonalOpen} employee={employee} />
      <EditEmploymentInfoDialog open={editEmploymentOpen} onOpenChange={setEditEmploymentOpen} employee={employee} />
      <TransferEmployeeDialog open={transferOpen} onOpenChange={setTransferOpen} employee={employee} />
    </div>
  )
}

function SummaryPeriodCard({ label, summary }: { label: string; summary: EmployeeAttendanceSummary }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Present</p>
          <p className="font-medium text-foreground">{summary.present}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Late</p>
          <p className="font-medium text-foreground">{summary.late}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Absent</p>
          <p className="font-medium text-foreground">{summary.absent}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">On Leave</p>
          <p className="font-medium text-foreground">{summary.onLeave}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Working Hours</p>
          <p className="font-medium text-foreground">{formatHoursAsDuration(summary.workingHours)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Overtime</p>
          <p className="font-medium text-foreground">{formatHoursAsDuration(summary.overtimeHours)}</p>
        </div>
      </div>
      <div className="mt-2 border-t border-border pt-2">
        <p className="text-xs text-muted-foreground">Attendance Rate</p>
        <p className="font-display text-lg font-bold text-foreground">{summary.attendancePercentage}%</p>
      </div>
    </div>
  )
}

function EmployeeAttendanceSummaryTab({ employeeId }: { employeeId: string }) {
  const { data, isLoading } = useEmployeeAttendanceSummary(employeeId)

  if (isLoading || !data) {
    return <p className="text-sm text-muted-foreground">Loading attendance summary…</p>
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryPeriodCard label="Today" summary={data.today} />
      <SummaryPeriodCard label="This Week" summary={data.thisWeek} />
      <SummaryPeriodCard label="This Month" summary={data.thisMonth} />
      <SummaryPeriodCard label="Overall" summary={data.overall} />
    </div>
  )
}

function EmployeeLeaveSummaryTab({ employeeId }: { employeeId: string }) {
  const { data, isLoading } = useEmployeeLeaveSummary(employeeId)
  const [adjusting, setAdjusting] = React.useState<EmployeeLeaveSummary['balances'][number] | null>(null)

  if (isLoading || !data) {
    return <p className="text-sm text-muted-foreground">Loading leave summary…</p>
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-3 text-center">
          <p className="text-xs text-muted-foreground">Pending Requests</p>
          <p className="font-display text-xl font-bold text-foreground">{data.pending}</p>
        </div>
        <div className="rounded-lg border border-border p-3 text-center">
          <p className="text-xs text-muted-foreground">Approved Requests</p>
          <p className="font-display text-xl font-bold text-foreground">{data.approved}</p>
        </div>
        <div className="rounded-lg border border-border p-3 text-center">
          <p className="text-xs text-muted-foreground">Rejected Requests</p>
          <p className="font-display text-xl font-bold text-foreground">{data.rejected}</p>
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Leave Balances ({new Date().getFullYear()})</h4>
        <div className="flex flex-col gap-2">
          {data.balances.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{b.leave_types.name}</p>
                <p className="text-xs text-muted-foreground">
                  {Number(b.used_credits)} used of {Number(b.total_credits)} · {Number(b.remaining_credits)} remaining
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setAdjusting(b)}>
                Adjust
              </Button>
            </div>
          ))}
        </div>
      </div>

      <AdjustLeaveBalanceDialog open={!!adjusting} onOpenChange={(open) => !open && setAdjusting(null)} balance={adjusting} />
    </div>
  )
}
