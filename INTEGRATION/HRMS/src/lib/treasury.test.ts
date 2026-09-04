import { describe, expect, it } from 'vitest'
import {
  APPROVAL_IS_NOT_PAYMENT_NOTE,
  PAYMENT_STATUS_LABEL,
  RECORDED_SETTLEMENT_NOTE,
  SETTLEMENT_STATUS_LABEL,
  isPaymentEditable,
  isSettlementEditable,
  movementSourceLabel,
  paymentActionsFor,
  settlementActionsFor,
  settlementSource,
  signedAmount,
  type CollectionSettlement,
  type SupplierPayment,
  type TreasuryMovement,
} from '@/lib/treasury'

/**
 * The rules the buttons follow, checked against the rules the database
 * enforces. Where these two disagree, a user meets a refusal instead of a
 * disabled control — so the interesting tests here are the ones about who may
 * do what, and about the words the page uses for money that has not moved.
 */

function payment(over: Partial<SupplierPayment> = {}): SupplierPayment {
  return {
    id: 'p1',
    payment_no: 'PV-2026-0001',
    supplier_invoice_id: 'inv1',
    supplier_invoice_number: 'SI-93842',
    invoice_no: 'AP-2026-0001',
    vendor_name: 'Sahara Inc.',
    treasury_account_id: 'acc1',
    account_name: 'Main Bank Account',
    amount: 1300,
    method: 'bank_transfer',
    payment_date: null,
    reference: null,
    notes: null,
    status: 'for_approval',
    prepared_by: 'accountant-1',
    prepared_by_name: 'Ana Cruz',
    approved_by_name: null,
    approved_at: null,
    paid_by_name: null,
    paid_at: null,
    decision_reason: null,
    created_at: '2026-09-04T02:00:00Z',
    ...over,
  }
}

function settlement(over: Partial<CollectionSettlement> = {}): CollectionSettlement {
  return {
    id: 's1',
    settlement_no: 'CS-2026-0001',
    kind: 'branch_cash',
    branch_id: 'b1',
    branch_name: 'Cavite',
    payment_method: null,
    destination_account_id: 'acc1',
    destination_account_name: 'Main Bank Account',
    destination_account_type: 'bank',
    gross_amount: 2000,
    fee_amount: 0,
    net_amount: 2000,
    item_count: 3,
    settlement_date: '2026-09-04',
    reference: 'DEP-2026-001',
    notes: null,
    status: 'for_review',
    prepared_by: 'accountant-1',
    prepared_by_name: 'Ana Cruz',
    submitted_at: null,
    reviewed_by: null,
    reviewed_by_name: null,
    reviewed_at: null,
    decision_reason: null,
    created_at: '2026-09-04T02:00:00Z',
    ...over,
  }
}

describe('who may act on a payment', () => {
  it('lets the Accountant submit a draft', () => {
    const can = paymentActionsFor(payment({ status: 'draft' }), 'accountant', 'accountant-1')
    expect(can.canSubmit).toBe(true)
    expect(can.canRecord).toBe(false)
  })

  it('lets the Finance Manager decide one somebody else prepared', () => {
    const can = paymentActionsFor(payment(), 'finance_manager', 'manager-1')
    expect(can.canDecide).toBe(true)
  })

  // The rule the database enforces on identity rather than on role, so the
  // button has to ask the same question or the user meets a refusal.
  it('refuses to offer approval to the person who prepared it', () => {
    const can = paymentActionsFor(payment(), 'finance_manager', 'accountant-1')
    expect(can.canDecide).toBe(false)
  })

  it('offers Record only once a Manager has approved', () => {
    expect(
      paymentActionsFor(payment({ status: 'for_approval' }), 'accountant', 'a1').canRecord
    ).toBe(false)
    expect(paymentActionsFor(payment({ status: 'approved' }), 'accountant', 'a1').canRecord).toBe(
      true
    )
  })

  it('gives the Finance Manager no way to record a completed payment', () => {
    // Recording is bookkeeping, and the Manager already spent their say on the
    // decision. Letting them do both would collapse maker and checker.
    const can = paymentActionsFor(payment({ status: 'approved' }), 'finance_manager', 'm1')
    expect(can.canRecord).toBe(false)
  })

  it('offers procurement nothing at all', () => {
    const can = paymentActionsFor(payment({ status: 'draft' }), 'finance_staff', 'f1')
    expect(can.canSubmit).toBe(false)
    expect(can.canDecide).toBe(false)
    expect(can.canRecord).toBe(false)
  })

  it('offers nothing once a payment is paid', () => {
    const can = paymentActionsFor(payment({ status: 'paid' }), 'accountant', 'a1')
    expect(can.canSubmit || can.canDecide || can.canRecord).toBe(false)
  })
})

