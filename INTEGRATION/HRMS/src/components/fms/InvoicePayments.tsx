import * as React from 'react'
import { businessTodayISODate } from '@/lib/dates'
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
import { useAuth } from '@/contexts/AuthContext'
import { formatMoney, sanitizeMoneyInput } from '@/lib/currency'
import { ReasonDialog } from '@/components/fms/ReasonDialog'
import {
  useCreatePayment,
  useSupplierPayments,
  useTransitionPayment,
  useTreasuryAccounts,
} from '@/hooks/useTreasury'
import {
  APPROVAL_IS_NOT_PAYMENT_NOTE,
  PAYMENT_METHODS,
  PAYMENT_STATUS_LABEL,
  formatTreasuryMoney,
  paymentActionsFor,
  paymentMethodLabel,
  type SupplierPayment,
} from '@/lib/treasury'
import type { SupplierInvoice } from '@/hooks/useSupplierInvoices'

/**
 * What is owed on this invoice, and every payment against it.
 *
 * The distinction this panel exists to keep visible: an approved payment is
 * authorised, not sent. JMAC has no bank-transfer API, so the balance falls
 * only when the Accountant records the completed transfer with its reference.
 * The wording says so next to the button, rather than leaving somebody to work
 * it out from a balance that did not move.
 *
 * Nothing here can be edited once recorded. A correction is a reversal, which
 * is a later phase — mutating a completed payment would restate a treasury
 * balance and a budget with no trace.
 */
export function InvoicePayments({ invoice }: { invoice: SupplierInvoice }) {
  const { profile } = useAuth()
  const { data: payments = [] } = useSupplierPayments(invoice.id)
  const transition = useTransitionPayment()
  const [preparing, setPreparing] = React.useState(false)
  const [recording, setRecording] = React.useState<SupplierPayment | null>(null)
  const [returning, setReturning] = React.useState<{ id: string; to: string } | null>(null)

  const balance = Number(invoice.balance_due ?? 0)
  const paid = Number(invoice.amount_paid ?? 0)
  // Owed and claimed are different questions. balance_due subtracts only
  // completed payments, deliberately -- an instruction nobody has sent has not
  // paid the supplier. What may still be asked for is what is left after the
  // instructions already in flight.
  const pending = Number(invoice.pending_payment_amount ?? 0)
  const available = Number(invoice.available_to_prepare ?? 0)
  const canPrepare = profile?.role === 'accountant' && available > 0
  const fullyInstructed = profile?.role === 'accountant' && balance > 0 && available <= 0

  // The generated types make every view column nullable. An invoice without an
  // id is not a thing this panel can act on, so it is narrowed once here rather
  // than asserted at each call site.
  const invoiceId = invoice.id

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-4 py-3">
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <div>
              <p className="text-xs text-muted-foreground">Paid so far</p>
              <p className="text-base font-semibold tabular-nums text-foreground">
                {formatMoney(paid)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Pending for payment</p>
              <p className="text-base font-semibold tabular-nums text-foreground">
                {formatMoney(pending)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Balance due</p>
              <p className="font-display text-lg font-bold tabular-nums text-foreground">
                {formatMoney(balance)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Available to prepare</p>
              <p className="text-base font-semibold tabular-nums text-foreground">
                {formatMoney(available)}
              </p>
            </div>
          </div>
          {canPrepare && (
            <Button size="sm" onClick={() => setPreparing(true)}>
              Prepare payment
            </Button>
          )}
          {/* Not a disabled button: there is nothing to enable it, and a
              greyed control invites clicking to find out why. */}
          {fullyInstructed && (
            <p className="max-w-xs text-right text-xs text-muted-foreground">
              The remaining balance is already covered by payment instructions.
            </p>
          )}
        </CardContent>
      </Card>

      {payments.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-semibold text-foreground">Payments</p>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {payments.map((p) => {
              // What this invoice could still take for THIS payment: the
              // balance less every other live instruction. Its own amount is
              // excluded, exactly as the server excludes it — counting a
              // payment against itself would refuse every resubmission.
              const siblings = payments
                .filter(
                  (o) =>
                    o.id !== p.id &&
                    ['draft', 'for_approval', 'approved'].includes(o.status)
                )
                .reduce((sum, o) => sum + Number(o.amount ?? 0), 0)
              const roomForThis = Math.max(balance - siblings, 0)
              const can = paymentActionsFor(p, profile?.role, profile?.id, roomForThis)
              const strandedReturn =
                p.status === 'returned' &&
                profile?.role === 'accountant' &&
                Number(p.amount) > roomForThis
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-foreground">{p.payment_no}</span>
                      <Badge
                        variant={p.status === 'paid' ? 'default' : 'secondary'}
                        className="font-normal"
                      >
                        {PAYMENT_STATUS_LABEL[p.status]}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {paymentMethodLabel(p.method)} · {p.account_name}
                      {p.payment_date ? ` · ${p.payment_date}` : ''}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </p>
                    {p.decision_reason && (
                      <p className="text-xs text-muted-foreground">{p.decision_reason}</p>
                    )}
                    {/* Kept on the record, but there is nothing left for it to
                        pay. Saying so beats a Submit button that fails. */}
                    {strandedReturn && (
                      <p className="text-xs text-muted-foreground">
                        This payment can no longer be resubmitted because the remaining invoice
                        balance is already paid or covered.
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
                    {formatMoney(Number(p.amount))}
                  </span>
                  <div className="flex shrink-0 gap-2">
                    {can.canSubmit && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => transition.mutate({ id: p.id, to: 'for_approval' })}
                      >
                        Submit
                      </Button>
                    )}
                    {can.canDecide && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setReturning({ id: p.id, to: 'returned' })}
                        >
                          Return
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => transition.mutate({ id: p.id, to: 'approved' })}
                        >
                          Approve
                        </Button>
                      </>
                    )}
                    {can.canRecord && (
                      <Button size="sm" onClick={() => setRecording(p)}>
                        Record payment
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          {payments.some((p) => p.status === 'approved') && (
            <div className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <p>{APPROVAL_IS_NOT_PAYMENT_NOTE}</p>
            </div>
          )}
        </div>
      )}

      {invoiceId && (
        <PreparePaymentDialog
          invoice={invoice}
          invoiceId={invoiceId}
          open={preparing}
          onOpenChange={setPreparing}
        />
      )}

      <RecordPaymentDialog
        payment={recording}
        onOpenChange={(open) => !open && setRecording(null)}
      />

      <ReasonDialog
        open={!!returning}
        title="Return this payment"
        description="Say what needs correcting. The Accountant will see this."
        placeholder="The account is wrong…"
        confirmLabel="Return"
        pending={transition.isPending}
        onOpenChange={(open) => !open && setReturning(null)}
        onConfirm={(reason) => {
          if (returning) transition.mutate({ ...returning, reason })
          setReturning(null)
        }}
      />
    </div>
  )
}

