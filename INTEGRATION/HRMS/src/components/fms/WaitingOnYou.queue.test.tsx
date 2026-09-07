import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The work queue against real claim and payment data.
 *
 * WaitingOnYou.test.ts covers waitingWork, which takes counts already computed.
 * The F7-QA-10 defect was in the computing: the overview counted approved
 * claims with balance_due > 0, and balance_due subtracts only what has been
 * PAID. RB-2026-0001 had ₱1,000 owing with a ₱1,000 instruction already sitting
 * with the Finance Manager, so the Accountant was told they had work while the
 * detail page — asking available_to_prepare — correctly showed them none.
 *
 * So these drive the component with claims and payments and read the rendered
 * queue, which is the only place the two could disagree.
 *
 * The fixtures are the controlled production records.
 */

const CLAIM = {
  id: 'rb1',
  request_no: 'RB-2026-0001',
  status: 'approved',
  amount: 1000,
  amount_paid: 0,
  balance_due: 1000,
  pending_payment_amount: 1000,
  available_to_prepare: 0,
}

const PAYMENT = {
  id: 'rv1',
  payment_no: 'RV-2026-0001',
  finance_request_id: 'rb1',
  amount: 1000,
  status: 'for_approval',
}

const state: {
  role: string
  claims: Array<Record<string, unknown>>
  payments: Array<Record<string, unknown>>
} = { role: 'accountant', claims: [CLAIM], payments: [PAYMENT] }

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'u1', role: state.role } }),
}))

vi.mock('@/hooks/useReimbursements', () => ({
  useReimbursements: () => ({ data: state.claims }),
  useReimbursementPayments: () => ({ data: state.payments }),
}))

// Everything else this component reads. Empty, so nothing else can put a row
// in the list and make a count assertion pass for the wrong reason.
vi.mock('@/hooks/useFinanceMasterData', () => ({
  useBudgets: () => ({ data: [] }),
  useFinanceCategories: () => ({ data: [] }),
  useVendors: () => ({ data: [] }),
}))
vi.mock('@/hooks/useFinanceRequests', () => ({ useFinanceRequests: () => ({ data: [] }) }))
vi.mock('@/hooks/useProcurement', () => ({
  useProcurementDemand: () => ({ data: [] }),
  usePurchaseOrders: () => ({ data: [] }),
}))
vi.mock('@/hooks/useSupplierInvoices', () => ({
  useSupplierInvoices: () => ({ data: [] }),
  useInvoiceablePurchaseOrders: () => ({ data: [] }),
}))
vi.mock('@/hooks/usePayrollFinance', () => ({
  usePayrollFinanceBatches: () => ({ data: [] }),
  usePayrollDisbursements: () => ({ data: [] }),
}))

const { WaitingOnYou } = await import('@/components/fms/WaitingOnYou')

function show() {
  return render(
    <MemoryRouter>
      <WaitingOnYou />
    </MemoryRouter>,
  )
}

/** The number rendered beside a queue row, or null when the row is absent. */
function countFor(label: string): number | null {
  const row = screen.queryByText(label)
  if (!row) return null
  const text = row.parentElement?.textContent ?? ''
  return Number(text.replace(label, '').trim())
}

const PREPARE = 'Approved reimbursements awaiting payment'
const RECORD = 'Approved payments to record as paid'
const APPROVE = 'Reimbursement payments to approve'

beforeEach(() => {
  state.role = 'accountant'
  state.claims = [CLAIM]
  state.payments = [PAYMENT]
})

afterEach(cleanup)

describe('the Accountant queue, against live payment instructions', () => {
  it('B. does not offer work on a claim already fully covered by an instruction', () => {
    // The defect, exactly: this row said 1.
    show()
    expect(countFor(PREPARE)).toBeNull()
  })

  it('B. and does not yet offer the instruction itself for recording', () => {
    // RV-2026-0001 is for_approval — the Manager's, not the Accountant's.
    show()
    expect(countFor(RECORD)).toBeNull()
  })

  it('A. offers it when nothing is prepared against the claim', () => {
    state.claims = [{ ...CLAIM, pending_payment_amount: 0, available_to_prepare: 1000 }]
    state.payments = []
    show()
    expect(countFor(PREPARE)).toBe(1)
  })

  it('C. still offers it when only part of the balance is covered', () => {
    state.claims = [{ ...CLAIM, pending_payment_amount: 400, available_to_prepare: 600 }]
    state.payments = [{ ...PAYMENT, amount: 400 }]
    show()
    expect(countFor(PREPARE)).toBe(1)
  })

  it('D. offers the instruction for recording once it is approved', () => {
    state.payments = [{ ...PAYMENT, status: 'approved' }]
    show()
    expect(countFor(RECORD)).toBe(1)
    // Still nothing to prepare: an approved instruction is live and holds the
    // room it claimed.
    expect(countFor(PREPARE)).toBeNull()
  })

  it('E. offers nothing on a claim that is fully paid', () => {
    state.claims = [
      { ...CLAIM, amount_paid: 1000, balance_due: 0, pending_payment_amount: 0, available_to_prepare: 0 },
    ]
    state.payments = [{ ...PAYMENT, status: 'paid' }]
    show()
    expect(countFor(PREPARE)).toBeNull()
    expect(countFor(RECORD)).toBeNull()
  })

  it('F. offers it again once a rejected instruction releases the room', () => {
    // The server stops counting a rejected instruction as pending and raises
    // available_to_prepare; the queue follows that number rather than its own.
    state.claims = [{ ...CLAIM, pending_payment_amount: 0, available_to_prepare: 1000 }]
    state.payments = [{ ...PAYMENT, status: 'rejected' }]
    show()
    expect(countFor(PREPARE)).toBe(1)
    expect(countFor(RECORD)).toBeNull()
  })

  it('H. never counts the same claim as both prepared-for and needing preparation', () => {
    // One claim, one instruction covering all of it: at most one row may
    // mention it, and on the Accountant's desk that is none.
    show()
    const rows = [PREPARE, RECORD].filter((label) => countFor(label) !== null)
    expect(rows).toEqual([])
  })
})

describe('the Finance Manager keeps the other half', () => {
  beforeEach(() => {
    state.role = 'finance_manager'
  })

  it('B. counts the instruction awaiting their approval', () => {
    show()
    expect(countFor(APPROVE)).toBe(1)
  })

  it('D. loses it once it is approved and becomes the Accountant`s', () => {
    state.payments = [{ ...PAYMENT, status: 'approved' }]
    show()
    expect(countFor(APPROVE)).toBeNull()
  })

  it('is never offered the Accountant rows', () => {
    show()
    expect(countFor(PREPARE)).toBeNull()
    expect(countFor(RECORD)).toBeNull()
  })
})

describe('unknown data does not become a task count', () => {
  it('shows no queue at all when nothing has loaded', () => {
    // Every hook returns an empty list before its query resolves, and an empty
    // list must read as "nothing known yet", not as "nothing to do" with rows
    // of zero. waitingWork filters count > 0, so the card does not render.
    state.claims = []
    state.payments = []
    const { container } = show()
    expect(container.textContent).toBe('')
  })
})
