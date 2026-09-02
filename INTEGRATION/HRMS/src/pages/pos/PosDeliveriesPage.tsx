import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Truck } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/contexts/AuthContext'
import { useBranches } from '@/hooks/useBranches'
import { isPosManagerAt } from '@/lib/portals'
import {
  useBranchDeliveries,
  useReceiveDelivery,
  type BranchDelivery,
} from '@/hooks/useProcurement'

/**
 * Deliveries waiting for this branch to confirm.
 *
 * The branch manager's whole share of procurement. They see what was ordered
 * for them, what has already arrived and what is still outstanding — and no
 * cost, no vendor terms and no order total. Confirming that units arrived is
 * not a reason to learn what the company paid for them.
 *
 * Confirming here is what moves stock. Nothing before it does: not the request
 * approval, not the purchase order, not its approval.
 */
export default function PosDeliveriesPage() {
  const { profile, posAccess } = useAuth()
  const { data: branches } = useBranches()

  const myBranches = React.useMemo(() => {
    const active = (branches ?? []).filter((b) => b.is_active)
    // Only branches this person actually manages: receiving is the manager's,
    // and the server refuses anything else anyway.
    return active.filter((b) => isPosManagerAt(posAccess, b.id))
  }, [branches, posAccess])

  const [branchId, setBranchId] = React.useState('')
  React.useEffect(() => {
    if (!branchId && myBranches.length > 0) setBranchId(myBranches[0].id)
  }, [branchId, myBranches])

  const { data: deliveries = [], isLoading } = useBranchDeliveries(branchId || undefined)
  const [receiving, setReceiving] = React.useState<BranchDelivery | null>(null)

  const outstandingLines = deliveries.filter((d) => d.quantity_outstanding > 0)
  const outstandingUnits = outstandingLines.reduce((sum, d) => sum + d.quantity_outstanding, 0)

  const columns = React.useMemo<ColumnDef<BranchDelivery>[]>(
    () => [
      {
        accessorKey: 'product_name',
        header: 'Product',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{row.original.product_name}</p>
            <p className="font-mono text-xs text-muted-foreground">{row.original.po_number}</p>
          </div>
        ),
      },
      {
        id: 'ordered',
        header: 'Ordered',
        cell: ({ row }) => <span className="tabular-nums">{row.original.quantity_ordered}</span>,
      },
      {
        id: 'received',
        header: 'Received',
        cell: ({ row }) => <span className="tabular-nums">{row.original.quantity_received}</span>,
      },
      {
        id: 'remaining',
        header: 'Remaining',
        cell: ({ row }) =>
          row.original.quantity_outstanding === 0 ? (
            <Badge variant="secondary">Complete</Badge>
          ) : (
            <span className="font-medium tabular-nums text-foreground">
              {row.original.quantity_outstanding}
            </span>
          ),
      },
      {
        id: 'expected',
        header: 'Expected',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.expected_delivery_date ?? '—'}
          </span>
        ),
      },
      {
        id: 'actions',
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={row.original.quantity_outstanding === 0}
              onClick={() => setReceiving(row.original)}
            >
              Confirm delivery
            </Button>
          </div>
        ),
      },
    ],
    [],
  )

  if (myBranches.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Deliveries" description="Stock arriving against purchase orders." />
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Deliveries are confirmed by the manager of the branch they are sent to. You do not
              manage a branch, so there is nothing here for you.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Deliveries"
        description="Confirm what physically arrived. This is what updates branch stock."
        action={
          myBranches.length > 1 ? (
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                {myBranches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Lines awaiting delivery" value={outstandingLines.length} icon={Truck} isLoading={isLoading} />
        <StatCard label="Units outstanding" value={outstandingUnits} icon={Truck} isLoading={isLoading} />
        <StatCard label="Lines on order" value={deliveries.length} icon={Truck} isLoading={isLoading} />
      </div>

      <DataTable
        columns={columns}
        data={deliveries}
        isLoading={isLoading}
        searchColumn="product_name"
        searchPlaceholder="Search deliveries..."
        emptyTitle="Nothing on order for this branch"
        emptyDescription="Approved purchase orders destined for your branch appear here until they arrive."
      />

      <ReceiveDialog
        branchId={branchId}
        delivery={receiving}
        onOpenChange={(open) => !open && setReceiving(null)}
        actorId={profile?.id}
      />
    </div>
  )
}

function ReceiveDialog({
  branchId,
  delivery,
  onOpenChange,
}: {
  branchId: string
  delivery: BranchDelivery | null
  onOpenChange: (open: boolean) => void
  actorId?: string
}) {
  const receive = useReceiveDelivery(branchId || undefined)
  const [quantity, setQuantity] = React.useState('')
  const [reference, setReference] = React.useState('')

  // One key per receiving action, generated when the dialog opens and reused on
  // every retry. A double-click, a refresh mid-flight or a flaky connection
  // produces one receipt and one inventory movement.
  const [idempotencyKey, setIdempotencyKey] = React.useState('')

  React.useEffect(() => {
    if (delivery) {
      setQuantity(String(delivery.quantity_outstanding))
      setReference('')
      setIdempotencyKey(crypto.randomUUID())
    }
  }, [delivery])

  const amount = Number(quantity)
  const invalid =
    !delivery || !Number.isInteger(amount) || amount <= 0 || amount > delivery.quantity_outstanding

  return (
    <Dialog open={!!delivery} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm delivery</DialogTitle>
          <DialogDescription>
            {delivery?.product_name} · {delivery?.po_number}. Enter what actually arrived — a partial
            delivery is fine, and the rest stays outstanding.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Figure label="Ordered" value={delivery?.quantity_ordered ?? 0} />
            <Figure label="Already received" value={delivery?.quantity_received ?? 0} />
            <Figure label="Outstanding" value={delivery?.quantity_outstanding ?? 0} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="receive-quantity">Quantity received</Label>
            <Input
              id="receive-quantity"
              type="number"
              min="1"
              max={delivery?.quantity_outstanding}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              autoFocus
            />
            {delivery && amount > delivery.quantity_outstanding && (
              <p className="text-xs text-destructive">
                Only {delivery.quantity_outstanding} remain outstanding on this line.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="receive-reference">Delivery reference</Label>
            <Input
              id="receive-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Delivery receipt or waybill number"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Confirming this updates branch stock. The cost is taken from the approved purchase
            order — you are confirming quantity, not price.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={receive.isPending}>
            Cancel
          </Button>
          <Button
            disabled={invalid || receive.isPending}
            onClick={async () => {
              if (!delivery) return
              await receive.mutateAsync({
                purchaseOrderItemId: delivery.purchase_order_item_id,
                quantity: amount,
                deliveryReference: reference.trim() || null,
                idempotencyKey,
              })
              onOpenChange(false)
            }}
          >
            {receive.isPending ? 'Confirming…' : `Confirm ${amount || 0} received`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-display text-lg font-bold tabular-nums text-foreground">{value}</p>
    </div>
  )
}
