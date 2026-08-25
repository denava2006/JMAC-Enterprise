import * as React from 'react'
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
import { useBranches } from '@/hooks/useBranches'
import { useRequestQueue, useReviewRequest } from '@/hooks/usePosRequests'
import {
  REQUEST_STATUS_VARIANT,
  pageCount,
  requestStatusLabel,
  requestTypeLabel,
  totalFrom,
  type QueuedRequest,
} from '@/lib/posRequests'
import type { PosRequestStatus } from '@/lib/enums'

/**
 * The POS request review queue.
 *
 * Two different decisions arrive here, and only one of them is permanently
 * this desk's:
 *
 *   Start carrying   an enterprise catalogue and branch-carrying decision.
 *                    No money in it, and it belongs with Products and
 *                    Categories. This stays here.
 *
 *   Restock          ultimately a procurement decision -- what to buy, from
 *                    whom, against which budget. That belongs to FMS. The
 *                    Administrator reviews it TODAY only because FMS is not
 *                    integrated yet.
 *
 * Approving a restock says the branch demand is legitimate and may proceed to
 * procurement. It is not a budget approval, not a vendor selection, not a
 * purchase, and not a receipt of stock -- and it moves no inventory whatsoever.
 * The screen says so, because "approved" is easy to misread.
 */

const ANY = '__any__'

function ReviewDialog({
  request,
  onClose,
}: {
  request: QueuedRequest
  onClose: () => void
}) {
  const [note, setNote] = React.useState('')
  const review = useReviewRequest()
  const isRestock = request.request_type === 'restock'

  const act = (approve: boolean) =>
    review.mutate({ requestId: request.request_id, approve, note }, { onSuccess: onClose })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request.product_name}</DialogTitle>
          <DialogDescription>
            {requestTypeLabel(request.request_type)} for {request.branch_name}, asked for by{' '}
            {request.requester_name}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border p-3">
            {request.requested_quantity !== null && (
              <p className="text-sm font-medium text-foreground">
                {request.requested_quantity} units requested
              </p>
            )}
            <p className="text-sm text-muted-foreground">{request.reason}</p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              {isRestock
                ? 'Approving confirms the branch genuinely needs this, and clears it to proceed to procurement. It does not approve a budget, choose a supplier, place an order, or add any stock.'
                : 'Approving lets this branch carry the product. It is created switched off with no stock, so the manager decides when to offer it and a delivery still has to be received.'}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="review_note">
              Note {isRestock ? '(required to decline)' : '(required to decline)'}
            </Label>
            <Textarea
              id="review_note"
              value={note}
              maxLength={500}
              placeholder="Why this is or is not going ahead"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="destructive"
            disabled={review.isPending || !note.trim()}
            onClick={() => act(false)}
          >
            Decline
          </Button>
          <Button disabled={review.isPending} onClick={() => act(true)}>
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function AdminPosRequestsPage() {
  const { data: branches } = useBranches()
  const [branch, setBranch] = React.useState<string>(ANY)
  const [status, setStatus] = React.useState<string>('pending')
  const [page, setPage] = React.useState(1)
  const [reviewing, setReviewing] = React.useState<QueuedRequest | null>(null)

  const query = useRequestQueue(
    branch === ANY ? undefined : branch,
    status === ANY ? undefined : (status as PosRequestStatus),
    page
  )

  const options = React.useMemo(
    () => (branches ?? []).filter((b) => b.is_active).map((b) => ({ id: b.id, name: b.name })),
    [branches]
  )

  const rows = query.data ?? []
  const total = totalFrom(rows)
  const pages = pageCount(total)

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground">POS Requests</h2>
        <p className="text-sm text-muted-foreground">
          What branches have asked the business for.
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Approving a request records that the branch demand is legitimate. It does not approve a
          budget, choose a supplier, place an order, or change stock — quantity moves only when a
          delivery is received through Inventory. Restock demand will move to Finance once FMS is
          integrated.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 py-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="queue_branch">Branch</Label>
            <Select
              value={branch}
              onValueChange={(value) => {
                setBranch(value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-52" id="queue_branch" aria-label="Branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Every branch</SelectItem>
                {options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="queue_status">Status</Label>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-48" id="queue_status" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Awaiting review</SelectItem>
                <SelectItem value={ANY}>Any status</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="declined">Declined</SelectItem>
                <SelectItem value="cancelled">Withdrawn</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto text-xs text-muted-foreground">
            {total} {total === 1 ? 'request' : 'requests'} in total
          </div>
        </CardContent>
      </Card>

      {query.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Nothing is waiting for review.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Asking for</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.request_id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{row.product_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.requester_name} ·{' '}
                        {new Date(row.requested_at).toLocaleDateString('en-PH', {
                          timeZone: 'Asia/Manila',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </div>
                    </TableCell>
                    <TableCell>{row.branch_name}</TableCell>
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
                      {row.reviewer_name && (
                        <div className="text-xs text-muted-foreground">{row.reviewer_name}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* can_review comes from the database, computed with the
                          same predicate the write path uses -- so this button
                          cannot appear where the RPC would refuse. */}
                      {row.can_review && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setReviewing(row)}
                          aria-label={`Review ${row.product_name} for ${row.branch_name}`}
                        >
                          Review
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

      {reviewing && <ReviewDialog request={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  )
}
