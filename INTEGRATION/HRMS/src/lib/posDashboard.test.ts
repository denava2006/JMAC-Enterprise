import { describe, expect, it } from 'vitest'
import {
  businessTodayISO,
  describeDashboardError,
  emptySummary,
  formatAverageSale,
  formatBusinessDate,
  moneyReconciles,
  paymentMethodLabel,
  paymentShares,
  peso,
  stockAlerts,
  type DashboardSummary,
} from '@/lib/posDashboard'

function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    business_date: '2026-08-25',
    sales_collected: 330,
    product_sales: 300,
    fees_collected: 30,
    transaction_count: 3,
    items_sold: 7,
    average_sale: 110,
    low_stock_count: 2,
    out_of_stock_count: 1,
    ...overrides,
  }
}

describe('the three money figures', () => {
  it('reconcile: collected is sales plus the fees the customer paid', () => {
    expect(moneyReconciles(summary())).toBe(true)
  })

  it('catches a drift between the RPC and the labels', () => {
    expect(moneyReconciles(summary({ fees_collected: 0 }))).toBe(false)
  })

  it('tolerates float representation, not real disagreement', () => {
    expect(moneyReconciles(summary({ sales_collected: 330.001 }))).toBe(true)
    expect(moneyReconciles(summary({ sales_collected: 331 }))).toBe(false)
  })

  it('holds for a day with nothing on it', () => {
    expect(moneyReconciles(emptySummary())).toBe(true)
  })
})

describe('formatAverageSale', () => {
  it('shows a dash on a day with no sales, never ₱0.00', () => {
    // The RPC divides by nullif(count, 0). "₱0.00 average" would read as
    // "sales averaged nothing", which is a different and untrue claim from
    // "there were no sales".
    expect(formatAverageSale(null)).toBe('—')
    expect(formatAverageSale(undefined)).toBe('—')
  })

  it('formats a real average as pesos', () => {
    expect(formatAverageSale(110)).toBe('₱110.00')
  })
})

