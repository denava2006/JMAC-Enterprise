import { describe, expect, it } from 'vitest'
import {
  MAX_LINE_QUANTITY,
  addToCart,
  attemptFingerprint,
  cartToItems,
  cartTotals,
  changeDue,
  describeCheckoutError,
  nextAttempt,
  setLineQuantity,
  validateSale,
  type CartLine,
  type CatalogueProduct,
  TILL_METHODS,
  TILL_METHOD_LABEL,
  isOnlineMethod,
  saleMethodLabel,
  LEGACY_PAYMENT_METHODS,
} from '@/lib/posTill'
import type { Fee } from '@/lib/posFees'

function product(overrides: Partial<CatalogueProduct> = {}): CatalogueProduct {
  return {
    product_id: 'p1',
    name: 'Cola 1.5L',
    category_name: 'Drinks',
    selling_price: 100,
    image_path: null,
    available_quantity: 10,
    is_low_stock: false,
    ...overrides,
  }
}

const line = (p: CatalogueProduct, quantity: number): CartLine => ({ product: p, quantity })

describe('addToCart', () => {
  it('adds a new product as its own line', () => {
    expect(addToCart([], product())).toEqual([line(product(), 1)])
  })

  it('merges a repeat tap into the existing line', () => {
    // The server normalises duplicates anyway; merging here keeps the stock
    // check honest, since two separate lines would each look affordable.
    const cart = addToCart(addToCart([], product(), 2), product(), 3)
    expect(cart).toHaveLength(1)
    expect(cart[0].quantity).toBe(5)
  })

  it('keeps different products on separate lines', () => {
    const cart = addToCart(addToCart([], product()), product({ product_id: 'p2', name: 'Chips' }))
    expect(cart).toHaveLength(2)
  })

  it('never exceeds the per-line cap', () => {
    const cart = addToCart([], product(), MAX_LINE_QUANTITY + 50)
    expect(cart[0].quantity).toBe(MAX_LINE_QUANTITY)
  })
})

describe('setLineQuantity', () => {
  it('removes the line at zero or below', () => {
    expect(setLineQuantity([line(product(), 3)], 'p1', 0)).toEqual([])
    expect(setLineQuantity([line(product(), 3)], 'p1', -1)).toEqual([])
  })

  it('sets the quantity', () => {
    expect(setLineQuantity([line(product(), 3)], 'p1', 7)[0].quantity).toBe(7)
  })
})

describe('cartTotals', () => {
  const fee: Fee = { id: 'f1', name: 'Service Charge', type: 'percent', value: 10, enabled: true }

  it('rounds each line before summing, matching the server', () => {
    const cart = [
      line(product({ product_id: 'a', selling_price: 0.005 }), 1),
      line(product({ product_id: 'b', selling_price: 0.005 }), 1),
    ]
    // 0.01 + 0.01, not round(0.01).
    expect(cartTotals(cart, null).subtotal).toBe(0.02)
  })

  it('applies fees to the subtotal', () => {
    const totals = cartTotals([line(product(), 5)], [fee])
    expect(totals.subtotal).toBe(500)
    expect(totals.feesTotal).toBe(50)
    expect(totals.total).toBe(550)
  })

  it('is fee-free when a branch has none configured', () => {
    const totals = cartTotals([line(product(), 5)], null)
    expect(totals.total).toBe(500)
    expect(totals.appliedFees).toEqual([])
  })

  it('counts units across lines', () => {
    const cart = [line(product(), 2), line(product({ product_id: 'p2' }), 3)]
    expect(cartTotals(cart, null).units).toBe(5)
  })
})

describe('changeDue', () => {
  it('is the tender less the total', () => {
    expect(changeDue(594, 600)).toBe(6)
  })

  it('rounds the way the database does', () => {
    expect(changeDue(1.005, 2)).toBe(1)
  })
})

describe('cartToItems', () => {
  it('sends only product ids and quantities -- never a price', () => {
    const items = cartToItems([line(product(), 2)])
    expect(items).toEqual([{ product_id: 'p1', quantity: 2 }])
    expect(JSON.stringify(items)).not.toMatch(/price|cost|total/)
  })
})

describe('validateSale', () => {
  const base = { method: 'cash' as const, tendered: '1000', total: 500 }

  it('accepts a normal cash sale', () => {
    expect(validateSale({ ...base, cart: [line(product(), 2)] })).toEqual([])
  })

  it('refuses an empty cart', () => {
    expect(validateSale({ ...base, cart: [] }).join(' ')).toContain('cart is empty')
  })

  it('refuses more units than the branch holds', () => {
    const cart = [line(product({ available_quantity: 3 }), 5)]
    expect(validateSale({ ...base, cart }).join(' ')).toContain('only 3 left')
  })

  it('refuses cash below the total', () => {
    expect(
      validateSale({ ...base, cart: [line(product(), 2)], tendered: '100' }).join(' ')
    ).toContain('less than the total')
  })

  it('refuses a blank cash tender', () => {
    expect(
      validateSale({ ...base, cart: [line(product(), 2)], tendered: '' }).join(' ')
    ).toContain('Enter the cash received')
  })

  it('asks for no reference on any offered method', () => {
    // The reference field went with the "record reference" methods. Every
    // non-cash method the till offers is settled by PayMongo, which issues its
    // own reference -- there is nothing for a cashier to type.
    for (const method of ['gcash', 'paymaya', 'card', 'qrph'] as const) {
      expect(validateSale({ ...base, cart: [line(product(), 2)], method })).toEqual([])
    }
  })

  it('does not ask for a tender on an electronic payment', () => {
    const cart = [line(product(), 2)]
    expect(
      validateSale({ ...base, cart, method: 'paymaya', tendered: '' })
    ).toEqual([])
  })
})

