import { describe, expect, it } from 'vitest'
import {
  canPrepareReimbursementPayment,
  hasAvailableToPrepare,
  nextStepFor,
  paymentActionsFor,
  reimbursementActionsFor,
  reimbursementStateLabel,
  roomForPayment,
  type ReimbursementPayment,
} from '@/lib/reimbursements'

/**
 * What Finance may do with an employee's claim, and what the screen calls it.
 *
 * The claim is a finance_request — it has carried type 'reimbursement' since
 * F3, which is why there is no second table and therefore no second budget
 * reservation. These tests are about the settlement half F7 adds.
 */

function payment(over: Partial<ReimbursementPayment> = {}): ReimbursementPayment {
  return {
    id: 'p1',
    payment_no: 'RV-2026-0001',
    finance_request_id: 'r1',
    request_no: 'PR-2026-0007',
    requester_name: 'Ana Cruz',
    treasury_account_id: 'acc1',
    account_name: 'Main Bank Account',
    amount: 1000,
    method: 'bank_transfer',
    payment_date: null,
    reference: null,
    notes: null,
    status: 'for_approval',
    prepared_by: 'accountant-1',
    prepared_by_name: 'Ben Reyes',
    approved_by_name: null,
    approved_at: null,
    paid_by_name: null,
    paid_at: null,
    decision_reason: null,
    created_at: '2026-09-05T02:00:00Z',
    ...over,
  }
}

describe('what a claim is called once money moves', () => {
  it('says awaiting payment while nothing is paid', () => {
    expect(
      reimbursementStateLabel({ status: 'approved', amount_paid: 0, balance_due: 1000 })
    ).toBe('Approved — awaiting payment')
  })

  it('says Partially paid, then Paid', () => {
    expect(
      reimbursementStateLabel({ status: 'approved', amount_paid: 400, balance_due: 600 })
    ).toBe('Partially paid')
    expect(reimbursementStateLabel({ status: 'approved', amount_paid: 1000, balance_due: 0 })).toBe(
      'Paid'
    )
  })

  // Paying a claim does not un-approve it, so the workflow status stays put
  // and only the words change.
  it('leaves the pre-approval states to the workflow wording', () => {
    expect(reimbursementStateLabel({ status: 'pending_validation' })).toBe(
      'Submitted — with Finance'
    )
    expect(reimbursementStateLabel({ status: 'pending_approval' })).toBe(
      'With the Finance Manager'
    )
    expect(reimbursementStateLabel({ status: 'returned' })).toBe('Returned for correction')
  })

  it('reads a string amount the same as a number', () => {
    expect(
      reimbursementStateLabel({ status: 'approved', amount_paid: '1000.00', balance_due: '0.00' })
    ).toBe('Paid')
  })
})

describe('who may decide a claim', () => {
  it('lets Finance Staff forward or return, and never approve', () => {
    const actions = reimbursementActionsFor('finance_staff', 'pending_validation')
    expect(actions.map((a) => a.to)).toEqual(['pending_approval', 'returned', 'rejected'])
    expect(actions.map((a) => a.to)).not.toContain('approved')
  })

  it('lets the Finance Manager approve one that has been forwarded', () => {
    const actions = reimbursementActionsFor('finance_manager', 'pending_approval')
    expect(actions.map((a) => a.to)).toContain('approved')
  })

  it('offers the Accountant no decision on the claim at all', () => {
    expect(reimbursementActionsFor('accountant', 'pending_approval')).toHaveLength(0)
    expect(reimbursementActionsFor('accountant', 'approved')).toHaveLength(0)
  })

  // Withdrawing an approval releases its budget reservation. Once money is
  // paid or promised there is nothing to release.
  it('withdraws the withdrawal once money is paid or promised', () => {
    expect(
      reimbursementActionsFor('finance_manager', 'approved', { amountPaid: 0, pending: 0 })
    ).toHaveLength(1)
    expect(
      reimbursementActionsFor('finance_manager', 'approved', { amountPaid: 400, pending: 0 })
    ).toHaveLength(0)
    expect(
      reimbursementActionsFor('finance_manager', 'approved', { amountPaid: 0, pending: 600 })
    ).toHaveLength(0)
  })
})

describe('whether another payment may be prepared', () => {
  it('offers it to the Accountant while something is available', () => {
    expect(
      canPrepareReimbursementPayment({ status: 'approved', available_to_prepare: 500 }, 'accountant')
    ).toBe(true)
  })

  it('withdraws it once the claim is fully covered', () => {
    expect(
      canPrepareReimbursementPayment({ status: 'approved', available_to_prepare: 0 }, 'accountant')
    ).toBe(false)
  })

  it('never offers it before the claim is approved', () => {
    expect(
      canPrepareReimbursementPayment(
        { status: 'pending_approval', available_to_prepare: 1000 },
        'accountant'
      )
    ).toBe(false)
  })

  it('never offers it to anybody but the Accountant', () => {
    expect(
      canPrepareReimbursementPayment(
        { status: 'approved', available_to_prepare: 500 },
        'finance_manager'
      )
    ).toBe(false)
  })
})

