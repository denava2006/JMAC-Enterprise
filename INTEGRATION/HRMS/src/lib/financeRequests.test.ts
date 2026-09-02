/** The transition table, mirrored from transition_finance_request.
 *
 * The database is what enforces the chain; these lock down that the UI offers
 * exactly the moves it will accept, so nobody is shown a button that comes back
 * "a finance_staff cannot move request PR-2026-0001 from pending_approval to
 * pending_payment".
 *
 * supabase/tests/finance_requests_rls.sql proves the same table server-side.
 */
import { describe, it, expect } from 'vitest'
import { actionsFor, inboxStatusFor, isEditable, isOpen } from './financeRequests'
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
    for (const status of ['pending_validation', 'pending_approval', 'pending_payment'] as const) {
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

  it('the Finance Manager cannot validate or pay', () => {
    expect(labels('finance_manager', req('pending_validation'), ME)).toEqual([])
    expect(labels('finance_manager', req('pending_payment'), ME)).toEqual([])
  })

  it('the Accountant records payment or returns it', () => {
    expect(labels('accountant', req('pending_payment'), ME)).toEqual([
      'Record payment',
      'Return for revision',
    ])
  })

  it('the Accountant cannot validate or approve', () => {
    expect(labels('accountant', req('pending_validation'), ME)).toEqual([])
    expect(labels('accountant', req('pending_approval'), ME)).toEqual([])
  })
})

describe('a finance officer who asks for money is a requester', () => {
  it.each(['finance_staff', 'finance_manager', 'accountant'] as const)(
    '%s cannot act on their own request',
    (role) => {
      for (const status of ['pending_validation', 'pending_approval', 'pending_payment'] as const) {
        expect(labels(role, req(status, ME), ME), `${role}/${status}`).toEqual([])
      }
    },
  )

  it('but may still submit and cancel it as its owner', () => {
    expect(labels('finance_manager', req('draft', ME), ME)).toEqual(['Submit', 'Cancel request'])
  })
})

describe('the Administrator moves nothing', () => {
  it.each([
    'draft',
    'pending_validation',
    'pending_approval',
    'pending_payment',
    'returned',
  ] as const)('no action at %s', (status) => {
    expect(labels('admin', req(status), ME)).toEqual([])
  })
})

describe('what an action demands before it is allowed to happen', () => {
  it('returning and rejecting require a reason', () => {
    const staff = actionsFor('finance_staff', req('pending_validation'), ME)
    expect(staff.find((a) => a.to === 'returned')?.requiresRemarks).toBe(true)
    expect(staff.find((a) => a.to === 'rejected')?.requiresRemarks).toBe(true)
    expect(staff.find((a) => a.to === 'pending_approval')?.requiresRemarks).toBeUndefined()
  })

  it('paying requires naming the account it came from', () => {
    const pay = actionsFor('accountant', req('pending_payment'), ME).find((a) => a.to === 'completed')
    expect(pay?.requiresPayment).toBe(true)
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
    for (const status of ['pending_validation', 'pending_approval', 'pending_payment', 'completed'] as const) {
      expect(isEditable(status), status).toBe(false)
    }
  })

  it('finished requests are not open', () => {
    expect(isOpen('pending_payment')).toBe(true)
    expect(isOpen('completed')).toBe(false)
    expect(isOpen('rejected')).toBe(false)
    expect(isOpen('cancelled')).toBe(false)
  })
})

describe('each finance role has one queue to clear', () => {
  it('and it is the status they act on', () => {
    expect(inboxStatusFor('finance_staff')).toBe('pending_validation')
    expect(inboxStatusFor('finance_manager')).toBe('pending_approval')
    expect(inboxStatusFor('accountant')).toBe('pending_payment')
  })

  it('the Administrator has none', () => {
    expect(inboxStatusFor('admin')).toBeNull()
    expect(inboxStatusFor('employee')).toBeNull()
  })
})
