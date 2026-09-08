import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import {
  ACCOUNTING_KEY,
  type JournalEntry,
  type LedgerLine,
  type TrialBalanceRow,
} from '@/lib/accounting'

/**
 * Reading the books.
 *
 * There is no mutation in this file and there is not meant to be one. Journal
 * entries are written by the database when a treasury movement is recorded, and
 * the tables carry no insert, update or delete policy at all — so a hook that
 * offered to create or correct an entry would be describing something the
 * server would refuse. Accounting here observes; the modules that move money
 * are still the only things that move it.
 */

const ENTRY_COLUMNS =
  'id, journal_no, posting_date, description, source_type, source_reference, status'

export interface JournalFilters {
  from?: string
  to?: string
  sourceType?: string
}

/**
 * The journal register.
 *
 * Totals come from the entry's own lines rather than a stored column: a
 * summary that could be written separately from the lines is a summary that can
 * one day disagree with them.
 */
export function useJournalEntries(filters: JournalFilters = {}) {
  const { from, to, sourceType } = filters
  return useQuery({
    queryKey: [...ACCOUNTING_KEY, 'journal', from ?? '', to ?? '', sourceType ?? 'all'],
    queryFn: async (): Promise<JournalEntry[]> => {
      let query = supabase
        .from('journal_entries')
        .select(`${ENTRY_COLUMNS}, journal_entry_lines(debit, credit)`)
        .order('posting_date', { ascending: false })
        .order('journal_no', { ascending: false })
        .limit(500)

      if (from) query = query.gte('posting_date', from)
      if (to) query = query.lte('posting_date', to)
      if (sourceType) query = query.eq('source_type', sourceType)

      const { data, error } = await query
      if (error) throw error

      return (data ?? []).map((row) => {
        const lines = (row.journal_entry_lines ?? []) as Array<{
          debit: number | string
          credit: number | string
        }>
        return {
          id: row.id,
          journal_no: row.journal_no,
          posting_date: row.posting_date,
          description: row.description,
          source_type: row.source_type,
          source_reference: row.source_reference,
          status: row.status,
          total_debit: lines.reduce((sum, l) => sum + Number(l.debit ?? 0), 0),
          total_credit: lines.reduce((sum, l) => sum + Number(l.credit ?? 0), 0),
        }
      })
    },
  })
}

/** One entry's lines, with the accounts they hit. */
export function useJournalEntryLines(entryId: string | null) {
  return useQuery({
    queryKey: [...ACCOUNTING_KEY, 'entry', entryId ?? 'none'],
    enabled: !!entryId,
    queryFn: async (): Promise<LedgerLine[]> => {
      const { data, error } = await supabase
        .from('general_ledger_lines')
        .select('*')
        .eq('journal_entry_id', entryId!)
        .order('line_no', { ascending: true })
      if (error) throw error
      return (data ?? []) as unknown as LedgerLine[]
    },
  })
}

export interface LedgerFilters {
  accountId?: string
  from?: string
  to?: string
}

/**
 * The general ledger.
 *
 * Ordered the way a ledger is read — oldest first — because the running balance
 * beside each line only means anything in that direction.
 */
export function useLedgerLines(filters: LedgerFilters = {}, enabled = true) {
  const { accountId, from, to } = filters
  return useQuery({
    queryKey: [...ACCOUNTING_KEY, 'ledger', accountId ?? 'all', from ?? '', to ?? ''],
    enabled,
    queryFn: async (): Promise<LedgerLine[]> => {
      let query = supabase
        .from('general_ledger_lines')
        .select('*')
        .order('posting_date', { ascending: true })
        .order('journal_no', { ascending: true })
        .order('line_no', { ascending: true })
        .limit(2000)

      if (accountId) query = query.eq('account_id', accountId)
      if (from) query = query.gte('posting_date', from)
      if (to) query = query.lte('posting_date', to)

      const { data, error } = await query
      if (error) throw error
      return (data ?? []) as unknown as LedgerLine[]
    },
  })
}

/**
 * The trial balance.
 *
 * Every account with posted activity, netted. It covers everything ever posted:
 * F8 has no period close, so there is no closed period for it to stop at, and
 * pretending otherwise by cutting it at a date would imply a closing process
 * that does not exist.
 */
export function useTrialBalance() {
  return useQuery({
    queryKey: [...ACCOUNTING_KEY, 'trial-balance'],
    queryFn: async (): Promise<TrialBalanceRow[]> => {
      const { data, error } = await supabase
        .from('trial_balance')
        .select('*')
        .order('account_code', { ascending: true })
      if (error) throw error
      return (data ?? []) as unknown as TrialBalanceRow[]
    },
  })
}
