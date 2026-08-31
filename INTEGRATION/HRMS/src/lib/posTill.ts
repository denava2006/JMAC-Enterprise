import { computeFees, round2, sumFees, type AppliedFee, type Fee } from '@/lib/posFees'

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

export const PAYMENT_METHODS = ['cash', 'gcash', 'maya', 'bank', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

/**
 * What the till OFFERS. These are the methods where the money has already
 * moved somewhere else and the cashier is recording it.
 *
 * GCash and Maya say so explicitly, because the online group offers those same
 * two brands and the two are settled completely differently. Two options
 * reading plain "Maya" would be ambiguous on screen and indistinguishable to a
 * screen reader. Use SALE_METHOD_LABEL to render a method a sale already has.
 */
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  gcash: 'GCash (record reference)',
  maya: 'Maya (record reference)',
  bank: 'Bank transfer',
  other: 'Other',
}

/**
 * Payments JMAC collects through PayMongo, as opposed to the methods above --
 * which record a payment that happened somewhere else and whose reference the
 * cashier types in.
 *
 * The distinction matters because the two are settled completely differently.
 * A manual GCash payment is already done when the cashier rings it up; an
 * online GCash payment does not exist until PayMongo says so, and the sale is
 * created by a webhook rather than by pressing a button. Keeping both means a
 * branch that is not using PayMongo loses nothing.
 *
 * 'paymaya' rather than 'maya' because that is PayMongo's identifier for it.
 * The legacy 'maya' value is untouched so historical sales stay valid.
 */
export const ONLINE_METHODS = ['card', 'gcash', 'paymaya', 'qrph'] as const
export type OnlineMethod = (typeof ONLINE_METHODS)[number]

export const ONLINE_METHOD_LABEL: Record<OnlineMethod, string> = {
  card: 'Card',
  gcash: 'GCash',
  paymaya: 'Maya',
  qrph: 'QR Ph',
}

/** What the till's selector holds. The `online:` prefix keeps the two GCash
 *  entries apart: one is a reference the cashier types, the other is a payment
 *  PayMongo has to confirm. */
export type TillMethod = PaymentMethod | `online:${OnlineMethod}`

export function isOnlineMethod(method: TillMethod): method is `online:${OnlineMethod}` {
  return method.startsWith('online:')
}

export function onlineMethodOf(method: TillMethod): OnlineMethod | null {
  if (!isOnlineMethod(method)) return null
  const value = method.slice('online:'.length) as OnlineMethod
  return ONLINE_METHODS.includes(value) ? value : null
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
  reference: string
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
  const { cart, method, reference, tendered, total } = input

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
  } else if (method === 'cash') {
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
  } else {
    const manual = method as Exclude<PaymentMethod, 'cash'>
    const trimmed = reference.trim()
    if (!trimmed) {
      errors.push(`A reference is required for ${PAYMENT_METHOD_LABEL[manual]} payments.`)
    } else if ((manual === 'gcash' || manual === 'maya') && !/^[0-9]{6,32}$/.test(trimmed)) {
      errors.push(`A ${PAYMENT_METHOD_LABEL[manual]} reference must be 6-32 digits.`)
    } else if (manual === 'bank' && !/^[A-Za-z0-9 -]{6,64}$/.test(trimmed)) {
      errors.push('A bank reference must be 6-64 letters, numbers, spaces or hyphens.')
    } else if (manual === 'other' && trimmed.length > 64) {
      errors.push('A reference must be 1-64 characters.')
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
  const message = error instanceof Error ? error.message : String(error ?? '')

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
