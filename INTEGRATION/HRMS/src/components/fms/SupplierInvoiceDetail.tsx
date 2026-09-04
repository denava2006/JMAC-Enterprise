import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { useAuth } from '@/contexts/AuthContext'
import { formatMoney } from '@/lib/currency'
import { ReasonDialog } from '@/components/fms/ReasonDialog'
import { InvoiceMatch, matchSummary } from '@/components/fms/InvoiceMatch'
import { InvoicePayments } from '@/components/fms/InvoicePayments'
import {
  invoiceStateLabel,
  useInvoiceHistory,
  useInvoiceMatch,
  useSupplierInvoices,
  useTransitionSupplierInvoice,
} from '@/hooks/useSupplierInvoices'

/**
 * One supplier invoice: what it charges, how it compares, and who may decide it.
 *
 * The Finance Manager reviews this read-only. There is no control here that
 * edits a vendor, a number, a quantity or a cost -- a checker who can correct
 * the document while approving it is approving their own correction, and the
 * whole reason two people touch an invoice is that neither does both jobs.
 *
 * When the match disagrees, Approve is not offered. The server refuses it too;
 * offering a button that fails would just be a slower way of saying no.
 */

/** Which transitions this person may make on an invoice in this state. */
/**
 * What the signed-in role may do with an invoice in this state.
 *
 * `settled` carries whether any money is paid or promised. Voiding says "this
 * bill was never valid", and F6 has no reversal — so once a payment exists,
 * voiding would hide the bill while leaving the money gone. The server refuses
 * it; this stops the button being offered in the first place.
 */
export function invoiceActionsFor(
  role: string | undefined,
  status: string | undefined,
  settled: { amountPaid: number; pending: number } = { amountPaid: 0, pending: 0 }
) {
  if (role === 'accountant') {
    if (status === 'draft' || status === 'returned') {
      return [{ to: 'for_review', label: 'Submit for review', tone: 'default' as const }]
    }
    return []
  }
  if (role === 'finance_manager') {
    if (status === 'for_review') {
      return [
        { to: 'approved', label: 'Approve', tone: 'default' as const },
        { to: 'returned', label: 'Return for correction', tone: 'outline' as const },
        { to: 'rejected', label: 'Reject', tone: 'destructive' as const },
      ]
    }
    if (status === 'approved') {
      // Hidden rather than disabled. A greyed Void button on a paid invoice
      // invites clicking to find out why, and the answer is that it will never
      // be available again — the reason is said in the panel instead.
      if (settled.amountPaid > 0 || settled.pending > 0) return []
      return [{ to: 'voided', label: 'Void invoice', tone: 'destructive' as const }]
    }
    return []
  }
  return []
}

const NEEDS_REASON = new Set(['returned', 'rejected', 'voided'])

