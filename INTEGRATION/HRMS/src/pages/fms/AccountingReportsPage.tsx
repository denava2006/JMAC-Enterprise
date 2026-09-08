import * as React from 'react'
import { ArrowDownRight, ArrowUpRight, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatMoney } from '@/lib/currency'
import { netIncome, summarise, totalOf, type SummaryRow } from '@/lib/accounting'
import { useLedgerLines } from '@/hooks/useAccounting'

/**
 * The three reports F8 can honestly produce.
 *
 * All of them read the same posted lines the ledger reads, filtered by date.
 * None of them queries payments, payroll or sales — a report that went back to
 * the operational tables would be a second opinion about what was spent, and
 * the point of a ledger is that there is only one.
 */

function SummaryTable({
  rows,
  total,
  isLoading,
  emptyLine,
  totalLabel,
}: {
  rows: SummaryRow[]
  total: number
  isLoading: boolean
  emptyLine: string
  totalLabel: string
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead>Account</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 4 }).map((_, j) => (
                  <TableCell key={j}>
                    <Skeleton className="h-5 w-full max-w-32" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="h-24 text-center text-sm text-muted-foreground">
                {emptyLine}
              </TableCell>
            </TableRow>
          ) : (
            <>
              {rows.map((row) => (
                <TableRow key={row.account_id}>
                  <TableCell className="whitespace-nowrap text-sm tabular-nums">
                    {row.account_code ?? '—'}
                  </TableCell>
                  <TableCell className="font-medium text-foreground">{row.account_name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(row.amount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {total === 0 ? '—' : `${Math.round((row.amount / total) * 100)}%`}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell colSpan={2} className="font-medium text-foreground">
                  {totalLabel}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums text-foreground">
                  {formatMoney(total)}
                </TableCell>
                <TableCell />
              </TableRow>
            </>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export default function AccountingReportsPage() {
  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')

  const {
    data: lines = [],
    isLoading,
    isError,
  } = useLedgerLines({ from: from || undefined, to: to || undefined })

  const expenses = React.useMemo(() => summarise(lines, 'expense'), [lines])
  const revenue = React.useMemo(() => summarise(lines, 'revenue'), [lines])
  const totalExpense = totalOf(expenses)
  const totalRevenue = totalOf(revenue)
  const result = netIncome(totalRevenue, totalExpense)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Accounting Reports"
        description="Cash in, cash out and the difference — all of it derived from posted journal entries."
      />

      <Card>
        <CardContent className="grid gap-4 py-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="report-from">From</Label>
            <Input
              id="report-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="report-to">To</Label>
            <Input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Revenue received"
          value={formatMoney(totalRevenue)}
          icon={ArrowUpRight}
          isLoading={isLoading}
          isError={isError}
        />
        <StatCard
          label="Expenses paid"
          value={formatMoney(totalExpense)}
          icon={ArrowDownRight}
          isLoading={isLoading}
          isError={isError}
        />
        <StatCard
          label={result < 0 ? 'Net loss' : 'Net income'}
          value={formatMoney(Math.abs(result))}
          icon={Wallet}
          isLoading={isLoading}
          isError={isError}
        />
      </div>

      {isError ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-medium text-foreground">The reports could not be loaded</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No figures are shown. An unknown total is not zero.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="income">
          <TabsList>
            <TabsTrigger value="income">Income statement</TabsTrigger>
            <TabsTrigger value="expenses">Expense summary</TabsTrigger>
            <TabsTrigger value="revenue">Revenue summary</TabsTrigger>
          </TabsList>

          <TabsContent value="income">
            <Card>
              <CardContent className="flex flex-col gap-4 py-4">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Line</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-medium text-foreground">
                          Revenue received
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {isLoading ? (
                            <Skeleton className="ml-auto h-5 w-24" />
                          ) : (
                            formatMoney(totalRevenue)
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium text-foreground">Expenses paid</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {isLoading ? (
                            <Skeleton className="ml-auto h-5 w-24" />
                          ) : (
                            `(${formatMoney(totalExpense)})`
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium text-foreground">
                          {result < 0 ? 'Net loss' : 'Net income'}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums text-foreground">
                          {isLoading ? (
                            <Skeleton className="ml-auto h-5 w-24" />
                          ) : (
                            formatMoney(result)
                          )}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>

                {/* Said plainly, because a reader who takes this for a statutory
                    income statement will read things into it that are not here. */}
                <p className="text-xs text-muted-foreground">
                  Cash basis: revenue is counted when it was collected and settled, expenses when
                  they were paid. It excludes unpaid invoices and uncollected sales, and carries no
                  cost of sales, depreciation or tax — JMAC records none of those, and this report
                  will not imply figures the business has not produced.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="expenses">
            <Card>
              <CardContent className="py-4">
                <SummaryTable
                  rows={expenses}
                  total={totalExpense}
                  isLoading={isLoading}
                  totalLabel="Total expenses"
                  emptyLine="No expense has been paid in this range."
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="revenue">
            <Card>
              <CardContent className="py-4">
                <SummaryTable
                  rows={revenue}
                  total={totalRevenue}
                  isLoading={isLoading}
                  totalLabel="Total revenue"
                  emptyLine="No revenue has been settled in this range."
                />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
