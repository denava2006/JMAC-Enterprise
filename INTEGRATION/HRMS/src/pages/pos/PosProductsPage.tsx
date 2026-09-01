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
import {
  useBranchCatalogueManagement,
  useSetBranchAvailability,
  useCarryableCatalogue,
  useAddProductToBranch,
  useCreateBranchProduct,
  useCreatePosCategory,
  useProductImageUrls,
  useSetProductImage,
  useImportProductImage,
  useUpdateProductDetails,
  useSetBranchSellingPrice,
  usePosCategories,
} from '@/hooks/usePosCatalogue'
import { Label } from '@/components/ui/label'
import { MoneyInput } from '@/components/MoneyInput'
import {
  ProductImagePicker,
  GLOBAL_FIELD_NOTICE,
  globalNoticeClass,
  type ImageChoice,
} from '@/components/pos/ProductImagePicker'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
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


/**
 * Putting something on this branch's shelves.
 *
 * Search first, create second, in that order deliberately. The catalogue is
 * company-wide: two branches inventing "Coke 1.5L" separately would be two
 * products, two price lists and two sets of numbers that never reconcile. So
 * the manager sees what already exists before they are offered a blank form,
 * and a name that collides is answered by offering the existing product rather
 * than by refusing.
 *
 * Neither path creates stock. A branch that has agreed to sell something still
 * has none of it until receiving says otherwise, which is why both routes end
 * at zero and not offered.
 */
