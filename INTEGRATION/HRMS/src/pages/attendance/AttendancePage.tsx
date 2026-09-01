import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { UserCheck, UserX, Clock, CalendarCheck, TrendingUp, Home, MoreHorizontal } from 'lucide-react'
import { StatCard } from '@/components/stat-card'
import { DataTable } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { CorrectAttendanceDialog } from '@/components/attendance/CorrectAttendanceDialog'
import { AttendanceDetailsSheet } from '@/components/attendance/AttendanceDetailsSheet'
import {
  useAttendanceRecords,
  useAttendanceStats,
  useAttendanceRealtimeAlerts,
  type AttendanceRecord,
} from '@/hooks/useAttendance'
import { useDepartments } from '@/hooks/useDepartments'
import { usePositions } from '@/hooks/usePositions'
import { ATTENDANCE_STATUS_LABEL, ATTENDANCE_STATUS_VARIANT } from '@/lib/attendanceLabels'
import { EMPLOYMENT_STATUS_LABEL } from '@/lib/employeeLabels'
import { formatMinutesAsDuration, formatHoursAsDuration } from '@/lib/attendanceCalculations'
import type { AttendanceStatus, EmploymentStatus } from '@/lib/enums'

const ALL = 'all'

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

type QuickRange = 'today' | 'this_week' | 'this_month' | 'custom'

function rangeForQuickFilter(range: QuickRange): { from: string; to: string } {
  const today = todayISODate()
  if (range === 'this_week') return { from: startOfWeekISODate(), to: today }
  if (range === 'this_month') return { from: startOfMonthISODate(), to: today }
  return { from: today, to: today }
}

function formatTime(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
}

function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function AttendancePage() {
  useAttendanceRealtimeAlerts()

  const [quickRange, setQuickRange] = React.useState<QuickRange>('today')
  const [customFrom, setCustomFrom] = React.useState(todayISODate())
  const [customTo, setCustomTo] = React.useState(todayISODate())
  const { from: rangeFrom, to: rangeTo } = quickRange === 'custom' ? { from: customFrom, to: customTo } : rangeForQuickFilter(quickRange)

  const { data: records, isLoading, isError } = useAttendanceRecords(rangeFrom, rangeTo)
  const { data: stats, isLoading: statsLoading } = useAttendanceStats()
  const { data: departments } = useDepartments()
  const { data: positions } = usePositions()

  const [departmentFilter, setDepartmentFilter] = React.useState(ALL)
  const [positionFilter, setPositionFilter] = React.useState(ALL)
  const [statusFilter, setStatusFilter] = React.useState(ALL)
  const [employmentStatusFilter, setEmploymentStatusFilter] = React.useState(ALL)

  const [correctingRecord, setCorrectingRecord] = React.useState<AttendanceRecord | null>(null)
  const [viewingRecordId, setViewingRecordId] = React.useState<string | null>(null)

  const filteredPositions = React.useMemo(
    () => (departmentFilter === ALL ? positions : positions?.filter((p) => p.department_id === departmentFilter)),
    [positions, departmentFilter]
  )

  const rows = React.useMemo(() => {
    if (!records) return []
    return records.filter((r) => {
      if (departmentFilter !== ALL && r.employees.department_id !== departmentFilter) return false
      if (positionFilter !== ALL && r.employees.position_id !== positionFilter) return false
      if (statusFilter !== ALL && r.status !== statusFilter) return false
      if (employmentStatusFilter !== ALL && r.employees.employment_status !== employmentStatusFilter) return false
      return true
    })
  }, [records, departmentFilter, positionFilter, statusFilter, employmentStatusFilter])

  const columns: ColumnDef<AttendanceRecord>[] = [
    {
      id: '_searchText',
      accessorFn: (row) => [row.employees.employee_number, row.employees.first_name, row.employees.last_name, row.employees.email].filter(Boolean).join(' ').toLowerCase(),
      header: () => null,
      cell: () => null,
    },
    {
      id: 'employee_id',
      header: 'Employee ID',
      accessorFn: (row) => row.employees.employee_number,
      cell: ({ row }) => <span className="font-mono text-sm text-foreground">{row.original.employees.employee_number}</span>,
    },
    {
      id: 'name',
      header: 'Employee Name',
      accessorFn: (row) => `${row.employees.first_name} ${row.employees.last_name}`,
      cell: ({ row }) => (
        <span className="font-medium text-foreground">
          {row.original.employees.first_name} {row.original.employees.last_name}
        </span>
      ),
    },
    {
      id: 'department',
      header: 'Department',
      accessorFn: (row) => row.employees.departments?.name ?? '',
      cell: ({ row }) => (row.original.employees.departments?.name ? <Badge variant="secondary">{row.original.employees.departments.name}</Badge> : '—'),
    },
    {
      id: 'position',
      header: 'Position',
      accessorFn: (row) => row.employees.positions?.title ?? '',
    },
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
      header: 'Attendance Status',
      cell: ({ row }) => <Badge variant={ATTENDANCE_STATUS_VARIANT[row.original.status]}>{ATTENDANCE_STATUS_LABEL[row.original.status]}</Badge>,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setViewingRecordId(row.original.id)}>View</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCorrectingRecord(row.original)}>Correct Attendance</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">Attendance Management</h2>
          <p className="text-sm text-muted-foreground">
            Track, calculate, and review attendance for every employee. Employees record their own time in and out —
            use Correct Attendance on a row to fix an entry.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Present Today" value={stats?.presentCount ?? 0} icon={UserCheck} isLoading={statsLoading} index={0} />
        <StatCard label="Absent Today" value={stats?.absentCount ?? 0} icon={UserX} isLoading={statsLoading} index={1} />
        <StatCard label="Late Today" value={stats?.lateCount ?? 0} icon={Clock} isLoading={statsLoading} index={2} />
        <StatCard label="On Leave" value={stats?.onLeaveCount ?? 0} icon={CalendarCheck} isLoading={statsLoading} index={3} />
        <StatCard label="Working Overtime" value={stats?.overtimeCount ?? 0} icon={TrendingUp} isLoading={statsLoading} index={4} />
        <StatCard label="Working Remotely" value={stats?.remoteCount ?? 0} icon={Home} isLoading={statsLoading} index={5} />
      </div>

      {isError ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="font-medium text-foreground">Couldn't load attendance records</p>
          <p className="text-sm text-muted-foreground">Please refresh the page or try again shortly.</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          density="compact"
          searchPlaceholder="Search by name, employee ID, or email..."
          searchColumn="_searchText"
          emptyTitle="No attendance records for this range"
          emptyDescription="Record an employee's Time In or Time Out to get started."
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
              <Select value={departmentFilter} onValueChange={(v) => { setDepartmentFilter(v); setPositionFilter(ALL) }}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All departments</SelectItem>
                  {departments?.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={positionFilter} onValueChange={setPositionFilter}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Position" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All positions</SelectItem>
                  {filteredPositions?.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  {(Object.entries(ATTENDANCE_STATUS_LABEL) as [AttendanceStatus, string][]).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={employmentStatusFilter} onValueChange={setEmploymentStatusFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Employment Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All employment statuses</SelectItem>
                  {(Object.entries(EMPLOYMENT_STATUS_LABEL) as [EmploymentStatus, string][]).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        />
      )}

      <CorrectAttendanceDialog open={!!correctingRecord} onOpenChange={(open) => !open && setCorrectingRecord(null)} record={correctingRecord} />
      <AttendanceDetailsSheet recordId={viewingRecordId} open={!!viewingRecordId} onOpenChange={(open) => !open && setViewingRecordId(null)} />
    </div>
  )
}
