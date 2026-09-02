/** The transition table, mirrored from transition_finance_request.
 *
 * The database is what enforces the chain; these lock down that the UI offers
 * exactly the moves it will accept, so nobody is shown a button that comes back
 * "a finance_staff cannot move request PR-2026-0001 from pending_approval to
 * approved".
 *
 * F3.1 removed the Accountant's "Record payment": completing a request would
 * claim a settlement that nothing in JMAC performs. Approval is authorization —
 * to procure, or to pay — and the money is reserved, not spent.
 *
 * supabase/tests/finance_requests_rls.sql proves the same table server-side.
 */
import { describe, it, expect } from 'vitest'
import { actionsFor, inboxStatusFor, isEditable, isOpen, statusLabel } from './financeRequests'
import type { RequestStatus } from './financeRequests'

const ME = 'me'
const SOMEONE_ELSE = 'them'

function req(status: RequestStatus, requester_id = SOMEONE_ELSE) {
  return { status, requester_id }
}

const labels = (...args: Parameters<typeof actionsFor>) => actionsFor(...args).map((a) => a.label)

describe('the requester', () => {
  it('submits or cancels a draft', () => {
    expect(labels('employee', req('draft', ME), ME)).toEqual(['Submit', 'Cancel request'])
  })

  it('resubmits or cancels a returned request', () => {
    expect(labels('employee', req('returned', ME), ME)).toEqual(['Resubmit', 'Cancel request'])
  })

  it('can do nothing once it is with Finance', () => {
    for (const status of ['pending_validation', 'pending_approval', 'approved'] as const) {
      expect(labels('employee', req(status, ME), ME), status).toEqual([])
    }
  })

  it('can do nothing to a finished request', () => {
    for (const status of ['completed', 'rejected', 'cancelled'] as const) {
      expect(labels('employee', req(status, ME), ME), status).toEqual([])
    }
  })
})

describe('each step belongs to one role', () => {
  it('Finance Staff validate, return or reject a submitted request', () => {
    expect(labels('finance_staff', req('pending_validation'), ME)).toEqual([
      'Validate',
      'Return for revision',
      'Reject',
    ])
  })

  it('Finance Staff cannot approve what they validated', () => {
    expect(labels('finance_staff', req('pending_approval'), ME)).toEqual([])
  })

  it('the Finance Manager approves, returns or rejects', () => {
    expect(labels('finance_manager', req('pending_approval'), ME)).toEqual([
      'Approve',
      'Return for revision',
      'Reject',
    ])
  })

  it('the Finance Manager cannot validate', () => {
    expect(labels('finance_manager', req('pending_validation'), ME)).toEqual([])
  })

  it('Finance Staff cannot touch an approved request', () => {
    expect(labels('finance_staff', req('approved'), ME)).toEqual([])
  })
})

describe('nothing here settles anything', () => {
  it('the Accountant has no way to record a payment', () => {
    const actions = actionsFor('accountant', req('approved'), ME)
    expect(actions.map((a) => a.label)).toEqual(['Return for revision'])
    expect(actions.some((a) => a.to === 'completed')).toBe(false)
  })

  it('no role, at any status, can move a request to completed', () => {
    const roles = ['employee', 'finance_staff', 'finance_manager', 'accountant', 'admin'] as const
    const statuses: RequestStatus[] = [
      'draft',
      'pending_validation',
      'pending_approval',
      'approved',
      'returned',
    ]
    for (const role of roles) {
      for (const status of statuses) {
        for (const requester of [ME, SOMEONE_ELSE]) {
          const actions = actionsFor(role, req(status, requester), ME)
          expect(
            actions.some((a) => a.to === 'completed'),
            `${role}/${status}/${requester === ME ? 'own' : 'other'}`,
          ).toBe(false)
        }
      }
    }
  })

  it('an approved request says what it is still waiting for', () => {
    expect(statusLabel('approved', 'purchase')).toBe('Approved — awaiting procurement')
    expect(statusLabel('approved', 'reimbursement')).toBe('Approved — awaiting payment')
  })

  it('and every other status reads the same for both types', () => {
    for (const status of ['draft', 'pending_validation', 'returned', 'rejected'] as const) {
      expect(statusLabel(status, 'purchase')).toBe(statusLabel(status, 'reimbursement'))
    }
  })
})

describe('an approval can be withdrawn before anything is realized', () => {
  it('by the Finance Manager, who set the ceiling it holds', () => {
    expect(labels('finance_manager', req('approved'), ME)).toEqual([
      'Return for revision',
      'Withdraw approval',
    ])
  })

  it('and withdrawing requires a reason', () => {
    const withdraw = actionsFor('finance_manager', req('approved'), ME).find(
      (a) => a.label === 'Withdraw approval',
    )
    expect(withdraw?.requiresRemarks).toBe(true)
    expect(withdraw?.to).toBe('rejected')
  })
})

describe('a finance officer who asks for money is a requester', () => {
  it.each(['finance_staff', 'finance_manager', 'accountant'] as const)(
    '%s cannot act on their own request',
    (role) => {
      for (const status of ['pending_validation', 'pending_approval', 'approved'] as const) {
        expect(labels(role, req(status, ME), ME), `${role}/${status}`).toEqual([])
      }
    },
  )

  it('but may still submit and cancel it as its owner', () => {
    expect(labels('finance_manager', req('draft', ME), ME)).toEqual(['Submit', 'Cancel request'])
  })
})

describe('the Administrator moves nothing', () => {
  it.each(['draft', 'pending_validation', 'pending_approval', 'approved', 'returned'] as const)(
    'no action at %s',
    (status) => {
      expect(labels('admin', req(status), ME)).toEqual([])
    },
  )
})

describe('what an action demands before it is allowed to happen', () => {
  it('returning and rejecting require a reason', () => {
    const staff = actionsFor('finance_staff', req('pending_validation'), ME)
    expect(staff.find((a) => a.to === 'returned')?.requiresRemarks).toBe(true)
    expect(staff.find((a) => a.to === 'rejected')?.requiresRemarks).toBe(true)
    expect(staff.find((a) => a.to === 'pending_approval')?.requiresRemarks).toBeUndefined()
  })
})

describe('signed-out and unlinked callers', () => {
  it('get nothing', () => {
    expect(actionsFor(null, req('draft', ME), ME)).toEqual([])
    expect(actionsFor('finance_staff', req('pending_validation'), null)).toEqual([])
  })
})

describe('editability and openness', () => {
  it('only a draft or a returned request is editable', () => {
    expect(isEditable('draft')).toBe(true)
    expect(isEditable('returned')).toBe(true)
    for (const status of ['pending_validation', 'pending_approval', 'approved', 'completed'] as const) {
      expect(isEditable(status), status).toBe(false)
    }
  })

  it('an approved request is still open — it is holding budget', () => {
    expect(isOpen('approved')).toBe(true)
    expect(isOpen('rejected')).toBe(false)
    expect(isOpen('cancelled')).toBe(false)
    expect(isOpen('completed')).toBe(false)
  })
})

describe('each finance role has one queue to clear', () => {
  it('and it is the status they act on', () => {
    expect(inboxStatusFor('finance_staff')).toBe('pending_validation')
    expect(inboxStatusFor('finance_manager')).toBe('pending_approval')
    expect(inboxStatusFor('accountant')).toBe('approved')
  })

  it('the Administrator has none', () => {
    expect(inboxStatusFor('admin')).toBeNull()
    expect(inboxStatusFor('employee')).toBeNull()
  })
})
