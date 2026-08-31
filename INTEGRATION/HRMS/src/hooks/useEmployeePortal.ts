import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import type { Tables } from '@/lib/database.types'
import { invalidateEmployeePortal } from '@/lib/employeePortalQueries'

function todayISODate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function startOfMonthISODate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
function startOfWeekISODate(): string {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---- My employee record (identity, header, work info) ----

const MY_EMPLOYEE_SELECT = `
  *,
  departments (id, name),
  positions (id, title),
  work_schedules (id, name, working_days, start_time, end_time, break_minutes)
`

export type MyEmployeeRecord = Tables<'employees'> & {
  departments: { id: string; name: string } | null
  positions: { id: string; title: string } | null
  work_schedules: Tables<'work_schedules'> | null
}

export function useMyEmployeeRecord() {
  const { profile } = useAuth()
  return useQuery({
    queryKey: ['my-employee-record', profile?.employee_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select(MY_EMPLOYEE_SELECT)
        .eq('id', profile?.employee_id as string)
        .single()
      if (error) throw error
      return data as unknown as MyEmployeeRecord
    },
    enabled: !!profile?.employee_id,
  })
}

// ---- Today's attendance (composite: record + approved leave) ----

export interface MyTodayAttendance {
  record: Tables<'attendance_records'> | null
  onApprovedLeave: boolean
  leaveTypeName: string | null
}

export function useMyTodayAttendance() {
  const { profile } = useAuth()
  const employeeId = profile?.employee_id
  return useQuery({
    queryKey: ['my-today-attendance', employeeId],
    queryFn: async (): Promise<MyTodayAttendance> => {
      const today = todayISODate()
      const [recordRes, leaveRes] = await Promise.all([
        supabase.from('attendance_records').select('*').eq('employee_id', employeeId as string).eq('attendance_date', today).maybeSingle(),
        supabase
          .from('leave_requests')
          .select('leave_types(name)')
          .eq('employee_id', employeeId as string)
          .eq('status', 'approved')
          .lte('start_date', today)
          .gte('end_date', today)
          .maybeSingle(),
      ])
      if (recordRes.error) throw recordRes.error
      if (leaveRes.error) throw leaveRes.error

      return {
        record: recordRes.data,
        onApprovedLeave: !!leaveRes.data,
        leaveTypeName: leaveRes.data?.leave_types?.name ?? null,
      }
    },
    enabled: !!employeeId,
  })
}

// ---- Month-to-date attendance summary (dashboard + attendance-page stat cards) ----

export interface MyAttendanceMonthSummary {
  daysPresentThisMonth: number
  lateThisMonth: number
  overtimeThisMonth: number
  workingHoursThisWeek: number
  todayWorkingHours: number
}

export function useMyAttendanceMonthSummary() {
  const { profile } = useAuth()
  const employeeId = profile?.employee_id
  return useQuery({
    queryKey: ['my-attendance-month-summary', employeeId],
    queryFn: async (): Promise<MyAttendanceMonthSummary> => {
      const monthStart = startOfMonthISODate()
      const weekStart = startOfWeekISODate()
      const today = todayISODate()

      const { data, error } = await supabase
        .from('attendance_records')
        .select('attendance_date, status, late_minutes, overtime_minutes, working_hours')
        .eq('employee_id', employeeId as string)
        .gte('attendance_date', monthStart)
        .lte('attendance_date', today)
      if (error) throw error

      const daysPresentThisMonth = data.filter((r) => r.status === 'present' || r.status === 'late' || r.status === 'work_from_home').length
      const lateThisMonth = data.filter((r) => r.late_minutes > 0).length
      const overtimeThisMonth = data.filter((r) => r.overtime_minutes > 0).length
      const workingHoursThisWeek = data.filter((r) => r.attendance_date >= weekStart).reduce((sum, r) => sum + Number(r.working_hours ?? 0), 0)
      const todayWorkingHours = Number(data.find((r) => r.attendance_date === today)?.working_hours ?? 0)

      return { daysPresentThisMonth, lateThisMonth, overtimeThisMonth, workingHoursThisWeek, todayWorkingHours }
    },
    enabled: !!employeeId,
  })
}

// ---- My payroll ----

const MY_PAYROLL_SELECT = `
  *,
  payroll_periods (period_start, period_end, pay_date, frequency),
  payslips (*)
`

export type MyPayrollRecord = Tables<'payroll_records'> & {
  payroll_periods: Pick<Tables<'payroll_periods'>, 'period_start' | 'period_end' | 'pay_date' | 'frequency'> | null
  payslips: Tables<'payslips'>[]
}

export function useMyPayrollRecords() {
  const { profile } = useAuth()
  const employeeId = profile?.employee_id
  return useQuery({
    queryKey: ['my-payroll-records', employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payroll_records')
        .select(MY_PAYROLL_SELECT)
        .eq('employee_id', employeeId as string)
        // Payroll is the employee's business only once it's released — a draft
        // is still being checked and its figures can still change. RLS enforces
        // this too; the filter keeps the intent visible here.
        .eq('status', 'released')
        .order('created_at', { ascending: false })
      if (error) throw error
      return data as unknown as MyPayrollRecord[]
    },
    enabled: !!employeeId,
  })
}

// ---- My leave requests (history + pending count) ----

const MY_LEAVE_SELECT = `
  *,
  leave_types (id, name, is_paid)
`

export type MyLeaveRequest = Tables<'leave_requests'> & { leave_types: Pick<Tables<'leave_types'>, 'id' | 'name' | 'is_paid'> }

export function useMyLeaveRequests() {
  const { profile } = useAuth()
  const employeeId = profile?.employee_id
  return useQuery({
    queryKey: ['my-leave-requests', employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leave_requests')
        .select(MY_LEAVE_SELECT)
        .eq('employee_id', employeeId as string)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data as unknown as MyLeaveRequest[]
    },
    enabled: !!employeeId,
  })
}

// ---- My activity feed (Notifications + Recent Activity share this) ----

export interface MyActivityItem {
  id: string
  message: string
  createdAt: string
}

const LEAVE_EMPLOYEE_HISTORY_LABEL: Record<string, string> = {
  account_activated: 'Welcome to JMAC Enterprise.',
  status_updated: 'Employment status updated.',
}

export function useMyActivity(limit = 10) {
  const { profile } = useAuth()
  const employeeId = profile?.employee_id
  return useQuery({
    queryKey: ['my-activity', employeeId, limit],
    queryFn: async (): Promise<MyActivityItem[]> => {
      const [attendanceRes, leaveRes, payrollRes, historyRes] = await Promise.all([
        supabase
          .from('attendance_records')
          .select('id, attendance_date, time_in, time_out, created_at, updated_at')
          .eq('employee_id', employeeId as string)
          .order('attendance_date', { ascending: false })
          .limit(limit),
        supabase
          .from('leave_requests')
          .select('id, status, created_at, reviewed_at, leave_types(name)')
          .eq('employee_id', employeeId as string)
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase
          .from('payroll_records')
          .select('id, status, released_at, payroll_periods(period_start, period_end)')
          .eq('employee_id', employeeId as string)
          .eq('status', 'released')
          .order('released_at', { ascending: false })
          .limit(limit),
        supabase
          .from('employee_history')
          .select('id, event, created_at')
          .eq('employee_id', employeeId as string)
          .order('created_at', { ascending: false })
          .limit(limit),
      ])
      if (attendanceRes.error) throw attendanceRes.error
      if (leaveRes.error) throw leaveRes.error
      if (payrollRes.error) throw payrollRes.error
      if (historyRes.error) throw historyRes.error

      const items: MyActivityItem[] = []

      for (const r of attendanceRes.data) {
        items.push({ id: `att-in-${r.id}`, message: 'Attendance recorded (Time In).', createdAt: r.created_at })
        if (r.time_out) {
          items.push({ id: `att-out-${r.id}`, message: 'Attendance updated (Time Out).', createdAt: r.updated_at })
        }
      }
      for (const r of leaveRes.data) {
        items.push({ id: `leave-sub-${r.id}`, message: `Leave request submitted (${r.leave_types?.name ?? 'Leave'}).`, createdAt: r.created_at })
        if (r.status === 'approved' && r.reviewed_at) {
          items.push({ id: `leave-appr-${r.id}`, message: 'Leave request approved.', createdAt: r.reviewed_at })
        } else if (r.status === 'rejected' && r.reviewed_at) {
          items.push({ id: `leave-rej-${r.id}`, message: 'Leave request rejected.', createdAt: r.reviewed_at })
        }
      }
      for (const r of payrollRes.data) {
        items.push({ id: `payroll-${r.id}`, message: 'Payroll released.', createdAt: r.released_at ?? new Date().toISOString() })
      }
      for (const r of historyRes.data) {
        if (LEAVE_EMPLOYEE_HISTORY_LABEL[r.event]) {
          items.push({ id: `hist-${r.id}`, message: LEAVE_EMPLOYEE_HISTORY_LABEL[r.event], createdAt: r.created_at })
        }
      }

      return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
    },
    enabled: !!employeeId,
  })
}

// ---- Realtime ----

export function useMyPortalRealtimeAlerts() {
  const { profile } = useAuth()
  const employeeId = profile?.employee_id
  const queryClient = useQueryClient()
  React.useEffect(() => {
    if (!employeeId) return
    const refresh = () => {
      // Every portal query — the previous list omitted my-leave-requests, so a
      // leave submission never appeared until the page was refreshed by hand.
      invalidateEmployeePortal(queryClient)
      // Plus the HR-side views this employee's action feeds.
      queryClient.invalidateQueries({ queryKey: ['attendance-records'] })
      queryClient.invalidateQueries({ queryKey: ['leave-requests'] })
      queryClient.invalidateQueries({ queryKey: ['employee-leave-balances'] })
    }
    const channel = supabase
      .channel(`my-portal-alerts-${employeeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_records', filter: `employee_id=eq.${employeeId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_requests', filter: `employee_id=eq.${employeeId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payroll_records', filter: `employee_id=eq.${employeeId}` }, refresh)
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [employeeId, queryClient])
}
