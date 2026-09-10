import * as React from 'react'
import { Lock, MoreHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Product Categories, seen by whoever is looking.
 *
 * There is ONE taxonomy -- `pos_product_categories`, global, no branch_id --
 * and there were two screens onto it that shared no code: the Administrator's
 * card list in the back office, and the POS Manager's table at /pos/categories.
 * They were written months apart, each hand-rolling its own header, list
 * primitive and dialog, so nothing kept them in step and they drifted into
 * looking like two unrelated modules.
 *
 * This module is the shared half. Both pages compose the same shell, the same
 * card and the same dialog frame, and each supplies its own actions and its own
 * form fields.
 *
 * WHAT IS DELIBERATELY NOT SHARED: authority. An Administrator reorders,
 * archives, deletes and edits colour and description; a POS Manager creates and
 * renames, which is the whole of what create_pos_category and
 * rename_pos_category grant them. Nothing here widens that, and nothing here
 * renders a control whose only outcome would be an error -- see `permanent`.
 * Looking alike and being alike are different things.
 */

/** The same words on both surfaces. The entity is Product Categories in the
 *  back office and in the POS portal; "Categories" was the manager's shorthand
 *  and it read as a different module. */
export const PRODUCT_CATEGORIES_TITLE = 'Product Categories'

/** A branch's own use of a category. Present for a POS Manager, absent for the
 *  Administrator, whose view is enterprise-wide and has no branch to report. */
export interface CategoryBranchUsage {
  carried: number
  offered: number
  low: number
  out: number
}

/**
 * One category as a screen needs it.
 *
 * A presentation model, not a third database representation. The Administrator
 * builds it from `pos_product_categories` rows plus a product tally; a manager
 * builds it from `get_branch_category_summary`. Both server paths are
 * untouched -- this only gives the card one shape to render.
 */
export interface ProductCategoryView {
  id: string
  name: string
  description: string | null
  color: string | null
  /**
   * General. It is the guaranteed home for orphaned products, so
   * protect_general_pos_category refuses to rename it, archive it or delete it.
   * A page reads this to decide what NOT to offer -- the database refuses
   * regardless, and a menu item that always errors is worse than no menu item.
   */
  permanent: boolean
  archived: boolean
  /**
   * Products filed under it. Enterprise-wide for the Administrator; for a
   * manager, the active products their branch carries. Different questions with
   * the same shape, which is why the count sits on the view model rather than
   * being computed inside the card.
   */
  productCount: number
  branchUsage?: CategoryBranchUsage
}

/**
 * The page around the cards: heading, optional note, the list, its states.
 *
 * The title is not a prop. Both surfaces must say Product Categories, and a
 * default is something a page can quietly disagree with.
 */
export function ProductCategoriesShell({
  description,
  action,
  note,
  loading = false,
  empty,
  children,
}: {
  /** Role-aware subtitle. Same style, different sentence. */
  description: string
  /** The primary button, and anything that travels with it. */
  action?: React.ReactNode
  /** A compact callout under the header, for something the reader must know
   *  before acting. */
  note?: React.ReactNode
  loading?: boolean
  /** Shown instead of the list when there is nothing to show. */
  empty?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={PRODUCT_CATEGORIES_TITLE} description={description} action={action} />

      {note}

      {loading ? (
        // Card-shaped, because cards are what arrives. A single tall block told
        // the reader nothing about what was coming.
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[68px] rounded-xl" />
          ))}
        </div>
      ) : empty ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {empty}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">{children}</div>
      )}
    </div>
  )
}

/**
 * A short thing the reader needs before they act.
 *
 * Used by the manager's page to say the taxonomy is global. Small on purpose:
 * the previous banner was three lines of prose above a list of four, and the
 * important sentence was the first one.
 */
export function ProductCategoryNote({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
      <p className="text-xs font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  )
}

function UsageFigure({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span>{label}</span>
      <span className={`font-medium tabular-nums ${tone ?? 'text-foreground'}`}>{value}</span>
    </span>
  )
}

/**
 * One category, however you got here.
 *
 * `actions` is a slot rather than a set of flags: the Administrator puts
 * reorder arrows and a menu in it, a manager puts a menu. A flag per capability
 * would have this component encoding a permission model it is not the authority
 * on.
 */
export function ProductCategoryCard({
  category,
  actions,
}: {
  category: ProductCategoryView
  actions?: React.ReactNode
}) {
  const { name, description, color, permanent, archived, productCount, branchUsage } = category

  return (
    <Card>
      {/* flex-wrap so the actions drop below the name at narrow widths instead
          of crushing it. Nothing here scrolls sideways. */}
      <CardContent className="flex flex-wrap items-start gap-3 p-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className="mt-0.5 h-8 w-8 shrink-0 rounded-lg border border-border"
            style={color ? { backgroundColor: color } : undefined}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{name}</span>
              {permanent && (
                <Badge variant="secondary">
                  <Lock className="h-3 w-3" />
                  Permanent
                </Badge>
              )}
              {archived && <Badge variant="muted">Archived</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              {productCount} product{productCount === 1 ? '' : 's'}
              {description ? ` · ${description}` : ''}
            </p>

            {branchUsage && (
              // The four numbers the manager's table used to be columns of.
              // Wrapping metadata, not a stat block: a category is still one
              // line tall until it has something to say.
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <UsageFigure label="Carried" value={branchUsage.carried} />
                <UsageFigure label="Offered" value={branchUsage.offered} />
                <UsageFigure
                  label="Low"
                  value={branchUsage.low}
                  tone={branchUsage.low > 0 ? 'text-warning' : undefined}
                />
                <UsageFigure
                  label="Out"
                  value={branchUsage.out}
                  tone={branchUsage.out > 0 ? 'text-destructive' : undefined}
                />
              </div>
            )}
          </div>
        </div>

        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </CardContent>
    </Card>
  )
}

/**
 * The ••• on a card.
 *
 * Shared so both surfaces name it the same way to a screen reader, and so
 * neither can quietly become an inline text link again.
 */
export function CategoryActionsMenu({
  categoryName,
  children,
}: {
  categoryName: string
  children: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={`Actions for ${categoryName}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The frame every category dialog wears.
 *
 * Same width, heading, spacing, footer and button pair on both surfaces. The
 * FIELDS are children, which is the whole point: the Administrator passes name,
 * description and colour, a manager passes a name. Consistency is the frame,
 * not the contents -- showing a manager a disabled Colour field would be
 * telling them it is theirs, just not today.
 */
export function CategoryDialogShell({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  submitDisabled = false,
  submitVariant,
  pending = false,
  onSubmit,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  submitLabel: string
  submitDisabled?: boolean
  submitVariant?: 'destructive'
  pending?: boolean
  onSubmit: () => void
  children: React.ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* A form, so Enter submits from any field. The old manager dialog had
            this and the Administrator's did not. */}
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (submitDisabled || pending) return
            onSubmit()
          }}
        >
          {children}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={submitVariant} loading={pending} disabled={submitDisabled}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
