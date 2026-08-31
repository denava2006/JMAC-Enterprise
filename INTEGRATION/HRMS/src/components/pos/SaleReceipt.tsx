import type { Receipt } from '@/hooks/usePosTill'
import { saleMethodLabel } from '@/lib/posTill'
import { peso } from '@/lib/posTransactions'

/**
 * A receipt, rendered from the snapshots stored on the sale.
 *
 * Every value here was written at the moment of sale -- company, branch,
 * cashier, product names, prices, fees, totals. A reprint next year shows what
 * the customer was handed, not what those things happen to be called now.
 *
 * Shared by the till (immediately after payment) and transaction history (a
 * reprint) so the two can never drift. There is no cost on it, because
 * `checkout_pos_sale` and `get_sale_detail` do not return any.
 */
export function SaleReceipt({ receipt }: { receipt: Receipt }) {
  return (
    <div className="flex flex-col gap-3 print:text-black">
      <div className="text-center print:block">
        {receipt.company_name && (
          <p className="font-display text-base font-semibold text-foreground">{receipt.company_name}</p>
        )}
        <p className="text-sm text-foreground">{receipt.branch_name}</p>
        {receipt.branch_address && (
          <p className="text-xs text-muted-foreground">{receipt.branch_address}</p>
        )}
        {receipt.branch_phone && <p className="text-xs text-muted-foreground">{receipt.branch_phone}</p>}
      </div>

      <div className="flex flex-col gap-0.5 border-t border-border pt-2 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <span>Receipt</span>
          <span className="font-mono">{receipt.sale_id.slice(0, 8).toUpperCase()}</span>
        </div>
        <div className="flex justify-between">
          <span>Date</span>
          <span>{new Date(receipt.created_at).toLocaleString()}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-2">
        {receipt.items.map((item) => (
          <div key={item.product_name} className="flex justify-between text-sm">
            <span className="text-foreground">
              {item.product_name} <span className="text-muted-foreground">× {item.quantity}</span>
              <span className="ml-1 text-xs text-muted-foreground">@ {peso(item.unit_price)}</span>
            </span>
            <span className="tabular-nums text-foreground">{peso(item.line_total)}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
        <div className="flex justify-between text-muted-foreground">
          <span>Subtotal</span>
          <span className="tabular-nums">{peso(receipt.subtotal)}</span>
        </div>
        {receipt.fees.map((fee) => (
          <div key={fee.name} className="flex justify-between text-muted-foreground">
            <span>
              {fee.name} {fee.type === 'percent' ? `(${fee.value}%)` : ''}
            </span>
            <span className="tabular-nums">{peso(fee.amount)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-border pt-1 font-medium text-foreground">
          <span>Total</span>
          <span className="tabular-nums">{peso(receipt.total_amount)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-2 text-sm text-muted-foreground">
        <div className="flex justify-between">
          <span>Paid by</span>
          <span>{saleMethodLabel(receipt.payment_method)}</span>
        </div>
        {receipt.payment_reference && (
          <div className="flex justify-between">
            <span>Reference</span>
            <span className="tabular-nums">{receipt.payment_reference}</span>
          </div>
        )}
        {receipt.amount_tendered !== null && (
          <>
            <div className="flex justify-between">
              <span>Cash received</span>
              <span className="tabular-nums">{peso(receipt.amount_tendered)}</span>
            </div>
            <div className="flex justify-between font-medium text-foreground">
              <span>Change</span>
              <span className="tabular-nums">{peso(receipt.change_given ?? 0)}</span>
            </div>
          </>
        )}
        <div className="flex justify-between pt-1">
          <span>Served by</span>
          <span>{receipt.cashier_name}</span>
        </div>
      </div>
    </div>
  )
}
