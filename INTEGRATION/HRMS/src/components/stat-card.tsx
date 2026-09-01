import type { ComponentType, ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The small figure card that sits in a row above a page's table.
 *
 * Four near-identical copies of this existed — in Employees, Attendance,
 * Deployment and My Attendance — differing only in padding, icon size and
 * whether they animated in. Those became the two sizes below rather than four
 * opinions, so a figure on a Finance page is the same object as a figure on an
 * HR page.
 *
 * `value` is a ReactNode: most callers pass a number, but a formatted amount or
 * a time is the same card.
 */
export function StatCard({
  label,
  value,
  icon: Icon,
  isLoading,
  index,
  size = 'compact',
}: {
  label: string
  value: ReactNode
  icon: ComponentType<{ className?: string }>
  isLoading?: boolean
  /** When set, the card fades in on a stagger. Omit for a static card. */
  index?: number
  /** 'compact' above a dense table; 'default' where the figures are the page. */
  size?: 'compact' | 'default'
}) {
  const compact = size === 'compact'

  const card = (
    <Card>
      <CardContent className={compact ? 'flex items-center gap-3 p-4' : 'flex items-center gap-4 p-5'}>
        <div
          className={
            compact
              ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent'
              : 'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent'
          }
        >
          <Icon className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
        </div>
        <div className="min-w-0">
          <p className={compact ? 'text-xs text-muted-foreground' : 'text-sm text-muted-foreground'}>{label}</p>
          {isLoading ? (
            <Skeleton className={compact ? 'mt-1 h-6 w-12' : 'mt-1 h-7 w-12'} />
          ) : (
            <p
              className={
                compact
                  ? 'font-display text-xl font-bold text-foreground'
                  : 'font-display text-2xl font-bold text-foreground'
              }
            >
              {value}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )

  if (index === undefined) return card

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
    >
      {card}
    </motion.div>
  )
}
