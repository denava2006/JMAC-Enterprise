import { describe, expect, it } from 'vitest'
import { fulfillmentOf, fulfillmentNote } from '@/hooks/useProcurement'

/**
 * What an order says versus what has arrived.
 *
 * PO-2026-0004 in production was approved, twenty ordered, twenty received, and
 * every screen read "Approved — awaiting delivery" directly above "20 of 20
 * received". The label came from the status column alone, so it could not
 * disagree with itself — it simply never looked.
 *
 * The workflow status stays the Finance Manager's: receiving does not close an
 * order. What these hold is that the visible state is read off the quantities.
 */

const order = (over: Record<string, unknown> = {}) => ({
  status: 'approved',
  quantity_ordered: 20,
  quantity_received: 0,
  quantity_outstanding: 20,
  ...over,
})

describe('an approved order reports what has arrived', () => {
  it('says awaiting delivery when nothing has', () => {
    const view = fulfillmentOf(order())
    expect(view.kind).toBe('awaiting')
    expect(view.label).toBe('Approved — awaiting delivery')
  })

  it('says partially received when some has', () => {
    const view = fulfillmentOf(order({ quantity_received: 6, quantity_outstanding: 14 }))
    expect(view.kind).toBe('partial')
    expect(view.label).toBe('Partially received')
  })

  it('says fully received when all of it has', () => {
    // The reported bug, as an assertion.
    const view = fulfillmentOf(order({ quantity_received: 20, quantity_outstanding: 0 }))
    expect(view.kind).toBe('complete')
    expect(view.label).toBe('Fully received — ready to close')
    expect(view.label).not.toContain('awaiting')
  })

  it('does not close the order by itself', () => {
    // Receiving twenty crates is not a decision to close the paperwork.
    const view = fulfillmentOf(order({ quantity_received: 20, quantity_outstanding: 0 }))
    expect(view.kind).not.toBe('workflow')
    expect(view.label).not.toBe('Closed')
  })

  it('describes an order with nothing receivable on it as simply approved', () => {
    // Services, rent, a licence: no delivery to wait for, so "awaiting
    // delivery" would be waiting for something that is never coming.
    const view = fulfillmentOf(order({ quantity_ordered: 1, quantity_received: 0, quantity_outstanding: 0 }))
    expect(view.kind).toBe('not_receivable')
    expect(view.label).toBe('Approved')
  })
})

describe('workflow status wins where it should', () => {
  it.each(['draft', 'pending_approval', 'returned', 'rejected', 'cancelled'])(
    'describes a %s order by its workflow state',
    (status) => {
      expect(fulfillmentOf(order({ status })).kind).toBe('workflow')
    },
  )

  it('shows a closed order as closed even when fully received', () => {
    const view = fulfillmentOf(
      order({ status: 'closed', quantity_received: 20, quantity_outstanding: 0 }),
    )
    expect(view.kind).toBe('workflow')
    expect(view.label).toBe('Closed')
  })
})

describe('the sentence matches the numbers beside it', () => {
  it('never claims nothing arrived when receipts exist', () => {
    // The exact contradiction that was on screen.
    const note = fulfillmentNote(order({ quantity_received: 20, quantity_outstanding: 0 }))
    expect(note).not.toMatch(/nothing has been received/i)
    expect(note).not.toMatch(/no units have been received/i)
    expect(note).toContain('Delivery complete')
    expect(note).toContain('All 20 units')
    expect(note).toContain('ready to close')
  })

  it('counts the arrived and the outstanding on a partial', () => {
    const note = fulfillmentNote(order({ quantity_received: 6, quantity_outstanding: 14 }))
    expect(note).toContain('6 of 20')
    expect(note).toContain('14 remain outstanding')
  })

  it('says nothing has arrived only when nothing has', () => {
    const note = fulfillmentNote(order())
    expect(note).toContain('No units have been received yet')
  })

  it('has nothing to say about an order that is not approved', () => {
    expect(fulfillmentNote(order({ status: 'draft' }))).toBeNull()
    expect(fulfillmentNote(order({ status: 'closed' }))).toBeNull()
  })
})

describe('the awaiting-delivery metric', () => {
  // The dashboard counts approved orders with something still outstanding.
  const counts = (orders: ReturnType<typeof order>[]) =>
    orders.filter((o) => o.status === 'approved' && Number(o.quantity_outstanding ?? 0) > 0).length

  it('excludes a fully received order', () => {
    expect(counts([order({ quantity_received: 20, quantity_outstanding: 0 })])).toBe(0)
  })

  it('still counts a genuinely outstanding one', () => {
    // PO-2026-0002 in production: approved, ten ordered, none received. The
    // metric legitimately stays at one, and must not be massaged to zero.
    expect(counts([order({ quantity_ordered: 10, quantity_outstanding: 10 })])).toBe(1)
  })

  it('counts only the outstanding one when both exist', () => {
    expect(
      counts([
        order({ quantity_received: 20, quantity_outstanding: 0 }),
        order({ quantity_ordered: 10, quantity_outstanding: 10 }),
      ]),
    ).toBe(1)
  })
})
