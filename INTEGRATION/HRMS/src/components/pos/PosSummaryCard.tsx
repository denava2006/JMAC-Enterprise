import type { ComponentType } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * One figure above the transaction register.
 *
 * Deliberately plainer than the StatCard used across HR and Finance: those sit
 * on dashboards where a figure is the point. Here the table is the point, and
 * three loud cards above it would push the first row of the register below the
 * fold on a 768-tall screen.
 */

/**
 * The three JMAC brand tones, named for the tokens rather than the colours so
 * a palette change reaches here without a rename.
 *
 * Each card gets its own, which makes the row read as three distinct figures
 * at a glance instead of one repeated shape. They are tints, not fills: the
 * figure beside them still has to be the loudest thing in the card.
 */
type Tone = 'primary' | 'secondary' | 'accent'

// One tint strength across all three. At 10% the navy and the ocean chips were
// hard to tell apart, which defeated the point of giving them different hues.
const TONE: Record<Tone, string> = {
  primary: 'bg-primary/15 text-primary',
  secondary: 'bg-secondary/15 text-secondary',
  accent: 'bg-accent/15 text-accent',
}

export function PosSummaryCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'primary',
}: {
  label: string
  value: string | number
  /** The quiet line underneath — a denominator, never a second figure. */
  hint?: string
  icon?: ComponentType<{ className?: string }>
  tone?: Tone
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 px-4 py-3">
        {Icon && (
          <span
            className={cn(
              'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              TONE[tone]
            )}
          >
            <Icon className="h-[18px] w-[18px]" />
          </span>
        )}
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p
            className={cn(
              'font-display text-xl font-bold leading-tight tabular-nums',
              // Only the takings figure is tinted. It is the number a cashier is
              // asked for at the end of a shift, and if all three were coloured
              // none of them would stand out.
              tone === 'accent' ? 'text-accent' : 'text-foreground'
            )}
          >
            {value}
          </p>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  )
}
