import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * The trial balance.
 *
 * Its whole job is the last row: if the two totals are not equal, something
 * upstream is broken and every other accounting figure is suspect. The page has
 * to say which it is rather than print two long numbers and leave the reader to
 * compare them digit by digit.
 */

const state = {
  rows: [
    {
      account_id: 'a1',
      account_code: '1100',
      account_name: 'BDO Current Account',
      account_type: 'asset' as const,
      debit_balance: 3500,
      credit_balance: 0,
    },
    {
      account_id: 'a2',
      account_code: '4000',
      account_name: 'Sales Revenue',
      account_type: 'revenue' as const,
      debit_balance: 0,
      credit_balance: 5000,
    },
    {
      account_id: 'a3',
      account_code: '5100',
      account_name: 'Employee Reimbursement Expense',
      account_type: 'expense' as const,
      debit_balance: 1500,
      credit_balance: 0,
    },
  ],
  isError: false,
}

vi.mock('@/hooks/useAccounting', () => ({
  useTrialBalance: () => ({ data: state.rows, isLoading: false, isError: state.isError }),
}))

import TrialBalancePage from '@/pages/fms/TrialBalancePage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TrialBalancePage />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  state.isError = false
})

describe('TrialBalancePage', () => {
  it('totals the two columns to the same figure and says so', () => {
    renderPage()
    const total = screen.getByRole('cell', { name: 'Total' }).closest('tr')!
    const cells = within(total).getAllByRole('cell').map((c) => c.textContent)
    expect(cells[1]).toBe('₱5,000.00')
    expect(cells[2]).toBe('₱5,000.00')
    expect(screen.getByText('Debits equal credits.')).toBeTruthy()
  })

  it('lists each account on the side its balance falls', () => {
    renderPage()
    const revenue = screen.getByText('Sales Revenue').closest('tr')!
    const cells = within(revenue).getAllByRole('cell').map((c) => c.textContent)
    expect(cells[3]).toBe('') // nothing in the debit column
    expect(cells[4]).toBe('₱5,000.00')
  })

  // Not a formality. If this ever fires, an entry got in unbalanced, and the
  // page must not present it as an ordinary result.
  it('reports an imbalance loudly rather than rounding it away', () => {
    state.rows = [{ ...state.rows[0], debit_balance: 3501 }, ...state.rows.slice(1)]
    renderPage()
    expect(screen.getByText(/Out of balance by ₱1\.00/)).toBeTruthy()
    expect(screen.getByText(/Raise it before relying on any figure/)).toBeTruthy()
    state.rows = [{ ...state.rows[0], debit_balance: 3500 }, ...state.rows.slice(1)]
  })

  it('shows nothing rather than zeros when the query failed', () => {
    state.isError = true
    renderPage()
    expect(screen.getByText('The trial balance could not be loaded')).toBeTruthy()
    expect(screen.queryByRole('cell', { name: 'Total' })).toBeNull()
  })
})
