/**
 * Supplier cost against branch selling price.
 *
 * The arithmetic only. What it means for a purchase order -- whether it may be
 * submitted -- is decided by the database, in guard_purchase_order_margin. This
 * exists so the screen can say the same thing the server will, before Finance
 * presses anything, and nothing here is a permission.
 *
 * THE BASIS IS PRE-VAT, and that is a fact about the deployed pricing model
 * rather than a choice made here. checkout_pos_sale builds a sale as
 * `subtotal = sum(price * qty)`, then applies each enabled branch fee -- a
 * percent fee computes `subtotal * value/100` -- and `total = subtotal + fees`.
 * VAT in this system is such a fee. So the branch selling price is what JMAC
 * earns on the product and the customer total is not: at a 12% VAT fee, a 30.00
 * line is 33.60 to the customer, and buying that product at 32.00 loses 2.00 a
 * unit whatever the receipt says. pos_sales.gross_profit already settles the
 * same question the same way -- it is `subtotal - total_cogs`.
 *
 * GROSS MARGIN, NOT MARKUP. Margin divides by the selling price; markup divides
 * by the cost. Cost 20 against price 30 is a 33.33% margin and a 50% markup,
 * and only one of them is what this reports.
 */

export type MarginVerdict = 'positive' | 'zero' | 'negative' | 'no-price'

export interface MarginView {
  verdict: MarginVerdict
  /** selling price - unit cost, per unit. Null when there is no price to compare. */
  perUnit: number | null
  /** (selling - cost) / selling * 100. Null when there is no price. */
  percent: number | null
  /** quantity * unit cost -- what leaves the business. */
  orderCost: number
  /** quantity * selling price, if every unit sells at today's price. */
  retailValue: number | null
  /** retailValue - orderCost. Review only: a projection, not a recorded figure. */
  potentialMargin: number | null
  /** How much the cost exceeds the price by. Only set when negative. */
  excess: number | null
}

/**
 * @param sellingPrice the destination branch's current price, pre-VAT. Null or
 *   non-positive means the branch has no usable price -- which is a refusal,
 *   not a comparison against zero.
 */
export function marginFor(
  sellingPrice: number | null | undefined,
  unitCost: number | null | undefined,
  quantity: number | null | undefined
): MarginView {
  const cost = Number.isFinite(Number(unitCost)) ? Number(unitCost) : 0
  const qty = Number.isFinite(Number(quantity)) ? Number(quantity) : 0
  const orderCost = round2(cost * qty)

  const price = Number(sellingPrice)
  // A missing price and a zero price are the same answer to procurement: there
  // is nothing to judge the cost against. Treating 0 as a real price would make
  // every purchase look like a total loss rather than an unanswered question.
  if (sellingPrice === null || sellingPrice === undefined || !Number.isFinite(price) || price <= 0) {
    return {
      verdict: 'no-price',
      perUnit: null,
      percent: null,
      orderCost,
      retailValue: null,
      potentialMargin: null,
      excess: null,
    }
  }

  const perUnit = round2(price - cost)
  const retailValue = round2(price * qty)

  return {
    verdict: perUnit > 0 ? 'positive' : perUnit === 0 ? 'zero' : 'negative',
    perUnit,
    percent: round2((perUnit / price) * 100),
    orderCost,
    retailValue,
    potentialMargin: round2(retailValue - orderCost),
    excess: perUnit < 0 ? round2(cost - price) : null,
  }
}

/** Whether this line may be submitted for approval. Mirrors the server rule:
 *  only a cost ABOVE the price, or no price at all, refuses. Zero margin is a
 *  real business decision and passes. */
export function blocksSubmission(view: MarginView): boolean {
  return view.verdict === 'negative' || view.verdict === 'no-price'
}

/** The sentence the server would raise, said before Finance presses submit. */
export function describeMargin(view: MarginView): string | null {
  switch (view.verdict) {
    case 'no-price':
      return 'The destination branch does not have a valid selling price for this product. Set or review the POS price before procurement continues.'
    case 'negative':
      return `Unit cost exceeds the current selling price by ${peso(view.excess ?? 0)} per unit. Revise the supplier cost or have the POS selling price reviewed before submitting this purchase order.`
    case 'zero':
      return 'Zero gross margin. This product would currently be sold at the same amount it costs to procure.'
    default:
      return null
  }
}

/** Whether the price moved between submission and now, which the approver is
 *  entitled to know: they are the one committing the company. */
export function priceMoved(
  snapshot: number | null | undefined,
  current: number | null | undefined
): boolean {
  if (snapshot === null || snapshot === undefined) return false
  if (current === null || current === undefined) return true
  return round2(Number(snapshot)) !== round2(Number(current))
}

export function peso(value: number): string {
  return `₱${value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Percent to two places, with its sign kept -- a negative margin reads as one. */
export function formatMarginPercent(percent: number | null): string {
  if (percent === null) return '—'
  return `${percent.toFixed(2)}%`
}

function round2(value: number): number {
  // Money arithmetic in floating point: 0.1 + 0.2 style drift would otherwise
  // turn an exactly-zero margin into a very small negative one and refuse a
  // purchase order the server would accept.
  return Math.round((value + Number.EPSILON) * 100) / 100
}
