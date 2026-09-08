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
 * Two tones, and the difference between them is real: `count` for a number of
 * things, `money` for an amount of pesos.
 *
 * Teal is what this app already uses for money in a good state -- it is the
 * colour of Change due on the till -- so the takings card wearing it is the
 * same idea said twice rather than a third decorative colour. Three different
 * tones for three cards would be decoration; two that mean something are not.
 */
type Tone = 'count' | 'money'

const TONE: Record<Tone, string> = {
  count: 'bg-primary/10 text-primary',
  money: 'bg-accent/15 text-accent',
}

export function PosSummaryCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'count',
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
              // The takings figure is the one a cashier is asked for at the end
              // of a shift, so it carries the tone rather than only its icon.
              tone === 'money' ? 'text-accent' : 'text-foreground'
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