export function SupplierInvoiceDetail({
  invoiceId,
  onOpenChange,
}: {
  invoiceId: string | null
  onOpenChange: (open: boolean) => void
}) {
  const { profile } = useAuth()
  const { data: invoices = [] } = useSupplierInvoices()
  const { data: match = [] } = useInvoiceMatch(invoiceId ?? undefined)
  const { data: history = [] } = useInvoiceHistory(invoiceId ?? undefined)
  const transition = useTransitionSupplierInvoice()
  const [asking, setAsking] = React.useState<{ to: string; label: string } | null>(null)

  const invoice = invoices.find((i) => i.id === invoiceId)
  const summary = matchSummary(match)
  const actions = invoiceActionsFor(profile?.role, invoice?.status ?? undefined, {
    amountPaid: Number(invoice?.amount_paid ?? 0),
    pending: Number(invoice?.pending_payment_amount ?? 0),
  })
    // Approve disappears while the three disagree. The database refuses it as
    // well; this stops somebody pressing it to find that out.
    .filter((a) => a.to !== 'approved' || summary.matched)

  return (
    <Dialog open={!!invoiceId} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {invoice?.supplier_invoice_number}
            <Badge
              variant={
                invoice?.status === 'approved'
                  ? 'success'
                  : ['rejected', 'voided'].includes(invoice?.status ?? '')
                    ? 'destructive'
                    : invoice?.status === 'returned'
                      ? 'warning'
                      : 'secondary'
              }
            >
              {invoice ? invoiceStateLabel(invoice) : ''}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {invoice?.vendor_name} · {invoice?.po_number} · dated {invoice?.invoice_date}
            {invoice?.due_date ? `, due ${invoice.due_date}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <InvoiceMatch rows={match} />

          <Card>
            <CardContent className="grid gap-x-6 gap-y-2 py-3 sm:grid-cols-2">
              <Figure label="Subtotal" value={formatMoney(Number(invoice?.subtotal ?? 0))} />
              <Figure label="Tax" value={formatMoney(Number(invoice?.tax_amount ?? 0))} />
              <Figure
                label="Other charges"
                value={formatMoney(Number(invoice?.other_charges ?? 0))}
                hint={invoice?.other_charges_note ?? undefined}
              />
              <Figure
                label="Invoice total"
                value={formatMoney(Number(invoice?.total_amount ?? 0))}
                strong
              />
            </CardContent>
          </Card>

          {/* What is owed, what has been paid, and the payments themselves.
              The balance is derived from completed payments, so this panel and
              the treasury cannot drift apart. */}
          {invoice?.status === 'approved' && <InvoicePayments invoice={invoice} />}

          {/* Where Void would otherwise sit. Said once, plainly, rather than
              leaving a Finance Manager to wonder where the control went. */}
          {profile?.role === 'finance_manager' &&
            invoice?.status === 'approved' &&
            (Number(invoice.amount_paid ?? 0) > 0 ||
              Number(invoice.pending_payment_amount ?? 0) > 0) && (
              <Card>
                <CardContent className="py-3 text-sm text-muted-foreground">
                  {Number(invoice.amount_paid ?? 0) > 0
                    ? 'Paid invoices cannot be voided. Voiding is not a reversal, and reversing a payment is not something this phase can do.'
                    : 'Resolve the pending payment instruction first — return or reject it, and this invoice can then be voided.'}
                </CardContent>
              </Card>
            )}

          {invoice?.decision_reason && (
            <Card>
              <CardContent className="py-3">
                <p className="text-xs text-muted-foreground">Reason given</p>
                <p className="text-sm text-foreground">{invoice.decision_reason}</p>
              </CardContent>
            </Card>
          )}

          {history.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-semibold text-foreground">History</p>
              <ul className="flex flex-col gap-1 rounded-lg border border-border p-3">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap gap-x-2 text-xs">
                    <span className="font-medium text-foreground">{h.action}</span>
                    <span className="text-muted-foreground">
                      {h.role_at_action ? `by ${h.role_at_action}` : ''} ·{' '}
                      {new Date(h.created_at).toLocaleString()}
                    </span>
                    {h.remarks && <span className="w-full text-muted-foreground">{h.remarks}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ReasonDialog
            open={!!asking}
            title={asking?.label ?? 'Confirm'}
            description="This is kept with the invoice and shown to whoever picks it up next."
            confirmLabel={asking?.label ?? 'Confirm'}
            pending={transition.isPending}
            onOpenChange={(open) => !open && setAsking(null)}
            onConfirm={async (reason) => {
              if (!invoiceId || !asking) return
              await transition.mutateAsync({ invoiceId, to: asking.to, remarks: reason })
              setAsking(null)
              onOpenChange(false)
            }}
          />

          {actions.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
              {actions.map((action) => (
                <Button
                  key={action.to}
                  variant={action.tone}
                  disabled={transition.isPending}
                  onClick={async () => {
                    if (!invoiceId) return
                    if (NEEDS_REASON.has(action.to)) {
                      setAsking({ to: action.to, label: action.label })
                      return
                    }
                    await transition.mutateAsync({ invoiceId, to: action.to })
                    if (action.to === 'approved') onOpenChange(false)
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Figure({
  label,
  value,
  hint,
  strong,
}: {
  label: string
  value: string
  hint?: string
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <span className="text-sm text-muted-foreground">{label}</span>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
      <span
        className={
          strong
            ? 'font-display text-base font-bold tabular-nums text-foreground'
            : 'text-sm tabular-nums text-foreground'
        }
      >
        {value}
      </span>
    </div>
  )
}
