import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

/** A single dated item shown on the global calendar widget and the Dashboard's
 * Upcoming Schedule card. */
export interface CalendarEvent {
  date: string
  label: string
  type: 'interview' | 'deployment' | 'leave' | 'payroll'
}

interface UpcomingInterviewRow {
  scheduled_at: string
  interview_type: 'initial' | 'final'
  applications: {
    applicants: { first_name: string; last_name: string } | null
  } | null
}

function todayISODate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Every upcoming scheduled interview org-wide — the calendar is a shared
 * awareness widget, not an action surface, so it isn't scoped to "my"
 * interviews the way the ownership-gated action buttons are. */
export function useUpcomingEvents() {
  return useQuery({
    queryKey: ['upcoming-events'],
    queryFn: async () => {
      const today = todayISODate()

      const [interviewsRes, leavesRes, periodsRes] = await Promise.all([
        supabase
          .from('interviews')
          .select('scheduled_at, interview_type, applications(applicant_first_name, applicant_last_name, applicants(first_name, last_name))')
          .eq('status', 'scheduled')
          .gte('scheduled_at', new Date().toISOString())
          .order('scheduled_at', { ascending: true })
          .limit(20),
        supabase
          .from('leave_requests')
          .select('start_date, employees(first_name, last_name), leave_types(name)')
          .eq('status', 'approved')
          .gte('start_date', today)
          .order('start_date', { ascending: true })
          .limit(10),
        supabase
          .from('payroll_periods')
          .select('pay_date, period_start, period_end')
          .not('pay_date', 'is', null)
          .gte('pay_date', today)
          .neq('status', 'released')
          .order('pay_date', { ascending: true })
          .limit(5),
      ])
      if (interviewsRes.error) throw interviewsRes.error
      if (leavesRes.error) throw leavesRes.error
      if (periodsRes.error) throw periodsRes.error

      const interviewEvents: CalendarEvent[] = (interviewsRes.data as unknown as UpcomingInterviewRow[]).map((row) => ({
        date: row.scheduled_at,
        label: `${row.interview_type === 'initial' ? 'Initial' : 'Final'} Interview — ${row.applications?.applicants?.first_name ?? ''} ${row.applications?.applicants?.last_name ?? ''}`.trim(),
        type: 'interview',
      }))

      const leaveEvents: CalendarEvent[] = leavesRes.data.map((row) => ({
        date: row.start_date,
        label: `${row.leave_types?.name ?? 'Leave'} — ${row.employees?.first_name ?? ''} ${row.employees?.last_name ?? ''}`.trim(),
        type: 'leave',
      }))

      const payrollEvents: CalendarEvent[] = periodsRes.data.map((row) => ({
        date: row.pay_date as string,
        label: `Payroll Pay Date — ${row.period_start} to ${row.period_end}`,
        type: 'payroll',
      }))

      return [...interviewEvents, ...leaveEvents, ...payrollEvents].sort((a, b) => a.date.localeCompare(b.date))
    },
    staleTime: 60_000,
  })
}
