import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type {
  PosManagerReportSummary,
  PosManagerReportTrend,
  PosReportPaymentTotal,
  PosReportPreset,
  PosReportRange,
  PosReportTopProduct,
} from '@/lib/posReports'
import type { PosAssignment } from '@/lib/portals'

const CAVITE = 'branch-cavite'
const MAIN = 'branch-main'

const branches: Branch[] = [
  {
    id: CAVITE,
    name: 'Cavite Branch',
    address: null,
    phone: null, latitude: null, longitude: null,
    is_active: true,
    created_at: '',
    updated_at: '',
  },
  {
    id: MAIN,
    name: 'Main Office',
    address: null,
    phone: null, latitude: null, longitude: null,
    is_active: true,
    created_at: '',
    updated_at: '',
  },
]

const databasePresets: PosReportPreset[] = [
  { preset: 'today', date_from: '2026-08-25', date_to: '2026-08-25', sort_order: 1 },
  { preset: 'yesterday', date_from: '2026-08-24', date_to: '2026-08-24', sort_order: 2 },
  { preset: 'last_7_days', date_from: '2026-08-19', date_to: '2026-08-25', sort_order: 3 },
  { preset: 'month_to_date', date_from: '2026-08-01', date_to: '2026-08-25', sort_order: 4 },
  { preset: 'year_to_date', date_from: '2026-01-01', date_to: '2026-08-25', sort_order: 5 },
]

interface QueryCall {
  branchId: string | undefined
  range: PosReportRange | undefined
}

const calls: Record<'summary' | 'trend' | 'payments' | 'topProducts', QueryCall[]> = {
  summary: [],
  trend: [],
  payments: [],
  topProducts: [],
}

const state: {
  assignments: PosAssignment[]
  summary: PosManagerReportSummary | undefined
  trend: PosManagerReportTrend[]
  payments: PosReportPaymentTotal[]
  topProducts: PosReportTopProduct[]
  summaryError: Error | null
} = {
  assignments: [],
  summary: undefined,
  trend: [],
  payments: [],
  topProducts: [],
  summaryError: null,
}

function summary(overrides: Partial<PosManagerReportSummary> = {}): PosManagerReportSummary {
  return {
    date_from: '2026-08-01',
    date_to: '2026-08-25',
    sales_collected: 330,
    product_sales: 300,
    fees_collected: 30,
    transaction_count: 3,
    items_sold: 7,
    average_sale: 110,
    ...overrides,
  }
}

function queryResult<T>(data: T, error: Error | null = null) {
  return { data, error, isError: !!error, isLoading: false }
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'employee-1', role: 'employee' },
    posAccess: {
      hasAccess: state.assignments.length > 0,
      branchIds: state.assignments.map((assignment) => assignment.branchId),
      assignments: state.assignments,
    },
  }),
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

vi.mock('@/hooks/usePosReports', () => ({
  usePosReportPresets: () => queryResult(databasePresets),
  usePosManagerReportSummary: (branchId?: string, range?: PosReportRange) => {
    calls.summary.push({ branchId, range })
    return queryResult(state.summary, state.summaryError)
  },
  usePosManagerReportTrend: (branchId?: string, range?: PosReportRange) => {
    calls.trend.push({ branchId, range })
    return queryResult(state.trend)
  },
  usePosManagerReportPaymentTotals: (branchId?: string, range?: PosReportRange) => {
    calls.payments.push({ branchId, range })
    return queryResult(state.payments)
  },
  usePosManagerReportTopProducts: (branchId?: string, range?: PosReportRange) => {
    calls.topProducts.push({ branchId, range })
    return queryResult(state.topProducts)
  },
}))

vi.mock('@/components/reports/ReportChartCard', () => ({
  ReportChartCard: ({ chart }: { chart: { title: string } }) => <div>{chart.title}</div>,
}))

const { default: PosReportsPage } = await import('@/pages/pos/PosReportsPage')

function show() {
  return render(
    <MemoryRouter initialEntries={['/pos/reports']}>
      <PosReportsPage />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  state.assignments = []
  state.summary = undefined
  state.trend = []
  state.payments = []
  state.topProducts = []
  state.summaryError = null
  for (const queryCalls of Object.values(calls)) queryCalls.length = 0
  vi.restoreAllMocks()
})

describe('manager report scope and date authority', () => {
  it('passes the database MTD dates unchanged to every managed-branch report query', async () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    state.summary = summary()
    show()

    const expectedRange = {
      dateFrom: '2026-08-01',
      dateTo: '2026-08-25',
      kind: 'month_to_date',
    }

    await waitFor(() => {
      for (const queryCalls of Object.values(calls)) {
        expect(queryCalls.at(-1)).toEqual({ branchId: CAVITE, range: expectedRange })
      }
    })

    expect(screen.getByText(/completed-sales reporting for Cavite Branch/i)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Branch' })).toBeNull()
    expect(calls.summary.some((call) => call.branchId === MAIN)).toBe(false)
  })
})

describe('manager operational reporting', () => {
  it('shows the six operational KPIs and no cost or profit measure', async () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    const { container } = show()

    await screen.findByText(/Showing completed sales for Aug 1, 2026 to Aug 25, 2026/)

    for (const label of [
      'Sales Collected',
      'Product Sales',
      'Customer Fees',
      'Transactions',
      'Items Sold',
      'Average Sale',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }

    const text = container.textContent ?? ''
    expect(text).toContain('330.00')
    expect(text).toContain('300.00')
    expect(text).toContain('30.00')
    expect(text).not.toMatch(/\bcost\b/i)
    expect(text).not.toMatch(/COGS/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/profit/i)
    expect(text).not.toMatch(/net profit/i)
  })

  it('renders payment and product rows by their stable contract identities', async () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    state.payments = [
      { payment_method: 'cash', transaction_count: 2, amount_collected: 220 },
      { payment_method: 'gcash', transaction_count: 1, amount_collected: 110 },
    ]
    state.topProducts = [
      { product_id: 'product-1', product_name: 'Shared Snapshot', quantity_sold: 4, sales_amount: 240 },
      { product_id: 'product-2', product_name: 'Shared Snapshot', quantity_sold: 3, sales_amount: 60 },
    ]
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    show()

    await screen.findByText('Cash')
    expect(screen.getByText('GCash')).toBeTruthy()
    expect(screen.getByText(/sum of each completed sale's total amount/i)).toBeTruthy()
    expect(screen.getAllByText('Shared Snapshot')).toHaveLength(2)
    expect(screen.getByText(/Grouped by product ID and ranked using historical line totals/i)).toBeTruthy()
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key|unique .key/i)
  })

  it('shows a safe access error and a clear empty-range state', async () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.summary = summary()
    const view = show()
    await screen.findByText('No payment totals for the selected range.')

    state.summaryError = new Error('permission denied for function')
    view.rerender(
      <MemoryRouter initialEntries={['/pos/reports']}>
        <PosReportsPage />
      </MemoryRouter>
    )

    expect((await screen.findByRole('alert')).textContent).toContain(
      'You do not have access to that report.'
    )
  })
})
