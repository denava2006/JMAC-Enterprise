import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Tables, TablesInsert, TablesUpdate } from '@/lib/database.types'
import { toast } from '@/components/ui/sonner'
import { describeFinanceError } from './useFinanceMasterData'
import type { RequestStatus } from '@/lib/financeRequests'

export type FinanceRequest = Tables<'finance_requests'>
export type RequestApproval = Tables<'finance_request_approvals'>
export type RequestAttachment = Tables<'finance_request_attachments'>

export const REQUEST_KEYS = {
  all: ['finance', 'requests'] as const,
  mine: ['finance', 'requests', 'mine'] as const,
  one: (id: string) => ['finance', 'requests', id] as const,
  trail: (id: string) => ['finance', 'requests', id, 'trail'] as const,
}

const SELECT =
  '*, vendors(name), finance_categories(name), budgets(name), finance_accounts(name), profiles!finance_requests_requester_id_fkey(full_name)'

export interface FinanceRequestRow extends FinanceRequest {
  vendors: { name: string } | null
  finance_categories: { name: string } | null
  budgets: { name: string } | null
  finance_accounts: { name: string } | null
  profiles: { full_name: string | null } | null
}

/** Everything the signed-in person is allowed to see. RLS decides whether that
 *  is "my requests" or "all of them" — the query does not have to ask. */
export function useFinanceRequests() {
  return useQuery({
    queryKey: REQUEST_KEYS.all,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('finance_requests')
        .select(SELECT)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data as unknown as FinanceRequestRow[]
    },
  })
}

export function useFinanceRequest(id: string | undefined) {
  return useQuery({
    queryKey: REQUEST_KEYS.one(id ?? 'none'),
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('finance_requests')
        .select(SELECT)
        .eq('id', id!)
        .maybeSingle()
      if (error) throw error
      return data as unknown as FinanceRequestRow | null
    },
  })
}

/** Who decided what, and when. Read-only by construction. */
export function useRequestTrail(id: string | undefined) {
  return useQuery({
    queryKey: REQUEST_KEYS.trail(id ?? 'none'),
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('finance_request_approvals')
        .select('*, profiles(full_name)')
        .eq('request_id', id!)
        .order('created_at')
      if (error) throw error
      return data as unknown as (RequestApproval & { profiles: { full_name: string | null } | null })[]
    },
  })
}

function useRequestMutation<TInput>(
  run: (input: TInput) => Promise<void>,
  success: string,
  extraKeys: readonly (readonly unknown[])[] = [],
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REQUEST_KEYS.all })
      queryClient.invalidateQueries({ queryKey: ['finance', 'budgets'] })
      for (const key of extraKeys) queryClient.invalidateQueries({ queryKey: key })
      toast.success(success)
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

export function useCreateFinanceRequest() {
  return useRequestMutation<TablesInsert<'finance_requests'>>(async (values) => {
    const { error } = await supabase.from('finance_requests').insert(values)
    if (error) throw error
  }, 'Request saved as a draft.')
}

/**
 * Amend a draft or returned request.
 *
 * The row count is checked rather than trusted: a request that has moved on is
 * outside the requester's UPDATE policy, so PostgREST returns success with an
 * empty result. Treating that as saved would tell somebody their correction went
 * through when the database ignored it.
 */
export function useUpdateFinanceRequest() {
  return useRequestMutation<{ id: string; values: TablesUpdate<'finance_requests'> }>(
    async ({ id, values }) => {
      const { data, error } = await supabase
        .from('finance_requests')
        .update(values)
        .eq('id', id)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) {
        throw new Error('This request has already moved on, so it can no longer be edited.')
      }
    },
    'Request updated.',
  )
}

export interface TransitionInput {
  requestId: string
  to: RequestStatus
  remarks?: string | null
}

/** The one door. Every move goes through the database's transition function,
 *  which decides whether this person may make this move from this status. */
export function useTransitionRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: TransitionInput) => {
      const { error } = await supabase.rpc('transition_finance_request', {
        _request_id: input.requestId,
        _to_status: input.to,
        _remarks: input.remarks ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: REQUEST_KEYS.all })
      queryClient.invalidateQueries({ queryKey: REQUEST_KEYS.one(input.requestId) })
      queryClient.invalidateQueries({ queryKey: REQUEST_KEYS.trail(input.requestId) })
      queryClient.invalidateQueries({ queryKey: ['finance', 'budgets'] })
      toast.success(TRANSITION_TOAST[input.to] ?? 'Request updated.')
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

const TRANSITION_TOAST: Partial<Record<RequestStatus, string>> = {
  pending_validation: 'Submitted to Finance.',
  pending_approval: 'Validated and sent to the Finance Manager.',
  approved: 'Approved. The amount is now reserved against the budget.',
  returned: 'Returned for revision.',
  rejected: 'Request rejected.',
  cancelled: 'Request cancelled.',
}
