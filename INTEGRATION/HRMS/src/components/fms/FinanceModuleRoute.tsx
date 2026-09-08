import { Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { canAccessFinanceModule } from '@/lib/financeModules'

/**
 * A Finance page, refused to roles whose workspace does not contain it.
 *
 * Hiding a sidebar link is housekeeping, not authorization: /fms/ledger typed
 * into the address bar would still have rendered. This asks the same table the
 * sidebar asks, so a module cannot be missing from the menu and reachable by
 * URL at the same time.
 *
 * Refusals land on /fms rather than /home. The person is a Finance user in the
 * right portal who has simply asked for somebody else's page, and bouncing
 * them out of Finance to be resolved back into it is a longer way round to the
 * same place.
 *
 * This decides which pages are worth rendering. It is not what stops a Finance
 * Staff account reading the ledger -- RLS and the RPCs answer that
 * independently and are unchanged.
 */
export function FinanceModuleRoute({
  route,
  children,
}: {
  /** The module's own path, exactly as registered in FINANCE_MODULES. */
  route: string
  children: React.ReactNode
}) {
  const { profile, initializing } = useAuth()

  // The profile arrives a moment after the session. Deciding during that gap
  // would redirect on a role that is merely not loaded yet; the /fms shell
  // above has already shown its spinner.
  if (initializing) return null

  if (!canAccessFinanceModule(profile?.role, route)) {
    return <Navigate to="/fms" replace />
  }

  return <>{children}</>
}
