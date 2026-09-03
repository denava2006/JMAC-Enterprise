import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/currency'
import type { InvoiceMatchRow } from '@/hooks/useSupplierInvoices'

/**
 * The three-way match, shown as three columns.
 *
 * What the company ordered, what the branch received, and what the supplier is
 * charging, side by side so a discrepancy is visible rather than described.
 * Nothing here is hidden or rounded away: an approver who cannot see the
 * difference cannot be said to have checked it.
 *
 * The verdicts come from the server. The approval guard reads the same
 * function, so this is a rendering of the decision rather than a second
 * opinion about it.
 */

export function matchSummary(rows: InvoiceMatchRow[]): {
  matched: boolean
  label: string
  tone: 'success' | 'destructive' | 'secondary'
} {
  if (rows.length === 0) {
    return { matched: false, label: 'No lines', tone: 'secondary' }
  }
  const quantity = rows.filter((r) => !r.quantity_matched).length
  const price = rows.filter((r) => r.price_matched === false).length

  if (quantity === 0 && price === 0) {
    return { matched: true, label: 'Matched', tone: 'success' }
  }
  if (quantity > 0 && price > 0) {
    return { matched: false, label: 'Quantity and price mismatch', tone: 'destructive' }
  }
  return {
    matched: false,
    label: quantity > 0 ? 'Quantity mismatch' : 'Price mismatch',
    tone: 'destructive',
  }
}

function Cell({ children, off = false }: { children: React.ReactNode; off?: boolean }) {
  return (
    <td className={`py-2 pr-4 text-right tabular-nums ${off ? 'font-semibold text-destructive' : ''}`}>
      {children}
    </td>
  )
}

export function InvoiceMatch({ rows }: { rows: InvoiceMatchRow[] }) {
  const summary = matchSummary(rows)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Three-way match</p>
        <Badge variant={summary.tone}>{summary.label}</Badge>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pl-3 pr-4 text-left font-medium">Item</th>
              <th className="py-2 pr-4 text-right font-medium">Ordered</th>
              <th className="py-2 pr-4 text-right font-medium">Received</th>
              <th className="py-2 pr-4 text-right font-medium">Billable</th>
              <th className="py-2 pr-4 text-right font-medium">Invoiced</th>
              <th className="py-2 pr-4 text-right font-medium">PO cost</th>
              <th className="py-2 pr-4 text-right font-medium">Invoice cost</th>
              <th className="py-2 pr-3 text-right font-medium">Line</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.line_id} className="border-b border-border last:border-0">
                <td className="py-2 pl-3 pr-4">
                  <p className="font-medium text-foreground">{row.description}</p>
                  {row.cancelled_quantity > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {row.cancelled_quantity} stopped, so not billable
                    </p>
                  )}
                  {row.previously_invoiced > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {row.previously_invoiced} already invoiced
                    </p>
                  )}
                </td>
                <Cell>{row.effective_quantity}</Cell>
                <Cell>{row.received_quantity}</Cell>
                <Cell>{row.billable_quantity}</Cell>
                <Cell off={!row.quantity_matched}>{row.invoice_quantity}</Cell>
                <Cell>{formatMoney(Number(row.po_unit_cost))}</Cell>
                <Cell off={!row.price_matched}>{formatMoney(Number(row.invoice_unit_cost))}</Cell>
                <td className="py-2 pr-3 text-right font-medium tabular-nums text-foreground">
                  {formatMoney(Number(row.invoice_line_value))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!summary.matched && rows.length > 0 && (
        <p className="text-xs text-destructive">
          {rows.some((r) => !r.quantity_matched)
            ? 'This invoice bills more than can still be charged for. Return it for correction.'
            : 'This invoice charges a different price from the one the purchase order agreed. Return it for correction.'}{' '}
          It cannot be approved while they disagree.
        </p>
      )}
    </div>
  )
}
