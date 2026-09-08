import { describe, expect, it } from 'vitest'
import {
  moneyOrBlank,
  netIncome,
  netOf,
  runningBalance,
  sourceLabel,
  summarise,
  totalOf,
  type LedgerLine,
} from '@/lib/accounting'

/**
 * The arithmetic the accounting screens do on top of posted lines.
 *
 * The database proves the ledger balances; these prove the reading of it is not
 * quietly wrong — a running balance signed the wrong way, or a summary that
 * counts a credit as a cost.
 */

function line(partial: Partial<LedgerLine>): LedgerLine {
  return {
    id: crypto.randomUUID(),
    journal_entry_id: 'e1',
    journal_no: 'JE-2026-0001',
    posting_date: '2026-09-08',
    description: 'Reimbursement payment RB-2026-0001',
    source_type: 'reimbursement_payment',
    source_reference: 'RB-2026-0001',
    account_id: 'a1',
    account_code: '5100',
    account_name: 'Employee Reimbursement Expense',
    account_type: 'expense',
    line_no: 1,
    line_description: null,
    debit: 0,
    credit: 0,
    ...partial,
  }
}

describe('runningBalance', () => {
  it('raises a debit-normal account on a debit and lowers it on a credit', () => {
    const balances = runningBalance(
      [
        { debit: 1000, credit: 0 },
        { debit: 0, credit: 250 },
        { debit: 50, credit: 0 },
      ],
      'asset',
    )
    expect(balances).toEqual([1000, 750, 800])
  })

  // The sign error that matters: a bank account whose credits raised it would
  // read as flush after a week of paying suppliers.
  it('raises a credit-normal account on a credit', () => {
    const balances = runningBalance(
      [
        { debit: 0, credit: 2000 },
        { debit: 0, credit: 500 },
      ],
      'revenue',
    )
    expect(balances).toEqual([2000, 2500])
  })

  it('is a running figure, not a repeated total', () => {
    expect(runningBalance([{ debit: 100, credit: 0 }], 'expense')).toEqual([100])
    expect(runningBalance([], 'expense')).toEqual([])
  })
})

describe('summaries', () => {
  const lines = [
    line({ account_code: '5100', account_id: 'a1', debit: 1000 }),
    line({ account_code: '5100', account_id: 'a1', debit: 400 }),
    line({
      account_code: '5200',
      account_id: 'a2',
      account_name: 'Payroll Expense',
      debit: 5000,
    }),
    line({
      account_code: '4000',
      account_id: 'a3',
      account_name: 'Sales Revenue',
      account_type: 'revenue',
      credit: 2000,
    }),
    line({
      account_code: '1100',
      account_id: 'a4',
      account_name: 'BDO Current Account',
      account_type: 'asset',
      credit: 6400,
    }),
  ]

  it('groups expenses by account and ignores every other account type', () => {
    const rows = summarise(lines, 'expense')
    expect(rows.map((r) => r.account_code)).toEqual(['5100', '5200'])
    expect(rows[0].amount).toBe(1400)
    expect(totalOf(rows)).toBe(6400)
  })

  it('reads revenue on its own side rather than as a negative', () => {
    const rows = summarise(lines, 'revenue')
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(2000)
  })

  // Nothing here reaches for a payment, a payroll run or a sale: the summary is
  // the posted lines and can only ever be the posted lines.
  it('totals exactly the lines it was given', () => {
    expect(netOf(lines.filter((l) => l.account_type === 'expense'), 'expense')).toBe(6400)
  })

  it('nets revenue against expenses and says so when it is a loss', () => {
    expect(netIncome(2000, 6400)).toBe(-4400)
    expect(netIncome(9000, 6400)).toBe(2600)
  })
})

describe('sourceLabel', () => {
  it('names each posting source the way Finance says it', () => {
    expect(sourceLabel('reimbursement_payment')).toBe('Reimbursement payment')
    expect(sourceLabel('collection_settlement')).toBe('Collection settlement')
    expect(sourceLabel('payroll_disbursement')).toBe('Payroll disbursement')
    expect(sourceLabel('supplier_payment')).toBe('Supplier payment')
  })

  it('still reads as words if a source type is added before this map is', () => {
    expect(sourceLabel('bank_transfer')).toBe('Bank transfer')
  })
})

describe('moneyOrBlank', () => {
  // A zero in a debit column reads as an amount of nothing; a blank reads as
  // "this line is on the other side", which is what it means.
  it('blanks a zero and formats everything else', () => {
    expect(moneyOrBlank(0)).toBe('')
    expect(moneyOrBlank(null)).toBe('')
    expect(moneyOrBlank(1000)).toContain('1,000.00')
  })
})
