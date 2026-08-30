import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from '@/components/ui/sonner'
import {
  WORKFORCE_KEY,
  describeWorkforceError,
  groupEntitlements,
  type EligibleEmployee,
  type NoncompliantAssignment,
  type PositionEntitlementRow,
} from '@/lib/workforce'
import type { EntitlementSystem, PosRole } from '@/lib/enums'

/**
 * Workforce eligibility reads and writes.
 *
 * Every one of these is an RPC. In particular the candidate list is
 * `get_eligible_pos_employees` and not a `profiles` query with a client-side
 * filter: the database decides who may be offered, so a modified client cannot
 * widen the list.
 */

const WORKFORCE_STALE_TIME = 30_000

/** Who may be given this POS role at this branch. Excludes anyone who already
 * holds an active assignment there, which would only be a duplicate. */
export function useEligiblePosEmployees(branchId: string | undefined, role: PosRole | undefined) {
  return useQuery({
    queryKey: [...WORKFORCE_KEY, 'eligible', branchId ?? 'none', role ?? 'none'],
    enabled: !!branchId && !!role,
    staleTime: WORKFORCE_STALE_TIME,
    queryFn: async (): Promise<EligibleEmployee[]> => {
      const { data, error } = await supabase.rpc('get_eligible_pos_employees', {
        _branch_id: branchId!,
        _role_code: role!,
      })
      if (error) throw error
      return (data ?? []) as unknown as EligibleEmployee[]
    },
  })
}

/** Active assignments whose holder is no longer eligible, with the reason. */
export function useNoncompliantAssignments() {
  return useQuery({
    queryKey: [...WORKFORCE_KEY, 'noncompliant'],
    staleTime: WORKFORCE_STALE_TIME,
    queryFn: async (): Promise<NoncompliantAssignment[]> => {
      const { data, error } = await supabase.rpc('get_noncompliant_pos_assignments')
      if (error) throw error
      return (data ?? []) as unknown as NoncompliantAssignment[]
    },
  })
}

export function usePositionEntitlements() {
  return useQuery({
    queryKey: [...WORKFORCE_KEY, 'entitlements'],
    staleTime: WORKFORCE_STALE_TIME,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_position_entitlements')
      if (error) throw error
      return groupEntitlements((data ?? []) as unknown as PositionEntitlementRow[])
    },
  })
}

export function useSetPositionEntitlement() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      positionId: string
      system: EntitlementSystem
      roleCode: string
      granted: boolean
    }) => {
      const { error } = await supabase.rpc('set_position_entitlement', {
        _position_id: input.positionId,
        _system: input.system,
        _role_code: input.roleCode,
        _granted: input.granted,
      })
      if (error) throw new Error(describeWorkforceError(error))
      return input.granted
    },
    onSuccess: (granted) => {
      queryClient.invalidateQueries({ queryKey: WORKFORCE_KEY })
      // Removing an entitlement does not revoke live assignments; they stop
      // authorizing immediately and surface on the compliance list, so the
      // Administrator closes them deliberately rather than by side effect.
      queryClient.invalidateQueries({ queryKey: ['pos-assignments'] })
      toast.success(granted ? 'Eligibility granted' : 'Eligibility removed')
    },
    onError: (error) => toast.error(error.message),
  })
}