describe('what one payment may still claim', () => {
  // Its own amount is excluded, exactly as the server excludes it. Counting a
  // payment against itself would refuse every resubmission there is.
  it('excludes the payment from its own sibling sum', () => {
    const p = payment({ amount: 1000, status: 'returned' })
    expect(roomForPayment(p, [p], 1000)).toBe(1000)
  })

  it('counts every other live instruction against it', () => {
    const p = payment({ id: 'p1', amount: 1000, status: 'returned' })
    const sibling = payment({ id: 'p2', amount: 600, status: 'for_approval' })
    expect(roomForPayment(p, [p, sibling], 1000)).toBe(400)
  })

  it('ignores siblings that are paid, returned or rejected', () => {
    const p = payment({ id: 'p1', amount: 1000, status: 'draft' })
    const done = payment({ id: 'p2', amount: 600, status: 'paid' })
    const gone = payment({ id: 'p3', amount: 300, status: 'rejected' })
    expect(roomForPayment(p, [p, done, gone], 1000)).toBe(1000)
  })

  it('never goes negative', () => {
    const p = payment({ id: 'p1', amount: 100, status: 'draft' })
    const sibling = payment({ id: 'p2', amount: 5000, status: 'approved' })
    expect(roomForPayment(p, [p, sibling], 1000)).toBe(0)
  })
})

describe('who may act on a payment', () => {
  it('lets the Finance Manager decide one somebody else prepared', () => {
    expect(paymentActionsFor(payment(), 'finance_manager', 'manager-1').canDecide).toBe(true)
  })

  it('refuses to offer approval to the person who prepared it', () => {
    expect(paymentActionsFor(payment(), 'finance_manager', 'accountant-1').canDecide).toBe(false)
  })

  it('offers Record only once a Manager has approved', () => {
    expect(paymentActionsFor(payment({ status: 'approved' }), 'accountant', 'a1').canRecord).toBe(
      true
    )
    expect(
      paymentActionsFor(payment({ status: 'for_approval' }), 'accountant', 'a1').canRecord
    ).toBe(false)
  })

  it('gives the Finance Manager no way to record a payment', () => {
    expect(
      paymentActionsFor(payment({ status: 'approved' }), 'finance_manager', 'm1').canRecord
    ).toBe(false)
  })

  it('withdraws Submit from a returned payment that no longer fits', () => {
    const p = payment({ status: 'returned', amount: 1000 })
    expect(paymentActionsFor(p, 'accountant', 'a1', 1000).canSubmit).toBe(true)
    expect(paymentActionsFor(p, 'accountant', 'a1', 400).canSubmit).toBe(false)
  })

  it('offers nothing once a payment is paid', () => {
    const can = paymentActionsFor(payment({ status: 'paid' }), 'accountant', 'a1')
    expect(can.canSubmit || can.canDecide || can.canRecord).toBe(false)
  })
})

/**
 * Whose turn it is next.
 *
 * F7 acceptance approved RB-2026-0001 and was left with "Approved — awaiting
 * payment" and "Available to prepare ₱1,000" — both true, and silent about who
 * does the preparing. The status says what has happened; this says what happens
 * next, and nothing was answering that.
 */
