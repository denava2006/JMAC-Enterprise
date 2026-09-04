import { formatMoney } from '@/lib/currency'
import { errorMessage } from '@/lib/errorMessage'
import { saleMethodLabel } from '@/lib/posTill'

/**
 * Treasury: where JMAC's money is, and what moved it.
 *
 * Two vocabularies that must not blur into each other:
 *
 *   COLLECTED   a customer paid. F5.5 knows this the moment POS records a sale.
 *   SETTLED     the money reached an account JMAC can spend from.
 *
 * A card sale is collected instantly and settled days later, minus a fee. Cash
 * is collected at the till and settled when somebody carries it to a bank. The
 * gap between the two is what this module exists to describe, and every label
 * here is chosen so a reader cannot mistake one for the other.
 *
 * Nothing below computes a balance. Balances come from the database, derived
 * from an opening figure plus immutable movements, and a second implementation
 * in TypeScript would be a second answer to a question that has one.
 */

export const TREASURY_KEY = ['treasury'] as const
export const SETTLEMENT_KEY = ['collection-settlements'] as const
export const PAYMENT_KEY = ['supplier-payments'] as const

export interface TreasuryAccount {
  id: string
  name: string
  account_type: 'cash' | 'bank'
  finance_account_id: string | null
  finance_account_name: string | null
  branch_id: string | null
  branch_name: string | null
  currency: string
  opening_balance: number
  opening_balance_as_of: string | null
  total_in: number
  total_out: number
  balance: number
  movement_count: number
  last_movement_on: string | null
  is_active: boolean
  notes: string | null
  created_at: string
}

export interface TreasuryMovement {
  id: string
  treasury_account_id: string
  account_name: string
  direction: 'in' | 'out'
  amount: number
  source_type: 'collection_settlement' | 'supplier_payment'
  source_id: string
  source_no: string | null
  occurred_on: string
  reference: string | null
  actor_name: string | null
  created_at: string
  total_rows: number
}

export type SettlementKind = 'branch_cash' | 'provider'
export type SettlementStatus = 'draft' | 'for_review' | 'confirmed' | 'returned' | 'rejected'

export interface CollectionSettlement {
  id: string
  settlement_no: string | null
  kind: SettlementKind
  branch_id: string | null
  branch_name: string | null
  payment_method: string | null
  destination_account_id: string
  destination_account_name: string | null
  destination_account_type: string | null
  gross_amount: number
  fee_amount: number
  net_amount: number
  item_count: number
  settlement_date: string
  reference: string | null
  notes: string | null
  status: SettlementStatus
  prepared_by: string | null
  prepared_by_name: string | null
  submitted_at: string | null
  reviewed_by: string | null
  reviewed_by_name: string | null
  reviewed_at: string | null
  decision_reason: string | null
  created_at: string
}

export interface UnsettledCollection {
  sale_id: string
  sold_at: string
  branch_id: string
  branch_name: string
  cashier_name: string
  payment_method: string
  payment_reference: string | null
  amount: number
}

export type PaymentStatus =
  | 'draft'
  | 'for_approval'
  | 'approved'
  | 'paid'
  | 'returned'
  | 'rejected'

export interface SupplierPayment {
  id: string
  payment_no: string | null
  supplier_invoice_id: string
  supplier_invoice_number: string
  invoice_no: string | null
  vendor_name: string | null
  treasury_account_id: string
  account_name: string | null
  amount: number
  method: string
  payment_date: string | null
  reference: string | null
  notes: string | null
  status: PaymentStatus
  prepared_by: string | null
  prepared_by_name: string | null
  approved_by_name: string | null
  approved_at: string | null
  paid_by_name: string | null
  paid_at: string | null
  decision_reason: string | null
  created_at: string
}

export interface PayableInvoice {
  id: string
  invoice_no: string | null
  supplier_invoice_number: string
  vendor_id: string
  vendor_name: string | null
  total_amount: number
  amount_paid: number
  balance_due: number
  due_date: string | null
  settlement_state: string | null
  payment_state: string | null
}

/**
 * Words that say what happened without overstating it.
 *
 * "Confirmed" rather than "Settled by PayMongo": JMAC recorded that the money
 * arrived, having watched its own bank. No payout API is integrated, and a
 * label implying one would be describing a capability the system does not have.
 */
export const SETTLEMENT_STATUS_LABEL: Record<SettlementStatus, string> = {
  draft: 'Draft',
  for_review: 'With the Finance Manager',
  confirmed: 'Confirmed — money received',
  returned: 'Returned for correction',
  rejected: 'Rejected',
}

