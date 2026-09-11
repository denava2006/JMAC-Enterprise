import { describe, expect, it } from 'vitest'
import {
  blocksSubmission,
  describeMargin,
  formatMarginPercent,
  marginFor,
  priceMoved,
} from '@/lib/procurementMargin'

/**
 * The arithmetic the purchase order builder shows Finance while they type a
 * supplier cost. The database decides what may be submitted; this decides what
 * the screen says, and the two must agree or the screen is lying.
 */

describe('the brief’s worked example', () => {
  it('reports ₱10 a unit and 33.33% for cost 20 against price 30', () => {
    const view = marginFor(30, 20, 20)
    expect(view.verdict).toBe('positive')
    expect(view.perUnit).toBe(10)
    expect(view.percent).toBe(33.33)
    expect(formatMarginPercent(view.percent)).toBe('33.33%')
    expect(blocksSubmission(view)).toBe(false)
  })

  it('is margin, not markup', () => {
    // Cost 20, price 30. Margin divides by 30 and gives 33.33%; markup divides
    // by 20 and gives 50%. Reporting the second under the first's name is the
    // mistake this pins.
    expect(marginFor(30, 20, 1).percent).toBe(33.33)
    expect(marginFor(30, 20, 1).percent).not.toBe(50)
  })

  it('derives the review totals from quantity, cost and price alone', () => {
    const view = marginFor(30, 20, 20)
    expect(view.orderCost).toBe(400)
    expect(view.retailValue).toBe(600)
    expect(view.potentialMargin).toBe(200)
  })
})

describe('the three verdicts', () => {
  it('passes a cost below the price', () => {
    expect(marginFor(30, 20, 5).verdict).toBe('positive')
    expect(describeMargin(marginFor(30, 20, 5))).toBeNull()
  })

  it('warns, but allows, a cost equal to the price', () => {
    const view = marginFor(30, 30, 5)
    expect(view.verdict).toBe('zero')
    expect(view.perUnit).toBe(0)
    expect(view.percent).toBe(0)
    // Allowed on purpose: a clearance line is a real decision, and the server
    // agrees -- only a cost ABOVE the price is refused.
    expect(blocksSubmission(view)).toBe(false)
    expect(describeMargin(view)).toMatch(/Zero gross margin/)
  })

  it('blocks a cost above the price, and says by how much', () => {
    const view = marginFor(30, 35, 5)
    expect(view.verdict).toBe('negative')
    expect(view.perUnit).toBe(-5)
    expect(view.excess).toBe(5)
    expect(view.percent).toBe(-16.67)
    expect(blocksSubmission(view)).toBe(true)
    expect(describeMargin(view)).toMatch(/exceeds the current selling price by ₱5\.00 per unit/)
  })
})

describe('VAT is not revenue', () => {
  it('judges a ₱32 cost against the ₱30 base, not the ₱33.60 the customer pays', () => {
    // The deployed model: VAT is a branch fee of type percent applied on top of
    // the line subtotal, so 30.00 + 12% = 33.60 at the till. Against 33.60 a
    // 32.00 cost looks like a gain; against the price JMAC actually earns it is
    // a 2.00 loss a unit.
    const real = marginFor(30, 32, 10)
    expect(real.verdict).toBe('negative')
    expect(real.perUnit).toBe(-2)
    expect(blocksSubmission(real)).toBe(true)

    // The mistake, written down so it cannot creep back in as a "fix".
    const vatInclusive = marginFor(33.6, 32, 10)
    expect(vatInclusive.verdict).toBe('positive')
    expect(blocksSubmission(vatInclusive)).toBe(false)
  })
})

describe('a missing or zero price is a question, not a comparison', () => {
  it.each([null, undefined, 0])('refuses when the price is %s', (price) => {
    const view = marginFor(price as number | null, 20, 10)
    expect(view.verdict).toBe('no-price')
    expect(view.perUnit).toBeNull()
    expect(view.percent).toBeNull()
    expect(view.retailValue).toBeNull()
    expect(blocksSubmission(view)).toBe(true)
    expect(describeMargin(view)).toMatch(/does not have a valid selling price/)
  })

  it('does not report a zero price as a total loss', () => {
    // Treating 0 as a real price would give -100% and a "cost exceeds price by
    // ₱20" message, which sends Finance to renegotiate a supplier when the
    // actual problem is an unpriced product.
    const view = marginFor(0, 20, 10)
    expect(view.percent).toBeNull()
    expect(describeMargin(view)).not.toMatch(/exceeds/)
  })

  it('still reports what the order would cost, which is knowable either way', () => {
    expect(marginFor(null, 20, 10).orderCost).toBe(200)
  })
})

describe('money arithmetic', () => {
  it('treats an exactly equal cost and price as zero, not as a tiny loss', () => {
    // 0.1 + 0.2 drift would otherwise refuse an order the server accepts.
    const view = marginFor(0.3, 0.1 + 0.2, 1)
    expect(view.perUnit).toBe(0)
    expect(view.verdict).toBe('zero')
    expect(blocksSubmission(view)).toBe(false)
  })

  it('rounds money to two places', () => {
    const view = marginFor(19.99, 6.66, 3)
    expect(view.perUnit).toBe(13.33)
    expect(view.orderCost).toBe(19.98)
    expect(view.retailValue).toBe(59.97)
  })
})

describe('a price that moved after submission', () => {
  it('is noticed, because the approver is the one committing the company', () => {
    expect(priceMoved(30, 25)).toBe(true)
    expect(priceMoved(30, 30)).toBe(false)
  })

  it('is not claimed when nothing was ever snapshotted', () => {
    // A draft never validated has no snapshot; that is not a price change.
    expect(priceMoved(null, 30)).toBe(false)
    expect(priceMoved(undefined, 30)).toBe(false)
  })

  it('counts a price that disappeared as a change', () => {
    // The branch stopped carrying it between submission and approval.
    expect(priceMoved(30, null)).toBe(true)
  })
})
