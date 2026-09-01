import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import type { ColumnDef } from '@tanstack/react-table'
import { motion } from 'framer-motion'
import { Users, UserCheck, BadgeCheck, UserX, Clock, Eye, ArrowRight, Plus } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useEmployees, useEmployeeStats, usePendingEmployees } from '@/hooks/useEmployees'
import { useDepartments } from '@/hooks/useDepartments'
import { usePositions } from '@/hooks/usePositions'
import { EMPLOYMENT_TYPE_LABEL } from '@/lib/jobPostingLabels'
import { EMPLOYMENT_STATUS_LABEL, EMPLOYMENT_STATUS_VARIANT, PENDING_EMPLOYEE_STATUS, PENDING_EMPLOYEE_STATUS_LABEL } from '@/lib/employeeLabels'
import type { EmploymentStatus } from '@/lib/enums'

const ALL = 'all'

interface EmployeeListRow {
  kind: 'employee' | 'pending'
  /** employees.id for a real row, applications.id for a pending one. */
  id: string
  employeeNumber: string | null
  firstName: string
  lastName: string
  email: string
  departmentId: string | null
  departmentName: string | null
  positionId: string | null
  positionName: string | null
  employmentType: string | null
  employmentStatus: EmploymentStatus | null
  hireDate: string | null
  sortDate: string
}

