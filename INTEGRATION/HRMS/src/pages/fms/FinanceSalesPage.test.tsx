import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

/**
 * The Finance sales page, asked what it shows and what it refuses to offer.
 *
 * The claims worth defending on the screen rather than in the database: a
 * Finance user is given no way to change a sale, provider money is never
 * described as banked, and the two structurally-zero figures are labelled as
 * unmodelled rather than left to read as measurements.
 *
 * Amounts are matched on their digits rather than their rendered currency
 * string, so the suite does not fail on an ICU release that spaces the peso
 * sign differently.
 */

const state: {
  summary: Record<string, unknown> | undefined
  collections: Array<Record<string, unknown>>
  transactions: Array<Record<string, unknown>>
  error: unknown
} = {
  summary: undefined,
  collections: [],
  transactions: [],
  error: null,
}

vi.mock('@/hooks/useFinanceSales', () => ({
  useFinanceSalesPresets: () => ({
    data: [
      { preset: 'today', date_from: '2026-09-04', date_to: '2026-09-04', sort_order: 1 },
      { preset: 'yesterday', date_from: '2026-09-03', date_to: '2026-09-03', sort_order: 2 },
      { preset: 'last_7_days', date_from: '2026-08-29', date_to: '2026-09-04', sort_order: 3 },
      { preset: 'month_to_date', date_from: '2026-09-01', date_to: '2026-09-04', sort_order: 4 },
      { preset: 'year_to_date', date_from: '2026-01-01', date_to: '2026-09-04', sort_order: 5 },
    ],
    isLoading: false,
    error: null,
  }),
  useFinanceSalesSummary: () => ({ data: state.summary, isLoading: false, error: state.error }),
  useFinanceSalesCollections: () => ({ data: state.collections, isLoading: false, error: null }),
  useFinanceSalesTransactions: () => ({ data: state.transactions, isLoading: false, error: null }),
  useFinanceSalesFilterOptions: () => ({
    data: [
      { kind: 'branch', id: 'b1', label: 'Cavite' },
      { kind: 'branch', id: 'b2', label: 'Bacoor' },
      { kind: 'cashier', id: 'c1', label: 'Ana Cruz' },
    ],
    isLoading: false,
    error: null,
  }),
}))

import FinanceSalesPage from '@/pages/fms/FinanceSalesPage'

beforeEach(() => {
  // The brief's own worked example: three sales across three methods.
  state.summary = {
    date_from: '2026-09-04',
    date_to: '2026-09-04',
    gross_sales: 4500,
    discounts: 0,
    refunds: 0,
    net_sales: 4500,
    fees_collected: 200,
    total_collected: 4700,
    transaction_count: 3,
    items_sold: 9,
    average_sale: 1566.67,
  }
  state.collections = [
    { payment_method: 'card', transaction_count: 1, amount_collected: 2000 },
    { payment_method: 'gcash', transaction_count: 1, amount_collected: 1500 },
    { payment_method: 'cash', transaction_count: 1, amount_collected: 1200 },
  ]
  state.transactions = [
    {
      sale_id: 'ab12cd34-0000-0000-0000-000000000000',
      sold_at: '2026-09-04T02:30:00Z',
      branch_id: 'b1',
      branch_name: 'Cavite',
      cashier_id: 'c1',
      cashier_name: 'Ana Cruz',
      payment_method: 'cash',
      payment_reference: null,
      item_count: 2,
      gross_sales: 1000,
      discounts: 0,
      refunds: 0,
      net_sales: 1000,
      fees_total: 200,
      total_collected: 1200,
      total_rows: 1,
    },
  ]
  state.error = null
})

afterEach(cleanup)

