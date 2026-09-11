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
import {
  blocksSubmission,
  describeMargin,
  formatMarginPercent,
  marginFor,
  peso,
  type MarginView,
} from '@/lib/procurementMargin'

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
/**
 * The selling price this purchase is judged against, and what the margin is.
 *
 * Read-only about the price, deliberately and structurally: there is no control
 * here to change it, because a branch selling price is the POS Manager's and
 * letting Finance edit it from the order they are trying to get approved would
 * make the check ceremonial. If the price is wrong, the price is what gets
 * reviewed -- in POS, by the people who own it.
 *
 * Restrained on purpose. Three states, one line of explanation each, and the
 * figures Finance is already thinking about. The blocking case is the only one
 * that raises its voice.
 */
function MarginPanel({
  view,
  sellingPrice,
  branchName,
  costEntered,
}: {
  view: MarginView
  sellingPrice: number | null
  branchName: string | null
  costEntered: boolean
}) {
  const message = describeMargin(view)
  const tone =
    view.verdict === 'negative' || view.verdict === 'no-price'
      ? 'border-destructive/40 bg-destructive/5'
      : view.verdict === 'zero'
        ? 'border-warning/40 bg-warning/10'
        : 'border-border bg-muted/40'

  return (
    <div className={`flex flex-col gap-2 rounded-lg border p-3 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">Current selling price</span>
          <span className="font-medium tabular-nums text-foreground">
            {sellingPrice === null || sellingPrice <= 0 ? '—' : peso(sellingPrice)}
          </span>
          {/* Which branch, and on which side of VAT. Both matter: the customer
              pays more than this, and another branch may charge something
              else entirely. */}
          <span className="text-[11px] text-muted-foreground">
            {branchName ?? 'Destination branch'} · before VAT
          </span>
        </div>

        {costEntered && view.verdict !== 'no-price' && (
          <>
            <Figure label="Gross margin / unit" value={peso(view.perUnit ?? 0)} />
            <Figure label="Gross margin" value={formatMarginPercent(view.percent)} />
          </>
        )}
      </div>

      {costEntered && view.verdict !== 'no-price' && (
        // Review only. Nothing here is persisted -- all three follow from
        // quantity, unit cost and the selling price, so storing them would only
        // create a second set of numbers to disagree with.
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border/60 pt-2">
          <Figure label="Order cost" value={peso(view.orderCost)} small />
          <Figure label="Potential retail value" value={peso(view.retailValue ?? 0)} small />
          <Figure label="Potential gross margin" value={peso(view.potentialMargin ?? 0)} small />
        </div>
      )}

      {message && (
        <p
          role={view.verdict === 'positive' ? undefined : 'alert'}
          className={
            view.verdict === 'zero'
              ? 'text-xs font-medium text-warning'
              : 'text-xs font-medium text-destructive'
          }
        >
          {message}
        </p>
      )}
    </div>
  )
}

function Figure({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className={small ? 'text-[11px] text-muted-foreground' : 'text-xs text-muted-foreground'}>
        {label}
      </span>
      <span className={`tabular-nums text-foreground ${small ? 'text-xs' : 'font-medium'}`}>
        {value}
      </span>
    </div>
  )
}

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

  // What the branch charges for this product, resolved server-side and handed
  // over with the rest of the request. Finance sees it; Finance does not set
  // it, and nothing here sends it back -- guard_purchase_order_margin reloads
  // the price itself, so a number typed into this browser could not change the
  // verdict even if it reached the RPC.
  const margin = marginFor(detail?.branch_selling_price ?? null, Number(unitCost || 0), Number(quantity || 0))
  const marginBlocks = isPosStock && unitCost !== '' && blocksSubmission(margin)

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

                <div className="sm:col-span-2">
                  <MarginPanel
                    view={margin}
                    sellingPrice={detail.branch_selling_price ?? null}
                    branchName={detail.branch_name}
                    costEntered={unitCost !== ''}
                  />
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
            {/* A draft is not a purchasing commitment, so an unresolved margin
                does not stop one being kept. The server agrees: the guard sits
                on the status transition, and a draft has not made one. */}
            <Button
              variant="outline"
              disabled={incomplete || build.isPending}
              onClick={() => void save(false)}
            >
              Save as draft
            </Button>
            <Button
              disabled={incomplete || marginBlocks || build.isPending}
              onClick={() => void save(true)}
            >
              {build.isPending ? 'Saving…' : 'Submit for approval'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