describe('who may act on a settlement', () => {
  it('lets the Accountant submit and the Manager confirm', () => {
    expect(
      settlementActionsFor(settlement({ status: 'draft' }), 'accountant', 'a1').canSubmit
    ).toBe(true)
    expect(settlementActionsFor(settlement(), 'finance_manager', 'manager-1').canDecide).toBe(true)
  })

  it('will not let the preparer confirm their own', () => {
    expect(settlementActionsFor(settlement(), 'finance_manager', 'accountant-1').canDecide).toBe(
      false
    )
  })

  it('offers nothing on a confirmed settlement', () => {
    const can = settlementActionsFor(settlement({ status: 'confirmed' }), 'finance_manager', 'm1')
    expect(can.canDecide).toBe(false)
  })
})

describe('what still belongs to its author', () => {
  it('counts draft and returned as editable, and nothing else', () => {
    expect(isPaymentEditable(payment({ status: 'draft' }))).toBe(true)
    expect(isPaymentEditable(payment({ status: 'returned' }))).toBe(true)
    expect(isPaymentEditable(payment({ status: 'for_approval' }))).toBe(false)
    expect(isPaymentEditable(payment({ status: 'approved' }))).toBe(false)
    expect(isPaymentEditable(payment({ status: 'paid' }))).toBe(false)

    expect(isSettlementEditable(settlement({ status: 'draft' }))).toBe(true)
    expect(isSettlementEditable(settlement({ status: 'confirmed' }))).toBe(false)
  })
})

describe('the words used for money', () => {
  // The distinction the whole phase turns on: authorising is not sending.
  it('says plainly that approving does not move money', () => {
    expect(PAYMENT_STATUS_LABEL.approved).toMatch(/not yet sent/i)
    expect(APPROVAL_IS_NOT_PAYMENT_NOTE).toMatch(/does not send money/i)
    expect(APPROVAL_IS_NOT_PAYMENT_NOTE).toMatch(/no bank transfer API/i)
  })

  it('never claims the system performs a provider payout', () => {
    expect(RECORDED_SETTLEMENT_NOTE).toMatch(/recorded from evidence/i)
    expect(RECORDED_SETTLEMENT_NOTE).toMatch(/no payout API/i)
    expect(RECORDED_SETTLEMENT_NOTE).not.toMatch(/withdraw/i)
  })

  it('describes a confirmed settlement as money received, not as a transfer made', () => {
    expect(SETTLEMENT_STATUS_LABEL.confirmed).toMatch(/received/i)
    expect(SETTLEMENT_STATUS_LABEL.confirmed).not.toMatch(/withdrawn|sent/i)
  })
})

describe('reading a movement', () => {
  function movement(over: Partial<TreasuryMovement> = {}): TreasuryMovement {
    return {
      id: 'm1',
      treasury_account_id: 'acc1',
      account_name: 'Main Bank Account',
      direction: 'in',
      amount: 2000,
      source_type: 'collection_settlement',
      source_id: 's1',
      source_no: 'CS-2026-0001',
      occurred_on: '2026-09-04',
      reference: 'DEP-2026-001',
      actor_name: 'Ana Cruz',
      created_at: '2026-09-04T02:00:00Z',
      total_rows: 1,
      ...over,
    }
  }

  it('signs an incoming movement as a gain and an outgoing one as a loss', () => {
    expect(signedAmount(movement())).toMatch(/^\+/)
    expect(signedAmount(movement({ direction: 'out' }))).toMatch(/^−/)
  })

  it('names the document behind each movement', () => {
    expect(movementSourceLabel(movement())).toBe('Collection settlement')
    expect(movementSourceLabel(movement({ source_type: 'supplier_payment' }))).toBe(
      'Supplier payment'
    )
  })
})

describe('describing what a settlement covers', () => {
  it('names the branch for a cash remittance', () => {
    expect(settlementSource(settlement())).toBe('Cavite cash')
  })

  it('names the method for a provider settlement', () => {
    const s = settlement({ kind: 'provider', branch_name: null, payment_method: 'gcash' })
    expect(settlementSource(s)).toMatch(/GCash/i)
    expect(settlementSource(s)).toMatch(/collections/i)
  })
})
