import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Tables, TablesInsert, TablesUpdate } from '@/lib/database.types'
import { toast } from '@/components/ui/sonner'

export type FinanceCategory = Tables<'finance_categories'>
export type Vendor = Tables<'vendors'>
export type FinanceAccount = Tables<'finance_accounts'>
export type Budget = Tables<'budgets'>
export type BudgetStatus = Tables<'budget_status'>
export type BudgetAllocation = Tables<'budget_allocations'>

export const FINANCE_KEYS = {
  categories: ['finance', 'categories'] as const,
  vendors: ['finance', 'vendors'] as const,
  vendorCategories: ['finance', 'vendor-categories'] as const,
  accounts: ['finance', 'accounts'] as const,
  budgets: ['finance', 'budgets'] as const,
  allocations: (budgetId: string) => ['finance', 'allocations', budgetId] as const,
}

/**
 * What went wrong, said the way a finance officer would say it.
 *
 * Postgres reports a denied policy as "new row violates row-level security
 * policy", which tells somebody preparing a purchase nothing at all. The two
 * cases worth naming are the ones the role matrix creates on purpose: you are
 * not the person who does this, and the ceiling is a ceiling.
 */
export function describeFinanceError(error: unknown): string {
  const err = error as { code?: string; message?: string } | null
  const message = err?.message ?? ''

  if (err?.code === '42501' || message.includes('row-level security')) {
    return 'Your finance role does not cover that action.'
  }
  // The ceiling and closed-budget triggers raise check_violation with a message
  // already written for a person; pass it through rather than replacing it.
  if (err?.code === '23514' && message && !message.includes('violates check constraint')) {
    return message
  }
  if (err?.code === '23505') {
    return 'Something with that name already exists.'
  }
  if (message.includes('over its approved ceiling') || message.includes('cannot be changed')) {
    return message
  }
  return message || 'That could not be saved.'
}

function useFinanceMutation<TInput>(
  run: (input: TInput) => Promise<void>,
  { invalidate, success }: { invalidate: readonly (readonly unknown[])[]; success: string },
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      for (const key of invalidate) queryClient.invalidateQueries({ queryKey: key })
      toast.success(success)
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

/* ------------------------------------------------------------- categories */

export function useFinanceCategories() {
  return useQuery({
    queryKey: FINANCE_KEYS.categories,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('finance_categories')
        .select('*')
        .order('kind')
        .order('name')
      if (error) throw error
      return data
    },
  })
}

export function useSaveFinanceCategory() {
  return useFinanceMutation<{ id?: string; values: TablesInsert<'finance_categories'> }>(
    async ({ id, values }) => {
      const { error } = id
        ? await supabase.from('finance_categories').update(values as TablesUpdate<'finance_categories'>).eq('id', id)
        : await supabase.from('finance_categories').insert(values)
      if (error) throw error
    },
    { invalidate: [FINANCE_KEYS.categories], success: 'Category saved.' },
  )
}

export function useSetFinanceCategoryActive() {
  return useFinanceMutation<{ id: string; isActive: boolean }>(
    async ({ id, isActive }) => {
      const { error } = await supabase
        .from('finance_categories')
        .update({ is_active: isActive })
        .eq('id', id)
      if (error) throw error
    },
    { invalidate: [FINANCE_KEYS.categories], success: 'Category updated.' },
  )
}

/* ---------------------------------------------------------------- vendors */

export function useVendors() {
  return useQuery({
    queryKey: FINANCE_KEYS.vendors,
    queryFn: async () => {
      const { data, error } = await supabase.from('vendors').select('*').order('name')
      if (error) throw error
      return data
    },
  })
}

/** Which categories each vendor supplies, as a lookup the table can render. */
export function useVendorCategories() {
  return useQuery({
    queryKey: FINANCE_KEYS.vendorCategories,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('vendor_categories')
        .select('vendor_id, finance_category_id')
      if (error) throw error
      const byVendor = new Map<string, string[]>()
      for (const row of data) {
        const list = byVendor.get(row.vendor_id) ?? []
        list.push(row.finance_category_id)
        byVendor.set(row.vendor_id, list)
      }
      return byVendor
    },
  })
}

export function useSaveVendor() {
  return useFinanceMutation<{ id?: string; values: TablesInsert<'vendors'>; categoryIds: string[] }>(
    async ({ id, values, categoryIds }) => {
      let vendorId = id
      if (vendorId) {
        const { error } = await supabase
          .from('vendors')
          .update(values as TablesUpdate<'vendors'>)
          .eq('id', vendorId)
        if (error) throw error
      } else {
        const { data, error } = await supabase.from('vendors').insert(values).select('id').single()
        if (error) throw error
        vendorId = data.id
      }

      // The link rows are replaced rather than diffed: a vendor supplies a
      // handful of categories, and "what it supplies now" is the whole answer.
      const { error: clearError } = await supabase
        .from('vendor_categories')
        .delete()
        .eq('vendor_id', vendorId)
      if (clearError) throw clearError

      if (categoryIds.length > 0) {
        const { error: linkError } = await supabase
          .from('vendor_categories')
          .insert(categoryIds.map((finance_category_id) => ({ vendor_id: vendorId!, finance_category_id })))
        if (linkError) throw linkError
      }
    },
    { invalidate: [FINANCE_KEYS.vendors, FINANCE_KEYS.vendorCategories], success: 'Vendor saved.' },
  )
}

export function useSetVendorActive() {
  return useFinanceMutation<{ id: string; isActive: boolean }>(
    async ({ id, isActive }) => {
      const { error } = await supabase.from('vendors').update({ is_active: isActive }).eq('id', id)
      if (error) throw error
    },
    { invalidate: [FINANCE_KEYS.vendors], success: 'Vendor updated.' },
  )
}

