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

// No profiles embed. profiles is selectable by yourself, by HR and by an
// Administrator -- a finance role is none of those, so the embed came back null
// and every screen said "Unknown requester" about somebody it knew. Names are
// resolved through finance_request_participants instead, which answers only
// "what are these people called" for requests the caller may already read.
const SELECT =
  '*, vendors(name), finance_categories(name), budgets(name), finance_accounts(name)'

export interface FinanceRequestRow extends FinanceRequest {
  vendors: { name: string } | null
  finance_categories: { name: string } | null
  budgets: { name: string } | null
  finance_accounts: { name: string } | null
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
        .select('*')
        .eq('request_id', id!)
        .order('created_at')
      if (error) throw error
      return data as RequestApproval[]
    },
  })
}

/**
 * Names for the people on the requests this account can see.
 *
 * A narrow RPC rather than a profiles read: it returns profile_id and
 * display_name and nothing else, for participants of requests the caller is
 * already allowed to read. Finance gets a name to show without being handed the
 * staff directory.
 */
export function useRequestParticipants() {
  return useQuery({
    queryKey: ['finance', 'request-participants'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('finance_request_participants')
      if (error) throw error
      const names = new Map<string, string>()
      for (const row of data ?? []) {
        if (row.profile_id) names.set(row.profile_id, row.display_name ?? 'Unknown')
      }
      return names
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
      queryClient.invalidateQueries({ queryKey: ['finance', 'request-participants'] })
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
  }, "Draft saved. Submit it when you're ready to send it to Finance.")
}

/**
 * Write it and send it, in that order.
 *
 * Filling in a request form usually means intending to send it, and the old
 * flow made that four steps: save, close, find it again, open it, submit. This
 * is one button.
 *
 * It is still two operations, because it has to be: the browser must not insert
 * a request already in pending_validation. Status belongs to
 * transition_finance_request, which decides whether this person may make this
 * move -- letting the client choose the starting status would hand it the one
 * thing the whole chain exists to keep.
 *
 * So a failure between the two leaves a draft, and says so. Retrying from My
 * Requests submits THAT draft rather than writing a second one; there is no
 * path here that creates two requests from one intention.
 */
export function useCreateAndSubmitRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: TablesInsert<'finance_requests'>) => {
      const { data, error } = await supabase
        .from('finance_requests')
        .insert(values)
        .select('id')
        .single()
      if (error) throw error

      const { error: submitError } = await supabase.rpc('transition_finance_request', {
        _request_id: data.id,
        _to_status: 'pending_validation',
      })
      if (submitError) {
        // The draft exists and is the requester's to submit. Saying it was
        // saved is the difference between "try again" and "type it all again".
        throw new DraftSavedButNotSubmitted()
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REQUEST_KEYS.all })
      queryClient.invalidateQueries({ queryKey: ['finance', 'request-participants'] })
      toast.success('Request submitted to Finance.')
    },
    onError: (error) => {
      toast.error(
        error instanceof DraftSavedButNotSubmitted
          ? 'Your request was saved as a draft but could not be submitted. Open it from My Requests and try again.'
          : describeFinanceError(error),
      )
    },
  })
}

export class DraftSavedButNotSubmitted extends Error {
  constructor() {
    super('draft saved, submission failed')
    this.name = 'DraftSavedButNotSubmitted'
  }
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
      queryClient.invalidateQueries({ queryKey: ['finance', 'request-participants'] })
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
