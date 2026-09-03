import { describe, expect, it } from 'vitest'
import {
  FINANCE_SALES_METHODS,
  NOT_MODELLED_NOTE,
  SETTLEMENT_DISCLOSURE,
  cashCollected,
  formatSaleTimestamp,
  isProviderSettled,
  providerCollected,
  saleReference,
  type FinanceSalesCollection,
  type FinanceSalesTransaction,
} from '@/lib/financeSales'

/**
 * What Finance says about POS money, and what it refuses to say.
 *
 * The interesting claims here are all about restraint: the module computes no
 * totals of its own, never calls provider money "deposited", and never lets a
 * structural zero read as a measurement.
 */

function collection(method: string, amount: number): FinanceSalesCollection {
  return { payment_method: method, transaction_count: 1, amount_collected: amount }
}

function transaction(over: Partial<FinanceSalesTransaction> = {}): FinanceSalesTransaction {
  return {
    sale_id: 'ab12cd34-0000-0000-0000-000000000000',
    sold_at: '2026-09-04T02:30:00Z',
    branch_id: 'b1',
    branch_name: 'Cavite',
    cashier_id: 'c1',
    cashier_name: 'Ana Cruz',
    payment_method: 'cash',
    payment_reference: null,
    item_count: 2,
    gross_sales: 200,
    discounts: 0,
    refunds: 0,
    net_sales: 200,
    fees_total: 5,
    total_collected: 205,
    total_rows: 1,
    ...over,
  }
}

describe('where the money actually is', () => {
  it('counts cash as cash in the branch', () => {
    const rows = [collection('cash', 1000), collection('gcash', 1500)]
    expect(cashCollected(rows)).toBe(1000)
  })

  it('counts card and e-wallet money as held by the provider, not by JMAC', () => {
    const rows = [
      collection('cash', 1000),
      collection('gcash', 1500),
      collection('card', 2000),
      collection('qrph', 500),
    ]
    expect(providerCollected(rows)).toBe(4000)
  })

  // The distinction the brief calls mandatory: a customer paying by card is
  // not the bank receiving the money.
  it('treats every non-cash method as provider-held', () => {
    for (const method of FINANCE_SALES_METHODS) {
      expect(isProviderSettled(method)).toBe(method !== 'cash')
    }
  })

  it('splits a range exhaustively -- nothing is counted twice or lost', () => {
    const rows = [collection('cash', 1000), collection('maya', 250), collection('card', 750)]
    const total = rows.reduce((sum, r) => sum + r.amount_collected, 0)
    expect(cashCollected(rows) + providerCollected(rows)).toBe(total)
  })
})

describe('what the page will not claim', () => {
  // A label reading "deposited" or "settled" would assert something no table
  // in this database knows.
  it('never describes provider money as banked, deposited or settled', () => {
    expect(SETTLEMENT_DISCLOSURE).not.toMatch(/\bdeposited\b/i)
    expect(SETTLEMENT_DISCLOSURE).not.toMatch(/bank received/i)
    // "settled" may appear, but only ever negated.
    expect(SETTLEMENT_DISCLOSURE).not.toMatch(/(?<!not yet )settled to/i)
    expect(SETTLEMENT_DISCLOSURE).toMatch(/not yet settled/i)
    expect(SETTLEMENT_DISCLOSURE).toMatch(/not integrated/i)
  })

  it('says discounts and refunds are unmodelled rather than measured at zero', () => {
    expect(NOT_MODELLED_NOTE).toMatch(/no discounts/i)
    expect(NOT_MODELLED_NOTE).toMatch(/no void or refund/i)
    expect(NOT_MODELLED_NOTE).toMatch(/structurally zero/i)
  })
})

describe('reconciling a row back to its receipt', () => {
  it('shows the provider reference when there is one', () => {
    expect(saleReference(transaction({ payment_reference: '09171234567' }))).toBe('09171234567')
  })

  it('falls back to the sale id, which is the POS primary key', () => {
    expect(saleReference(transaction())).toBe('AB12CD34')
  })

  it('ignores a blank reference rather than showing an empty cell', () => {
    expect(saleReference(transaction({ payment_reference: '   ' }))).toBe('AB12CD34')
  })
})

describe('the clock a Finance reader sees', () => {
  // 02:30 UTC is 10:30 the same morning in Manila. A reader anywhere must see
  // the branch's clock, or the row will not match the receipt in the shop.
  it('renders sale times in Philippine business time', () => {
    const shown = formatSaleTimestamp('2026-09-04T02:30:00Z')
    expect(shown).toMatch(/10:30/)
    expect(shown).toMatch(/Sep/)
    expect(shown).toMatch(/4/)
  })

  // 16:30 UTC on the 3rd is already 00:30 on the 4th in Manila -- the boundary
  // a naive UTC render gets wrong.
  it('shows a late-UTC sale on the Manila day it belongs to', () => {
    const shown = formatSaleTimestamp('2026-09-03T16:30:00Z')
    expect(shown).toMatch(/Sep 4/)
    expect(shown).toMatch(/12:30/)
  })

  it('renders nothing for a missing or unparseable timestamp', () => {
    expect(formatSaleTimestamp(null)).toBe('')
    expect(formatSaleTimestamp('')).toBe('')
    expect(formatSaleTimestamp('not a date')).toBe('')
  })
})
