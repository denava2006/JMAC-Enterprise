import { cn } from '@/lib/utils'
import { ALL_CATEGORIES } from '@/lib/posTill'

/**
 * The category chips under the till's search bar.
 *
 * The list is derived from the branch's own catalogue, so a category added in
 * Products shows up here on its own -- there is nothing to register and nothing
 * that can fall out of step with what the branch actually sells.
 *
 * Rendered as a tab list rather than buttons: it is one choice out of a set
 * that changes what the grid below shows, which is what tabs are. That also
 * gives arrow-key movement, which a keyboard-driven till wants.
 *
 * Shown as soon as the branch sells anything at all. It was hidden below two
 * categories on the reasoning that a filter with one option is furniture --
 * but a till whose controls appear and disappear as stock changes is harder to
 * learn than one with a strip that is always in the same place, and a branch
 * with one category today has two the week it widens its range. Only a branch
 * offering nothing gets no strip, and that grid has its own empty state.
 */
export function PosCategoryFilter({
  categories,
  value,
  onChange,
}: {
  categories: string[]
  /** ALL_CATEGORIES, or one of `categories`. */
  value: string
  onChange: (category: string) => void
}) {
  if (categories.length === 0) return null

  const options = [ALL_CATEGORIES, ...categories]

  return (
    <div
      role="tablist"
      aria-label="Filter by category"
      // Scrolls sideways rather than wrapping to a second row: a branch with
      // fifteen categories must not push the product grid down the page.
      className="flex shrink-0 gap-1.5 overflow-x-auto pb-0.5"
    >
      {options.map((category) => {
        const selected = value === category
        const label = category === ALL_CATEGORIES ? 'All' : category
        return (
          <button
            key={category || 'all'}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(category)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              e.preventDefault()
              const step = e.key === 'ArrowRight' ? 1 : -1
              const next = options[(options.indexOf(category) + step + options.length) % options.length]
              onChange(next)
            }}
            className={cn(
              'h-9 shrink-0 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground'
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
