import type { ReactNode } from 'react'

/**
 * The heading every list and detail page opens with.
 *
 * This markup was written out by hand on each page, which is how HRMS ended up
 * with h2 in some places and h1 in others for the same visual role. One
 * component means Finance cannot drift from HR and POS, and the next page to be
 * touched can adopt it without a decision.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  /** Usually the page's primary Button. Rendered at the top right. */
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}