describe('attemptFingerprint', () => {
  const items = [{ product_id: 'b', quantity: 1 }, { product_id: 'a', quantity: 2 }]
  const base = { branchId: 'br1', method: 'cash' as const, reference: null, tendered: 1000 }

  it('is order-independent -- the same cart is the same sale', () => {
    const one = attemptFingerprint({ ...base, items })
    const other = attemptFingerprint({ ...base, items: [...items].reverse() })
    expect(one).toBe(other)
  })

  it('merges duplicate lines the way the server does', () => {
    const split = attemptFingerprint({
      ...base,
      items: [{ product_id: 'a', quantity: 2 }, { product_id: 'a', quantity: 3 }],
    })
    const merged = attemptFingerprint({ ...base, items: [{ product_id: 'a', quantity: 5 }] })
    expect(split).toBe(merged)
  })

  it('changes when the cart changes', () => {
    expect(attemptFingerprint({ ...base, items })).not.toBe(
      attemptFingerprint({ ...base, items: [{ product_id: 'a', quantity: 9 }] })
    )
  })

  it('changes when the payment changes', () => {
    expect(attemptFingerprint({ ...base, items })).not.toBe(
      attemptFingerprint({ ...base, items, tendered: 2000 })
    )
  })
})

describe('nextAttempt', () => {
  let counter = 0
  const key = () => `key-${++counter}`

  it('reuses the key while the sale is unchanged -- that is what makes a retry safe', () => {
    counter = 0
    const first = nextAttempt(null, 'fp-1', key)
    const second = nextAttempt(first, 'fp-1', key)
    expect(second).toBe(first)
  })

  it('mints a new key as soon as the sale changes', () => {
    counter = 0
    const first = nextAttempt(null, 'fp-1', key)
    const second = nextAttempt(first, 'fp-2', key)
    expect(second.key).not.toBe(first.key)
  })
})

describe('describeCheckoutError', () => {
  it('explains a reused key', () => {
    expect(
      describeCheckoutError(new Error('That checkout key was already used for a different sale'))
    ).toContain('Start a new sale')
  })

  it('explains a stock race', () => {
    expect(
      describeCheckoutError(new Error('Stock for Cola 1.5L changed during checkout'))
    ).toContain('sold the last of an item')
  })

  it('passes the insufficient-stock sentence through, since it names the number', () => {
    expect(describeCheckoutError(new Error('Only 3 of Cola 1.5L left'))).toContain('Only 3')
  })

  it('never returns an empty string', () => {
    expect(describeCheckoutError(null)).toBe('The sale could not be completed. Please try again.')
  })
})

describe('the payment methods the till offers', () => {
  it('offers exactly five', () => {
    expect(TILL_METHODS).toHaveLength(5)
    expect([...TILL_METHODS]).toEqual(['cash', 'gcash', 'paymaya', 'card', 'qrph'])
  })

  it('reads as Cash, GCash, Maya, Card, QR Ph', () => {
    expect(TILL_METHODS.map((m) => TILL_METHOD_LABEL[m])).toEqual([
      'Cash',
      'GCash',
      'Maya',
      'Card',
      'QR Ph',
    ])
  })

  it('offers no duplicate GCash and no duplicate Maya', () => {
    // Two entries reading the same brand is what the "record reference"
    // variants used to cause; a screen reader could not tell them apart.
    const labels = TILL_METHODS.map((m) => TILL_METHOD_LABEL[m])
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels.filter((l) => l === 'GCash')).toHaveLength(1)
    expect(labels.filter((l) => l === 'Maya')).toHaveLength(1)
  })

  it('offers no Bank transfer and no Other', () => {
    const labels = TILL_METHODS.map((m) => TILL_METHOD_LABEL[m])
    expect(labels).not.toContain('Bank transfer')
    expect(labels).not.toContain('Other')
    const values = [...TILL_METHODS] as string[]
    expect(values).not.toContain('bank')
    expect(values).not.toContain('other')
    expect(values).not.toContain('maya')
  })

  it('treats cash as the only method not settled by PayMongo', () => {
    expect(isOnlineMethod('cash')).toBe(false)
    for (const method of ['gcash', 'paymaya', 'card', 'qrph'] as const) {
      expect(isOnlineMethod(method)).toBe(true)
    }
  })
})

describe('rendering a sale that used a method the till no longer offers', () => {
  it('still names every historical value', () => {
    // These sales exist. Removing a menu entry must not turn their receipts,
    // reports or audit rows into "undefined" or a raw enum.
    expect(saleMethodLabel('maya')).toBe('Maya')
    expect(saleMethodLabel('bank')).toBe('Bank transfer')
    expect(saleMethodLabel('other')).toBe('Other')
    expect(saleMethodLabel('gcash')).toBe('GCash')
    expect(saleMethodLabel('cash')).toBe('Cash')
  })

  it('still names the methods that are offered', () => {
    expect(saleMethodLabel('paymaya')).toBe('Maya')
    expect(saleMethodLabel('card')).toBe('Card')
    expect(saleMethodLabel('qrph')).toBe('QR Ph')
  })

  it('falls back to the stored value rather than rendering nothing', () => {
    expect(saleMethodLabel('something_new')).toBe('something_new')
  })

  it('covers every value the database still accepts', () => {
    // The CHECK on pos_sales.payment_method is deliberately wider than the
    // menu, because history has to stay valid. Nothing it allows may render
    // blank.
    for (const stored of LEGACY_PAYMENT_METHODS) {
      const label = saleMethodLabel(stored)
      expect(label).toBeTruthy()
      expect(label).not.toBe('undefined')
    }
  })
})
