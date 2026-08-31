import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { SystemAccessSelection } from '@/lib/workforce'
import type { Json } from '@/lib/database.types'
import type { ChangeRequestOperation, ChangeRequestStatus } from '@/lib/enums'
import { useAuth } from '@/contexts/AuthContext'
import { toast } from '@/components/ui/sonner'

/** Reference-data modules that go through HR Manager review. Salary grades are
 * absent on purpose — they're manager-controlled outright, with no
 * staff-authored path at all. */
export type ChangeRequestTable = 'departments' | 'positions' | 'work_schedules'

/** Re-exported from the shared enum module so the historical import path keeps
 * working. Both were hand-written string unions until the generated-type
 * cleanup: they matched the database, but nothing would have failed if they
 * stopped matching. Deriving them from the enum makes a future migration break
 * compilation instead. (`ChangeRequestTable` above stays a hand-written union
 * on purpose -- it is not a database enum but a domain rule about which
 * reference tables go through review.) */
export type { ChangeRequestOperation, ChangeRequestStatus }

export const CHANGE_TARGET_LABEL: Record<ChangeRequestTable, string> = {
  departments: 'Department',
  positions: 'Position',
  work_schedules: 'Work Schedule',
}

export const CHANGE_OPERATION_LABEL: Record<ChangeRequestOperation, string> = {
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
}

export interface ChangeRequest {
  id: string
  target_table: ChangeRequestTable
  operation: ChangeRequestOperation
  target_id: string | null
  payload: Record<string, unknown>
  summary: string
  status: ChangeRequestStatus
  requested_by: string
  requested_at: string
  reviewed_by: string | null
  reviewed_at: string | null
  rejection_reason: string | null
  requester: { full_name: string } | null
  reviewer: { full_name: string } | null
}

const KEY = ['change-requests']

const SELECT = `
  *,
  requester:profiles!change_requests_requested_by_fkey (full_name),
  reviewer:profiles!change_requests_reviewed_by_fkey (full_name)
`

export function useChangeRequests(status?: ChangeRequestStatus) {
  return useQuery({
    queryKey: [...KEY, status ?? 'all'],
    queryFn: async () => {
      let q = supabase.from('change_requests').select(SELECT).order('requested_at', { ascending: false })
      if (status) q = q.eq('status', status)
      const { data, error } = await q
      if (error) throw error
      return data as unknown as ChangeRequest[]
    },
  })
}

export function usePendingChangeRequestCount() {
  return useQuery({
    queryKey: [...KEY, 'pending-count'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('change_requests')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending')
      if (error) throw error
      return count ?? 0
    },
  })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: KEY })
    // An approved request writes to one of these, so their lists are stale too.
    queryClient.invalidateQueries({ queryKey: ['departments'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['work_schedules'] })
  }
}

export interface SubmitChangeRequestInput {
  targetTable: ChangeRequestTable
  operation: ChangeRequestOperation
  targetId?: string
  payload?: Record<string, unknown>
  summary: string
  /** Proposed position eligibility, applied by the database in the same
   *  transaction that approves the request. Rejecting applies nothing, so a
   *  refused position can never leave an entitlement behind. */
  systemAccess?: SystemAccessSelection | null
}

export function useSubmitChangeRequest() {
  const { profile } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (input: SubmitChangeRequestInput) => {
      if (!profile?.id) throw new Error('You must be signed in to submit a change.')
      const { error } = await supabase.from('change_requests').insert({
        target_table: input.targetTable,
        operation: input.operation,
        target_id: input.targetId ?? null,
        payload: (input.payload ?? {}) as Json,
        summary: input.summary,
        requested_by: profile.id,
        status: 'pending',
        system_access: (input.systemAccess ?? null) as Json,
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidate()
      toast.success('Submitted for HR Manager approval.')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useApproveChangeRequest() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (requestId: string) => {
      const { error } = await supabase.rpc('approve_change_request', { p_request_id: requestId })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      invalidate()
      toast.success('Change approved and applied.')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useRejectChangeRequest() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async ({ requestId, reason }: { requestId: string; reason: string }) => {
      const { error } = await supabase.rpc('reject_change_request', {
        p_request_id: requestId,
        p_reason: reason,
      })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      invalidate()
      toast.success('Change rejected — the author can correct and resubmit.')
    },
    onError: (error) => toast.error(error.message),
  })
}