describe('who has the claim next', () => {
  const approved = { status: 'approved', balance_due: 1000, available_to_prepare: 1000 }

  it('names Finance Staff while the claim is being checked', () => {
    const step = nextStepFor({ status: 'pending_validation' })
    expect(step?.actor).toBe('Finance Staff')
    expect(step?.description).toMatch(/budget/)
  })

  it('names the Finance Manager while it waits for approval', () => {
    expect(nextStepFor({ status: 'pending_approval' })?.actor).toBe('The Finance Manager')
  })

  it('names the Accountant once it is approved and nothing is prepared yet', () => {
    const step = nextStepFor(approved, [])
    expect(step?.actor).toBe('The Accountant')
    expect(step?.description).toBe('prepares the reimbursement payment.')
  })

  it('hands it back to the Finance Manager once a payment awaits approval', () => {
    // The defect this guards against is saying "Accountant prepares the
    // payment" while one is already sitting on the Manager's desk.
    const step = nextStepFor(approved, [{ status: 'for_approval' }])
    expect(step?.actor).toBe('The Finance Manager')
    expect(step?.description).toBe('approves the prepared payment.')
  })

  it('returns to the Accountant once the payment is authorised but not sent', () => {
    const step = nextStepFor(approved, [{ status: 'approved' }])
    expect(step?.actor).toBe('The Accountant')
    expect(step?.description).toMatch(/records the completed payment/)
  })

  it('asks the Accountant to send a draft or a returned payment onward', () => {
    for (const status of ['draft', 'returned'] as const) {
      const step = nextStepFor(approved, [{ status }])
      expect(step?.actor, status).toBe('The Accountant')
      expect(step?.description, status).toMatch(/submits the prepared payment/)
    }
  })

  it('says nothing once the claim is fully paid', () => {
    expect(
      nextStepFor({ status: 'approved', balance_due: 0, available_to_prepare: 0 }, [
        { status: 'paid' },
      ]),
    ).toBeNull()
  })

  it('says nothing about a claim nobody is waiting on', () => {
    for (const status of ['completed', 'rejected', 'cancelled']) {
      expect(nextStepFor({ status }), status).toBeNull()
    }
  })

  it('points a draft and a returned claim back at the employee', () => {
    expect(nextStepFor({ status: 'draft' })?.actor).toBe('The employee')
    expect(nextStepFor({ status: 'returned' })?.description).toMatch(/resubmits/)
  })

  it('ignores payments that are no longer live', () => {
    // A rejected payment is not somebody's turn; the claim is back to needing
    // one prepared.
    const step = nextStepFor(approved, [{ status: 'rejected' }, { status: 'paid' }])
    expect(step?.actor).toBe('The Accountant')
    expect(step?.description).toBe('prepares the reimbursement payment.')
  })
})

/**
 * Whether the Accountant can still prepare a payment against a claim.
 *
 * F7-QA-10: the overview counted approved claims with balance_due > 0, and
 * balance_due subtracts only what has been PAID. RB-2026-0001 had P1,000 owing
 * and a P1,000 instruction already with the Finance Manager, so the overview
 * advertised Accountant work while the detail page correctly showed none.
 *
 * available_to_prepare is the server's own answer and accounts for live
 * instructions: amount - paid - pending, where pending sums payments in draft,
 * for_approval or approved. These pin the cases from the defect report.
 */
describe('whether a claim still has room for an instruction', () => {
  const claim = (over: Record<string, unknown> = {}) => ({
    status: 'approved',
    balance_due: 1000,
    available_to_prepare: 1000,
    ...over,
  })

  it('A. counts an approved claim with nothing prepared against it', () => {
    expect(hasAvailableToPrepare(claim({ available_to_prepare: 1000 }))).toBe(true)
  })

  it('B. does not count one whose balance is fully covered by a live instruction', () => {
    // The production case: owing P1,000, pending P1,000, available P0. The
    // next step is the Finance Manager's, not the Accountant's.
    expect(
      hasAvailableToPrepare(claim({ balance_due: 1000, available_to_prepare: 0 })),
    ).toBe(false)
  })

  it('C. still counts one that is only partly covered', () => {
    expect(hasAvailableToPrepare(claim({ balance_due: 1000, available_to_prepare: 600 }))).toBe(
      true,
    )
  })

  it('E. does not count one that is fully paid', () => {
    expect(
      hasAvailableToPrepare(claim({ balance_due: 0, available_to_prepare: 0 })),
    ).toBe(false)
  })

  it('F. counts it again once a rejected instruction releases the room', () => {
    // reimbursement_pending_payment sums draft, for_approval and approved only,
    // so rejecting or returning an instruction gives its room back and the
    // server raises available_to_prepare. Nothing here recomputes that.
    expect(hasAvailableToPrepare(claim({ available_to_prepare: 0 }))).toBe(false)
    expect(hasAvailableToPrepare(claim({ available_to_prepare: 1000 }))).toBe(true)
  })

  it('never counts a claim that is not approved, whatever the number says', () => {
    for (const status of ['draft', 'pending_validation', 'pending_approval', 'returned', 'rejected']) {
      expect(hasAvailableToPrepare(claim({ status })), status).toBe(false)
    }
  })

  it('reads a string amount the same as a number', () => {
    expect(hasAvailableToPrepare(claim({ available_to_prepare: '600.00' }))).toBe(true)
    expect(hasAvailableToPrepare(claim({ available_to_prepare: '0.00' }))).toBe(false)
  })

  it('G. is the same question the detail page asks before offering Prepare', () => {
    // The overview and the detail page cannot disagree, because the claim half
    // of both answers is this one function.
    for (const available of [0, 600, 1000]) {
      const c = claim({ available_to_prepare: available })
      expect(canPrepareReimbursementPayment(c, 'accountant'), String(available)).toBe(
        hasAvailableToPrepare(c),
      )
    }
  })

  it('and the role check still sits on top of it', () => {
    const c = claim({ available_to_prepare: 1000 })
    expect(hasAvailableToPrepare(c)).toBe(true)
    expect(canPrepareReimbursementPayment(c, 'finance_manager')).toBe(false)
  })
})
