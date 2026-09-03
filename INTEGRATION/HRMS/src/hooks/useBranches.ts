import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from '@/components/ui/sonner'

export interface Branch {
  id: string
  name: string
  address: string | null
  /** Printed on POS receipts. An enterprise fact about the branch, which is why
   * it lives here rather than in branch_pos_settings. */
  phone: string | null
  /** Decimal degrees, both or neither -- the database refuses a half-set pair.
   *  Null means nobody has located this branch yet, which is a display state
   *  and never an operational one: an unlocated branch trades exactly as it
   *  did before. */
  latitude: number | null
  longitude: number | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface WorkLocation {
  id: string
  branch_id: string | null
  name: string
  description: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

const BRANCHES_KEY = ['branches']
const LOCATIONS_KEY = ['work-locations']

export function useBranches() {
  return useQuery({
    queryKey: BRANCHES_KEY,
    queryFn: async () => {
      const { data, error } = await supabase.from('branches').select('*').order('name')
      if (error) throw error
      return data as unknown as Branch[]
    },
  })
}

export function useWorkLocations(branchId?: string | null) {
  return useQuery({
    queryKey: [...LOCATIONS_KEY, branchId ?? 'all'],
    queryFn: async () => {
      let query = supabase.from('work_locations').select('*').order('name')
      if (branchId) query = query.eq('branch_id', branchId)
      const { data, error } = await query
      if (error) throw error
      return data as unknown as WorkLocation[]
    },
  })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: BRANCHES_KEY })
    queryClient.invalidateQueries({ queryKey: LOCATIONS_KEY })
  }
}

export function useSaveBranch() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async ({
      id,
      name,
      address,
      phone,
      latitude,
      longitude,
    }: {
      id?: string
      name: string
      address?: string
      phone?: string
      latitude?: number | null
      longitude?: number | null
    }) => {
      const payload = {
        name,
        address: address || null,
        phone: phone || null,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
      }
      const { error } = id
        ? await supabase.from('branches').update(payload).eq('id', id)
        : await supabase.from('branches').insert(payload)
      if (error) throw error
      return !!id
    },
    onSuccess: (wasUpdate) => {
      invalidate()
      toast.success(wasUpdate ? 'Branch updated' : 'Branch added')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useDeleteBranch() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('branches').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      invalidate()
      toast.success('Branch removed')
    },
    onError: (error) => {
      if (error.message.includes('violates foreign key constraint')) {
        toast.error('This branch is still referenced by a deployment record.')
        return
      }
      toast.error(error.message)
    },
  })
}

export function useSaveWorkLocation() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async ({
      id,
      branchId,
      name,
      description,
    }: {
      id?: string
      branchId: string
      name: string
      description?: string
    }) => {
      const payload = { branch_id: branchId, name, description: description || null }
      const { error } = id
        ? await supabase.from('work_locations').update(payload).eq('id', id)
        : await supabase.from('work_locations').insert(payload)
      if (error) throw error
      return !!id
    },
    onSuccess: (wasUpdate) => {
      invalidate()
      toast.success(wasUpdate ? 'Work location updated' : 'Work location added')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useDeleteWorkLocation() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('work_locations').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      invalidate()
      toast.success('Work location removed')
    },
    onError: (error) => {
      if (error.message.includes('violates foreign key constraint')) {
        toast.error('This location is still referenced by a deployment record.')
        return
      }
      toast.error(error.message)
    },
  })
}
