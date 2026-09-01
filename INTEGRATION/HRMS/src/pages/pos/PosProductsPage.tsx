import * as React from 'react'
import { Link } from 'react-router-dom'
import { Package, Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { useAuth } from '@/contexts/AuthContext'
import { useBranches } from '@/hooks/useBranches'
import { useBranchInventory } from '@/hooks/usePosInventory'
import { useBranchCatalogueManagement, useSetBranchAvailability } from '@/hooks/usePosCatalogue'
import { peso } from '@/lib/posInventory'
import { isPosManagerAt } from '@/lib/portals'

/**
 * What this branch sells, for its POS Manager.
 *
 * Products and Inventory are deliberately two screens with one owner each:
 * this one owns the *catalogue* questions -- what do we sell, at what price, is
 * it on the till right now -- and Inventory owns the *quantity* questions --
 * how many, at what level is it low, what moved. The offered switch lives here
 * and only here. It previously sat on Inventory precisely because there had
 * been two screens showing the same products with no clear owner; splitting by
 * question rather than by table keeps that from happening again.
 *
 * What a manager may do here is narrow on purpose:
 *
 *   * The catalogue is enterprise-owned. pos_products has no branch column, so
 *     editing it would change what every branch sells. Adding a product to THIS
 *     branch is a carry request an Administrator approves -- the same request
 *     engine Inventory uses, not a second one.
 *
 *   * Price is read-only. enforce_branch_product_boundaries refuses a manager's
 *     selling_price_override outright, so an editable field would be a box that
 *     always errors.
 *
 *   * Availability is the one write they hold, and the same trigger refuses
 *     anything else sent with it.
 *
 * No cost, COGS, margin or profit appears here, and none is fetched:
 * get_branch_inventory and get_branch_catalogue_management declare no cost
 * column, so there is nothing to leak even to someone reading the network tab.
 */

const ALL = 'all'

export default function PosProductsPage() {
  const { profile, posAccess } = useAuth()
  const { data: branches } = useBranches()
  const isAdministrator = profile?.role === 'admin'

  const myBranches = React.useMemo(() => {
    const active = (branches ?? []).filter((b) => b.is_active)
    return isAdministrator ? active : active.filter((b) => posAccess.branchIds.includes(b.id))
  }, [branches, posAccess.branchIds, isAdministrator])

  const [branchId, setBranchId] = React.useState('')
  React.useEffect(() => {
    if (!branchId && myBranches.length > 0) setBranchId(myBranches[0].id)
  }, [branchId, myBranches])

  const { data: rows, isLoading } = useBranchInventory(branchId || undefined)
  const { data: priced } = useBranchCatalogueManagement(branchId || undefined)
  const setAvailability = useSetBranchAvailability()

  // The same rule the Inventory screen uses: managing one branch says nothing
  // about another, and the database refuses the write regardless.
  const managesThisBranch = isAdministrator || isPosManagerAt(posAccess, branchId)

  // Price comes from the catalogue RPC; stock from the inventory RPC. Neither
  // pretends to own the other's data.
  const priceByProduct = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const row of priced ?? []) map.set(row.product_id, Number(row.selling_price))
    return map
  }, [priced])

  const [search, setSearch] = React.useState('')
  const [filter, setFilter] = React.useState(ALL)

  const visible = React.useMemo(() => {
    const term = search.trim().toLowerCase()
    return [...(rows ?? [])]
      .filter((r) => {
        if (filter === 'out' && r.quantity_on_hand > 0) return false
        if (filter === 'offered' && !r.is_available) return false
        if (filter === 'stopped' && r.is_available) return false
        if (!term) return true
        return (
          r.product_name.toLowerCase().includes(term) ||
          r.category_name.toLowerCase().includes(term)
        )
      })
      .sort((a, b) => a.product_name.localeCompare(b.product_name))
  }, [rows, search, filter])

  const outOfStock = (rows ?? []).filter((r) => r.quantity_on_hand === 0).length

  if (myBranches.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          You are not assigned to a branch yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">Products</h2>
          <p className="text-sm text-muted-foreground">
            What this branch sells, and whether the till is offering it. Prices and the
            enterprise catalogue are set by an Administrator.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {myBranches.length > 1 && (
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="w-52" aria-label="Branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {myBranches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {managesThisBranch && (
            <Button asChild>
              <Link to="/pos/requests">
                <Plus className="h-4 w-4" />
                Add a product
              </Link>
            </Button>
          )}
        </div>
      </div>

      {outOfStock > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-sm text-foreground">
              {outOfStock} {outOfStock === 1 ? 'product is' : 'products are'} out of stock.{' '}
              <Link to="/pos/requests" className="font-medium underline">
                Request stock
              </Link>{' '}
              — approving a request does not add stock; receiving does.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products or categories..."
            className="pl-9"
            aria-label="Search products"
          />
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="sm:w-48" aria-label="Filter products">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All products</SelectItem>
            <SelectItem value="out">Out of stock</SelectItem>
            <SelectItem value="offered">On the till</SelectItem>
            <SelectItem value="stopped">Stopped</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex flex-col gap-2 p-6">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {(rows ?? []).length === 0
                ? 'This branch does not carry any products yet.'
                : 'No products match those filters.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>On the till</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => {
                  const price = priceByProduct.get(row.product_id)
                  return (
                    <TableRow key={row.product_id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">{row.product_name}</span>
                          <span className="text-xs text-muted-foreground">{row.category_name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="tabular-nums text-foreground">
                            {price === undefined ? '—' : peso(price)}
                          </span>
                          {/* Stated once rather than shown as a disabled input
                              that looks like something is broken. */}
                          <span className="text-[10px] text-muted-foreground">
                            set by Administrator
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.quantity_on_hand === 0 ? (
                          <Badge variant="destructive">Out of stock</Badge>
                        ) : row.is_low_stock ? (
                          <div className="flex items-center gap-2">
                            <span className="tabular-nums text-foreground">
                              {row.quantity_on_hand}
                            </span>
                            <Badge variant="warning">Low</Badge>
                          </div>
                        ) : (
                          <span className="tabular-nums text-foreground">
                            {row.quantity_on_hand}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <Switch
                            checked={row.is_available}
                            aria-label={`Offer ${row.product_name} at this branch`}
                            disabled={!managesThisBranch || row.product_status !== 'active'}
                            onCheckedChange={(isAvailable) =>
                              setAvailability.mutate({
                                branchId,
                                productId: row.product_id,
                                isAvailable,
                              })
                            }
                          />
                          <span className="text-xs text-muted-foreground">
                            {row.is_available ? 'Offered' : 'Stopped'}
                          </span>
                          {row.product_status !== 'active' && (
                            <Badge variant="warning">Not active enterprise-wide</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {managesThisBranch && (
                          <Button asChild size="sm" variant="outline">
                            <Link to="/pos/requests">Request stock</Link>
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
