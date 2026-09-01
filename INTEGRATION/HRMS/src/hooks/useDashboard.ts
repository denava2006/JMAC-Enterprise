import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { CurrencyCode } from '@/lib/currency'
import type { PayrollStatus } from '@/lib/enums'

function todayISODate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function count(query: PromiseLike<{ count: number | null }>): Promise<number> {
  return Promise.resolve(query).then((r) => r.count ?? 0)
}

// ---- 3. Organization Overview ----

export function useOrganizationOverview() {
  return useQuery({
    queryKey: ['dashboard-organization-overview'],
    queryFn: async () => {
      const [total, active, departments, positions] = await Promise.all([
        count(supabase.from('employees').select('*', { count: 'exact', head: true })),
        count(supabase.from('employees').select('*', { count: 'exact', head: true }).eq('employment_status', 'active')),
        count(supabase.from('departments').select('*', { count: 'exact', head: true })),
        count(supabase.from('positions').select('*', { count: 'exact', head: true })),
      ])
      return { total, active, departments, positions }
    },
  })
}

// ---- 4. Recruitment Overview ----

export function useRecruitmentOverview() {
  return useQuery({
    queryKey: ['dashboard-recruitment-overview'],
    queryFn: async () => {
      const [newApplications, qualified, interviewsScheduled, pendingDeployment] = await Promise.all([
        count(supabase.from('applications').select('*', { count: 'exact', head: true }).eq('status', 'submitted')),
        count(supabase.from('applications').select('*', { count: 'exact', head: true }).eq('status', 'qualified')),
        count(supabase.from('interviews').select('*', { count: 'exact', head: true }).eq('status', 'scheduled')),
        count(supabase.from('applications').select('*', { count: 'exact', head: true }).eq('status', 'hired')),
      ])
      return { newApplications, qualified, interviewsScheduled, pendingDeployment }
    },
  })
}

// ---- 5. Today's Interviews ----

export interface TodaysInterview {
  id: string
  applicantName: string
  position: string
  interviewType: 'initial' | 'final'
  scheduledAt: string
  interviewerName: string | null
}

/** interviewerId scopes results to "my" interviews (HR Staff) — omitted, Admin
 * sees every interview scheduled today org-wide. */
export function useTodaysInterviews(interviewerId?: string) {
  return useQuery({
    queryKey: ['dashboard-todays-interviews', interviewerId ?? 'all'],
    queryFn: async () => {
      const today = todayISODate()
      const start = new Date(`${today}T00:00:00`).toISOString()
      const end = new Date(`${today}T23:59:59.999`).toISOString()

      let query = supabase
        .from('interviews')
        .select(
          'id, scheduled_at, interview_type, interviewer:profiles!interviews_interviewer_id_fkey(full_name), applications(applicant_first_name, applicant_last_name, applicants(first_name,last_name), job_postings(positions(title)))'
        )
        .eq('status', 'scheduled')
        .gte('scheduled_at', start)
        .lte('scheduled_at', end)
        .order('scheduled_at', { ascending: true })
      if (interviewerId) query = query.eq('interviewer_id', interviewerId)

      const { data, error } = await query
      if (error) throw error

      return (data ?? []).map(
        (row): TodaysInterview => ({
          id: row.id,
          applicantName: `${row.applications?.applicants?.first_name ?? ''} ${row.applications?.applicants?.last_name ?? ''}`.trim() || '—',
          position: row.applications?.job_postings?.positions?.title ?? '—',
          interviewType: row.interview_type,
          scheduledAt: row.scheduled_at,
          interviewerName: row.interviewer?.full_name ?? null,
        })
      )
    },
  })
}

// ---- 7. Leave Requests (pending, by type) ----

