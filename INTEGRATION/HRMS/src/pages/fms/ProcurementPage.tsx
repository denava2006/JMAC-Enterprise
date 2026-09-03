import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { ClipboardList, PackageCheck, Truck } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { useAuth } from '@/contexts/AuthContext'
import { formatMoney } from '@/lib/currency'
import {
  DEMAND_STATE_LABEL,
  PO_STATUS_LABEL,
  useAcceptRestockDemand,
  useProcurementDemand,
  usePurchaseOrders,
  type ProcurementDemand,
  type PurchaseOrder,
} from '@/hooks/useProcurement'
import { PurchaseOrderDetail } from '@/components/fms/PurchaseOrderDetail'
import { PurchaseOrderBuilder } from '@/components/fms/PurchaseOrderBuilder'
import type { ProcurementSourceRef } from '@/hooks/useProcurement'

type Scope = 'demand' | 'orders'

/**
 * Procurement: approved demand on one side, purchase orders on the other.
 *
 * Demand is not copied into procurement. An approved finance request and a POS
 * stock request each keep their own record and their own lifecycle; raising an
 * order links to them, so "what created this PO" has an answer that survives.
 *
 * Nothing on this page moves stock. An approved order is authorization to buy;
 * the branch that receives the goods is what changes inventory.
 */
export default function ProcurementPage() {
  const { profile } = useAuth()
  const { data: orders = [], isLoading } = usePurchaseOrders()
  const { data: demand = [], isError: demandFailed, error: demandError } = useProcurementDemand()
  const acceptDemand = useAcceptRestockDemand()
  const [scope, setScope] = React.useState<Scope>('demand')
  const [openOrder, setOpenOrder] = React.useState<string | null>(null)
  const [newOrderFor, setNewOrderFor] = React.useState<ProcurementSourceRef | null>(null)

  // Preparation is the maker's, and the server agrees:
  // create_purchase_order_from_source refuses anybody who is not Finance Staff.
  // Offering the Manager a builder here would only mean a rejected call.
  const canPrepare = profile?.role === 'finance_staff'

  // Demand that has not yet produced an order. Once one exists the row moves on
  // rather than inviting a second order for the same need.
  const openDemand = demand.filter((d) => d.demand_state !== 'ordered')
  const awaitingDelivery = orders.filter(
    (o) => o.status === 'approved' && (o.quantity_outstanding ?? 0) > 0,
  )

  const orderColumns = React.useMemo<ColumnDef<PurchaseOrder>[]>(
    () => [
      {
        accessorKey: 'po_number',
        header: 'Order',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-mono text-xs text-muted-foreground">{row.original.po_number}</p>
            <p className="truncate font-medium text-foreground">{row.original.vendor_name ?? '—'}</p>
          </div>
        ),
      },
      {
        id: 'lines',
        header: 'Lines',
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.line_count ?? 0}</span>
        ),
      },
      {
        id: 'subtotal',
        header: 'Value',
        cell: ({ row }) => (
          <span className="tabular-nums">{formatMoney(Number(row.original.subtotal ?? 0))}</span>
        ),
      },
      {
        id: 'progress',
        header: 'Received',
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.quantity_received ?? 0} / {row.original.quantity_ordered ?? 0}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.status === 'approved'
                ? 'default'
                : ['rejected', 'cancelled'].includes(row.original.status ?? '')
                  ? 'destructive'
                  : 'secondary'
            }
          >
            {PO_STATUS_LABEL[row.original.status ?? ''] ?? row.original.status}
          </Badge>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Procurement"
        description="Approved demand, the orders raised against it, and what is still to arrive."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Awaiting procurement"
          value={demandFailed ? '—' : openDemand.length}
          icon={ClipboardList}
          isLoading={isLoading}
        />
        <StatCard
          label="Orders in progress"
          value={orders.filter((o) => ['draft', 'pending_approval'].includes(o.status ?? '')).length}
          icon={PackageCheck}
          isLoading={isLoading}
        />
        <StatCard
          label="Awaiting delivery"
          value={awaitingDelivery.length}
          icon={Truck}
          isLoading={isLoading}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant={scope === 'demand' ? 'default' : 'outline'} size="sm" onClick={() => setScope('demand')}>
          Demand ({demandFailed ? '—' : openDemand.length})
        </Button>
        <Button variant={scope === 'orders' ? 'default' : 'outline'} size="sm" onClick={() => setScope('orders')}>
          Purchase Orders ({orders.length})
        </Button>
      </div>

      {scope === 'demand' ? (
        <div className="flex flex-col gap-3">
          {demandFailed ? (
            // A page that cannot load its work says so. Reporting a failure as
            // "Demand (0)" makes a permission problem and an empty queue look
            // identical, which is how a branch's request goes unnoticed.
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-sm font-medium text-destructive">
                  Procurement demand could not be loaded.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {(demandError as { message?: string } | null)?.message ??
                    'Try again, and tell an administrator if it persists.'}
                </p>
              </CardContent>
            </Card>
          ) : openDemand.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  Nothing is waiting to be procured. Approved purchase requests and branch stock
                  requests appear here as soon as they are raised.
                </p>
              </CardContent>
            </Card>
          ) : (
            openDemand.map((d) => (
              <DemandRow
                key={`${d.source_kind}-${d.source_id}`}
                demand={d}
                canPrepare={canPrepare}
                accepting={acceptDemand.isPending}
                onAccept={() => acceptDemand.mutate({ requestId: d.source_id })}
                onCreate={() =>
                  setNewOrderFor({
                    kind: d.source_kind === 'finance_request' ? 'finance_request' : 'pos_restock',
                    id: d.source_id,
                    label: d.reference ?? d.title ?? 'Request',
                  })
                }
              />
            ))
          )}
        </div>
      ) : (
        <DataTable
          columns={orderColumns}
          data={orders}
          isLoading={isLoading}
          searchColumn="po_number"
          searchPlaceholder="Search by PO number..."
          emptyTitle="No purchase orders yet"
          emptyDescription="Raise one from approved demand, and it appears here until it is delivered."
          onRowClick={(row) => row.id && setOpenOrder(row.id)}
        />
      )}

      <PurchaseOrderBuilder
        source={newOrderFor}
        onOpenChange={(open) => !open && setNewOrderFor(null)}
        onCreated={(id) => {
          setNewOrderFor(null)
          setScope('orders')
          setOpenOrder(id)
        }}
      />
      <PurchaseOrderDetail
        orderId={openOrder}
        onOpenChange={(open) => !open && setOpenOrder(null)}
      />
    </div>
  )
}

