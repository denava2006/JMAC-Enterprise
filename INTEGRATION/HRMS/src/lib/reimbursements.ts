import { formatMoney } from '@/lib/currency'
import { errorMessage } from '@/lib/errorMessage'

/**
 * Employee reimbursements, and paying them back.
 *
 * The claim itself is a finance_request with type 'reimbursement' — it has
 * been one since F3, which is why there is no second table and therefore no
 * second budget reservation. What F7 adds is the settlement half, and this
 * module holds the words for it.
 *
 * Two states, kept apart on purpose. The workflow status is what Finance
 * decided about the claim; the settlement state is what has happened to the
 * money since. Paying a claim does not un-approve it, so the status stays
 * 'approved' for ever and the label is derived.
 */

export const REIMBURSEMENT_KEY = ['reimbursements'] as const
export const REIMBURSEMENT_PAYMENT_KEY = ['reimbursement-payments'] as const

export interface Reimbursement {
  id: string
  request_no: string | null
  title: string
  description: string | null
  justification: string | null
  requester_id: string
  requester_name: string | null
  finance_category_id: string | null
  finance_category_name: string | null
  budget_id: string | null
  budget_name: string | null
  amount: number
  expense_date: string | null
  needed_by: string | null
  priority: string
  status: string
  amount_paid: number
  balance_due: number
  pending_payment_amount: number
  available_to_prepare: number
  settlement_state: string | null
  created_at: string
  updated_at: string
}

export type ReimbursementPaymentStatus =
  | 'draft'
  | 'for_approval'
  | 'approved'
  | 'paid'
  | 'returned'
  | 'rejected'

export interface ReimbursementPayment {
  id: string
  payment_no: string | null
  finance_request_id: string
  request_no: string | null
  requester_name: string | null
  treasury_account_id: string
  account_name: string | null
  amount: number
  method: string
  payment_date: string | null
  reference: string | null
  notes: string | null
  status: ReimbursementPaymentStatus
  prepared_by: string | null
  prepared_by_name: string | null
  approved_by_name: string | null
  approved_at: string | null
  paid_by_name: string | null
  paid_at: string | null
  decision_reason: string | null
  created_at: string
}

/**
 * The workflow states a claim moves through, in the words the employee filed
 * it under. These come from finance_requests and are not F7's to rename.
 */
export const REIMBURSEMENT_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending_validation: 'Submitted — with Finance',
  pending_approval: 'With the Finance Manager',
  approved: 'Approved — awaiting payment',
  completed: 'Completed',
  returned: 'Returned for correction',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
}

/**
 * What to call a claim once money has moved against it.
 *
 * The same shape as the supplier invoice label from F6, and for the same
 * reason: "Approved — awaiting payment" on a claim that has been paid in full
 * is simply wrong on the screen, but the workflow status is not the place to
 * fix that. No second mutable column — another one to keep in step is another
 * one to disagree.
 */
export function reimbursementStateLabel(r: {
  status?: string | null
  amount_paid?: number | string | null
  balance_due?: number | string | null
}): string {
  const paid = Number(r.amount_paid ?? 0)
  const balance = Number(r.balance_due ?? 0)

  if (r.status !== 'approved') {
    return REIMBURSEMENT_STATUS_LABEL[r.status ?? ''] ?? (r.status ?? '')
  }
  if (paid > 0 && balance <= 0) return 'Paid'
  if (paid > 0) return 'Partially paid'
  return 'Approved — awaiting payment'
}

export const PAYMENT_STATUS_LABEL: Record<ReimbursementPaymentStatus, string> = {
  draft: 'Draft',
  for_approval: 'With the Finance Manager',
  approved: 'Approved for payment — not yet sent',
  paid: 'Paid',
  returned: 'Returned for correction',
  rejected: 'Rejected',
}

/**
 * What this Finance role may do with a claim in this state.
 *
 * Every rule is also enforced in the database; this exists so a user is not
 * offered an action that is about to be refused. The Finance Manager reviews
 * and never edits — a checker who can correct the claim while approving it is
 * approving their own correction.
 */
export function reimbursementActionsFor(
  role: string | undefined,
  status: string | undefined,
  settled: { amountPaid: number; pending: number } = { amountPaid: 0, pending: 0 }
): Array<{ to: string; label: string; tone: 'default' | 'outline' | 'destructive' }> {
  if (role === 'finance_staff' && status === 'pending_validation') {
    return [
      { to: 'pending_approval', label: 'Forward for approval', tone: 'default' },
      { to: 'returned', label: 'Return for correction', tone: 'outline' },
      { to: 'rejected', label: 'Reject', tone: 'destructive' },
    ]
  }
  if (role === 'finance_manager') {
    if (status === 'pending_approval') {
      return [
        { to: 'approved', label: 'Approve', tone: 'default' },
        { to: 'returned', label: 'Return for correction', tone: 'outline' },
        { to: 'rejected', label: 'Reject', tone: 'destructive' },
      ]
    }
    if (status === 'approved') {
      // Withdrawing an approved claim releases its budget reservation. Once
      // money is paid or promised there is nothing to release — F7 has no
      // reversal — so the action is withdrawn rather than shown failing.
      if (settled.amountPaid > 0 || settled.pending > 0) return []
      return [{ to: 'rejected', label: 'Withdraw approval', tone: 'destructive' }]
    }
  }
  return []
}

