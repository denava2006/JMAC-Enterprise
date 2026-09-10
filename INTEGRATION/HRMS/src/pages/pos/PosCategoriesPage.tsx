import * as React from 'react'
import { Link } from 'react-router-dom'
import { Info } from 'lucide-react'
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
import { ManagerBranchPicker, useManagerBranch } from '@/components/pos/ManagerBranchPicker'
import { useBranchCategorySummary } from '@/hooks/usePosCategorySummary'

/**
 * Categories, as a branch manager needs them.
 *
 * This is a read-only operational summary, not a taxonomy editor, and the
 * difference is the whole point of the module. Phase 3 made categories a global
 * enterprise taxonomy: `pos_product_categories` carries a single `is_admin()`
 * policy, `delete_pos_category` and `reorder_pos_category` check `is_admin()`
 * internally, and `protect_general_pos_category` guards General. The standalone
 * POS gave managers create, rename, archive, reorder and a bulk product-move
 * picker on top of exactly this screen; none of it is ported, and this page
 * renders no control that would attempt it.
 *
 * What it is for: understanding your own catalogue -- what you carry under each
 * heading, how much of it you are actually offering, and where the gaps are.
 * Acting on any of that happens on Inventory, which is one click away per row.
 * Nothing here mutates stock.
 */
export default function PosCategoriesPage() {
  const { branchId, setBranchId, managed, isLoading: branchesLoading } = useManagerBranch()
  const { data: rows, isLoading } = useBranchCategorySummary(branchId || undefined)

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
          <ManagerBranchPicker branchId={branchId} onChange={setBranchId} branches={managed} />
        }
      />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Categories are defined once for the whole business, so they are read-only here — an
          Administrator adds and renames them. The counts are your branch&apos;s: pausing a product
          or setting its low-stock level is done on Inventory.
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
                      <Link
                        to={`/pos/stock?branch=${branchId}`}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        Open in Inventory
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  )
}
