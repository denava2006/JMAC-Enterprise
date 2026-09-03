import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Branch } from '@/hooks/useBranches'
import type { BranchProduct, Category, Product } from '@/lib/posCatalogue'

/**
 * The product master screen. Administrator-only, so cost is shown here and
 * nowhere a POS user can reach.
 *
 * The behaviour worth pinning is that this page never claims a product is
 * sellable: carrying a product at a branch is catalogue intent, and stock
 * arrives in a later phase.
 */

const BRANCH_A = 'b1'
const BRANCH_B = 'b2'

const branches: Branch[] = [
  { id: BRANCH_A, name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: BRANCH_B, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
]

const categories: Category[] = [
  { id: 'gen', name: 'General', normalized_name: 'general', description: null, color: null, icon: null, is_active: true, sort_order: 0 },
  { id: 'c1', name: 'Drinks', normalized_name: 'drinks', description: null, color: null, icon: null, is_active: true, sort_order: 1 },
]

const state: { products: Product[]; branchProducts: BranchProduct[] } = {
  products: [],
  branchProducts: [],
}

const save = vi.fn()
const setCarries = vi.fn()
const setAvailability = vi.fn()

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    name: 'Cola 1.5L',
    category_id: 'c1',
    default_selling_price: 85,
    default_unit_cost: 60,
    image_path: null,
    status: 'active',
    ...overrides,
  }
}

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

vi.mock('@/hooks/usePosCatalogue', () => ({
  usePosProducts: () => ({ data: state.products, isLoading: false }),
  usePosCategories: () => ({ data: categories, isLoading: false }),
  useBranchProducts: () => ({ data: state.branchProducts, isLoading: false }),
  useProductImageUrls: () => ({ data: {}, isLoading: false }),
  useSaveProduct: () => ({ mutate: save, isPending: false }),
  useSetBranchCarries: () => ({ mutate: setCarries, isPending: false }),
  useSetBranchAvailability: () => ({ mutate: setAvailability, isPending: false }),
  useUploadProductImage: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveProductImage: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { default: PosProductsPage } = await import('@/pages/admin/PosProductsPage')

function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'Enter' })
}

afterEach(() => {
  cleanup()
  state.products = []
  state.branchProducts = []
  save.mockReset()
  setCarries.mockReset()
  setAvailability.mockReset()
})

describe('the product list', () => {
  it('shows the product, its category, price and status', () => {
    state.products = [product()]
    render(<PosProductsPage />)

    expect(screen.getByText('Cola 1.5L')).toBeTruthy()
    expect(screen.getByText('Drinks')).toBeTruthy()
    expect(screen.getByText('₱85.00')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
  })

  it('shows cost -- this screen is Administrator-only', () => {
    state.products = [product()]
    render(<PosProductsPage />)
    expect(screen.getByText('₱60.00')).toBeTruthy()
  })

  it('counts the branches carrying each product', () => {
    state.products = [product()]
    state.branchProducts = [
      { branch_id: BRANCH_A, product_id: 'p1', is_available: true, selling_price_override: null },
      { branch_id: BRANCH_B, product_id: 'p1', is_available: false, selling_price_override: null },
    ]
    render(<PosProductsPage />)
    expect(screen.getByText('2 branches')).toBeTruthy()
  })

  it('says a product carried nowhere is carried by no branch', () => {
    state.products = [product()]
    render(<PosProductsPage />)
    expect(screen.getByText('None')).toBeTruthy()
  })
})

describe('the boundary with inventory', () => {
  it('states that carrying a product is not stock and not sellability', () => {
    render(<PosProductsPage />)
    expect(screen.getByText(/does not give it stock/)).toBeTruthy()
    expect(screen.getByText(/Stock, restocking and selling are later phases/)).toBeTruthy()
  })
})

describe('the product dialog', () => {
  it('refuses a duplicate name -- one physical product, one record', () => {
    state.products = [product()]
    render(<PosProductsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New product' }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: ' cola 1.5l ' } })

    expect(screen.getByText(/already exists/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Add product' }) as HTMLButtonElement).disabled).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('refuses negative money', () => {
    render(<PosProductsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New product' }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Water' } })
    fireEvent.change(screen.getByLabelText('Default selling price'), { target: { value: '-5' } })

    expect(screen.getByText(/selling price cannot be negative/)).toBeTruthy()
  })

  it('says the cost is never shown to POS staff', () => {
    render(<PosProductsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New product' }))
    expect(screen.getByText(/Never shown to POS staff/)).toBeTruthy()
  })

  it('starts a new product as a draft', () => {
    render(<PosProductsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New product' }))
    // A product is not offered anywhere until an administrator activates it.
    expect(screen.getByLabelText('Status').textContent).toContain('Draft')
    expect(screen.getByText(/Not offered at any branch yet/)).toBeTruthy()
  })

  it('saves a valid product', () => {
    render(<PosProductsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New product' }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Water 500ml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add product' }))

    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('branch availability', () => {
  it('lets an administrator add a branch to a product', () => {
    state.products = [product()]
    render(<PosProductsPage />)
    openMenu('Actions for Cola 1.5L')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branches' }))

    expect(screen.getByText('Main Office')).toBeTruthy()
    expect(screen.getAllByText('Not carried')).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0])
    expect(setCarries).toHaveBeenCalledWith({
      branchId: BRANCH_A,
      productId: 'p1',
      carries: true,
    })
  })

  it('distinguishes carried-and-offered from carried-but-paused', () => {
    state.products = [product()]
    state.branchProducts = [
      { branch_id: BRANCH_A, product_id: 'p1', is_available: true, selling_price_override: null },
      { branch_id: BRANCH_B, product_id: 'p1', is_available: false, selling_price_override: null },
    ]
    render(<PosProductsPage />)
    openMenu('Actions for Cola 1.5L')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branches' }))

    expect(screen.getByText('Carried and offered')).toBeTruthy()
    expect(screen.getByText('Carried, paused by the branch')).toBeTruthy()
  })

  it('says adding a branch does not give it stock', () => {
    state.products = [product()]
    render(<PosProductsPage />)
    openMenu('Actions for Cola 1.5L')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branches' }))
    expect(screen.getByText(/does not give the branch any stock/)).toBeTruthy()
  })
})