/* --------------------------------------------------------------- accounts */

export function useFinanceAccounts() {
  return useQuery({
    queryKey: FINANCE_KEYS.accounts,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('finance_accounts')
        .select('*')
        .order('account_type')
        .order('name')
      if (error) throw error
      return data
    },
  })
}

export function useSaveFinanceAccount() {
  return useFinanceMutation<{ id?: string; values: TablesInsert<'finance_accounts'> }>(
    async ({ id, values }) => {
      const { error } = id
        ? await supabase.from('finance_accounts').update(values as TablesUpdate<'finance_accounts'>).eq('id', id)
        : await supabase.from('finance_accounts').insert(values)
      if (error) throw error
    },
    { invalidate: [FINANCE_KEYS.accounts], success: 'Account saved.' },
  )
}

export function useSetFinanceAccountActive() {
  return useFinanceMutation<{ id: string; isActive: boolean }>(
    async ({ id, isActive }) => {
      const { error } = await supabase
        .from('finance_accounts')
        .update({ is_active: isActive })
        .eq('id', id)
      if (error) throw error
    },
    { invalidate: [FINANCE_KEYS.accounts], success: 'Account updated.' },
  )
}

/* ---------------------------------------------------------------- budgets */

/** Read from budget_status, never from budgets: the ceiling on its own is one
 *  of four numbers, and a screen showing only the ceiling misleads. */
export function useBudgets() {
  return useQuery({
    queryKey: FINANCE_KEYS.budgets,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('budget_status')
        .select('*')
        .order('fiscal_year', { ascending: false })
        .order('name')
      if (error) throw error
      return data
    },
  })
}

export function useSaveBudget() {
  return useFinanceMutation<{ id?: string; values: TablesInsert<'budgets'> }>(
    async ({ id, values }) => {
      const { error } = id
        ? await supabase.from('budgets').update(values as TablesUpdate<'budgets'>).eq('id', id)
        : await supabase.from('budgets').insert(values)
      if (error) throw error
    },
    { invalidate: [FINANCE_KEYS.budgets], success: 'Budget saved.' },
  )
}

export function useSetBudgetStatus() {
  return useFinanceMutation<{ id: string; status: 'draft' | 'active' | 'closed' }>(
    async ({ id, status }) => {
      const { error } = await supabase.from('budgets').update({ status }).eq('id', id)
      if (error) throw error
    },
    { invalidate: [FINANCE_KEYS.budgets], success: 'Budget updated.' },
  )
}

/* -------------------------------------------------------- maker / checker */

/**
 * The checker's half of finance master data.
 *
 * Each of these calls a SECURITY DEFINER function rather than updating the row,
 * because approval is not something a maker may write and the database is where
 * that is decided. The self-approval refusal comes back from the server as an
 * insufficient_privilege error and is surfaced as-is by describeFinanceError.
 */
export function useReviewVendor() {
  return useFinanceMutation<{ id: string; approve: boolean; note?: string }>(
    async ({ id, approve, note }) => {
      const { error } = await supabase.rpc('review_vendor', {
        _vendor_id: id,
        _approve: approve,
        _note: note ?? undefined,
      })
      if (error) throw error
    },
    { invalidate: [FINANCE_KEYS.vendors], success: 'Vendor reviewed.' },
  )
}

export function useReviewFinanceCategory() {
  return useFinanceMutation<{ id: string; approve: boolean; note?: string }>(
    async ({ id, approve, note }) => {
      const { error } = await supabase.rpc('review_finance_category', {
        _category_id: id,
        _approve: approve,
        _note: note ?? undefined,
      })
      if (error) throw error
    },
    { invalidate: [FINANCE_KEYS.categories], success: 'Category reviewed.' },
  )
}

export function useReviewBudget() {
  return useFinanceMutation<{ id: string; approve: boolean; note?: string }>(
    async ({ id, approve, note }) => {
      const { error } = await supabase.rpc('review_budget', {
        _budget_id: id,
        _approve: approve,
        _note: note ?? undefined,
      })
      if (error) throw error
    },
    { invalidate: [FINANCE_KEYS.budgets], success: 'Budget reviewed.' },
  )
}

/* ------------------------------------------------------------ allocations */

export function useBudgetAllocations(budgetId: string | undefined) {
  return useQuery({
    queryKey: FINANCE_KEYS.allocations(budgetId ?? 'none'),
    enabled: !!budgetId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('budget_allocations')
        .select('*')
        .eq('budget_id', budgetId!)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
  })
}

export function useSaveAllocation(budgetId: string | undefined) {
  return useFinanceMutation<{ id?: string; values: TablesInsert<'budget_allocations'> }>(
    async ({ id, values }) => {
      const { error } = id
        ? await supabase
            .from('budget_allocations')
            .update(values as TablesUpdate<'budget_allocations'>)
            .eq('id', id)
        : await supabase.from('budget_allocations').insert(values)
      if (error) throw error
    },
    {
      invalidate: [FINANCE_KEYS.allocations(budgetId ?? 'none'), FINANCE_KEYS.budgets],
      success: 'Allocation saved.',
    },
  )
}

export function useReleaseAllocation(budgetId: string | undefined) {
  return useFinanceMutation<{ id: string }>(
    async ({ id }) => {
      const { error } = await supabase
        .from('budget_allocations')
        .update({ status: 'released', released_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
    },
    {
      invalidate: [FINANCE_KEYS.allocations(budgetId ?? 'none'), FINANCE_KEYS.budgets],
      success: 'Allocation released. The amount is back on the ceiling.',
    },
  )
}
