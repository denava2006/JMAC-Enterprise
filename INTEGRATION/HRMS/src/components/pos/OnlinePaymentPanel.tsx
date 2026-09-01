import * as React from 'react'
import { Button } from '@/components/ui/button'
import { peso } from '@/lib/posTill'
import {
  describeAttemptStatus,
  useCancelPaymentAttempt,
  usePaymentAttempt,
  type PaymentAttemptStatus,
} from '@/hooks/usePosPayment'

/**
 * What the till shows while a customer is paying online.
 *
 * The one design rule here: this panel has no button that completes a sale.
 * It can open the payment page, ask the server what the status is, and give up
 * — nothing else. The sale is created by the webhook after PayMongo verifies
 * the payment, and the panel finds out by watching the row. A "mark as paid"
 * control would be the whole integration's weakest point, so there isn't one.
 */

interface Props {
  checkoutKey: string
  checkoutUrl: string | null
  amountCentavos: number
  reference: string | null
  onPaid: (saleId: string) => void
  onDismiss: () => void
}

const TERMINAL: PaymentAttemptStatus[] = ['paid', 'paid_unfulfilled', 'failed', 'expired', 'cancelled']

export function OnlinePaymentPanel({
  checkoutKey,
  checkoutUrl,
  amountCentavos,
  reference,
  onPaid,
  onDismiss,
}: Props) {
  const attempt = usePaymentAttempt(checkoutKey, true)
  const cancel = useCancelPaymentAttempt()
  const status = attempt.data?.status ?? 'pending'
  const notified = React.useRef(false)

  React.useEffect(() => {
    if (status === 'paid' && attempt.data?.sale_id && !notified.current) {
      notified.current = true
      onPaid(attempt.data.sale_id)
    }
  }, [status, attempt.data?.sale_id, onPaid])

  const isTerminal = TERMINAL.includes(status)
  const needsManager = status === 'paid_unfulfilled'

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-baseline justify-between">
        {/* Still said, because mistaking a test for a real sale is expensive --
            but as a mark beside the amount rather than a panel the cashier has
            to read past on every transaction. */}
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          Amount
          <span className="rounded border border-amber-500/50 bg-amber-500/10 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            Test
          </span>
        </span>
        <span className="text-lg font-semibold tabular-nums text-foreground">
          {peso(amountCentavos / 100)}
        </span>
      </div>

      {reference && (
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">Reference</span>
          <span className="font-mono text-xs text-foreground">{reference}</span>
        </div>
      )}

      <p
        className={
          needsManager
            ? 'rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs font-medium text-destructive'
            : 'text-xs text-muted-foreground'
        }
        role={needsManager ? 'alert' : undefined}
      >
        {describeAttemptStatus(status)}
      </p>

      {/* No "Open payment page" step: the till navigates there as soon as the
          session exists. This stays only as a way back if the customer closed
          the page before paying. */}
      {status === 'pending' && checkoutUrl && (
        <Button asChild variant="outline" className="w-full">
          <a href={checkoutUrl} rel="noopener noreferrer">
            Reopen payment page
          </a>
        </Button>
      )}

      <div className="flex gap-2">
        {status === 'pending' && (
          <>
            <Button
              variant="outline"
              className="flex-1"
              loading={attempt.isFetching}
              onClick={() => attempt.refetch()}
            >
              Check status
            </Button>
            <Button
              variant="ghost"
              className="flex-1"
              loading={cancel.isPending}
              onClick={() => cancel.mutate(checkoutKey)}
            >
              Cancel
            </Button>
          </>
        )}
        {isTerminal && status !== 'paid' && (
          <Button variant="outline" className="w-full" onClick={onDismiss}>
            Back to the till
          </Button>
        )}
      </div>

      {cancel.isError && (
        <p className="text-xs text-destructive">{cancel.error.message}</p>
      )}
    </div>
  )
}
