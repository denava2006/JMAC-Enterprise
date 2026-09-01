import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { CalendarClock, Clock, AlarmClock, TrendingUp, CalendarCheck } from 'lucide-react'
import { StatCard } from '@/components/stat-card'
import { DataTable } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { AttendanceDetailsSheet } from '@/components/attendance/AttendanceDetailsSheet'
import { TimeInOutButton } from '@/components/employee-portal/TimeInOutButton'
import { useAttendanceRecords } from '@/hooks/useAttendance'
import { useMyAttendanceMonthSummary, useMyTodayAttendance, useMyPortalRealtimeAlerts } from '@/hooks/useEmployeePortal'
import { ATTENDANCE_STATUS_LABEL, ATTENDANCE_STATUS_VARIANT } from '@/lib/attendanceLabels'
import { formatMinutesAsDuration, formatHoursAsDuration } from '@/lib/attendanceCalculations'
import type { Tables } from '@/lib/database.types'

function todayISODate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function startOfWeekISODate(): string {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function startOfMonthISODate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}
function formatTime(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
}

type QuickRange = 'today' | 'this_week' | 'this_month' | 'custom'

function rangeForQuickFilter(range: QuickRange): { from: string; to: string } {
  const today = todayISODate()
  if (range === 'this_week') return { from: startOfWeekISODate(), to: today }
  if (range === 'this_month') return { from: startOfMonthISODate(), to: today }
  return { from: today, to: today }
}

export default function MyAttendancePage() {
  useMyPortalRealtimeAlerts()

  const [quickRange, setQuickRange] = React.useState<QuickRange>('this_month')
  const [customFrom, setCustomFrom] = React.useState(startOfMonthISODate())
  const [customTo, setCustomTo] = React.useState(todayISODate())
  const [searchDate, setSearchDate] = React.useState('')
  const [viewingRecordId, setViewingRecordId] = React.useState<string | null>(null)

  const { from: rangeFrom, to: rangeTo } = quickRange === 'custom' ? { from: customFrom, to: customTo } : rangeForQuickFilter(quickRange)

  const { data: records, isLoading, isError } = useAttendanceRecords(rangeFrom, rangeTo)
  const { data: today, isLoading: isLoadingToday } = useMyTodayAttendance()
  const { data: monthSummary, isLoading: isLoadingMonth } = useMyAttendanceMonthSummary()

  const rows = React.useMemo(() => {
    if (!records) return []
    if (!searchDate) return records
    return records.filter((r) => r.attendance_date === searchDate)
  }, [records, searchDate])

  const columns: ColumnDef<Tables<'attendance_records'>>[] = [
    {
      id: 'date',
      header: 'Date',
      accessorFn: (row) => row.attendance_date,
      cell: ({ row }) => formatDate(row.original.attendance_date),
    },
    {
      id: 'time_in',
      header: 'Time In',
      accessorFn: (row) => row.time_in ?? '',
      cell: ({ row }) => formatTime(row.original.time_in),
    },
    {
      id: 'time_out',
      header: 'Time Out',
      accessorFn: (row) => row.time_out ?? '',
      cell: ({ row }) => formatTime(row.original.time_out),
    },
    {
      id: 'working_hours',
      header: 'Working Hours',
      accessorFn: (row) => row.working_hours,
      cell: ({ row }) => formatHoursAsDuration(Number(row.original.working_hours)),
    },
    {
      id: 'late_minutes',
      header: 'Late',
      accessorFn: (row) => row.late_minutes,
      cell: ({ row }) => formatMinutesAsDuration(row.original.late_minutes),
    },
    {
      id: 'undertime_minutes',
      header: 'Undertime',
      accessorFn: (row) => row.undertime_minutes,
      cell: ({ row }) => formatMinutesAsDuration(row.original.undertime_minutes),
    },
    {
      id: 'overtime_minutes',
      header: 'Overtime',
      accessorFn: (row) => row.overtime_minutes,
      cell: ({ row }) => formatMinutesAsDuration(row.original.overtime_minutes),
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => <Badge variant={ATTENDANCE_STATUS_VARIANT[row.original.status]}>{ATTENDANCE_STATUS_LABEL[row.original.status]}</Badge>,
    },
  ]

  const todayStatusLabel = today?.onApprovedLeave
    ? 'On Leave'
    : today?.record
      ? ATTENDANCE_STATUS_LABEL[today.record.status]
      : 'Not Timed In'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">My Attendance</h2>
          <p className="text-sm text-muted-foreground">Record your daily time in/out and review your attendance history.</p>
        </div>
        <TimeInOutButton />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Today's Status" value={todayStatusLabel} icon={CalendarCheck} isLoading={isLoadingToday} />
        <StatCard
          label="Today's Working Hours"
          value={today?.record ? formatHoursAsDuration(Number(today.record.working_hours)) : '—'}
          icon={Clock}
          isLoading={isLoadingToday}
        />
        <StatCard label="Late This Month" value={monthSummary?.lateThisMonth ?? 0} icon={AlarmClock} isLoading={isLoadingMonth} />
        <StatCard label="Overtime This Month" value={monthSummary?.overtimeThisMonth ?? 0} icon={TrendingUp} isLoading={isLoadingMonth} />
        <StatCard label="Attendance This Month" value={`${monthSummary?.daysPresentThisMonth ?? 0} Days`} icon={CalendarClock} isLoading={isLoadingMonth} />
      </div>

      {isError ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="font-medium text-foreground">Couldn't load your attendance records</p>
          <p className="text-sm text-muted-foreground">Please refresh the page or try again shortly.</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          density="compact"
          searchPlaceholder="Search..."
          emptyTitle="No attendance records for this range"
          emptyDescription="Use Time In above to record your first attendance entry."
          onRowClick={(row) => setViewingRecordId(row.id)}
          toolbarAction={
            <div className="flex flex-wrap items-center gap-2">
              <Select value={quickRange} onValueChange={(v) => setQuickRange(v as QuickRange)}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="this_week">This Week</SelectItem>
                  <SelectItem value="this_month">This Month</SelectItem>
                  <SelectItem value="custom">Custom Range</SelectItem>
                </SelectContent>
              </Select>
              {quickRange === 'custom' && (
                <div className="flex items-center gap-1.5">
                  <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="w-36" />
                  <span className="text-sm text-muted-foreground">to</span>
                  <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="w-36" />
                </div>
              )}
              <Input type="date" value={searchDate} onChange={(e) => setSearchDate(e.target.value)} className="w-40" placeholder="Search by date" />
            </div>
          }
        />
      )}

      <AttendanceDetailsSheet recordId={viewingRecordId} open={!!viewingRecordId} onOpenChange={(open) => !open && setViewingRecordId(null)} />
    </div>
  )
}
