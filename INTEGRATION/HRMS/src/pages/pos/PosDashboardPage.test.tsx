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

    expect(screen.getByText('Sales collected today')).toBeTruthy()
    expect(screen.getByText('Product sales')).toBeTruthy()
    expect(screen.getByText('Customer fees')).toBeTruthy()
    expect(screen.getByText('₱330.00')).toBeTruthy()
    expect(screen.getByText('₱300.00')).toBeTruthy()
    expect(screen.getByText('₱30.00')).toBeTruthy()
  })

  // The relationship the three figures have is now shown by where they sit --
  // the components inside the takings card -- rather than explained in a
  // paragraph underneath it.
  it('shows the parts inside the total they add up to', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show()

    const takings = screen.getByText('Sales collected today').closest('div[class*="p-5"]')!
    expect(takings.textContent).toContain('₱330.00')
    expect(takings.textContent).toContain('Product sales')
    expect(takings.textContent).toContain('₱300.00')
    expect(takings.textContent).toContain('Customer fees')
    expect(takings.textContent).toContain('₱30.00')
  })

  it('says so loudly when the three do not add up', () => {
    // The lib could always check this and the comment said the page should say
    // so out loud. It never did. A mismatch is not a rounding curiosity -- it
    // means the RPC and these labels have drifted apart.
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary({ sales_collected: 999 })
    show()

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/do not add up/i)
  })

  it('stays quiet while they do add up', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    show()
    expect(screen.queryByRole('alert')).toBeNull()
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

  /**
   * What is running out, as work rather than as a number.
   *
   * Two half-width cards each held a single count and offered no way to act on
   * it. A manager reading "3 out of stock" wants to go to Inventory.
   */
  it('turns a stock shortage into somewhere to go', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary({ out_of_stock_count: 3, low_stock_count: 2 })
    show()

    const out = screen.getByText('Out of stock').closest('a')!
    expect(out.getAttribute('href')).toBe('/pos/stock')
    expect(out.textContent).toContain('3')

    const low = screen.getByText('Low stock').closest('a')!
    expect(low.getAttribute('href')).toBe('/pos/stock')
    expect(low.textContent).toContain('2')
  })

  it('mentions only the shortage that exists', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary({ out_of_stock_count: 0, low_stock_count: 4 })
    show()
    expect(screen.getByText('Low stock')).toBeTruthy()
    expect(screen.queryByText('Out of stock')).toBeNull()
  })

  it('says nothing is wrong rather than showing two zeroes', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary({ out_of_stock_count: 0, low_stock_count: 0 })
    show()
    expect(screen.getByText('Everything on the shelf is in stock.')).toBeTruthy()
    expect(screen.queryByText('Out of stock')).toBeNull()
    expect(screen.queryByText('Low stock')).toBeNull()
  })

  it('draws each payment method as a share of the day', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.payments = [
      { payment_method: 'cash', transaction_count: 3, amount_collected: 300 },
      { payment_method: 'gcash', transaction_count: 1, amount_collected: 100 },
    ]
    show()

    // 300 of 400 is 75%, 100 of 400 is 25% -- announced, not just drawn, so a
    // screen reader gets the proportion too.
    expect(screen.getByLabelText("75% of today's takings")).toBeTruthy()
    expect(screen.getByLabelText("25% of today's takings")).toBeTruthy()
  })

  it('lists the biggest payment method first', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.payments = [
      { payment_method: 'gcash', transaction_count: 1, amount_collected: 50 },
      { payment_method: 'cash', transaction_count: 9, amount_collected: 900 },
    ]
    const { container } = show()
    const text = container.textContent ?? ''
    expect(text.indexOf('Cash')).toBeLessThan(text.indexOf('GCash'))
  })

  it('does not present a manual e-wallet reference as settled money', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.payments = [{ payment_method: 'gcash', transaction_count: 2, amount_collected: 200 }]
    show()
    expect(screen.getByText(/not a confirmation that the payment settled/)).toBeTruthy()
  })

  /**
   * The recent-sales list names a sale the way its receipt does.
   *
   * It used to print the first eight characters of the sale's uuid, so a
   * manager reading this panel saw BA2F5555 for the sale whose printed receipt
   * said OR-2026-0009 -- two unrelated-looking references for one sale, with
   * nothing on either screen connecting them.
   */
  it('identifies a recent sale by its receipt number', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.recent = [
      {
        sale_id: 'ba2f5555-1111-2222-3333-444444444444',
        receipt_number: 'OR-2026-0009',
        created_at: '2026-09-04T02:30:00Z',
        status: 'completed',
        branch_id: CAVITE,
        branch_name: 'Cavite Branch',
        cashier_name: 'Ana Cruz',
        item_count: 2,
        subtotal: 100,
        fees_total: 0,
        total_amount: 100,
        payment_method: 'cash',
        payment_reference: null,
        amount_tendered: 200,
        change_given: 100,
        total_count: 1,
      },
    ]
    const { container } = show()

    expect(screen.getByText('OR-2026-0009')).toBeTruthy()
    // The old value, named so it cannot creep back unnoticed.
    expect(container.textContent).not.toContain('BA2F5555')
    expect(container.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    )
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
