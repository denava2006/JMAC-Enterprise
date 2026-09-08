import type { ComponentType } from 'react'
import { Card, CardContent } from '@/components/ui/card'

/**
 * One figure above the transaction register.
 *
 * Deliberately plainer than the StatCard used across HR and Finance: those sit
 * on dashboards where a figure is the point. Here the table is the point, and
 * three loud cards above it would push the first row of the register below the
 * fold on a 768-tall screen.
 */
export function PosSummaryCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string
  value: string | number
  /** The quiet line underneath — a denominator, never a second figure. */
  hint?: string
  icon?: ComponentType<{ className?: string }>
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 px-4 py-3">
        {Icon && (
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="font-display text-xl font-bold leading-tight tabular-nums text-foreground">
            {value}
          </p>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  )
}