describe('the summary shape', () => {
  it('carries no cost, COGS, margin or profit field', () => {
    // The RPCs do not declare them; this pins the client type to the same
    // contract so a future edit here cannot start reading one.
    const keys = Object.keys(summary())
    for (const forbidden of [
      'unit_cost',
      'average_unit_cost',
      'total_cogs',
      'line_cogs',
      'gross_profit',
      'net_profit',
      'margin',
      // The standalone's own column names, so a copy-paste from it fails here.
      'net_sales',
    ]) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('names its money figures for what they are', () => {
    const keys = Object.keys(summary())
    expect(keys).toContain('sales_collected')
    expect(keys).toContain('product_sales')
    expect(keys).toContain('fees_collected')
  })

  it('gives an unloaded day a full shape rather than undefined cards', () => {
    const empty = emptySummary('2026-08-25')
    expect(empty.transaction_count).toBe(0)
    expect(empty.items_sold).toBe(0)
    expect(empty.average_sale).toBeNull()
    expect(empty.business_date).toBe('2026-08-25')
  })
})

describe('formatBusinessDate', () => {
  it('reads the date as calendar fields, not as UTC midnight', () => {
    // new Date('2026-08-25') is parsed as UTC and renders as the 24th for
    // anyone west of Greenwich -- the same class of bug as the browser-local
    // day window this phase removed.
    expect(formatBusinessDate('2026-08-25')).toContain('25')
    expect(formatBusinessDate('2026-08-25')).toContain('2026')
  })

  it('is empty rather than "Invalid Date" when the day has not loaded', () => {
    expect(formatBusinessDate(undefined)).toBe('')
    expect(formatBusinessDate('')).toBe('')
  })
})

describe('businessTodayISO', () => {
  it('is the business calendar date, not the device one', () => {
    // 2026-08-25T16:30:00Z is already the 26th in Manila (UTC+8).
    expect(businessTodayISO(new Date('2026-08-25T16:30:00Z'))).toBe('2026-08-26')
    expect(businessTodayISO(new Date('2026-08-25T15:30:00Z'))).toBe('2026-08-25')
  })

  it('produces the format both a date input and the RPC accept', () => {
    expect(businessTodayISO(new Date('2026-08-25T02:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('paymentMethodLabel', () => {
  it('uses the till"s own labels so the two screens agree', () => {
    expect(paymentMethodLabel('cash')).toBe('Cash')
    expect(paymentMethodLabel('gcash')).toBe('GCash')
  })

  it('falls back to the raw value rather than rendering nothing', () => {
    expect(paymentMethodLabel('crypto')).toBe('crypto')
  })
})

describe('peso', () => {
  it('always shows two decimals', () => {
    expect(peso(0)).toBe('₱0.00')
    expect(peso(1234.5)).toBe('₱1,234.50')
  })
})

describe('describeDashboardError', () => {
  it('explains a branch the account does not manage', () => {
    expect(describeDashboardError(new Error('permission denied'))).toBe(
      'You do not manage that branch.'
    )
  })

  it('explains an expired session', () => {
    expect(describeDashboardError(new Error('Sign in to continue'))).toContain('session has expired')
  })

  it('never returns an empty string', () => {
    expect(describeDashboardError(null)).toBe("Today's figures could not be loaded.")
  })
})

describe('how the day was paid', () => {
  const method = (payment_method: string, amount_collected: number, transaction_count = 1) => ({
    payment_method,
    transaction_count,
    amount_collected,
  })

  it('gives each method its share of the takings', () => {
    const shares = paymentShares([method('cash', 750), method('gcash', 250)])
    expect(shares.map((s) => Math.round(s.share))).toEqual([75, 25])
  })

  it('puts the biggest first, whatever order it arrived in', () => {
    const shares = paymentShares([method('gcash', 50), method('cash', 900), method('qrph', 300)])
    expect(shares.map((s) => s.payment_method)).toEqual(['cash', 'qrph', 'gcash'])
  })

  it('divides by nothing on a day that took nothing', () => {
    const shares = paymentShares([method('cash', 0), method('gcash', 0)])
    expect(shares.every((s) => s.share === 0)).toBe(true)
    expect(shares.every((s) => Number.isFinite(s.share))).toBe(true)
  })

  it('leaves the amounts and counts exactly as they arrived', () => {
    const [cash] = paymentShares([method('cash', 750, 12)])
    expect(cash.amount_collected).toBe(750)
    expect(cash.transaction_count).toBe(12)
  })

  it('has nothing to say about an empty list', () => {
    expect(paymentShares([])).toEqual([])
  })
})

describe('what needs attention', () => {
  const withStock = (out: number, low: number) => ({ ...emptySummary(), out_of_stock_count: out, low_stock_count: low })

  // Out of stock first: a product offered and unavailable is costing sales
  // now, where a low one is a warning about later.
  it('puts the shortage that is already costing sales first', () => {
    expect(stockAlerts(withStock(2, 5)).map((a) => a.kind)).toEqual(['out', 'low'])
  })

  it('mentions only what is actually wrong', () => {
    expect(stockAlerts(withStock(0, 5)).map((a) => a.kind)).toEqual(['low'])
    expect(stockAlerts(withStock(3, 0)).map((a) => a.kind)).toEqual(['out'])
  })

  // A dashboard that reports two zeroes every day teaches a manager to ignore
  // the panel, which is the opposite of what it is for.
  it('says nothing at all when nothing is wrong', () => {
    expect(stockAlerts(withStock(0, 0))).toEqual([])
  })

  it('carries the count through untouched', () => {
    expect(stockAlerts(withStock(4, 0))[0].count).toBe(4)
  })

  it('has nothing to say before the figures arrive', () => {
    expect(stockAlerts(undefined)).toEqual([])
  })
})
