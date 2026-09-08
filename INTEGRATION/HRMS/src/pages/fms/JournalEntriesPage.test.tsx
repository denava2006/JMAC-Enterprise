import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * The journal register, and the things it must never offer.
 *
 * Two of the checks here are about absence. F8 posts entries from completed
 * transactions and nothing else may write one, so a "New journal entry" button
 * or an approve control would not merely be dead UI — it would advertise an
 * accounting process JMAC deliberately does not have.
 */

const ENTRY = {
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  journal_no: 'JE-2026-0001',
  posting_date: '2026-09-08',
  description: 'Reimbursement payment RB-2026-0001',
  source_type: 'reimbursement_payment',
  source_reference: 'RB-2026-0001',
  status: 'posted',
  total_debit: 1000,
  total_credit: 1000,
}

const LINES = [
  {
    id: 'l1',
    journal_entry_id: ENTRY.id,
    journal_no: ENTRY.journal_no,
    posting_date: ENTRY.posting_date,
    description: ENTRY.description,
    source_type: ENTRY.source_type,
    source_reference: ENTRY.source_reference,
    account_id: 'f1e2d3c4-b5a6-4978-8899-aabbccddeeff',
    account_code: '5100',
    account_name: 'Employee Reimbursement Expense',
    account_type: 'expense' as const,
    line_no: 1,
    line_description: 'RB-2026-0001',
    debit: 1000,
    credit: 0,
  },
  {
    id: 'l2',
    journal_entry_id: ENTRY.id,
    journal_no: ENTRY.journal_no,
    posting_date: ENTRY.posting_date,
    description: ENTRY.description,
    source_type: ENTRY.source_type,
    source_reference: ENTRY.source_reference,
    account_id: 'aabbccdd-1122-4334-8556-778899aabbcc',
    account_code: '1100',
    account_name: 'BDO Current Account',
    account_type: 'asset' as const,
    line_no: 2,
    line_description: 'RB-2026-0001',
    debit: 0,
    credit: 1000,
  },
]

vi.mock('@/hooks/useAccounting', () => ({
  useJournalEntries: () => ({ data: [ENTRY], isLoading: false, isError: false }),
  useJournalEntryLines: () => ({ data: LINES, isLoading: false, isError: false }),
}))

import JournalEntriesPage from '@/pages/fms/JournalEntriesPage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <JournalEntriesPage />
    </QueryClientProvider>,
  )
}

afterEach(cleanup)

describe('JournalEntriesPage', () => {
  it('lists posted entries with their number, date and amount', () => {
    renderPage()
    expect(screen.getByText('JE-2026-0001')).toBeTruthy()
    expect(screen.getByText('Reimbursement payment RB-2026-0001')).toBeTruthy()
    expect(screen.getAllByText(/₱1,000\.00/).length).toBeGreaterThan(0)
  })

  it('names the source in business terms, not as a column value', () => {
    renderPage()
    expect(screen.getAllByText('Reimbursement payment').length).toBeGreaterThan(0)
    expect(screen.queryByText('reimbursement_payment')).toBeNull()
  })

  it('shows the source document by its business reference', () => {
    renderPage()
    expect(screen.getAllByText('RB-2026-0001').length).toBeGreaterThan(0)
  })

  // The ids exist and are used as React keys and query arguments; what must not
  // happen is a person being shown one in place of a reference they recognise.
  it('never prints a raw uuid', () => {
    const { container } = renderPage()
    fireEvent.click(screen.getByText('JE-2026-0001'))
    expect(container.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )
  })

  it('opens the entry and shows both sides balancing', () => {
    renderPage()
    fireEvent.click(screen.getByText('JE-2026-0001'))
    const detail = screen.getByRole('dialog')
    expect(within(detail).getByText('Employee Reimbursement Expense')).toBeTruthy()
    expect(within(detail).getByText('BDO Current Account')).toBeTruthy()

    // The totals row: the same amount on each side.
    const totals = within(detail).getByText('Total').closest('tr')!
    const cells = within(totals).getAllByRole('cell').map((c) => c.textContent)
    expect(cells[1]).toContain('1,000.00')
    expect(cells[2]).toContain('1,000.00')
  })

  it('offers no way to create a journal entry by hand', () => {
    renderPage()
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/new entry|new journal|add entry|create/i)
    }
  })

  it('offers no approval workflow for an automatic entry', () => {
    renderPage()
    fireEvent.click(screen.getByText('JE-2026-0001'))
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/approve|reject|post entry|reverse|void|edit/i)
    }
  })
})
