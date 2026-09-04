import { describe, expect, it } from 'vitest'
import { invoiceStateLabel } from '@/hooks/useSupplierInvoices'
import { invoiceActionsFor } from '@/components/fms/SupplierInvoiceDetail'

/**
 * What an invoice is called, and what may still be done to it.
 *
 * Two facts that had been collapsed into one. The workflow status is what the
 * Finance Manager decided; the payment state is what has happened since. An
 * invoice stays `approved` for ever — paying it does not un-decide the
 * approval — but "Approved — awaiting payment" on a settled invoice is simply
 * wrong on the screen.
 */

describe('what an invoice is called', () => {
  it('says Approved — awaiting payment while nothing is paid', () => {
    expect(invoiceStateLabel({ status: 'approved', amount_paid: 0, balance_due: 1300 })).toBe(
      'Approved — awaiting payment'
    )
  })

  it('says Partially paid once some of it is', () => {
    expect(invoiceStateLabel({ status: 'approved', amount_paid: 500, balance_due: 800 })).toBe(
      'Partially paid'
    )
  })

  // The production case: SI-93842 after repair — workflow approved, fully paid.
  it('says Paid when the balance is gone, not "awaiting payment"', () => {
    expect(invoiceStateLabel({ status: 'approved', amount_paid: 1300, balance_due: 0 })).toBe(
      'Paid'
    )
  })

  it('lets Voided win over everything, because it is a different claim', () => {
    expect(invoiceStateLabel({ status: 'voided', amount_paid: 0, balance_due: 0 })).toBe('Voided')
  })

  it('leaves the pre-approval states to the workflow wording', () => {
    expect(invoiceStateLabel({ status: 'draft', amount_paid: 0, balance_due: 0 })).toBe('Draft')
    expect(invoiceStateLabel({ status: 'for_review', amount_paid: 0, balance_due: 0 })).toBe(
      'With the Finance Manager'
    )
    expect(invoiceStateLabel({ status: 'returned', amount_paid: 0, balance_due: 0 })).toBe(
      'Returned for correction'
    )
  })

  it('reads a string amount the same as a number', () => {
    // The view returns numerics, which PostgREST hands over as strings.
    expect(invoiceStateLabel({ status: 'approved', amount_paid: '1300.00', balance_due: '0.00' }))
      .toBe('Paid')
  })
})

describe('whether an invoice may still be voided', () => {
  const clean = { amountPaid: 0, pending: 0 }

  it('offers Void on an approved invoice nobody has paid or promised', () => {
    const actions = invoiceActionsFor('finance_manager', 'approved', clean)
    expect(actions.map((a) => a.to)).toContain('voided')
  })

  // Voiding says the bill was never valid. F6 has no reversal, so on a paid
  // invoice it would hide the bill and leave the money gone.
  it('withdraws Void once any money has been paid', () => {
    const actions = invoiceActionsFor('finance_manager', 'approved', {
      amountPaid: 500,
      pending: 0,
    })
    expect(actions.map((a) => a.to)).not.toContain('voided')
  })

  it('withdraws Void while an instruction is still in flight', () => {
    const actions = invoiceActionsFor('finance_manager', 'approved', {
      amountPaid: 0,
      pending: 800,
    })
    expect(actions.map((a) => a.to)).not.toContain('voided')
  })

  it('never offered Void to the Accountant in the first place', () => {
    expect(invoiceActionsFor('accountant', 'approved', clean)).toHaveLength(0)
  })

  it('leaves the review actions alone', () => {
    const actions = invoiceActionsFor('finance_manager', 'for_review', {
      amountPaid: 0,
      pending: 0,
    })
    expect(actions.map((a) => a.to).sort()).toEqual(['approved', 'rejected', 'returned'])
  })
})
