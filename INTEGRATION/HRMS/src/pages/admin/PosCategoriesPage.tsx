import * as React from 'react'
import { ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  CategoryActionsMenu,
  CategoryDialogShell,
  ProductCategoriesShell,
  ProductCategoryCard,
  type ProductCategoryView,
} from '@/components/pos/ProductCategories'
import {
  usePosCategories,
  usePosProducts,
  useDeleteCategory,
  useReorderCategory,
  useSaveCategory,
  useSetCategoryActive,
} from '@/hooks/usePosCatalogue'
import { isGeneralCategory, validateCategory, type Category } from '@/lib/posCatalogue'

/**
 * The product category taxonomy.
 *
 * Global, not per branch. Products are enterprise-level, and a product has
 * exactly one category, so a branch-scoped taxonomy could not describe them.
 * That also means renaming a category here changes it for every branch.
 *
 * This is the visual source of truth for Product Categories, and it now says so
 * in code: the shell, the card and the dialog frame live in
 * components/pos/ProductCategories and the POS Manager's page composes the same
 * three. What stays here is what is actually the Administrator's -- reordering,
 * archiving, deleting, and the description and colour fields.
 */

function CategoryDialog({
  open,
  onOpenChange,
  category,
  categories,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  category: Category | null
  categories: Category[]
}) {
  const save = useSaveCategory()
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [color, setColor] = React.useState('')
  const [touched, setTouched] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setName(category?.name ?? '')
    setDescription(category?.description ?? '')
    setColor(category?.color ?? '')
    setTouched(false)
  }, [open, category])

  const errors = validateCategory({ name, description, color }, categories, category?.id)
  // Not until they have typed something. New category opened on an empty form
  // and greeted the Administrator with "A category needs a name." -- an error
  // about something they had not done yet. The manager's dialog never did
  // this, which made it the one visible behavioural difference left between
  // the two once they shared a frame. Submit stays disabled either way.
  const shownErrors = touched ? errors : []

  return (
    <CategoryDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={category ? 'Edit category' : 'New category'}
      description="Categories are shared by every branch. Renaming one changes it everywhere."
      submitLabel={category ? 'Save changes' : 'Add category'}
      submitDisabled={errors.length > 0}
      pending={save.isPending}
      onSubmit={() =>
        save.mutate(
          { id: category?.id, name, description, color },
          { onSuccess: () => onOpenChange(false) }
        )
      }
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="category_name">
          Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="category_name"
          value={name}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value)
            setTouched(true)
          }}
          placeholder="Drinks"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="category_description">Description</Label>
        <Textarea
          id="category_description"
          value={description}
          maxLength={500}
          onChange={(e) => {
            setDescription(e.target.value)
            setTouched(true)
          }}
          placeholder="Optional"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="category_color">Colour</Label>
        <Input
          id="category_color"
          value={color}
          onChange={(e) => {
            setColor(e.target.value)
            setTouched(true)
          }}
          placeholder="#1D6FA5"
        />
      </div>
      {shownErrors.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          {shownErrors.map((error) => (
            <li key={error} className="text-xs text-destructive">
              {error}
            </li>
          ))}
        </ul>
      )}
    </CategoryDialogShell>
  )
}

function DeleteCategoryDialog({
  category,
  categories,
  productCount,
  onClose,
}: {
  category: Category | null
  categories: Category[]
  productCount: number
  onClose: () => void
}) {
  const remove = useDeleteCategory()
  const [replacementId, setReplacementId] = React.useState('')

  React.useEffect(() => {
    if (category) setReplacementId('')
  }, [category])

  if (!category) return null

  // pos_products.category_id is NOT NULL, so a category holding products cannot
  // simply vanish -- the RPC refuses without somewhere to put them.
  const options = categories.filter((c) => c.id !== category.id && c.is_active)
  const needsReplacement = productCount > 0

  return (
    <CategoryDialogShell
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${category.name}?`}
      description={
        needsReplacement
          ? productCount === 1
            ? '1 product uses this category. Choose where it should go.'
            : `${productCount} products use this category. Choose where they should go.`
          : 'This category has no products. Deleting it cannot be undone.'
      }
      submitLabel="Delete category"
      submitVariant="destructive"
      submitDisabled={needsReplacement && !replacementId}
      pending={remove.isPending}
      onSubmit={() =>
        remove.mutate(
          { id: category.id, replacementId: needsReplacement ? replacementId : null },
          { onSuccess: onClose }
        )
      }
    >
      {needsReplacement && (
        <div className="flex flex-col gap-1.5">
          <Label>Move products to</Label>
          <Select value={replacementId} onValueChange={setReplacementId}>
            <SelectTrigger aria-label="Replacement category">
              <SelectValue placeholder="Choose a category" />
            </SelectTrigger>
            <SelectContent>
              {options.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </CategoryDialogShell>
  )
}

export default function PosCategoriesPage() {
  const { data: categories, isLoading } = usePosCategories()
  const { data: products } = usePosProducts()
  const reorder = useReorderCategory()
  const setActive = useSetCategoryActive()
  const [editing, setEditing] = React.useState<Category | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState<Category | null>(null)

  const list = categories ?? []
  const countFor = (categoryId: string) =>
    (products ?? []).filter((p) => p.category_id === categoryId).length

  /** The taxonomy row, as the shared card wants it. Enterprise-wide, so no
   *  branchUsage -- there is no branch in view to report on. */
  const viewOf = (category: Category): ProductCategoryView => ({
    id: category.id,
    name: category.name,
    description: category.description,
    color: category.color,
    permanent: isGeneralCategory(category),
    archived: !category.is_active,
    productCount: countFor(category.id),
  })

  return (
    <>
      <ProductCategoriesShell
        description="One taxonomy shared by every branch. The order here is the order a till shows them in."
        loading={isLoading}
        action={
          <Button
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus className="h-4 w-4" />
            New category
          </Button>
        }
      >
        {list.map((category, index) => (
          <ProductCategoryCard
            key={category.id}
            category={viewOf(category)}
            actions={
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Move ${category.name} up`}
                  disabled={index === 0}
                  onClick={() => reorder.mutate({ id: category.id, direction: -1 })}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Move ${category.name} down`}
                  disabled={index === list.length - 1}
                  onClick={() => reorder.mutate({ id: category.id, direction: 1 })}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <CategoryActionsMenu categoryName={category.name}>
                  <DropdownMenuItem
                    onClick={() => {
                      setEditing(category)
                      setDialogOpen(true)
                    }}
                  >
                    Edit
                  </DropdownMenuItem>
                  {/* General is the guaranteed home for orphaned products, so
                      it can be neither archived nor deleted. The database
                      refuses too -- this only avoids offering it. Edit stays:
                      the trigger blocks its name and its archiving, not its
                      description or colour. */}
                  {!isGeneralCategory(category) && (
                    <>
                      <DropdownMenuItem
                        onClick={() =>
                          setActive.mutate({ id: category.id, isActive: !category.is_active })
                        }
                      >
                        {category.is_active ? 'Archive' : 'Restore'}
                      </DropdownMenuItem>
                      <DropdownMenuItem destructive onClick={() => setDeleting(category)}>
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </CategoryActionsMenu>
              </>
            }
          />
        ))}
      </ProductCategoriesShell>

      <CategoryDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditing(null)
        }}
        category={editing}
        categories={list}
      />

      <DeleteCategoryDialog
        category={deleting}
        categories={list}
        productCount={deleting ? countFor(deleting.id) : 0}
        onClose={() => setDeleting(null)}
      />
    </>
  )
}