/** Whether another payment may still be prepared against this claim. */
export function canPrepareReimbursementPayment(
  r: { status?: string | null; available_to_prepare?: number | string | null },
  role: string | undefined
): boolean {
  return role === 'accountant' && r.status === 'approved' && Number(r.available_to_prepare ?? 0) > 0
}

/**
 * What this invoice could still take for THIS payment.
 *
 * The payment's own amount is excluded, exactly as the server excludes it.
 * Counting a payment against itself would refuse every resubmission there is.
 */
export function roomForPayment(
  payment: ReimbursementPayment,
  siblings: ReimbursementPayment[],
  balanceDue: number
): number {
  const claimed = siblings
    .filter((o) => o.id !== payment.id && ['draft', 'for_approval', 'approved'].includes(o.status))
    .reduce((sum, o) => sum + Number(o.amount ?? 0), 0)
  return Math.max(balanceDue - claimed, 0)
}

export function paymentActionsFor(
  payment: ReimbursementPayment,
  role: string | undefined,
  userId: string | undefined,
  availableForThis?: number
): { canSubmit: boolean; canDecide: boolean; canRecord: boolean } {
  const isAccountant = role === 'accountant'
  const fits = availableForThis === undefined || Number(payment.amount) <= availableForThis
  return {
    canSubmit:
      isAccountant && (payment.status === 'draft' || payment.status === 'returned') && fits,
    // Identity, not role: somebody promoted overnight still cannot approve
    // what they prepared yesterday.
    canDecide:
      role === 'finance_manager' &&
      payment.status === 'for_approval' &&
      payment.prepared_by !== userId,
    canRecord: isAccountant && payment.status === 'approved',
  }
}

export interface NextStep {
  /** The role that owns the next move, named the way JMAC names roles. */
  actor: string
  /** What they do, completing the sentence "Next step: {actor} {description}". */
  description: string
}

/**
 * Who has the claim next, and what they do with it.
 *
 * F7 acceptance approved RB-2026-0001 and was left with "Approved — awaiting
 * payment" and "Available to prepare ₱1,000" — true, and silent about who does
 * the preparing. The status says what has happened; this says what happens
 * next, which is a different question and was not being answered anywhere.
 *
 * Derived, never stored. A second column recording whose turn it is would be
 * one more thing to disagree with the status, and this has no authority of its
 * own: every move it names is one transition_finance_request or
 * transition_reimbursement_payment already refuses to anybody else.
 *
 * For an approved claim the answer is not always the Accountant, which is why
 * the payments are read rather than assumed. A payment sitting for_approval is
 * the Finance Manager's, and an authorised one waiting to be sent is the
 * Accountant's again — saying "Accountant prepares the payment" while one is
 * already on the Manager's desk would be worse than saying nothing.
 */
export function nextStepFor(
  claim: {
    status?: string | null
    balance_due?: number | string | null
    available_to_prepare?: number | string | null
  },
  payments: Array<{ status: ReimbursementPaymentStatus }> = []
): NextStep | null {
  switch (claim.status) {
    case 'draft':
      return { actor: 'The employee', description: 'submits the claim to Finance.' }
    case 'returned':
      return { actor: 'The employee', description: 'corrects the claim and resubmits it.' }
    case 'pending_validation':
      return {
        actor: 'Finance Staff',
        description: 'check the claim and charge it to a budget.',
      }
    case 'pending_approval':
      return {
        actor: 'The Finance Manager',
        description: 'approves the claim or returns it for correction.',
      }
    case 'approved':
      break
    default:
      // completed, rejected, cancelled — nobody is waiting on anybody.
      return null
  }

  // An approved claim, in the order the money actually moves.
  const held = (status: ReimbursementPaymentStatus) => payments.some((p) => p.status === status)

  if (held('for_approval')) {
    return { actor: 'The Finance Manager', description: 'approves the prepared payment.' }
  }
  if (held('approved')) {
    return {
      actor: 'The Accountant',
      description: 'records the completed payment with its reference.',
    }
  }
  if (held('draft') || held('returned')) {
    return {
      actor: 'The Accountant',
      description: 'submits the prepared payment for approval.',
    }
  }
  if (Number(claim.available_to_prepare ?? 0) > 0) {
    return { actor: 'The Accountant', description: 'prepares the reimbursement payment.' }
  }
  // Nothing left to prepare and nothing in flight: the claim is settled.
  return null
}

export const APPROVAL_IS_NOT_PAYMENT_NOTE =
  'Approving authorises the payment. It does not send money — no bank transfer ' +
  'API is connected. The reimbursement balance falls only when the Accountant ' +
  'records the completed payment with its reference.'

export function formatReimbursementMoney(value: number | null | undefined): string {
  return formatMoney(Number(value ?? 0))
}

export function describeReimbursementError(error: unknown): string {
  const message = errorMessage(error)
  return message || 'That could not be completed. Please try again.'
}
