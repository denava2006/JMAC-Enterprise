import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Branch } from '@/hooks/useBranches'
import type {
  AdminPosBranchComparison,
  AdminPosReportSummary,
  AdminPosReportTrend,
  PosReportPreset,
  PosReportRange,
} from '@/lib/posReports'

const BRANCH_A = 'branch-a'
const BRANCH_B = 'branch-b'

const branches: Branch[] = [
  {
    id: BRANCH_A,
    name: 'Twin Branch',
    address: null,
    phone: null, latitude: null, longitude: null,
    is_active: true,
    created_at: '',
    updated_at: '',
  },
  {
    id: BRANCH_B,
    name: 'Twin Branch',
    address: null,
    phone: null, latitude: null, longitude: null,
    is_active: false,
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

interface AdminCall {
  branchId: string | undefined
  range: PosReportRange | undefined
}

const calls: { summary: AdminCall[]; trend: AdminCall[]; comparison: (PosReportRange | undefined)[] } = {
  summary: [],
  trend: [],
  comparison: [],
}

const state: {
  summary: AdminPosReportSummary | undefined
  trend: AdminPosReportTrend[]
  comparison: AdminPosBranchComparison[]
  summaryError: Error | null
} = {
  summary: undefined,
  trend: [],
  comparison: [],
  summaryError: null,
}

function summary(overrides: Partial<AdminPosReportSummary> = {}): AdminPosReportSummary {
  return {
    date_from: '2026-08-01',
    date_to: '2026-08-25',
    sales_collected: 330,
    product_sales: 300,
    fees_collected: 30,
    total_cogs: 180,
    gross_product_profit: 120,
    gross_product_margin: 40,
    transaction_count: 3,
    items_sold: 7,
    average_sale: 110,
    ...overrides,
  }
}

function comparisonRow(
  branchId: string,
  isActive: boolean,
  overrides: Partial<AdminPosBranchComparison> = {}
): AdminPosBranchComparison {
  return {
    branch_id: branchId,
    branch_name: 'Twin Branch',
    branch_is_active: isActive,
    sales_collected: 165,
    product_sales: 150,
    fees_collected: 15,
    total_cogs: 90,
    gross_product_profit: 60,
    gross_product_margin: 40,
    transaction_count: 2,
    items_sold: 4,
    average_sale: 82.5,
    ...overrides,
  }
}

function queryResult<T>(data: T, error: Error | null = null) {
  return { data, error, isError: !!error, isLoading: false }
}

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

vi.mock('@/hooks/usePosReports', () => ({
  usePosReportPresets: () => queryResult(databasePresets),
  useAdminPosReportSummary: (branchId?: string, range?: PosReportRange) => {
    calls.summary.push({ branchId, range })
    return queryResult(state.summary, state.summaryError)
  },
  useAdminPosReportTrend: (branchId?: string, range?: PosReportRange) => {
    calls.trend.push({ branchId, range })
    return queryResult(state.trend)
  },
  useAdminPosBranchComparison: (range?: PosReportRange) => {
    calls.comparison.push(range)
    return queryResult(state.comparison)
  },
}))

vi.mock('@/components/reports/ReportChartCard', () => ({
  ReportChartCard: ({ chart }: { chart: { title: string } }) => <div>{chart.title}</div>,
}))

const { default: AdminPosReportsPage } = await import('@/pages/admin/AdminPosReportsPage')

function show() {
  return render(<AdminPosReportsPage />)
}

function figureText(label: string) {
  const labelNode = screen.getAllByText(label)[0]
  return labelNode.parentElement?.textContent ?? ''
}

afterEach(() => {
  cleanup()
  state.summary = undefined
  state.trend = []
  state.comparison = []
  state.summaryError = null
  calls.summary.length = 0
  calls.trend.length = 0
  calls.comparison.length = 0
  vi.restoreAllMocks()
})

describe('administrator financial definitions', () => {
  it('shows the exact financial measures and values without inventing Net Profit', async () => {
    state.summary = summary()
    const { container } = show()

    await screen.findByText(/Showing completed sales for Aug 1, 2026 to Aug 25, 2026/)

    expect(figureText('Sales Collected')).toContain('330.00')
    expect(figureText('Product Sales')).toContain('300.00')
    expect(figureText('Customer Fees')).toContain('30.00')
    expect(figureText('COGS')).toContain('180.00')
    expect(figureText('Gross Product Profit')).toContain('120.00')
    expect(figureText('Gross Product Margin %')).toContain('40.00%')
    expect(container.textContent).toContain(
      'Gross Product Margin % = ((Product Sales - COGS) / Product Sales) × 100.'
    )
    expect(container.textContent ?? '').not.toMatch(/net profit/i)
  })

  it('renders zero-product-sales margin as an em dash', async () => {
    state.summary = summary({
      sales_collected: 30,
      product_sales: 0,
      total_cogs: 0,
      gross_product_profit: 0,
      gross_product_margin: null,
    })
    show()

    await waitFor(() => expect(figureText('Gross Product Margin %')).toContain('—'))
    expect(screen.getByText(/shown as — when Product Sales is zero/i)).toBeTruthy()
  })
})

describe('administrator branch scope and identity', () => {
  it('defaults to all branches, preserves the database range, and keys equal names by branch ID', async () => {
    state.summary = summary()
    state.comparison = [comparisonRow(BRANCH_A, true), comparisonRow(BRANCH_B, false)]
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    show()

    const expectedRange = {
      dateFrom: '2026-08-01',
      dateTo: '2026-08-25',
      kind: 'month_to_date',
    }
    await waitFor(() => {
      expect(calls.summary.at(-1)).toEqual({ branchId: undefined, range: expectedRange })
      expect(calls.trend.at(-1)).toEqual({ branchId: undefined, range: expectedRange })
      expect(calls.comparison.at(-1)).toEqual(expectedRange)
    })

    expect(screen.getByText(/financial reporting for all branches/i)).toBeTruthy()
    expect(screen.getAllByText('Twin Branch')).toHaveLength(2)
    expect(screen.getByText('Inactive')).toBeTruthy()
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key|unique .key/i)
  })

  it('explains an empty range and an empty comparison', async () => {
    state.summary = summary({
      sales_collected: 0,
      product_sales: 0,
      fees_collected: 0,
      total_cogs: 0,
      gross_product_profit: 0,
      gross_product_margin: null,
      transaction_count: 0,
      items_sold: 0,
      average_sale: null,
    })
    show()

    expect(
      await screen.findByText(/No completed sales were recorded for all branches/i)
    ).toBeTruthy()
    expect(screen.getByText('There are no branches to compare.')).toBeTruthy()
  })
})
