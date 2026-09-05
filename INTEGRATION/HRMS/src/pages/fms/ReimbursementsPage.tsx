import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Receipt, Clock, Wallet } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAuth } from '@/contexts/AuthContext'
import { formatMoney } from '@/lib/currency'
import { ReasonDialog } from '@/components/fms/ReasonDialog'
import { DisbursementPanel, PrepareDialog } from '@/components/fms/DisbursementPanel'
import {
  useCreateReimbursementPayment,
  useReimbursementPayments,
  useReimbursements,
  useTransitionReimbursement,
  useTransitionReimbursementPayment,
} from '@/hooks/useReimbursements'
import {
  APPROVAL_IS_NOT_PAYMENT_NOTE,
  PAYMENT_STATUS_LABEL,
  canPrepareReimbursementPayment,
  describeReimbursementError,
  paymentActionsFor,
  reimbursementActionsFor,
  reimbursementStateLabel,
  roomForPayment,
  type Reimbursement,
} from '@/lib/reimbursements'

/**
 * Employee reimbursements, from Finance's side.
 *
 * The claim itself is a finance_request — the employee files it from My
 * Requests, and it has carried type 'reimbursement' since F3. This page is
 * where Finance reviews it, approves it, and pays it back.
 *
 * Nothing here edits what the employee claimed. If an amount or a date is
 * wrong, the claim is returned for correction; a checker who can rewrite the
 * claim while approving it is approving their own correction.
 */
export default function ReimbursementsPage() {
  const { data: claims = [], isLoading, isError, error } = useReimbursements()
  const transition = useTransitionReimbursement()
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [reasonFor, setReasonFor] = React.useState<{ id: string; to: string; label: string } | null>(
    null
  )

  const awaitingReview = claims.filter((c) => c.status === 'pending_validation')
  const awaitingApproval = claims.filter((c) => c.status === 'pending_approval')
  const payable = claims.filter((c) => c.status === 'approved' && c.balance_due > 0)
  const owed = payable.reduce((sum, c) => sum + Number(c.balance_due ?? 0), 0)

  const columns = React.useMemo<ColumnDef<Reimbursement>[]>(
    () => [
      {
        accessorKey: 'request_no',
        header: 'Claim',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-foreground">
              {row.original.request_no ?? '—'}
            </p>
            <p className="truncate text-xs text-muted-foreground">{row.original.title}</p>
          </div>
        ),
      },
      {
        accessorKey: 'requester_name',
        header: 'Employee',
        cell: ({ row }) => (
          <span className="text-sm">{row.original.requester_name ?? '—'}</span>
        ),
      },
      {
        accessorKey: 'expense_date',
        header: 'Spent on',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm text-muted-foreground">
            {row.original.expense_date ?? '—'}
          </span>
        ),
      },
      {
        accessorKey: 'amount',
        header: () => <div className="text-right">Claimed</div>,
        cell: ({ row }) => (
          <div className="text-right font-medium tabular-nums">
            {formatMoney(Number(row.original.amount))}
          </div>
        ),
      },
      {
        accessorKey: 'balance_due',
        header: () => <div className="text-right">Owing</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {formatMoney(Number(row.original.balance_due))}
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.status === 'approved'
                ? 'success'
                : ['rejected', 'cancelled'].includes(row.original.status)
                  ? 'destructive'
                  : row.original.status === 'returned'
                    ? 'warning'
                    : 'secondary'
            }
            className="font-normal"
          >
            {reimbursementStateLabel(row.original)}
          </Badge>
        ),
      },
    ],
    []
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reimbursements"
        description="Employee expense claims, from review through to paying them back."
      />

      {isError && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-sm text-destructive">
            {describeReimbursementError(error)}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Awaiting review"
          value={awaitingReview.length}
          icon={Clock}
          isLoading={isLoading}
          index={0}
        />
        <StatCard
          label="Awaiting approval"
          value={awaitingApproval.length}
          icon={Receipt}
          isLoading={isLoading}
          index={1}
        />
        <StatCard
          label="Approved, still owing"
          value={formatMoney(owed)}
          icon={Wallet}
          isLoading={isLoading}
          index={2}
        />
      </div>

      <DataTable
        columns={columns}
        data={claims}
        isLoading={isLoading}
        searchPlaceholder="Search claims…"
        emptyTitle="No reimbursements"
        emptyDescription="Employee expense claims appear here once they are submitted."
        density="compact"
        onRowClick={(row) => setOpenId(row.id)}
      />

      <ReimbursementDetail
        claim={claims.find((c) => c.id === openId) ?? null}
        onOpenChange={(open) => !open && setOpenId(null)}
        onDecide={(to, label) => {
          if (!openId) return
          if (to === 'approved') transition.mutate({ id: openId, to })
          else setReasonFor({ id: openId, to, label })
        }}
      />

      <ReasonDialog
        open={!!reasonFor}
        title={reasonFor?.label ?? 'Confirm'}
        description="This is kept with the claim and shown to the employee."
        placeholder="The receipt does not match the amount claimed…"
        confirmLabel={reasonFor?.label ?? 'Confirm'}
        pending={transition.isPending}
        onOpenChange={(open) => !open && setReasonFor(null)}
        onConfirm={(remarks) => {
          if (reasonFor) transition.mutate({ id: reasonFor.id, to: reasonFor.to, remarks })
          setReasonFor(null)
        }}
      />
    </div>
  )
}