/**
 * The payment lifecycle, said so nobody confuses authorisation with a transfer.
 *
 * "Approved for payment" is a decision. "Paid" is a fact about the world, and
 * only the Accountant recording the actual bank reference can assert it.
 */
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  draft: 'Draft',
  for_approval: 'With the Finance Manager',
  approved: 'Approved for payment — not yet sent',
  paid: 'Paid',
  returned: 'Returned for correction',
  rejected: 'Rejected',
}

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  cheque: 'Cheque',
  other: 'Other',
}

export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'cheque', 'other'] as const

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABEL[method] ?? method
}

export function settlementKindLabel(kind: SettlementKind): string {
  return kind === 'branch_cash' ? 'Branch cash remittance' : 'Provider settlement'
}

/** What a settlement is moving, in one phrase a reader can scan. */
export function settlementSource(s: CollectionSettlement): string {
  return s.kind === 'branch_cash'
    ? `${s.branch_name ?? 'Branch'} cash`
    : `${saleMethodLabel(s.payment_method ?? '')} collections`
}

/**
 * Said next to every provider settlement figure.
 *
 * PayMongo runs in test mode in this deployment and exposes no payout API, so
 * a settlement here is Finance writing down a transfer it observed, not the
 * system performing one.
 */
export const RECORDED_SETTLEMENT_NOTE =
  'Settlements are recorded from evidence, not fetched from the provider. ' +
  'No payout API is integrated, so Finance enters the reference, date and fee ' +
  'from the settlement advice or bank statement.'

/** Said next to the approved-but-unpaid state, which is easy to misread. */
export const APPROVAL_IS_NOT_PAYMENT_NOTE =
  'Approving authorises the payment. It does not send money — no bank transfer ' +
  'API is connected. The balance falls only when the Accountant records the ' +
  'completed payment with its reference.'

export function formatTreasuryMoney(value: number | null | undefined): string {
  return formatMoney(Number(value ?? 0))
}

/** A movement's effect on a balance, signed for display. */
export function signedAmount(m: TreasuryMovement): string {
  const money = formatMoney(Number(m.amount ?? 0))
  return m.direction === 'in' ? `+${money}` : `−${money}`
}

export function movementSourceLabel(m: TreasuryMovement): string {
  return m.source_type === 'collection_settlement' ? 'Collection settlement' : 'Supplier payment'
}

/** Whether this settlement still belongs to the Accountant. */
export function isSettlementEditable(s: CollectionSettlement): boolean {
  return s.status === 'draft' || s.status === 'returned'
}

/** Whether this payment still belongs to the Accountant. */
export function isPaymentEditable(p: SupplierPayment): boolean {
  return p.status === 'draft' || p.status === 'returned'
}

/**
 * What the signed-in Finance role may do with a payment right now.
 *
 * One place, so the buttons cannot disagree with the database. Every rule here
 * is also enforced server-side; this exists to avoid offering an action that
 * would be refused.
 */
export function paymentActionsFor(
  payment: SupplierPayment,
  role: string | undefined,
  userId: string | undefined
): { canSubmit: boolean; canDecide: boolean; canRecord: boolean } {
  const isAccountant = role === 'accountant'
  const isManager = role === 'finance_manager'
  return {
    canSubmit: isAccountant && (payment.status === 'draft' || payment.status === 'returned'),
    // The preparer never decides their own, checked on identity exactly as the
    // database checks it -- so the button and the answer agree rather than the
    // user discovering the rule from an error.
    canDecide:
      isManager && payment.status === 'for_approval' && payment.prepared_by !== userId,
    // Recording completion is the Accountant's, and only for something the
    // Manager has already authorised.
    canRecord: isAccountant && payment.status === 'approved',
  }
}

/** The same question for a settlement. */
export function settlementActionsFor(
  settlement: CollectionSettlement,
  role: string | undefined,
  userId: string | undefined
): { canSubmit: boolean; canDecide: boolean } {
  return {
    canSubmit:
      role === 'accountant' &&
      (settlement.status === 'draft' || settlement.status === 'returned'),
    canDecide:
      role === 'finance_manager' &&
      settlement.status === 'for_review' &&
      settlement.prepared_by !== userId,
  }
}

export function describeTreasuryError(error: unknown): string {
  const message = errorMessage(error)
  return message || 'That could not be completed. Please try again.'
}
