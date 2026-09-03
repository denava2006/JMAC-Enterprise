import { formatMoney } from '@/lib/currency'
import { errorMessage } from '@/lib/errorMessage'
import { LEGACY_PAYMENT_METHODS, saleMethodLabel } from '@/lib/posTill'

/**
 * What Finance is allowed to say about POS sales, and in whose words.
 *
 * POS owns the sale. This module owns none of the arithmetic -- every figure
 * below arrives from the database already computed, using the same expressions
 * the POS reports use. Nothing here adds, subtracts or re-derives a total,
 * because a second implementation of "net sales" in TypeScript is exactly how
 * two screens in one company end up disagreeing about a day's takings.
 *
 * The vocabulary, and why it is not the vocabulary a finance textbook would
 * reach for first:
 *
 *   Gross Sales   sum(subtotal)      what the goods came to
 *   Discounts     always 0           POS has no discount model
 *   Refunds       always 0           POS has no void or refund path
 *   Net Sales     = Gross - the two  so, today, identical to Gross
 *   Fees          sum(fees_total)    ADDED to what the customer pays
 *   Collected     sum(total_amount)  what actually crossed the counter
 *
 * Discounts and refunds are shown rather than hidden, and labelled as not
 * modelled rather than as zero. A row reading a confident "₱0.00" invites the
 * reader to conclude nobody was refunded this month; the truth is that the
 * question cannot be asked of this POS yet.
 */

export const FINANCE_SALES_KEY = ['finance-sales'] as const

/** How many transactions one page of the drill-down asks for. */
export const FINANCE_SALES_PAGE_SIZE = 25

export interface FinanceSalesFilters {
  dateFrom: string
  dateTo: string
  branchId: string | null
  paymentMethod: string | null
  cashierId: string | null
}

export interface FinanceSalesSummary {
  date_from: string
  date_to: string
  gross_sales: number
  discounts: number
  refunds: number
  net_sales: number
  fees_collected: number
  total_collected: number
  transaction_count: number
  items_sold: number
  average_sale: number | null
}

export interface FinanceSalesCollection {
  payment_method: string
  transaction_count: number
  /** sum(total_amount) for the method: collected from the customer. */
  amount_collected: number
}

export interface FinanceSalesTransaction {
  sale_id: string
  sold_at: string
  branch_id: string
  branch_name: string
  cashier_id: string
  cashier_name: string
  payment_method: string
  payment_reference: string | null
  item_count: number
  gross_sales: number
  discounts: number
  refunds: number
  net_sales: number
  fees_total: number
  total_collected: number
  total_rows: number
}

export interface FinanceSalesFilterOption {
  kind: 'branch' | 'cashier'
  id: string
  label: string
}

/**
 * Which methods settle to a bank on their own schedule, and which arrive as
 * cash in a drawer.
 *
 * The distinction matters more than it looks. A card sale is revenue the
 * moment POS records it, but the money is with PayMongo, not with JMAC -- less
 * whatever the provider keeps. Cash is already in the branch. Labelling both
 * "collected" without saying which is which is how a business talks itself
 * into believing its bank balance is larger than it is.
 */
export function isProviderSettled(method: string): boolean {
  return method !== 'cash'
}

/** Cash actually in a drawer, across the methods in the range. */
export function cashCollected(rows: FinanceSalesCollection[]): number {
  return rows
    .filter((r) => !isProviderSettled(r.payment_method))
    .reduce((sum, r) => sum + Number(r.amount_collected ?? 0), 0)
}

/** Customer money held by a payment provider, not yet in any JMAC account. */
export function providerCollected(rows: FinanceSalesCollection[]): number {
  return rows
    .filter((r) => isProviderSettled(r.payment_method))
    .reduce((sum, r) => sum + Number(r.amount_collected ?? 0), 0)
}

/**
 * The methods a Finance filter offers.
 *
 * LEGACY_PAYMENT_METHODS is the same list the pos_sales payment_method CHECK
 * constraint enforces, so Finance can filter for anything the data can hold --
 * including 'maya', which predates PayMongo's 'paymaya' and still appears on
 * historical sales. Defining a second list here would quietly drop a method the
 * day POS adds one.
 */
export const FINANCE_SALES_METHODS = LEGACY_PAYMENT_METHODS

export function financeSalesMethodLabel(method: string): string {
  return saleMethodLabel(method)
}

/**
 * What the payment-method figure does and does not claim.
 *
 * Shown next to the collections breakdown. PayMongo settlement is not
 * integrated, so no label on this page may say deposited, settled or received
 * by the bank -- because nothing in this database knows whether it was.
 */
export const SETTLEMENT_DISCLOSURE =
  'Collected from customers. Card and e-wallet payments are confirmed by the ' +
  'provider but are not yet settled to a JMAC bank account, and provider fees ' +
  'are not deducted here. Settlement and payout data are not integrated.'

/** Why the discount and refund figures read as they do. */
export const NOT_MODELLED_NOTE =
  'The POS records no discounts and has no void or refund path, so these are ' +
  'structurally zero rather than measured. A reversal would have to originate ' +
  'in POS before Finance could report it.'

export function formatFinanceSalesMoney(value: number | null | undefined): string {
  return formatMoney(Number(value ?? 0))
}

export function formatFinanceSalesCount(value: number | null | undefined): string {
  return new Intl.NumberFormat('en-PH').format(Number(value ?? 0))
}

/**
 * The time a sale was rung up, in Philippine business time.
 *
 * Explicit rather than left to the browser: a Finance user opening this from
 * outside the country must see the same clock the branch did, or the row will
 * not agree with the receipt in the shop.
 */
export function formatSaleTimestamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at)
}

/** The short reference a Finance user reconciles against a receipt. */
export function saleReference(row: FinanceSalesTransaction): string {
  return row.payment_reference?.trim() || row.sale_id.slice(0, 8).toUpperCase()
}

export function describeFinanceSalesError(error: unknown): string {
  const message = errorMessage(error)
  return message || 'Sales could not be loaded. Please try again.'
}
