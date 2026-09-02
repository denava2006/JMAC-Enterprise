import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { useVendors } from '@/hooks/useFinanceMasterData'
import { useCreatePurchaseOrder } from '@/hooks/useProcurement'

/**
 * Raise an order against a piece of approved demand.
 *
 * The demand is linked, not copied: the request keeps its own record and its
 * own lifecycle, and the order records what created it. Lines are added on the
 * order itself, because what to buy is procurement's judgement rather than a
 * transcription of the request.
 */
export function NewPurchaseOrderDialog({
  source,
  onOpenChange,
  onCreated,
}: {
  source: { financeRequestId?: string; posInventoryRequestId?: string; label: string } | null
  onOpenChange: (open: boolean) => void
  onCreated: (orderId: string) => void
}) {
  const { data: vendors = [] } = useVendors()
  const create = useCreatePurchaseOrder()

  const [vendorId, setVendorId] = React.useState('')
  const [expected, setExpected] = React.useState('')
  const [notes, setNotes] = React.useState('')

  React.useEffect(() => {
    if (source) {
      setVendorId('')
      setExpected('')
      setNotes('')
    }
  }, [source])

  const activeVendors = vendors.filter((v) => v.is_active)

  return (
    <Dialog open={!!source} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New purchase order</DialogTitle>
          <DialogDescription>
            For {source?.label}. The order is drafted now and takes its lines next; nothing is
            committed until a Finance Manager approves it, and nothing arrives until a branch
            confirms delivery.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="po-vendor">
              Vendor <span className="text-destructive">*</span>
            </Label>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger id="po-vendor">
                <SelectValue placeholder="Select a supplier" />
              </SelectTrigger>
              <SelectContent>
                {activeVendors.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeVendors.length === 0 && (
              <p className="text-xs text-warning">
                No active vendors yet. Add one under Vendors before raising an order.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="po-expected">Expected delivery</Label>
            <Input
              id="po-expected"
              type="date"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="po-notes">Notes</Label>
            <Textarea id="po-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!vendorId || create.isPending}
            onClick={async () => {
              const id = await create.mutateAsync({
                order: {
                  vendor_id: vendorId,
                  order_date: new Date().toISOString().slice(0, 10),
                  expected_delivery_date: expected || null,
                  notes: notes.trim() || null,
                },
                source: {
                  financeRequestId: source?.financeRequestId,
                  posInventoryRequestId: source?.posInventoryRequestId,
                },
              })
              if (id) onCreated(id)
            }}
          >
            {create.isPending ? 'Creating…' : 'Create draft order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
