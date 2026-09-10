import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { SaleReceipt } from '@/components/pos/SaleReceipt'
import type { Receipt } from '@/hooks/usePosTill'
import { SALE_STATUS_LABEL, describeTransactionError } from '@/lib/posTransactions'

/**
 * The receipt for a completed sale — the only one.
 *
 * Both places a receipt is looked at now render this: the till the instant a
 * sale is taken, and transaction history when it is reprinted months later.
 * They were separate before. SaleReceipt was written to be shared and said so
 * in its own comment, history adopted it, and the till kept a hand-written
 * summary alongside — which is how the till came to show no receipt number, no
 * branch address, no unit prices, no status, and no way to print.
 *
 * The receipt itself is read from the sale's stored snapshots, which is why a
 * reprint and the original agree: `checkout_pos_sale` and `get_sale_detail`
 * both return `pos_sale_receipt(sale_id)`, so the two entry points are the same
 * receipt from the same builder, not two readings of the same sale.
 *
 * Nothing here writes. Opening, printing and closing a receipt are read-only —
 * by the time this renders the sale is committed, stock has moved, and Finance
 * can already see it.
 */
export function PosReceiptDialog({
  open,
  onOpenChange,
  receipt,
  isLoading = false,
  isError = false,
  error,
  title = 'Receipt',
  description,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  receipt: Receipt | null | undefined
  /** History fetches by id; the till already holds the sale it just took. */
  isLoading?: boolean
  isError?: boolean
  error?: unknown
  /** "Sale complete" from the till, "Receipt" from history. The receipt below
   *  is identical either way — only the reason for looking at it differs. */
  title?: string
  description?: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isError ? (
          <p className="py-8 text-center text-sm text-destructive">
            {describeTransactionError(error)}
          </p>
        ) : receipt ? (
          // The id the print system targets. One element, so the till and
          // history print the same thing by construction.
          <div id="printable-receipt">
            <SaleReceipt receipt={receipt} />
            <p className="mt-3 text-center text-xs text-muted-foreground">
              {SALE_STATUS_LABEL[receipt.status as 'completed'] ?? receipt.status}
            </p>
          </div>
        ) : null}

        <DialogFooter className="print:hidden">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {/* Primary, because a cashier who has just taken money is reaching
              for this. Read-only: it hands the page to the browser and touches
              no sale. */}
          <Button disabled={!receipt} onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
