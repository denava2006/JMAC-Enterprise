import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from '@/components/ui/sonner'
import { POS_AUDIT_KEY } from '@/lib/posAudit'
import { CATEGORY_SUMMARY_KEY } from '@/hooks/usePosCategorySummary'
import {
  POS_REQUESTS_KEY,
  POS_REQUEST_PAGE_SIZE,
  describeRequestError,
  offsetFor,
  type ManagerRequest,
  type QueuedRequest,
} from '@/lib/posRequests'
import type { PosRequestStatus } from '@/lib/enums'

/**
 * POS inventory and product requests.
 *
 * Every write is an RPC. The table holds no privilege for any API role and
 * defines no RLS policy, so there is no direct path a future edit could reach
 * for — and the requester and reviewer are derived from `auth.uid()` inside the
 * database, never sent from here.
 *
 * None of these mutations touches stock. Approving a restock records a
 * decision; quantity still moves only through `receive_pos_stock`.
 */

const REQUEST_STALE_TIME = 30_000

function useInvalidateRequests() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: POS_REQUESTS_KEY })
    // Every lifecycle transition writes a POS audit event.
    queryClient.invalidateQueries({ queryKey: POS_AUDIT_KEY })
  }
}

/** Active enterprise products this branch does not carry yet -- the picker for
 * a carry request. Manager-gated in the database, and it returns identity and
 * taxonomy only: no price, no cost. */
export function useCarryableProducts(branchId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...POS_REQUESTS_KEY, 'carryable', branchId ?? 'none'],
    enabled: !!branchId && enabled,
    staleTime: REQUEST_STALE_TIME,
    queryFn: async (): Promise<{ product_id: string; product_name: string; category_name: string }[]> => {
      const { data, error } = await supabase.rpc('get_pos_carryable_products', {
        _branch_id: branchId!,
      })
      if (error) throw error
      return (data ?? []) as unknown as { product_id: string; product_name: string; category_name: string }[]
    },
  })
}

export function useManagerRequests(
  branchId: string | undefined,
  status: PosRequestStatus | undefined,
  page: number
) {
  return useQuery({
    queryKey: [...POS_REQUESTS_KEY, 'manager', branchId ?? 'none', status ?? 'any', page],
    enabled: !!branchId,
    staleTime: REQUEST_STALE_TIME,
    queryFn: async (): Promise<ManagerRequest[]> => {
      const { data, error } = await supabase.rpc('get_pos_manager_requests', {
        _branch_id: branchId!,
        _status: status,
        _limit: POS_REQUEST_PAGE_SIZE,
        _offset: offsetFor(page),
      })
      if (error) throw error
      return (data ?? []) as unknown as ManagerRequest[]
    },
  })
}

/** The review queue. Named for the job rather than the role: when FMS takes
 * over restock demand review it calls this same function. */
export function useRequestQueue(
  branchId: string | undefined,
  status: PosRequestStatus | undefined,
  page: number
) {
  return useQuery({
    queryKey: [...POS_REQUESTS_KEY, 'queue', branchId ?? 'all', status ?? 'any', page],
    staleTime: REQUEST_STALE_TIME,
    queryFn: async (): Promise<QueuedRequest[]> => {
      const { data, error } = await supabase.rpc('get_pos_request_queue', {
        _branch_id: branchId,
        _status: status,
        _limit: POS_REQUEST_PAGE_SIZE,
        _offset: offsetFor(page),
      })
      if (error) throw error
      return (data ?? []) as unknown as QueuedRequest[]
    },
  })
}

export function useCreateStockRequest() {
  const invalidate = useInvalidateRequests()
  return useMutation({
    mutationFn: async (input: {
      branchId: string
      productId: string
      quantity: number
      reason: string
    }) => {
      const { error } = await supabase.rpc('create_pos_stock_request', {
        _branch_id: input.branchId,
        _product_id: input.productId,
        _requested_quantity: input.quantity,
        _reason: input.reason,
      })
      if (error) throw new Error(describeRequestError(error))
    },
    onSuccess: () => {
      invalidate()
      toast.success('Request submitted for review')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useCreateCarryRequest() {
  const invalidate = useInvalidateRequests()
  return useMutation({
    mutationFn: async (input: { branchId: string; productId: string; reason: string }) => {
      const { error } = await supabase.rpc('create_pos_carry_request', {
        _branch_id: input.branchId,
        _product_id: input.productId,
        _reason: input.reason,
      })
      if (error) throw new Error(describeRequestError(error))
    },
    onSuccess: () => {
      invalidate()
      toast.success('Request submitted for review')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useCancelRequest() {
  const invalidate = useInvalidateRequests()
  return useMutation({
    mutationFn: async (requestId: string) => {
      const { error } = await supabase.rpc('cancel_pos_request', { _request_id: requestId })
      if (error) throw new Error(describeRequestError(error))
    },
    onSuccess: () => {
      invalidate()
      toast.success('Request withdrawn')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useReviewRequest() {
  const queryClient = useQueryClient()
  const invalidate = useInvalidateRequests()
  return useMutation({
    mutationFn: async (input: { requestId: string; approve: boolean; note: string }) => {
      const { error } = input.approve
        ? await supabase.rpc('approve_pos_request', {
            _request_id: input.requestId,
            _note: input.note.trim() || undefined,
          })
        : await supabase.rpc('decline_pos_request', {
            _request_id: input.requestId,
            _note: input.note,
          })
      if (error) throw new Error(describeRequestError(error))
      return input.approve
    },
    onSuccess: (approved) => {
      invalidate()
      // Approving a carry request creates the branch listing, so the catalogue
      // summary is now stale. Nothing here invalidates inventory quantities,
      // because no approval changes one.
      if (approved) {
        queryClient.invalidateQueries({ queryKey: CATEGORY_SUMMARY_KEY })
        queryClient.invalidateQueries({ queryKey: ['pos-catalogue'] })
      }
      toast.success(approved ? 'Request approved' : 'Request declined')
    },
    onError: (error) => toast.error(error.message),
  })
}
