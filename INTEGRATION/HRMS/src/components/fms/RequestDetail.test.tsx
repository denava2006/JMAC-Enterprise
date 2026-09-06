import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * The Draft reimbursement detail, and the two defects acceptance found in it.
 *
 * RB-2026-0001 was raised as a Draft for a controlled F7 acceptance run. Opening
 * it offered Submit, Cancel request and Close — so a wrong amount could only be
 * fixed by cancelling the claim and typing a second one, which is how one test
 * record becomes two records and a cancelled one. And the expense date, stored
 * since the claim was first saved, was displayed nowhere: a reviewer approved an
 * expense without being shown the day it happened.
 *
 * These cover what the browser decides. What the browser is not allowed to
 * decide — who may edit, in what state, and which columns — is settled in
 * update_finance_request_draft and proved in
 * supabase/tests/reimbursement_draft_edit_rls.sql.
 */

type Request = {
  id: string
  request_no: string
  type: string
  title: string
  description: string | null
  justification: string | null
  requester_id: string
  amount: number
  priority: string
  status: string
  expense_date: string | null
  needed_by: string | null
  budget_id: string | null
  finance_category_id: string | null
  vendor_id: string | null
  updated_at: string
  budgets: null
  finance_categories: null
  vendors: null
  finance_accounts: null
}

const ME = 'marc'
const SOMEONE_ELSE = 'other'

function claim(over: Partial<Request> = {}): Request {
  return {
    id: 'rb1',
    request_no: 'RB-2026-0001',
    type: 'reimbursement',
    title: 'Client meeting transport',
    description: 'Grab fares',
    justification: 'Site visit',
    requester_id: ME,
    amount: 1000,
    priority: 'medium',
    status: 'draft',
    expense_date: '2026-09-07',
    needed_by: null,
    budget_id: null,
    finance_category_id: null,
    vendor_id: null,
    updated_at: '2026-09-07T01:00:00.000Z',
    budgets: null,
    finance_categories: null,
    vendors: null,
    finance_accounts: null,
    ...over,
  }
}

const state: { request: Request; role: string; viewer: string } = {
  request: claim(),
  role: 'employee',
  viewer: ME,
}

const saved: Array<Record<string, unknown>> = []

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: state.viewer, role: state.role } }),
}))

vi.mock('@/hooks/useFinanceRequests', () => ({
  useFinanceRequest: () => ({ data: state.request, isLoading: false }),
  useRequestTrail: () => ({ data: [] }),
  useRequestParticipants: () => ({ data: new Map([[ME, 'Marc Villanueva']]) }),
  useTransitionRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateFinanceRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateRequestDraft: () => ({
    mutateAsync: async (input: Record<string, unknown>) => {
      saved.push(input)
    },
    isPending: false,
  }),
}))

vi.mock('@/hooks/useFinanceMasterData', () => ({
  useBudgets: () => ({ data: [] }),
  useFinanceCategories: () => ({ data: [] }),
  useVendors: () => ({ data: [] }),
}))

const { RequestDetail } = await import('@/components/fms/RequestDetail')

function show() {
  return render(<RequestDetail requestId="rb1" onOpenChange={() => {}} />)
}

beforeEach(() => {
  state.request = claim()
  state.role = 'employee'
  state.viewer = ME
  saved.length = 0
})

afterEach(cleanup)

describe('correcting a draft', () => {
  it('offers Edit to the claimant on their own Draft', () => {
    show()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    // Alongside what was already there, not instead of it.
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeTruthy()
  })

  it('offers it to nobody else, however senior', () => {
    state.viewer = SOMEONE_ELSE
    state.role = 'finance_manager'
    show()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('withdraws it the moment the claim is submitted', () => {
    for (const status of ['pending_validation', 'pending_approval', 'approved', 'completed']) {
      state.request = claim({ status })
      const { unmount } = show()
      expect(screen.queryByRole('button', { name: 'Edit' }), status).toBeNull()
      unmount()
    }
  })

  it('sends the corrected fields, and nothing beyond them', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const amount = screen.getByLabelText('Amount') as HTMLInputElement
    fireEvent.change(amount, { target: { value: '1250.5' } })
    const title = screen.getByLabelText('What is this for?') as HTMLInputElement
    fireEvent.change(title, { target: { value: 'Client meeting transport (corrected)' } })
    const spent = screen.getByLabelText('Date spent') as HTMLInputElement
    fireEvent.change(spent, { target: { value: '2026-09-05' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(saved.length).toBe(1))
    const sent = saved[0]
    expect(sent.requestId).toBe('rb1')
    expect(sent.amount).toBe(1250.5)
    expect(sent.title).toBe('Client meeting transport (corrected)')
    expect(sent.expenseDate).toBe('2026-09-05')

    // The whole point of a dedicated function rather than a PATCH: there is no
    // budget, classification, status or payment field to send, so a bug in this
    // form cannot become a bug in the money.
    for (const forbidden of [
      'budget_id',
      'budgetId',
      'finance_category_id',
      'vendor_id',
      'status',
      'requester_id',
      'request_no',
      'type',
      'paid_at',
      'payment_reference',
    ]) {
      expect(Object.keys(sent), forbidden).not.toContain(forbidden)
    }
  })

  it('carries the version it rendered, so a stale tab cannot overwrite a newer save', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(saved.length).toBe(1))
    expect(saved[0].expectedUpdatedAt).toBe('2026-09-07T01:00:00.000Z')
  })

  it('refuses an empty amount in the browser, before the server has to', async () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(screen.getByText('An amount must be more than zero')).toBeTruthy(),
    )
    expect(saved.length).toBe(0)
  })

  it('does not offer a purchase a date the money was already spent', () => {
    state.request = claim({ type: 'purchase', expense_date: null, needed_by: '2026-10-01' })
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByLabelText('Date spent')).toBeNull()
    expect(screen.getByLabelText('Needed by')).toBeTruthy()
  })
})

describe('the expense date is on the screen', () => {
  it('shows the day a reimbursement was spent', () => {
    show()
    expect(screen.getByText('Date spent')).toBeTruthy()
    // The stored date, not the one a timezone conversion lands on. 2026-09-07
    // parsed as UTC midnight renders as the 6th anywhere west of Greenwich.
    expect(screen.getByText('Sep 7, 2026')).toBeTruthy()
  })

  it('shows a purchase its needed-by date instead — neither type has both', () => {
    state.request = claim({ type: 'purchase', expense_date: null, needed_by: '2026-10-01' })
    show()
    expect(screen.getByText('Needed by')).toBeTruthy()
    expect(screen.getByText('Oct 1, 2026')).toBeTruthy()
    expect(screen.queryByText('Date spent')).toBeNull()
  })

  it('says so plainly when a claim has no expense date', () => {
    state.request = claim({ expense_date: null })
    show()
    expect(screen.getByText('Date spent')).toBeTruthy()
  })
})