function AddProductDialog({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const [query, setQuery] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [name, setName] = React.useState('')
  const [categoryId, setCategoryId] = React.useState('')
  const [price, setPrice] = React.useState('')
  const [newCategory, setNewCategory] = React.useState('')
  const [image, setImage] = React.useState<ImageChoice>({ kind: 'none' })

  const { data: carryable, isLoading } = useCarryableCatalogue(branchId)
  const { data: categories } = usePosCategories()
  const addToBranch = useAddProductToBranch()
  const createProduct = useCreateBranchProduct()
  const createCategory = useCreatePosCategory()
  const setProductImage = useSetProductImage()
  const importImage = useImportProductImage()

  const matches = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = carryable ?? []
    if (!q) return rows.slice(0, 25)
    return rows.filter((r) => r.product_name.toLowerCase().includes(q)).slice(0, 25)
  }, [carryable, query])

  const priceValue = Number(price)
  const canCreate = name.trim().length > 0 && !!categoryId && priceValue > 0

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{creating ? 'Create a product' : 'Add a product to this branch'}</DialogTitle>
          <DialogDescription>
            {creating
              ? 'This adds the product to the company catalogue and starts carrying it here.'
              : 'Search what the company already sells. Nothing here creates stock.'}
          </DialogDescription>
        </DialogHeader>

        {!creating ? (
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              placeholder="Search the catalogue…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="max-h-64 overflow-y-auto rounded-md border border-border">
              {isLoading ? (
                <p className="p-3 text-sm text-muted-foreground">Loading…</p>
              ) : matches.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  {query.trim()
                    ? 'Nothing in the catalogue matches that.'
                    : 'This branch already carries everything in the catalogue.'}
                </p>
              ) : (
                matches.map((row) => (
                  <div
                    key={row.product_id}
                    className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{row.product_name}</p>
                      <p className="text-xs text-muted-foreground">{row.category_name}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      loading={addToBranch.isPending}
                      onClick={() =>
                        addToBranch.mutate({ branchId, productId: row.product_id }, { onSuccess: onClose })
                      }
                    >
                      Add to Branch
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="text-xs text-muted-foreground">Not in the list?</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setName(query.trim())
                  setCreating(true)
                }}
              >
                Create New Product
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new_product_name">Product name</Label>
              <Input
                id="new_product_name"
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new_product_category">Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="new_product_category">
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  {(categories ?? [])
                    .filter((c) => c.is_active)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>

              {/* So an empty branch is never a dead end: General always exists,
                  and a manager who needs a different shelf can name one here
                  rather than waiting for an Administrator. */}
              <div className="flex items-center gap-2 pt-1">
                <Input
                  placeholder="or create a category…"
                  value={newCategory}
                  maxLength={80}
                  onChange={(e) => setNewCategory(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={newCategory.trim().length === 0}
                  loading={createCategory.isPending}
                  onClick={() =>
                    createCategory.mutate(newCategory.trim(), {
                      onSuccess: (id) => {
                        setCategoryId(id)
                        setNewCategory('')
                      },
                    })
                  }
                >
                  Create
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new_product_price">Selling price at this branch</Label>
              <MoneyInput id="new_product_price" value={price} onValueChange={setPrice} />
            </div>

            {/* No Import button here: an import needs a product id to file the
                result against, and the product does not exist yet. The link is
                held and imported the moment it does. */}
            <ProductImagePicker value={image} onChange={setImage} />

            <p className="text-xs text-muted-foreground">
              The product starts with no stock and is not offered until you enable it.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={creating ? () => setCreating(false) : onClose}>
            {creating ? 'Back' : 'Cancel'}
          </Button>
          {creating && (
            <Button
              disabled={!canCreate}
              loading={createProduct.isPending}
              onClick={() =>
                createProduct.mutate(
                  { branchId, name: name.trim(), categoryId, sellingPrice: priceValue },
                  {
                    onSuccess: async (productId) => {
                      // The product is created and carried; the image is a
                      // second step against an id that now exists. If it fails
                      // the product still stands -- losing a created product
                      // because its photo would not download is a worse outcome
                      // than a product with no photo, which Edit can fix.
                      try {
                        if (image.kind === 'file') {
                          await setProductImage.mutateAsync({ productId, file: image.file })
                        } else if (image.kind === 'url') {
                          await importImage.mutateAsync({ productId, imageUrl: image.url })
                        }
                      } catch {
                        toast.message('Product created, but the image could not be added.', {
                          description: 'You can add it from Edit product.',
                        })
                      }
                      onClose()
                    },
                  }
                )
              }
            >
              Create Product
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


/**
 * Editing a product.
 *
 * Two kinds of field sit here and they behave differently, so the dialog says
 * which is which rather than leaving a manager to discover that renaming a
 * product renamed it for six other branches. Name, category and image are the
 * company's; the selling price is this branch's.
 */
function EditProductDialog({
  branchId,
  product,
  currentImageUrl,
  onClose,
}: {
  branchId: string
  product: {
    product_id: string
    product_name: string
    category_id: string | null
    selling_price: number
  }
  currentImageUrl: string | null
  onClose: () => void
}) {
  const [name, setName] = React.useState(product.product_name)
  const [categoryId, setCategoryId] = React.useState(product.category_id ?? '')
  const [image, setImage] = React.useState<ImageChoice>({ kind: 'none' })
  const [price, setPrice] = React.useState(String(product.selling_price))

  const { data: categories } = usePosCategories()
  const updateDetails = useUpdateProductDetails()
  const setBranchPrice = useSetBranchSellingPrice()
  const setProductImage = useSetProductImage()
  const importImage = useImportProductImage()

  const priceValue = Number(price)
  const priceChanged = Number.isFinite(priceValue) && priceValue !== Number(product.selling_price)
  const detailsChanged =
    name.trim() !== product.product_name || categoryId !== (product.category_id ?? '')
  const canSave =
    name.trim().length > 0 &&
    !!categoryId &&
    priceValue >= 0 &&
    (detailsChanged || priceChanged || image.kind !== 'none')

  const save = async () => {
    if (detailsChanged) {
      await updateDetails.mutateAsync({ productId: product.product_id, name: name.trim(), categoryId })
    }
    if (priceChanged) {
      await setBranchPrice.mutateAsync({
        branchId,
        productId: product.product_id,
        price: priceValue,
      })
    }
    if (image.kind === 'file') {
      await setProductImage.mutateAsync({ productId: product.product_id, file: image.file })
    } else if (image.kind === 'url') {
      await importImage.mutateAsync({ productId: product.product_id, imageUrl: image.url })
    }
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit product</DialogTitle>
          <DialogDescription>{product.product_name}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <p className={globalNoticeClass}>{GLOBAL_FIELD_NOTICE}</p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit_product_name">Product name</Label>
            <Input
              id="edit_product_name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit_product_category">Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger id="edit_product_category">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {(categories ?? [])
                  .filter((c) => c.is_active)
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {/* The one field on this screen that belongs to this branch alone,
              placed under the shared ones so the difference is visible rather
              than only stated. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit_product_price">Selling price at this branch</Label>
            <MoneyInput id="edit_product_price" value={price} onValueChange={setPrice} />
            <p className="text-xs text-muted-foreground">
              Only this branch. Other branches keep their own price.
            </p>
          </div>

          {/* The product exists, so a link can be imported and previewed as the
              stored copy straight away. */}
          <ProductImagePicker
            value={image}
            onChange={setImage}
            currentImageUrl={currentImageUrl}
            importing={importImage.isPending}
            onImportNow={(url) =>
              importImage.mutate(
                { productId: product.product_id, imageUrl: url },
                { onSuccess: () => setImage({ kind: 'none' }) }
              )
            }
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            loading={updateDetails.isPending || setProductImage.isPending || setBranchPrice.isPending}
            onClick={save}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
  const [adding, setAdding] = React.useState(false)
  const [editing, setEditing] = React.useState<string | null>(null)
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

  // Same source as the price: the catalogue knows what a product looks like,
  // the inventory RPC knows how many there are. Neither owns the other's data.
  const imageByProduct = React.useMemo(() => {
    const map = new Map<string, string | null>()
    for (const row of priced ?? []) map.set(row.product_id, row.image_path)
    return map
  }, [priced])

  const { data: imageUrls } = useProductImageUrls((priced ?? []).map((r) => r.image_path))

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
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" />
              Add Product
            </Button>
          )}
        </div>
      </div>

      {adding && branchId && (
        <AddProductDialog branchId={branchId} onClose={() => setAdding(false)} />
      )}

      {editing && branchId && (() => {
        const row = (priced ?? []).find((r) => r.product_id === editing)
        if (!row) return null
        return (
          <EditProductDialog
            branchId={branchId}
            product={{
              product_id: row.product_id,
              product_name: row.name,
              category_id: row.category_id,
              selling_price: Number(row.selling_price),
            }}
            currentImageUrl={imageUrls?.[row.image_path ?? ''] ?? null}
            onClose={() => setEditing(null)}
          />
        )
      })()}

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
                        <div className="flex items-center gap-3">
                          {/* A product without a picture is still a product --
                              the placeholder keeps the row aligned rather than
                              implying something is wrong. */}
                          {imageUrls?.[imageByProduct.get(row.product_id) ?? ''] ? (
                            <img
                              src={imageUrls[imageByProduct.get(row.product_id) ?? '']}
                              alt=""
                              className="h-9 w-9 shrink-0 rounded object-cover"
                            />
                          ) : (
                            <span
                              aria-hidden="true"
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground"
                            >
                              <Package className="h-4 w-4" />
                            </span>
                          )}
                          <div className="flex flex-col">
                            <span className="font-medium text-foreground">{row.product_name}</span>
                            <span className="text-xs text-muted-foreground">{row.category_name}</span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="tabular-nums text-foreground">
                            {price === undefined ? '—' : peso(price)}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {managesThisBranch ? 'this branch' : 'set by Administrator'}
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
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditing(row.product_id)}
                            >
                              Edit
                            </Button>
                            <Button asChild size="sm" variant="outline">
                              <Link to="/pos/requests">Request stock</Link>
                            </Button>
                          </div>
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
