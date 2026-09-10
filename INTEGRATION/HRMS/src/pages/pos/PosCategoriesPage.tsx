import * as React from 'react'
import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  CategoryActionsMenu,
  CategoryDialogShell,
  ProductCategoriesShell,
  ProductCategoryCard,
  ProductCategoryNote,
  type ProductCategoryView,
} from '@/components/pos/ProductCategories'
import { ManagerBranchPicker, useManagerBranch } from '@/components/pos/ManagerBranchPicker'
import { useBranchCategorySummary } from '@/hooks/usePosCategorySummary'
import { useCreatePosCategory, useRenamePosCategory } from '@/hooks/usePosCatalogue'
import { isGeneralCategoryName } from '@/lib/posCatalogue'

/**
 * Product Categories, as a branch manager needs them.
 *
 * The same module the Administrator uses, seen from a branch: the shell, the
 * card and the dialog frame all come from components/pos/ProductCategories, so
 * the two surfaces cannot drift into looking like different systems again. What
 * differs is authority and context, which is what should differ.
 *
 * WHAT A MANAGER MAY DO HERE, and why it is exactly two things. Categories are
 * a global enterprise taxonomy: `pos_product_categories` has no branch_id, and
 * its RLS is a single `is_admin()` policy. But two SECURITY DEFINER functions
 * deliberately widen that for managers, both guarded
 * `is_admin() or has_pos_role(null, ['manager'])`:
 *
 *   create_pos_category   a manager may add a heading
 *   rename_pos_category   a manager may correct one
 *
 * Everything else stays the Administrator's, because the database says so
 * rather than because this screen is shy: reorder_pos_category and
 * delete_pos_category check `is_admin()` alone, and archiving, colour and
 * description are table writes against an is_admin() policy. This page renders
 * no control that would attempt any of them -- no disabled reorder arrows
 * either, since an arrow they can never press is only a smaller refusal.
 *
 * Both writes are GLOBAL and the page says so before either is confirmed --
 * renaming "Drinks" renames it at every branch and on the Administrator's own
 * catalogue.
 *
 * The four counts that used to be table columns -- carried, offered, low, out
 * -- are branch usage on the card now. Same RPC, same arithmetic, less
 * furniture.
 */

/**
 * Adding a heading, or correcting one.
 *
 * One dialog for both: the fields are identical and the warning is the same, so
 * two would only be two places to keep that warning in step. The FRAME is the
 * Administrator's; the single field is not, because a manager's whole edit is
 * the name. rename_pos_category writes `name` and nothing else, so a Colour box
 * here -- even a disabled one -- would be describing authority that does not
 * exist.
 */
function CategoryDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The category being renamed, or null to add a new one. */
  editing: { id: string; name: string } | null
}) {
  const create = useCreatePosCategory()
  const rename = useRenamePosCategory()
  const [name, setName] = React.useState('')

  React.useEffect(() => {
    if (open) setName(editing?.name ?? '')
  }, [open, editing])

  const trimmed = name.trim()
  const unchanged = !!editing && trimmed === editing.name
  const pending = create.isPending || rename.isPending

  return (
    <CategoryDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'Rename category' : 'New category'}
      description={
        editing
          ? 'Categories are shared across all branches. Renaming this category changes it everywhere.'
          : 'Categories are shared across all branches. A new one becomes available to every branch, not only yours.'
      }
      submitLabel={editing ? 'Rename everywhere' : 'Create category'}
      submitDisabled={!trimmed || unchanged}
      pending={pending}
      onSubmit={() => {
        const done = { onSuccess: () => onOpenChange(false) }
        if (editing) rename.mutate({ id: editing.id, name: trimmed }, done)
        else create.mutate(trimmed, done)
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pos_category_name">
          Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="pos_category_name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="Drinks"
          autoFocus
        />
      </div>
    </CategoryDialogShell>
  )
}

export default function PosCategoriesPage() {
  const { branchId, setBranchId, managed, isLoading: branchesLoading } = useManagerBranch()
  const { data: rows, isLoading } = useBranchCategorySummary(branchId || undefined)

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<{ id: string; name: string } | null>(null)

  const branchName = managed.find((b) => b.id === branchId)?.name ?? ''

  const sorted = React.useMemo(
    () =>
      [...(rows ?? [])].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
      ),
    [rows]
  )

  if (!branchesLoading && managed.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          {/* A cashier has no nav item for this page and the route guard turns
              them around -- this is the belt to that braces. */}
          Product Categories are for the branch you manage. What your branch sells is shown on the
          POS screen.
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <ProductCategoriesShell
        description={`Shared across every branch. These are the headings ${
          branchName || 'this branch'
        } files its catalogue under.`}
        loading={branchesLoading || isLoading}
        empty={sorted.length === 0 ? 'No categories to show yet.' : undefined}
        note={
          <ProductCategoryNote title="Global catalogue">
            Categories are shared across all branches. Creating or renaming one affects every
            branch. Ordering, archiving and deleting stay with an Administrator.
          </ProductCategoryNote>
        }
        action={
          <div className="flex items-center gap-2">
            <ManagerBranchPicker branchId={branchId} onChange={setBranchId} branches={managed} />
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              New category
            </Button>
          </div>
        }
      >
        {sorted.map((row) => {
          const permanent = isGeneralCategoryName(row.name)
          const view: ProductCategoryView = {
            id: row.category_id,
            name: row.name,
            description: row.description,
            color: row.color,
            permanent,
            // A retired category can still hold products this branch carries.
            // Saying so beats hiding the row and leaving the stock unaccounted
            // for. Same badge the Administrator sees.
            archived: !row.is_active,
            productCount: row.product_count,
            branchUsage: {
              carried: row.product_count,
              offered: row.offered_count,
              low: row.low_stock_count,
              out: row.out_of_stock_count,
            },
          }

          return (
            <ProductCategoryCard
              key={row.category_id}
              category={view}
              actions={
                <CategoryActionsMenu categoryName={row.name}>
                  {/* Rename, and only rename. Reordering, archiving and
                      deleting are is_admin() in the database, so a control for
                      them here would be a button that always fails -- and it is
                      hidden rather than disabled, because a disabled control
                      still claims the action is yours.

                      General is exempt even from rename:
                      protect_general_pos_category refuses a name change on it,
                      whoever asks. The Administrator keeps Edit on General
                      because their edit also covers description and colour,
                      which the trigger allows. A manager's edit is the name, so
                      there is nothing left to offer. */}
                  {!permanent && (
                    <DropdownMenuItem
                      onClick={() => {
                        setEditing({ id: row.category_id, name: row.name })
                        setDialogOpen(true)
                      }}
                    >
                      Rename
                    </DropdownMenuItem>
                  )}
                  {/* A real anchor inside the menu, not a handler that calls
                      navigate: it keeps the href, and with it middle-click,
                      copy-link and the status bar. */}
                  <DropdownMenuItem asChild>
                    <Link to={`/pos/stock?branch=${branchId}`}>Open in Inventory</Link>
                  </DropdownMenuItem>
                </CategoryActionsMenu>
              }
            />
          )
        })}
      </ProductCategoriesShell>

      <CategoryDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />
    </>
  )
}
