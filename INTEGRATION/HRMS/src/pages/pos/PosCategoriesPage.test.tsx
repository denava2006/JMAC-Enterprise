import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { BranchCategorySummary } from '@/hooks/usePosCategorySummary'
import type { PosAssignment } from '@/lib/portals'

/**
 * Categories, as a branch manager sees them.
 *
 * The claim that matters: this is a summary, not an editor. Phase 3 made
 * categories a global enterprise taxonomy and the standalone POS gave managers
 * create/rename/archive/reorder plus a bulk product-move picker on top of
 * exactly this screen. None of that is ported, and the database refuses it
 * regardless -- pos_product_categories carries one is_admin() policy.
 */

const CAVITE = 'cavite'
const MAIN = 'main'

const branches: Branch[] = [
  { id: CAVITE, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: MAIN, name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
]

const state: { assignments: PosAssignment[]; rows: BranchCategorySummary[] } = {
  assignments: [],
  rows: [],
}
const asked: string[] = []

function row(overrides: Partial<BranchCategorySummary> = {}): BranchCategorySummary {
  return {
    category_id: 'c1',
    name: 'Drinks',
    description: 'Bottled and canned',
    color: '#3366ff',
    icon: null,
    sort_order: 0,
    is_active: true,
    product_count: 6,
    offered_count: 5,
    low_stock_count: 2,
    out_of_stock_count: 1,
    ...overrides,
  }
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: 'employee' },
    posAccess: {
      hasAccess: state.assignments.length > 0,
      branchIds: state.assignments.map((a) => a.branchId),
      assignments: state.assignments,
    },
  }),
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

vi.mock('@/hooks/usePosCategorySummary', () => ({
  useBranchCategorySummary: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    return { data: state.rows, isLoading: false, isError: false, error: null }
  },
}))

const { default: PosCategoriesPage } = await import('@/pages/pos/PosCategoriesPage')

function show(url = '/pos/categories') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <PosCategoriesPage />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  state.assignments = []
  state.rows = []
  asked.length = 0
})

describe('what a manager sees', () => {
  it('shows the global definition alongside their own branch counts', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show()

    expect(screen.getByText('Drinks')).toBeTruthy()
    expect(screen.getByText('Bottled and canned')).toBeTruthy()
    expect(screen.getByText('6')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()
  })

  it('labels a retired category rather than hiding stock filed under it', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row({ is_active: false, product_count: 2 })]
    show()
    expect(screen.getByText('Retired')).toBeTruthy()
  })

  it('does not label an active category', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row({ is_active: true })]
    show()
    expect(screen.queryByText('Retired')).toBeNull()
  })

  it('links a row to Inventory rather than mutating stock here', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show()
    const link = screen.getByRole('link', { name: 'Open in Inventory' })
    expect(link.getAttribute('href')).toBe(`/pos/stock?branch=${CAVITE}`)
  })

  it('says why it is read-only', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show()
    expect(screen.getByText(/an Administrator adds and renames them/)).toBeTruthy()
  })

  it('shows no cost, COGS, margin or profit', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    const { container } = show()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\bcost\b/i)
    expect(text).not.toMatch(/COGS/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/profit/i)
    expect(text).not.toMatch(/₱/)
  })
})

describe('what a manager cannot do here', () => {
  it('is offered no way to create, edit, archive, delete or reorder a category', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show()

    for (const name of [
      /New category/i,
      /Add category/i,
      /Edit/i,
      /Delete/i,
      /Archive/i,
      /Restore/i,
      /Move up/i,
      /Move down/i,
      /Reassign/i,
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('renders no form control at all -- not a disabled one', () => {
    // A disabled control still says "this is yours, just not now". It is not.
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show()
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
  })
})

describe('branch scoping', () => {
  it('never asks about a branch it only cashiers at', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    state.rows = [row()]
    show()

    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((id) => id === CAVITE)).toBe(true)
  })

  it('ignores a branch named in the URL that the account does not manage', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show(`/pos/categories?branch=${MAIN}`)
    expect(asked.every((id) => id === CAVITE)).toBe(true)
  })
})

describe('a cashier who types the URL', () => {
  it('is pointed at the POS screen rather than shown an empty table', () => {
    state.assignments = [{ branchId: CAVITE, role: 'cashier' }]
    show()
    expect(screen.getByText(/shown on the POS screen/)).toBeTruthy()
    expect(screen.queryByText('Drinks')).toBeNull()
  })
})
