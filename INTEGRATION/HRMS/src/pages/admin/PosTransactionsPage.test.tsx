import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Branch } from '@/hooks/useBranches'
import type { TransactionRow, TransactionScope } from '@/lib/posTransactions'

/**
 * Transaction history for the Administrator, in the back office.
 *
 * Two claims. It reads through the admin RPC rather than the sale tables --
 * which the Administrator *can* read, and which carry unit_cost_snapshot and
 * total_cogs -- so no future edit here can surface valuation by accident. And
 * it is operational: no cost, COGS, margin or profit reaches the page.
 */

const CAVITE = 'cavite'
const MAIN = 'main'

const branches: Branch[] = [
  { id: CAVITE, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: MAIN, name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: 'closed', name: 'Closed Depot', address: null, phone: null, latitude: null, longitude: null, is_active: false, created_at: '', updated_at: '' },
]

const state: { rows: TransactionRow[] } = { rows: [] }
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

const { default: AdminPosTransactionsPage } = await import('@/pages/admin/PosTransactionsPage')

afterEach(() => {
  cleanup()
  state.rows = []
  queries.length = 0
})

describe('the Administrator transaction module', () => {
  it('reads through the admin RPC, never the sale tables', () => {
    render(<AdminPosTransactionsPage />)
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.every((q) => q.scope === 'admin')).toBe(true)
  })

  it('starts across every branch rather than guessing one', () => {
    render(<AdminPosTransactionsPage />)
    expect(queries.every((q) => q.branchId === undefined)).toBe(true)
  })

  it('shows no cost, COGS, margin or profit in its data', () => {
    state.rows = [row()]
    const { container } = render(<AdminPosTransactionsPage />)
    // The standing note names cost to say where it belongs; strip it, then
    // nothing about cost may remain.
    const text = (container.textContent ?? '').replace(
      /Cost, margin and profit are not shown here[\s\S]*?settled\./,
      ''
    )
    expect(text).not.toMatch(/\bcost\b/i)
    expect(text).not.toMatch(/COGS/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/profit/i)
  })

  it('says where cost analysis belongs instead of silently omitting it', () => {
    render(<AdminPosTransactionsPage />)
    expect(screen.getByText(/they belong to reporting/)).toBeTruthy()
  })

  it('shows who rang each sale up, and where', () => {
    state.rows = [row()]
    render(<AdminPosTransactionsPage />)
    expect(screen.getByText('Liza Fernandez')).toBeTruthy()
    expect(screen.getAllByText('Cavite Branch').length).toBeGreaterThan(0)
  })

  it('offers a receipt for each sale, addressed by the sale it belongs to', () => {
    state.rows = [row()]
    render(<AdminPosTransactionsPage />)
    expect(screen.getByRole('button', { name: 'Receipt for 11111111' })).toBeTruthy()
  })

  it('explains an empty history rather than showing a bare grid', () => {
    render(<AdminPosTransactionsPage />)
    expect(screen.getByText('No sales have been recorded yet.')).toBeTruthy()
  })
})
