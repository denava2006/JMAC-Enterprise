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
import { ReasonDialog } from '@/components/fms/ReasonDialog'
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
  useCancelRemainder,
  useDiscardDraft,
} from '@/hooks/useProcurement'

const NONE = '__none__'

/**
 * The transitions that stop, return or refuse something.
 *
 * These take a reason -- the database refuses a blank one -- so the UI asks for
 * it first rather than letting the call fail. Approving and submitting are
 * absent on purpose: what an approval means is answered by the approval.
 */
const NEEDS_REASON = new Set(['returned', 'rejected', 'cancelled'])

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
    // Deliberately nothing for draft/returned. Submitting an order for
    // approval is the maker's act, and a checker who can submit is a checker
    // who can approve their own work -- which is the whole control this
    // separation exists to provide.
    return []
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
  const discardDraft = useDiscardDraft()
  const stopRemainder = useCancelRemainder()
  const [asking, setAsking] = React.useState<
    { kind: 'transition'; to: string; label: string } | { kind: 'discard' } | { kind: 'remainder' } | null
  >(null)

  const order = orders.find((o) => o.id === orderId)
  // Editing an order is the maker's work, so it takes BOTH an editable status
  // and the maker's role. This used to be status alone, which is how a Finance
  // Manager reviewing an order still saw the line editor and the delete icons:
  // the checker was being offered the maker's controls on the document they
  // were reviewing. The database refuses those writes, but a control that is
  // visible and then fails is worse than one that was never offered.
  const isMaker = profile?.role === 'finance_staff'
  const isChecker = profile?.role === 'finance_manager'
  const editable = isMaker && (order?.status === 'draft' || order?.status === 'returned')
  const actions = actionsFor(profile?.role, order?.status ?? undefined)

  // What has not arrived and has not been stopped.
  //
  // Counted over receivable lines only: a line for services or rent has no
  // delivery to wait for. Cancellation is per line and receipts are per order,
  // which is why the two halves come from different places -- only a line with
  // a POS product can be received at all, so the order's received count is
  // already the receivable total.
  const receivableOrdered = items.reduce(
    (sum, item) =>
      item.pos_product_id
        ? sum + (item.quantity_ordered ?? 0) - (item.quantity_cancelled ?? 0)
        : sum,
    0,
  )
  const outstanding = Math.max(receivableOrdered - Number(order?.quantity_received ?? 0), 0)

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

          {/* A draft somebody deliberately saved is a record, so abandoning it is
              a transition with a reason -- and the demand it was going to
              satisfy goes back into the procurement queue. */}
          {isMaker && (order?.status === 'draft' || order?.status === 'returned') && (
            <div className="flex justify-end border-t border-border pt-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={discardDraft.isPending}
                onClick={() => setAsking({ kind: 'discard' })}
              >
                Discard draft
              </Button>
            </div>
          )}

          {/* Ordered twenty, six arrived, the rest is not coming. Cancelling the
              order outright would claim the six never did. */}
          {isChecker && order?.status === 'approved' && outstanding > 0 && (
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                {outstanding} unit(s) still outstanding. Stopping them leaves everything already
                received on the branch's shelf.
              </p>
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={stopRemainder.isPending}
                  onClick={() => setAsking({ kind: 'remainder' })}
                >
                  Stop outstanding quantity
                </Button>
              </div>
            </div>
          )}

          <ReasonDialog
            open={!!asking}
            title={
              asking?.kind === 'discard'
                ? 'Discard this draft'
                : asking?.kind === 'remainder'
                  ? 'Stop the outstanding quantity'
                  : (asking?.label ?? 'Confirm')
            }
            description={
              asking?.kind === 'discard'
                ? 'The demand behind it goes back into the procurement queue, and the order number is not reused.'
                : asking?.kind === 'remainder'
                  ? `${outstanding} unit(s) will be recorded as stopped. Everything already received stays on the branch's shelf.`
                  : 'This is kept with the order and shown to whoever picks it up next.'
            }
            confirmLabel={
              asking?.kind === 'discard'
                ? 'Discard draft'
                : asking?.kind === 'remainder'
                  ? 'Stop outstanding'
                  : (asking?.label ?? 'Confirm')
            }
            destructive={asking?.kind !== 'remainder'}
            pending={transition.isPending || discardDraft.isPending || stopRemainder.isPending}
            onOpenChange={(open) => !open && setAsking(null)}
            onConfirm={async (reason) => {
              if (!orderId || !asking) return
              if (asking.kind === 'discard') {
                await discardDraft.mutateAsync({ id: orderId, reason })
              } else if (asking.kind === 'remainder') {
                await stopRemainder.mutateAsync({ id: orderId, reason })
              } else {
                await transition.mutateAsync({ orderId, to: asking.to, remarks: reason })
              }
              setAsking(null)
              onOpenChange(false)
            }}
          />

          {actions.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
              {actions.map((action) => (
                <Button
                  key={action.to}
                  variant={action.tone}
                  disabled={transition.isPending}
                  onClick={async () => {
                    if (!orderId) return
                    if (NEEDS_REASON.has(action.to)) {
                      setAsking({ kind: 'transition', to: action.to, label: action.label })
                      return
                    }
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
