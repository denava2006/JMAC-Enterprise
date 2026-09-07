import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Who gets the classification controls, and what forwarding still needs.
 *
 * F7 continuation acceptance opened RB-2026-0001 as Finance Staff and found
 * Category "Not classified", Budget "Not assigned", no controls for either, and
 * "Forward for approval" offered anyway. Forwarding would have worked and
 * approval would then have reserved nothing, because transition_finance_request
 * only commits when budget_id is not null.
 *
 * These pin what the browser decides. The database decides the same things
 * again, in finance_requests_classify, protect_finance_request and
 * require_budget_before_validation, and
 * supabase/tests/reimbursement_classification_rls.sql proves that half.
 */

const state: { role: string; viewer: string } = { role: 'finance_staff', viewer: 'alice' }
const saved: Array<Record<string, unknown>> = []

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: state.viewer, role: state.role } }),
}))

vi.mock('@/hooks/useFinanceMasterData', () => ({
  useBudgets: () => ({
    data: [
      { id: 'b-active', name: 'Operations 2026', status: 'active' },
      { id: 'b-draft', name: 'Not yet approved', status: 'draft' },
      { id: 'b-closed', name: 'Last year', status: 'closed' },
    ],
  }),
  useFinanceCategories: () => ({
    data: [
      { id: 'c1', name: 'Transport', kind: 'expense', is_active: true },
      { id: 'c2', name: 'Retired', kind: 'expense', is_active: false },
    ],
  }),
  useVendors: () => ({ data: [{ id: 'v1', name: 'A Vendor', is_active: true }] }),
}))

vi.mock('@/hooks/useFinanceRequests', () => ({
  useUpdateFinanceRequest: () => ({
    mutate: (input: Record<string, unknown>) => {
      saved.push(input)
    },
    isPending: false,
  }),
}))

const { ClassificationPanel, canClassify, missingBeforeForwarding } = await import(
  '@/components/fms/ClassificationPanel'
)

const CLAIM: {
  id: string
  status: string
  requester_id: string
  budget_id: string | null
  finance_category_id: string | null
} = {
  id: 'rb1',
  status: 'pending_validation',
  requester_id: 'marc',
  budget_id: null,
  finance_category_id: null,
}

function show(over: Partial<typeof CLAIM> = {}, showVendor = false) {
  return render(
    <ClassificationPanel record={{ ...CLAIM, ...over }} showVendor={showVendor} />,
  )
}

beforeEach(() => {
  state.role = 'finance_staff'
  state.viewer = 'alice'
  saved.length = 0
})

afterEach(cleanup)

describe('who may classify', () => {
  it('gives Finance Staff the controls while the claim is theirs to validate', () => {
    show()
    expect(screen.getByText('Classification')).toBeTruthy()
    expect(screen.getByLabelText(/Budget/)).toBeTruthy()
    expect(screen.getByLabelText('Category')).toBeTruthy()
  })

  it('gives them to nobody else', () => {
    for (const role of ['finance_manager', 'accountant', 'employee', 'admin', 'hr_staff']) {
      state.role = role
      const { unmount } = show()
      expect(screen.queryByText('Classification'), role).toBeNull()
      unmount()
    }
  })

  it('does not let Finance Staff classify their own claim', () => {
    // Holding the role does not make your own claim somebody else's to check.
    state.viewer = 'marc'
    show()
    expect(screen.queryByText('Classification')).toBeNull()
    expect(canClassify({ status: 'pending_validation', requester_id: 'marc' }, 'finance_staff', 'marc'))
      .toBe(false)
  })

  it('withdraws the controls outside validation', () => {
    for (const status of ['draft', 'pending_approval', 'approved', 'completed', 'returned', 'rejected']) {
      const { unmount } = show({ status })
      expect(screen.queryByText('Classification'), status).toBeNull()
      unmount()
    }
  })
})

describe('what it offers', () => {
  it('offers only budgets that can actually receive a commitment', () => {
    show()
    fireEvent.keyDown(screen.getByLabelText(/Budget/), { key: 'ArrowDown' })
    expect(screen.getByText('Operations 2026')).toBeTruthy()
    // A draft or closed budget cannot be committed against, and the server
    // refuses one at forwarding, so it is not offered here either.
    expect(screen.queryByText('Not yet approved')).toBeNull()
    expect(screen.queryByText('Last year')).toBeNull()
  })

  it('offers only live expense categories', () => {
    show()
    fireEvent.keyDown(screen.getByLabelText('Category'), { key: 'ArrowDown' })
    expect(screen.getByText('Transport')).toBeTruthy()
    expect(screen.queryByText('Retired')).toBeNull()
  })

  it('has no vendor for a reimbursement — the employee already paid', () => {
    show()
    expect(screen.queryByLabelText('Vendor')).toBeNull()
  })

  it('keeps the vendor for a purchase, where there is somebody to pay', () => {
    show({}, true)
    expect(screen.getByLabelText('Vendor')).toBeTruthy()
  })
})

describe('what it says is still needed', () => {
  it('names the missing budget, and who receives the claim next', () => {
    show()
    expect(screen.getByText(/Still needed before forwarding: a budget/)).toBeTruthy()
  })

  it('says it is ready once a budget is assigned', () => {
    show({ budget_id: 'b-active' })
    expect(screen.getByText(/Ready to forward to the Finance Manager/)).toBeTruthy()
  })

  it('treats the budget as the requirement and the category as optional', () => {
    // Every budget already carries its own finance_category_id, so demanding a
    // second one on the request asks twice for something already known.
    expect(missingBeforeForwarding({ budget_id: null })).toEqual(['a budget'])
    expect(missingBeforeForwarding({ budget_id: 'b-active' })).toEqual([])
  })
})

describe('saving a classification', () => {
  it('sends the classification and nothing else', () => {
    show({ budget_id: null })
    fireEvent.keyDown(screen.getByLabelText(/Budget/), { key: 'ArrowDown' })
    fireEvent.click(screen.getByText('Operations 2026'))
    fireEvent.click(screen.getByRole('button', { name: 'Save classification' }))

    expect(saved.length).toBe(1)
    const values = saved[0].values as Record<string, unknown>
    expect(saved[0].id).toBe('rb1')
    expect(values.budget_id).toBe('b-active')
    // Classification only. Not the amount, not the status, not a payment.
    for (const forbidden of ['amount', 'status', 'paid_at', 'payment_reference', 'requester_id']) {
      expect(Object.keys(values), forbidden).not.toContain(forbidden)
    }
  })

  it('leaves the vendor alone on a reimbursement rather than nulling it', () => {
    show({ budget_id: null })
    fireEvent.keyDown(screen.getByLabelText(/Budget/), { key: 'ArrowDown' })
    fireEvent.click(screen.getByText('Operations 2026'))
    fireEvent.click(screen.getByRole('button', { name: 'Save classification' }))
    expect(Object.keys(saved[0].values as object)).not.toContain('vendor_id')
  })

  it('does not offer to save what has not changed', () => {
    show({ budget_id: 'b-active' })
    const save = screen.getByRole('button', { name: 'Save classification' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })
})
