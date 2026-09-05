import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from '@/components/ui/sonner'
import { TREASURY_KEY } from '@/lib/treasury'
import {
  PAYROLL_FINANCE_KEY,
  describePayrollError,
  type PayrollDisbursement,
  type PayrollFinanceBatch,
  type PayrollFinanceItem,
} from '@/lib/payrollFinance'

/**
 * Payroll payables and their disbursements.
 *
 * Read-only towards HR: there is no mutation here that touches a payroll
 * period, a payroll record or a payslip. The batch arrives when HR finalizes,
 * written by a database trigger — the frontend is never responsible for the
 * financial handoff, because a browser that fails halfway would leave a
 * finalized payroll with no payable.
 *
 * Payroll is budget-neutral, so recording a disbursement invalidates the
 * treasury and nothing else.
 */

export function usePayrollFinanceBatches() {
  return useQuery({
    queryKey: [...PAYROLL_FINANCE_KEY, 'batches'],
    queryFn: async (): Promise<PayrollFinanceBatch[]> => {
      const { data, error } = await supabase.rpc('get_payroll_finance_batches')
      if (error) throw error
      return (data ?? []) as unknown as PayrollFinanceBatch[]
    },
  })
}

/**
 * The per-employee lines.
 *
 * Salary data: the server returns nothing unless the caller is HR, an
 * administrator, the Accountant or the Finance Manager. An empty list here is
 * a legitimate answer, not an error.
 */
export function usePayrollFinanceItems(batchId: string | null) {
  return useQuery({
    queryKey: [...PAYROLL_FINANCE_KEY, batchId ?? 'none', 'items'],
    enabled: !!batchId,
    queryFn: async (): Promise<PayrollFinanceItem[]> => {
      const { data, error } = await supabase.rpc('get_payroll_finance_items', {
        _batch_id: batchId!,
      })
      if (error) throw error
      return (data ?? []) as unknown as PayrollFinanceItem[]
    },
  })
}

export function usePayrollDisbursements(batchId?: string | null) {
  return useQuery({
    queryKey: [...PAYROLL_FINANCE_KEY, 'disbursements', batchId ?? 'all'],
    queryFn: async (): Promise<PayrollDisbursement[]> => {
      const { data, error } = await supabase.rpc('get_payroll_disbursements', {
        _batch_id: batchId ?? undefined,
      })
      if (error) throw error
      return (data ?? []) as unknown as PayrollDisbursement[]
    },
  })
}

export function useCreateDisbursement() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      batchId: string
      accountId: string
      amount: number
      method: string
      notes?: string | null
      submit?: boolean
    }) => {
      const { data, error } = await supabase.rpc('create_payroll_disbursement', {
        _batch_id: input.batchId,
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
      qc.invalidateQueries({ queryKey: PAYROLL_FINANCE_KEY })
      toast.success(
        input.submit ? 'Disbursement submitted for approval' : 'Disbursement saved as draft'
      )
    },
    onError: (e) => toast.error(describePayrollError(e)),
  })
}

export function useTransitionDisbursement() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      to: string
      reason?: string | null
      reference?: string | null
      paymentDate?: string | null
    }) => {
      const { error } = await supabase.rpc('transition_payroll_disbursement', {
        _disbursement_id: input.id,
        _to_status: input.to,
        _reason: input.reason ?? undefined,
        _reference: input.reference ?? undefined,
        _payment_date: input.paymentDate ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: (_r, input) => {
      qc.invalidateQueries({ queryKey: PAYROLL_FINANCE_KEY })
      if (input.to === 'paid') {
        qc.invalidateQueries({ queryKey: TREASURY_KEY })
        toast.success('Disbursement recorded')
      } else if (input.to === 'approved') {
        toast.success('Approved for payment. No money has moved yet.')
      } else {
        toast.success(`Disbursement ${input.to.replace('_', ' ')}`)
      }
    },
    onError: (e) => toast.error(describePayrollError(e)),
  })
}
