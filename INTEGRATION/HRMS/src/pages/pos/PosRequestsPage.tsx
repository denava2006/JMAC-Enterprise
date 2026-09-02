import * as React from 'react'
import { Link } from 'react-router-dom'
import { Info } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ManagerBranchPicker, useManagerBranch } from '@/components/pos/ManagerBranchPicker'
import { PosInventoryHeader } from '@/components/pos/PosInventoryHeader'
import { useAuth } from '@/contexts/AuthContext'
import { REQUEST_PROGRESS_LABEL, useBranchRequestProgress } from '@/hooks/useProcurement'
import { useBranchInventory } from '@/hooks/usePosInventory'
import {
  useCancelRequest,
  useCreateStockRequest,
  useManagerRequests,
} from '@/hooks/usePosRequests'
import {
  POS_REQUEST_MAX_REASON,
  REQUEST_STATUS_VARIANT,
  approvalMeaning,
  isCancellable,
  pageCount,
  requestStatusLabel,
  requestTypeLabel,
  totalFrom,
  validateRequest,
  type ManagerRequest,
} from '@/lib/posRequests'
import type { PosRequestType } from '@/lib/enums'

/**
 * What a POS Manager asks the business for.
 *
 * A request is a demand signal, and nothing more. Submitting one moves no
 * stock; approving one moves no stock either. Quantity changes only when
 * somebody receives a delivery through Inventory, which is a separate,
 * Administrator-controlled action.
 *
 * The page says so in as many words, because "approved" is the word most
 * likely to be misread as "it is on its way".
 */

const ANY = '__any__'