function DemandRow({
  demand,
  canPrepare,
  accepting,
  onAccept,
  onCreate,
}: {
  demand: ProcurementDemand
  canPrepare: boolean
  accepting: boolean
  onAccept: () => void
  onCreate: () => void
}) {
  const isRestock = demand.source_kind === 'pos_restock'
  const awaitingReview = demand.demand_state === 'awaiting_finance_review'

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-xs text-muted-foreground">{demand.reference}</p>
            <Badge variant={awaitingReview ? 'default' : 'secondary'}>
              {DEMAND_STATE_LABEL[demand.demand_state] ?? demand.demand_state}
            </Badge>
          </div>
          <p className="truncate font-medium text-foreground">{demand.title}</p>
          <p className="text-xs text-muted-foreground">
            {isRestock
              ? `${demand.branch_name ?? 'Branch'} · ${demand.requested_quantity} requested · ${demand.requested_by_name ?? 'Unknown'}`
              : `${formatMoney(Number(demand.amount ?? 0))} · ${demand.requested_by_name ?? 'Unknown'}`}
          </p>
          {demand.reason && (
            <p className="truncate text-xs text-muted-foreground">{demand.reason}</p>
          )}
        </div>

        {canPrepare && (
          <div className="flex flex-wrap gap-2">
            {/* Two different decisions, named differently on purpose: Finance
                Staff say this should be bought; the Finance Manager commits the
                company to buying it, on the order. */}
            {isRestock && awaitingReview ? (
              <Button size="sm" disabled={accepting} onClick={onAccept}>
                {accepting ? 'Accepting…' : 'Accept for procurement'}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onCreate}>
                Create purchase order
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
