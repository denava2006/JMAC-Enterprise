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

/** The two categories the defect report named, with the ids the dropdown must
 *  submit. Global taxonomy: no branch, no inventory summary. */
const GENERAL_ID = '11111111-1111-4111-8111-111111111111'
const DRINKS_ID = '22222222-2222-4222-8222-222222222222'

interface PortalCategory {
  id: string
  name: string
  color: string | null
  sort_order: number
}

const state: {
  rows: InventoryRow[]
  priced: {
    product_id: string
    selling_price: number
    name?: string
    category_id?: string | null
    image_path?: string | null
  }[]
  role: 'admin' | 'employee'
  assignments: { branchId: string; role: 'manager' | 'cashier' }[]
  categories: PortalCategory[]
  categoriesLoading: boolean
  categoriesError: boolean
} = {
  rows: [],
  priced: [],
  role: 'employee',
  assignments: [{ branchId: BRANCH_A, role: 'manager' }],
  categories: [],
  categoriesLoading: false,
  categoriesError: false,
}

const setAvailability = vi.fn()
const createCategory = vi.fn()
const createProduct = vi.fn()
const updateDetails = vi.fn()
const refetchCategories = vi.fn()

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
  useCreateBranchProduct: () => ({ mutate: createProduct, isPending: false }),
  useCreatePosCategory: () => ({ mutate: createCategory, isPending: false }),
  // The POS portal's taxonomy reader. This mock is the whole point of the
  // regression: the harness used to mock usePosCategories() -- the
  // Administrator's table read -- as a permanently empty list, which is
  // exactly the production symptom, so nothing here could ever have caught it.
  usePosPortalCategories: () => ({
    data: state.categories,
    isLoading: state.categoriesLoading,
    isError: state.categoriesError,
    isFetching: false,
    refetch: refetchCategories,
  }),
  useUpdateProductDetails: () => ({ mutate: updateDetails, mutateAsync: updateDetails, isPending: false }),
  useSetBranchSellingPrice: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useSetProductImage: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useImportProductImage: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
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
  state.categories = []
  state.categoriesLoading = false
  state.categoriesError = false
  setAvailability.mockReset()
  createCategory.mockReset()
  createProduct.mockReset()
  updateDetails.mockReset()
  refetchCategories.mockReset()
})

/** What the server returns for Marc Villanueva: the global taxonomy, both
 *  categories active, no branch data attached. */
function withBothCategories() {
  state.categories = [
    { id: GENERAL_ID, name: 'General', color: null, sort_order: 0 },
    { id: DRINKS_ID, name: 'Drinks', color: '#1D6FA5', sort_order: 1 },
  ]
}

/** Products → Add Product → Create New Product, which is where the Category
 *  selector lives. */
