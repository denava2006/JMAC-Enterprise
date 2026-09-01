import { useNavigate } from 'react-router-dom'
import { CalendarClock, CalendarCheck, Wallet, IdCard, Bell, ListChecks } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { firstName } from '@/lib/displayName'
import { Badge } from '@/components/ui/badge'
import { WelcomeSection } from '@/components/dashboard/WelcomeSection'
import { DashboardSectionCard, MiniStat, DashboardEmptyState, DashboardListSkeleton } from '@/components/dashboard/DashboardPrimitives'
import { TimeInOutButton } from '@/components/employee-portal/TimeInOutButton'
import {
  useMyEmployeeRecord,
  useMyTodayAttendance,
  useMyAttendanceMonthSummary,
  useMyPayrollRecords,
  useMyLeaveRequests,
  useMyActivity,
  useMyPortalRealtimeAlerts,
} from '@/hooks/useEmployeePortal'
import { useEmployeeLeaveBalances } from '@/hooks/useLeave'
import { formatHoursAsDuration } from '@/lib/attendanceCalculations'
import { EMPLOYMENT_STATUS_LABEL, EMPLOYMENT_STATUS_VARIANT } from '@/lib/employeeLabels'
import { EMPLOYMENT_TYPE_LABEL } from '@/lib/jobPostingLabels'
import { PAYROLL_STATUS_LABEL, PAYROLL_STATUS_VARIANT } from '@/lib/payrollLabels'
import { formatMoney, type CurrencyCode } from '@/lib/currency'
import { getLatestPayslip } from '@/hooks/usePayroll'

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}
function formatTime(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
}
function formatRelativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })
}

const TODAY_STATUS_LABEL: Record<string, string> = {
  present: 'Present',
  late: 'Late',
  half_day: 'Half Day',
  on_leave: 'On Leave',
  rest_day: 'Rest Day',
  official_business: 'Official Business',
  work_from_home: 'Working Remotely',
  absent: 'Absent',
}

export default function EmployeeDashboard() {
  const { profile } = useAuth()
  useMyPortalRealtimeAlerts()

  const { data: myEmployee, isLoading: isLoadingEmployee } = useMyEmployeeRecord()
  const { data: today, isLoading: isLoadingToday } = useMyTodayAttendance()
  const { data: monthSummary, isLoading: isLoadingMonth } = useMyAttendanceMonthSummary()
  const { data: balances, isLoading: isLoadingBalances } = useEmployeeLeaveBalances(profile?.employee_id ?? undefined)
  const { data: payrollRecords, isLoading: isLoadingPayroll } = useMyPayrollRecords()
  const { data: notifications, isLoading: isLoadingNotifications } = useMyActivity(6)
  const { data: recentActivity, isLoading: isLoadingActivity } = useMyActivity(10)

  const latestPayroll = payrollRecords?.[0]

  const todayStatusLabel = today?.onApprovedLeave
    ? 'On Leave'
    : today?.record
      ? TODAY_STATUS_LABEL[today.record.status] ?? today.record.status
      : 'Not Timed In'

  return (
    <div className="flex flex-col gap-4">
      <WelcomeSection name={firstName(profile?.full_name)} subtitle="Here's a summary of your employment information." />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MiniStat label="Attendance This Month" value={`${monthSummary?.daysPresentThisMonth ?? 0} Days`} isLoading={isLoadingMonth} />
        <MiniStat
          label="Leave Balance"
          value={balances && balances.length > 0 ? `${Number(balances[0].remaining_credits ?? 0)} Days` : '—'}
          isLoading={isLoadingBalances}
        />
        <MiniStat
          label="Payroll Status"
          value={latestPayroll ? PAYROLL_STATUS_LABEL[latestPayroll.status] : 'None yet'}
          isLoading={isLoadingPayroll}
        />
        <MiniStat
          label="Employment Status"
          value={myEmployee ? EMPLOYMENT_STATUS_LABEL[myEmployee.employment_status] : '—'}
          isLoading={isLoadingEmployee}
        />
        <MiniStat
          label="Working Hours This Week"
          value={monthSummary ? formatHoursAsDuration(monthSummary.workingHoursThisWeek) : '—'}
          isLoading={isLoadingMonth}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashboardSectionCard title="Today's Attendance" icon={CalendarClock}>
          {isLoadingToday ? (
            <DashboardListSkeleton rows={2} />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Today's Status</p>
                  <p className="font-display text-lg font-bold text-foreground">{todayStatusLabel}</p>
                </div>
                <TimeInOutButton />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <MiniStat label="Time In" value={formatTime(today?.record?.time_in ?? null)} />
                <MiniStat label="Time Out" value={formatTime(today?.record?.time_out ?? null)} />
                <MiniStat label="Working Hours" value={today?.record ? formatHoursAsDuration(Number(today.record.working_hours)) : '—'} />
              </div>
            </div>
          )}
        </DashboardSectionCard>

        <DashboardSectionCard title="Work Information" icon={IdCard}>
          {isLoadingEmployee || !myEmployee ? (
            <DashboardListSkeleton rows={3} />
          ) : (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Employee ID</p>
                <p className="font-mono text-foreground">{myEmployee.employee_number}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Department</p>
                <p className="text-foreground">{myEmployee.departments?.name ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Position</p>
                <p className="text-foreground">{myEmployee.positions?.title ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Employment Type</p>
                <p className="text-foreground">{EMPLOYMENT_TYPE_LABEL[myEmployee.employment_type]}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Employment Status</p>
                <Badge variant={EMPLOYMENT_STATUS_VARIANT[myEmployee.employment_status]}>
                  {EMPLOYMENT_STATUS_LABEL[myEmployee.employment_status]}
                </Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Date Hired</p>
                <p className="text-foreground">{formatDate(myEmployee.hire_date)}</p>
              </div>
            </div>
          )}
        </DashboardSectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PayrollWidget />
        <LeaveWidget />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashboardSectionCard title="Notifications" icon={Bell}>
          {isLoadingNotifications ? (
            <DashboardListSkeleton />
          ) : !notifications || notifications.length === 0 ? (
            <DashboardEmptyState message="No recent notifications." />
          ) : (
            <div className="flex flex-col gap-2.5">
              {notifications.map((item) => (
                <div key={item.id} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">{formatRelativeTime(item.createdAt)}</span>
                  <p className="text-foreground">{item.message}</p>
                </div>
              ))}
            </div>
          )}
        </DashboardSectionCard>

        <DashboardSectionCard title="Recent Activity" icon={ListChecks}>
          {isLoadingActivity ? (
            <DashboardListSkeleton rows={5} />
          ) : !recentActivity || recentActivity.length === 0 ? (
            <DashboardEmptyState message="No recent activities." />
          ) : (
            <div className="flex flex-col gap-2.5">
              {recentActivity.map((item) => (
                <div key={item.id} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: false })}
                  </span>
                  <p className="text-foreground">{item.message}</p>
                </div>
              ))}
            </div>
          )}
        </DashboardSectionCard>
      </div>
    </div>
  )
}

