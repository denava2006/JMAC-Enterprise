import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Branch } from '@/hooks/useBranches'
import type { TransactionRow, TransactionScope } from '@/lib/posTransactions'

/**
 * Transaction history in the POS portal.
 *
 * The claim that matters: a cashier's list is their own. That is enforced in
 * the database -- `get_my_transactions` takes no cashier argument -- and this
 * proves the screen asks for the right thing and offers no way to ask for
 * anything else.
 */

const CAVITE = 'cavite'
const MAIN = 'main'

const branches: Branch[] = [
  { id: CAVITE, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: MAIN, name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
]

const state: {
  assignments: { branchId: string; role: 'manager' | 'cashier' }[]
  rows: TransactionRow[]
} = { assignments: [{ branchId: CAVITE, role: 'cashier' }], rows: [] }

const queries: { scope: TransactionScope; branchId?: string }[] = []

function row(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    sale_id: '11111111-2222-3333-4444-555555555555',
    created_at: '2026-08-25T10:00:00Z',
    status: 'completed',
    branch_id: CAVITE,
    branch_name: 'Cavite Branch',
    cashier_name: 'Liza Fernandez',
    item_count: 2,
    subtotal: 100,
    fees_total: 10,
    total_amount: 110,
    payment_method: 'cash',
    payment_reference: null,
    amount_tendered: 200,
    change_given: 90,
    total_count: 1,
    ...overrides,
  }
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: 'employee' },
    posAccess: {
      hasAccess: true,
      branchIds: state.assignments.map((a) => a.branchId),
      assignments: state.assignments,
    },
  }),
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

vi.mock('@/hooks/usePosTransactions', () => ({
  usePosTransactions: (query: { scope: TransactionScope; branchId?: string }) => {
    queries.push({ scope: query.scope, branchId: query.branchId })
    return { data: state.rows, isLoading: false, isError: false, error: null }
  },
  useSaleDetail: () => ({ data: null, isLoading: false, isError: false, error: null }),
}))

const { default: PosTransactionsPage } = await import('@/pages/pos/PosTransactionsPage')

/** Radix tabs activate on pointer-down/focus, not on a synthetic click. */
function selectTab(name: string) {
  const tab = screen.getByRole('tab', { name })
  fireEvent.mouseDown(tab)
  fireEvent.focus(tab)
}

afterEach(() => {
  cleanup()
  state.assignments = [{ branchId: CAVITE, role: 'cashier' }]
  state.rows = []
  queries.length = 0
})

describe('a cashier', () => {
  it('sees only their own sales, and is told so', () => {
    state.rows = [row()]
    render(<PosTransactionsPage />)
    expect(screen.getByText('Every sale you have rung up.')).toBeTruthy()
  })

  it('asks the database for its own scope, which takes no cashier argument', () => {
    render(<PosTransactionsPage />)
    expect(queries.every((q) => q.scope === 'mine')).toBe(true)
  })

  it('is offered no branch tab at all', () => {
    render(<PosTransactionsPage />)
    expect(screen.queryByRole('tab', { name: 'Branch' })).toBeNull()
  })

  it('sees no cost anywhere', () => {
    state.rows = [row()]
    const { container } = render(<PosTransactionsPage />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/cost/i)
    expect(text).not.toMatch(/COGS/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/profit/i)
  })

  it('explains an empty history', () => {
    render(<PosTransactionsPage />)
    expect(screen.getByText('You have not rung up a sale yet.')).toBeTruthy()
  })
})

/**
 * The register as it reads.
 *
 * Every figure here comes from the same rows the list has always used; what
 * changed is where the eye lands. These assert the authoritative values survive
 * the new presentation rather than that the presentation is pretty.
 */
