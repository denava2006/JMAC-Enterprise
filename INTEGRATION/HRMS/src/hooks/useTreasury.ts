import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from '@/components/ui/sonner'
import {
  PAYMENT_KEY,
  SETTLEMENT_KEY,
  TREASURY_KEY,
  describeTreasuryError,
  type CollectionSettlement,
  type PayableInvoice,
  type SettlementKind,
  type SupplierPayment,
  type TreasuryAccount,
  type TreasuryMovement,
  type UnsettledCollection,
} from '@/lib/treasury'
import { INVOICE_KEYS } from '@/hooks/useSupplierInvoices'
import { FINANCE_KEYS } from '@/hooks/useFinanceMasterData'

/**
 * Treasury, settlements and supplier payments.
 *
 * Every write goes through an RPC that owns its transaction, checks the role
 * and the funds, and writes the treasury movement itself. Nothing here decides
 * whether an action is allowed -- it mirrors rules the database enforces, so a
 * hook that got it wrong would be refused rather than obeyed.
 *
 * The invalidations are deliberately wide on the two actions that move money.
 * Confirming a settlement or recording a payment changes a treasury balance, a
 * payable, and a budget at once; refreshing only the list the user is looking
 * at would leave the other two showing yesterday's numbers.
 */

export function useTreasuryAccounts() {
  return useQuery({
    queryKey: [...TREASURY_KEY, 'accounts'],
    queryFn: async (): Promise<TreasuryAccount[]> => {
      const { data, error } = await supabase.rpc('get_treasury_accounts')
      if (error) throw error
      return (data ?? []) as unknown as TreasuryAccount[]
    },
  })
}

export function useTreasuryMovements(accountId?: string) {
  return useQuery({
    queryKey: [...TREASURY_KEY, 'movements', accountId ?? 'all'],
    queryFn: async (): Promise<TreasuryMovement[]> => {
      const { data, error } = await supabase.rpc('get_treasury_movements', {
        _account_id: accountId ?? undefined,
        _limit: 100,
        _offset: 0,
      })
      if (error) throw error
      return (data ?? []) as unknown as TreasuryMovement[]
    },
  })
}

export function useCreateTreasuryAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      name: string
      accountType: 'cash' | 'bank'
      branchId?: string | null
      financeAccountId?: string | null
      openingBalance?: number
      openingBalanceAsOf?: string | null
      notes?: string | null
    }) => {
      const { data, error } = await supabase
        .from('treasury_accounts')
        .insert({
          name: input.name,
          account_type: input.accountType,
          branch_id: input.branchId ?? null,
          finance_account_id: input.financeAccountId ?? null,
          opening_balance: input.openingBalance ?? 0,
          opening_balance_as_of: input.openingBalance ? input.openingBalanceAsOf : null,
          notes: input.notes ?? null,
        })
        .select('id')
        .single()
      if (error) throw error
      return data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TREASURY_KEY })
      toast.success('Account added')
    },
    onError: (e) => toast.error(describeTreasuryError(e)),
  })
}

// ---------------------------------------------------------------- settlements

export function useCollectionSettlements() {
  return useQuery({
    queryKey: [...SETTLEMENT_KEY, 'list'],
    queryFn: async (): Promise<CollectionSettlement[]> => {
      const { data, error } = await supabase.rpc('get_collection_settlements')
      if (error) throw error
      return (data ?? []) as unknown as CollectionSettlement[]
    },
  })
}

/**
 * What is still waiting to be settled.
 *
 * Only completed sales appear, and only those no live settlement already
 * covers -- so a collection cannot be picked twice, and money that never
 * became a sale can never be picked at all.
 */
export function useUnsettledCollections(
  kind: SettlementKind,
  opts: { branchId?: string | null; paymentMethod?: string | null; from?: string; to?: string },
  enabled = true
) {
  return useQuery({
    queryKey: [
      ...SETTLEMENT_KEY,
      'unsettled',
      kind,
      opts.branchId ?? 'all',
      opts.paymentMethod ?? 'all',
      opts.from ?? '',
      opts.to ?? '',
    ],
    enabled,
    queryFn: async (): Promise<UnsettledCollection[]> => {
      const { data, error } = await supabase.rpc('get_unsettled_collections', {
        _kind: kind,
        _branch_id: opts.branchId ?? undefined,
        _payment_method: opts.paymentMethod ?? undefined,
        _from_date: opts.from ?? undefined,
        _to_date: opts.to ?? undefined,
      })
      if (error) throw error
      return (data ?? []) as unknown as UnsettledCollection[]
    },
  })
}

export function useSettlementItems(settlementId: string | null) {
  return useQuery({
    queryKey: [...SETTLEMENT_KEY, settlementId ?? 'none', 'items'],
    enabled: !!settlementId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_collection_settlement_items', {
        _settlement_id: settlementId!,
      })
      if (error) throw error
      return data ?? []
    },
  })
}

