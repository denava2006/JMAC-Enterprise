import type { PosRequestStatus, PosRequestType, UserRole } from '@/lib/enums'
import { errorMessage } from '@/lib/errorMessage'

/**
 * POS inventory and product requests: the pure parts.
 *
 * A request is a **demand signal** — "this branch needs more of X", or "this
 * branch should carry X". It is not a purchase, an order, or a receipt.
 *
 *     approved  =  this branch demand is legitimate and may proceed to
 *                  procurement
 *
 *     approved  ≠  budget approved
 *               ≠  vendor selected
 *               ≠  purchase authorized
 *               ≠  stock received
 *
 * POS request review and FMS procurement approval are two different business
 * decisions. Nothing in this file, and no column behind it, carries an amount,
 * a vendor, a budget or a cost — those belong to FMS, and a contract test
 * asserts their absence on the table.
 */

export const POS_REQUESTS_KEY = ['pos-requests'] as const
export const POS_REQUEST_PAGE_SIZE = 25
export const POS_REQUEST_MIN_QUANTITY = 1
export const POS_REQUEST_MAX_QUANTITY = 100000
export const POS_REQUEST_MAX_REASON = 500

/** What a manager sees about their own branch's requests. */
export interface ManagerRequest {
  request_id: string
  branch_id: string
  branch_name: string
  product_id: string
  product_name: string
  request_type: PosRequestType
  requested_quantity: number | null
  reason: string
  status: PosRequestStatus
  requested_by: string
  requester_name: string
  requested_at: string
  reviewer_name: string | null
  reviewed_at: string | null
  review_note: string | null
  total_count: number
}

/** What a reviewer sees. Adds the requester's enterprise role and `can_review`,
 * which the database computes with the same predicate the write path uses — so
 * the interface cannot offer a button the RPC would refuse. */
export interface QueuedRequest extends ManagerRequest {
  requester_enterprise_role: UserRole | null
  can_review: boolean
}

export const REQUEST_TYPE_LABEL: Record<PosRequestType, string> = {
  restock: 'Restock',
  carry_existing_product: 'Start carrying',
  new_product: 'New product',
}

export const REQUEST_TYPE_DESCRIPTION: Record<PosRequestType, string> = {
  restock: 'More of a product this branch already carries.',
  carry_existing_product: 'A product the business sells that this branch does not stock yet.',
  // A proposal. Approving it creates the product and lists it here at zero
  // stock -- it does not stock it.
  new_product: 'A product the business does not sell yet, proposed by this branch.',
}

export const REQUEST_STATUS_LABEL: Record<PosRequestStatus, string> = {
  pending: 'Awaiting review',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Withdrawn',
}

export const REQUEST_STATUS_VARIANT: Record<PosRequestStatus, string> = {
  pending: 'warning',
  approved: 'success',
  declined: 'destructive',
  cancelled: 'secondary',
}

/** What an approval actually granted, said plainly. Shown next to an approved
 * restock so nobody reads it as "the stock is on its way". */
export function approvalMeaning(type: PosRequestType): string {
  return type === 'restock'
    ? 'Cleared to proceed to procurement. No stock has been ordered or received.'
    : 'The branch may now carry this product. It is not offered until you switch it on, and it has no stock until it is received.'
}

export function requestTypeLabel(type: PosRequestType): string {
  return REQUEST_TYPE_LABEL[type] ?? type
}

export function requestStatusLabel(status: PosRequestStatus): string {
  return REQUEST_STATUS_LABEL[status] ?? status
}

/** Only a pending request can still be acted on by its author. */
export function isCancellable(request: ManagerRequest, viewerId: string | undefined): boolean {
  return request.status === 'pending' && !!viewerId && request.requested_by === viewerId
}

export function pageCount(totalCount: number, pageSize = POS_REQUEST_PAGE_SIZE): number {
  if (totalCount <= 0) return 1
  return Math.ceil(totalCount / pageSize)
}

export function offsetFor(page: number, pageSize = POS_REQUEST_PAGE_SIZE): number {
  return Math.max(0, (Math.max(1, page) - 1) * pageSize)
}

export function totalFrom(rows: { total_count: number }[]): number {
  return rows.length > 0 ? Number(rows[0].total_count) : 0
}

/** Mirrors the database's own bounds, so an impossible request is refused
 * before it costs a round trip. The database refuses it regardless. */
export function validateRequest(input: {
  type: PosRequestType
  quantity: string
  reason: string
}): string | null {
  if (!input.reason.trim()) return 'Say why this branch needs it.'
  if (input.reason.trim().length > POS_REQUEST_MAX_REASON) {
    return `Keep the reason under ${POS_REQUEST_MAX_REASON} characters.`
  }
  if (input.type !== 'restock') return null

  const quantity = Number(input.quantity)
  if (!Number.isInteger(quantity)) return 'Enter a whole number of units.'
  if (quantity < POS_REQUEST_MIN_QUANTITY || quantity > POS_REQUEST_MAX_QUANTITY) {
    return `Quantity must be between ${POS_REQUEST_MIN_QUANTITY} and ${POS_REQUEST_MAX_QUANTITY.toLocaleString()}.`
  }
  return null
}

export function describeRequestError(error: unknown): string {
  const message = errorMessage(error)
  if (message.includes('already an open request')) {
    return 'There is already an open request for this product at this branch.'
  }
  if (message.includes('already been reviewed')) {
    return 'Somebody has already decided this one. Refresh to see the outcome.'
  }
  if (message.includes('does not carry that product')) {
    return 'This branch does not carry that product yet — ask for it to be carried first.'
  }
  if (message.includes('already carries that product')) {
    return 'This branch already carries that product — ask for a restock instead.'
  }
  if (message.includes('submitted yourself')) {
    return 'You cannot review a request you submitted yourself.'
  }
  if (message.includes('do not manage that branch')) return 'You do not manage that branch.'
  if (message.includes('Sign in')) return 'Your session has expired. Sign in again.'
  return message || 'That request could not be completed.'
}
