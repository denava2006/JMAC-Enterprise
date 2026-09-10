import * as React from 'react'
import {
  Calculator,
  CircleDollarSign,
  PackageCheck,
  Percent,
  Receipt,
  ShoppingBasket,
  Trophy,
  Wallet,
} from 'lucide-react'
import { PosReportRange } from '@/components/pos/PosReportRange'
import { ReportChartCard } from '@/components/reports/ReportChartCard'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useBranches } from '@/hooks/useBranches'
import {
  useAdminPosBranchComparison,
  useAdminPosReportSummary,
  useAdminPosReportTrend,
  usePosReportPresets,
} from '@/hooks/usePosReports'
import {
  defaultPosReportRange,
  describePosReportError,
  formatNullablePosReportMoney,
  formatPosBusinessDate,
  formatPosBusinessDateShort,
  formatPosReportCount,
  formatPosReportMoney,
  formatPosReportPercent,
  isPosReportRangeReady,
  type PosReportRange as PosReportRangeValue,
} from '@/lib/posReports'

const ALL_BRANCHES = 'all'

function FinancialFigure({
  label,
  value,
  hint,
  icon: Icon,
  loading,
}: {
  label: string
  value: string
  hint: string
  icon: React.ComponentType<{ className?: string }>
  loading: boolean
}) {
  return (
    <Card>
      {/* Matches the manager's POS Reports figure exactly. This is the same
          module seen by another role, so the two must not drift -- and they
          would have, because the sentence-case pass landed on the manager's
          copy first. */}
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Icon className="h-4 w-4" aria-hidden="true" />
          {label}
        </div>
        {loading ? (
          <Skeleton className="mt-1 h-7 w-24" />
        ) : (
          <div className="font-display text-xl font-bold tabular-nums text-foreground">{value}</div>
        )}
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}

export default function AdminPosReportsPage() {
  const { data: branches, isLoading: branchesLoading } = useBranches()
  const presets = usePosReportPresets()
  const [branchSelection, setBranchSelection] = React.useState(ALL_BRANCHES)
  const [range, setRange] = React.useState<PosReportRangeValue>()

  React.useEffect(() => {
    if (range || !presets.data) return
    const initial = defaultPosReportRange(presets.data)
    if (initial) setRange(initial)
  }, [presets.data, range])

  const branchId = branchSelection === ALL_BRANCHES ? undefined : branchSelection
  const summary = useAdminPosReportSummary(branchId, range)
  const trend = useAdminPosReportTrend(branchId, range)
  const comparison = useAdminPosBranchComparison(range)
  const stats = summary.data
  const reportsLoading = !range || summary.isLoading
  const queryError = presets.error ?? summary.error ?? trend.error ?? comparison.error
  const selectedBranchName =
    branchSelection === ALL_BRANCHES
      ? 'all branches'
      : branches?.find((branch) => branch.id === branchSelection)?.name ?? 'the selected branch'

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">POS Reports</h2>
          <p className="text-sm text-muted-foreground">
            Administrator financial reporting for {selectedBranchName}.
          </p>
        </div>
        {branchesLoading ? (
          <Skeleton className="h-10 w-56" />
        ) : (
          <Select value={branchSelection} onValueChange={setBranchSelection}>
            <SelectTrigger className="w-56" aria-label="Report branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_BRANCHES}>All branches</SelectItem>
              {(branches ?? []).map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}{branch.is_active ? '' : ' (inactive)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <PosReportRange
        presets={presets.data ?? []}
        value={range}
        onChange={setRange}
        isLoading={presets.isLoading}
      />

      {stats && (
        <p className="text-xs text-muted-foreground">
          Database report period: {formatPosBusinessDate(stats.date_from)} to{' '}
          {formatPosBusinessDate(stats.date_to)}.
        </p>
      )}

      {queryError ? (
        <Card>
          <CardContent role="alert" className="py-10 text-center text-sm text-destructive">
            {describePosReportError(queryError)}
          </CardContent>
        </Card>
      ) : isPosReportRangeReady(range) && !summary.isLoading && !stats ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Administrator POS reporting is not available for this account.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <FinancialFigure
              label="Sales collected"
              value={formatPosReportMoney(stats?.sales_collected ?? 0)}
              hint="Product Sales plus Customer Fees"
              icon={Wallet}
              loading={reportsLoading}
            />
            <FinancialFigure
              label="Product sales"
              value={formatPosReportMoney(stats?.product_sales ?? 0)}
              hint="Historical product line totals before fees"
              icon={Receipt}
              loading={reportsLoading}
            />
            <FinancialFigure
              label="Customer fees"
              value={formatPosReportMoney(stats?.fees_collected ?? 0)}
              hint="Customer-paid fees, reported separately"
              icon={Calculator}
              loading={reportsLoading}
            />
            <FinancialFigure
              label="COGS"
              value={formatPosReportMoney(stats?.total_cogs ?? 0)}
              hint="Historical cost of the products sold"
              icon={CircleDollarSign}
              loading={reportsLoading}
            />
            <FinancialFigure
              label="Gross product profit"
              value={formatPosReportMoney(stats?.gross_product_profit ?? 0)}
              hint="Product Sales minus COGS"
              icon={CircleDollarSign}
              loading={reportsLoading}
            />
            <FinancialFigure
              label="Gross product margin %"
              value={formatPosReportPercent(stats?.gross_product_margin)}
              hint="Gross Product Profit divided by Product Sales"
              icon={Percent}
              loading={reportsLoading}
            />
            <FinancialFigure
              label="Transactions"
              value={formatPosReportCount(stats?.transaction_count ?? 0)}
              hint="Completed sales in the selected range"
              icon={Trophy}
              loading={reportsLoading}
            />
            <FinancialFigure
              label="Items sold"
              value={formatPosReportCount(stats?.items_sold ?? 0)}
              hint="Units sold, not line-item rows"
              icon={PackageCheck}
              loading={reportsLoading}
            />
            <FinancialFigure
              label="Average sale"
              value={formatNullablePosReportMoney(stats?.average_sale)}
              hint="Sales Collected divided by completed transactions"
              icon={ShoppingBasket}
              loading={reportsLoading}
            />
          </div>

          <Card>
            <CardContent className="py-4 text-xs text-muted-foreground">
              Gross Product Margin % = ((Product Sales - COGS) / Product Sales) &times; 100. It is
              shown as {'\u2014'} when Product Sales is zero. Customer Fees are not product margin.
            </CardContent>
          </Card>

          {!reportsLoading && (stats?.transaction_count ?? 0) === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No completed sales were recorded for {selectedBranchName} in the selected range.
              </CardContent>
            </Card>
          )}

          {!range || trend.isLoading ? (
            <div className="grid gap-4 xl:grid-cols-3">
              {[0, 1, 2].map((item) => (
                <Skeleton key={item} className="h-80 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-3">
              <ReportChartCard
                chart={{
                  title: 'Daily Product Sales',
                  kind: 'line',
                  data: (trend.data ?? []).map((day) => ({
                    name: formatPosBusinessDateShort(day.business_date),
                    value: Number(day.product_sales),
                  })),
                }}
              />
              <ReportChartCard
                chart={{
                  title: 'Daily COGS',
                  kind: 'line',
                  data: (trend.data ?? []).map((day) => ({
                    name: formatPosBusinessDateShort(day.business_date),
                    value: Number(day.total_cogs),
                  })),
                }}
              />
              <ReportChartCard
                chart={{
                  title: 'Daily Gross Product Profit',
                  kind: 'line',
                  data: (trend.data ?? []).map((day) => ({
                    name: formatPosBusinessDateShort(day.business_date),
                    value: Number(day.gross_product_profit),
                  })),
                }}
              />
            </div>
          )}

          <Card>
            <CardContent className="pt-6">
              <div className="mb-4">
                <h3 className="font-display text-base font-semibold text-foreground">
                  Branch Comparison
                </h3>
                <p className="text-xs text-muted-foreground">
                  Enterprise comparison for the selected range, aggregated by branch ID.
                </p>
              </div>
              {!range || comparison.isLoading ? (
                <div className="flex flex-col gap-2">
                  {[0, 1, 2].map((item) => (
                    <Skeleton key={item} className="h-11 w-full" />
                  ))}
                </div>
              ) : (comparison.data ?? []).length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  There are no branches to compare.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Branch</TableHead>
                        <TableHead className="text-right">Sales Collected</TableHead>
                        <TableHead className="text-right">Product Sales</TableHead>
                        <TableHead className="text-right">COGS</TableHead>
                        <TableHead className="text-right">Gross Product Profit</TableHead>
                        <TableHead className="text-right">Gross Product Margin %</TableHead>
                        <TableHead className="text-right">Transactions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(comparison.data ?? []).map((branch) => (
                        <TableRow key={branch.branch_id}>
                          <TableCell>
                            <div className="flex items-center gap-2 font-medium">
                              {branch.branch_name}
                              {!branch.branch_is_active && <Badge variant="muted">Inactive</Badge>}
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPosReportMoney(branch.sales_collected)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPosReportMoney(branch.product_sales)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPosReportMoney(branch.total_cogs)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPosReportMoney(branch.gross_product_profit)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPosReportPercent(branch.gross_product_margin)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPosReportCount(branch.transaction_count)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
