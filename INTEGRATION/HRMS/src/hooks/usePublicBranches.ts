import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

/**
 * The branches an anonymous visitor may know about.
 *
 * Reads public_branch_locations, never the branches table. The view is the
 * authorization boundary: it carries name, address and coordinates for active
 * branches and nothing else, so there is no set of columns this hook could ask
 * for that would leak an operational field.
 *
 * One query feeds both the cards and the map on the landing page. Two sources
 * would eventually disagree, and the version that disagreed would be whichever
 * one nobody was looking at.
 */
export interface PublicBranch {
  id: string
  name: string
  address: string | null
  latitude: number | null
  longitude: number | null
}

export function usePublicBranches() {
  return useQuery({
    queryKey: ['public', 'branch-locations'],
    queryFn: async (): Promise<PublicBranch[]> => {
      const { data, error } = await supabase
        .from('public_branch_locations')
        .select('id, name, address, latitude, longitude')
        .order('name')
      // Surfaced rather than swallowed. An empty list has to mean "no branches
      // yet", not "the query failed and the section rendered as if it had not".
      if (error) throw error
      return (data ?? []) as PublicBranch[]
    },
    // A branch opening is not a by-the-second fact, and this is the first thing
    // an anonymous visitor loads. One fetch per session is plenty; a refresh
    // picks up whatever the back office changed.
    staleTime: 5 * 60_000,
  })
}
