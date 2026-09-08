import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Expense summary, revenue summary and the cash-basis income statement.
 *
 * The check that matters most is the one about where the numbers come from: all
 * three read posted journal lines and nothing else. A report that queried
 * payments or payroll directly would be a second opinion about what the company
 * spent, and two sets of books is the failure F8 exists to prevent.
 *
 * Payroll is the sharpest case. A payroll disbursement posts as one aggregate
 * line, so the reports can show what payroll cost without anyone reading a
 * salary — Finance Staff can total the expense and still not see a person's pay.
 */

const LINES = [
  {
    id: 'l1',
    journal_entry_id: 'e1',
    journal_no: 'JE-2026-0001',
    posting_date: '2026-09-08',
    description: 'Payroll disbursement PD-2026-0001',
    source_type: 'payroll_disbursement',
    source_reference: 'PD-2026-0001',
    account_id: 'a-payroll',
    account_code: '5200',
    account_name: 'Payroll Expense',
    account_type: 'expense' as const,
    line_no: 1,
    line_description: null,
    debit: 60000,
    credit: 0,
  },
  {
    id: 'l2',
    journal_entry_id: 'e2',
    journal_no: 'JE-2026-0002',
    posting_date: '2026-09-08',
    description: 'Reimbursement payment RB-2026-0001',
    source_type: 'reimbursement_payment',
    source_reference: 'RB-2026-0001',
    account_id: 'a-reimb',
    account_code: '5100',
    account_name: 'Employee Reimbursement Expense',
    account_type: 'expense' as const,
    line_no: 1,
    line_description: null,
    debit: 1000,
    credit: 0,
  },
  {
    id: 'l3',
    journal_entry_id: 'e3',
    journal_no: 'JE-2026-0003',
    posting_date: '2026-09-08',
    description: 'Collection settlement CS-2026-0001',
    source_type: 'collection_settlement',
    source_reference: 'CS-2026-0001',
    account_id: 'a-sales',
    account_code: '4000',
    account_name: 'Sales Revenue',
    account_type: 'revenue' as const,
    line_no: 3,
    line_description: null,
    debit: 0,
    credit: 90000,
  },
  {
    id: 'l4',
    journal_entry_id: 'e3',
    journal_no: 'JE-2026-0003',
    posting_date: '2026-09-08',
    description: 'Collection settlement CS-2026-0001',
    source_type: 'collection_settlement',
    source_reference: 'CS-2026-0001',
    account_id: 'a-bank',
    account_code: '1100',
    account_name: 'BDO Current Account',
    account_type: 'asset' as const,
    line_no: 1,
    line_description: null,
    debit: 90000,
    credit: 0,
  },
]

const asked: Array<Record<string, unknown>> = []
const state = { isError: false }

vi.mock('@/hooks/useAccounting', () => ({
  useLedgerLines: (filters: Record<string, unknown>) => {
    asked.push({ ...filters })
    return { data: LINES, isLoading: false, isError: state.isError }
  },
}))

import AccountingReportsPage from '@/pages/fms/AccountingReportsPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AccountingReportsPage />
    </QueryClientProvider>,
  )
}

/** Radix Tabs switch on mousedown, not click. */
function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 })
}

beforeEach(() => {
  asked.length = 0
})
afterEach(() => {
  cleanup()
  state.isError = false
})

describe('AccountingReportsPage', () => {
  it('reads posted journal lines and nothing else', () => {
    renderPage()
    // Every figure came through the one ledger hook. If a second source ever
    // appears, the two can disagree — which is the thing a general ledger
    // exists to make impossible.
    expect(asked.length).toBeGreaterThan(0)
    // From disk: under Vite, import.meta.url is an http URL.
    const source = readFileSync(
      resolve(process.cwd(), 'src/pages/fms/AccountingReportsPage.tsx'),
      'utf8',
    )
    expect(source).not.toMatch(
      /useSupplierPayments|usePayroll|useFinanceSales|useReimbursements|from\('(supplier_payments|payroll|pos_sales)/,
    )
  })

  it('sums revenue and expenses from the lines, with the difference between', () => {
    renderPage()
    // Scoped to the statement itself: the same three words also label the
    // summary cards above it.
    const statement = within(screen.getByRole('table'))
    expect(statement.getByText('Revenue received').closest('tr')!.textContent).toContain(
      '₱90,000.00',
    )
    expect(statement.getByText('Expenses paid').closest('tr')!.textContent).toContain(
      '(₱61,000.00)',
    )
    expect(statement.getByText('Net income').closest('tr')!.textContent).toContain('₱29,000.00')
  })

  it('ignores asset lines, so cash movement is not counted as income', () => {
    renderPage()
    // The bank leg of the collection is ₱90,000 too; counting it would double
    // the revenue.
    const statement = within(screen.getByRole('table'))
    expect(statement.getByText('Revenue received').closest('tr')!.textContent).not.toContain(
      '₱180,000.00',
    )
  })

  it('breaks expenses down by account', () => {
    renderPage()
    openTab('Expense summary')
    const payroll = screen.getByText('Payroll Expense').closest('tr')!
    expect(within(payroll).getAllByRole('cell')[2].textContent).toBe('₱60,000.00')
    const total = screen.getByRole('cell', { name: 'Total expenses' }).closest('tr')!
    expect(within(total).getAllByRole('cell')[1].textContent).toBe('₱61,000.00')
  })

  // Payroll appears as one figure against one account. There is no employee, no
  // salary and no payslip on this page for a Finance Staff reader to find.
  it('shows payroll as a single aggregate expense with no salary detail', () => {
    const { container } = renderPage()
    openTab('Expense summary')

    // One row for payroll, carrying one figure. Not one row per person.
    expect(screen.getAllByText('Payroll Expense')).toHaveLength(1)
    const rows = screen.getAllByRole('row')
    expect(rows.filter((r) => r.textContent?.includes('Payroll'))).toHaveLength(1)

    // "Employee Reimbursement Expense" is an account name and is fine; a
    // payslip, a salary or a named person's pay is what must not be here.
    expect(container.textContent).not.toMatch(/payslip|salary|net pay|gross pay|basic pay/i)
  })

  it('says plainly that it is cash basis and what it leaves out', () => {
    renderPage()
    expect(screen.getByText(/Cash basis/)).toBeTruthy()
    expect(screen.getByText(/no cost of sales, depreciation or tax/i)).toBeTruthy()
  })

  it('passes the date range to the query', () => {
    renderPage()
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } })
    expect(asked[asked.length - 1]).toMatchObject({ from: '2026-09-01', to: '2026-09-30' })
  })

  it('shows no figures at all when the query failed', () => {
    state.isError = true
    renderPage()
    expect(screen.getByText('The reports could not be loaded')).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'Income statement' })).toBeNull()
  })

  // Not an empty loop over zero buttons: the assertion is over the whole
  // rendered page, so a control added later is caught wherever it is put.
  it('offers no journal creation, adjustment or approval control', () => {
    const { container } = renderPage()
    expect(container.textContent).not.toMatch(
      /new entry|new journal|adjusting|adjustment|closing entry|approve|reverse|post entry/i,
    )
    for (const el of screen.queryAllByRole('button')) {
      expect(el.textContent ?? '').not.toMatch(/new|adjust|approve|post|reverse/i)
    }
  })
})
