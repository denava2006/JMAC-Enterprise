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
  /** Whether this location appears on the public landing page. Separate from
   *  is_active on purpose: a warehouse or an unopened site is operationally
   *  real and is not a public address. */
  show_on_landing: boolean
  /** Object path in the public branch-images bucket. */
  image_path: string | null
  /** Public ordering, lowest first, name breaking ties. */
  display_order: number
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

/**
 * Putting a photograph of a branch where the public page can read it.
 *
 * branch-images is the one public bucket in this system. Everything else here
 * holds somebody's documents and is read through a signed URL; a shopfront
 * photograph is published on purpose, to visitors who are not logged in and
 * cannot be, so public read is the honest posture and a signed link would only
 * expire while somebody was looking at it.
 *
 * Write is not public. The bucket's policies admit an Administrator alone, and
 * its own limits refuse anything that is not a reasonably sized image, so the
 * browser sending the file is never the thing being trusted.
 *
 * Filed under the branch id and suffixed, so replacing a photograph does not
 * leave the old one being served from a cached URL.
 */
export function useUploadBranchImage() {
  return useMutation({
    mutationFn: async ({ branchId, file }: { branchId: string; file: File }) => {
      const extension = (file.name.split('.').pop() ?? 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase()
      const path = `${branchId}/${Date.now()}.${extension || 'jpg'}`
      const { error } = await supabase.storage.from('branch-images').upload(path, file, {
        contentType: file.type,
        upsert: false,
      })
      if (error) throw error
      return path
    },
    onError: (error: Error) => toast.error(error.message),
    onSuccess: () => toast.success('Photograph uploaded. Save the branch to publish it.'),
  })
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
      show_on_landing,
      image_path,
      display_order,
    }: {
      id?: string
      name: string
      address?: string
      phone?: string
      latitude?: number | null
      longitude?: number | null
      show_on_landing?: boolean
      image_path?: string | null
      display_order?: number
    }) => {
      const payload = {
        name,
        address: address || null,
        phone: phone || null,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        show_on_landing: show_on_landing ?? false,
        image_path: image_path ?? null,
        display_order: display_order ?? 0,
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
