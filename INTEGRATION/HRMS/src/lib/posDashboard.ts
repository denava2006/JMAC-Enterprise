import { saleMethodLabel } from '@/lib/posTill'

/**
 * The POS Manager's dashboard: the pure parts.
 *
 * Every figure here is operational. There is no cost, COGS, margin or profit
 * shaping to do, because none of the four dashboard RPCs declares such a
 * column -- the guarantee lives in the signatures, not in this file. What this
 * file does own is the labelling, and that matters more than it looks: the
 * standalone POS put `subtotal` on a card reading "Today's Net Sales" and never
 * showed what the customer actually paid, which understates the day at any
 * branch that charges a fee.
 *
 * So the three money figures are named for exactly what they are, and they
 * reconcile:
 *
 *     Sales Collected  =  Product Sales  +  Customer Fees
 */

export interface DashboardSummary {
  /** The business day the SERVER used, echoed back so the page can label the
   * day it is actually showing rather than the device's idea of today. */
  business_date: string
  /** What the till took, fees included. */
  sales_collected: number
  /** What the goods came to, before fees. */
  product_sales: number
  /** Fees the customer paid on top. */
  fees_collected: number
  transaction_count: number
  /** Units sold, not lines: three of one product on one line counts as three. */
  items_sold: number
  average_sale: number | null
  /** Point-in-time, not day-scoped -- "what is running out right now". */
  low_stock_count: number
  out_of_stock_count: number
}

export interface PaymentTotal {
  payment_method: PaymentMethod
  transaction_count: number
  amount_collected: number
}

export interface TopProduct {
  /** Grouped by the enterprise product, so a mid-period rename cannot split
   * one product into two ranked rows. */
  product_id: string
  /** The most recent sale-item snapshot name. */
  product_name: string
  quantity_sold: number
  sales_amount: number
}

export const RECENT_TRANSACTION_COUNT = 5
export const TOP_PRODUCT_COUNT = 5

export const peso = (value: number) =>
  `₱${Number(value ?? 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

export function paymentMethodLabel(method: string): string {
  return saleMethodLabel(method)
}

/** An empty day still has a shape. Without this the cards would flash `NaN`
 * and `undefined` at a branch that has not sold anything yet today. */
export function emptySummary(businessDate = ''): DashboardSummary {
  return {
    business_date: businessDate,
    sales_collected: 0,
    product_sales: 0,
    fees_collected: 0,
    transaction_count: 0,
    items_sold: 0,
    average_sale: null,
    low_stock_count: 0,
    out_of_stock_count: 0,
  }
}

/** `average_sale` is null on a day with no transactions -- the RPC divides by
 * `nullif(count, 0)` rather than returning a misleading zero. Render the
 * absence as a dash, never as `₱0.00`, which would read as "sales averaged
 * nothing" instead of "there were none". */
export function formatAverageSale(average: number | null | undefined): string {
  if (average === null || average === undefined || !Number.isFinite(Number(average))) return '—'
  return peso(Number(average))
}

/** The three money figures must add up, and the page says so out loud. If this
 * ever returns false the RPC and the labels have drifted apart. */
export function moneyReconciles(summary: DashboardSummary): boolean {
  const collected = Number(summary.sales_collected)
  const parts = Number(summary.product_sales) + Number(summary.fees_collected)
  // Two decimal places of currency; allow for float representation only.
  return Math.abs(collected - parts) < 0.005
}

/** A business date as the page should title it. The string arrives from the
 * database as a plain `YYYY-MM-DD` calendar date with no timezone attached, so
 * it is parsed as local calendar fields -- `new Date('2026-08-25')` would be
 * read as UTC midnight and render as the 24th for anyone west of Greenwich. */
export function formatBusinessDate(iso: string | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/** Today, on the business's calendar rather than the device's.
 *
 * Used only to seed a date input. Nothing computes a dashboard window from it:
 * the client sends either nothing or a plain calendar date, and
 * `pos_day_bounds()` decides what that means. */
export function businessTodayISO(now = new Date()): string {
  // en-CA renders as YYYY-MM-DD, which is the format a <input type="date">
  // and the RPC both want.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now)
}

export function describeDashboardError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message.includes('Sign in')) return 'Your session has expired. Sign in again.'
  if (message.includes('row-level security') || message.includes('permission denied')) {
    return 'You do not manage that branch.'
  }
  return message || "Today's figures could not be loaded."
}