/** Preparing an instruction. Supplier and invoice are fixed; the rest is asked. */
function PreparePaymentDialog({
  invoice,
  invoiceId,
  open,
  onOpenChange,
}: {
  invoice: SupplierInvoice
  invoiceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const create = useCreatePayment()
  const { data: accounts = [] } = useTreasuryAccounts()
  const balance = Number(invoice.balance_due ?? 0)
  // The ceiling is what is still unclaimed, not what is owed. Using the
  // balance let two instructions for the whole amount onto one invoice.
  const available = Number(invoice.available_to_prepare ?? 0)
  const pending = Number(invoice.pending_payment_amount ?? 0)

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
  const overBalance = value > available
  // A warning, not a block: the funds are re-checked at the moment of
  // completion, which is the only moment that matters.
  const short = !!funded && value > Number(funded.balance ?? 0)
  const canSave = !!accountId && value > 0 && !overBalance && !create.isPending

  async function save(submit: boolean) {
    await create.mutateAsync({
      invoiceId,
      accountId,
      amount: value,
      method,
      submit,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Prepare a payment</DialogTitle>
          <DialogDescription>
            {invoice.vendor_name} · {invoice.supplier_invoice_number} · {formatMoney(balance)}{' '}
            outstanding
            {pending > 0 && `, ${formatMoney(pending)} already instructed`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="pay-account">Pay from</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="pay-account">
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
              <Label htmlFor="pay-amount">Amount</Label>
              <Input
                id="pay-amount"
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
              <Label htmlFor="pay-method">Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="pay-method">
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
            Part payment is fine — the balance follows what is actually paid. Instructions already
            waiting are counted, so the same money cannot be instructed twice.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => save(false)} disabled={!canSave}>
            Save as draft
          </Button>
          <Button onClick={() => save(true)} disabled={!canSave}>
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Recording what actually happened.
 *
 * The reference is required, because it is the evidence. Without it, "paid"
 * would be an assertion with nothing behind it.
 */
function RecordPaymentDialog({
  payment,
  onOpenChange,
}: {
  payment: SupplierPayment | null
  onOpenChange: (open: boolean) => void
}) {
  const transition = useTransitionPayment()
  const [reference, setReference] = React.useState('')
  const [date, setDate] = React.useState(() => businessTodayISODate())

  React.useEffect(() => {
    if (!payment) return
    setReference('')
    setDate(businessTodayISODate())
  }, [payment])

  if (!payment) return null

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record the completed payment</DialogTitle>
          <DialogDescription>
            {formatMoney(Number(payment.amount))} from {payment.account_name}. This is the step
            that moves the money out of the account and reduces what is owed.
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
            <Input id="rec-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
          <Button
            disabled={!reference.trim() || transition.isPending}
            onClick={async () => {
              await transition.mutateAsync({
                id: payment.id,
                to: 'paid',
                reference: reference.trim(),
                paymentDate: date,
              })
              onOpenChange(false)
            }}
          >
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
