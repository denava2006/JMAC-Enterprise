import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Tables, TablesInsert, TablesUpdate } from '@/lib/database.types'
import { toast } from '@/components/ui/sonner'
import { WORKFORCE_KEY, describeWorkforceError, type SystemAccessSelection } from '@/lib/workforce'

export type Position = Tables<'positions'> & { departments: { name: string } | null }

const QUERY_KEY = ['positions']

export function usePositions() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('positions')
        .select('*, departments(name)')
        .order('title')
      if (error) throw error
      return data as Position[]
    },
  })
}

/**
 * Create a position and its eligibility in one transaction.
 *
 * Goes through create_position_with_access rather than a plain insert so the
 * position and its System Access land together. Writing them separately would
 * leave a window where the position exists with no entitlement, and would put
 * the entitlement outside whatever approval the position itself went through.
 */
export function useCreatePosition() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      values: TablesInsert<'positions'>
      systemAccess?: SystemAccessSelection | null
    }) => {
      const { error } = await supabase.rpc('create_position_with_access', {
        _title: input.values.title,
        _department_id: input.values.department_id as string,
        _description: (input.values.description as string | null) ?? '',
        _access: (input.systemAccess ?? null) as never,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: WORKFORCE_KEY })
      toast.success('Position created')
    },
    onError: (error) => toast.error(describeWorkforceError(error)),
  })
}

export function useUpdatePosition() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: TablesUpdate<'positions'> }) => {
      const { error } = await supabase.from('positions').update(values).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast.success('Position updated')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useDeletePosition() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('positions').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast.success('Position deleted')
    },
    onError: (error) => {
      if (error.message.includes('violates foreign key constraint')) {
        toast.error('This position is still assigned to employees or job postings.')
        return
      }
      toast.error(error.message)
    },
  })
}