function PayrollWidget() {
  const navigate = useNavigate()
  const { data: payrollRecords, isLoading } = useMyPayrollRecords()
  const latest = payrollRecords?.[0]
  const payslip = latest ? getLatestPayslip(latest) : null

  return (
    <DashboardSectionCard title="Payroll" icon={Wallet} onClick={() => navigate('/dashboard/my-payroll')}>
      {isLoading ? (
        <DashboardListSkeleton rows={2} />
      ) : !latest ? (
        <DashboardEmptyState message="No payroll records yet." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MiniStat
            label="Payroll Period"
            value={latest.payroll_periods ? `${formatDate(latest.payroll_periods.period_start)} – ${formatDate(latest.payroll_periods.period_end)}` : '—'}
          />
          <MiniStat label="Net Salary" value={formatMoney(Number(latest.net_salary), latest.currency as CurrencyCode)} />
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Payroll Status</p>
            <Badge variant={PAYROLL_STATUS_VARIANT[latest.status]} className="mt-1">
              {PAYROLL_STATUS_LABEL[latest.status]}
            </Badge>
          </div>
          {payslip && (
            <div className="col-span-2 sm:col-span-3">
              <p className="text-xs text-muted-foreground">Payslip Number</p>
              <p className="font-mono text-sm text-foreground">{payslip.payslip_number}</p>
            </div>
          )}
        </div>
      )}
    </DashboardSectionCard>
  )
}

function LeaveWidget() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { data: balances, isLoading } = useEmployeeLeaveBalances(profile?.employee_id ?? undefined)
  const { data: requests, isLoading: isLoadingRequests } = useMyLeaveRequests()

  const primaryTypes = ['Vacation Leave', 'Sick Leave', 'Emergency Leave']
  const primaryBalances = (balances ?? []).filter((b) => primaryTypes.includes(b.leave_types.name))
  const otherBalances = (balances ?? []).filter((b) => !primaryTypes.includes(b.leave_types.name))
  const pendingCount = (requests ?? []).filter((r) => r.status === 'pending').length

  return (
    <DashboardSectionCard title="Leave" icon={CalendarCheck} onClick={() => navigate('/dashboard/my-leave')}>
      {isLoading ? (
        <DashboardListSkeleton rows={2} />
      ) : !balances || balances.length === 0 ? (
        <DashboardEmptyState message="No leave balances configured yet." />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {primaryBalances.map((b) => (
              <MiniStat key={b.id} label={b.leave_types.name} value={`${Number(b.remaining_credits ?? 0)} Days`} />
            ))}
            <MiniStat label="Pending Leave Requests" value={pendingCount} isLoading={isLoadingRequests} />
          </div>
          {otherBalances.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {otherBalances.map((b) => (
                <Badge key={b.id} variant="outline">
                  {b.leave_types.name}: {Number(b.remaining_credits ?? 0)}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </DashboardSectionCard>
  )
}
