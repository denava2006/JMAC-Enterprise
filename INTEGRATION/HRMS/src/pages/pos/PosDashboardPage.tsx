import * as React from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Info, PackageX, Receipt, Trophy, Wallet } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ManagerBranchPicker, useManagerBranch } from '@/components/pos/ManagerBranchPicker'
import {
  useBusinessDay,
  useDashboardPaymentTotals,
  useDashboardRecentSales,
  useDashboardSummary,
  useDashboardTopProducts,
} from '@/hooks/usePosDashboard'
import {
  describeDashboardError,
  formatAverageSale,
  formatBusinessDate,
  paymentMethodLabel,
  peso,
} from '@/lib/posDashboard'

/**
 * The POS Manager's operational dashboard.
 *
 * Operational, and only operational. There is no cost, COGS, margin or profit
 * here -- not hidden behind a permission flag, but absent from the four RPC
 * signatures this page reads, so there is nothing on the wire to leak. The
 * standalone POS put "Today's Net Profit" on the manager's very first screen
 * and gated the whole query on `canViewProfit`; that is deliberately not
 * carried over.
 *
 * Two smaller inheritances are also corrected here. The standalone labelled
 * `subtotal` as "Net Sales" and never showed what the customer actually paid,
 * so a branch charging a fee under-reported its takings; this page shows Sales
 * Collected, Product Sales and Customer Fees, which reconcile. And it computed
 * "today" with `startOfDay(new Date())`, so the figures moved with the device
 * clock; the day here is resolved by `pos_day_bounds()` in Asia/Manila.
 */

function Figure({
  label,
  value,
  hint,
  icon: Icon,
  loading,
}: {
  label: string
  value: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  loading: boolean
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-5">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Icon className="h-4 w-4" />
          {label}
        </div>
        {loading ? (
          <Skeleton className="mt-1 h-8 w-28" />
        ) : (
          <div className="font-display text-2xl font-semibold tabular-nums text-foreground">
            {value}
          </div>
        )}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}

function Panel({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
)

export default function PosDashboardPage() {
  const { branchId, setBranchId, managed, isLoading: branchesLoading } = useManagerBranch()

  const { data: day } = useBusinessDay()
  const summary = useDashboardSummary(branchId || undefined)
  const payments = useDashboardPaymentTotals(branchId || undefined)
  const top = useDashboardTopProducts(branchId || undefined)
  const recent = useDashboardRecentSales(branchId || undefined, day?.day_start)

  const branchName = managed.find((b) => b.id === branchId)?.name ?? ''
  const stats = summary.data
  const loading = summary.isLoading

  if (!branchesLoading && managed.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          You do not manage a branch, so there is no dashboard to show.
        </CardContent>
      </Card>
    )
  }

  if (summary.isError) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-destructive">
          {describeDashboardError(summary.error)}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">
            {branchName || 'Dashboard'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {/* The day the SERVER used, not the device's idea of today. */}
            {day?.business_date
              ? `Trading today — ${formatBusinessDate(day.business_date)}`
              : 'Trading today'}
          </p>
        </div>
        <ManagerBranchPicker branchId={branchId} onChange={setBranchId} branches={managed} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Sales Collected"
          value={peso(stats?.sales_collected ?? 0)}
          hint="What the till took, fees included"
          icon={Wallet}
          loading={loading}
        />
        <Figure
          label="Product Sales"
          value={peso(stats?.product_sales ?? 0)}
          hint="What the goods came to"
          icon={Receipt}
          loading={loading}
        />
        <Figure
          label="Customer Fees"
          value={peso(stats?.fees_collected ?? 0)}
          hint="Paid by the customer on top"
          icon={Receipt}
          loading={loading}
        />
        <Figure
          label="Transactions"
          value={String(stats?.transaction_count ?? 0)}
          hint={`${stats?.items_sold ?? 0} items sold · ${formatAverageSale(
            stats?.average_sale
          )} average`}
          icon={Trophy}
          loading={loading}
        />
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Sales Collected = Product Sales + Customer Fees. These are operational figures for your
          branch; cost and profit are not part of this view.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Figure
          label="Low stock"
          value={String(stats?.low_stock_count ?? 0)}
          hint="Some left, but at or under the branch's low-stock level"
          icon={AlertTriangle}
          loading={loading}
        />
        <Figure
          label="Out of stock"
          value={String(stats?.out_of_stock_count ?? 0)}
          hint="Offered here, but nothing on hand"
          icon={PackageX}
          loading={loading}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Top sellers today" icon={Trophy}>
          {top.isLoading ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : (top.data ?? []).length === 0 ? (
            <Empty>Nothing has sold yet today.</Empty>
          ) : (
            <div className="flex flex-col gap-2">
              {(top.data ?? []).map((product, index) => (
                <div
                  key={product.product_id}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {product.product_name}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {peso(product.sales_amount)}
                  </span>
                  <Badge variant="secondary" className="tabular-nums">
                    {product.quantity_sold} sold
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="How today was paid" icon={Wallet}>
          {payments.isLoading ? (
            <div className="flex flex-col gap-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : (payments.data ?? []).length === 0 ? (
            <Empty>No payments taken yet today.</Empty>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                {(payments.data ?? []).map((row) => (
                  <div
                    key={row.payment_method}
                    className="flex items-center gap-3 rounded-lg border border-border p-3"
                  >
                    <span className="min-w-0 flex-1 text-sm font-medium">
                      {paymentMethodLabel(row.payment_method)}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {row.transaction_count}{' '}
                      {row.transaction_count === 1 ? 'sale' : 'sales'}
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {peso(row.amount_collected)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {/* A typed GCash or Maya number is what the cashier entered, not
                    money anyone has confirmed arrived. */}
                What customers paid with. An electronic reference recorded at the till is not a
                confirmation that the payment settled.
              </p>
            </>
          )}
        </Panel>
      </div>

      <Panel
        title="Recent sales"
        icon={Receipt}
        action={
          <Button variant="ghost" size="sm" asChild>
            <Link to="/pos/transactions">
              All transactions <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        }
      >
        {recent.isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : (recent.data ?? []).length === 0 ? (
          <Empty>No sales have been rung up yet today.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Cashier</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recent.data ?? []).map((sale) => (
                  <TableRow key={sale.sale_id}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(sale.created_at).toLocaleTimeString('en-PH', {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </TableCell>
                    {/* The sale's own receipt number, so a manager reading
                        this list and a customer holding the paper are looking
                        at the same reference. */}
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {sale.receipt_number}
                    </TableCell>
                    <TableCell>{sale.cashier_name}</TableCell>
                    <TableCell className="tabular-nums">{sale.item_count}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {peso(Number(sale.total_amount))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </div>
  )
}
