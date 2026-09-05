import * as React from 'react'
import { businessTodayISODate } from '@/lib/dates'
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
import { formatMoney } from '@/lib/currency'
import {
  useCreateSupplierInvoice,
  useInvoiceablePurchaseOrders,
} from '@/hooks/useSupplierInvoices'
import { usePurchaseOrderItems } from '@/hooks/useProcurement'

/**
 * Recording what a supplier has billed.
 *
 * The purchase order supplies the vendor and the lines; the Accountant supplies
 * what only the supplier's document can say -- its number, its dates, and any
 * tax or charges on it. The vendor is shown and locked: an invoice for an order
 * bills that order's supplier, and letting somebody choose otherwise would let
 * one supplier's bill be matched against another's goods.
 *
 * Quantities and costs default to what the order agreed, because that is the
 * common case and retyping it is how a transcription error becomes a payment.
 * They stay editable, because the whole point of the match is to record what
 * the supplier actually charged -- including when it is wrong.
 */
export function SupplierInvoiceBuilder({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (invoiceId: string) => void
}) {
  const { data: orders = [] } = useInvoiceablePurchaseOrders()
  const create = useCreateSupplierInvoice()

  const [poId, setPoId] = React.useState('')
  const [number, setNumber] = React.useState('')
  const [invoiceDate, setInvoiceDate] = React.useState('')
  const [dueDate, setDueDate] = React.useState('')
  const [tax, setTax] = React.useState('0')
  const [charges, setCharges] = React.useState('0')
  const [chargesNote, setChargesNote] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [quantities, setQuantities] = React.useState<Record<string, string>>({})
  const [costs, setCosts] = React.useState<Record<string, string>>({})

  const { data: items = [] } = usePurchaseOrderItems(poId || undefined)
  const chosen = orders.find((o) => o.purchase_order_id === poId)

  React.useEffect(() => {
    if (!open) return
    setPoId('')
    setNumber('')
    setInvoiceDate(businessTodayISODate())
    setDueDate('')
    setTax('0')
    setCharges('0')
    setChargesNote('')
    setNotes('')
    setQuantities({})
    setCosts({})
  }, [open])

  // Seeded from the order, then the Accountant corrects whatever the supplier
  // actually billed.
  React.useEffect(() => {
    if (items.length === 0) return
    setQuantities(
      Object.fromEntries(
        items.map((i) => [i.id, String((i.quantity_ordered ?? 0) - (i.quantity_cancelled ?? 0))]),
      ),
    )
    setCosts(Object.fromEntries(items.map((i) => [i.id, String(i.unit_cost ?? 0)])))
  }, [items])

  const lines = items
    .map((i) => ({
      purchase_order_item_id: i.id,
      quantity: Number(quantities[i.id] ?? 0),
      unit_cost: Number(costs[i.id] ?? 0),
    }))
    .filter((l) => l.quantity > 0)

  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unit_cost, 0)
  const total = subtotal + Number(tax || 0) + Number(charges || 0)

  const incomplete =
    !poId ||
    !number.trim() ||
    !invoiceDate ||
    lines.length === 0 ||
    Number(tax || 0) < 0 ||
    Number(charges || 0) < 0 ||
    (Number(charges || 0) > 0 && !chargesNote.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record a supplier invoice</DialogTitle>
          <DialogDescription>
            Enter what the supplier billed. It is checked against the order and the receipts before
            a Finance Manager can approve it, and approving it pays nothing.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inv-po">
              Purchase order <span className="text-destructive">*</span>
            </Label>
            <Select value={poId} onValueChange={setPoId}>
              <SelectTrigger id="inv-po">
                <SelectValue placeholder="Which delivered order is this for?" />
              </SelectTrigger>
              <SelectContent>
                {orders.map((o) => (
                  <SelectItem key={o.purchase_order_id} value={o.purchase_order_id}>
                    {o.po_number} — {o.vendor_name} ·{' '}
                    {formatMoney(Number(o.outstanding_value))} uninvoiced
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {orders.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing to invoice. An order appears here once its goods have been received and
                some of their value has not been billed.
              </p>
            )}
          </div>

          {chosen && (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">Supplier</Badge>
                <span className="text-sm font-medium text-foreground">{chosen.vendor_name}</span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Taken from {chosen.po_number} and not editable — an invoice bills the supplier its
                purchase order names.
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-number">
                Supplier invoice no. <span className="text-destructive">*</span>
              </Label>
              <Input
                id="inv-number"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder="SI-93842"
              />
              <p className="text-xs text-muted-foreground">As printed on their document.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-date">
                Invoice date <span className="text-destructive">*</span>
              </Label>
              <Input
                id="inv-date"
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-due">Due date</Label>
              <Input
                id="inv-due"
                type="date"
                value={dueDate}
                min={invoiceDate || undefined}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          {items.length > 0 && (
            <div className="flex flex-col gap-2">
              <Label>What is being charged</Label>
              <p className="text-xs text-muted-foreground">
                Seeded from the order. Change them to whatever the supplier actually billed — a
                difference is meant to show up in the match, not to be smoothed over here.
              </p>
              {items.map((item) => (
                <div key={item.id} className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{item.description}</p>
                    <p className="text-xs text-muted-foreground">
                      Order: {(item.quantity_ordered ?? 0) - (item.quantity_cancelled ?? 0)} ×{' '}
                      {formatMoney(Number(item.unit_cost))}
                    </p>
                  </div>
                  <div className="w-20">
                    <Label htmlFor={`q-${item.id}`} className="text-xs">
                      Qty
                    </Label>
                    <Input
                      id={`q-${item.id}`}
                      type="number"
                      min={0}
                      value={quantities[item.id] ?? ''}
                      onChange={(e) =>
                        setQuantities((prev) => ({ ...prev, [item.id]: e.target.value }))
                      }
                    />
                  </div>
                  <div className="w-28">
                    <Label htmlFor={`c-${item.id}`} className="text-xs">
                      Unit cost
                    </Label>
                    <Input
                      id={`c-${item.id}`}
                      type="number"
                      min={0}
                      step="0.01"
                      value={costs[item.id] ?? ''}
                      onChange={(e) => setCosts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-tax">Tax</Label>
              <Input
                id="inv-tax"
                type="number"
                min={0}
                step="0.01"
                value={tax}
                onChange={(e) => setTax(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inv-charges">Other charges</Label>
              <Input
                id="inv-charges"
                type="number"
                min={0}
                step="0.01"
                value={charges}
                onChange={(e) => setCharges(e.target.value)}
              />
            </div>
            {Number(charges || 0) > 0 && (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="inv-charges-note">
                  What are those charges for? <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="inv-charges-note"
                  value={chargesNote}
                  onChange={(e) => setChargesNote(e.target.value)}
                  placeholder="Delivery to Cavite Branch"
                />
                <p className="text-xs text-muted-foreground">
                  An unexplained amount is the one an approver cannot check.
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="inv-notes">Notes</Label>
            <Textarea
              id="inv-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {lines.length > 0 && (
            <div className="rounded-lg border border-border p-3 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatMoney(subtotal)}</span>
              </div>
              <div className="mt-2 flex justify-between font-semibold text-foreground">
                <span>Invoice total</span>
                <span className="tabular-nums">{formatMoney(total)}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                The server totals it again from the lines; this is a preview.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            disabled={incomplete || create.isPending}
            onClick={async () => {
              const id = await create.mutateAsync({
                purchaseOrderId: poId,
                supplierInvoiceNumber: number.trim(),
                invoiceDate,
                dueDate: dueDate || null,
                lines,
                taxAmount: Number(tax || 0),
                otherCharges: Number(charges || 0),
                otherChargesNote: chargesNote.trim() || null,
                notes: notes.trim() || null,
              })
              if (id) onCreated(id)
            }}
          >
            {create.isPending ? 'Recording…' : 'Save as draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
