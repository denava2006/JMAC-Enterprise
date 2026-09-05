import * as React from 'react'
import { Info } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ReasonDialog } from '@/components/fms/ReasonDialog'
import { businessTodayISODate } from '@/lib/dates'
import { formatMoney, sanitizeMoneyInput } from '@/lib/currency'
import { useTreasuryAccounts } from '@/hooks/useTreasury'
import { formatTreasuryMoney, PAYMENT_METHODS, paymentMethodLabel } from '@/lib/treasury'

/**
 * Preparing, approving and recording a payment — for a reimbursement or a
 * payroll batch alike.
 *
 * Both settle a payable the same way, so the panel is shared while the two
 * domains keep their own tables, guards and RPCs. Sharing the screen is not
 * the same as sharing the accounting, and the brief is explicit that stability
 * beats abstraction on the second.
 *
 * The distinction the panel exists to keep visible: an approved payment is
 * authorised, not sent. The balance falls only when the completed transfer is
 * recorded with its reference.
 */

export interface PayableRow {
  id: string
  number: string | null
  status: string
  statusLabel: string
  amount: number
  method: string
  accountName: string | null
  paymentDate: string | null
  reference: string | null
  decisionReason: string | null
  canSubmit: boolean
  canDecide: boolean
  canRecord: boolean
  stranded: boolean
}

export function DisbursementPanel({
  title,
  totals,
  rows,
  canPrepare,
  fullyInstructedNote,
  approvalNote,
  onPrepare,
  onSubmit,
  onApprove,
  onReturn,
  onRecord,
}: {
  title: string
  totals: Array<{ label: string; value: number; strong?: boolean }>
  rows: PayableRow[]
  canPrepare: boolean
  fullyInstructedNote?: string
  approvalNote: string
  onPrepare: () => void
  onSubmit: (id: string) => void
  onApprove: (id: string) => void
  onReturn: (id: string, reason: string) => void
  onRecord: (id: string, reference: string, date: string) => void
}) {
  const [returning, setReturning] = React.useState<string | null>(null)
  const [recording, setRecording] = React.useState<PayableRow | null>(null)

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-4 py-3">
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {totals.map((t) => (
              <div key={t.label}>
                <p className="text-xs text-muted-foreground">{t.label}</p>
                <p
                  className={
                    t.strong
                      ? 'font-display text-lg font-bold tabular-nums text-foreground'
                      : 'text-base font-semibold tabular-nums text-foreground'
                  }
                >
                  {formatMoney(t.value)}
                </p>
              </div>
            ))}
          </div>
          {canPrepare && (
            <Button size="sm" onClick={onPrepare}>
              {title}
            </Button>
          )}
          {/* Not a disabled button: there is nothing to enable it, and a greyed
              control invites clicking to find out why. */}
          {!canPrepare && fullyInstructedNote && (
            <p className="max-w-xs text-right text-xs text-muted-foreground">
              {fullyInstructedNote}
            </p>
          )}
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-semibold text-foreground">Payments</p>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {rows.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-foreground">{p.number}</span>
                    <Badge
                      variant={p.status === 'paid' ? 'default' : 'secondary'}
                      className="font-normal"
                    >
                      {p.statusLabel}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {paymentMethodLabel(p.method)} · {p.accountName}
                    {p.paymentDate ? ` · ${p.paymentDate}` : ''}
                    {p.reference ? ` · ${p.reference}` : ''}
                  </p>
                  {p.decisionReason && (
                    <p className="text-xs text-muted-foreground">{p.decisionReason}</p>
                  )}
                  {p.stranded && (
                    <p className="text-xs text-muted-foreground">
                      This payment can no longer be resubmitted because the remaining balance is
                      already paid or covered.
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
                  {formatMoney(p.amount)}
                </span>
                <div className="flex shrink-0 gap-2">
                  {p.canSubmit && (
                    <Button size="sm" variant="outline" onClick={() => onSubmit(p.id)}>
                      Submit
                    </Button>
                  )}
                  {p.canDecide && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setReturning(p.id)}>
                        Return
                      </Button>
                      <Button size="sm" onClick={() => onApprove(p.id)}>
                        Approve
                      </Button>
                    </>
                  )}
                  {p.canRecord && (
                    <Button size="sm" onClick={() => setRecording(p)}>
                      Record payment
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {rows.some((p) => p.status === 'approved') && (
            <div className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <p>{approvalNote}</p>
            </div>
          )}
        </div>
      )}

      <ReasonDialog
        open={!!returning}
        title="Return this payment"
        description="Say what needs correcting. The Accountant will see this."
        placeholder="The account is wrong…"
        confirmLabel="Return"
        onOpenChange={(open) => !open && setReturning(null)}
        onConfirm={(reason) => {
          if (returning) onReturn(returning, reason)
          setReturning(null)
        }}
      />

      <RecordDialog
        row={recording}
        onOpenChange={(open) => !open && setRecording(null)}
        onRecord={(ref, date) => {
          if (recording) onRecord(recording.id, ref, date)
          setRecording(null)
        }}
      />
    </div>
  )
}

