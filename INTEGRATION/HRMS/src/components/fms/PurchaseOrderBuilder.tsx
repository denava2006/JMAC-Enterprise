import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
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
import { useVendors, useBudgets } from '@/hooks/useFinanceMasterData'
import { formatMoney } from '@/lib/currency'
import {
  useProcurementSource,
  useBuildPurchaseOrder,
  type ProcurementSourceRef,
} from '@/hooks/useProcurement'

/**
 * Build a purchase order from a piece of demand.
 *
 * Two things this replaces, both found in the hosted walkthrough.
 *
 * It used to write a numbered purchase order to the database the moment it
 * opened, so closing the dialog left a zero-line order behind for ever. Now
 * nothing exists until Save as draft or Submit, and either creates the order,
 * its source link and its lines in one server call -- so a failure halfway
 * costs a retry rather than leaving half an order.
 *
 * And it used to make Finance rebuild, by hand, facts the request already
 * held: which product, which branch, how many. The POS product dropdown it
 * offered was fed by a table Finance cannot read, so its only option was
 * "Not POS stock" and every line was saved with no product and no destination
 * -- which is why an approved order for twenty bottles never reached the
 * branch's Deliveries. Those fields are inherited from the source now, shown
 * and locked, and the server takes them from the request rather than from
 * anything this form sends.
 */
type GeneralLine = { description: string; quantity: string; unitCost: string }

const EMPTY_LINE: GeneralLine = { description: '', quantity: '1', unitCost: '' }