function NewRequestDialog({
  branchId,
  onClose,
}: {
  branchId: string
  onClose: () => void
}) {
  // Always a restock now. The type stays in the payload and in history -- the
  // engine, the approval flow and every existing record are untouched -- but a
  // manager no longer has to choose between three kinds of asking.
  const type: PosRequestType = 'restock'
  const [productId, setProductId] = React.useState('')
  const [quantity, setQuantity] = React.useState('')
  const [reason, setReason] = React.useState('')

  const { data: carried } = useBranchInventory(branchId)
  const createStock = useCreateStockRequest()

  // What this branch already carries. Asking for stock of something it does
  // not sell is not a request anybody can fulfil -- that is a Products
  // decision, and it is made there.
  const options = React.useMemo(
    () => (carried ?? []).map((row) => ({ id: row.product_id, name: row.product_name })),
    [carried]
  )

  const activeCarried = (carried ?? []).filter((r) => r.product_status === 'active').length

  // Why the list is empty matters. A manager staring at an empty dropdown needs
  // to know the next move is in Products, not that something is broken.
  const emptyReason =
    activeCarried === 0
      ? 'This branch does not carry any active product yet. Add one in Products first.'
      : null

  const error = validateRequest({ type, quantity, reason })
  const pending = createStock.isPending
  const canSubmit = !!productId && !error && !pending

  const submit = () => {
    if (!canSubmit) return
    // One kind of request: units of something this branch already sells.
    // Approval still moves no stock -- receiving does.
    createStock.mutate(
      { branchId, productId, quantity: Number(quantity), reason: reason.trim() },
      { onSuccess: onClose }
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New stock request</DialogTitle>
          <DialogDescription>
            Tell the business what this branch needs. Submitting a request does not order or
            receive anything.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request_product">Request stock</Label>
            <p className="text-xs text-muted-foreground">
              For products this branch already carries. To start selling something new, add it
              in <Link to="/pos/products" className="font-medium text-secondary underline-offset-2 hover:underline">Products</Link>.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request_product">Product</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger id="request_product" aria-label="Product">
                <SelectValue placeholder="Choose a product" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {options.length === 0 && emptyReason && (
              <p className="text-xs text-muted-foreground">{emptyReason}</p>
            )}
          </div>

          {type === 'restock' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="request_quantity">How many units?</Label>
              <Input
                id="request_quantity"
                type="number"
                min={1}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request_reason">Why?</Label>
            <Textarea
              id="request_reason"
              value={reason}
              maxLength={POS_REQUEST_MAX_REASON}
              placeholder="Running low before the weekend rush"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          {error && reason.length > 0 && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function PosRequestsPage() {
  const { profile } = useAuth()
  const { branchId, setBranchId, managed, isLoading: branchesLoading } = useManagerBranch()
  // What procurement did with these, read from the orders themselves.
  const { data: progress = [] } = useBranchRequestProgress(branchId || undefined)

  const [status, setStatus] = React.useState<string>(ANY)
  const progressByRequest = React.useMemo(
    () => new Map(progress.map((row) => [row.request_id, row])),
    [progress],
  )
  const [page, setPage] = React.useState(1)
  const [composing, setComposing] = React.useState(false)

  const query = useManagerRequests(
    branchId || undefined,
    status === ANY ? undefined : (status as ManagerRequest['status']),
    page
  )
  const cancel = useCancelRequest()

  const rows = query.data ?? []
  const total = totalFrom(rows)
  const pages = pageCount(total)

  if (!branchesLoading && managed.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Stock requests are for the branch you manage. What your branch sells is set in
          Products.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PosInventoryHeader
        description="Ask for more units of what this branch already sells."
        branchId={branchId}
        onNewRequest={() => setComposing(true)}
        newRequestDisabled={!branchId}
        branchPicker={
          <ManagerBranchPicker
            branchId={branchId}
            onChange={(id) => {
              setBranchId(id)
              setPage(1)
            }}
            branches={managed}
          />
        }
      />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          A request tells the business what this branch needs. It does not order anything, and an
          approval does not mean stock is on its way — quantity changes only when a delivery is
          received.
        </p>
      </div>

      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="request_status">Status</Label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value)
              setPage(1)
            }}
          >
            <SelectTrigger className="w-48" id="request_status" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any status</SelectItem>
              <SelectItem value="pending">Awaiting review</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="declined">Declined</SelectItem>
              <SelectItem value="cancelled">Withdrawn</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          {total} {total === 1 ? 'request' : 'requests'} in total
        </div>
      </div>

      {query.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            This branch has not asked for anything yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Asking for</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.request_id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{row.product_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(row.requested_at).toLocaleDateString('en-PH', {
                          timeZone: 'Asia/Manila',
                          month: 'short',
                          day: 'numeric',
                        })}{' '}
                        · {row.requester_name}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div>{requestTypeLabel(row.request_type)}</div>
                      {row.requested_quantity !== null && (
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {row.requested_quantity} units
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground">
                      {row.reason}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          REQUEST_STATUS_VARIANT[row.status] as 'success' | 'warning' | 'destructive' | 'secondary'
                        }
                      >
                        {requestStatusLabel(row.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-72">
                      {row.status === 'approved' && (
                        <p className="text-xs text-muted-foreground">
                          {approvalMeaning(row.request_type)}
                        </p>
                      )}
                      {row.review_note && (
                        <p className="text-xs text-foreground">{row.review_note}</p>
                      )}
                      {row.reviewer_name && (
                        <p className="text-xs text-muted-foreground">
                          Reviewed by {row.reviewer_name}
                        </p>
                      )}
                      {(() => {
                        // Where procurement has got to. Quantities only: what
                        // was ordered and what has arrived. Never the cost, and
                        // never which supplier -- those are procurement's
                        // judgement and are not in the function that feeds this.
                        const p = progressByRequest.get(row.request_id)
                        if (!p?.progress) return null
                        return (
                          <div className="mt-1 flex flex-col gap-0.5">
                            <p className="text-xs font-medium text-foreground">
                              {REQUEST_PROGRESS_LABEL[p.progress] ?? p.progress}
                              {p.po_number ? ` · ${p.po_number}` : ''}
                            </p>
                            {p.quantity_ordered !== null && (
                              <p className="text-xs text-muted-foreground tabular-nums">
                                {p.quantity_received ?? 0} of {p.quantity_ordered} received
                              </p>
                            )}
                          </div>
                        )
                      })()}
                    </TableCell>
                    <TableCell className="text-right">
                      {isCancellable(row, profile?.id) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={cancel.isPending}
                          onClick={() => cancel.mutate(row.request_id)}
                        >
                          Withdraw
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {composing && branchId && (
        <NewRequestDialog branchId={branchId} onClose={() => setComposing(false)} />
      )}
    </div>
  )
}