export function useCreateSettlement() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      kind: SettlementKind
      destinationAccountId: string
      settlementDate: string
      saleIds: string[]
      branchId?: string | null
      paymentMethod?: string | null
      feeAmount?: number
      reference?: string | null
      notes?: string | null
      submit?: boolean
    }) => {
      const { data, error } = await supabase.rpc('create_collection_settlement', {
        _kind: input.kind,
        _destination_account_id: input.destinationAccountId,
        _settlement_date: input.settlementDate,
        _sale_ids: input.saleIds,
        _branch_id: input.branchId ?? undefined,
        _payment_method: input.paymentMethod ?? undefined,
        _fee_amount: input.feeAmount ?? 0,
        _reference: input.reference ?? undefined,
        _notes: input.notes ?? undefined,
        _submit: input.submit ?? false,
      })
      if (error) throw error
      return data as unknown as string
    },
    onSuccess: (_id, input) => {
      qc.invalidateQueries({ queryKey: SETTLEMENT_KEY })
      toast.success(input.submit ? 'Settlement submitted for review' : 'Settlement saved as draft')
    },
    onError: (e) => toast.error(describeTreasuryError(e)),
  })
}

export function useTransitionSettlement() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; to: string; reason?: string | null }) => {
      const { error } = await supabase.rpc('transition_collection_settlement', {
        _settlement_id: input.id,
        _to_status: input.to,
        _reason: input.reason ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: (_r, input) => {
      qc.invalidateQueries({ queryKey: SETTLEMENT_KEY })
      // Confirming credits an account, so the treasury is stale too.
      qc.invalidateQueries({ queryKey: TREASURY_KEY })
      toast.success(
        input.to === 'confirmed'
          ? 'Settlement confirmed — the account has been credited'
          : `Settlement ${input.to.replace('_', ' ')}`
      )
    },
    onError: (e) => toast.error(describeTreasuryError(e)),
  })
}

// ------------------------------------------------------------------- payments

export function usePayableInvoices() {
  return useQuery({
    queryKey: [...PAYMENT_KEY, 'payable'],
    queryFn: async (): Promise<PayableInvoice[]> => {
      const { data, error } = await supabase.rpc('get_payable_invoices')
      if (error) throw error
      return (data ?? []) as unknown as PayableInvoice[]
    },
  })
}

export function useSupplierPayments(invoiceId?: string | null) {
  return useQuery({
    queryKey: [...PAYMENT_KEY, 'list', invoiceId ?? 'all'],
    queryFn: async (): Promise<SupplierPayment[]> => {
      const { data, error } = await supabase.rpc('get_supplier_payments', {
        _invoice_id: invoiceId ?? undefined,
      })
      if (error) throw error
      return (data ?? []) as unknown as SupplierPayment[]
    },
  })
}

export function useCreatePayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      invoiceId: string
      accountId: string
      amount: number
      method: string
      notes?: string | null
      submit?: boolean
    }) => {
      const { data, error } = await supabase.rpc('create_supplier_payment', {
        _supplier_invoice_id: input.invoiceId,
        _treasury_account_id: input.accountId,
        _amount: input.amount,
        _method: input.method,
        _notes: input.notes ?? undefined,
        _submit: input.submit ?? false,
      })
      if (error) throw error
      return data as unknown as string
    },
    onSuccess: (_id, input) => {
      qc.invalidateQueries({ queryKey: PAYMENT_KEY })
      toast.success(input.submit ? 'Payment submitted for approval' : 'Payment saved as draft')
    },
    onError: (e) => toast.error(describeTreasuryError(e)),
  })
}

/**
 * Moving a payment along, including the one step that spends.
 *
 * Recording completion is the only transition that changes a balance, a
 * payable or a budget, so it is the only one that invalidates all three.
 */
export function useTransitionPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      to: string
      reason?: string | null
      reference?: string | null
      paymentDate?: string | null
    }) => {
      const { error } = await supabase.rpc('transition_supplier_payment', {
        _payment_id: input.id,
        _to_status: input.to,
        _reason: input.reason ?? undefined,
        _reference: input.reference ?? undefined,
        _payment_date: input.paymentDate ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: (_r, input) => {
      qc.invalidateQueries({ queryKey: PAYMENT_KEY })
      qc.invalidateQueries({ queryKey: INVOICE_KEYS.all })
      if (input.to === 'paid') {
        // The three things a completed payment touches at once.
        qc.invalidateQueries({ queryKey: TREASURY_KEY })
        qc.invalidateQueries({ queryKey: FINANCE_KEYS.budgets })
        toast.success('Payment recorded')
      } else if (input.to === 'approved') {
        toast.success('Approved for payment. No money has moved yet.')
      } else {
        toast.success(`Payment ${input.to.replace('_', ' ')}`)
      }
    },
    onError: (e) => toast.error(describeTreasuryError(e)),
  })
}
