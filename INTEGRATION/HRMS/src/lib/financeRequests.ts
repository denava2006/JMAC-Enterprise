import type { Database } from './database.types'

type UserRole = Database['public']['Enums']['user_role']

export type RequestStatus =
  | 'draft'
  | 'pending_validation'
  | 'pending_approval'
  | 'approved'
  | 'completed'
  | 'returned'
  | 'rejected'
  | 'cancelled'

export type RequestType = 'purchase' | 'reimbursement'

export const REQUEST_TYPE_LABEL: Record<RequestType, string> = {
  purchase: 'Purchase',
  reimbursement: 'Reimbursement',
}

/** Written for the person waiting on it, not for the table it lives in. */
export const STATUS_LABEL: Record<RequestStatus, string> = {
  draft: 'Draft',
  pending_validation: 'With Finance Staff',
  pending_approval: 'With the Finance Manager',
  approved: 'Approved',
  completed: 'Settled',
  returned: 'Returned to you',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
}

export const STATUS_TONE: Record<RequestStatus, 'neutral' | 'active' | 'good' | 'bad'> = {
  draft: 'neutral',
  pending_validation: 'active',
  pending_approval: 'active',
  approved: 'good',
  completed: 'good',
  returned: 'bad',
  rejected: 'bad',
  cancelled: 'neutral',
}

/** Statuses whose substance the requester may still change. */
export const EDITABLE_STATUSES: RequestStatus[] = ['draft', 'returned']

export function isEditable(status: RequestStatus): boolean {
  return EDITABLE_STATUSES.includes(status)
}

export function isOpen(status: RequestStatus): boolean {
  return ['draft', 'pending_validation', 'pending_approval', 'approved', 'returned'].includes(status)
}

/**
 * What an approved request is actually waiting for.
 *
 * Approval is authorization, not the thing itself: a purchase request becomes
 * authority to procure, a reimbursement becomes authority to pay. Neither has
 * happened, and neither can happen in this phase, so the label says what is
 * still owed rather than implying it is done.
 */
export function statusLabel(status: RequestStatus, type: RequestType): string {
  if (status !== 'approved') return STATUS_LABEL[status]
  return type === 'reimbursement' ? 'Approved — awaiting payment' : 'Approved — awaiting procurement'
}

export interface RequestAction {
  to: RequestStatus
  label: string
  tone: 'primary' | 'secondary' | 'destructive'
  /** Returning or rejecting without saying why wastes everybody's next hour. */
  requiresRemarks?: boolean
}

/**
 * What this person may do to this request, right now.
 *
 * A mirror of the transition table in transition_finance_request — the database
 * is what enforces it, and this is what stops the UI offering a button that
 * would come back refused. The two are kept deliberately identical in shape so
 * a change to one is obviously a change to the other.
 *
 * The Administrator appears in no branch. They read the chain and its history
 * and move nothing through it.
 */
export function actionsFor(
  role: UserRole | null | undefined,
  request: { status: RequestStatus; requester_id: string },
  viewerId: string | null | undefined,
): RequestAction[] {
  if (!role || !viewerId) return []
  const owner = request.requester_id === viewerId
  const { status } = request

  if (owner) {
    if (status === 'draft') {
      return [
        { to: 'pending_validation', label: 'Submit', tone: 'primary' },
        { to: 'cancelled', label: 'Cancel request', tone: 'destructive' },
      ]
    }
    if (status === 'returned') {
      return [
        { to: 'pending_validation', label: 'Resubmit', tone: 'primary' },
        { to: 'cancelled', label: 'Cancel request', tone: 'destructive' },
      ]
    }
    // A finance officer who raised the request is a requester like anyone else:
    // the next step belongs to somebody who did not ask for the money.
    return []
  }

  if (role === 'finance_staff' && status === 'pending_validation') {
    return [
      { to: 'pending_approval', label: 'Validate', tone: 'primary' },
      { to: 'returned', label: 'Return for revision', tone: 'secondary', requiresRemarks: true },
      { to: 'rejected', label: 'Reject', tone: 'destructive', requiresRemarks: true },
    ]
  }

  if (role === 'finance_manager' && status === 'pending_approval') {
    return [
      { to: 'approved', label: 'Approve', tone: 'primary' },
      { to: 'returned', label: 'Return for revision', tone: 'secondary', requiresRemarks: true },
      { to: 'rejected', label: 'Reject', tone: 'destructive', requiresRemarks: true },
    ]
  }

  // Withdrawing an approval before anything has been procured or paid. Without
  // it, an approved request that turns out to be unnecessary would hold budget
  // indefinitely, because nothing in this phase can conclude it.
  if (role === 'finance_manager' && status === 'approved') {
    return [
      { to: 'returned', label: 'Return for revision', tone: 'secondary', requiresRemarks: true },
      { to: 'rejected', label: 'Withdraw approval', tone: 'destructive', requiresRemarks: true },
    ]
  }

  // The Accountant's pre-settlement check. There is no "pay" here: nothing in
  // JMAC can settle a request yet, and a button that recorded a payment would
  // be recording something that did not happen.
  if (role === 'accountant' && status === 'approved') {
    return [
      { to: 'returned', label: 'Return for revision', tone: 'secondary', requiresRemarks: true },
    ]
  }

  return []
}

/** The queue a finance role is responsible for clearing. */
export function inboxStatusFor(role: UserRole | null | undefined): RequestStatus | null {
  if (role === 'finance_staff') return 'pending_validation'
  if (role === 'finance_manager') return 'pending_approval'
  if (role === 'accountant') return 'approved'
  return null
}

export const APPROVAL_ACTION_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  resubmitted: 'Resubmitted',
  validated: 'Validated',
  approved: 'Approved',
  paid: 'Settled',
  returned: 'Returned for revision',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
}
