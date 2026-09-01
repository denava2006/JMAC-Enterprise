import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { motion } from 'framer-motion'
import { Inbox, CheckCircle2, XCircle, CalendarClock, Eye } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApplicantDetailsSheet } from '@/components/recruitment/ApplicantDetailsSheet'
import {
  useRecruitmentApplications,
  useRecruitmentStats,
  useRecruitmentRealtimeAlerts,
  type RecruitmentApplication,
} from '@/hooks/useRecruitment'
import { useDepartments } from '@/hooks/useDepartments'
import { usePositions } from '@/hooks/usePositions'
import { APPLICATION_STATUS_LABEL, APPLICATION_STATUS_VARIANT, RECRUITMENT_STATUSES } from '@/lib/applicationStatusLabels'

const ALL = 'all'

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
        <CardContent className="flex items-center gap-4 p-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            {isLoading ? (
              <Skeleton className="mt-1 h-7 w-12" />
            ) : (
              <p className="font-display text-2xl font-bold text-foreground">{value}</p>
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

export default function RecruitmentPage() {
  useRecruitmentRealtimeAlerts()

  const { data: applications, isLoading, isError } = useRecruitmentApplications()
  const { data: stats, isLoading: statsLoading } = useRecruitmentStats()
  const { data: departments } = useDepartments()
  const { data: positions } = usePositions()

  const [departmentFilter, setDepartmentFilter] = React.useState(ALL)
  const [positionFilter, setPositionFilter] = React.useState(ALL)
  const [statusFilter, setStatusFilter] = React.useState(ALL)
  const [dateFrom, setDateFrom] = React.useState('')
  const [dateTo, setDateTo] = React.useState('')
  const [selectedApplicationId, setSelectedApplicationId] = React.useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = React.useState(false)

  const filteredPositions = React.useMemo(
    () => (departmentFilter === ALL ? positions : positions?.filter((p) => p.department_id === departmentFilter)),
    [positions, departmentFilter]
  )

  // Department/position/status/date are real filters (narrow the dataset before the
  // table sees it, so pagination reflects the filtered count). Free-text search by
  // name/email/position is left to DataTable's own search box via the synthetic
  // _searchText column below, rather than duplicating that logic here.
  const rows = React.useMemo(() => {
    if (!applications) return []
    return applications.filter((app) => {
      if (departmentFilter !== ALL && app.job_postings?.department_id !== departmentFilter) return false
      if (positionFilter !== ALL && app.job_postings?.position_id !== positionFilter) return false
      if (statusFilter !== ALL && app.status !== statusFilter) return false
      if (dateFrom && app.created_at < dateFrom) return false
      if (dateTo && app.created_at.slice(0, 10) > dateTo) return false
      return true
    })
  }, [applications, departmentFilter, positionFilter, statusFilter, dateFrom, dateTo])

  const openApplication = (id: string) => {
    setSelectedApplicationId(id)
    setSheetOpen(true)
  }

  const columns: ColumnDef<RecruitmentApplication>[] = [
    {
      // Registered so DataTable's searchColumn="_searchText" can read it via
      // getValue() — hidden from view automatically (see data-table.tsx).
      id: '_searchText',
      accessorFn: (row) =>
        [
          row.applicant_first_name,
          row.applicant_last_name,
          row.applicant_email,
          row.job_postings?.positions?.title,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      header: () => null,
      cell: () => null,
    },
    {
      id: 'applicant',
      header: 'Applicant Name',
      accessorFn: (row) => `${row.applicant_first_name ?? ''} ${row.applicant_last_name ?? ''}`.trim(),
      cell: ({ row }) => (
        <span className="font-medium text-foreground">
          {row.original.applicant_first_name} {row.original.applicant_last_name}
        </span>
      ),
    },
    {
      id: 'position',
      header: 'Position Applied',
      accessorFn: (row) => row.job_postings?.positions?.title ?? '',
    },
    {
      id: 'department',
      header: 'Department',
      accessorFn: (row) => row.job_postings?.departments?.name ?? '',
      cell: ({ row }) =>
        row.original.job_postings?.departments?.name ? (
          <Badge variant="secondary">{row.original.job_postings.departments.name}</Badge>
        ) : (
          '—'
        ),
    },
    {
      accessorKey: 'created_at',
      header: 'Submission Date',
      cell: ({ row }) => formatDate(row.original.created_at),
    },
    {
      accessorKey: 'status',
      header: 'Current Status',
      cell: ({ row }) => (
        <Badge variant={APPLICATION_STATUS_VARIANT[row.original.status]}>
          {APPLICATION_STATUS_LABEL[row.original.status]}
        </Badge>
      ),
    },
    {
      id: 'reviewed_by',
      header: 'Reviewed By',
      accessorFn: (row) => row.reviewer?.full_name ?? '',
      cell: ({ row }) => row.original.reviewer?.full_name ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            openApplication(row.original.id)
          }}
        >
          <Eye className="h-4 w-4" />
          View
        </Button>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground">Recruitment</h2>
        <p className="text-sm text-muted-foreground">Review, screen, and decide on every application received.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="New Applications" value={stats?.newCount ?? 0} icon={Inbox} isLoading={statsLoading} index={0} />
        <StatCard label="Qualified" value={stats?.qualifiedCount ?? 0} icon={CheckCircle2} isLoading={statsLoading} index={1} />
        <StatCard label="Rejected" value={stats?.rejectedCount ?? 0} icon={XCircle} isLoading={statsLoading} index={2} />
        <StatCard label="Received Today" value={stats?.todayCount ?? 0} icon={CalendarClock} isLoading={statsLoading} index={3} />
      </div>

      {isError ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="font-medium text-foreground">Couldn't load applications</p>
          <p className="text-sm text-muted-foreground">Please refresh the page or try again shortly.</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          searchPlaceholder="Search by name, email, or position..."
          searchColumn="_searchText"
          emptyTitle="No applications yet"
          emptyDescription="Applications submitted through the Careers Portal will show up here."
          onRowClick={(row) => openApplication(row.id)}
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
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All statuses</SelectItem>
                  {RECRUITMENT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {APPLICATION_STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="date_from" className="sr-only">
                  From
                </Label>
                <Input
                  id="date_from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-36"
                />
                <span className="text-sm text-muted-foreground">to</span>
                <Input
                  id="date_to"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-36"
                />
              </div>
            </div>
          }
        />
      )}

      <ApplicantDetailsSheet applicationId={selectedApplicationId} open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  )
}
