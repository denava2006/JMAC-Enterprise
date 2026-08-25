import { describe, expect, it } from 'vitest'
import {
  POS_REQUEST_MAX_QUANTITY,
  REQUEST_STATUS_LABEL,
  REQUEST_TYPE_LABEL,
  approvalMeaning,
  describeRequestError,
  isCancellable,
  offsetFor,
  pageCount,
  requestStatusLabel,
  requestTypeLabel,
  totalFrom,
  validateRequest,
  type ManagerRequest,
  type QueuedRequest,
} from '@/lib/posRequests'

function request(overrides: Partial<ManagerRequest> = {}): ManagerRequest {
  return {
    request_id: 'r1',
    branch_id: 'b1',
    branch_name: 'Cavite Branch',
    product_id: 'p1',
    product_name: 'Cola 1.5L',
    request_type: 'restock',
    requested_quantity: 24,
    reason: 'Running low before the weekend',
    status: 'pending',
    requested_by: 'u1',
    requester_name: 'Jerome Castillo',
    requested_at: '2026-08-27T02:00:00Z',
    reviewer_name: null,
    reviewed_at: null,
    review_note: null,
    total_count: 1,
    ...overrides,
  }
}

function queued(overrides: Partial<QueuedRequest> = {}): QueuedRequest {
  return { ...request(), requester_enterprise_role: 'employee', can_review: true, ...overrides }
}

describe('what a request is, and is not', () => {
  it('carries no amount, vendor, budget or cost field', () => {
    // The FMS boundary, pinned on the client type as well as the table. A
    // request is a demand signal; procurement is a different decision made by
    // a different system.
    const keys = Object.keys(request())
    for (const forbidden of [
      'amount',
      'vendor_id',
      'supplier_id',
      'budget_id',
      'unit_cost',
      'payment_schedule',
      'total_value',
      'price',
    ]) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('names no approval authority', () => {
    // reviewed_by / reviewed_at / review_note are generic. Nothing says "an
    // Administrator did this", so restock review can move to FMS without a
    // schema or contract change.
    const keys = Object.keys(request()).join(' ')
    expect(keys).not.toMatch(/admin/i)
    expect(keys).not.toMatch(/fms/i)
    expect(keys).not.toMatch(/authority/i)
  })

  it('gives a reviewer the requester role and a can_review flag the manager never sees', () => {
    const managerKeys = Object.keys(request())
    expect(managerKeys).not.toContain('can_review')
    expect(managerKeys).not.toContain('requester_enterprise_role')

    const queueKeys = Object.keys(queued())
    expect(queueKeys).toContain('can_review')
    expect(queueKeys).toContain('requester_enterprise_role')
  })
})

describe('approvalMeaning', () => {
  it('says a restock approval has ordered and received nothing', () => {
    const text = approvalMeaning('restock')
    expect(text).toMatch(/procurement/i)
    expect(text).toMatch(/No stock has been ordered or received/i)
  })

  it('says a carry approval leaves the product switched off and empty', () => {
    const text = approvalMeaning('carry_existing_product')
    expect(text).toMatch(/not offered/i)
    expect(text).toMatch(/no stock until it is received/i)
  })

  it('never implies stock has arrived', () => {
    for (const type of ['restock', 'carry_existing_product'] as const) {
      expect(approvalMeaning(type)).not.toMatch(/on its way|delivered|in stock now/i)
    }
  })
})

describe('validateRequest', () => {
  it('requires a reason', () => {
    expect(validateRequest({ type: 'restock', quantity: '5', reason: '   ' })).toMatch(/why/i)
  })

  it('mirrors the database bounds so an impossible ask costs no round trip', () => {
    expect(validateRequest({ type: 'restock', quantity: '0', reason: 'x' })).toMatch(/between/i)
    expect(
      validateRequest({ type: 'restock', quantity: String(POS_REQUEST_MAX_QUANTITY + 1), reason: 'x' })
    ).toMatch(/between/i)
    expect(validateRequest({ type: 'restock', quantity: '2.5', reason: 'x' })).toMatch(/whole number/i)
  })

  it('accepts a well-formed restock', () => {
    expect(validateRequest({ type: 'restock', quantity: '24', reason: 'Running low' })).toBeNull()
  })

  it('asks a carry request for no quantity at all', () => {
    // The branch does not stock it yet; "how many" is a procurement question.
    expect(
      validateRequest({ type: 'carry_existing_product', quantity: '', reason: 'Customers ask' })
    ).toBeNull()
  })
})

describe('isCancellable', () => {
  it('lets the author withdraw their own pending request', () => {
    expect(isCancellable(request({ status: 'pending', requested_by: 'u1' }), 'u1')).toBe(true)
  })

  it('refuses once somebody has decided', () => {
    for (const status of ['approved', 'declined', 'cancelled'] as const) {
      expect(isCancellable(request({ status, requested_by: 'u1' }), 'u1')).toBe(false)
    }
  })

  it('refuses somebody else"s request', () => {
    expect(isCancellable(request({ requested_by: 'u2' }), 'u1')).toBe(false)
  })

  it('refuses when the viewer is unknown', () => {
    expect(isCancellable(request(), undefined)).toBe(false)
  })
})

describe('labels', () => {
  it('names both request types without jargon', () => {
    expect(requestTypeLabel('restock')).toBe('Restock')
    expect(requestTypeLabel('carry_existing_product')).toBe('Start carrying')
  })

  it('calls a pending request "awaiting review", not "submitted"', () => {
    expect(requestStatusLabel('pending')).toBe('Awaiting review')
  })

  it('calls a cancelled request "withdrawn" -- the requester chose it', () => {
    expect(requestStatusLabel('cancelled')).toBe('Withdrawn')
  })

  it('labels every type and status', () => {
    expect(Object.keys(REQUEST_TYPE_LABEL)).toHaveLength(2)
    expect(Object.keys(REQUEST_STATUS_LABEL)).toHaveLength(4)
    for (const label of Object.values(REQUEST_STATUS_LABEL)) expect(label).not.toMatch(/_/)
  })

  it('has no label suggesting fulfilment, which does not exist yet', () => {
    const labels = Object.values(REQUEST_STATUS_LABEL).join(' ')
    expect(labels).not.toMatch(/fulfilled|received|delivered|ordered/i)
  })
})

describe('pagination', () => {
  it('counts pages at 25', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(25)).toBe(1)
    expect(pageCount(26)).toBe(2)
  })

  it('offsets from a one-based page', () => {
    expect(offsetFor(1)).toBe(0)
    expect(offsetFor(3)).toBe(50)
    expect(offsetFor(-2)).toBe(0)
  })

  it('reads the total off any row, zero from none', () => {
    expect(totalFrom([request({ total_count: 7 })])).toBe(7)
    expect(totalFrom([])).toBe(0)
  })
})

describe('describeRequestError', () => {
  it('explains a duplicate', () => {
    expect(describeRequestError(new Error('There is already an open request for this'))).toMatch(
      /already an open request/i
    )
  })

  it('explains losing a review race, and says to refresh', () => {
    expect(describeRequestError(new Error('That request has already been reviewed'))).toMatch(
      /Refresh/i
    )
  })

  it('points a mis-typed restock at the carry request instead', () => {
    expect(describeRequestError(new Error('This branch does not carry that product yet'))).toMatch(
      /ask for it to be carried/i
    )
  })

  it('never returns an empty string', () => {
    expect(describeRequestError(null)).toBe('That request could not be completed.')
  })
})
