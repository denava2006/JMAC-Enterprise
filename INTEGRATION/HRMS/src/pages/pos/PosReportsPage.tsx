import * as React from 'react'
import { Calculator, PackageCheck, Receipt, ShoppingBasket, Trophy, Wallet } from 'lucide-react'
import { ManagerBranchPicker, useManagerBranch } from '@/components/pos/ManagerBranchPicker'
import { PosReportRange } from '@/components/pos/PosReportRange'
import { ReportChartCard } from '@/components/reports/ReportChartCard'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  usePosManagerReportPaymentTotals,
  usePosManagerReportSummary,
  usePosManagerReportTopProducts,
  usePosManagerReportTrend,
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
  isPosReportRangeReady,
  posReportPaymentMethodLabel,
  type PosReportRange as PosReportRangeValue,
} from '@/lib/posReports'

function ReportFigure({
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
      {/* Sentence case, matching the dashboard. Six tracked-out uppercase
          labels in a grid give a reader no idea which figure matters, and this
          page has six. */}
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

function ReportPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function PanelLoading() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((item) => (
        <Skeleton key={item} className="h-10 w-full" />
      ))}
    </div>
  )
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
}

export default function PosReportsPage() {
  const { branchId, setBranchId, managed, isLoading: branchesLoading } = useManagerBranch()
  const presets = usePosReportPresets()
  const [range, setRange] = React.useState<PosReportRangeValue>()

  React.useEffect(() => {
    if (range || !presets.data) return
    const initial = defaultPosReportRange(presets.data)
    if (initial) setRange(initial)
  }, [presets.data, range])

  const summary = usePosManagerReportSummary(branchId || undefined, range)
  const trend = usePosManagerReportTrend(branchId || undefined, range)
  const payments = usePosManagerReportPaymentTotals(branchId || undefined, range)
  const topProducts = usePosManagerReportTopProducts(branchId || undefined, range)

  const branchName = managed.find((branch) => branch.id === branchId)?.name ?? ''
  const queryError =
    presets.error ?? summary.error ?? trend.error ?? payments.error ?? topProducts.error
  const reportsLoading = !range || summary.isLoading
  const stats = summary.data
  const hasSales = (stats?.transaction_count ?? 0) > 0

  if (!branchesLoading && managed.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          You do not manage a branch, so there are no branch reports to show.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="POS Reports"
        description={`Operational completed-sales reporting for ${branchName || 'your managed branch'}.`}
        action={
          <ManagerBranchPicker branchId={branchId} onChange={setBranchId} branches={managed} />
        }
      />

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
            This report is not available for the selected branch.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <ReportFigure
              label="Sales collected"
              value={formatPosReportMoney(stats?.sales_collected ?? 0)}
              hint="Total amount collected, including customer fees"
              icon={Wallet}
              loading={reportsLoading}
            />
            <ReportFigure
              label="Product sales"
              value={formatPosReportMoney(stats?.product_sales ?? 0)}
              hint="Historical product line totals before fees"
              icon={Receipt}
              loading={reportsLoading}
            />
            <ReportFigure
              label="Customer fees"
              value={formatPosReportMoney(stats?.fees_collected ?? 0)}
              hint="Fees customers paid on top of product sales"
              icon={Calculator}
              loading={reportsLoading}
            />
            <ReportFigure
              label="Transactions"
              value={formatPosReportCount(stats?.transaction_count ?? 0)}
              hint="Completed sales in the selected range"
              icon={Trophy}
              loading={reportsLoading}
            />
            <ReportFigure
              label="Items sold"
              value={formatPosReportCount(stats?.items_sold ?? 0)}
              hint="Units sold, not line-item rows"
              icon={PackageCheck}
              loading={reportsLoading}
            />
            <ReportFigure
              label="Average sale"
              value={formatNullablePosReportMoney(stats?.average_sale)}
              hint="Sales Collected divided by completed transactions"
              icon={ShoppingBasket}
              loading={reportsLoading}
            />
          </div>

          {!reportsLoading && !hasSales && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No completed sales were recorded for this branch in the selected range.
              </CardContent>
            </Card>
          )}

          {!range || trend.isLoading ? (
            <Skeleton className="h-80 w-full" />
          ) : (
            <ReportChartCard
              chart={{
                title: 'Daily Sales Collected',
                kind: 'line',
                data: hasSales
                  ? (trend.data ?? []).map((day) => ({
                      name: formatPosBusinessDateShort(day.business_date),
                      value: Number(day.sales_collected),
                    }))
                  : [],
              }}
            />
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <ReportPanel title="Payment Methods">
              {!range || payments.isLoading ? (
                <PanelLoading />
              ) : (payments.data ?? []).length === 0 ? (
                <EmptyPanel>No payment totals for the selected range.</EmptyPanel>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Method</TableHead>
                        <TableHead className="text-right">Transactions</TableHead>
                        <TableHead className="text-right">Amount Collected</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(payments.data ?? []).map((payment) => (
                        <TableRow key={payment.payment_method}>
                          <TableCell className="font-medium">
                            {posReportPaymentMethodLabel(payment.payment_method)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPosReportCount(payment.transaction_count)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPosReportMoney(payment.amount_collected)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Amount Collected is the sum of each completed sale's total amount.
                  </p>
                </div>
              )}
            </ReportPanel>

            <ReportPanel title="Top Products">
              {!range || topProducts.isLoading ? (
                <PanelLoading />
              ) : (topProducts.data ?? []).length === 0 ? (
                <EmptyPanel>No products sold in the selected range.</EmptyPanel>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Units</TableHead>
                        <TableHead className="text-right">Product Sales</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(topProducts.data ?? []).map((product, index) => (
                        <TableRow key={product.product_id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary">{index + 1}</Badge>
                              <span className="font-medium">{product.product_name}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPosReportCount(product.quantity_sold)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPosReportMoney(product.sales_amount)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Grouped by product ID and ranked using historical line totals. The displayed name is the
                    most recent sale snapshot in the range.
                  </p>
                </div>
              )}
            </ReportPanel>
          </div>
        </>
      )}
    </div>
  )
}
