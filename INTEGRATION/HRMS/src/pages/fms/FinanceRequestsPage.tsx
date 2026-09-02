import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Inbox, ListChecks } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/AuthContext'
import { formatMoney } from '@/lib/currency'
import {
  REQUEST_TYPE_LABEL,
  inboxStatusFor,
  isOpen,
  type RequestStatus,
  type RequestType,
} from '@/lib/financeRequests'
import { RequestDetail, StatusBadge } from '@/components/fms/RequestDetail'
import { useFinanceRequests, type FinanceRequestRow } from '@/hooks/useFinanceRequests'

export default function FinanceRequestsPage() {
  const { profile } = useAuth()
  const { data: requests = [], isLoading } = useFinanceRequests()
  const [openId, setOpenId] = React.useState<string | null>(null)

  // The status this role is responsible for clearing. Everything else is
  // visible but is somebody else's move.
  const inboxStatus = inboxStatusFor(profile?.role)
  const [scope, setScope] = React.useState<'inbox' | 'open' | 'all'>(inboxStatus ? 'inbox' : 'open')

  const inbox = React.useMemo(
    () => (inboxStatus ? requests.filter((r) => r.status === inboxStatus) : []),
    [requests, inboxStatus],
  )
  const open = React.useMemo(() => requests.filter((r) => isOpen(r.status as RequestStatus)), [requests])

  const shown = scope === 'inbox' ? inbox : scope === 'open' ? open : requests
  const committed = requests
    .filter((r) => r.status === 'pending_payment')
    .reduce((sum, r) => sum + Number(r.amount), 0)

  const columns = React.useMemo<ColumnDef<FinanceRequestRow>[]>(
    () => [
      {
        accessorKey: 'request_no',
        header: 'Reference',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-mono text-xs text-muted-foreground">{row.original.request_no}</p>
            <p className="truncate font-medium text-foreground">{row.original.title}</p>
          </div>
        ),
      },
      {
        id: 'requester',
        header: 'Requested by',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate text-sm text-foreground">
              {row.original.profiles?.full_name ?? '—'}
            </p>
            <p className="text-xs text-muted-foreground">
              {REQUEST_TYPE_LABEL[row.original.type as RequestType]}
            </p>
          </div>
        ),
      },
      {
        id: 'amount',
        header: 'Amount',
        cell: ({ row }) => (
          <div className="min-w-[6rem]">
            <p className="tabular-nums text-foreground">{formatMoney(Number(row.original.amount))}</p>
            <p className="truncate text-xs text-muted-foreground">
              {row.original.budgets?.name ?? 'No budget'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusBadge status={row.original.status as RequestStatus} />,
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Requests"
        description="Purchases and reimbursements moving through validation, approval and payment."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={inboxStatus ? 'Waiting on you' : 'Open requests'}
          value={inboxStatus ? inbox.length : open.length}
          icon={Inbox}
          isLoading={isLoading}
        />
        <StatCard label="Open in total" value={open.length} icon={ListChecks} isLoading={isLoading} />
        <StatCard
          label="Approved, not yet paid"
          value={formatMoney(committed)}
          icon={ListChecks}
          isLoading={isLoading}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {inboxStatus && (
          <Button variant={scope === 'inbox' ? 'default' : 'outline'} size="sm" onClick={() => setScope('inbox')}>
            Waiting on you ({inbox.length})
          </Button>
        )}
        <Button variant={scope === 'open' ? 'default' : 'outline'} size="sm" onClick={() => setScope('open')}>
          Open ({open.length})
        </Button>
        <Button variant={scope === 'all' ? 'default' : 'outline'} size="sm" onClick={() => setScope('all')}>
          Everything ({requests.length})
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={shown}
        isLoading={isLoading}
        searchColumn="request_no"
        searchPlaceholder="Search by reference..."
        emptyTitle={scope === 'inbox' ? 'Nothing is waiting on you' : 'No requests yet'}
        emptyDescription={
          scope === 'inbox'
            ? 'Requests appear here when they reach the step you are responsible for.'
            : 'Requests raised by employees appear here once submitted.'
        }
        onRowClick={(row) => setOpenId(row.id)}
      />

      <RequestDetail requestId={openId} onOpenChange={(open) => !open && setOpenId(null)} />
    </div>
  )
}
