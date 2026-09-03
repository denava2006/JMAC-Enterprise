import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Banknote, Coins, Info, Receipt, TrendingUp, Wallet } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { PosReportRange } from '@/components/pos/PosReportRange'
import { defaultPosReportRange, type PosReportRange as ReportRange } from '@/lib/posReports'
import {
  FINANCE_SALES_METHODS,
  FINANCE_SALES_PAGE_SIZE,
  NOT_MODELLED_NOTE,
  SETTLEMENT_DISCLOSURE,
  cashCollected,
  describeFinanceSalesError,
  financeSalesMethodLabel,
  formatFinanceSalesCount,
  formatFinanceSalesMoney,
  providerCollected,
  saleReference,
  formatSaleTimestamp,
  type FinanceSalesFilters,
  type FinanceSalesTransaction,
} from '@/lib/financeSales'
import {
  useFinanceSalesCollections,
  useFinanceSalesFilterOptions,
  useFinanceSalesPresets,
  useFinanceSalesSummary,
  useFinanceSalesTransactions,
} from '@/hooks/useFinanceSales'

const ALL = '__all__'

/**
 * Sales & Collections: what POS earned, read by Finance.
 *
 * Read-only, and not incidentally so. There is no action on this page because
 * a sale belongs to the POS that recorded it -- Finance reconciles it, and a
 * correction has to start where the transaction did. That is why there is no
 * New button, no row menu, and no editable cell anywhere below.
 *
 * The page reuses the POS report range picker rather than growing its own.
 * "Today" is a Philippine business day resolved in the database, and a Finance
 * user opening this from another timezone sees the same day the branch did.
 *
 * Two figures here are structurally zero, and are shown anyway. Discounts and
 * refunds are things this POS cannot record, and a page that silently omitted
 * them would let a reader assume the answer was measured.
 */
