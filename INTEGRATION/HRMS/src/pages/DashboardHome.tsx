import { useAuth } from '@/contexts/AuthContext'
import { firstName } from '@/lib/displayName'
import { WelcomeSection } from '@/components/dashboard/WelcomeSection'
import { QuickActions } from '@/components/dashboard/QuickActions'
import { OrganizationOverviewSection, RecruitmentOverviewSection, EmployeeOverviewSection } from '@/components/dashboard/OverviewSections'
import { TodaysInterviewsSection } from '@/components/dashboard/TodaysInterviewsSection'
import {
  AttendanceSummarySection,
  LeaveRequestsSection,
  DeploymentStatusSection,
  PayrollSummarySection,
} from '@/components/dashboard/OperationsSections'
import { NotificationsSection, RecentActivitySection, UpcomingScheduleSection } from '@/components/dashboard/ActivitySections'
import { DashboardCharts } from '@/components/dashboard/DashboardCharts'
import { HrAccountsSection, SystemStatusSection, RecentAuditLogsSection } from '@/components/dashboard/AdminWidgets'
import { useDashboardRealtimeAlerts } from '@/hooks/useDashboard'
import EmployeeDashboard from '@/pages/employee-portal/EmployeeDashboard'

export default function DashboardHome() {
  const { profile } = useAuth()
  useDashboardRealtimeAlerts()

  if (profile?.role === 'employee') {
    return <EmployeeDashboard />
  }

  const isAdmin = profile?.role === 'admin'

  return (
    <div className="flex flex-col gap-4">
      <WelcomeSection name={firstName(profile?.full_name)} subtitle="Here's the current state of your organization." />

      <QuickActions isAdmin={isAdmin} />

      <OrganizationOverviewSection />
      <RecruitmentOverviewSection />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TodaysInterviewsSection interviewerId={isAdmin ? undefined : profile?.id} />
        <AttendanceSummarySection />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LeaveRequestsSection />
        <PayrollSummarySection />
      </div>

      <DeploymentStatusSection />
      <EmployeeOverviewSection />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <NotificationsSection />
        <UpcomingScheduleSection />
      </div>

      <RecentActivitySection />

      <div>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Analytics</h3>
        <DashboardCharts />
      </div>

      {isAdmin && (
        <div className="flex flex-col gap-4">
          <h3 className="mt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Administration</h3>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <HrAccountsSection />
            <SystemStatusSection />
          </div>
          <RecentAuditLogsSection />
        </div>
      )}
    </div>
  )
}
