import { computeFees, round2, sumFees, type AppliedFee, type Fee } from '@/lib/posFees'
import { errorMessage } from '@/lib/errorMessage'

/**
 * The till's own arithmetic and cart rules.
 *
 * Everything here is a *preview*. `checkout_pos_sale` recomputes the price,
 * the fees, the total and the change from the database under lock, and its
 * answer is the one that is charged. This exists so the cashier sees the same
 * number a moment earlier, and so the till does not offer an action the
 * database would refuse.
 *
 * The rounding must match the server exactly. Each line rounds before anything
 * is summed, and each fee rounds before the fees are summed -- the same order
 * `checkout_pos_sale` uses. Diverge by a centavo and the till refuses an exact
 * cash tender with "Cash received is less than the total".
 */

/**
 * Payment method values a SALE may already hold.
 *
 * This is history, not a menu. 'maya', 'bank' and 'other' are no longer
 * offered and 'gcash' is no longer typed in by hand, but sales carrying those
 * values exist and their receipts, reports and audit rows must keep rendering.
 * The database CHECK still accepts every one of them for the same reason.
 * Render one with saleMethodLabel; never index a menu by it.
 */
export const LEGACY_PAYMENT_METHODS = ['cash', 'gcash', 'maya', 'paymaya', 'card', 'qrph', 'bank', 'other'] as const
export type StoredPaymentMethod = (typeof LEGACY_PAYMENT_METHODS)[number]

/**
 * Payments JMAC collects through PayMongo.
 *
 * 'paymaya' rather than 'maya' because that is PayMongo's identifier for it;
 * the legacy 'maya' value is untouched so historical sales stay valid.
 */
export const ONLINE_METHODS = ['gcash', 'paymaya', 'card', 'qrph'] as const
export type OnlineMethod = (typeof ONLINE_METHODS)[number]

/**
 * What the till offers, and the whole of it.
 *
 * Five methods: cash, and four that PayMongo settles. There used to be a
 * second GCash and a second Maya on this menu -- the "record reference"
 * variants, where the money had already moved elsewhere and a cashier typed
 * the reference in. Those are gone, along with Bank transfer and Other.
 *
 * That removes the reason the values were once prefixed with `online:`. The
 * prefix existed only to keep two entries reading "GCash" apart; with one of
 * each left, the value a cashier picks IS the method the provider settles, and
 * the extra encoding was a hazard rather than a help.
 *
 * Cash stays completely independent of PayMongo: it is the one method that
 * finishes at the till instead of waiting for a signed webhook.
 */
export const TILL_METHODS = ['cash', 'gcash', 'paymaya', 'card', 'qrph'] as const
export type TillMethod = (typeof TILL_METHODS)[number]

export const TILL_METHOD_LABEL: Record<TillMethod, string> = {
  cash: 'Cash',
  gcash: 'GCash',
  paymaya: 'Maya',
  card: 'Card',
  qrph: 'QR Ph',
}

/** Everything except cash is settled by the provider. */
export function isOnlineMethod(method: TillMethod): method is OnlineMethod {
  return method !== 'cash'
}

/** The provider's floor. Below this it refuses the checkout session, so the
 *  till should not offer to start one. */
export const MIN_ONLINE_TOTAL = 1

/**
 * How a completed sale's payment method is written on a receipt.
 *
 * Separate from PAYMENT_METHOD_LABEL because that one describes what the till
 * *offers*, and this describes what a sale can *hold* -- which now includes
 * values no selector shows: 'paymaya', 'card' and 'qrph' arrive from the
 * payment provider, and 'maya' is a legacy value kept so older receipts still
 * read correctly. Indexing the offer list by a stored value printed
 * "undefined" on card receipts.
 */
export const SALE_METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  paymaya: 'Maya',
  card: 'Card',
  qrph: 'QR Ph',
  bank: 'Bank transfer',
  other: 'Other',
}

