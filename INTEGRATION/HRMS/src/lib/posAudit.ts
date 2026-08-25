import type { PosAuditEntityType, PosAuditEventType, PosRole, UserRole } from '@/lib/enums'
import type { PosReportRange } from '@/lib/posReports'

/**
 * The POS operational audit stream: the pure parts.
 *
 * Two audiences, two contracts, and the split is decided in the database, not
 * here. `get_pos_manager_audit_events` projects only the manager-safe columns
 * and filters on `manager_visible` in a predicate no parameter can widen;
 * `get_admin_pos_audit_events` returns the administrator columns as well. This
 * file shapes and labels what arrives -- it is not, and must never become, the
 * thing that decides what a manager may see.
 *
 * Nothing here mentions cost, COGS, margin or profit because none of the RPCs
 * declares such a column. `branch_selling_price_changed` is the single
 * intentionally money-bearing manager-safe value in the whole stream, and it is
 * a SELLING price -- what a customer pays.
 */

export const POS_AUDIT_KEY = ['pos-audit'] as const
export const POS_AUDIT_PAGE_SIZE = 25

/** What a manager receives. No description, no admin values, no visibility
 * flag -- those columns are not in the manager RPC's declared result. */
export interface ManagerAuditEvent {
  event_id: string
  occurred_at: string
  business_date: string
  event_type: PosAuditEventType
  entity_type: PosAuditEntityType
  entity_id: string | null
  actor_id: string
  actor_name: string
  branch_id: string | null
  branch_name: string | null
  entity_name: string | null
  old_value: string | null
  new_value: string | null
  total_count: number
}

/** What an Administrator receives: the manager fields, plus the two role
 * snapshots, the visibility flag and the administrator description. */
export interface AdminAuditEvent extends Omit<ManagerAuditEvent, 'old_value' | 'new_value'> {
  actor_enterprise_role: UserRole
  actor_pos_role: PosRole | null
  manager_visible: boolean
  description: string
  old_value: string | null
  new_value: string | null
}

export type AuditSurface = 'manager' | 'admin'

/**
 * Human labels for the taxonomy.
 *
 * Derived from `event_type` at render time rather than read from a stored
 * description, so a manager-visible label physically cannot contain anything a
 * writer improvised into a text column.
 */
export const POS_AUDIT_EVENT_LABEL: Record<PosAuditEventType, string> = {
  fees_changed: 'Fees changed',
  payment_qr_updated: 'Payment QR updated',
  payment_qr_removed: 'Payment QR removed',
  branch_product_added: 'Product added to branch',
  branch_product_removed: 'Product removed from branch',
  branch_selling_price_changed: 'Branch selling price changed',
  product_offered: 'Product offered',
  product_stopped: 'Product stopped',
  low_stock_threshold_changed: 'Low-stock level changed',
  assignment_granted: 'POS access granted',
  assignment_revoked: 'POS access revoked',
  product_created: 'Product created',
  product_updated: 'Product updated',
  product_archived: 'Product archived',
  product_restored: 'Product restored',
  category_created: 'Category created',
  category_updated: 'Category updated',
  category_archived: 'Category archived',
  category_restored: 'Category restored',
  category_reordered: 'Categories reordered',
  category_deleted: 'Category deleted',
  stock_request_created: 'Request submitted',
  stock_request_cancelled: 'Request withdrawn',
  stock_request_approved: 'Request approved',
  stock_request_declined: 'Request declined',
}

export const POS_AUDIT_ENTITY_LABEL: Record<PosAuditEntityType, string> = {
  branch_assignment: 'POS access',
  branch_settings: 'Branch settings',
  product: 'Product',
  category: 'Category',
  branch_product: 'Branch product',
  inventory_threshold: 'Low-stock level',
  inventory_request: 'Inventory request',
}

/** The event types a manager can ever see. Mirrors
 * `pos_audit_is_manager_visible()`; the database remains the authority, and
 * this exists so the manager filter cannot offer a type that would return
 * nothing. */
export const MANAGER_VISIBLE_EVENT_TYPES: PosAuditEventType[] = [
  'fees_changed',
  'payment_qr_updated',
  'payment_qr_removed',
  'branch_product_added',
  'branch_product_removed',
  'branch_selling_price_changed',
  'product_offered',
  'product_stopped',
  'low_stock_threshold_changed',
  // A manager's own request at their own branch. A decision they cannot see is
  // not a decision.
  'stock_request_created',
  'stock_request_cancelled',
  'stock_request_approved',
  'stock_request_declined',
]

export const ALL_EVENT_TYPES = Object.keys(POS_AUDIT_EVENT_LABEL) as PosAuditEventType[]

export function eventTypesFor(surface: AuditSurface): PosAuditEventType[] {
  return surface === 'manager' ? MANAGER_VISIBLE_EVENT_TYPES : ALL_EVENT_TYPES
}

export function eventLabel(type: PosAuditEventType): string {
  return POS_AUDIT_EVENT_LABEL[type] ?? type
}

export function entityLabel(type: PosAuditEntityType): string {
  return POS_AUDIT_ENTITY_LABEL[type] ?? type
}

/** Which branch scope an Administrator is looking at. Global catalogue and
 * access events are not filed under any branch, so they need their own scope
 * rather than being folded into an arbitrary one. */
export type AdminBranchScope = 'all' | 'global' | string

export interface AuditQuery {
  surface: AuditSurface
  branchId?: string
  scope?: AdminBranchScope
  range: PosReportRange | undefined
  eventType?: PosAuditEventType
  actorId?: string
  entityType?: PosAuditEntityType
  page: number
}

export function pageCount(totalCount: number, pageSize = POS_AUDIT_PAGE_SIZE): number {
  if (totalCount <= 0) return 1
  return Math.ceil(totalCount / pageSize)
}

export function offsetFor(page: number, pageSize = POS_AUDIT_PAGE_SIZE): number {
  return Math.max(0, (Math.max(1, page) - 1) * pageSize)
}

/** The window count rides on every row; an empty page has none to read. */
export function totalFrom(rows: { total_count: number }[]): number {
  return rows.length > 0 ? Number(rows[0].total_count) : 0
}

/** A change rendered for a table cell. Either side may legitimately be absent
 * -- a creation has no "before", a removal has no "after". */
export function formatChange(oldValue: string | null, newValue: string | null): string {
  if (oldValue && newValue) return `${oldValue} → ${newValue}`
  if (newValue) return newValue
  if (oldValue) return oldValue
  return '—'
}

/** The time of day, in business time. The date column already carries the
 * business date the server resolved, so this never recomputes a day boundary
 * from the device clock. */
export function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Who acted, and in what capacity. Two snapshots, because a POS role is
 * branch-scoped and an enterprise role is not: an Administrator has no POS
 * role at all, and the same person can be a manager at one branch and a
 * cashier at another. */
export function formatActorRole(
  enterpriseRole: UserRole,
  posRole: PosRole | null | undefined
): string {
  if (enterpriseRole === 'admin') return 'Administrator'
  if (posRole === 'manager') return 'POS Manager'
  if (posRole === 'cashier') return 'Cashier'
  if (enterpriseRole === 'hr_manager') return 'HR Manager'
  if (enterpriseRole === 'hr_staff') return 'HR Staff'
  return 'Employee'
}

export function describeAuditError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message.includes('Sign in')) return 'Your session has expired. Sign in again.'
  if (message.includes('row-level security') || message.includes('permission denied')) {
    return 'You do not manage that branch.'
  }
  return message || 'The audit log could not be loaded.'
}
