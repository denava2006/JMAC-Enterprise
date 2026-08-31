import { formatMoney } from '@/lib/currency'
import { saleMethodLabel } from '@/lib/posTill'

export const POS_REPORTS_KEY = ['pos-reports'] as const
export const POS_REPORT_MAX_DAYS = 366
export const POS_REPORT_TOP_PRODUCT_LIMIT = 10

export const POS_REPORT_PRESET_KEYS = [
  'today',
  'yesterday',
  'last_7_days',
  'month_to_date',
  'year_to_date',
] as const

export type PosReportPresetKey = (typeof POS_REPORT_PRESET_KEYS)[number]
export type PosReportRangeKind = PosReportPresetKey | 'custom'

export interface PosReportPreset {
  preset: string
  date_from: string
  date_to: string
  sort_order: number
}

export interface PosReportRange {
  dateFrom: string
  dateTo: string
  kind: PosReportRangeKind
}

export interface PosManagerReportSummary {
  date_from: string
  date_to: string
  sales_collected: number
  product_sales: number
  fees_collected: number
  transaction_count: number
  items_sold: number
  average_sale: number | null
}

export interface PosManagerReportTrend {
  business_date: string
  sales_collected: number
  product_sales: number
  fees_collected: number
  transaction_count: number
  items_sold: number
}

export interface PosReportPaymentTotal {
  payment_method: string
  transaction_count: number
  /** SUM(total_amount): the full amount collected from customers. */
  amount_collected: number
}

export interface PosReportTopProduct {
  /** Ranking identity. Product renames never create another row. */
  product_id: string
  /** Most recent historical line-item name snapshot in the selected range. */
  product_name: string
  quantity_sold: number
  /** SUM(historical line_total), not the product's current selling price. */
  sales_amount: number
}

export interface AdminPosReportSummary extends PosManagerReportSummary {
  total_cogs: number
  gross_product_profit: number
  gross_product_margin: number | null
}

export interface AdminPosReportTrend extends PosManagerReportTrend {
  total_cogs: number
  gross_product_profit: number
  gross_product_margin: number | null
}

export interface AdminPosBranchComparison {
  /** Aggregation identity. Duplicate or renamed branch names cannot merge rows. */
  branch_id: string
  branch_name: string
  branch_is_active: boolean
  sales_collected: number
  product_sales: number
  fees_collected: number
  total_cogs: number
  gross_product_profit: number
  gross_product_margin: number | null
  transaction_count: number
  items_sold: number
  average_sale: number | null
}

export const POS_REPORT_PRESET_LABEL: Record<PosReportPresetKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_7_days: 'Last 7 Days',
  month_to_date: 'MTD',
  year_to_date: 'YTD',
}

export function isPosReportPresetKey(value: string): value is PosReportPresetKey {
  return (POS_REPORT_PRESET_KEYS as readonly string[]).includes(value)
}

export function rangeFromPreset(preset: PosReportPreset): PosReportRange | null {
  if (!isPosReportPresetKey(preset.preset)) return null
  return {
    dateFrom: preset.date_from,
    dateTo: preset.date_to,
    kind: preset.preset,
  }
}

export function defaultPosReportRange(presets: PosReportPreset[]): PosReportRange | undefined {
  const monthToDate = presets.find((preset) => preset.preset === 'month_to_date')
  return monthToDate ? rangeFromPreset(monthToDate) ?? undefined : undefined
}

function parseCalendarDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return null

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day < 1 || day > daysInMonth[month - 1]) return null

  return { year, month, day }
}

/**
 * Converts a civil date to a monotonic day number without consulting the
 * browser clock or timezone. Only range length and ordering use this value.
 */
function calendarDayNumber({ year, month, day }: { year: number; month: number; day: number }) {
  const adjustedYear = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(adjustedYear / 400)
  const yearOfEra = adjustedYear - era * 400
  const adjustedMonth = month + (month > 2 ? -3 : 9)
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra
}

export function validatePosReportRange(range: PosReportRange | undefined): string | null {
  if (!range?.dateFrom || !range.dateTo) return 'Choose both a start date and an end date.'

  const from = parseCalendarDate(range.dateFrom)
  const to = parseCalendarDate(range.dateTo)
  if (!from || !to) return 'Enter valid dates in YYYY-MM-DD format.'

  const difference = calendarDayNumber(to) - calendarDayNumber(from)
  if (difference < 0) return 'The start date must be on or before the end date.'
  if (difference >= POS_REPORT_MAX_DAYS) {
    return `Reports may cover at most ${POS_REPORT_MAX_DAYS} days.`
  }

  return null
}

export function isPosReportRangeReady(range: PosReportRange | undefined): range is PosReportRange {
  return !!range && validatePosReportRange(range) === null
}

export function formatPosReportMoney(value: number): string {
  return formatMoney(Number(value ?? 0))
}

export function formatNullablePosReportMoney(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? '\u2014'
    : formatPosReportMoney(Number(value))
}

export function formatPosReportPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? '\u2014'
    : `${Number(value).toLocaleString('en-PH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}%`
}

export function formatPosReportCount(value: number): string {
  return Number(value ?? 0).toLocaleString('en-PH', { maximumFractionDigits: 0 })
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Formats a database calendar date without parsing it as a UTC timestamp. */
export function formatPosBusinessDate(value: string): string {
  const parsed = parseCalendarDate(value)
  if (!parsed) return value
  return `${MONTH_LABELS[parsed.month - 1]} ${parsed.day}, ${parsed.year}`
}

export function formatPosBusinessDateShort(value: string): string {
  const parsed = parseCalendarDate(value)
  if (!parsed) return value
  return `${MONTH_LABELS[parsed.month - 1]} ${parsed.day}`
}

export function formatPosReportPeriod(range: PosReportRange | undefined): string {
  if (!range?.dateFrom || !range.dateTo) return ''
  if (range.dateFrom === range.dateTo) return formatPosBusinessDate(range.dateFrom)
  return `${formatPosBusinessDate(range.dateFrom)} to ${formatPosBusinessDate(range.dateTo)}`
}

export function posReportPaymentMethodLabel(method: string): string {
  return saleMethodLabel(method)
}

export function describePosReportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message.includes('Report ranges may cover at most 366 days')) {
    return 'Reports may cover at most 366 days.'
  }
  if (message.includes('Report start date')) {
    return 'The start date must be on or before the end date.'
  }
  if (message.includes('permission denied') || message.includes('row-level security')) {
    return 'You do not have access to that report.'
  }
  if (message.includes('JWT') || message.includes('Sign in')) {
    return 'Your session has expired. Sign in again.'
  }
  return message || 'The POS report could not be loaded.'
}
