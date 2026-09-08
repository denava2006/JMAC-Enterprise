import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * The general ledger: the filters, and the running balance beside each line.
 *
 * The balance is the only figure on any accounting page that is computed in the
 * browser rather than read back, so it is the one that can be wrong on its own.
 */

const BANK = 'aabbccdd-1122-4334-8556-778899aabbcc'
const EXPENSE = 'f1e2d3c4-b5a6-4978-8899-aabbccddeeff'

const ACCOUNTS = [
  { id: BANK, name: 'BDO Current Account', account_code: '1100', account_type: 'asset' },
  {
    id: EXPENSE,
    name: 'Employee Reimbursement Expense',
    account_code: '5100',
    account_type: 'expense',
  },
]

function ledgerLine(n: number, debit: number, credit: number, date: string) {
  return {
    id: `l${n}`,
    journal_entry_id: `e${n}`,
    journal_no: `JE-2026-000${n}`,
    posting_date: date,
    description: `Movement ${n}`,
    source_type: 'collection_settlement',
    source_reference: `CS-2026-000${n}`,
    account_id: BANK,
    account_code: '1100',
    account_name: 'BDO Current Account',
    account_type: 'asset' as const,
    line_no: 1,
    line_description: null,
    debit,
    credit,
  }
}

const LINES = [
  ledgerLine(1, 5000, 0, '2026-09-01'),
  ledgerLine(2, 0, 1000, '2026-09-05'),
  ledgerLine(3, 0, 500, '2026-09-08'),
]

const asked: Array<Record<string, unknown>> = []

vi.mock('@/hooks/useAccounting', () => ({
  useLedgerLines: (filters: Record<string, unknown>, enabled: boolean) => {
    asked.push({ ...filters, enabled })
    return { data: enabled ? LINES : [], isLoading: false, isError: false }
  },
}))

vi.mock('@/hooks/useFinanceMasterData', () => ({
  useFinanceAccounts: () => ({ data: ACCOUNTS, isLoading: false }),
}))

import GeneralLedgerPage from '@/pages/fms/GeneralLedgerPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <GeneralLedgerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The account picker is a listbox, so choosing is two clicks. */
function chooseAccount(label: string) {
  fireEvent.click(screen.getByLabelText('Account'))
  fireEvent.click(screen.getByRole('option', { name: label }))
}

beforeEach(() => {
  asked.length = 0
})
afterEach(cleanup)

describe('GeneralLedgerPage', () => {
  it('asks for nothing until an account is chosen', () => {
    renderPage()
    // The empty state's own sentence: "Choose an account" is also the select's
    // placeholder, so the heading alone is ambiguous.
    expect(screen.getByText(/The ledger shows the movements of a single account/)).toBeTruthy()
    expect(asked.every((a) => a.enabled === false)).toBe(true)
  })

  it('runs the balance down the account rather than repeating a total', () => {
    renderPage()
    chooseAccount('1100 — BDO Current Account')

    const rows = screen.getAllByRole('row')
    const balances = rows
      .map((r) => within(r).queryAllByRole('cell'))
      .filter((cells) => cells.length === 6)
      .map((cells) => cells[5].textContent)

    expect(balances).toEqual(['₱5,000.00', '₱4,000.00', '₱3,500.00'])
  })

  it('shows the closing balance as the last running figure', () => {
    renderPage()
    chooseAccount('1100 — BDO Current Account')
    const closing = screen.getByText('Closing balance').parentElement!
    expect(closing.textContent).toContain('₱3,500.00')
  })

  it('passes the account and both dates to the query', () => {
    renderPage()
    chooseAccount('1100 — BDO Current Account')
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } })

    expect(asked[asked.length - 1]).toMatchObject({
      accountId: BANK,
      from: '2026-09-01',
      to: '2026-09-30',
      enabled: true,
    })
  })

  it('names each line by its source document, not its id', () => {
    const { container } = renderPage()
    chooseAccount('1100 — BDO Current Account')
    expect(screen.getAllByText(/CS-2026-0001/).length).toBeGreaterThan(0)
    expect(container.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )
  })

  // Over the whole page rather than over a list of buttons, so a control added
  // later is caught wherever it is put — and so this does not silently become
  // an empty loop.
  it('offers no way to write to the ledger', () => {
    const { container } = renderPage()
    chooseAccount('1100 — BDO Current Account')
    expect(container.textContent).not.toMatch(
      /new entry|add entry|adjusting|adjustment|correct this|reverse|approve|post entry/i,
    )
    for (const el of screen.queryAllByRole('button')) {
      expect(el.textContent ?? '').not.toMatch(/new|add|adjust|reverse|approve|post/i)
    }
  })
})
