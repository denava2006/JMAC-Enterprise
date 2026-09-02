import * as React from 'react'
import { Trash2 } from 'lucide-react'
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
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/contexts/AuthContext'
import { formatMoney } from '@/lib/currency'
import { useBranches } from '@/hooks/useBranches'
import { usePosProducts } from '@/hooks/usePosCatalogue'
import {
  PO_STATUS_LABEL,
  usePurchaseOrderItems,
  usePurchaseOrderSources,
  usePurchaseOrders,
  useRemovePurchaseOrderItem,
  useSavePurchaseOrderItem,
  useTransitionPurchaseOrder,
} from '@/hooks/useProcurement'

const NONE = '__none__'

/** What this person may do to this order, mirroring transition_purchase_order. */
function actionsFor(role: string | undefined, status: string | undefined) {
  if (role === 'finance_staff') {
    if (status === 'draft' || status === 'returned') {
      return [
        { to: 'pending_approval', label: 'Submit for approval', tone: 'default' as const },
        { to: 'cancelled', label: 'Cancel order', tone: 'destructive' as const },
      ]
    }
    return []
  }
  if (role === 'finance_manager') {
    if (status === 'pending_approval') {
      return [
        { to: 'approved', label: 'Approve', tone: 'default' as const },
        { to: 'returned', label: 'Return for revision', tone: 'outline' as const },
        { to: 'rejected', label: 'Reject', tone: 'destructive' as const },
      ]
    }
    if (status === 'approved') {
      return [
        { to: 'closed', label: 'Close order', tone: 'outline' as const },
        { to: 'cancelled', label: 'Cancel order', tone: 'destructive' as const },
      ]
    }
    if (status === 'draft' || status === 'returned') {
      return [{ to: 'pending_approval', label: 'Submit for approval', tone: 'default' as const }]
    }
  }
  return []
}