/**
 * Recording what actually happened.
 *
 * The reference is required, because it is the evidence. The date defaults to
 * the Manila business day and travels as YYYY-MM-DD — an F6 acceptance dated a
 * payment a day early because a UTC clock decided what "today" was.
 */
function RecordDialog({
  row,
  onOpenChange,
  onRecord,
}: {
  row: PayableRow | null
  onOpenChange: (open: boolean) => void
  onRecord: (reference: string, date: string) => void
}) {
  const [reference, setReference] = React.useState('')
  const [date, setDate] = React.useState(() => businessTodayISODate())

  React.useEffect(() => {
    if (!row) return
    setReference('')
    setDate(businessTodayISODate())
  }, [row])

  if (!row) return null

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record the completed payment</DialogTitle>
          <DialogDescription>
            {formatMoney(row.amount)} from {row.accountName}. This is the step that moves the money
            out of the account.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="rec-ref">Payment reference</Label>
            <Input
              id="rec-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="From the bank confirmation or receipt"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rec-date">Payment date</Label>
            <Input
              id="rec-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Once recorded this cannot be edited or deleted — a correction would have to be a
            separate reversal.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!reference.trim()} onClick={() => onRecord(reference.trim(), date)}>
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Preparing an instruction against a payable, capped at what is available. */
export function PrepareDialog({
  open,
  onOpenChange,
  heading,
  subject,
  balanceDue,
  pending,
  available,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  heading: string
  subject: string
  balanceDue: number
  pending: number
  available: number
  onSave: (input: { accountId: string; amount: number; method: string; submit: boolean }) => void
}) {
  const { data: accounts = [] } = useTreasuryAccounts()
  const [accountId, setAccountId] = React.useState('')
  const [amount, setAmount] = React.useState('')
  const [method, setMethod] = React.useState<string>('bank_transfer')

  React.useEffect(() => {
    if (!open) return
    setAccountId('')
    setAmount(available.toFixed(2))
    setMethod('bank_transfer')
  }, [open, available])

  const value = Number(amount || 0)
  const funded = accounts.find((a) => a.id === accountId)
  // The ceiling is what is still unclaimed, not what is owed.
  const overBalance = value > available
  const short = !!funded && value > Number(funded.balance ?? 0)
  const canSave = !!accountId && value > 0 && !overBalance

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            {subject} · {formatMoney(balanceDue)} outstanding
            {pending > 0 && `, ${formatMoney(pending)} already instructed`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="prep-account">Pay from</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="prep-account">
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts
                  .filter((a) => a.is_active)
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} — {formatTreasuryMoney(a.balance)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="prep-amount">Amount</Label>
              <Input
                id="prep-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(sanitizeMoneyInput(e.target.value))}
              />
              {overBalance && (
                <p className="text-xs text-destructive">
                  Available to prepare: {formatMoney(available)}.
                </p>
              )}
              {short && !overBalance && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  That account holds {formatTreasuryMoney(funded?.balance)}. The payment cannot be
                  completed from it until it is funded.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prep-method">Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="prep-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {paymentMethodLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Part payment is fine. Instructions already waiting are counted, so the same money
            cannot be instructed twice.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={!canSave}
            onClick={() => {
              onSave({ accountId, amount: value, method, submit: false })
              onOpenChange(false)
            }}
          >
            Save as draft
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              onSave({ accountId, amount: value, method, submit: true })
              onOpenChange(false)
            }}
          >
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