function ReimbursementDetail({
  claim,
  onOpenChange,
  onDecide,
}: {
  claim: Reimbursement | null
  onOpenChange: (open: boolean) => void
  onDecide: (to: string, label: string) => void
}) {
  const { profile } = useAuth()
  const { data: payments = [] } = useReimbursementPayments(claim?.id ?? null)
  const create = useCreateReimbursementPayment()
  const transition = useTransitionReimbursementPayment()
  const [preparing, setPreparing] = React.useState(false)

  if (!claim) return null

  const actions = reimbursementActionsFor(profile?.role, claim.status, {
    amountPaid: Number(claim.amount_paid ?? 0),
    pending: Number(claim.pending_payment_amount ?? 0),
  })
  const canPrepare = canPrepareReimbursementPayment(claim, profile?.role)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {claim.request_no}
            <Badge variant="secondary" className="font-normal">
              {reimbursementStateLabel(claim)}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {claim.requester_name} · spent {claim.expense_date ?? 'date not given'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* What the employee claimed. Read-only for every Finance role — a
              correction goes back to them, it is not made here. */}
          <Card>
            <CardContent className="grid gap-x-6 gap-y-2 py-3 sm:grid-cols-2">
              <Figure label="Claimed" value={formatMoney(Number(claim.amount))} strong />
              <Figure label="Category" value={claim.finance_category_name ?? 'Not classified'} />
              <Figure label="Budget" value={claim.budget_name ?? 'Not assigned'} />
              <Figure label="Purpose" value={claim.title} />
            </CardContent>
          </Card>

          {claim.justification && (
            <Card>
              <CardContent className="py-3">
                <p className="text-xs text-muted-foreground">Business purpose</p>
                <p className="text-sm text-foreground">{claim.justification}</p>
              </CardContent>
            </Card>
          )}

          {claim.status === 'approved' && (
            <DisbursementPanel
              title="Prepare payment"
              totals={[
                { label: 'Paid so far', value: Number(claim.amount_paid) },
                { label: 'Pending for payment', value: Number(claim.pending_payment_amount) },
                { label: 'Balance due', value: Number(claim.balance_due), strong: true },
                { label: 'Available to prepare', value: Number(claim.available_to_prepare) },
              ]}
              canPrepare={canPrepare}
              fullyInstructedNote={
                profile?.role === 'accountant' && Number(claim.balance_due) > 0
                  ? 'The remaining balance is already covered by payment instructions.'
                  : undefined
              }
              approvalNote={APPROVAL_IS_NOT_PAYMENT_NOTE}
              rows={payments.map((p) => {
                const room = roomForPayment(p, payments, Number(claim.balance_due))
                const can = paymentActionsFor(p, profile?.role, profile?.id, room)
                return {
                  id: p.id,
                  number: p.payment_no,
                  status: p.status,
                  statusLabel: PAYMENT_STATUS_LABEL[p.status],
                  amount: Number(p.amount),
                  method: p.method,
                  accountName: p.account_name,
                  paymentDate: p.payment_date,
                  reference: p.reference,
                  decisionReason: p.decision_reason,
                  canSubmit: can.canSubmit,
                  canDecide: can.canDecide,
                  canRecord: can.canRecord,
                  stranded:
                    p.status === 'returned' &&
                    profile?.role === 'accountant' &&
                    Number(p.amount) > room,
                }
              })}
              onPrepare={() => setPreparing(true)}
              onSubmit={(id) => transition.mutate({ id, to: 'for_approval' })}
              onApprove={(id) => transition.mutate({ id, to: 'approved' })}
              onReturn={(id, reason) => transition.mutate({ id, to: 'returned', reason })}
              onRecord={(id, reference, paymentDate) =>
                transition.mutate({ id, to: 'paid', reference, paymentDate })
              }
            />
          )}

          {actions.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {actions.map((a) => (
                <Button
                  key={a.to}
                  variant={a.tone === 'default' ? 'default' : a.tone}
                  onClick={() => onDecide(a.to, a.label)}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
        </div>

        <PrepareDialog
          open={preparing}
          onOpenChange={setPreparing}
          heading="Prepare a reimbursement payment"
          subject={`${claim.requester_name} · ${claim.request_no}`}
          balanceDue={Number(claim.balance_due)}
          pending={Number(claim.pending_payment_amount)}
          available={Number(claim.available_to_prepare)}
          onSave={(input) =>
            create.mutate({
              requestId: claim.id,
              accountId: input.accountId,
              amount: input.amount,
              method: input.method,
              submit: input.submit,
            })
          }
        />
      </DialogContent>
    </Dialog>
  )
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={strong ? 'text-base font-semibold text-foreground' : 'text-sm text-foreground'}>
        {value}
      </p>
    </div>
  )
}
