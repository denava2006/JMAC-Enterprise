import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { FileText, Hourglass, FileCheck2, PenLine, PackageCheck, Rocket, Eye } from 'lucide-react'
import { StatCard } from '@/components/stat-card'
import { DataTable } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DeploymentDetailsSheet } from '@/components/deployment/DeploymentDetailsSheet'
import {
  useDeploymentApplications,
  useDeploymentStats,
  useDeploymentRealtimeAlerts,
  getLatestOffer,
  getLatestContract,
  getDeploymentRecord,
  type DeploymentApplication,
} from '@/hooks/useDeployment'
import { useDepartments } from '@/hooks/useDepartments'
import { usePositions } from '@/hooks/usePositions'
import { APPLICATION_STATUS_LABEL, type ApplicationStatus } from '@/lib/applicationStatusLabels'
import {
  DEPLOYMENT_PIPELINE_STATUSES,
  DEPLOYMENT_STAGE_LABEL,
  DEPLOYMENT_STAGE_VARIANT,
  OFFER_STATUS_LABEL,
  OFFER_STATUS_VARIANT,
  CONTRACT_STATUS_LABEL,
  CONTRACT_STATUS_VARIANT,
  deriveDeploymentStage,
} from '@/lib/deploymentLabels'

const ALL = 'all'

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}

function getLastUpdated(row: DeploymentApplication): string {
  const offer = getLatestOffer(row)
  const contract = getLatestContract(offer)
  const deployment = getDeploymentRecord(row)
  const candidates = [row.updated_at, offer?.updated_at, contract?.updated_at, deployment?.updated_at].filter(
    (v): v is string => !!v
  )
  return candidates.sort().at(-1) ?? row.updated_at
}

export default function DeploymentPage() {
  useDeploymentRealtimeAlerts()

  const { data: applications, isLoading, isError } = useDeploymentApplications()
  const stats = useDeploymentStats(applications)
  const { data: departments } = useDepartments()
  const { data: positions } = usePositions()

  const [departmentFilter, setDepartmentFilter] = React.useState(ALL)
  const [positionFilter, setPositionFilter] = React.useState(ALL)
  const [statusFilter, setStatusFilter] = React.useState(ALL)
  const [offerStatusFilter, setOfferStatusFilter] = React.useState(ALL)
  const [contractStatusFilter, setContractStatusFilter] = React.useState(ALL)
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

      const offer = getLatestOffer(app)
      const contract = getLatestContract(offer)
      if (offerStatusFilter !== ALL && offer?.status !== offerStatusFilter) return false
      if (contractStatusFilter !== ALL && contract?.status !== contractStatusFilter) return false

      const lastUpdated = getLastUpdated(app)
      if (dateFrom && lastUpdated < dateFrom) return false
      if (dateTo && lastUpdated.slice(0, 10) > dateTo) return false
      return true
    })
  }, [applications, departmentFilter, positionFilter, statusFilter, offerStatusFilter, contractStatusFilter, dateFrom, dateTo])

  const openApplication = (id: string) => {
    setSelectedApplicationId(id)
    setSheetOpen(true)
  }

  const columns: ColumnDef<DeploymentApplication>[] = [
    {
      id: '_searchText',
      accessorFn: (row) =>
        [
          row.applicant_first_name,
          row.applicant_last_name,
          row.applicant_email,
          row.job_postings?.departments?.name,
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
      header: 'Applicant',
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
      id: 'offer_status',
      header: 'Offer Status',
      cell: ({ row }) => {
        const offer = getLatestOffer(row.original)
        return offer ? (
          <Badge variant={OFFER_STATUS_VARIANT[offer.status]}>{OFFER_STATUS_LABEL[offer.status]}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
    {
      id: 'contract_status',
      header: 'Contract Status',
      cell: ({ row }) => {
        const contract = getLatestContract(getLatestOffer(row.original))
        return contract ? (
          <Badge variant={CONTRACT_STATUS_VARIANT[contract.status]}>{CONTRACT_STATUS_LABEL[contract.status]}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
    {
      id: 'deployment_status',
      header: 'Deployment Status',
      cell: ({ row }) => {
        const app = row.original
        const offer = getLatestOffer(app)
        const contract = getLatestContract(offer)
        const stage = deriveDeploymentStage({
          applicationStatus: app.status as ApplicationStatus,
          offerStatus: offer?.status ?? null,
          contractStatus: contract?.status ?? null,
          hasDeploymentRecord: !!getDeploymentRecord(app),
        })
        return <Badge variant={DEPLOYMENT_STAGE_VARIANT[stage]}>{DEPLOYMENT_STAGE_LABEL[stage]}</Badge>
      },
    },
    {
      id: 'assigned_hr',
      header: 'Assigned HR',
      cell: ({ row }) => getLatestOffer(row.original)?.preparer?.full_name ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'last_updated',
      header: 'Last Updated',
      cell: ({ row }) => formatDate(getLastUpdated(row.original)),
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
        <h2 className="font-display text-xl font-semibold text-foreground">Deployment</h2>
        <p className="text-sm text-muted-foreground">
          Prepare job offers, employment contracts, and deploy hired applicants.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Pending Job Offers" value={stats.pendingOffersCount} icon={FileText} isLoading={isLoading} index={0} size="default" />
        <StatCard label="Awaiting Offer Response" value={stats.awaitingOfferResponseCount} icon={Hourglass} isLoading={isLoading} index={1} size="default" />
        <StatCard label="Contracts Ready" value={stats.contractsReadyCount} icon={FileCheck2} isLoading={isLoading} index={2} size="default" />
        <StatCard label="Waiting for Signature" value={stats.waitingForSignatureCount} icon={PenLine} isLoading={isLoading} index={3} size="default" />
        <StatCard label="Ready for Deployment" value={stats.readyForDeploymentCount} icon={PackageCheck} isLoading={isLoading} index={4} size="default" />
        <StatCard label="Deployed Today" value={stats.deployedTodayCount} icon={Rocket} isLoading={isLoading} index={5} size="default" />
      </div>

      {isError ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="font-medium text-foreground">Couldn't load the deployment queue</p>
          <p className="text-sm text-muted-foreground">Please refresh the page or try again shortly.</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          searchPlaceholder="Search by name, email, department, or position..."
          searchColumn="_searchText"
          emptyTitle="No applicants in the deployment pipeline"
          emptyDescription="Applicants marked Hired in Interview Management will show up here."
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
                  {DEPLOYMENT_PIPELINE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {APPLICATION_STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={offerStatusFilter} onValueChange={setOfferStatusFilter}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Offer Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All offer statuses</SelectItem>
                  {(Object.entries(OFFER_STATUS_LABEL) as [string, string][]).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={contractStatusFilter} onValueChange={setContractStatusFilter}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Contract Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All contract statuses</SelectItem>
                  {(Object.entries(CONTRACT_STATUS_LABEL) as [string, string][]).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
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

      <DeploymentDetailsSheet applicationId={selectedApplicationId} open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  )
}
