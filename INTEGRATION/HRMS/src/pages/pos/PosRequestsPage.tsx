import * as React from 'react'
import { Info } from 'lucide-react'
import { MoneyInput } from '@/components/MoneyInput'
import { usePosCategories } from '@/hooks/usePosCatalogue'
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
import { useBranchInventory } from '@/hooks/usePosInventory'
import {
  useCancelRequest,
  useCarryableProducts,
  useCreateCarryRequest,
  useCreateNewProductRequest,
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
  const [type, setType] = React.useState<PosRequestType>('restock')
  const [productId, setProductId] = React.useState('')
  const [quantity, setQuantity] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [name, setName] = React.useState('')
  const [categoryId, setCategoryId] = React.useState('')
  const [price, setPrice] = React.useState('')
  const [description, setDescription] = React.useState('')

  const { data: carried } = useBranchInventory(branchId)
  const { data: carryable } = useCarryableProducts(branchId, type === 'carry_existing_product')
  const { data: categories } = usePosCategories()
  const createStock = useCreateStockRequest()
  const createCarry = useCreateCarryRequest()
  const createProposal = useCreateNewProductRequest()

  // Restock is for what the branch already stocks; a carry request is for what
  // it does not. Offering the wrong list would only produce a refusal.
  const options = React.useMemo(() => {
    if (type === 'restock') {
      return (carried ?? []).map((row) => ({ id: row.product_id, name: row.product_name }))
    }
    return (carryable ?? []).map((row) => ({ id: row.product_id, name: row.product_name }))
  }, [type, carried, carryable])

  // Why the list is empty matters, and the three reasons are different
  // problems. Saying "this branch already carries every active product" when
  // the catalogue is simply empty sends a manager looking for a product that
  // was never there.
  //
  // carryable counts active products this branch does NOT carry, so:
  //   none carryable and none carried  -> the catalogue itself is empty
  //   none carryable and some carried  -> the branch really does carry them all
  const activeCarried = (carried ?? []).filter((r) => r.product_status === 'active').length
  const catalogueIsEmpty = (carryable ?? []).length === 0 && activeCarried === 0

  const emptyReason =
    type === 'restock'
      ? activeCarried === 0
        ? 'This branch does not carry any active product yet. Ask to carry one, or propose a new product.'
        : null
      : (carryable ?? []).length > 0
        ? null
        : catalogueIsEmpty
          ? 'There are no active products in the catalogue yet. Propose a new product to get started.'
          : 'This branch already carries every active product.'

  const proposalError =
    name.trim().length === 0
      ? 'Give the product a name.'
      : !categoryId
        ? 'Choose a category.'
        : !(Number(price) > 0)
          ? 'Suggest a selling price.'
          : reason.trim().length === 0
            ? 'Give a reason.'
            : null

  const error = type === 'new_product' ? proposalError : validateRequest({ type, quantity, reason })
  const pending = createStock.isPending || createCarry.isPending || createProposal.isPending
  const canSubmit = (type === 'new_product' ? true : !!productId) && !error && !pending

  const submit = () => {
    if (!canSubmit) return
    const done = { onSuccess: onClose }
    if (type === 'restock') {
      createStock.mutate(
        { branchId, productId, quantity: Number(quantity), reason: reason.trim() },
        done
      )
    } else if (type === 'new_product') {
      createProposal.mutate(
        {
          branchId,
          name: name.trim(),
          categoryId,
          sellingPrice: Number(price),
          reason: reason.trim(),
          description: description.trim() || null,
        },
        done
      )
    } else {
      createCarry.mutate({ branchId, productId, reason: reason.trim() }, done)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New request</DialogTitle>
          <DialogDescription>
            Tell the business what this branch needs. Submitting a request does not order or
            receive anything.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request_type">What are you asking for?</Label>
            <Select
              value={type}
              onValueChange={(value) => {
                setType(value as PosRequestType)
                setProductId('')
              }}
            >
              <SelectTrigger id="request_type" aria-label="What are you asking for?">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="restock">More of something we already sell</SelectItem>
                <SelectItem value="carry_existing_product">
                  Start carrying a product we do not stock
                </SelectItem>
                {/* Without this a brand-new branch is a dead end: nothing to
                    restock, and nothing in the catalogue to carry. */}
                <SelectItem value="new_product">Create a new product</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {type === 'new_product' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="proposal_name">Product name</Label>
                <Input
                  id="proposal_name"
                  value={name}
                  maxLength={200}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Coca-Cola 1.5L"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="proposal_category">Category</Label>
                <Select value={categoryId} onValueChange={setCategoryId}>
                  <SelectTrigger id="proposal_category" aria-label="Category">
                    <SelectValue placeholder="Choose a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {(categories ?? []).map((category: { id: string; name: string }) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="proposal_price">Suggested selling price</Label>
                <MoneyInput id="proposal_price" value={price} onValueChange={setPrice} placeholder="0.00" />
                {/* Suggested, not set. An Administrator decides the real price,
                    as they do for every other product. Cost is never asked for
                    here -- it enters through receiving. */}
                <p className="text-xs text-muted-foreground">
                  A suggestion. An Administrator sets the price that is charged.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="proposal_description">Description (optional)</Label>
                <Input
                  id="proposal_description"
                  value={description}
                  maxLength={500}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
            </>
          ) : (
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
          )}

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

  const [status, setStatus] = React.useState<string>(ANY)
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
          Requests are for the branch you manage. What your branch sells is shown on the POS
          screen.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PosInventoryHeader
        description="Manage branch stock and inventory requests."
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
