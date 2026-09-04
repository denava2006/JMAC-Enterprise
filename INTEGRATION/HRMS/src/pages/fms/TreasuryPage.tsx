import * as React from 'react'
import { ArrowDownLeft, ArrowUpRight, Banknote, Landmark, Plus, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/contexts/AuthContext'
import { useTreasuryAccounts, useTreasuryMovements } from '@/hooks/useTreasury'
import {
  describeTreasuryError,
  formatTreasuryMoney,
  movementSourceLabel,
  signedAmount,
  type TreasuryAccount,
} from '@/lib/treasury'
import { TreasuryAccountDialog } from '@/components/fms/TreasuryAccountDialog'

/**
 * Cash & Bank Accounts: where the company's money actually is.
 *
 * Every balance here is derived — an opening figure plus the movements since —
 * so there is no field to edit one, and deliberately no "adjust balance"
 * control. A number that can be typed is a number that can disagree with the
 * documents behind it, and the whole point of this page is that it cannot.
 *
 * The drill-down is the answer to "why is it that much": each row names the
 * settlement or payment that moved it.
 */
export default function TreasuryPage() {
  const { profile } = useAuth()
  const accounts = useTreasuryAccounts()
  const [selected, setSelected] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)
  const movements = useTreasuryMovements(selected ?? undefined)

  // Opening an account is a bookkeeping act, so it is the Accountant's.
  const canOpen = profile?.role === 'accountant'

  const rows = accounts.data ?? []
  const active = rows.filter((a) => a.is_active)
  const totalCash = active
    .filter((a) => a.account_type === 'cash')
    .reduce((sum, a) => sum + Number(a.balance ?? 0), 0)
  const totalBank = active
    .filter((a) => a.account_type === 'bank')
    .reduce((sum, a) => sum + Number(a.balance ?? 0), 0)

  const chosen = rows.find((a) => a.id === selected)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash & Bank Accounts"
        description="Where company money is held. Balances are derived from recorded movements."
        action={
          canOpen ? (
            <Button onClick={() => setAdding(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New account
            </Button>
          ) : undefined
        }
      />

      {accounts.isError && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-sm text-destructive">
            {describeTreasuryError(accounts.error)}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="In bank accounts"
          value={formatTreasuryMoney(totalBank)}
          icon={Landmark}
          isLoading={accounts.isLoading}
          index={0}
        />
        <StatCard
          label="In cash accounts"
          value={formatTreasuryMoney(totalCash)}
          icon={Banknote}
          isLoading={accounts.isLoading}
          index={1}
        />
        <StatCard
          label="Total held"
          value={formatTreasuryMoney(totalBank + totalCash)}
          icon={Wallet}
          isLoading={accounts.isLoading}
          index={2}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardContent className="space-y-3 py-5">
            <h3 className="font-display text-base font-semibold text-foreground">Accounts</h3>
            {accounts.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                No treasury accounts yet. An Accountant can add the company bank account and any
                branch cash accounts here.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((account) => (
                  <li key={account.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(selected === account.id ? null : account.id)}
                      aria-pressed={selected === account.id}
                      className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-muted/60 ${
                        selected === account.id ? 'bg-muted' : ''
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                          {account.account_type === 'bank' ? (
                            <Landmark className="h-4 w-4" />
                          ) : (
                            <Banknote className="h-4 w-4" />
                          )}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">{account.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {account.branch_name ?? (account.account_type === 'bank' ? 'Company' : 'Cash')}
                            {account.movement_count > 0
                              ? ` · ${account.movement_count} movement${account.movement_count === 1 ? '' : 's'}`
                              : ' · no movements yet'}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-medium tabular-nums text-foreground">
                          {formatTreasuryMoney(account.balance)}
                        </p>
                        {!account.is_active && (
                          <Badge variant="secondary" className="mt-0.5 font-normal">
                            Inactive
                          </Badge>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 py-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-display text-base font-semibold text-foreground">
                {chosen ? chosen.name : 'All movements'}
              </h3>
              {chosen && (
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                  Show all
                </Button>
              )}
            </div>

            {chosen && (
              <AccountBreakdown account={chosen} />
            )}

            {movements.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : (movements.data ?? []).length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                Nothing has moved yet. Confirmed collection settlements and recorded supplier
                payments appear here.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {(movements.data ?? []).map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                          m.direction === 'in'
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        {m.direction === 'in' ? (
                          <ArrowDownLeft className="h-4 w-4" />
                        ) : (
                          <ArrowUpRight className="h-4 w-4" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {m.source_no ?? movementSourceLabel(m)}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {movementSourceLabel(m)} · {m.occurred_on}
                          {m.reference ? ` · ${m.reference}` : ''}
                          {!selected && m.account_name ? ` · ${m.account_name}` : ''}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`shrink-0 text-sm font-medium tabular-nums ${
                        m.direction === 'in'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-foreground'
                      }`}
                    >
                      {signedAmount(m)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <TreasuryAccountDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}

/** How this balance is arrived at, said in the open. */
function AccountBreakdown({ account }: { account: TreasuryAccount }) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/40 p-3 sm:grid-cols-4">
      <Figure label="Opening" value={formatTreasuryMoney(account.opening_balance)} />
      <Figure label="Received" value={`+${formatTreasuryMoney(account.total_in)}`} />
      <Figure label="Paid out" value={`−${formatTreasuryMoney(account.total_out)}`} />
      <Figure label="Balance" value={formatTreasuryMoney(account.balance)} strong />
    </div>
  )
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`tabular-nums ${strong ? 'text-base font-semibold text-foreground' : 'text-sm text-foreground'}`}
      >
        {value}
      </p>
    </div>
  )
}