export function saleMethodLabel(method: string): string {
  return SALE_METHOD_LABEL[method] ?? method
}

/** Mirrors public.pos_max_cart_lines() / pos_max_line_quantity(). */
import { parseMoney } from '@/lib/currency'

export const MAX_CART_LINES = 50
export const MAX_LINE_QUANTITY = 999

/** An upper bound on cash received. No till holds a trillion pesos; the point
 *  is that an unbounded field lets a mistyped or pasted value through, and the
 *  change calculation then reports a fortune owed to the customer. */
export const MAX_TENDERED = 1_000_000_000_000

export interface CatalogueProduct {
  product_id: string
  name: string
  category_name: string
  selling_price: number
  image_path: string | null
  available_quantity: number
  is_low_stock: boolean
}

export interface CartLine {
  product: CatalogueProduct
  quantity: number
}

export interface CartTotals {
  subtotal: number
  appliedFees: AppliedFee[]
  feesTotal: number
  total: number
  units: number
}

/**
 * Adds to the cart, merging a repeat tap into the existing line.
 *
 * The server normalises duplicates anyway, but merging here keeps the cart
 * readable and keeps the stock check meaningful -- two separate lines of the
 * same product would each look affordable while together exceeding stock.
 */
export function addToCart(cart: CartLine[], product: CatalogueProduct, quantity = 1): CartLine[] {
  const existing = cart.find((line) => line.product.product_id === product.product_id)
  if (!existing) {
    return [...cart, { product, quantity: Math.min(quantity, MAX_LINE_QUANTITY) }]
  }
  return cart.map((line) =>
    line.product.product_id === product.product_id
      ? { ...line, quantity: Math.min(line.quantity + quantity, MAX_LINE_QUANTITY) }
      : line
  )
}

export function setLineQuantity(cart: CartLine[], productId: string, quantity: number): CartLine[] {
  if (quantity <= 0) return cart.filter((line) => line.product.product_id !== productId)
  return cart.map((line) =>
    line.product.product_id === productId
      ? { ...line, quantity: Math.min(quantity, MAX_LINE_QUANTITY) }
      : line
  )
}

export function cartTotals(cart: CartLine[], fees: Fee[] | null | undefined): CartTotals {
  const subtotal = round2(
    cart.reduce((sum, line) => sum + round2(line.product.selling_price * line.quantity), 0)
  )
  const appliedFees = computeFees(subtotal, fees)
  const feesTotal = sumFees(appliedFees)
  return {
    subtotal,
    appliedFees,
    feesTotal,
    total: round2(subtotal + feesTotal),
    units: cart.reduce((sum, line) => sum + line.quantity, 0),
  }
}

export function changeDue(total: number, tendered: number): number {
  return round2(tendered - total)
}

/**
 * What the till sends. Only the safe inputs: which products, how many, and how
 * the customer is paying. No price, no total, no cashier id.
 */
export function cartToItems(cart: CartLine[]): { product_id: string; quantity: number }[] {
  return cart.map((line) => ({ product_id: line.product.product_id, quantity: line.quantity }))
}

export interface TillValidationInput {
  cart: CartLine[]
  method: TillMethod
  tendered: string
  total: number
}

/**
 * Mirrors the RPC's refusals so the cashier is told before the round trip.
 * The database still decides -- these checks are a courtesy, and the reference
 * formats in particular are re-validated server-side.
 */