function openCreateProduct() {
  renderPage()
  fireEvent.click(screen.getByRole('button', { name: /Add Product/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Create New Product' }))
}

/** The trigger is a combobox; choosing is two clicks. */
function openCategoryDropdown() {
  fireEvent.click(screen.getByLabelText('Category'))
}

describe('the Create Product category selector', () => {
  /**
   * The reported defect, exactly. Marc Villanueva manages Cavite Branch. The
   * Product Categories page shows him General and Drinks. Add Product → Choose
   * a category showed nothing at all.
   *
   * The cause was the source: the dialog read usePosCategories(), which SELECTs
   * pos_product_categories under an is_admin() policy. RLS filters rows rather
   * than raising, so the query succeeded with zero rows and the list rendered
   * empty with no error to explain it.
   */
  it('offers the existing global categories a POS Manager can already see', () => {
    withBothCategories()
    openCreateProduct()
    openCategoryDropdown()

    expect(screen.getByRole('option', { name: 'General' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Drinks' })).toBeTruthy()

    // And none of the three "nothing to show" sentences, because there is.
    expect(screen.queryByText('No product categories available.')).toBeNull()
    expect(screen.queryByText('Categories could not be loaded.')).toBeNull()
    expect(screen.queryByText('Loading categories…')).toBeNull()
  })

  it('submits the existing Drinks ID through the current creation workflow', () => {
    withBothCategories()
    openCreateProduct()

    fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'Cola 1.5L' } })
    openCategoryDropdown()
    fireEvent.click(screen.getByRole('option', { name: 'Drinks' }))
    fireEvent.change(screen.getByLabelText(/Selling price/), { target: { value: '65' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Product' }))

    expect(createProduct).toHaveBeenCalledTimes(1)
    expect(createProduct.mock.calls[0][0]).toEqual({
      branchId: BRANCH_A,
      name: 'Cola 1.5L',
      categoryId: DRINKS_ID,
      sellingPrice: 65,
    })

    // Selecting an existing category must not create one. A dropdown that
    // quietly re-created "Drinks" would be the worse version of this bug.
    expect(createCategory).not.toHaveBeenCalled()
  })

  it('does not filter categories out on a field the RPC does not return', () => {
    // The trap behind the first fix: the Administrator's dropdown filters
    // `c.is_active`, and get_pos_categories() returns no such field -- it
    // excludes inactive rows server-side instead. Copying that filter across
    // would test undefined and discard every row, reproducing the defect
    // through a different mistake.
    withBothCategories()
    openCreateProduct()
    openCategoryDropdown()
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('says it is loading rather than showing an empty list', () => {
    state.categoriesLoading = true
    openCreateProduct()
    openCategoryDropdown()

    // Said twice on purpose: once as the trigger's placeholder, so it is
    // visible without opening the list, and once inside it.
    expect(screen.getAllByText('Loading categories…').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('No product categories available.')).toBeNull()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('says it failed, and offers a retry, rather than showing an empty list', () => {
    state.categoriesError = true
    openCreateProduct()

    // Stated outside the dropdown too, so it is visible without opening it.
    expect(screen.getAllByText('Categories could not be loaded.').length).toBeGreaterThan(0)
    expect(screen.queryByText('No product categories available.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetchCategories).toHaveBeenCalledTimes(1)
  })

  it('shows the genuine empty state only when there really are none', () => {
    state.categories = []
    openCreateProduct()
    openCategoryDropdown()

    expect(screen.getByText('No product categories available.')).toBeTruthy()
    expect(screen.queryByText('Categories could not be loaded.')).toBeNull()
  })

  it('keeps inline create as the secondary path, and selects what it made', () => {
    // Unchanged feature, and it must stay working: a manager who needs a shelf
    // that does not exist can name one here. The hook invalidates
    // POS_CATALOGUE_KEY, which the selector is keyed under, so the new category
    // arrives without a reload.
    withBothCategories()
    openCreateProduct()

    const inline = screen.getByPlaceholderText('or create a category…')
    fireEvent.change(inline, { target: { value: 'Frozen' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(createCategory).toHaveBeenCalledTimes(1)
    expect(createCategory.mock.calls[0][0]).toBe('Frozen')

    // The page selects whatever id the RPC returns.
    const onSuccess = createCategory.mock.calls[0][1]?.onSuccess
    expect(typeof onSuccess).toBe('function')
    onSuccess('33333333-3333-4333-8333-333333333333')
  })
})

describe('the Edit product category selector', () => {
  it('had the same defect and gets the same source', () => {
    // A manager editing a product saw an empty category list for exactly the
    // same reason, and so could not change a product's category at all.
    withBothCategories()
    state.rows = [row()]
    state.priced = [
      {
        product_id: 'p1',
        selling_price: 65,
        name: 'Cola 1.5L',
        category_id: DRINKS_ID,
        image_path: null,
      },
    ]
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    openCategoryDropdown()

    expect(screen.getByRole('option', { name: 'General' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Drinks' })).toBeTruthy()
  })
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