export default function FinanceSalesPage() {
  const presets = useFinanceSalesPresets()
  const [range, setRange] = React.useState<ReportRange | undefined>()
  const [branchId, setBranchId] = React.useState<string>(ALL)
  const [method, setMethod] = React.useState<string>(ALL)
  const [cashierId, setCashierId] = React.useState<string>(ALL)
  const [page, setPage] = React.useState(0)

  React.useEffect(() => {
    if (range || !presets.data) return
    setRange(defaultPosReportRange(presets.data))
  }, [presets.data, range])

  const filters: FinanceSalesFilters = {
    dateFrom: range?.dateFrom ?? '',
    dateTo: range?.dateTo ?? '',
    branchId: branchId === ALL ? null : branchId,
    paymentMethod: method === ALL ? null : method,
    cashierId: cashierId === ALL ? null : cashierId,
  }

  const summary = useFinanceSalesSummary(filters)
  const collections = useFinanceSalesCollections(filters)
  const transactions = useFinanceSalesTransactions(filters, page)
  const options = useFinanceSalesFilterOptions(filters.dateFrom, filters.dateTo)

  // Any change of what is being asked for starts the list again. Staying on
  // page 4 of a narrower result is how a reader concludes there is no data.
  React.useEffect(() => setPage(0), [branchId, method, cashierId, range?.dateFrom, range?.dateTo])

  const branches = (options.data ?? []).filter((o) => o.kind === 'branch')
  const cashiers = (options.data ?? []).filter((o) => o.kind === 'cashier')
  const rows = transactions.data ?? []
  const totalRows = Number(rows[0]?.total_rows ?? 0)
  const pageCount = Math.max(1, Math.ceil(totalRows / FINANCE_SALES_PAGE_SIZE))

  const error =
    presets.error ?? summary.error ?? collections.error ?? transactions.error ?? options.error
  const loading = summary.isLoading || presets.isLoading

  const collectionRows = collections.data ?? []
  const inDrawer = cashCollected(collectionRows)
  const withProvider = providerCollected(collectionRows)

  const columns = React.useMemo<ColumnDef<FinanceSalesTransaction>[]>(
    () => [
      {
        accessorKey: 'sold_at',
        header: 'Date',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm text-muted-foreground">
            {formatSaleTimestamp(row.original.sold_at)}
          </span>
        ),
      },
      {
        id: 'reference',
        header: 'Receipt',
        cell: ({ row }) => (
          <span className="font-mono text-xs text-foreground">{saleReference(row.original)}</span>
        ),
      },
      {
        accessorKey: 'branch_name',
        header: 'Branch',
        cell: ({ row }) => <span className="text-sm">{row.original.branch_name}</span>,
      },
      {
        accessorKey: 'cashier_name',
        header: 'Cashier',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">{row.original.cashier_name}</span>
        ),
      },
      {
        accessorKey: 'payment_method',
        header: 'Method',
        cell: ({ row }) => (
          <Badge variant="secondary" className="font-normal">
            {financeSalesMethodLabel(row.original.payment_method)}
          </Badge>
        ),
      },
      {
        accessorKey: 'net_sales',
        header: () => <div className="text-right">Net</div>,
        cell: ({ row }) => (
          <div className="text-right font-medium tabular-nums">
            {formatFinanceSalesMoney(row.original.net_sales)}
          </div>
        ),
      },
      {
        accessorKey: 'total_collected',
        header: () => <div className="text-right">Collected</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {formatFinanceSalesMoney(row.original.total_collected)}
          </div>
        ),
      },
    ],
    []
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales & Collections"
        description="Completed POS sales, read by Finance. The POS owns every transaction here."
      />

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-sm text-destructive">
            {describeFinanceSalesError(error)}
          </CardContent>
        </Card>
      )}

      <PosReportRange
        presets={presets.data ?? []}
        value={range}
        onChange={setRange}
        isLoading={presets.isLoading}
        summaryNoun="completed POS sales"
      />

      <Card>
        <CardContent className="grid gap-4 py-5 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="sales-branch">Branch</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger id="sales-branch">
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sales-method">Payment method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger id="sales-method">
                <SelectValue placeholder="All methods" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All methods</SelectItem>
                {FINANCE_SALES_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {financeSalesMethodLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sales-cashier">Cashier</Label>
            <Select value={cashierId} onValueChange={setCashierId}>
              <SelectTrigger id="sales-cashier">
                <SelectValue placeholder="All cashiers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All cashiers</SelectItem>
                {cashiers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Gross Sales"
          value={formatFinanceSalesMoney(summary.data?.gross_sales)}
          icon={TrendingUp}
          isLoading={loading}
          index={0}
        />
        <StatCard
          label="Discounts"
          value={formatFinanceSalesMoney(summary.data?.discounts)}
          icon={Coins}
          isLoading={loading}
          index={1}
        />
        <StatCard
          label="Refunds"
          value={formatFinanceSalesMoney(summary.data?.refunds)}
          icon={Receipt}
          isLoading={loading}
          index={2}
        />
        <StatCard
          label="Net Sales"
          value={formatFinanceSalesMoney(summary.data?.net_sales)}
          icon={Banknote}
          isLoading={loading}
          index={3}
        />
      </div>

      {/* Said plainly, next to the two figures it explains. */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{NOT_MODELLED_NOTE}</p>
      </div>

      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-display text-base font-semibold text-foreground">Collections</h3>
            <p className="text-sm text-muted-foreground">
              {formatFinanceSalesCount(summary.data?.transaction_count)} sales ·{' '}
              {formatFinanceSalesCount(summary.data?.items_sold)} items ·{' '}
              <span className="font-medium text-foreground">
                {formatFinanceSalesMoney(summary.data?.total_collected)}
              </span>{' '}
              collected
            </p>
          </div>

          {collections.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : collectionRows.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No completed sales in the selected range.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {collectionRows.map((row) => (
                  <li
                    key={row.payment_method}
                    className="flex items-center justify-between gap-4 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Wallet className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate text-sm font-medium text-foreground">
                        {financeSalesMethodLabel(row.payment_method)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatFinanceSalesCount(row.transaction_count)}&nbsp;sales
                      </span>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
                      {formatFinanceSalesMoney(row.amount_collected)}
                    </span>
                  </li>
                ))}
              </ul>

              {/* Where the money currently is, which is not the same question
                  as how the customer paid. */}
              <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Cash in branch
                  </p>
                  <p className="text-lg font-semibold tabular-nums text-foreground">
                    {formatFinanceSalesMoney(inDrawer)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Held by payment provider
                  </p>
                  <p className="text-lg font-semibold tabular-nums text-foreground">
                    {formatFinanceSalesMoney(withProvider)}
                  </p>
                </div>
              </div>
            </>
          )}

          <div className="flex items-start gap-2 border-t border-border pt-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">{SETTLEMENT_DISCLOSURE}</p>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h3 className="font-display text-base font-semibold text-foreground">Transactions</h3>
        <DataTable
          columns={columns}
          data={rows}
          isLoading={transactions.isLoading}
          searchPlaceholder="Search by branch, cashier or receipt…"
          emptyTitle="No sales to show"
          emptyDescription="No completed POS sales match the selected range and filters."
          density="compact"
        />
        {pageCount > 1 && (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Page {page + 1} of {pageCount} · {formatFinanceSalesCount(totalRows)} sales
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