export function validateSale(input: TillValidationInput): string[] {
  const errors: string[] = []
  const { cart, method, tendered, total } = input

  if (cart.length === 0) errors.push('The cart is empty.')
  if (cart.length > MAX_CART_LINES) {
    errors.push(`A single sale can hold at most ${MAX_CART_LINES} different products.`)
  }

  for (const line of cart) {
    if (line.quantity > MAX_LINE_QUANTITY) {
      errors.push(`${line.product.name}: a single line cannot exceed ${MAX_LINE_QUANTITY} units.`)
    }
    if (line.quantity > line.product.available_quantity) {
      errors.push(
        `${line.product.name}: only ${line.product.available_quantity} left, ${line.quantity} in the cart.`
      )
    }
  }

  if (isOnlineMethod(method)) {
    // An online payment has no reference to type and no cash to count: the
    // customer pays at PayMongo and the webhook records the sale. The only
    // thing the till can usefully check first is the provider's floor.
    if (total < MIN_ONLINE_TOTAL) {
      errors.push(`An online payment must be at least ${MIN_ONLINE_TOTAL.toFixed(2)}.`)
    }
  } else {
    // parseMoney, not Number: Number('1e5') is 100000 and Number(' 12 ') is 12,
    // so a field that looked like it rejected letters would still have accepted
    // them in the value that reached the database.
    const amount = parseMoney(tendered)
    if (tendered.trim() === '') {
      errors.push('Enter the cash received.')
    } else if (amount === null) {
      errors.push('Cash received must be a plain amount, e.g. 250 or 250.50.')
    } else if (amount > MAX_TENDERED) {
      errors.push(`Cash received cannot exceed ${MAX_TENDERED.toLocaleString()}.`)
    } else if (amount < total) {
      errors.push('Cash received is less than the total.')
    }
  }

  return errors
}

/* ------------------------------------------------------------ idempotency */

export interface CheckoutAttempt {
  fingerprint: string
  key: string
}

/**
 * A local description of the sale being attempted.
 *
 * This is NOT the fingerprint the database compares -- that one is computed
 * inside `checkout_pos_sale` with SHA-256 over the normalised request, because
 * a value the client supplies is a claim rather than a fact. This exists only
 * to decide when the till should mint a *new* key: the same sale keeps its key
 * so a retry is idempotent, and any change to the sale earns a fresh one.
 *
 * Items are normalised and sorted here for the same reason the server does it:
 * the same cart entered in a different order is the same sale.
 */
export function attemptFingerprint(input: {
  branchId: string | null
  items: { product_id: string; quantity: number }[]
  method: TillMethod
  reference: string | null
  tendered: number | null
}): string {
  const merged = new Map<string, number>()
  for (const item of input.items) {
    merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + item.quantity)
  }
  const normalized = [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([product_id, quantity]) => ({ product_id, quantity }))

  return JSON.stringify({
    branch_id: input.branchId,
    items: normalized,
    method: input.method,
    reference: input.reference,
    tendered: input.tendered,
  })
}

/** Same sale as last time → reuse the key. Anything different → a new one. */
export function nextAttempt(
  previous: CheckoutAttempt | null,
  fingerprint: string,
  generateKey: () => string
): CheckoutAttempt {
  if (previous && previous.fingerprint === fingerprint) return previous
  return { fingerprint, key: generateKey() }
}

export function newCheckoutKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/* ------------------------------------------------------------------ errors */

export function describeCheckoutError(error: unknown): string {
  const message = errorMessage(error)

  if (message.includes('already used for a different sale')) {
    return 'This till already recorded a different sale under that attempt. Start a new sale.'
  }
  if (message.includes('Stock for') && message.includes('changed during checkout')) {
    return 'Someone sold the last of an item while this sale was being rung up. Check the cart and try again.'
  }
  if (message.includes('Only') && message.includes('left')) {
    return message.replace(/^.*?ERROR:\s*/i, '')
  }
  if (message.includes('no longer available at this branch')) {
    return 'One of those products is no longer offered at this branch. Remove it and try again.'
  }
  if (message.includes('POS access at this branch')) {
    return 'You do not have POS access at this branch.'
  }
  if (message.includes('Cash received is less')) {
    return 'Cash received is less than the total.'
  }
  if (message.includes('reference')) {
    return message.replace(/^.*?ERROR:\s*/i, '')
  }
  return message || 'The sale could not be completed. Please try again.'
}

export const peso = (value: number) =>
  `₱${value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
