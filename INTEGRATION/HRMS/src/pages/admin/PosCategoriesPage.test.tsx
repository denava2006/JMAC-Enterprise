import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Category, Product } from '@/lib/posCatalogue'

/**
 * The category screen's job is to keep the taxonomy coherent: General is
 * permanent, names are unique enterprise-wide, and a category holding products
 * cannot be deleted without saying where they go.
 */

const state: { categories: Category[]; products: Product[] } = { categories: [], products: [] }
const save = vi.fn()
const remove = vi.fn()
const reorder = vi.fn()
const setActive = vi.fn()

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'c1',
    name: 'Drinks',
    normalized_name: 'drinks',
    description: null,
    color: null,
    icon: null,
    is_active: true,
    sort_order: 1,
    ...overrides,
  }
}

const general = category({ id: 'gen', name: 'General', normalized_name: 'general', sort_order: 0 })

vi.mock('@/hooks/usePosCatalogue', () => ({
  usePosCategories: () => ({ data: state.categories, isLoading: false }),
  usePosProducts: () => ({ data: state.products, isLoading: false }),
  useSaveCategory: () => ({ mutate: save, isPending: false }),
  useDeleteCategory: () => ({ mutate: remove, isPending: false }),
  useReorderCategory: () => ({ mutate: reorder, isPending: false }),
  useSetCategoryActive: () => ({ mutate: setActive, isPending: false }),
}))

const { default: PosCategoriesPage } = await import('@/pages/admin/PosCategoriesPage')

/** Radix's dropdown trigger opens on pointerdown or a key, not on a synthetic
 * click, and @testing-library/user-event is not a dependency of this project. */
function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'Enter' })
}

afterEach(() => {
  cleanup()
  state.categories = []
  state.products = []
  save.mockReset()
  remove.mockReset()
  reorder.mockReset()
  setActive.mockReset()
})

describe('the General category', () => {
  it('is marked permanent', () => {
    state.categories = [general]
    render(<PosCategoriesPage />)
    expect(screen.getByText('Permanent')).toBeTruthy()
  })

  it('offers no archive or delete action', () => {
    // It is the guaranteed home for orphaned products, so removing it would
    // break category deletion. The database refuses too; this avoids offering
    // a button whose only outcome is an error.
    state.categories = [general]
    render(<PosCategoriesPage />)
    openMenu('Actions for General')
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
  })

  it('lets an ordinary category be archived and deleted', () => {
    state.categories = [general, category()]
    render(<PosCategoriesPage />)
    openMenu('Actions for Drinks')
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
  })
})

describe('the list', () => {
  it('shows how many products use each category', () => {
    state.categories = [category()]
    state.products = [
      { id: 'p1', name: 'Cola', category_id: 'c1', default_selling_price: 1, default_unit_cost: 0, image_path: null, status: 'active' },
      { id: 'p2', name: 'Water', category_id: 'c1', default_selling_price: 1, default_unit_cost: 0, image_path: null, status: 'active' },
    ]
    render(<PosCategoriesPage />)
    expect(screen.getByText(/2 products/)).toBeTruthy()
  })

  it('marks an archived category', () => {
    state.categories = [category({ is_active: false })]
    render(<PosCategoriesPage />)
    expect(screen.getByText('Archived')).toBeTruthy()
  })

  it('cannot move the first category up or the last one down', () => {
    state.categories = [general, category()]
    render(<PosCategoriesPage />)
    expect((screen.getByRole('button', { name: 'Move General up' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Move Drinks down' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Move Drinks up' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('deleting a category', () => {
  it('asks where its products should go', () => {
    state.categories = [general, category()]
    state.products = [
      { id: 'p1', name: 'Cola', category_id: 'c1', default_selling_price: 1, default_unit_cost: 0, image_path: null, status: 'active' },
    ]
    render(<PosCategoriesPage />)
    openMenu('Actions for Drinks')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    expect(screen.getByText(/1 product uses this category/)).toBeTruthy()
    // pos_products.category_id is NOT NULL, so the delete cannot proceed until
    // a destination is chosen.
    expect((screen.getByRole('button', { name: 'Delete category' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('deletes an empty category without asking', () => {
    state.categories = [general, category()]
    render(<PosCategoriesPage />)
    openMenu('Actions for Drinks')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    expect(screen.getByText(/no products/)).toBeTruthy()
    const confirm = screen.getByRole('button', { name: 'Delete category' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(remove).toHaveBeenCalledWith({ id: 'c1', replacementId: null }, expect.anything())
  })
})

describe('the category dialog', () => {
  it('refuses a duplicate name before the round trip', () => {
    state.categories = [general, category()]
    render(<PosCategoriesPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New category' }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: '  drinks ' } })

    expect(screen.getByText(/already exists/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Add category' }) as HTMLButtonElement).disabled).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('refuses a malformed colour', () => {
    state.categories = [general]
    render(<PosCategoriesPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New category' }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Snacks' } })
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: 'blue' } })

    expect(screen.getByText(/six-digit hex/)).toBeTruthy()
  })

  it('saves a valid category', () => {
    state.categories = [general]
    render(<PosCategoriesPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New category' }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Snacks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }))

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does not greet an empty new-category form with an error', () => {
    // "A category needs a name." before they have typed one is an error about
    // something they have not done yet. Submit is still refused.
    state.categories = [general]
    render(<PosCategoriesPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New category' }))

    expect(screen.queryByText('A category needs a name.')).toBeNull()
    expect((screen.getByRole('button', { name: 'Add category' }) as HTMLButtonElement).disabled).toBe(true)

    // And it appears the moment they type something and clear it again.
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: '' } })
    expect(screen.getByText('A category needs a name.')).toBeTruthy()
  })

  it('says renaming affects every branch', () => {
    state.categories = [general]
    render(<PosCategoriesPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New category' }))
    // The page subtitle says something similar, so assert on the dialog's own
    // sentence rather than the shared phrase.
    expect(screen.getByText(/Renaming one changes it everywhere/)).toBeTruthy()
  })
})
