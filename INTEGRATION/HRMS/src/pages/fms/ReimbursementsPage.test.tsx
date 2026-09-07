import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

// The trail as the database holds it for RB-2026-0001: Marc submitted, Alice
// forwarded, and the Finance Manager has not decided yet.
const TRAIL = [
  {
    id: 'a1',
    action: 'submitted',
    actor_id: 'marc',
    remarks: null as string | null,
    created_at: '2026-09-07T01:08:00.000Z',
  },
  {
    id: 'a2',
    action: 'validated',
    actor_id: 'alice',
    remarks: 'Receipt checked against the amount claimed.' as string | null,
    created_at: '2026-09-07T03:20:00.000Z',
  },
]

const history: {
  trail: typeof TRAIL
  isLoading: boolean
  isError: boolean
  error: unknown
  names: Map<string, string> | undefined
  namesLoading: boolean
} = {
  trail: TRAIL,
  isLoading: false,
  isError: false,
  error: null,
  names: new Map([
    ['marc', 'Marc Villanueva'],
    ['alice', 'Alice Dela Cruz'],
  ]),
  namesLoading: false,
}

vi.mock('@/hooks/useFinanceRequests', () => ({
  useUpdateFinanceRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useRequestTrail: () => ({
    data: history.trail,
    isLoading: history.isLoading,
    isError: history.isError,
    error: history.error,
  }),
  useRequestParticipants: () => ({ data: history.names, isLoading: history.namesLoading }),
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

/** The trail's own block. The claimant's name also appears in the table row and
 *  the dialog header, so an unscoped query for it is ambiguous rather than
 *  wrong. */
function historyRegion(): HTMLElement {
  return screen.getByText('History').parentElement as HTMLElement
}

beforeEach(() => {
  state.role = 'finance_staff'
  state.viewer = 'alice'
  state.claim = { ...claim }
  moved.length = 0
  history.trail = TRAIL
  history.isLoading = false
  history.isError = false
  history.error = null
  history.names = new Map([
    ['marc', 'Marc Villanueva'],
    ['alice', 'Alice Dela Cruz'],
  ])
  history.namesLoading = false
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

/**
 * The Finance Manager was being asked to approve RB-2026-0001 with no way to
 * see that Marc had submitted it and Alice had forwarded it — the review
 * surface had no History section and no link to one. The trail existed the
 * whole time; only this page could not see it.
 */
describe('the history a Manager approves against', () => {
  beforeEach(() => {
    state.role = 'finance_manager'
    state.viewer = 'angelo'
    state.claim = { ...claim, status: 'pending_approval', budget_id: 'b-active' }
  })

  it('shows the submission and who made it', () => {
    open()
    const trail = historyRegion()
    expect(within(trail).getByText('Submitted')).toBeTruthy()
    // Scoped to the trail: the claimant's name is also in the table row and in
    // the dialog header, which is correct and not what this is asking about.
    expect(within(trail).getByText('Marc Villanueva')).toBeTruthy()
  })

  it('shows the Finance Staff forwarding, named after the act performed', () => {
    open()
    // The button that writes this row says "Forward for approval", so calling
    // the row "Validated" makes a reader check whether they pressed the wrong
    // thing. Purchases keep "Validated" — that is what it is called there.
    const trail = historyRegion()
    expect(within(trail).getByText('Forwarded for approval')).toBeTruthy()
    expect(within(trail).getByText(/Alice Dela Cruz/)).toBeTruthy()
  })

  it('carries the note Finance Staff left with it', () => {
    open()
    expect(
      within(historyRegion()).getByText(/Receipt checked against the amount claimed\./),
    ).toBeTruthy()
  })

  it('keeps the events in the order they happened', () => {
    open()
    const text = historyRegion().textContent ?? ''
    expect(text).toContain('Submitted')
    expect(text.indexOf('Submitted')).toBeLessThan(text.indexOf('Forwarded for approval'))
  })

  it('shows no approval, because there has not been one', () => {
    open()
    expect(within(historyRegion()).queryByText('Approved')).toBeNull()
    // The action is still on offer; it is the event that has not happened.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  })

  it('stamps the times in Manila, and says so', () => {
    open()
    // Compared against an explicit Manila formatter rather than a literal, and
    // that matters: this runner sits at UTC+8, where the browser's own clock
    // agrees with Manila to the minute. A loose assertion like /9:08/ passes
    // whichever implementation is in place here and only fails on somebody
    // else's machine. Matching the whole formatted string pins the zone and the
    // format together, so reverting to toLocaleString() fails everywhere.
    const expected = new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date('2026-09-07T01:08:00.000Z'))

    const trail = historyRegion()
    expect(within(trail).getByText(expected)).toBeTruthy()
    expect(within(trail).getByText(/Philippine Standard Time/)).toBeTruthy()
  })

  it('exposes no ids, enum tokens or database words', () => {
    open()
    // The whole dialog, not just the trail — and read off the document because
    // Radix renders it through a portal, outside the render container.
    const text = document.body.textContent ?? ''
    for (const leak of [
      'pending_approval',
      'pending_validation',
      'validated',
      'finance_request',
      'marc',
      'alice',
      'rb1',
      'b-active',
      'undefined',
      'null',
    ]) {
      expect(text, leak).not.toContain(leak)
    }
  })

  it('does not offer the Manager the classification controls', () => {
    open()
    expect(screen.queryByText('Classification')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save classification' })).toBeNull()
  })

  it('does not offer the Manager the Accountant payment controls', () => {
    open()
    expect(screen.queryByText('Prepare payment')).toBeNull()
  })
})

describe('when the history cannot be shown', () => {
  beforeEach(() => {
    state.role = 'finance_manager'
    state.viewer = 'angelo'
    state.claim = { ...claim, status: 'pending_approval', budget_id: 'b-active' }
  })

  it('says it is loading rather than showing an empty trail', () => {
    history.isLoading = true
    history.trail = []
    open()
    expect(screen.getByText(/Loading the history/)).toBeTruthy()
    expect(screen.queryByText(/Nothing has happened/)).toBeNull()
  })

  it('says it failed rather than looking like nothing happened', () => {
    // The two look identical to a reader and are very different things to
    // approve against.
    history.isError = true
    history.error = new Error('permission denied')
    history.trail = []
    open()
    expect(screen.getByText(/could not be loaded/)).toBeTruthy()
    expect(screen.queryByText(/Nothing has happened/)).toBeNull()
  })

  it('says plainly when there is genuinely nothing yet', () => {
    history.trail = []
    open()
    expect(screen.getByText(/Nothing has happened to this request yet/)).toBeTruthy()
  })

  it('names an actor it cannot resolve rather than leaving a half-drawn row', () => {
    history.names = new Map()
    open()
    expect(screen.getAllByText(/Unknown user/).length).toBeGreaterThan(0)
  })
})

describe('reviewing moves no money', () => {
  it('offers no payment controls while the claim is still being reviewed', () => {
    open()
    expect(screen.queryByText('Prepare payment')).toBeNull()
    expect(screen.queryByRole('button', { name: /Prepare/ })).toBeNull()
  })
})
