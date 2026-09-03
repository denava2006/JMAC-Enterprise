import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import {
  FINANCE_SALES_KEY,
  FINANCE_SALES_PAGE_SIZE,
  type FinanceSalesCollection,
  type FinanceSalesFilterOption,
  type FinanceSalesFilters,
  type FinanceSalesSummary,
  type FinanceSalesTransaction,
} from '@/lib/financeSales'

/**
 * Finance's read of POS sales.
 *
 * Four queries, no mutations, and no mutation is coming: there is nothing on
 * this surface a Finance user may change. A correction to a sale has to
 * originate in POS, which owns it.
 *
 * The date range arrives as two plain dates and is resolved into a Philippine
 * business day by the database, using the same bounds the POS reports use. The
 * browser's clock never decides what "Today" means -- a Finance user in another
 * timezone would otherwise see a different day's takings from the branch that
 * earned them.
 */

const SALES_STALE_TIME = 30_000

/** The five presets are computed server-side from the POS business date. */
export interface FinanceSalesPreset {
  preset: string
  date_from: string
  date_to: string
  sort_order: number
}

/**
 * "No filter" is sent as an absent argument, not as an explicit null.
 *
 * PostgREST omits undefined keys, so the function's own `default null` applies
 * and the SQL reads `_branch_id is null` -- one definition of unfiltered,
 * living in the database rather than being asserted twice.
 */
function filterArgs(filters: FinanceSalesFilters) {
  return {
    _from_date: filters.dateFrom,
    _to_date: filters.dateTo,
    _branch_id: filters.branchId ?? undefined,
    _payment_method: filters.paymentMethod ?? undefined,
    _cashier_id: filters.cashierId ?? undefined,
  }
}

function filterKey(filters: FinanceSalesFilters) {
  return [
    filters.dateFrom,
    filters.dateTo,
    filters.branchId ?? 'all',
    filters.paymentMethod ?? 'all',
    filters.cashierId ?? 'all',
  ] as const
}

const ready = (filters: FinanceSalesFilters) => !!filters.dateFrom && !!filters.dateTo

/**
 * The same presets the POS reports use.
 *
 * Deliberately the POS function rather than a Finance copy of it: "Today"
 * has to mean one thing across the enterprise, and it is defined once, in
 * Philippine business time, in the database.
 */
export function useFinanceSalesPresets() {
  return useQuery({
    queryKey: [...FINANCE_SALES_KEY, 'presets'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<FinanceSalesPreset[]> => {
      const { data, error } = await supabase.rpc('get_pos_report_presets')
      if (error) throw error
      return (data ?? []) as FinanceSalesPreset[]
    },
  })
}

export function useFinanceSalesSummary(filters: FinanceSalesFilters) {
  return useQuery({
    queryKey: [...FINANCE_SALES_KEY, 'summary', ...filterKey(filters)],
    enabled: ready(filters),
    staleTime: SALES_STALE_TIME,
    queryFn: async (): Promise<FinanceSalesSummary | undefined> => {
      const { data, error } = await supabase.rpc('get_finance_sales_summary', filterArgs(filters))
      if (error) throw error
      return (data ?? [])[0] as unknown as FinanceSalesSummary | undefined
    },
  })
}

export function useFinanceSalesCollections(filters: FinanceSalesFilters) {
  return useQuery({
    queryKey: [...FINANCE_SALES_KEY, 'collections', ...filterKey(filters)],
    enabled: ready(filters),
    staleTime: SALES_STALE_TIME,
    queryFn: async (): Promise<FinanceSalesCollection[]> => {
      const { data, error } = await supabase.rpc(
        'get_finance_sales_collections',
        filterArgs(filters)
      )
      if (error) throw error
      return (data ?? []) as unknown as FinanceSalesCollection[]
    },
  })
}

export function useFinanceSalesTransactions(filters: FinanceSalesFilters, page = 0) {
  return useQuery({
    queryKey: [...FINANCE_SALES_KEY, 'transactions', ...filterKey(filters), page],
    enabled: ready(filters),
    staleTime: SALES_STALE_TIME,
    queryFn: async (): Promise<FinanceSalesTransaction[]> => {
      const { data, error } = await supabase.rpc('get_finance_sales_transactions', {
        ...filterArgs(filters),
        _limit: FINANCE_SALES_PAGE_SIZE,
        _offset: page * FINANCE_SALES_PAGE_SIZE,
      })
      if (error) throw error
      return (data ?? []) as unknown as FinanceSalesTransaction[]
    },
  })
}

/**
 * The branches and cashiers worth offering as filters.
 *
 * Only those that actually traded in the range. Listing every branch would
 * send Finance hunting through empty ones, and listing every cashier would put
 * the POS roster on a page that has no reason to carry it.
 */
export function useFinanceSalesFilterOptions(dateFrom: string, dateTo: string) {
  return useQuery({
    queryKey: [...FINANCE_SALES_KEY, 'filters', dateFrom, dateTo],
    enabled: !!dateFrom && !!dateTo,
    staleTime: SALES_STALE_TIME,
    queryFn: async (): Promise<FinanceSalesFilterOption[]> => {
      const { data, error } = await supabase.rpc('get_finance_sales_filters', {
        _from_date: dateFrom,
        _to_date: dateTo,
      })
      if (error) throw error
      return (data ?? []) as unknown as FinanceSalesFilterOption[]
    },
  })
}
