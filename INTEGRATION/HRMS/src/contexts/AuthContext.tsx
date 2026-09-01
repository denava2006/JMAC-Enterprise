import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Database } from '@/lib/database.types'
import { NO_POS_ACCESS, type PosAccess } from '@/lib/portals'
import type { PosRole } from '@/lib/enums'

type Profile = Database['public']['Tables']['profiles']['Row']

interface AuthContextValue {
  session: Session | null
  profile: Profile | null
  /** Which POS branches this account may act in, if any. Loaded alongside the
   * profile so route guards can stay synchronous. */
  posAccess: PosAccess
  /** True while the initial session is being restored on page load. */
  initializing: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  /** Re-read the profile for the current session.
   *
   *  Needed after the account changes underneath the client: setting a first
   *  password stamps activated_at from a database trigger, so the cached
   *  profile still says the account is un-activated. Routing on that stale copy
   *  sends the employee straight back to the setup page they just completed. */
  refreshProfile: () => Promise<void>
}

const AuthContext = React.createContext<AuthContextValue | undefined>(undefined)

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single()
  if (error) {
    console.error('Failed to load profile for signed-in user:', error.message)
    return null
  }
  return data
}

/** POS access comes from the database, not from the role.
 *
 * `has_pos_access()` is the authoritative answer (it also covers Administrators,
 * whose access is implicit and branch-unscoped), and `my_pos_assignments()`
 * lists the (branch, role) pairs a non-admin actually holds. Reading both here rather
 * than deriving one from the other keeps the rule in one place -- the database.
 *
 * A failure is reported as no access. Silently granting the POS because a query
 * failed is the wrong way for this to break. */
async function fetchPosAccess(): Promise<PosAccess> {
  const [access, assignments] = await Promise.all([
    supabase.rpc('has_pos_access'),
    supabase.rpc('my_pos_assignments'),
  ])

  if (access.error) {
    console.error('Failed to check POS access:', access.error.message)
    return NO_POS_ACCESS
  }
  if (assignments.error) {
    console.error('Failed to load POS assignments:', assignments.error.message)
  }

  // (branch, role) pairs, not a flattened list of branches: the same person can
  // manage one branch and cash up at another, and the navigation has to tell
  // those apart. `branchIds` is derived from the pairs so nothing can drift.
  const pairs = ((assignments.data ?? []) as { branch_id: string; pos_role: PosRole }[]).map(
    (row) => ({ branchId: row.branch_id, role: row.pos_role })
  )

  return {
    hasAccess: Boolean(access.data),
    branchIds: pairs.map((a) => a.branchId),
    assignments: pairs,
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const [session, setSession] = React.useState<Session | null>(null)
  const [profile, setProfile] = React.useState<Profile | null>(null)
  const [posAccess, setPosAccess] = React.useState<PosAccess>(NO_POS_ACCESS)
  const [initializing, setInitializing] = React.useState(true)

  React.useEffect(() => {
    let isMounted = true

    supabase.auth.getSession().then(async ({ data }) => {
      if (!isMounted) return
      setSession(data.session)
      if (data.session) {
        const [nextProfile, nextPosAccess] = await Promise.all([
          fetchProfile(data.session.user.id),
          fetchPosAccess(),
        ])
        if (!isMounted) return
        setProfile(nextProfile)
        setPosAccess(nextPosAccess)
      }
      setInitializing(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      if (!isMounted) return
      setSession(nextSession)
      if (!nextSession) {
        setProfile(null)
        setPosAccess(NO_POS_ACCESS)
        return
      }
      const [nextProfile, nextPosAccess] = await Promise.all([
        fetchProfile(nextSession.user.id),
        fetchPosAccess(),
      ])
      if (!isMounted) return
      setProfile(nextProfile)
      setPosAccess(nextPosAccess)
    })

    return () => {
      isMounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  const refreshProfile = React.useCallback(async () => {
    const { data } = await supabase.auth.getSession()
    if (!data.session) return
    const [nextProfile, nextPosAccess] = await Promise.all([
      fetchProfile(data.session.user.id),
      fetchPosAccess(),
    ])
    setProfile(nextProfile)
    setPosAccess(nextPosAccess)
  }, [])

  const signIn = React.useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      // Reporting every failure as "wrong password" sends people hunting for
      // a typo when the real problem is that the backend isn't reachable --
      // the Supabase stack isn't running, or VITE_SUPABASE_URL points
      // somewhere dead. Those need very different fixes, so they say so.
      const status = (error as { status?: number }).status
      const isUnreachable =
        status === undefined || status === 0 || status >= 500 || /fetch|network/i.test(error.message)

      if (isUnreachable) {
        return {
          error:
            'Can\u2019t reach the server. Check that Supabase is running (supabase start) and that VITE_SUPABASE_URL is correct.',
        }
      }
      return { error: 'That email and password combination doesn\u2019t match our records.' }
    }

    const activeProfile = await fetchProfile(data.user.id)

    // A deactivated HR/Admin account should not be able to sign in, even with
    // valid credentials (mirrors Admin's "Deactivate HR Account" action).
    if (!activeProfile || activeProfile.status !== 'active') {
      await supabase.auth.signOut()
      return { error: 'This account has been deactivated. Contact your administrator.' }
    }

    void supabase
      .from('profiles')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', data.user.id)
      .then(({ error: updateError }) => {
        if (updateError) console.error('Failed to record last login:', updateError.message)
      })

    setProfile(activeProfile)
    setPosAccess(await fetchPosAccess())
    return { error: null }
  }, [])

  const signOut = React.useCallback(async () => {
    await supabase.auth.signOut()
    setSession(null)
    setProfile(null)
    setPosAccess(NO_POS_ACCESS)
    // Everything cached was fetched as the previous user. Without this the next
    // person to sign in on this machine sees the last one's data flash up
    // before their own queries resolve -- and with the POS portal in play that
    // now includes another branch's till.
    queryClient.clear()
  }, [queryClient])

  const value = React.useMemo(
    () => ({ session, profile, posAccess, initializing, signIn, signOut, refreshProfile }),
    [session, profile, posAccess, initializing, signIn, signOut, refreshProfile]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = React.useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within an AuthProvider')
  return context
}
