import type { PosProductStatus } from '@/lib/enums'
import { errorMessage } from '@/lib/errorMessage'

/**
 * Catalogue decisions that are pure, kept out of the hooks so they can be
 * tested without a Supabase client.
 *
 * The database is the authority on all of it: pos_products and
 * pos_product_categories are Administrator-only through RLS, and the
 * POS-facing catalogue comes from SECURITY DEFINER RPCs that never select a
 * cost column. Nothing here is a security boundary.
 */

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const satisfies readonly PosProductStatus[]

export const PRODUCT_STATUS_LABEL: Record<PosProductStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  archived: 'Archived',
}

export const PRODUCT_STATUS_HINT: Record<PosProductStatus, string> = {
  draft: 'Not offered at any branch yet.',
  active: 'Branches that carry it may sell it, once stock exists.',
  archived: 'Withdrawn. Disappears from every branch catalogue.',
}

export const MAX_PRODUCT_NAME_LENGTH = 120
export const MAX_CATEGORY_NAME_LENGTH = 80
export const MAX_CATEGORY_DESCRIPTION_LENGTH = 500

export interface Category {
  id: string
  name: string
  normalized_name: string
  description: string | null
  color: string | null
  icon: string | null
  is_active: boolean
  sort_order: number
}

export interface Product {
  id: string
  name: string
  category_id: string
  default_selling_price: number
  default_unit_cost: number
  image_path: string | null
  status: PosProductStatus
}

export interface BranchProduct {
  branch_id: string
  product_id: string
  is_available: boolean
  selling_price_override: number | null
}

/** The General category is permanent -- delete_pos_category() reassigns
 * orphaned products to it, so the UI must never offer to rename, archive or
 * delete it. Matches protect_general_pos_category(). */
export function isGeneralCategory(category: Pick<Category, 'normalized_name'>): boolean {
  return category.normalized_name === 'general'
}

/** What the database's unique(normalized_name) index compares. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * A branch pays the override when one is set, otherwise the enterprise
 * default. `null` means "use the default" -- 0 is a real price and must not be
 * treated as absent.
 */
export function effectivePrice(
  product: Pick<Product, 'default_selling_price'>,
  branchProduct?: Pick<BranchProduct, 'selling_price_override'> | null
): number {
  return branchProduct?.selling_price_override ?? product.default_selling_price
}

/**
 * Whether a till could offer this today.
 *
 * Deliberately NOT a sellability check: Phase 3 has no stock, and availability
 * does not mean there is any. From Phase 4 this gains "and stock > 0". Naming
 * it `isOfferable` rather than `isSellable` keeps that distinction visible.
 */
export function isOfferable(
  product: Pick<Product, 'status'>,
  branchProduct?: Pick<BranchProduct, 'is_available'> | null
): boolean {
  return product.status === 'active' && branchProduct?.is_available === true
}

export interface CategoryDraft {
  name: string
  description: string
  color: string
}

/** Mirrors the CHECK constraints so the form can point at the field rather
 * than surfacing a constraint name. The database still decides. */
export function validateCategory(
  draft: CategoryDraft,
  existing: Pick<Category, 'id' | 'normalized_name'>[],
  editingId?: string
): string[] {
  const errors: string[] = []
  const name = draft.name.trim()

  if (!name) errors.push('A category needs a name.')
  else if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    errors.push(`A category name cannot be longer than ${MAX_CATEGORY_NAME_LENGTH} characters.`)
  }

  if (draft.description.length > MAX_CATEGORY_DESCRIPTION_LENGTH) {
    errors.push(`A description cannot be longer than ${MAX_CATEGORY_DESCRIPTION_LENGTH} characters.`)
  }

  const color = draft.color.trim()
  if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
    errors.push('A colour must be a six-digit hex value like #1D6FA5.')
  }

  if (name) {
    const clash = existing.find(
      (c) => c.normalized_name === normalizeName(name) && c.id !== editingId
    )
    if (clash) errors.push('A category with that name already exists.')
  }

  return errors
}

export interface ProductDraft {
  name: string
  categoryId: string
  sellingPrice: number
  unitCost: number
}

export function validateProduct(
  draft: ProductDraft,
  existing: Pick<Product, 'id' | 'name'>[],
  editingId?: string
): string[] {
  const errors: string[] = []
  const name = draft.name.trim()

  if (!name) errors.push('A product needs a name.')
  else if (name.length > MAX_PRODUCT_NAME_LENGTH) {
    errors.push(`A product name cannot be longer than ${MAX_PRODUCT_NAME_LENGTH} characters.`)
  }

  if (!draft.categoryId) errors.push('Choose a category.')

  if (!Number.isFinite(draft.sellingPrice) || draft.sellingPrice < 0) {
    errors.push('The selling price cannot be negative.')
  }
  if (!Number.isFinite(draft.unitCost) || draft.unitCost < 0) {
    errors.push('The unit cost cannot be negative.')
  }

  if (name) {
    const clash = existing.find(
      (p) => normalizeName(p.name) === normalizeName(name) && p.id !== editingId
    )
    // One physical product, one record -- the point of an enterprise master.
    if (clash) errors.push('A product with that name already exists.')
  }

  return errors
}

/** `<product_id>/<uuid>.<ext>`, matching the CHECK constraint and the storage
 * policies, which authorise on the first path segment. */
export function productImagePath(productId: string, fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  const raw = lastDot > -1 ? fileName.slice(lastDot + 1) : ''
  const extension = raw.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase() || 'png'
  const unique =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `${productId}/${unique}.${extension}`
}

export function describeCatalogueError(error: unknown): string {
  const message = errorMessage(error)

  if (message.includes('pos_products_normalized_name_key')) {
    return 'A product with that name already exists.'
  }
  if (message.includes('pos_product_categories_normalized_name_key')) {
    return 'A category with that name already exists.'
  }
  if (message.includes('General category')) {
    // The trigger's own sentence is already the right one.
    return message.replace(/^.*?ERROR:\s*/i, '')
  }
  if (message.includes('pos_products_image_path_scoped')) {
    return 'The image must be stored under its own product. Please try the upload again.'
  }
  if (message.includes('row-level security')) {
    return 'Only an Administrator can change the product catalogue.'
  }
  if (message.includes('violates foreign key constraint')) {
    return 'That category or product no longer exists. Refresh the page and try again.'
  }
  if (message.includes('exceeded the maximum allowed size')) {
    return 'The image must be under 5MB.'
  }
  return message || 'Something went wrong. Please try again.'
}

export const peso = (value: number) =>
  `₱${value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
