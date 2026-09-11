import { Banknote, CreditCard, QrCode, Smartphone } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TILL_METHODS, TILL_METHOD_LABEL, type TillMethod } from '@/lib/posTill'

/**
 * How the customer is paying.
 *
 * A dropdown for five options costs two taps and hides four of them; on a
 * touchscreen with a queue behind it, that is the wrong trade. These are the
 * same five values the till has always sent -- TILL_METHODS is the only source,
 * so a method cannot be added or renamed here without changing what the server
 * is told.
 *
 * Built as a radiogroup rather than buttons: it is one choice out of a fixed
 * set, which is what a radio is, and it gives arrow-key movement for free.
 */

const METHOD_ICON: Record<TillMethod, typeof Banknote> = {
  cash: Banknote,
  gcash: Smartphone,
  paymaya: Smartphone,
  card: CreditCard,
  qrph: QrCode,
}

export function PosPaymentMethod({
  value,
  onChange,
  disabled = false,
}: {
  value: TillMethod
  onChange: (method: TillMethod) => void
  disabled?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Payment method"
      className="grid grid-cols-3 gap-1.5"
    >
      {TILL_METHODS.map((method) => {
        const Icon = METHOD_ICON[method]
        const selected = value === method
        return (
          <button
            key={method}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={TILL_METHOD_LABEL[method]}
            disabled={disabled}
            // Only the selected tile is in the tab order, so Tab moves past the
            // group and the arrow keys move within it -- the way a radio set is
            // expected to behave.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(method)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              e.preventDefault()
              const step = e.key === 'ArrowRight' ? 1 : -1
              const next =
                TILL_METHODS[
                  (TILL_METHODS.indexOf(method) + step + TILL_METHODS.length) % TILL_METHODS.length
                ]
              onChange(next)
            }}
            className={cn(
              // Fixed height, so there was never a box metric worth animating.
              'flex h-[58px] flex-col items-center justify-center gap-1 rounded-lg border text-xs font-medium transition',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              'disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? // Teal earns its place here: this is the one control on the
                  // till whose state the cashier must be certain of before
                  // taking money.
                  'border-accent bg-accent/10 text-teal-ink shadow-[inset_0_0_0_1px_var(--color-accent)]'
                : 'border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground'
            )}
          >
            <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
            {TILL_METHOD_LABEL[method]}
          </button>
        )
      })}
    </div>
  )
}
