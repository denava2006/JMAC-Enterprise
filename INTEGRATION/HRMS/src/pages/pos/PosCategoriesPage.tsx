import * as React from 'react'
import { Link } from 'react-router-dom'
import { Info, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ManagerBranchPicker, useManagerBranch } from '@/components/pos/ManagerBranchPicker'
import { useBranchCategorySummary } from '@/hooks/usePosCategorySummary'
import { useCreatePosCategory, useRenamePosCategory } from '@/hooks/usePosCatalogue'

/**
 * Categories, as a branch manager needs them.
 *
 * Mostly an operational summary -- what you carry under each heading, how much
 * of it you are actually offering, and where the gaps are. Acting on any of
 * that happens on Inventory, one click away per row. Nothing here mutates
 * stock.
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
 * Create was already reachable from the Add Product flow, so a manager could
 * make a category and then had no way to fix a typo in it. Both now live here,
 * where a person looking for them would look.
 *
 * Everything else stays the Administrator's, because the database says so
 * rather than because this screen is shy: reorder_pos_category and
 * delete_pos_category check `is_admin()` alone, activating and deactivating is
 * a table write against an is_admin() policy, and protect_general_pos_category
 * guards General. This page renders no control that would attempt any of them.
 *
 * Both writes are GLOBAL and the screen says so before either is confirmed --
 * renaming "Drinks" renames it at every branch and on the Administrator's own
 * catalogue.
 */
/**
 * Adding a heading, or correcting one.
 *
 * One dialog for both: the fields are identical and the warning is the same,
 * so two would only be two places to keep that warning in step.
 */
function CategoryDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The category being renamed, or null to add a new one. */
  editing: { category_id: string; name: string } | null
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

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!trimmed || unchanged || pending) return
    const done = { onSuccess: () => onOpenChange(false) }
    if (editing) rename.mutate({ id: editing.category_id, name: trimmed }, done)
    else create.mutate(trimmed, done)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Rename category' : 'New category'}</DialogTitle>
          <DialogDescription>
            Categories are shared by the whole business.{' '}
            {editing
              ? 'Renaming this one renames it at every branch, and on the Administrator’s catalogue.'
              : 'A new one becomes available to every branch, not only yours.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pos-category-name">Category name</Label>
            <Input
              id="pos-category-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Drinks"
              autoFocus
              maxLength={60}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={!trimmed || unchanged}>
              {editing ? 'Rename everywhere' : 'Create category'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function PosCategoriesPage() {
  const { branchId, setBranchId, managed, isLoading: branchesLoading } = useManagerBranch()
  const { data: rows, isLoading } = useBranchCategorySummary(branchId || undefined)

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<{ category_id: string; name: string } | null>(null)

  const openNew = () => {
    setEditing(null)
    setDialogOpen(true)
  }
  const openRename = (row: { category_id: string; name: string }) => {
    setEditing({ category_id: row.category_id, name: row.name })
    setDialogOpen(true)
  }

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
          {/* A cashier has no nav item for this page -- this is the typed-the-URL
              case, and the RPC returns them nothing regardless. */}
          Category summaries are for the branch you manage. What your branch sells is shown on the
          POS screen.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Categories"
        description={`How ${branchName || 'this branch'}'s catalogue is filed, and where the gaps are.`}
        action={
          <div className="flex items-center gap-2">
            <ManagerBranchPicker branchId={branchId} onChange={setBranchId} branches={managed} />
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" />
              New category
            </Button>
          </div>
        }
      />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Categories are shared by the whole business, so adding or renaming one changes it at
          every branch. Ordering, archiving and deleting stay with an Administrator. The counts
          are your branch&apos;s: pausing a product or setting its low-stock level is done on
          Inventory.
        </p>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No categories to show yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Carried</TableHead>
                  <TableHead>Offered</TableHead>
                  <TableHead>Low</TableHead>
                  <TableHead>Out</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((row) => (
                  <TableRow key={row.category_id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {row.color && (
                          <span
                            className="h-3 w-3 shrink-0 rounded-full border border-border"
                            style={{ backgroundColor: row.color }}
                            aria-hidden
                          />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground">{row.name}</span>
                            {/* A retired category can still hold products this
                                branch carries. Saying so beats hiding the row
                                and leaving the stock unaccounted for. */}
                            {!row.is_active && <Badge variant="secondary">Retired</Badge>}
                          </div>
                          {row.description && (
                            <p className="truncate text-xs text-muted-foreground">
                              {row.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{row.product_count}</TableCell>
                    <TableCell className="tabular-nums">{row.offered_count}</TableCell>
                    <TableCell className="tabular-nums">
                      {row.low_stock_count > 0 ? (
                        <Badge variant="warning">{row.low_stock_count}</Badge>
                      ) : (
                        0
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.out_of_stock_count > 0 ? (
                        <Badge variant="destructive">{row.out_of_stock_count}</Badge>
                      ) : (
                        0
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-3">
                        {/* Rename, and only rename. Reordering, archiving and
                            deleting are is_admin() in the database, so a
                            control for them here would be a button that
                            always fails. */}
                        <button
                          type="button"
                          onClick={() => openRename(row)}
                          className="text-xs font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Rename ${row.name}`}
                        >
                          Rename
                        </button>
                        <Link
                          to={`/pos/stock?branch=${branchId}`}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          Open in Inventory
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      <CategoryDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />
    </div>
  )
}
