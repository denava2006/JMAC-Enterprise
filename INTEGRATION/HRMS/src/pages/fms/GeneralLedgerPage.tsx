import * as React from 'react'
import { Link } from 'react-router-dom'
import { BookMarked } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCalendarDate } from '@/lib/dates'
import { formatMoney } from '@/lib/currency'
import { moneyOrBlank, runningBalance, sourceLabel, type AccountType } from '@/lib/accounting'
import { useLedgerLines } from '@/hooks/useAccounting'
import { useFinanceAccounts } from '@/hooks/useFinanceMasterData'

/**
 * The general ledger: one account at a time, oldest entry first.
 *
 * An account has to be chosen before anything is shown. A ledger is a story
 * about one account, and a running balance down a mixed list of every account
 * would be a column of meaningless numbers.
 */
export default function GeneralLedgerPage() {
  const { data: accounts = [], isLoading: accountsLoading } = useFinanceAccounts()
  const [accountId, setAccountId] = React.useState('')
  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')

  const account = accounts.find((a) => a.id === accountId)
  const {
    data: lines = [],
    isLoading,
    isError,
  } = useLedgerLines(
    { accountId, from: from || undefined, to: to || undefined },
    !!accountId,
  )

  const accountType = (account?.account_type ?? 'asset') as AccountType
  const balances = React.useMemo(
    () => runningBalance(lines, accountType),
    [lines, accountType],
  )
  const closing = balances.length ? balances[balances.length - 1] : 0

  const sortedAccounts = React.useMemo(
    () =>
      [...accounts].sort((a, b) =>
        (a.account_code ?? '~').localeCompare(b.account_code ?? '~'),
      ),
    [accounts],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="General Ledger"
        description="Every posted line against one account, in the order it happened."
      />

      <Card>
        <CardContent className="grid gap-4 py-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ledger-account">Account</Label>
            <Select value={accountId} onValueChange={setAccountId} disabled={accountsLoading}>
              <SelectTrigger id="ledger-account">
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {sortedAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.account_code ? `${a.account_code} — ${a.name}` : a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ledger-from">From</Label>
            <Input
              id="ledger-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ledger-to">To</Label>
            <Input id="ledger-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {!accountId ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <BookMarked className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium text-foreground">Choose an account</p>
            <p className="max-w-md text-sm text-muted-foreground">
              The ledger shows the movements of a single account and the balance after each one.
              Pick one from the chart above, or see the{' '}
              <Link to="/fms/trial-balance" className="underline underline-offset-2">
                trial balance
              </Link>{' '}
              for every account at once.
            </p>
          </CardContent>
        </Card>
      ) : isError ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-medium text-foreground">The ledger could not be loaded</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No balance is shown, because an unknown balance is not zero.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col gap-4 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="font-medium text-foreground">{account?.name}</p>
                <p className="text-xs text-muted-foreground">
                  {account?.account_code ?? 'no code'} · {accountType}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Closing balance</p>
                {isLoading ? (
                  <Skeleton className="mt-1 h-7 w-28" />
                ) : (
                  <p className="font-display text-xl font-bold tabular-nums text-foreground">
                    {formatMoney(closing)}
                  </p>
                )}
              </div>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Entry</TableHead>
                    <TableHead>Particulars</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 6 }).map((_, j) => (
                          <TableCell key={j}>
                            <Skeleton className="h-5 w-full max-w-32" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : lines.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="h-28 text-center">
                        <p className="font-medium text-foreground">Nothing posted to this account</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Either no transaction has used it, or none falls in this date range.
                        </p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    lines.map((line, i) => (
                      <TableRow key={line.id}>
                        <TableCell className="whitespace-nowrap text-sm">
                          {formatCalendarDate(line.posting_date) ?? '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm font-medium text-foreground">
                          {line.journal_no ?? '—'}
                        </TableCell>
                        <TableCell>
                          <p className="text-sm text-foreground">{line.description}</p>
                          <p className="text-xs text-muted-foreground">
                            {sourceLabel(line.source_type)}
                            {line.source_reference ? ` · ${line.source_reference}` : ''}
                          </p>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {moneyOrBlank(line.debit)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {moneyOrBlank(line.credit)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums text-foreground">
                          {formatMoney(balances[i])}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
