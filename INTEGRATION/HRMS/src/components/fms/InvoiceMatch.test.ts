import { describe, expect, it } from 'vitest'
import { matchSummary } from '@/components/fms/InvoiceMatch'
import { invoiceActionsFor } from '@/components/fms/SupplierInvoiceDetail'
import type { InvoiceMatchRow } from '@/hooks/useSupplierInvoices'

/**
 * The three-way match, and who may act on it.
 *
 * The verdicts themselves come from the database -- the approval guard reads
 * the same function -- so what is held here is the summary shown to a person
 * and the controls they are offered. A discrepancy must never be summarised
 * away, and Approve must never appear on an invoice the server would refuse.
 */

function row(over: Partial<InvoiceMatchRow> = {}): InvoiceMatchRow {
  return {
    line_id: 'l1',
    purchase_order_item_id: 'poi1',
    description: 'Coca-Cola 5.6',
    ordered_quantity: 20,
    cancelled_quantity: 0,
    effective_quantity: 20,
    received_quantity: 20,
    previously_invoiced: 0,
    billable_quantity: 20,
    invoice_quantity: 20,
    po_unit_cost: 65,
    invoice_unit_cost: 65,
    po_line_value: 1300,
    invoice_line_value: 1300,
    quantity_matched: true,
    price_matched: true,
    verdict: 'matched',
    ...over,
  }
}

describe('summarising the match', () => {
  it('calls an exact invoice matched', () => {
    const s = matchSummary([row()])
    expect(s.matched).toBe(true)
    expect(s.label).toBe('Matched')
    expect(s.tone).toBe('success')
  })

  it('names a quantity mismatch as one', () => {
    // Billed 25 against 20 received.
    const s = matchSummary([row({ invoice_quantity: 25, quantity_matched: false, verdict: 'quantity_mismatch' })])
    expect(s.matched).toBe(false)
    expect(s.label).toBe('Quantity mismatch')
  })

  it('names a price mismatch as one', () => {
    // Billed 70 where the order agreed 65.
    const s = matchSummary([row({ invoice_unit_cost: 70, price_matched: false, verdict: 'price_mismatch' })])
    expect(s.matched).toBe(false)
    expect(s.label).toBe('Price mismatch')
  })

  it('says so when both are wrong rather than picking one', () => {
    const s = matchSummary([
      row({ quantity_matched: false, verdict: 'quantity_mismatch' }),
      row({ line_id: 'l2', price_matched: false, verdict: 'price_mismatch' }),
    ])
    expect(s.label).toBe('Quantity and price mismatch')
  })

  it('does not call one good line a match when another is wrong', () => {
    // The failure mode worth guarding: a summary that reports the majority.
    const s = matchSummary([row(), row({ line_id: 'l2', quantity_matched: false })])
    expect(s.matched).toBe(false)
  })

  it('treats an invoice with no lines as unmatched', () => {
    expect(matchSummary([]).matched).toBe(false)
  })
})

describe('who may act on an invoice', () => {
  it('lets the Accountant submit a draft, and nothing else', () => {
    const actions = invoiceActionsFor('accountant', 'draft').map((a) => a.to)
    expect(actions).toEqual(['for_review'])
  })

  it('lets them resubmit one that came back', () => {
    expect(invoiceActionsFor('accountant', 'returned').map((a) => a.to)).toEqual(['for_review'])
  })

  it('offers the Accountant nothing once it is with the Manager', () => {
    expect(invoiceActionsFor('accountant', 'for_review')).toEqual([])
  })

  it('never offers the Accountant an approval', () => {
    for (const status of ['draft', 'for_review', 'returned', 'approved', 'rejected']) {
      const actions = invoiceActionsFor('accountant', status).map((a) => a.to)
      expect(actions).not.toContain('approved')
    }
  })

  it('gives the Finance Manager the three decisions on a submitted invoice', () => {
    expect(invoiceActionsFor('finance_manager', 'for_review').map((a) => a.to)).toEqual([
      'approved',
      'returned',
      'rejected',
    ])
  })

  it('offers the Finance Manager nothing on a draft', () => {
    // A checker who can act on a document still being written is a checker
    // acting on something nobody has put in front of them.
    expect(invoiceActionsFor('finance_manager', 'draft')).toEqual([])
  })

  it('never offers the Finance Manager a submit', () => {
    for (const status of ['draft', 'for_review', 'returned', 'approved']) {
      const actions = invoiceActionsFor('finance_manager', status).map((a) => a.to)
      expect(actions).not.toContain('for_review')
    }
  })

  it.each(['finance_staff', 'admin', 'employee', undefined])(
    'offers %s nothing at all',
    (role) => {
      for (const status of ['draft', 'for_review', 'approved']) {
        expect(invoiceActionsFor(role, status)).toEqual([])
      }
    },
  )
})
