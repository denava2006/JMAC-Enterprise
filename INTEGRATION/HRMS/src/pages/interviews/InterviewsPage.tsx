import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { motion } from 'framer-motion'
import { CalendarClock, CalendarCheck2, CalendarDays, Hourglass, CheckCircle2, XCircle, Eye } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InterviewDetailsSheet } from '@/components/interviews/InterviewDetailsSheet'
import {
  useInterviewApplications,
  useInterviewStats,
  useInterviewRealtimeAlerts,
  getInterviewByStage,
  type InterviewApplication,
} from '@/hooks/useInterviews'
import { useDepartments } from '@/hooks/useDepartments'
import { usePositions } from '@/hooks/usePositions'
import { APPLICATION_STATUS_LABEL, APPLICATION_STATUS_VARIANT, type ApplicationStatus } from '@/lib/applicationStatusLabels'
import { DERIVED_STAGE_LABEL, DERIVED_STAGE_VARIANT, INTERVIEW_PIPELINE_STATUSES, deriveStage } from '@/lib/interviewLabels'

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

/** The interview currently driving the row's "Interview Date"/"Interviewer"
 * columns — the final interview once scheduled, otherwise the initial one. */
function currentInterview(row: InterviewApplication) {
  const final = getInterviewByStage(row.interviews, 'final')
  if (final) return final
  return getInterviewByStage(row.interviews, 'initial')
}

export default function InterviewsPage() {
  useInterviewRealtimeAlerts()

  const { data: applications, isLoading, isError } = useInterviewApplications()
  const { data: stats, isLoading: statsLoading } = useInterviewStats()
  const { data: departments } = useDepartments()
  const { data: positions } = usePositions()

  const [departmentFilter, setDepartmentFilter] = React.useState(ALL)
  const [positionFilter, setPositionFilter] = React.useState(ALL)
  const [statusFilter, setStatusFilter] = React.useState(ALL)
  const [stageFilter, setStageFilter] = React.useState(ALL)
  const [dateFrom, setDateFrom] = React.useState('')
  const [dateTo, setDateTo] = React.useState('')
  const [selectedApplicationId, setSelectedApplicationId] = React.useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = React.useState(false)

  const filteredPositions = React.useMemo(
    () => (departmentFilter === ALL ? positions : positions?.filter((p) => p.department_id === departmentFilter)),
    [positions, departmentFilter]
  )

  const rows = React.useMemo(() => {
    if (!applications) return []
    return applications.filter((app) => {
      if (departmentFilter !== ALL && app.job_postings?.department_id !== departmentFilter) return false
      if (positionFilter !== ALL && app.job_postings?.position_id !== positionFilter) return false
      if (statusFilter !== ALL && app.status !== statusFilter) return false
      const stage = deriveStage(app.status as ApplicationStatus, getInterviewByStage(app.interviews, 'initial'), getInterviewByStage(app.interviews, 'final'))
      if (stageFilter !== ALL && stage !== stageFilter) return false
      const interview = currentInterview(app)
      if (dateFrom && (!interview || interview.scheduled_at < dateFrom)) return false
      if (dateTo && (!interview || interview.scheduled_at.slice(0, 10) > dateTo)) return false
      return true
    })
  }, [applications, departmentFilter, positionFilter, statusFilter, stageFilter, dateFrom, dateTo])

  const openApplication = (id: string) => {
    setSelectedApplicationId(id)
    setSheetOpen(true)
  }

  const columns: ColumnDef<InterviewApplication>[] = [
    {
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
      header: 'Position',
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
      id: 'stage',
      header: 'Interview Stage',
      cell: ({ row }) => {
        const stage = deriveStage(
          row.original.status as ApplicationStatus,
          getInterviewByStage(row.original.interviews, 'initial'),
          getInterviewByStage(row.original.interviews, 'final')
        )
        return <Badge variant={DERIVED_STAGE_VARIANT[stage]}>{DERIVED_STAGE_LABEL[stage]}</Badge>
      },
    },
    {
      id: 'interview_date',
      header: 'Interview Date',
      cell: ({ row }) => {
        const interview = currentInterview(row.original)
        return interview ? formatDate(interview.scheduled_at) : <span className="text-muted-foreground">—</span>
      },
    },
    {
      id: 'interviewer',
      header: 'Interviewer',
      cell: ({ row }) => {
        const interview = currentInterview(row.original)
        return interview?.interviewer?.full_name ?? <span className="text-muted-foreground">—</span>
      },
    },
    {
      id: 'status',
      header: 'Current Status',
      cell: ({ row }) => (
        <Badge variant={APPLICATION_STATUS_VARIANT[row.original.status]}>
          {APPLICATION_STATUS_LABEL[row.original.status]}
        </Badge>
      ),
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
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground">Interview Management</h2>
        <p className="text-sm text-muted-foreground">
          Schedule, conduct, and decide on interviews for every qualified applicant.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Scheduled Interviews" value={stats?.scheduledCount ?? 0} icon={CalendarClock} isLoading={statsLoading} index={0} />
        <StatCard label="Initial Interviews Today" value={stats?.initialTodayCount ?? 0} icon={CalendarDays} isLoading={statsLoading} index={1} />
        <StatCard label="Final Interviews Today" value={stats?.finalTodayCount ?? 0} icon={CalendarCheck2} isLoading={statsLoading} index={2} />
        <StatCard label="Under Interview" value={stats?.underInterviewCount ?? 0} icon={Hourglass} isLoading={statsLoading} index={3} />
        <StatCard label="Hired" value={stats?.hiredCount ?? 0} icon={CheckCircle2} isLoading={statsLoading} index={4} />
        <StatCard label="Rejected" value={stats?.rejectedCount ?? 0} icon={XCircle} isLoading={statsLoading} index={5} />
      </div>

      {isError ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="font-medium text-foreground">Couldn't load interview queue</p>
          <p className="text-sm text-muted-foreground">Please refresh the page or try again shortly.</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          density="compact"
          searchPlaceholder="Search by name, email, or position..."
          searchColumn="_searchText"
          emptyTitle="No applicants in the interview pipeline"
          emptyDescription="Applicants marked Qualified in Recruitment will show up here."
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
              <Select value={stageFilter} onValueChange={setStageFilter}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Interview Stage" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All stages</SelectItem>
                  {Object.entries(DERIVED_STAGE_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
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
                  {INTERVIEW_PIPELINE_STATUSES.map((s) => (
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

      <InterviewDetailsSheet applicationId={selectedApplicationId} open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  )
}
