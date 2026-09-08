import * as React from 'react'
import { Scale } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatMoney } from '@/lib/currency'
import { moneyOrBlank } from '@/lib/accounting'
import { useTrialBalance } from '@/hooks/useAccounting'

const TYPE_LABEL: Record<string, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expense',
}

/**
 * The trial balance.
 *
 * The two totals are equal or the ledger is broken; there is no third
 * possibility and no rounding tolerance, because every entry balanced on the
 * way in. The banner says which it is rather than leaving a reader to compare
 * two long numbers by eye.
 */
export default function TrialBalancePage() {
  const { data: rows = [], isLoading, isError } = useTrialBalance()

  const totals = React.useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          debit: acc.debit + Number(r.debit_balance ?? 0),
          credit: acc.credit + Number(r.credit_balance ?? 0),
        }),
        { debit: 0, credit: 0 },
      ),
    [rows],
  )
  const balanced = Math.round((totals.debit - totals.credit) * 100) === 0

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Trial Balance"
        description="Every account with posted activity, netted to the side it falls on."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Total debits"
          value={formatMoney(totals.debit)}
          icon={Scale}
          isLoading={isLoading}
          isError={isError}
        />
        <StatCard
          label="Total credits"
          value={formatMoney(totals.credit)}
          icon={Scale}
          isLoading={isLoading}
          isError={isError}
        />
        <StatCard
          label="Accounts with activity"
          value={rows.length}
          icon={Scale}
          isLoading={isLoading}
          isError={isError}
        />
      </div>

      {!isLoading && !isError && rows.length > 0 && (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm font-medium text-foreground">
              {balanced
                ? 'Debits equal credits.'
                : `Out of balance by ${formatMoney(Math.abs(totals.debit - totals.credit))}.`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {balanced
                ? 'As it must be — every entry is posted balanced, and none can be edited afterwards.'
                : 'This should be impossible. Raise it before relying on any figure in Accounting.'}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-4">
          {isError ? (
            <div className="py-8 text-center">
              <p className="font-medium text-foreground">The trial balance could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Nothing is shown rather than zeros, which would read as a real result.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 5 }).map((_, j) => (
                          <TableCell key={j}>
                            <Skeleton className="h-5 w-full max-w-32" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-28 text-center">
                        <p className="font-medium text-foreground">Nothing has been posted yet</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          The trial balance fills in as transactions complete.
                        </p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <>
                      {rows.map((row) => (
                        <TableRow key={row.account_id}>
                          <TableCell className="whitespace-nowrap text-sm tabular-nums">
                            {row.account_code ?? '—'}
                          </TableCell>
                          <TableCell className="font-medium text-foreground">
                            {row.account_name}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {TYPE_LABEL[row.account_type] ?? row.account_type}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {moneyOrBlank(row.debit_balance)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {moneyOrBlank(row.credit_balance)}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow>
                        <TableCell colSpan={3} className="font-medium text-foreground">
                          Total
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums text-foreground">
                          {formatMoney(totals.debit)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums text-foreground">
                          {formatMoney(totals.credit)}
                        </TableCell>
                      </TableRow>
                    </>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <p className="text-xs text-muted-foreground">
            This covers everything posted to date. There is no period close in JMAC, so there is no
            closed period for the trial balance to stop at.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
