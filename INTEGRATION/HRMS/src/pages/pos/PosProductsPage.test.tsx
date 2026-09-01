import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { InventoryRow } from '@/lib/posInventory'

/**
 * The branch's Products screen.
 *
 * Two things are worth pinning here, and they pull in opposite directions:
 * a manager must be able to stop offering something on their own till, and
 * must not be able to reach anything that belongs to the enterprise -- price,
 * cost, or another branch. The database enforces both independently
 * (supabase/tests/pos_manager_modules_rls.sql); this proves the screen agrees
 * rather than quietly offering a control that always errors.
 */

const BRANCH_A = 'b1'

const state: {
  rows: InventoryRow[]
  priced: { product_id: string; selling_price: number }[]
  role: 'admin' | 'employee'
  assignments: { branchId: string; role: 'manager' | 'cashier' }[]
} = { rows: [], priced: [], role: 'employee', assignments: [{ branchId: BRANCH_A, role: 'manager' }] }

const setAvailability = vi.fn()

function row(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    product_id: 'p1',
    product_name: 'Cola 1.5L',
    category_name: 'Drinks',
    quantity_on_hand: 12,
    low_stock_threshold: 5,
    is_low_stock: false,
    is_available: true,
    product_status: 'active',
    ...overrides,
  }
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: state.role },
    posAccess: {
      hasAccess: true,
      branchIds: state.assignments.map((a) => a.branchId),
      assignments: state.assignments,
    },
  }),
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({
    data: [{ id: BRANCH_A, name: 'Cavite Branch', is_active: true }],
    isLoading: false,
  }),
}))

vi.mock('@/hooks/usePosInventory', () => ({
  useBranchInventory: () => ({ data: state.rows, isLoading: false }),
}))

vi.mock('@/hooks/usePosCatalogue', () => ({
  useBranchCatalogueManagement: () => ({ data: state.priced, isLoading: false }),
  useSetBranchAvailability: () => ({ mutate: setAvailability, isPending: false }),
  // The Add Product dialog and the row thumbnails. Empty by default: a product
  // without a picture is still a product, and the page must render either way.
  useCarryableCatalogue: () => ({ data: [], isLoading: false }),
  useAddProductToBranch: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateBranchProduct: () => ({ mutate: vi.fn(), isPending: false }),
  useCreatePosCategory: () => ({ mutate: vi.fn(), isPending: false }),
  usePosCategories: () => ({ data: [] }),
  // Empty on purpose: a product without a picture is still a product, and
  // the row must render either way.
  useProductImageUrls: () => ({ data: {} }),
}))

const { default: PosProductsPage } = await import('@/pages/pos/PosProductsPage')

const renderPage = () =>
  render(
    <MemoryRouter>
      <PosProductsPage />
    </MemoryRouter>
  )

afterEach(() => {
  cleanup()
  state.rows = []
  state.priced = []
  state.role = 'employee'
  state.assignments = [{ branchId: BRANCH_A, role: 'manager' }]
  setAvailability.mockReset()
})

describe('what a POS manager can do here', () => {
  it('stops and resumes offering a product at their own branch', () => {
    state.rows = [row({ is_available: true })]
    renderPage()

    fireEvent.click(screen.getByRole('switch', { name: 'Offer Cola 1.5L at this branch' }))
    expect(setAvailability).toHaveBeenCalledWith({
      branchId: BRANCH_A,
      productId: 'p1',
      isAvailable: false,
    })
  })

  it('will not offer a product that is not active enterprise-wide', () => {
    state.rows = [row({ product_status: 'archived' })]
    renderPage()
    const toggle = screen.getByRole('switch', { name: 'Offer Cola 1.5L at this branch' })
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Not active enterprise-wide')).toBeTruthy()
  })

  it("says the price shown is this branch's", () => {
    // The caption used to read "set by Administrator", which stopped being true
    // when the branch price became the manager's. A label that misstates who
    // owns a number is worse than no label.
    state.rows = [row()]
    state.priced = [{ product_id: 'p1', selling_price: 65 }]
    renderPage()

    expect(screen.getByText('this branch')).toBeTruthy()
    expect(screen.queryByText('set by Administrator')).toBeNull()
  })

  it('never shows cost, COGS, margin or profit', () => {
    state.rows = [row()]
    state.priced = [{ product_id: 'p1', selling_price: 65 }]
    renderPage()
    const text = document.body.textContent ?? ''
    for (const word of ['Cost', 'COGS', 'Margin', 'Profit']) {
      expect(text).not.toContain(word)
    }
  })
})

describe('the new product to stocked product path', () => {
  it('marks a carried product with no stock as out of stock', () => {
    // What an approved carry request leaves behind: listed, zero on hand.
    state.rows = [row({ quantity_on_hand: 0, is_available: false })]
    renderPage()
    expect(screen.getByText('Out of stock')).toBeTruthy()
  })

  it('points an out-of-stock branch at the request engine, not at a stock field', () => {
    state.rows = [row({ quantity_on_hand: 0 })]
    renderPage()

    const links = screen.getAllByRole('link', { name: 'Request stock' })
    expect(links.length).toBeGreaterThan(0)
    expect(links[0].getAttribute('href')).toBe('/pos/requests')
    // The screen must offer no way to type a new quantity.
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })

  it('says plainly that approving a request is not receiving stock', () => {
    state.rows = [row({ quantity_on_hand: 0 })]
    renderPage()
    expect(screen.getByText(/approving a request does not add stock/i)).toBeTruthy()
  })

  it('lets a manager add a product here rather than sending them to ask', () => {
    // Reversed deliberately. Adding a product used to be a request an
    // Administrator answered, which meant a new branch could not open without
    // somebody else driving. Deciding what this branch sells is the manager's
    // job; what they still cannot do is conjure stock, which the checks above
    // cover.
    state.rows = [row()]
    renderPage()

    const button = screen.getByRole('button', { name: /Add Product/i })
    expect(button).toBeTruthy()
    expect(button.getAttribute('href')).toBeNull()
  })

  it('offers no product controls to a cashier', () => {
    state.assignments = [{ branchId: BRANCH_A, role: 'cashier' }]
    state.rows = [row()]
    renderPage()
    expect(screen.queryByRole('button', { name: /Add Product/i })).toBeNull()
  })
})

describe('branch scope', () => {
  it('offers no controls for a branch the account only cashiers at', () => {
    // Managing one branch says nothing about another. The database refuses the
    // write regardless; the screen should not invite it.
    state.assignments = [{ branchId: BRANCH_A, role: 'cashier' }]
    state.rows = [row()]
    renderPage()

    const toggle = screen.getByRole('switch', { name: 'Offer Cola 1.5L at this branch' })
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('link', { name: 'Request stock' })).toBeNull()
  })

  it('explains itself when the account holds no branch at all', () => {
    state.assignments = []
    renderPage()
    expect(screen.getByText(/not assigned to a branch/i)).toBeTruthy()
  })
})
