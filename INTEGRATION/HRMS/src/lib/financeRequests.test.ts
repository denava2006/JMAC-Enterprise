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
import {
  actionsFor,
  canEditDraft,
  describeRequestEditError,
  inboxStatusFor,
  isEditable,
  isOpen,
  statusLabel,
} from './financeRequests'
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

/**
 * Acceptance found a Draft reimbursement with Submit, Cancel and Close and no
 * way to correct a wrong amount, so the only route to a right claim was to
 * cancel and retype it. canEditDraft is what decides whether the Edit button is
 * there; update_finance_request_draft is what decides whether it works, and
 * supabase/tests/reimbursement_draft_edit_rls.sql proves that half.
 */
describe('correcting a draft', () => {
  it('is offered to the person who raised it, while it is still a draft', () => {
    expect(canEditDraft(req('draft', ME), ME)).toBe(true)
  })

  it('is not offered to anybody else, whatever they hold', () => {
    expect(canEditDraft(req('draft', SOMEONE_ELSE), ME)).toBe(false)
  })

  it('is not offered once it has been submitted', () => {
    // Including returned, which is editable by the older amend policy but is a
    // different act: it answers a reviewer's remarks and ends in Resubmit.
    for (const status of [
      'pending_validation',
      'pending_approval',
      'approved',
      'completed',
      'returned',
      'rejected',
      'cancelled',
    ] as const) {
      expect(canEditDraft(req(status, ME), ME), status).toBe(false)
    }
  })

  it('is not offered to a signed-out viewer', () => {
    expect(canEditDraft(req('draft', ME), null)).toBe(false)
    expect(canEditDraft(req('draft', ME), undefined)).toBe(false)
  })
})

describe('what the server said went wrong', () => {
  it('passes a written refusal through rather than replacing it', () => {
    // These arrive as 42501, which the generic finance mapper turns into "Your
    // finance role does not cover that action" — untrue of an employee with no
    // finance role at all, and useless next to the sentence the database wrote.
    expect(describeRequestEditError({ message: 'Only the person who raised a request can edit it.' }))
      .toBe('Only the person who raised a request can edit it.')
    expect(describeRequestEditError({ message: 'An amount must be more than zero.' }))
      .toBe('An amount must be more than zero.')
  })

  it('substitutes its own sentence when nobody wrote one for a reader', () => {
    expect(
      describeRequestEditError({
        message: 'new row violates row-level security policy for table "finance_requests"',
      }),
    ).toBe('That change could not be saved.')
    expect(describeRequestEditError({})).toBe('That change could not be saved.')
    expect(describeRequestEditError(null)).toBe('That change could not be saved.')
  })

  it('does not read the schema out loud when Postgres describes itself', () => {
    // An amount too large for numeric(14,2) reached the UPDATE and came back as
    // an overflow. It is a true sentence about a column and a useless one to a
    // claimant, and it names the storage of a finance table to whoever asked.
    expect(
      describeRequestEditError({
        code: '22003',
        message: 'numeric field overflow',
        details: 'A field with precision 14, scale 2 must round to an absolute value less than 10^12.',
      }),
    ).toBe('That change could not be saved.')

    // A tripped table constraint arrives as 23514 -- the same code the function
    // uses for its own validation -- so the code alone is not enough to tell
    // them apart, and the words are checked as well.
    expect(
      describeRequestEditError({
        code: '23514',
        message:
          'new row for relation "finance_requests" violates check constraint "finance_requests_expense_date_is_reimbursement"',
      }),
    ).toBe('That change could not be saved.')

    for (const leak of [
      { code: '23503', message: 'insert or update on table "finance_requests" violates foreign key constraint "finance_requests_budget_id_fkey"' },
      { code: '23505', message: 'duplicate key value violates unique constraint "finance_requests_request_no_key"' },
      { code: '22P02', message: 'invalid input syntax for type numeric: "abc"' },
      { code: '42501', message: 'permission denied for table finance_requests' },
      { code: '42883', message: 'function public.update_finance_request_draft(unknown) does not exist' },
    ]) {
      expect(describeRequestEditError(leak), leak.message).toBe('That change could not be saved.')
    }
  })

  it('still passes the sentences the function raises on purpose', () => {
    // These are the codes update_finance_request_draft names, carrying the
    // words it wrote. Replacing them with an apology is the whole reason this
    // mapper exists rather than the generic finance one.
    const authored = [
      { code: '42501', message: 'Only the person who raised a request can edit it.' },
      { code: '23514', message: 'An amount must be more than zero.' },
      { code: '23514', message: 'Keep the amount under 1,000,000,000,000.' },
      { code: 'P0002', message: 'That request no longer exists.' },
      {
        code: '23514',
        message:
          'This request was changed somewhere else while you were editing it. Close it and open it again to see the current version.',
      },
    ]
    for (const err of authored) {
      expect(describeRequestEditError(err), err.message).toBe(err.message)
    }
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