export function PurchaseOrderBuilder({
  source,
  onOpenChange,
  onCreated,
}: {
  source: ProcurementSourceRef | null
  onOpenChange: (open: boolean) => void
  onCreated: (orderId: string) => void
}) {
  const { data: vendors = [] } = useVendors()
  const { data: budgets = [] } = useBudgets()
  const { data: detail, isLoading, error } = useProcurementSource(source)
  const build = useBuildPurchaseOrder()

  const [vendorId, setVendorId] = React.useState('')
  const [budgetId, setBudgetId] = React.useState('')
  const [expected, setExpected] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [quantity, setQuantity] = React.useState('')
  const [unitCost, setUnitCost] = React.useState('')
  const [lines, setLines] = React.useState<GeneralLine[]>([{ ...EMPTY_LINE }])

  const isPosStock = source?.kind === 'pos_restock'

  React.useEffect(() => {
    if (!source) return
    setVendorId('')
    setBudgetId('')
    setExpected('')
    setNotes('')
    setUnitCost('')
    setLines([{ ...EMPTY_LINE }])
  }, [source])

  // The quantity starts at what is still outstanding, never at 1. A branch
  // asking for twenty and being ordered one is the kind of default that gets
  // noticed three deliveries later.
  React.useEffect(() => {
    if (detail?.outstanding != null) setQuantity(String(detail.outstanding))
  }, [detail?.outstanding])

  const selectableVendors = vendors.filter(
    (v) => v.is_active && v.approval_status === 'approved',
  )

  // Only ceilings actually in force. A draft budget has not been approved by
  // anybody, and the server refuses one -- offering it would just be a failed
  // save. The remaining figure shown beside each is a preview: the authoritative
  // check happens under a row lock at approval, so what is affordable now may
  // not be by then.
  const selectableBudgets = budgets.filter((b) => b.status === 'active')
  const chosenBudget = selectableBudgets.find((b) => b.id === budgetId)

  const posTotal = Number(quantity || 0) * Number(unitCost || 0)
  const generalTotal = lines.reduce(
    (sum, l) => sum + Number(l.quantity || 0) * Number(l.unitCost || 0),
    0,
  )

  const posIncomplete =
    !vendorId ||
    !budgetId ||
    !quantity ||
    Number(quantity) <= 0 ||
    unitCost === '' ||
    Number(unitCost) < 0
  const generalIncomplete =
    !vendorId ||
    lines.length === 0 ||
    lines.some(
      (l) => !l.description.trim() || Number(l.quantity) <= 0 || l.unitCost === '' || Number(l.unitCost) < 0,
    )
  const incomplete = isPosStock ? posIncomplete : generalIncomplete

  async function save(submit: boolean) {
    if (!source) return
    const result = await build.mutateAsync({
      source,
      vendorId,
      expectedDelivery: expected || null,
      notes: notes.trim() || null,
      budgetId: isPosStock ? budgetId : null,
      quantity: isPosStock ? Number(quantity) : null,
      unitCost: isPosStock ? Number(unitCost) : null,
      lines: isPosStock
        ? null
        : lines.map((l) => ({
            description: l.description.trim(),
            quantity: Number(l.quantity),
            unit_cost: Number(l.unitCost),
          })),
      submit,
    })
    if (result?.id) {
      onOpenChange(false)
      onCreated(result.id)
    }
  }

  return (
    <Dialog open={!!source} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New purchase order</DialogTitle>
          <DialogDescription>
            Nothing is saved until you choose below. Approval commits the company to buying;
            stock changes only when the branch confirms a delivery.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Reading the request…</p>}

        {error && (
          <p className="text-sm text-destructive">
            That demand could not be read: {(error as Error).message}
          </p>
        )}

        {detail && (
          <div className="flex flex-col gap-4">
            {/* What the request already answered. Shown rather than asked. */}
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Badge variant="secondary">
                  {isPosStock ? 'POS stock request' : 'Employee purchase'}
                </Badge>
                <span className="text-xs text-muted-foreground">{detail.reference}</span>
              </div>
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                {isPosStock && (
                  <>
                    <div>
                      <dt className="text-xs text-muted-foreground">Product</dt>
                      <dd className="font-medium text-foreground">{detail.product_name}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Destination</dt>
                      <dd className="font-medium text-foreground">{detail.branch_name}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Requested</dt>
                      <dd className="tabular-nums text-foreground">
                        {detail.requested_quantity}
                        {(detail.ordered_quantity ?? 0) > 0 && (
                          <span className="text-muted-foreground">
                            {' '}
                            · {detail.ordered_quantity} already ordered
                          </span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Still to order</dt>
                      <dd className="font-medium tabular-nums text-foreground">
                        {detail.outstanding}
                      </dd>
                    </div>
                  </>
                )}
                {!isPosStock && (
                  <>
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-muted-foreground">Request</dt>
                      <dd className="font-medium text-foreground">{detail.title}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Raised by</dt>
                      <dd className="text-foreground">{detail.requested_by_name}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Deliver to</dt>
                      <dd className="text-foreground">
                        {detail.branch_name ?? 'No branch recorded on the request'}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              {isPosStock && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Product and destination come from the branch's request and cannot be changed
                  here — an order that names a different product is one the branch can never
                  receive.
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="po-vendor">
                  Vendor <span className="text-destructive">*</span>
                </Label>
                <Select value={vendorId} onValueChange={setVendorId}>
                  <SelectTrigger id="po-vendor">
                    <SelectValue placeholder="Select a supplier" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectableVendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectableVendors.length === 0 && (
                  <p className="text-xs text-warning">
                    No approved vendors yet. A vendor has to be added under Vendors and approved
                    by a Finance Manager before an order can be raised against it.
                  </p>
                )}
              </div>

              {/* POS stock only. A general purchase reserved its money when the
                  request was approved, so charging the order to a budget again
                  would commit the same pesos twice -- the server refuses it. */}
              {isPosStock && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="po-budget">
                    Budget <span className="text-destructive">*</span>
                  </Label>
                  <Select value={budgetId} onValueChange={setBudgetId}>
                    <SelectTrigger id="po-budget">
                      <SelectValue placeholder="Charge this order to..." />
                    </SelectTrigger>
                    <SelectContent>
                      {selectableBudgets.map((b) => (
                        <SelectItem key={b.id!} value={b.id!}>
                          {b.name} — {formatMoney(Number(b.remaining ?? 0))} available
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectableBudgets.length === 0 && (
                    <p className="text-xs text-warning">
                      No active budget to charge this to. A Finance Manager approves a drafted
                      budget before it can fund an order.
                    </p>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="po-expected">Expected delivery</Label>
                <Input
                  id="po-expected"
                  type="date"
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                />
              </div>
            </div>

            {isPosStock ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="po-quantity">
                    Quantity to order <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="po-quantity"
                    type="number"
                    min={1}
                    max={detail.outstanding ?? undefined}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Up to {detail.outstanding} outstanding.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="po-cost">
                    Unit cost <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="po-cost"
                    type="number"
                    min={0}
                    step="0.01"
                    value={unitCost}
                    onChange={(e) => setUnitCost(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Total {formatMoney(posTotal)}. The branch never sees this.
                  </p>
                  {chosenBudget && posTotal > Number(chosenBudget.remaining ?? 0) && (
                    <p className="text-xs text-destructive">
                      That is more than {chosenBudget.name} has available (
                      {formatMoney(Number(chosenBudget.remaining ?? 0))}). Approval will be
                      refused.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Label>Items to buy</Label>
                <p className="text-xs text-muted-foreground">
                  A general request says what is needed, not what to buy. These lines are
                  procurement's judgement, and none of them touches POS stock.
                </p>
                {lines.map((line, index) => (
                  <div key={index} className="flex items-end gap-2">
                    <div className="flex-1">
                      <Label htmlFor={`line-desc-${index}`} className="text-xs">
                        Description
                      </Label>
                      <Input
                        id={`line-desc-${index}`}
                        value={line.description}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((l, i) =>
                              i === index ? { ...l, description: e.target.value } : l,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="w-20">
                      <Label htmlFor={`line-qty-${index}`} className="text-xs">
                        Qty
                      </Label>
                      <Input
                        id={`line-qty-${index}`}
                        type="number"
                        min={1}
                        value={line.quantity}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)),
                          )
                        }
                      />
                    </div>
                    <div className="w-28">
                      <Label htmlFor={`line-cost-${index}`} className="text-xs">
                        Unit cost
                      </Label>
                      <Input
                        id={`line-cost-${index}`}
                        type="number"
                        min={0}
                        step="0.01"
                        value={line.unitCost}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((l, i) => (i === index ? { ...l, unitCost: e.target.value } : l)),
                          )
                        }
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove item ${index + 1}`}
                      disabled={lines.length === 1}
                      onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <div className="flex items-center justify-between">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
                  >
                    <Plus className="h-4 w-4" />
                    Add item
                  </Button>
                  <span className="text-sm font-medium tabular-nums text-foreground">
                    {formatMoney(generalTotal)}
                  </span>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="po-notes">Notes</Label>
              <Textarea
                id="po-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {/* Cancel writes nothing at all -- there is no order yet to abandon,
              which is the point of the redesign. */}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={build.isPending}>
            Cancel
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={incomplete || build.isPending}
              onClick={() => void save(false)}
            >
              Save as draft
            </Button>
            <Button disabled={incomplete || build.isPending} onClick={() => void save(true)}>
              {build.isPending ? 'Saving…' : 'Submit for approval'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
