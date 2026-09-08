import * as React from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Package,
  Printer,
  Receipt as ReceiptIcon,
  Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { SaleReceipt } from '@/components/pos/SaleReceipt'
import { PosSummaryCard } from '@/components/pos/PosSummaryCard'
import { usePosTransactions, useSaleDetail } from '@/hooks/usePosTransactions'
import {
  PAGE_SIZE,
  SALE_STATUS_LABEL,
  describeTransactionError,
  pageCount,
  paymentLabel,
  peso,
  summarise,
  totalFrom,
  type DateRange,
  type TransactionScope,
} from '@/lib/posTransactions'

/**
 * The transaction list, shared by the POS portal and the back office.
 *
 * One component because the three audiences differ only in which read path they
 * use and which columns are worth showing -- not in what a sale is. What each
 * may see is decided by the database, so this cannot widen anyone's scope by
 * rendering an extra column.
 *
 * No cost appears here, and none could: the RPCs behind it declare none.
 */

export interface BranchOption {
  id: string
  name: string
}

/**
 * The badge tone for a payment method.
 *
 * Cash is the one that settles at the till, so it gets the positive tone;
 * everything else is a provider settlement and stays neutral-blue. Deliberately
 * only two tones rather than one per method: a register whose every row is a
 * different colour is a chart, not a list, and the colour would be encoding
 * nothing a cashier needs to act on.
 *
 * Any method with no mapping falls through to `outline`, so a value stored
 * before this map existed still renders as a badge rather than as nothing.
 */
function paymentBadge(method: string): 'success' | 'secondary' | 'outline' {
  if (method === 'cash') return 'success'
  if (['gcash', 'maya', 'paymaya', 'card', 'qrph'].includes(method)) return 'secondary'
  return 'outline'
}

