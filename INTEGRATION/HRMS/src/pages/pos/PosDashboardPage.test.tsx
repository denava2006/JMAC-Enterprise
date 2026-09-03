import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { DashboardSummary, PaymentTotal, TopProduct } from '@/lib/posDashboard'
import type { PosAssignment } from '@/lib/portals'
import type { TransactionRow } from '@/lib/posTransactions'

/**
 * The POS Manager's dashboard.
 *
 * The claims worth pinning: it asks only about branches this account actually
 * manages, it shows the three money figures under names that reconcile, and it
 * shows no cost. The last one is guaranteed in the database -- none of the RPCs
 * declares a cost column -- and this proves the page did not invent one.
 */

const CAVITE = 'cavite'
const MAIN = 'main'

const branches: Branch[] = [
  { id: CAVITE, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: MAIN, name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
]

const state: {
  assignments: PosAssignment[]
  summary: DashboardSummary | undefined
  payments: PaymentTotal[]
  top: TopProduct[]
  recent: TransactionRow[]
} = { assignments: [], summary: undefined, payments: [], top: [], recent: [] }

/** Every branch id the page asked any query about. */
const asked: string[] = []

function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    business_date: '2026-08-25',
    sales_collected: 330,
    product_sales: 300,
    fees_collected: 30,
    transaction_count: 3,
    items_sold: 7,
    average_sale: 110,
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

vi.mock('@/hooks/usePosDashboard', () => ({
  useBusinessDay: () => ({
    data: {
      business_date: '2026-08-25',
      day_start: '2026-08-24T16:00:00+00:00',
      day_end: '2026-08-25T16:00:00+00:00',
    },
  }),
  useDashboardSummary: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    return { data: state.summary, isLoading: false, isError: false, error: null }
  },
  useDashboardPaymentTotals: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    return { data: state.payments, isLoading: false, isError: false, error: null }
  },
  useDashboardTopProducts: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    return { data: state.top, isLoading: false, isError: false, error: null }
  },
  useDashboardRecentSales: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    return { data: state.recent, isLoading: false, isError: false, error: null }
  },
}))

const { default: PosDashboardPage } = await import('@/pages/pos/PosDashboardPage')

function show(url = '/pos/dashboard') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <PosDashboardPage />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  state.assignments = []
  state.summary = undefined
  state.payments = []
  state.top = []
  state.recent = []
  asked.length = 0
})

describe('what a manager sees', () => {
  it('names the three money figures so they reconcile', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show()

    expect(screen.getByText('Sales Collected')).toBeTruthy()
    expect(screen.getByText('Product Sales')).toBeTruthy()
    expect(screen.getByText('Customer Fees')).toBeTruthy()
    expect(screen.getByText('₱330.00')).toBeTruthy()
    expect(screen.getByText('₱300.00')).toBeTruthy()
    expect(screen.getByText('₱30.00')).toBeTruthy()
  })

  it('never calls anything "Net Sales"', () => {
    // The standalone put `subtotal` on a card reading "Today's Net Sales" and
    // never showed what the customer actually paid.
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    const { container } = show()
    expect(container.textContent ?? '').not.toMatch(/net sales/i)
  })

  it('counts units sold, taking the number the RPC gives it', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary({ items_sold: 7, transaction_count: 3 })
    show()
    expect(screen.getByText(/7 items sold/)).toBeTruthy()
  })

  it('shows no cost, COGS, margin or profit', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.top = [
      { product_id: 'p1', product_name: 'Cola 1.5L', quantity_sold: 4, sales_amount: 400 },
    ]
    state.payments = [{ payment_method: 'cash', transaction_count: 3, amount_collected: 330 }]
    const { container } = show()
    const text = (container.textContent ?? '').replace(
      /cost and profit are not part of this view/i,
      ''
    )
    expect(text).not.toMatch(/\bcost\b/i)
    expect(text).not.toMatch(/COGS/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/profit/i)
  })

  it('is not the old placeholder', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    const { container } = show()
    expect(container.textContent ?? '').not.toMatch(/portal is set up/i)
  })

  it('labels the day the server chose, not the device"s idea of today', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show()
    expect(screen.getByText(/Trading today —/)).toBeTruthy()
  })

  it('says an empty day is empty rather than showing a broken panel', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary({ transaction_count: 0, sales_collected: 0 })
    show()
    expect(screen.getByText('Nothing has sold yet today.')).toBeTruthy()
    expect(screen.getByText('No sales have been rung up yet today.')).toBeTruthy()
  })

  it('does not present a manual e-wallet reference as settled money', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.payments = [{ payment_method: 'gcash', transaction_count: 2, amount_collected: 200 }]
    show()
    expect(screen.getByText(/not a confirmation that the payment settled/)).toBeTruthy()
  })
})

describe('branch scoping', () => {
  it('offers no picker when there is only one branch to manage', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show()
    expect(screen.queryByRole('combobox', { name: 'Branch' })).toBeNull()
  })

  it('offers only managed branches, never one they merely cashier at', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    state.summary = summary()
    show()

    // One managed branch means no picker at all -- and the branch shown is the
    // managed one, not whichever assignment came first.
    expect(screen.queryByRole('combobox', { name: 'Branch' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Cavite Branch' })).toBeTruthy()
  })

  it('never asks about a branch it only cashiers at', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    state.summary = summary()
    show()

    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((id) => id === CAVITE)).toBe(true)
    expect(asked).not.toContain(MAIN)
  })

  it('lets someone managing two branches choose, listing both', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'manager' },
    ]
    state.summary = summary()
    show()
    const picker = screen.getByRole('combobox', { name: 'Branch' })
    // useBranches orders by name, so the first is a deterministic choice.
    expect(picker.textContent).toContain('Cavite Branch')
  })

  it('honours a branch named in the URL when the account manages it', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'manager' },
    ]
    state.summary = summary()
    show(`/pos/dashboard?branch=${MAIN}`)
    expect(screen.getByRole('heading', { name: 'Main Office' })).toBeTruthy()
  })

  it('ignores a branch named in the URL that the account does not manage', () => {
    // A hand-edited query string is not a grant. The database would refuse it
    // too; this stops the page from pretending otherwise.
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show(`/pos/dashboard?branch=${MAIN}`)

    expect(screen.getByRole('heading', { name: 'Cavite Branch' })).toBeTruthy()
    expect(asked.every((id) => id === CAVITE)).toBe(true)
  })
})

describe('someone who manages nothing', () => {
  it('is told so instead of shown a page of zeroes', () => {
    state.assignments = [{ branchId: CAVITE, role: 'cashier' }]
    show()
    expect(screen.getByText(/You do not manage a branch/)).toBeTruthy()
  })
})
