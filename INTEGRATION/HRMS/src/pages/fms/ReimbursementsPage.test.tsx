import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * The Finance Staff review queue, and the three things acceptance found wrong
 * with it on RB-2026-0001.
 *
 * The claim showed Category "Not classified" and Budget "Not assigned" with no
 * controls to set either — the classification panel lives in the requests queue
 * and had never been wired into this one. "Forward for approval" was offered
 * regardless, and forwarding an unclassified claim works: approval only reserves
 * when budget_id is not null, so the claim would have gone to the Finance
 * Manager and been approved against nothing. And Forward opened a *required*
 * "Reason" whose placeholder was "The receipt does not match the amount
 * claimed…", so passing a good claim along meant typing a complaint about it.
 */

const claim = {
  id: 'rb1',
  request_no: 'RB-2026-0001',
  title: 'Client meeting transport',
  justification: 'Site visit',
  requester_id: 'marc',
  requester_name: 'Marc Villanueva',
  finance_category_id: null as string | null,
  finance_category_name: null as string | null,
  budget_id: null as string | null,
  budget_name: null as string | null,
  amount: 1000,
  expense_date: '2026-09-07',
  status: 'pending_validation',
  amount_paid: 0,
  balance_due: 1000,
  pending_payment_amount: 0,
  available_to_prepare: 0,
  settlement_state: null,
}

const state = { role: 'finance_staff', viewer: 'alice', claim: { ...claim } }
const moved: Array<Record<string, unknown>> = []

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: state.viewer, role: state.role } }),
}))

vi.mock('@/hooks/useReimbursements', () => ({
  useReimbursements: () => ({ data: [state.claim], isLoading: false, isError: false, error: null }),
  useReimbursementPayments: () => ({ data: [] }),
  useCreateReimbursementPayment: () => ({ mutate: vi.fn(), isPending: false }),
  useTransitionReimbursement: () => ({
    mutate: (input: Record<string, unknown>) => {
      moved.push(input)
    },
    isPending: false,
  }),
  useTransitionReimbursementPayment: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/useFinanceMasterData', () => ({
  useBudgets: () => ({ data: [{ id: 'b-active', name: 'Operations 2026', status: 'active' }] }),
  useFinanceCategories: () => ({
    data: [{ id: 'c1', name: 'Transport', kind: 'expense', is_active: true }],
  }),
  useVendors: () => ({ data: [] }),
}))

vi.mock('@/hooks/useFinanceRequests', () => ({
  useUpdateFinanceRequest: () => ({ mutate: vi.fn(), isPending: false }),
}))

const ReimbursementsPage = (await import('@/pages/fms/ReimbursementsPage')).default

// The payment dialog is mounted alongside the detail and reads treasury
// accounts, so the page needs a real client even though nothing here pays
// anything. Retries off: a failing query should surface, not be attempted three
// times while the test waits.
function open() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <ReimbursementsPage />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByText('RB-2026-0001'))
  return view
}

beforeEach(() => {
  state.role = 'finance_staff'
  state.viewer = 'alice'
  state.claim = { ...claim }
  moved.length = 0
})

afterEach(cleanup)

describe('classifying from the reimbursement queue', () => {
  it('puts the controls in front of Finance Staff, where there were none', () => {
    open()
    expect(screen.getByText('Classification')).toBeTruthy()
    expect(screen.getByLabelText(/Budget/)).toBeTruthy()
    expect(screen.getByLabelText('Category')).toBeTruthy()
  })

  it('does not put them in front of the Finance Manager or the Accountant', () => {
    for (const role of ['finance_manager', 'accountant']) {
      state.role = role
      const { unmount } = open()
      expect(screen.queryByText('Classification'), role).toBeNull()
      unmount()
    }
  })
})

describe('forwarding a claim that is not classified', () => {
  it('refuses to offer the forward, and says what is missing', () => {
    open()
    const forward = screen.getByRole('button', { name: 'Forward for approval' }) as HTMLButtonElement
    expect(forward.disabled).toBe(true)
    expect(screen.getByText(/Assign a budget before forwarding/)).toBeTruthy()
  })

  it('still lets it be returned or rejected — that is what should happen to it', () => {
    open()
    for (const label of ['Return for correction', 'Reject']) {
      const button = screen.getByRole('button', { name: label }) as HTMLButtonElement
      expect(button.disabled, label).toBe(false)
    }
  })

  it('allows the forward once a budget is on the claim', () => {
    state.claim = { ...claim, budget_id: 'b-active', budget_name: 'Operations 2026' }
    open()
    const forward = screen.getByRole('button', { name: 'Forward for approval' }) as HTMLButtonElement
    expect(forward.disabled).toBe(false)
    expect(screen.queryByText(/Assign a budget before forwarding/)).toBeNull()
  })
})

describe('what the dialog asks for', () => {
  beforeEach(() => {
    state.claim = { ...claim, budget_id: 'b-active', budget_name: 'Operations 2026' }
  })

  it('asks for an optional note when forwarding, not a grievance', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Forward for approval' }))
    expect(screen.getByText(/Note for the Finance Manager/)).toBeTruthy()
    expect(screen.getByText('(optional)')).toBeTruthy()
    // The defect, named so it cannot come back: rejection copy on a step
    // forward.
    const placeholder = screen.getByRole('textbox').getAttribute('placeholder') ?? ''
    expect(placeholder).not.toMatch(/does not match/i)
    expect(screen.queryByText(/shown to the employee/)).toBeNull()
  })

  it('lets the forward go through with the note left blank', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Forward for approval' }))
    const confirm = screen.getAllByRole('button', { name: 'Forward for approval' }).at(-1)!
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirm)
    expect(moved).toEqual([{ id: 'rb1', to: 'pending_approval', remarks: null }])
  })

  it('still demands a reason to return a claim, and says who reads it', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Return for correction' }))
    expect(screen.getByText(/This is kept with the claim and shown to the employee/)).toBeTruthy()
    // Required, and labelled as a reason rather than a note.
    expect(screen.queryByText('(optional)')).toBeNull()
    expect(screen.getByLabelText(/^Reason/)).toBeTruthy()

    // What "required" actually means here: it cannot be sent empty.
    const confirm = screen.getAllByRole('button', { name: 'Return for correction' }).at(-1)!
    expect((confirm as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'The receipt is missing.' },
    })
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirm)
    expect(moved).toEqual([
      { id: 'rb1', to: 'returned', remarks: 'The receipt is missing.' },
    ])
  })

  it('keeps the rejection wording where a rejection is what is happening', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const placeholder = screen.getByRole('textbox').getAttribute('placeholder') ?? ''
    expect(placeholder).toMatch(/does not match/i)
  })
})

describe('reviewing moves no money', () => {
  it('offers no payment controls while the claim is still being reviewed', () => {
    open()
    expect(screen.queryByText('Prepare payment')).toBeNull()
    expect(screen.queryByRole('button', { name: /Prepare/ })).toBeNull()
  })
})
