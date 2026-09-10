import { describe, expect, it } from 'vitest'
import {
  PAGE_SIZE,
  clampPageSize,
  describeTransactionError,
  offsetFor,
  pageCount,
  summarise,
  toTimestampRange,
  totalFrom,
  type TransactionRow,
} from '@/lib/posTransactions'

function row(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    sale_id: 's1',
    receipt_number: 'OR-2026-0001',
    created_at: '2026-08-25T10:00:00Z',
    status: 'completed',
    branch_id: 'b1',
    branch_name: 'Cavite Branch',
    cashier_name: 'Liza Fernandez',
    item_count: 2,
    subtotal: 100,
    fees_total: 10,
    total_amount: 110,
    payment_method: 'cash',
    payment_reference: null,
    amount_tendered: 200,
    change_given: 90,
    total_count: 1,
    ...overrides,
  }
}

describe('clampPageSize', () => {
  it('mirrors the server bound so a hand-edited request cannot ask for the table', () => {
    expect(clampPageSize(500)).toBe(100)
    expect(clampPageSize(0)).toBe(1)
    expect(clampPageSize(-10)).toBe(1)
    expect(clampPageSize(25)).toBe(25)
  })

  it('falls back to the default for a non-number', () => {
    expect(clampPageSize(Number.NaN)).toBe(PAGE_SIZE)
  })
})

describe('pagination arithmetic', () => {
  it('counts pages', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(1)).toBe(1)
    expect(pageCount(25)).toBe(1)
    expect(pageCount(26)).toBe(2)
    expect(pageCount(50)).toBe(2)
  })

  it('offsets from a one-based page', () => {
    expect(offsetFor(1)).toBe(0)
    expect(offsetFor(2)).toBe(25)
    expect(offsetFor(0)).toBe(0)
    expect(offsetFor(-3)).toBe(0)
  })
})

describe('totalFrom', () => {
  it('reads the window count off any row', () => {
    expect(totalFrom([row({ total_count: 42 })])).toBe(42)
  })

  it('is zero on an empty page, where there is no row to read it from', () => {
    expect(totalFrom([])).toBe(0)
  })
})

describe('toTimestampRange', () => {
  it('is null for an unset side, so the RPC skips that bound', () => {
    expect(toTimestampRange({ from: '', to: '' })).toEqual({ from: null, to: null })
  })

  it('runs the "to" date to the end of its day', () => {
    // "today to today" means the whole of today, not the instant midnight
    // passed -- otherwise a cashier's own sales vanish from their own filter.
    const { to } = toTimestampRange({ from: '', to: '2026-08-25' })
    expect(to).toBeTruthy()
    const end = new Date(to!)
    expect(end.getHours()).toBe(23)
    expect(end.getMinutes()).toBe(59)
  })

  it('starts the "from" date at midnight', () => {
    const { from } = toTimestampRange({ from: '2026-08-25', to: '' })
    expect(new Date(from!).getHours()).toBe(0)
  })
})

describe('summarise', () => {
  it('adds up the page', () => {
    const stats = summarise([row({ item_count: 2, total_amount: 110 }), row({ sale_id: 's2', item_count: 3, total_amount: 90 })])
    expect(stats).toEqual({ sales: 2, units: 5, taken: 200 })
  })

  it('is all zeroes for an empty page', () => {
    expect(summarise([])).toEqual({ sales: 0, units: 0, taken: 0 })
  })
})

describe('describeTransactionError', () => {
  it('keeps the receipt refusal deliberately vague', () => {
    // The RPC answers the same way for "does not exist" and "not yours", so a
    // probe cannot tell them apart. The interface must not undo that.
    expect(describeTransactionError(new Error('That receipt is not available'))).toBe(
      'That receipt is not available.'
    )
  })

  it('explains an expired session', () => {
    expect(describeTransactionError(new Error('Sign in to view a receipt'))).toContain(
      'session has expired'
    )
  })

  it('never returns an empty string', () => {
    expect(describeTransactionError(null)).toBe('Those transactions could not be loaded.')
  })
})

describe('the row shape', () => {
  it('carries no cost, COGS or profit field', () => {
    // The RPCs do not declare them; this pins the client type to the same
    // contract so a future edit cannot start reading one.
    const keys = Object.keys(row())
    for (const forbidden of ['unit_cost', 'line_cogs', 'total_cogs', 'average_unit_cost', 'gross_profit', 'net_profit', 'margin']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})