describe('the register', () => {
  it('carries every column a cashier needs to place a sale', () => {
    state.rows = [row()]
    render(<PosTransactionsPage />)

    // The receipt reference, the branch, the count, the method and the money.
    // Scoped to the row: "2" is also the units figure on the summary above it,
    // which is a different number that happens to agree.
    const cells = screen
      .getByText('11111111')
      .closest('tr')!
      .querySelectorAll('td')
    const rowText = Array.from(cells).map((c) => c.textContent?.trim())

    expect(screen.getByText('Cavite Branch')).toBeTruthy()
    expect(rowText).toContain('2')
    expect(rowText).toContain('Cash')
    expect(rowText).toContain('₱110.00')
  })

  it('splits the timestamp into a day and a time without changing either', () => {
    state.rows = [row()]
    render(<PosTransactionsPage />)

    // The same instant the single dense timestamp rendered, read off the same
    // Date -- so this stays true wherever the machine running it happens to be.
    const when = new Date('2026-08-25T10:00:00Z')
    const day = when.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    expect(screen.getByText(day)).toBeTruthy()
    expect(screen.getByText(when.toLocaleTimeString())).toBeTruthy()
  })

  it('summarises the page without inventing a metric', () => {
    state.rows = [row(), row({ sale_id: 'aaaaaaaa-2222-3333-4444-555555555555', total_count: 2 })]
    const { container } = render(<PosTransactionsPage />)

    expect(screen.getByText('Sales on this page')).toBeTruthy()
    expect(screen.getByText('Items sold')).toBeTruthy()
    expect(screen.getByText('Total taken')).toBeTruthy()
    expect(screen.getByText('₱220.00')).toBeTruthy()

    // The reference mock showed an average; nothing computes one, so nothing
    // claims one.
    expect(container.textContent).not.toMatch(/average/i)
    expect(container.textContent).not.toMatch(/export/i)
  })

  it('keeps the receipt reachable for each row', () => {
    state.rows = [row()]
    render(<PosTransactionsPage />)
    expect(screen.getByRole('button', { name: 'Receipt for 11111111' })).toBeTruthy()
  })

  it('tells cash apart from a provider settlement at a glance', () => {
    state.rows = [
      row(),
      row({ sale_id: 'bbbbbbbb-2222-3333-4444-555555555555', payment_method: 'gcash' }),
    ]
    render(<PosTransactionsPage />)
    expect(screen.getByText('Cash')).toBeTruthy()
    expect(screen.getByText('GCash')).toBeTruthy()
  })

  it('still lets the dates be filtered and cleared', () => {
    state.rows = [row()]
    render(<PosTransactionsPage />)

    const from = screen.getByLabelText('From') as HTMLInputElement
    fireEvent.change(from, { target: { value: '2026-08-01' } })
    expect(from.value).toBe('2026-08-01')

    fireEvent.click(screen.getByRole('button', { name: 'Clear dates' }))
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('')
  })
})

describe('a POS manager', () => {
  it('gets a branch tab as well as their own', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    render(<PosTransactionsPage />)
    expect(screen.getByRole('tab', { name: 'My sales' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Branch' })).toBeTruthy()
  })

  it('starts on their own sales, not the branch', () => {
    // The default tab decides what a manager sees first; their own list is the
    // narrower one, so it is the safer default.
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    render(<PosTransactionsPage />)
    expect(queries.some((q) => q.scope === 'mine')).toBe(true)
  })
})

describe('a manager at one branch and a cashier at another', () => {
  it('offers only the branch they manage', () => {
    // Manager authority does not travel. At Main Office they work a till, so
    // their sales there belong on the "My sales" tab, not in a branch view.
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    state.rows = [row()]
    render(<PosTransactionsPage />)
    selectTab('Branch')

    // getByLabelText('Branch') is ambiguous here: the tab panel is
    // aria-labelledby the "Branch" tab. The Select is the combobox.
    const picker = screen.getByRole('combobox', { name: 'Branch' })
    expect(picker.textContent).toContain('Cavite Branch')
    expect(picker.textContent).not.toContain('Main Office')
  })

  it('never asks the branch scope for the branch it only cashiers at', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    render(<PosTransactionsPage />)
    selectTab('Branch')

    const branchQueries = queries.filter((q) => q.scope === 'branch')
    expect(branchQueries.length).toBeGreaterThan(0)
    expect(branchQueries.every((q) => q.branchId === CAVITE)).toBe(true)
    expect(branchQueries.some((q) => q.branchId === MAIN)).toBe(false)
  })

  it('says why the other branch is absent', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    render(<PosTransactionsPage />)
    selectTab('Branch')
    expect(screen.getByText(/Only the branches you manage appear here/)).toBeTruthy()
  })
})
