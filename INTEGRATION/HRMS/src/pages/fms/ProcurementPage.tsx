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
import { financeCan } from '@/lib/financeAuthority'
import {
  PO_STATUS_LABEL,
  useProcurementDemand,
  usePurchaseOrders,
  type PurchaseOrder,
} from '@/hooks/useProcurement'
import { PurchaseOrderDetail } from '@/components/fms/PurchaseOrderDetail'
import { NewPurchaseOrderDialog } from '@/components/fms/NewPurchaseOrderDialog'

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
  const { data: demand } = useProcurementDemand()
  const [scope, setScope] = React.useState<Scope>('demand')
  const [openOrder, setOpenOrder] = React.useState<string | null>(null)
  const [newOrderFor, setNewOrderFor] = React.useState<
    { financeRequestId?: string; posInventoryRequestId?: string; label: string } | null
  >(null)

  const canPrepare = financeCan(profile?.role, 'budgets', 'read') &&
    (profile?.role === 'finance_staff' || profile?.role === 'finance_manager')

  const financeDemand = demand?.financeRequests ?? []
  const stockDemand = demand?.stockRequests ?? []
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
          value={financeDemand.length + stockDemand.length}
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
          Demand ({financeDemand.length + stockDemand.length})
        </Button>
        <Button variant={scope === 'orders' ? 'default' : 'outline'} size="sm" onClick={() => setScope('orders')}>
          Purchase Orders ({orders.length})
        </Button>
      </div>

      {scope === 'demand' ? (
        <div className="flex flex-col gap-3">
          {financeDemand.length === 0 && stockDemand.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  Nothing is waiting to be procured. Approved purchase requests and approved branch
                  stock requests appear here.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {financeDemand.map((r) => (
                <DemandRow
                  key={r.id}
                  reference={r.request_no ?? 'Request'}
                  title={r.title}
                  detail={`Approved request · ${formatMoney(Number(r.amount))}`}
                  canPrepare={canPrepare}
                  onCreate={() =>
                    setNewOrderFor({ financeRequestId: r.id, label: r.request_no ?? r.title })
                  }
                />
              ))}
              {stockDemand.map((r) => (
                <DemandRow
                  key={r.id}
                  reference="Stock request"
                  title={r.product_name_snapshot ?? 'Branch stock'}
                  detail={`${r.branch_name_snapshot ?? 'Branch'} · ${r.requested_quantity} requested`}
                  canPrepare={canPrepare}
                  onCreate={() =>
                    setNewOrderFor({
                      posInventoryRequestId: r.id,
                      label: r.product_name_snapshot ?? 'Branch stock',
                    })
                  }
                />
              ))}
            </>
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

      <NewPurchaseOrderDialog
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
  reference,
  title,
  detail,
  canPrepare,
  onCreate,
}: {
  reference: string
  title: string
  detail: string
  canPrepare: boolean
  onCreate: () => void
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">{reference}</p>
          <p className="truncate font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        {canPrepare && (
          <Button size="sm" variant="outline" onClick={onCreate}>
            Create purchase order
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
