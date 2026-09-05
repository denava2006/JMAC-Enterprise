import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from '@/components/ui/sonner'
import { TREASURY_KEY } from '@/lib/treasury'
import { FINANCE_KEYS } from '@/hooks/useFinanceMasterData'
import {
  REIMBURSEMENT_KEY,
  REIMBURSEMENT_PAYMENT_KEY,
  describeReimbursementError,
  type Reimbursement,
  type ReimbursementPayment,
} from '@/lib/reimbursements'

/**
 * Employee reimbursements and the payments that settle them.
 *
 * The claim is a finance_request, so its workflow already has an RPC —
 * transition_finance_request — and nothing here reimplements it. What is new
 * is the payment side, which follows the supplier-payment shape from F6
 * because that architecture is proven rather than because it deduplicates.
 *
 * Recording a payment is the only action that touches three things at once: a
 * treasury balance, a claim's balance and a budget. It is the only one that
 * invalidates all three.
 */

export function useReimbursements() {
  return useQuery({
    queryKey: [...REIMBURSEMENT_KEY, 'list'],
    queryFn: async (): Promise<Reimbursement[]> => {
      const { data, error } = await supabase.rpc('get_reimbursements')
      if (error) throw error
      return (data ?? []) as unknown as Reimbursement[]
    },
  })
}

export function usePayableReimbursements() {
  return useQuery({
    queryKey: [...REIMBURSEMENT_KEY, 'payable'],
    queryFn: async (): Promise<Reimbursement[]> => {
      const { data, error } = await supabase.rpc('get_payable_reimbursements')
      if (error) throw error
      return (data ?? []) as unknown as Reimbursement[]
    },
  })
}

export function useReimbursementPayments(requestId?: string | null) {
  return useQuery({
    queryKey: [...REIMBURSEMENT_PAYMENT_KEY, requestId ?? 'all'],
    queryFn: async (): Promise<ReimbursementPayment[]> => {
      const { data, error } = await supabase.rpc('get_reimbursement_payments', {
        _request_id: requestId ?? undefined,
      })
      if (error) throw error
      return (data ?? []) as unknown as ReimbursementPayment[]
    },
  })
}

/** Moving the claim itself: review, forward, approve, return, reject. */
export function useTransitionReimbursement() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; to: string; remarks?: string | null }) => {
      const { error } = await supabase.rpc('transition_finance_request', {
        _request_id: input.id,
        _to_status: input.to,
        _remarks: input.remarks ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: (_r, input) => {
      qc.invalidateQueries({ queryKey: REIMBURSEMENT_KEY })
      // Approving reserves budget; withdrawing releases it.
      qc.invalidateQueries({ queryKey: FINANCE_KEYS.budgets })
      toast.success(
        input.to === 'approved'
          ? 'Approved. The budget now holds this amount.'
          : `Reimbursement ${input.to.replace('_', ' ')}`
      )
    },
    onError: (e) => toast.error(describeReimbursementError(e)),
  })
}

export function useCreateReimbursementPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      requestId: string
      accountId: string
      amount: number
      method: string
      notes?: string | null
      submit?: boolean
    }) => {
      const { data, error } = await supabase.rpc('create_reimbursement_payment', {
        _finance_request_id: input.requestId,
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
      qc.invalidateQueries({ queryKey: REIMBURSEMENT_PAYMENT_KEY })
      qc.invalidateQueries({ queryKey: REIMBURSEMENT_KEY })
      toast.success(input.submit ? 'Payment submitted for approval' : 'Payment saved as draft')
    },
    onError: (e) => toast.error(describeReimbursementError(e)),
  })
}

export function useTransitionReimbursementPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      to: string
      reason?: string | null
      reference?: string | null
      paymentDate?: string | null
    }) => {
      const { error } = await supabase.rpc('transition_reimbursement_payment', {
        _payment_id: input.id,
        _to_status: input.to,
        _reason: input.reason ?? undefined,
        _reference: input.reference ?? undefined,
        _payment_date: input.paymentDate ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: (_r, input) => {
      qc.invalidateQueries({ queryKey: REIMBURSEMENT_PAYMENT_KEY })
      qc.invalidateQueries({ queryKey: REIMBURSEMENT_KEY })
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
    onError: (e) => toast.error(describeReimbursementError(e)),
  })
}