describe('the figures the page leads with', () => {
  it('shows gross, discounts, refunds and net', () => {
    render(<FinanceSalesPage />)
    expect(screen.getByText('Gross Sales')).toBeTruthy()
    expect(screen.getByText('Discounts')).toBeTruthy()
    expect(screen.getByText('Refunds')).toBeTruthy()
    expect(screen.getByText('Net Sales')).toBeTruthy()
    expect(screen.getAllByText(/4,500\.00/).length).toBeGreaterThan(0)
  })

  it('never recomputes a total the server already sent', () => {
    // Net is rendered as given, not derived on the client from gross and the
    // two zeros -- so a server that changed its definition would show through
    // here rather than be silently overwritten.
    state.summary = { ...state.summary!, net_sales: 4321 }
    render(<FinanceSalesPage />)
    expect(screen.getAllByText(/4,321\.00/).length).toBeGreaterThan(0)
  })
})

describe('what the page says about money it cannot vouch for', () => {
  it('explains that discounts and refunds are unmodelled, not measured', () => {
    render(<FinanceSalesPage />)
    expect(screen.getByText(/structurally zero rather than measured/i)).toBeTruthy()
  })

  it('separates cash in the branch from money held by the provider', () => {
    render(<FinanceSalesPage />)
    expect(screen.getByText('Cash in branch')).toBeTruthy()
    expect(screen.getByText('Held by payment provider')).toBeTruthy()
    expect(screen.getAllByText(/1,200\.00/).length).toBeGreaterThan(0) // cash
    expect(screen.getAllByText(/3,500\.00/).length).toBeGreaterThan(0) // card + gcash
  })

  it('does not claim provider money reached a bank', () => {
    render(<FinanceSalesPage />)
    expect(screen.getByText(/not yet settled to a JMAC bank account/i)).toBeTruthy()
    expect(screen.queryByText(/\bdeposited\b/i)).toBeNull()
    expect(screen.queryByText(/bank received/i)).toBeNull()
  })
})

describe('reading a figure back to its source', () => {
  it('lists the transaction with branch, cashier, method and net', () => {
    render(<FinanceSalesPage />)
    const table = screen.getByRole('table')
    expect(within(table).getByText('Cavite')).toBeTruthy()
    expect(within(table).getByText('Ana Cruz')).toBeTruthy()
    expect(within(table).getAllByText(/1,000\.00/).length).toBeGreaterThan(0)
    // Cash carries no provider reference, so the POS sale id identifies the row.
    expect(within(table).getByText('AB12CD34')).toBeTruthy()
  })

  it('shows the sale time on the Manila clock the branch used', () => {
    render(<FinanceSalesPage />)
    expect(within(screen.getByRole('table')).getByText(/10:30/)).toBeTruthy()
  })
})

describe('the page offers Finance no way to change a sale', () => {
  it('has no create, edit, delete, void or refund control', () => {
    render(<FinanceSalesPage />)
    const forbidden = /new sale|edit|delete|void|refund sale|adjust|change total/i
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(forbidden)
    }
  })

  it('offers no money or quantity field that could write back to a sale', () => {
    render(<FinanceSalesPage />)
    // Every input on the page narrows a query. None of them names an amount.
    for (const box of screen.queryAllByRole('textbox')) {
      expect(box.getAttribute('name') ?? '').not.toMatch(/amount|total|quantity|price/i)
    }
    expect(screen.queryAllByRole('spinbutton').length).toBe(0)
  })
})

describe('when the read fails', () => {
  it('shows a readable message rather than an object', () => {
    state.error = { message: 'Sales could not be loaded right now.' }
    render(<FinanceSalesPage />)
    expect(screen.getByText('Sales could not be loaded right now.')).toBeTruthy()
    expect(screen.queryByText(/\[object Object\]/)).toBeNull()
  })
})

describe('an empty range', () => {
  it('says so instead of showing a breakdown of zeros', () => {
    state.collections = []
    state.transactions = []
    render(<FinanceSalesPage />)
    expect(screen.getByText(/No completed sales in the selected range/i)).toBeTruthy()
  })
})
