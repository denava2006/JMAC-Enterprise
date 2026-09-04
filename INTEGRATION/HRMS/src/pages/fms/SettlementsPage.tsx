import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Banknote, Info, Plus, Wallet } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useAuth } from '@/contexts/AuthContext'
import { ReasonDialog } from '@/components/fms/ReasonDialog'
import { SettlementBuilder } from '@/components/fms/SettlementBuilder'
import { useCollectionSettlements, useTransitionSettlement } from '@/hooks/useTreasury'
import {
  RECORDED_SETTLEMENT_NOTE,
  SETTLEMENT_STATUS_LABEL,
  describeTreasuryError,
  formatTreasuryMoney,
  settlementActionsFor,
  settlementSource,
  type CollectionSettlement,
} from '@/lib/treasury'

/**
 * Collection Settlements: POS money arriving in a company account.
 *
 * F5.5 says what was collected and where it currently sits. This page is the
 * step after — cash carried to a bank, and provider payouts landing net of a
 * fee. Nothing here performs a transfer: it records one that already happened,
 * which is why the wording is "record" and never "withdraw".
 *
 * Confirming is the only action that credits an account, and it belongs to the
 * Finance Manager. The Accountant who prepared the record cannot confirm it.
 */
export default function SettlementsPage() {
  const { profile } = useAuth()
  const { data: settlements = [], isLoading, isError, error } = useCollectionSettlements()
  const transition = useTransitionSettlement()
  const [building, setBuilding] = React.useState(false)
  const [reasonFor, setReasonFor] = React.useState<{ id: string; to: string } | null>(null)

  const canPrepare = profile?.role === 'accountant'

  const confirmed = settlements.filter((s) => s.status === 'confirmed')
  const awaiting = settlements.filter((s) => s.status === 'for_review')
  const settledNet = confirmed.reduce((sum, s) => sum + Number(s.net_amount ?? 0), 0)
  const feesBorne = confirmed.reduce((sum, s) => sum + Number(s.fee_amount ?? 0), 0)

  const columns = React.useMemo<ColumnDef<CollectionSettlement>[]>(
    () => [
      {
        accessorKey: 'settlement_no',
        header: 'Settlement',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-foreground">
              {row.original.settlement_no ?? '—'}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {settlementSource(row.original)}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'settlement_date',
        header: 'Date',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm text-muted-foreground">
            {row.original.settlement_date}
          </span>
        ),
      },
      {
        accessorKey: 'gross_amount',
        header: () => <div className="text-right">Gross</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {formatTreasuryMoney(row.original.gross_amount)}
          </div>
        ),
      },
      {
        accessorKey: 'fee_amount',
        header: () => <div className="text-right">Fee</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {Number(row.original.fee_amount) > 0
              ? `−${formatTreasuryMoney(row.original.fee_amount)}`
              : '—'}
          </div>
        ),
      },
      {
        accessorKey: 'net_amount',
        header: () => <div className="text-right">Net</div>,
        cell: ({ row }) => (
          <div className="text-right font-medium tabular-nums">
            {formatTreasuryMoney(row.original.net_amount)}
          </div>
        ),
      },
      {
        accessorKey: 'destination_account_name',
        header: 'Into',
        cell: ({ row }) => (
          <span className="text-sm">{row.original.destination_account_name ?? '—'}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <Badge
            variant={row.original.status === 'confirmed' ? 'default' : 'secondary'}
            className="font-normal"
          >
            {SETTLEMENT_STATUS_LABEL[row.original.status]}
          </Badge>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const s = row.original
          const can = settlementActionsFor(s, profile?.role, profile?.id)
          if (!can.canSubmit && !can.canDecide) {
            return (
              <span className="text-xs text-muted-foreground">
                {s.status === 'confirmed' && s.reviewed_by_name
                  ? `Confirmed by ${s.reviewed_by_name}`
                  : ''}
              </span>
            )
          }
          return (
            <div className="flex justify-end gap-2">
              {can.canSubmit && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => transition.mutate({ id: s.id, to: 'for_review' })}
                >
                  Submit
                </Button>
              )}
              {can.canDecide && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReasonFor({ id: s.id, to: 'returned' })}
                  >
                    Return
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => transition.mutate({ id: s.id, to: 'confirmed' })}
                  >
                    Confirm
                  </Button>
                </>
              )}
            </div>
          )
        },
      },
    ],
    [profile?.role, profile?.id, transition]
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Collection Settlements"
        description="POS collections arriving in a company cash or bank account."
        action={
          canPrepare ? (
            <Button onClick={() => setBuilding(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Record settlement
            </Button>
          ) : undefined
        }
      />

      {isError && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-sm text-destructive">
            {describeTreasuryError(error)}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Settled into accounts"
          value={formatTreasuryMoney(settledNet)}
          icon={Wallet}
          isLoading={isLoading}
          index={0}
        />
        <StatCard
          label="Provider fees borne"
          value={formatTreasuryMoney(feesBorne)}
          icon={Banknote}
          isLoading={isLoading}
          index={1}
        />
        <StatCard
          label="Awaiting review"
          value={awaiting.length}
          icon={Info}
          isLoading={isLoading}
          index={2}
        />
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{RECORDED_SETTLEMENT_NOTE}</p>
      </div>

      <DataTable
        columns={columns}
        data={settlements}
        isLoading={isLoading}
        searchPlaceholder="Search settlements…"
        emptyTitle="No settlements yet"
        emptyDescription="When branch cash is banked or a provider pays out, record it here."
        density="compact"
      />

      <SettlementBuilder open={building} onOpenChange={setBuilding} />

      <ReasonDialog
        open={!!reasonFor}
        title="Return this settlement"
        description="Say what needs correcting. The Accountant will see this."
        placeholder="The deposit slip does not match the amount…"
        confirmLabel="Return"
        pending={transition.isPending}
        onOpenChange={(open) => !open && setReasonFor(null)}
        onConfirm={(reason) => {
          if (reasonFor) transition.mutate({ ...reasonFor, reason })
          setReasonFor(null)
        }}
      />
    </div>
  )
}
