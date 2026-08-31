import type { Enums } from '@/lib/database.types'
import { saleMethodLabel } from '@/lib/posTill'

/**
 * Transaction history: the pure parts.
 *
 * Which sales somebody may see is decided entirely in the database --
 * `get_my_transactions` takes no cashier parameter, `get_branch_transactions`
 * checks `has_pos_role(branch, ['manager'])`, and `get_admin_transactions`
 * checks `is_admin()`. Nothing here is a filter that grants access; the scope
 * below only decides which of those three functions to call.
 */

export type SaleStatus = Enums<'pos_sale_status'>

export const SALE_STATUS_LABEL: Record<SaleStatus, string> = {
  completed: 'Completed',
}

/** Which read path a screen is using. Not an authorization claim -- the
 * database re-decides on every call. */
export type TransactionScope = 'mine' | 'branch' | 'admin'

export interface TransactionRow {
  sale_id: string
  created_at: string
  status: SaleStatus
  branch_id: string
  branch_name: string
  cashier_name: string
  /** Units sold, not lines on the sale: two of one product counts as two. */
  item_count: number
  subtotal: number
  fees_total: number
  total_amount: number
  payment_method: PaymentMethod
  payment_reference: string | null
  amount_tendered: number | null
  change_given: number | null
  total_count: number
}

export const PAGE_SIZE = 25

/** Mirrors public.pos_page_size(): the server clamps, and so does the client,
 * so a hand-edited request cannot ask for the whole table. */
export function clampPageSize(requested: number): number {
  if (!Number.isFinite(requested)) return PAGE_SIZE
  return Math.max(1, Math.min(Math.trunc(requested), 100))
}

export function pageCount(totalCount: number, pageSize = PAGE_SIZE): number {
  if (totalCount <= 0) return 1
  return Math.ceil(totalCount / pageSize)
}

export function offsetFor(page: number, pageSize = PAGE_SIZE): number {
  return Math.max(0, (Math.max(1, page) - 1) * pageSize)
}

/** The count comes back on every row (a window function), so an empty page
 * legitimately has no rows to read it from. */
export function totalFrom(rows: TransactionRow[]): number {
  return rows.length > 0 ? Number(rows[0].total_count) : 0
}

export interface DateRange {
  from: string
  to: string
}

/**
 * Turns the two date inputs into the timestamps the RPC expects.
 *
 * `to` is pushed to the end of its day: a cashier choosing "today to today"
 * means the whole of today, not the instant midnight passed.
 */
export function toTimestampRange(range: DateRange): { from: string | null; to: string | null } {
  const from = range.from ? new Date(`${range.from}T00:00:00`).toISOString() : null
  const to = range.to ? new Date(`${range.to}T23:59:59.999`).toISOString() : null
  return { from, to }
}

export function summarise(rows: TransactionRow[]): { sales: number; units: number; taken: number } {
  return {
    sales: rows.length,
    units: rows.reduce((sum, r) => sum + r.item_count, 0),
    taken: rows.reduce((sum, r) => sum + Number(r.total_amount), 0),
  }
}

export function paymentLabel(method: PaymentMethod): string {
  return saleMethodLabel(method)
}

export function describeTransactionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')

  if (message.includes('That receipt is not available')) {
    // The RPC gives the same answer for "does not exist" and "not yours", so a
    // probe cannot tell them apart. Say the same thing here.
    return 'That receipt is not available.'
  }
  if (message.includes('Sign in')) return 'Your session has expired. Sign in again.'
  if (message.includes('row-level security') || message.includes('permission denied')) {
    return 'You do not have access to those transactions.'
  }
  return message || 'Those transactions could not be loaded.'
}

export const peso = (value: number) =>
  `₱${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
