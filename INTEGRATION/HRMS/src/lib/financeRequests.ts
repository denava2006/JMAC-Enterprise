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

/**
 * Whether this person may still correct this request themselves.
 *
 * Draft only, which is narrower than the amend policy that has covered draft
 * and returned since F3. Those are different acts: correcting something nobody
 * has read yet, and answering a reviewer who sent it back with remarks. The
 * second wants the remarks in front of it and a Resubmit at the end, so it gets
 * its own treatment when it is built rather than being quietly absorbed here.
 *
 * Not authorization. update_finance_request_draft decides that, and decides it
 * again for anyone who never loads this page. This is what to offer, so that a
 * button is never shown that is about to come back refused.
 */
export function canEditDraft(
  request: { status: RequestStatus; requester_id: string },
  viewerId: string | null | undefined,
): boolean {
  return !!viewerId && request.requester_id === viewerId && request.status === 'draft'
}

/**
 * SQLSTATEs update_finance_request_draft raises on purpose.
 *
 * P0001 is PL/pgSQL's default for a bare RAISE, and the other three are the
 * ones the function names explicitly. A code outside this set did not come
 * from a RAISE anybody wrote -- it came from the engine.
 */
const AUTHORED_CODES = new Set([
  '42501', // insufficient_privilege -- who may edit, and in what state
  '23514', // check_violation -- the validation rules, and the staleness guard
  'P0002', // no_data_found -- the request is gone
  'P0001', // raise_exception -- a RAISE with no errcode
])

/**
 * Phrases that only ever appear in something Postgres wrote about itself.
 *
 * A code alone is not enough: 23514 is both the function's own validation
 * failures and a table constraint tripping, and the second arrives naming the
 * constraint and the relation. So the text is checked too, and a message
 * carrying any of these is a message about the schema rather than about the
 * claim.
 */
const INTERNAL_SIGNATURES = [
  'numeric field overflow',
  'value overflows numeric format',
  'violates check constraint',
  'violates foreign key constraint',
  'violates not-null constraint',
  'violates unique constraint',
  'duplicate key value',
  'row-level security',
  'permission denied',
  'invalid input syntax',
  'value too long for type',
  'out of range',
  'null value in column',
  'does not exist',
  'relation "',
  'column "',
  'constraint "',
  'table "',
]

/**
 * What went wrong, in the database's own words -- when those words were meant
 * for a reader.
 *
 * Everything update_finance_request_draft raises is already a sentence written
 * for the person reading it: who owns the request, what state it is in, which
 * field is wrong. The generic finance mapper would replace the 42501 ones with
 * "Your finance role does not cover that action", which is both unhelpful and
 * untrue -- an employee correcting their own claim has no finance role at all.
 *
 * What must not pass through is the other kind. An amount too large for
 * numeric(14,2) came back as "numeric field overflow"; a tripped constraint
 * comes back naming the table and the constraint. Neither says anything a
 * claimant can act on, and both describe the schema to whoever asked. So a
 * refusal is passed on only when it carries a code the function raises
 * deliberately and reads like prose rather than like a catalogue entry.
 */
export function describeRequestEditError(error: unknown): string {
  const err = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown } | null
  const message = typeof err?.message === 'string' ? err.message.trim() : ''
  if (!message) return 'That change could not be saved.'

  // An error that names a code must name one of ours. An error with no code at
  // all -- a thrown Error, a rejected string -- is judged on its words alone.
  if (typeof err?.code === 'string' && err.code && !AUTHORED_CODES.has(err.code)) {
    return 'That change could not be saved.'
  }

  // Checked across every field the error carries: PostgREST puts the readable
  // half of a constraint failure in `details` as often as in `message`.
  const carried = [err?.message, err?.details, err?.hint]
    .filter((field): field is string => typeof field === 'string')
    .join(' ')
    .toLowerCase()
  if (INTERNAL_SIGNATURES.some((phrase) => carried.includes(phrase))) {
    return 'That change could not be saved.'
  }

  return message
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
