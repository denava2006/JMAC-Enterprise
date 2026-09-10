import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { BranchCategorySummary } from '@/hooks/usePosCategorySummary'
import type { PosAssignment } from '@/lib/portals'

/**
 * Product Categories, as a branch manager sees them. Not Finance Categories --
 * a different module, in a different portal, that this file never touches.
 *
 * The claim that matters is the SHAPE of the manager's authority, and it comes
 * from the database rather than from taste. `pos_product_categories` is a
 * global taxonomy with a single `is_admin()` policy, but two SECURITY DEFINER
 * functions widen it, both guarded `is_admin() or has_pos_role(null,
 * ['manager'])`:
 *
 *   create_pos_category   a manager may add a heading
 *   rename_pos_category   a manager may correct one
 *
 * So this screen offers exactly those two, and the tests below hold that line
 * from both sides: the two are present, and reorder / archive / delete / colour
 * / description are not -- those check `is_admin()` alone, and a control for
 * them would be a button that always fails.
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

// The two RPCs the database already authorises for a manager. Only these two
// are mocked, because only these two may be imported: anything else this page
// reached for would fail to resolve here and, more to the point, would return
// 42501 in production.
const created: string[] = []
const renamed: { id: string; name: string }[] = []

vi.mock('@/hooks/usePosCatalogue', () => ({
  useCreatePosCategory: () => ({
    mutate: (name: string) => created.push(name),
    isPending: false,
  }),
  useRenamePosCategory: () => ({
    mutate: (input: { id: string; name: string }) => renamed.push(input),
    isPending: false,
  }),
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
  created.length = 0
  renamed.length = 0
})

/** Signed in as the manager of Cavite, looking at one category. */
function asManager(overrides: Partial<BranchCategorySummary> = {}) {
  state.assignments = [{ branchId: CAVITE, role: 'manager' }]
  state.rows = [row(overrides)]
  return show()
}

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

  it('says what is theirs and what is the Administrator’s, before they click anything', () => {
    asManager()
    const text = screen.getByText(/Categories are shared by the whole business/).textContent ?? ''
    expect(text).toMatch(/adding or renaming one changes it at every branch/)
    expect(text).toMatch(/Ordering, archiving and deleting stay with an Administrator/)
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

describe('the two things the database lets a manager do', () => {
  it('offers both, on the page a person would look for them on', () => {
    asManager()
    expect(screen.getByRole('button', { name: /New category/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Rename Drinks' })).toBeTruthy()
  })

  it('warns that a new category is the whole business’s before creating one', () => {
    asManager()
    fireEvent.click(screen.getByRole('button', { name: /New category/i }))

    expect(screen.getByRole('dialog').textContent ?? '').toMatch(
      /becomes available to every branch, not only yours/
    )
  })

  it('creates through the RPC, with the name trimmed', () => {
    asManager()
    fireEvent.click(screen.getByRole('button', { name: /New category/i }))
    fireEvent.change(screen.getByLabelText('Category name'), {
      target: { value: '  Frozen  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create category' }))

    expect(created).toEqual(['Frozen'])
    expect(renamed).toHaveLength(0)
  })

  it('opens Rename on the category asked about, with its current name in the field', () => {
    asManager()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Drinks' }))

    expect((screen.getByLabelText('Category name') as HTMLInputElement).value).toBe('Drinks')
    expect(screen.getByRole('dialog').textContent ?? '').toMatch(
      /renames it at every branch/
    )
  })

  it('renames through the RPC, by ID rather than by the name being replaced', () => {
    asManager()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Drinks' }))
    fireEvent.change(screen.getByLabelText('Category name'), {
      target: { value: 'Beverages' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Rename everywhere' }))

    expect(renamed).toEqual([{ id: 'c1', name: 'Beverages' }])
    expect(created).toHaveLength(0)
  })

  it('will not send a rename that changes nothing', () => {
    asManager()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Drinks' }))
    const submit = screen.getByRole('button', { name: 'Rename everywhere' })

    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(submit)
    expect(renamed).toHaveLength(0)
  })

  it('will not create a category with a blank name -- the RPC would refuse it anyway', () => {
    asManager()
    fireEvent.click(screen.getByRole('button', { name: /New category/i }))
    fireEvent.change(screen.getByLabelText('Category name'), { target: { value: '   ' } })

    const submit = screen.getByRole('button', { name: 'Create category' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(submit)
    expect(created).toHaveLength(0)
  })
})

describe('what a manager still cannot do here', () => {
  it('is offered no way to reorder, archive, restore, delete or reassign', () => {
    // Every one of these is is_admin() in the database --
    // reorder_pos_category, delete_pos_category, and the table policy behind
    // is_active. A control for them would be a button that always fails.
    asManager()

    for (const name of [
      /^Delete/i,
      /Archive/i,
      /Restore/i,
      /Deactivate/i,
      /Move up/i,
      /Move down/i,
      /Reassign/i,
      /Reorder/i,
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('cannot edit a category’s colour, icon, description or sort order', () => {
    // Rename is the whole of it: rename_pos_category writes `name` and nothing
    // else, so the dialog offers one field and no more.
    asManager()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Drinks' }))

    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelectorAll('input, textarea, select')).toHaveLength(1)
    expect(dialog.textContent ?? '').not.toMatch(/colour|color|icon|description|order/i)
  })

  it('renders no editing control at all until one is asked for', () => {
    // A disabled field sitting on the page says "this is yours, just not now".
    // The two writes live behind a dialog, so the table itself stays a summary.
    asManager()
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

describe('a cashier', () => {
  // The route refuses them first now -- PosManagerRoute sends them to the till,
  // which ProtectedRoute.test.tsx pins. This is the page's own second answer,
  // kept because a guard is not a reason to render an editor if it is ever
  // bypassed.
  it('is pointed at the POS screen rather than shown an empty table', () => {
    state.assignments = [{ branchId: CAVITE, role: 'cashier' }]
    show()
    expect(screen.getByText(/shown on the POS screen/)).toBeTruthy()
    expect(screen.queryByText('Drinks')).toBeNull()
  })

  it('is offered neither of the manager’s two writes', () => {
    state.assignments = [{ branchId: CAVITE, role: 'cashier' }]
    state.rows = [row()]
    show()
    expect(screen.queryByRole('button', { name: /New category/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Rename/i })).toBeNull()
    expect(created).toHaveLength(0)
    expect(renamed).toHaveLength(0)
  })
})