function StatCard({
  label,
  value,
  icon: Icon,
  isLoading,
  index,
}: {
  label: string
  value: number
  icon: React.ComponentType<{ className?: string }>
  isLoading: boolean
  index: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
    >
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            {isLoading ? (
              <Skeleton className="mt-1 h-6 w-12" />
            ) : (
              <p className="font-display text-xl font-bold text-foreground">{value}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function EmployeesPage() {
  const navigate = useNavigate()
  const { data: employees, isLoading, isError } = useEmployees()
  const { data: pendingEmployees, isLoading: pendingLoading } = usePendingEmployees()
  const { data: stats, isLoading: statsLoading } = useEmployeeStats()
  const { data: departments } = useDepartments()
  const { data: positions } = usePositions()

  const [departmentFilter, setDepartmentFilter] = React.useState(ALL)
  const [positionFilter, setPositionFilter] = React.useState(ALL)
  // Employees opens on the people who currently work here. Resigned, terminated
  // and retired records are kept forever and stay one click away, but they are
  // history: they should not pad the headcount anyone sees first.
  const [statusFilter, setStatusFilter] = React.useState<string>('active')
  const [typeFilter, setTypeFilter] = React.useState(ALL)
  const [dateFrom, setDateFrom] = React.useState('')
  const [dateTo, setDateTo] = React.useState('')

  const filteredPositions = React.useMemo(
    () => (departmentFilter === ALL ? positions : positions?.filter((p) => p.department_id === departmentFilter)),
    [positions, departmentFilter]
  )

  // Pending rows sort first (newest-deployed first), then real employees —
  // matches the spec's "pending employees appear at the top of the table".
  const allRows: EmployeeListRow[] = React.useMemo(() => {
    const pending: EmployeeListRow[] = (pendingEmployees ?? [])
      .slice()
      .sort((a, b) => b.deployedAt.localeCompare(a.deployedAt))
      .map((p) => ({
        kind: 'pending',
        id: p.applicationId,
        employeeNumber: null,
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        departmentId: null,
        departmentName: null,
        positionId: null,
        positionName: null,
        employmentType: null,
        employmentStatus: null,
        hireDate: null,
        sortDate: p.deployedAt,
      }))
    const real: EmployeeListRow[] = (employees ?? []).map((e) => ({
      kind: 'employee',
      id: e.id,
      employeeNumber: e.employee_number,
      firstName: e.first_name,
      lastName: e.last_name,
      email: e.email,
      departmentId: e.department_id,
      departmentName: e.departments?.name ?? null,
      positionId: e.position_id,
      positionName: e.positions?.title ?? null,
      employmentType: e.employment_type,
      employmentStatus: e.employment_status,
      hireDate: e.hire_date,
      sortDate: e.created_at,
    }))
    return [...pending, ...real]
  }, [pendingEmployees, employees])

  const rows = React.useMemo(() => {
    return allRows.filter((row) => {
      if (statusFilter === PENDING_EMPLOYEE_STATUS) return row.kind === 'pending'
      // A deployed applicant with no employees row yet is incoming, not departed,
      // so the default Active view keeps showing them -- that row is the only
      // entry point to Create Employee, and hiding it would strand the hire.
      if (row.kind === 'pending')
        return (
          (statusFilter === ALL || statusFilter === 'active') &&
          departmentFilter === ALL &&
          positionFilter === ALL &&
          typeFilter === ALL &&
          !dateFrom &&
          !dateTo
        )
      if (departmentFilter !== ALL && row.departmentId !== departmentFilter) return false
      if (positionFilter !== ALL && row.positionId !== positionFilter) return false
      if (statusFilter !== ALL && row.employmentStatus !== statusFilter) return false
      if (typeFilter !== ALL && row.employmentType !== typeFilter) return false
      if (dateFrom && (!row.hireDate || row.hireDate < dateFrom)) return false
      if (dateTo && (!row.hireDate || row.hireDate > dateTo)) return false
      return true
    })
  }, [allRows, departmentFilter, positionFilter, statusFilter, typeFilter, dateFrom, dateTo])

  const columns: ColumnDef<EmployeeListRow>[] = [
    {
      id: '_searchText',
      accessorFn: (row) => [row.employeeNumber, row.firstName, row.lastName, row.email].filter(Boolean).join(' ').toLowerCase(),
      header: () => null,
      cell: () => null,
    },
    {
      id: 'employee_number',
      header: 'Employee ID',
      accessorFn: (row) => row.employeeNumber ?? '',
      cell: ({ row }) =>
        row.original.employeeNumber ? (
          <span className="font-mono text-sm text-foreground">{row.original.employeeNumber}</span>
        ) : (
          <span className="text-muted-foreground">Pending</span>
        ),
    },
    {
      id: 'name',
      header: 'Employee Name',
      accessorFn: (row) => `${row.firstName} ${row.lastName}`,
      cell: ({ row }) => (
        <span className="font-medium text-foreground">
          {row.original.firstName} {row.original.lastName}
        </span>
      ),
    },
    {
      id: 'department',
      header: 'Department',
      accessorFn: (row) => row.departmentName ?? '',
      cell: ({ row }) => (row.original.departmentName ? <Badge variant="secondary">{row.original.departmentName}</Badge> : '—'),
    },
    {
      id: 'position',
      header: 'Position',
      accessorFn: (row) => row.positionName ?? '',
      cell: ({ row }) => row.original.positionName ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'employment_type',
      header: 'Employment Type',
      accessorFn: (row) => (row.employmentType ? EMPLOYMENT_TYPE_LABEL[row.employmentType as keyof typeof EMPLOYMENT_TYPE_LABEL] : ''),
    },
    {
      id: 'employment_status',
      header: 'Employment Status',
      accessorFn: (row) => (row.employmentStatus ? EMPLOYMENT_STATUS_LABEL[row.employmentStatus] : PENDING_EMPLOYEE_STATUS_LABEL),
      cell: ({ row }) =>
        row.original.employmentStatus ? (
          <Badge variant={EMPLOYMENT_STATUS_VARIANT[row.original.employmentStatus]}>{EMPLOYMENT_STATUS_LABEL[row.original.employmentStatus]}</Badge>
        ) : (
          <Badge variant="warning">{PENDING_EMPLOYEE_STATUS_LABEL}</Badge>
        ),
    },
    {
      id: 'hire_date',
      header: 'Date Hired',
      accessorFn: (row) => row.hireDate ?? '',
      cell: ({ row }) => (row.original.hireDate ? formatDate(row.original.hireDate) : '—'),
    },
    { accessorKey: 'email', header: 'Email' },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        row.original.kind === 'pending' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              navigate(`/dashboard/employees/new?applicationId=${row.original.id}`)
            }}
          >
            Complete Record
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              navigate(`/dashboard/employees/${row.original.id}`)
            }}
          >
            <Eye className="h-4 w-4" />
            View
          </Button>
        ),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">Employee Management</h2>
          <p className="text-sm text-muted-foreground">The single source of truth for every employee record.</p>
        </div>
        <Button onClick={() => navigate('/dashboard/employees/new')}>
          <Plus className="h-4 w-4" />
          Create Employee
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Total Employees" value={stats?.total ?? 0} icon={Users} isLoading={statsLoading} index={0} />
        <StatCard label="Pending Employee Creation" value={pendingEmployees?.length ?? 0} icon={Clock} isLoading={pendingLoading} index={1} />
        <StatCard label="Active Employees" value={stats?.active ?? 0} icon={UserCheck} isLoading={statsLoading} index={2} />
        <StatCard label="Regular Employees" value={stats?.regular ?? 0} icon={BadgeCheck} isLoading={statsLoading} index={3} />
        <StatCard label="Inactive Employees" value={stats?.inactive ?? 0} icon={UserX} isLoading={statsLoading} index={4} />
      </div>

      {isError ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="font-medium text-foreground">Couldn't load employee records</p>
          <p className="text-sm text-muted-foreground">Please refresh the page or try again shortly.</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading || pendingLoading}
          density="compact"
          searchPlaceholder="Search by name, employee ID, or email..."
          searchColumn="_searchText"
          emptyTitle={
            statusFilter === PENDING_EMPLOYEE_STATUS
              ? 'No pending employee records'
              : allRows.length === 0
                ? 'No employees yet'
                : 'No employees match these filters'
          }
          emptyDescription={
            statusFilter === PENDING_EMPLOYEE_STATUS
              ? 'Deployed applicants awaiting a completed employee record will appear here.'
              : allRows.length === 0
                ? 'Create your first employee record to get started.'
                : 'This view shows active employees by default. Change the status filter to see resigned, terminated or retired records.'
          }
          onRowClick={(row) =>
            navigate(row.kind === 'pending' ? `/dashboard/employees/new?applicationId=${row.id}` : `/dashboard/employees/${row.id}`)
          }
          toolbarAction={
            <div className="flex flex-wrap items-center gap-2">
              <Select value={departmentFilter} onValueChange={(v) => { setDepartmentFilter(v); setPositionFilter(ALL) }}>
                <SelectTrigger className="w-40">
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
                <SelectTrigger className="w-40">
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
                  <SelectItem value={PENDING_EMPLOYEE_STATUS}>{PENDING_EMPLOYEE_STATUS_LABEL}</SelectItem>
                  {(Object.entries(EMPLOYMENT_STATUS_LABEL) as [EmploymentStatus, string][]).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All types</SelectItem>
                  {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="hired_from" className="sr-only">
                  Hired from
                </Label>
                <Input id="hired_from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-36" />
                <span className="text-sm text-muted-foreground">to</span>
                <Input id="hired_to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-36" />
              </div>
            </div>
          }
        />
      )}
    </div>
  )
}