export function PosTransactionsView({
  scope,
  branches,
  branchId,
  onBranchChange,
  allowAllBranches = false,
  showCashier = true,
  showBranch = false,
  emptyMessage,
}: {
  scope: TransactionScope
  branches?: BranchOption[]
  branchId?: string
  onBranchChange?: (id: string) => void
  /** Admin only: an "every branch" option. */
  allowAllBranches?: boolean
  showCashier?: boolean
  showBranch?: boolean
  emptyMessage: string
}) {
  const [range, setRange] = React.useState<DateRange>({ from: '', to: '' })
  const [page, setPage] = React.useState(1)
  const [openSale, setOpenSale] = React.useState<string | null>(null)

  // A changed filter invalidates the page you were on.
  React.useEffect(() => {
    setPage(1)
  }, [range.from, range.to, branchId, scope])

  // "all" is the Select's own value for the every-branch option, not a branch
  // id; the RPC takes null for that.
  const queryBranchId = branchId === 'all' ? undefined : branchId

  const { data: rows, isLoading, isError, error } = usePosTransactions({
    scope,
    branchId: queryBranchId,
    range,
    page,
  })

  const list = rows ?? []
  const total = totalFrom(list)
  const pages = pageCount(total, PAGE_SIZE)
  const stats = summarise(list)

  const { data: receipt, isLoading: receiptLoading, isError: receiptError, error: receiptErr } =
    useSaleDetail(openSale)

  return (
    <div className="flex flex-col gap-4">
      {/* One bar on one surface, rather than three controls floating on the
          page background. Everything here already existed -- branch, from, to
          and clear; only the container is new. */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 px-4 py-3">
          {branches && branches.length > 0 && onBranchChange && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Branch</Label>
              <Select value={branchId ?? ''} onValueChange={onBranchChange}>
                <SelectTrigger className="h-10 w-52" aria-label="Branch">
                  <SelectValue placeholder="Choose a branch" />
                </SelectTrigger>
                <SelectContent>
                  {allowAllBranches && <SelectItem value="all">Every branch</SelectItem>}
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tx_from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="tx_from"
              type="date"
              className="h-10 w-40"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tx_to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="tx_to"
              type="date"
              className="h-10 w-40"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </div>
          {(range.from || range.to) && (
            <Button variant="ghost" className="h-10" onClick={() => setRange({ from: '', to: '' })}>
              Clear dates
            </Button>
          )}
        </CardContent>
      </Card>

      {isError ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            {describeTransactionError(error)}
          </CardContent>
        </Card>
      ) : isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* The same three figures, given room to be read at a glance. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <PosSummaryCard
              label="Sales on this page"
              value={stats.sales}
              hint={`of ${total} transaction${total === 1 ? '' : 's'}`}
              icon={ReceiptIcon}
            />
            <PosSummaryCard label="Items sold" value={stats.units} icon={Package} />
            <PosSummaryCard label="Total taken" value={peso(stats.taken)} icon={Wallet} />
          </div>

          {/* Scrolls sideways before it gives up a column: a register with the
              payment method hidden is not a register. */}
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>When</TableHead>
                    <TableHead>Receipt</TableHead>
                    {showBranch && <TableHead>Branch</TableHead>}
                    {showCashier && <TableHead>Cashier</TableHead>}
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((row) => {
                    const when = new Date(row.created_at)
                    return (
                      <TableRow key={row.sale_id} className="hover:bg-muted/40">
                        {/* Day over time. Scanning a register is looking for a
                            day first and an instant second, and one dense
                            timestamp makes both hard.
                            Both halves come from the same Date the single
                            timestamp used, so nothing about the timezone
                            changes -- only where the line breaks. */}
                        <TableCell className="whitespace-nowrap">
                          <span className="block text-sm font-medium text-foreground">
                            {when.toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </span>
                          <span className="block text-xs tabular-nums text-muted-foreground">
                            {when.toLocaleTimeString()}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {row.sale_id.slice(0, 8).toUpperCase()}
                        </TableCell>
                        {showBranch && (
                          <TableCell className="whitespace-nowrap text-sm">
                            {row.branch_name}
                          </TableCell>
                        )}
                        {showCashier && (
                          <TableCell className="whitespace-nowrap text-sm">
                            {row.cashier_name}
                          </TableCell>
                        )}
                        <TableCell className="text-right tabular-nums">{row.item_count}</TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start">
                            <Badge variant={paymentBadge(row.payment_method)}>
                              {paymentLabel(row.payment_method)}
                            </Badge>
                            {row.payment_reference && (
                              <span className="mt-1 font-mono text-[11px] text-muted-foreground">
                                {row.payment_reference}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        {/* The column the eye goes to. */}
                        <TableCell className="whitespace-nowrap text-right font-display text-[15px] font-bold tabular-nums text-foreground">
                          {peso(row.total_amount)}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end">
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={`Receipt for ${row.sale_id.slice(0, 8).toUpperCase()}`}
                              onClick={() => setOpenSale(row.sale_id)}
                            >
                              <ReceiptIcon className="h-4 w-4" />
                              Receipt
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            {pages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  Page {page} of {pages}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= pages}
                    onClick={() => setPage((p) => Math.min(pages, p + 1))}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      <Dialog open={!!openSale} onOpenChange={(open) => !open && setOpenSale(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Receipt</DialogTitle>
            <DialogDescription>
              Printed as it was on the day — from the sale's own snapshots, not today's prices.
            </DialogDescription>
          </DialogHeader>

          {receiptLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : receiptError ? (
            <p className="py-8 text-center text-sm text-destructive">
              {describeTransactionError(receiptErr)}
            </p>
          ) : receipt ? (
            <div id="printable-receipt">
              <SaleReceipt receipt={receipt} />
              <p className="mt-3 text-center text-xs text-muted-foreground">
                {SALE_STATUS_LABEL[receipt.status as 'completed'] ?? receipt.status}
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenSale(null)}>
              Close
            </Button>
            <Button disabled={!receipt} onClick={() => window.print()}>
              <Printer className="h-4 w-4" />
              Print
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