export function PurchaseOrderDetail({
  orderId,
  onOpenChange,
}: {
  orderId: string | null
  onOpenChange: (open: boolean) => void
}) {
  const { profile } = useAuth()
  const { data: orders = [] } = usePurchaseOrders()
  const { data: items = [] } = usePurchaseOrderItems(orderId ?? undefined)
  const { data: sources = [] } = usePurchaseOrderSources(orderId ?? undefined)
  const transition = useTransitionPurchaseOrder()

  const order = orders.find((o) => o.id === orderId)
  const editable = order?.status === 'draft' || order?.status === 'returned'
  const actions = actionsFor(profile?.role, order?.status ?? undefined)

  return (
    <Dialog open={!!orderId} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {order?.po_number}
            <Badge variant={order?.status === 'approved' ? 'default' : 'secondary'}>
              {PO_STATUS_LABEL[order?.status ?? ''] ?? order?.status}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {order?.vendor_name ?? 'No vendor'} ·{' '}
            {order?.expected_delivery_date
              ? `expected ${order.expected_delivery_date}`
              : 'no expected date'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* What created this order. A link, not a copy. */}
          {sources.length > 0 && (
            <Card>
              <CardContent className="py-3">
                <p className="text-xs text-muted-foreground">Raised for</p>
                {sources.map((s) => (
                  <p key={s.id} className="text-sm text-foreground">
                    {s.finance_requests
                      ? `${s.finance_requests.request_no} — ${s.finance_requests.title}`
                      : s.pos_inventory_requests
                        ? `Branch stock request — ${s.pos_inventory_requests.product_name_snapshot ?? 'product'} × ${s.pos_inventory_requests.requested_quantity}`
                        : 'Unknown source'}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-semibold text-foreground">Lines</p>
              <p className="text-sm tabular-nums text-muted-foreground">
                {formatMoney(Number(order?.subtotal ?? 0))} · {order?.quantity_received ?? 0} of{' '}
                {order?.quantity_ordered ?? 0} received
              </p>
            </div>

            <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {items.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  No lines yet. An order with no lines orders nothing, and cannot be submitted.
                </p>
              ) : (
                items.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {item.description}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.quantity_ordered} {item.unit_of_measure} ×{' '}
                        {formatMoney(Number(item.unit_cost))}
                        {item.pos_products
                          ? ` · ${item.pos_products.name} → ${item.branches?.name ?? 'branch'}`
                          : ''}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                      {formatMoney(Number(item.line_total))}
                    </p>
                    {editable && <RemoveLine id={item.id} />}
                  </div>
                ))
              )}
            </div>
          </div>

          {editable && orderId && <AddLine orderId={orderId} />}

          {order?.status === 'approved' && (
            <Card>
              <CardContent className="py-3">
                <p className="text-xs text-muted-foreground">
                  Approved. Nothing has been received and no stock has moved — the destination
                  branch confirms the delivery, and that is what updates inventory.
                </p>
              </CardContent>
            </Card>
          )}

          {actions.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
              {actions.map((action) => (
                <Button
                  key={action.to}
                  variant={action.tone}
                  disabled={transition.isPending}
                  onClick={async () => {
                    if (!orderId) return
                    await transition.mutateAsync({ orderId, to: action.to })
                    if (['approved', 'rejected', 'cancelled', 'closed'].includes(action.to)) {
                      onOpenChange(false)
                    }
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RemoveLine({ id }: { id: string }) {
  const remove = useRemovePurchaseOrderItem()
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Remove line"
      disabled={remove.isPending}
      onClick={() => remove.mutate({ id })}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  )
}

function AddLine({ orderId }: { orderId: string }) {
  const save = useSavePurchaseOrderItem()
  const { data: branches } = useBranches()
  const { data: products } = usePosProducts()

  const [description, setDescription] = React.useState('')
  const [quantity, setQuantity] = React.useState('1')
  const [unitCost, setUnitCost] = React.useState('')
  const [productId, setProductId] = React.useState(NONE)
  const [branchId, setBranchId] = React.useState(NONE)

  // A line that replenishes POS stock needs both a product and somewhere to
  // send it; the database refuses one without the other.
  const posLinked = productId !== NONE
  const invalid =
    !description.trim() ||
    Number(quantity) <= 0 ||
    Number(unitCost) < 0 ||
    unitCost === '' ||
    (posLinked && branchId === NONE)

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <p className="text-sm font-semibold text-foreground">Add a line</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="line-description">Description</Label>
          <Input
            id="line-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="line-quantity">Quantity</Label>
          <Input
            id="line-quantity"
            type="number"
            min="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="line-cost">Unit cost</Label>
          <Input
            id="line-cost"
            type="number"
            step="0.01"
            min="0"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="line-product">POS product</Label>
          <Select
            value={productId}
            onValueChange={(v) => {
              setProductId(v)
              if (v === NONE) setBranchId(NONE)
            }}
          >
            <SelectTrigger id="line-product">
              <SelectValue placeholder="Not stock" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not POS stock</SelectItem>
              {(products ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="line-branch">
            Destination branch {posLinked && <span className="text-destructive">*</span>}
          </Label>
          <Select value={branchId} onValueChange={setBranchId} disabled={!posLinked}>
            <SelectTrigger id="line-branch">
              <SelectValue placeholder={posLinked ? 'Select branch' : '—'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {(branches ?? [])
                .filter((b) => b.is_active)
                .map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          variant="outline"
          disabled={invalid || save.isPending}
          onClick={async () => {
            await save.mutateAsync({
              purchase_order_id: orderId,
              description: description.trim(),
              quantity_ordered: Number(quantity),
              unit_cost: Number(unitCost),
              pos_product_id: posLinked ? productId : null,
              destination_branch_id: posLinked && branchId !== NONE ? branchId : null,
            })
            setDescription('')
            setQuantity('1')
            setUnitCost('')
            setProductId(NONE)
            setBranchId(NONE)
          }}
        >
          {save.isPending ? 'Adding…' : 'Add line'}
        </Button>
      </div>
    </div>
  )
}