export function usePendingLeaveBreakdown() {
  return useQuery({
    queryKey: ['dashboard-pending-leave-breakdown'],
    queryFn: async () => {
      const { data, error } = await supabase.from('leave_requests').select('leave_types(name)').eq('status', 'pending')
      if (error) throw error

      const counts = new Map<string, number>()
      for (const row of data) {
        const name = row.leave_types?.name ?? 'Other'
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      return {
        total: data.length,
        breakdown: [...counts.entries()].map(([name, requestCount]) => ({ name, count: requestCount })).sort((a, b) => b.count - a.count),
      }
    },
  })
}

// ---- 10. Payroll Summary ----

export interface DashboardPayrollSummary {
  periodStart: string
  periodEnd: string
  frequency: string
  status: PayrollStatus
  employeesIncluded: number
  estimatedPayroll: number
  currency: CurrencyCode
}

export function useDashboardPayrollSummary() {
  return useQuery({
    queryKey: ['dashboard-payroll-summary'],
    queryFn: async (): Promise<DashboardPayrollSummary | null> => {
      const { data: period, error: periodError } = await supabase
        .from('payroll_periods')
        .select('*')
        .order('period_start', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (periodError) throw periodError
      if (!period) return null

      const { data: records, error: recordsError } = await supabase
        .from('payroll_records')
        .select('net_salary, currency')
        .eq('payroll_period_id', period.id)
      if (recordsError) throw recordsError

      return {
        periodStart: period.period_start,
        periodEnd: period.period_end,
        frequency: period.frequency,
        status: period.status,
        employeesIncluded: records.length,
        estimatedPayroll: records.reduce((sum, r) => sum + Number(r.net_salary), 0),
        currency: (records[0]?.currency ?? 'PHP') as CurrencyCode,
      }
    },
  })
}

// ---- Admin-only: HR Accounts ----

export function useHrAccountsOverview() {
  return useQuery({
    queryKey: ['dashboard-hr-accounts-overview'],
    queryFn: async () => {
      // Same role set HR Accounts itself lists — employee logins are counted
      // separately and must not inflate this.
      const { data, error } = await supabase
        .from('profiles')
        .select('status')
        .in('role', ['admin', 'hr_manager', 'hr_staff'])
      if (error) throw error
      return {
        total: data.length,
        active: data.filter((p) => p.status === 'active').length,
        disabled: data.filter((p) => p.status === 'inactive').length,
      }
    },
  })
}

// ---- Admin-only: Recent Audit Logs ----

export function useRecentAuditLogs(limit = 8) {
  return useQuery({
    queryKey: ['dashboard-recent-audit-logs', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('id, action, table_name, created_at, actor:profiles(full_name)')
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) throw error
      return data
    },
  })
}

// ---- 11 & 12. Notifications / Recent Activity (one shared feed) ----

export interface ActivityItem {
  id: string
  message: string
  actorName: string | null
  createdAt: string
}

/** Only the recruitment-side events worth surfacing on the dashboard feed —
 * audit_logs already reads as human-friendly action phrases and needs no
 * translation, but application_history's event keys do. */
const APPLICATION_EVENT_LABEL: Record<string, string> = {
  submitted: 'New application submitted',
  reviewed: 'Application moved to review',
  qualified: 'Applicant qualified',
  rejected: 'Applicant rejected',
  initial_interview_scheduled: 'Initial interview scheduled',
  initial_interview_passed: 'Initial interview passed',
  initial_interview_rejected: 'Applicant rejected after initial interview',
  final_interview_scheduled: 'Final interview scheduled',
  final_interview_rejected: 'Applicant rejected after final interview',
  hired: 'Applicant hired',
  offer_accepted: 'Job offer accepted',
  offer_declined: 'Job offer declined',
  contract_signed: 'Employment contract signed',
  deployment_completed: 'Employee deployed',
  pending_employee_record_created: 'Pending employee record created',
}

export function useRecentActivity(limit = 10) {
  return useQuery({
    queryKey: ['dashboard-recent-activity', limit],
    queryFn: async (): Promise<ActivityItem[]> => {
      const [auditRes, historyRes] = await Promise.all([
        supabase
          .from('audit_logs')
          .select('id, action, created_at, actor:profiles(full_name)')
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase
          .from('application_history')
          .select('id, event, created_at, actor:profiles(full_name)')
          .order('created_at', { ascending: false })
          .limit(limit),
      ])
      if (auditRes.error) throw auditRes.error
      if (historyRes.error) throw historyRes.error

      const fromAudit: ActivityItem[] = auditRes.data.map((r) => ({
        id: `audit-${r.id}`,
        message: r.action,
        actorName: r.actor?.full_name ?? null,
        createdAt: r.created_at,
      }))
      const fromHistory: ActivityItem[] = historyRes.data
        .filter((r) => APPLICATION_EVENT_LABEL[r.event])
        .map((r) => ({
          id: `hist-${r.id}`,
          message: APPLICATION_EVENT_LABEL[r.event],
          actorName: r.actor?.full_name ?? null,
          createdAt: r.created_at,
        }))

      return [...fromAudit, ...fromHistory].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
    },
  })
}

// ---- 14. Dashboard Charts ----

export interface DashboardChartDatum {
  name: string
  value: number
  color?: string
}

export function useRecruitmentStatusChart() {
  return useQuery({
    queryKey: ['dashboard-chart-recruitment-status'],
    queryFn: async (): Promise<DashboardChartDatum[]> => {
      const [newCount, qualifiedCount, interviewCount, hiredCount, rejectedCount] = await Promise.all([
        count(supabase.from('applications').select('*', { count: 'exact', head: true }).eq('status', 'submitted')),
        count(supabase.from('applications').select('*', { count: 'exact', head: true }).eq('status', 'qualified')),
        count(supabase.from('applications').select('*', { count: 'exact', head: true }).eq('status', 'interview_scheduled')),
        count(supabase.from('applications').select('*', { count: 'exact', head: true }).in('status', ['hired', 'offered', 'deployed'])),
        count(supabase.from('applications').select('*', { count: 'exact', head: true }).eq('status', 'rejected')),
      ])
      return [
        { name: 'New', value: newCount },
        { name: 'Qualified', value: qualifiedCount },
        { name: 'Interview', value: interviewCount },
        { name: 'Hired', value: hiredCount },
        { name: 'Rejected', value: rejectedCount },
      ]
    },
  })
}

/** Attendance rate per day (present+late / total active employees) for the
 * trailing 7 days — a deliberate simplification (doesn't account for each
 * employee's individual work schedule), consistent with other dashboard-level
 * summaries elsewhere in the app. */
export function useAttendanceTrendChart() {
  return useQuery({
    queryKey: ['dashboard-chart-attendance-trend'],
    queryFn: async (): Promise<DashboardChartDatum[]> => {
      const totalActive = await count(
        supabase.from('employees').select('*', { count: 'exact', head: true }).eq('employment_status', 'active')
      )
      const days: string[] = []
      for (let i = 6; i >= 0; i--) {
        const d = new Date()
        d.setDate(d.getDate() - i)
        days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
      }

      const { data, error } = await supabase
        .from('attendance_records')
        .select('attendance_date, status')
        .gte('attendance_date', days[0])
        .lte('attendance_date', days[days.length - 1])
      if (error) throw error

      return days.map((day) => {
        const present = data.filter((r) => r.attendance_date === day && (r.status === 'present' || r.status === 'late')).length
        const rate = totalActive > 0 ? Math.round((present / totalActive) * 100) : 0
        return { name: new Date(`${day}T00:00:00`).toLocaleDateString('en-PH', { weekday: 'short' }), value: rate }
      })
    },
  })
}

/** New hires by month for the trailing 6 months. */
export function useHiringTrendChart() {
  return useQuery({
    queryKey: ['dashboard-chart-hiring-trend'],
    queryFn: async (): Promise<DashboardChartDatum[]> => {
      const sixMonthsAgo = new Date()
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5)
      sixMonthsAgo.setDate(1)
      const startISO = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, '0')}-01`

      const { data, error } = await supabase.from('employees').select('hire_date').gte('hire_date', startISO)
      if (error) throw error

      const buckets = new Map<string, number>()
      for (let i = 5; i >= 0; i--) {
        const d = new Date()
        d.setMonth(d.getMonth() - i)
        buckets.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, 0)
      }
      for (const row of data) {
        const key = row.hire_date.slice(0, 7)
        if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1)
      }
      return [...buckets.entries()].map(([key, value]) => {
        const [year, month] = key.split('-').map(Number)
        return { name: new Date(year, month - 1, 1).toLocaleDateString('en-PH', { month: 'short' }), value }
      })
    },
  })
}

export function useLeaveDistributionChart() {
  return useQuery({
    queryKey: ['dashboard-chart-leave-distribution'],
    queryFn: async (): Promise<DashboardChartDatum[]> => {
      const { data, error } = await supabase.from('leave_requests').select('leave_types(name)')
      if (error) throw error

      const counts = new Map<string, number>()
      for (const row of data) {
        const name = row.leave_types?.name ?? 'Other'
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      return [...counts.entries()].map(([name, value]) => ({ name, value }))
    },
  })
}

// ---- Real-time invalidation ----

const DASHBOARD_QUERY_KEYS = [
  ['dashboard-organization-overview'],
  ['dashboard-recruitment-overview'],
  ['dashboard-todays-interviews'],
  ['dashboard-pending-leave-breakdown'],
  ['dashboard-payroll-summary'],
  ['dashboard-hr-accounts-overview'],
  ['dashboard-recent-audit-logs'],
  ['dashboard-recent-activity'],
  ['dashboard-chart-recruitment-status'],
  ['dashboard-chart-attendance-trend'],
  ['dashboard-chart-hiring-trend'],
  ['dashboard-chart-leave-distribution'],
  ['employee-stats'],
  ['pending-employees'],
  ['attendance-stats'],
  ['upcoming-events'],
]

const REALTIME_TABLES = [
  'applications',
  'application_history',
  'interviews',
  'attendance_records',
  'leave_requests',
  'payroll_records',
  'payroll_periods',
  'employees',
  'deployment_records',
  'audit_logs',
  'profiles',
] as const

export function useDashboardRealtimeAlerts() {
  const queryClient = useQueryClient()
  React.useEffect(() => {
    const refresh = () => {
      for (const key of DASHBOARD_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: key })
    }
    let channel = supabase.channel('dashboard-alerts')
    for (const table of REALTIME_TABLES) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, refresh)
    }
    channel.subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])
}
