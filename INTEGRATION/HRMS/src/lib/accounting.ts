import { formatMoney } from '@/lib/currency'

/**
 * The accounting layer's words and arithmetic.
 *
 * Every figure on every F8 screen comes from posted journal lines. There is no
 * second set of balances anywhere — not in a table, not in this file. What is
 * here is only the shaping: running a balance down a column, netting an account
 * to the side it falls on, and naming a source in business terms.
 */

export const ACCOUNTING_KEY = ['accounting'] as const

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'

export interface JournalEntry {
  id: string
  journal_no: string | null
  posting_date: string
  description: string
  source_type: string
  source_reference: string | null
  status: string
  total_debit: number
  total_credit: number
}

export interface LedgerLine {
  id: string
  journal_entry_id: string
  journal_no: string | null
  posting_date: string
  description: string
  source_type: string
  source_reference: string | null
  account_id: string
  account_code: string
  account_name: string
  account_type: AccountType
  line_no: number
  line_description: string | null
  debit: number
  credit: number
}

export interface TrialBalanceRow {
  account_id: string
  account_code: string
  account_name: string
  account_type: AccountType
  debit_balance: number
  credit_balance: number
}

/**
 * What produced an entry, said the way Finance says it.
 *
 * The source_type is a column value; nobody outside the database calls it
 * "collection_settlement". The business reference beside it — RV-2026-0001 —
 * is what a person actually recognises, so the id never has to appear.
 */
export const JOURNAL_SOURCE_LABEL: Record<string, string> = {
  reimbursement_payment: 'Reimbursement payment',
  supplier_payment: 'Supplier payment',
  payroll_disbursement: 'Payroll disbursement',
  collection_settlement: 'Collection settlement',
}

export function sourceLabel(sourceType: string): string {
  const known = JOURNAL_SOURCE_LABEL[sourceType]
  if (known) return known
  const words = sourceType.replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Transaction'
}

/**
 * A running balance down an account's lines.
 *
 * Signed by what the account is: a debit raises an asset or an expense and
 * lowers a revenue, and the reverse for a credit. Getting this backwards would
 * make a perfectly correct ledger read as though the bank were overdrawn.
 */
export function runningBalance(
  lines: Array<Pick<LedgerLine, 'debit' | 'credit'>>,
  accountType: AccountType,
): number[] {
  const debitNormal = accountType === 'asset' || accountType === 'expense'
  let balance = 0
  return lines.map((l) => {
    const movement = Number(l.debit ?? 0) - Number(l.credit ?? 0)
    balance += debitNormal ? movement : -movement
    return Math.round(balance * 100) / 100
  })
}

/** One account's net, on the side it belongs. */
export function netOf(
  lines: Array<Pick<LedgerLine, 'debit' | 'credit'>>,
  accountType: AccountType,
): number {
  const debitNormal = accountType === 'asset' || accountType === 'expense'
  const total = lines.reduce(
    (sum, l) => sum + Number(l.debit ?? 0) - Number(l.credit ?? 0),
    0,
  )
  return Math.round((debitNormal ? total : -total) * 100) / 100
}

export interface SummaryRow {
  account_id: string
  account_code: string
  account_name: string
  amount: number
}

/**
 * Expense and revenue summaries, from the same lines the ledger shows.
 *
 * Deliberately not a query against payments, payroll or sales: a summary that
 * reads the operational tables would be a second opinion about what was spent,
 * and the whole point of the ledger is that there is one.
 */
export function summarise(lines: LedgerLine[], accountType: AccountType): SummaryRow[] {
  const byAccount = new Map<string, SummaryRow & { lines: LedgerLine[] }>()
  for (const line of lines) {
    if (line.account_type !== accountType) continue
    const row = byAccount.get(line.account_id) ?? {
      account_id: line.account_id,
      account_code: line.account_code,
      account_name: line.account_name,
      amount: 0,
      lines: [],
    }
    row.lines.push(line)
    byAccount.set(line.account_id, row)
  }
  return Array.from(byAccount.values())
    .map((row) => ({
      account_id: row.account_id,
      account_code: row.account_code,
      account_name: row.account_name,
      amount: netOf(row.lines, accountType),
    }))
    .sort((a, b) => a.account_code.localeCompare(b.account_code))
}

export function totalOf(rows: SummaryRow[]): number {
  return Math.round(rows.reduce((sum, r) => sum + r.amount, 0) * 100) / 100
}

/**
 * Revenue less expenses, and nothing else.
 *
 * It is only an income statement in the narrow sense the ledger supports: this
 * is cash-basis, so there is no accrual, no cost of sales, no depreciation and
 * no closing. Those would each need an accounting process JMAC does not have,
 * and inventing one to make this report look fuller is exactly what F8 was told
 * not to do.
 */
export function netIncome(revenue: number, expenses: number): number {
  return Math.round((revenue - expenses) * 100) / 100
}

export function formatAccountingMoney(value: number | null | undefined): string {
  return formatMoney(Number(value ?? 0))
}

/** Blank rather than ₱0.00 where a column does not apply to a line. A zero in a
 *  debit column reads as an amount; nothing reads as the other side. */
export function moneyOrBlank(value: number | null | undefined): string {
  const n = Number(value ?? 0)
  return n === 0 ? '' : formatMoney(n)
}
