import { Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import type { UserRole } from '@/lib/enums'
import { needsPasswordSetup } from '@/lib/passwordSetup'
import { isFinanceRole } from '@/lib/portals'

interface ProtectedRouteProps {
  children: React.ReactNode
  /** Omit to allow any authenticated, active user regardless of role. */
  allowedRoles?: UserRole[]
  /** Require POS access -- an Administrator, or an active assignment in
   * pos_branch_assignments. Role alone never grants it. */
  requirePos?: boolean
  /** Roles that belong somewhere else even though they could technically pass.
   * Used to keep Administrators inside the back office: HRMS/JMAC is the parent
   * system, so its administrator should not be dropped into an operational
   * workspace that hides HR from them. Their POS modules live in their own
   * sidebar instead. */
  blockRoles?: UserRole[]
  /** Require a linked employee record.
   *
   * Self-service is about a person's own employment, so the question is whether
   * they HAVE employment -- not what privilege they hold. Gating these pages by
   * role is what removed self-service from HR staff, who are employees too, and
   * would have handed it to an Administrator with no employee record to read. */
  requireEmployee?: boolean
  /** Require an active finance privilege.
   *
   * A role list would admit anyone whose profile claims a finance role; the
   * database refuses to authorize a role without a grant behind it, so the
   * guard asks the same question rather than a looser one. The server is still
   * the authority -- this only decides what is worth rendering. */
  requireFinance?: boolean
}

export function ProtectedRoute({
  children,
  allowedRoles,
  requirePos,
  blockRoles,
  requireEmployee,
  requireFinance,
}: ProtectedRouteProps) {
  const { session, profile, posAccess, initializing } = useAuth()

  if (initializing) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-secondary"
          role="status"
          aria-label="Loading"
        />
      </div>
    )
  }

  // No `state={{ from: location }}` on purpose. Stashing the path someone was
  // refused at means the *previous* user's route decides where the *next* one
  // lands after signing in on the same machine -- an Administrator bounced off
  // /pos would send the HR Staff who signs in next straight back to it. Every
  // sign-in goes through /home instead, which derives the portal from the
  // account that just authenticated.
  if (!session || !profile) {
    return <Navigate to="/login" replace />
  }

  // An employee still on the password HR handed them has to choose their own
  // before going anywhere. activated_at is null from account creation until the
  // password actually changes, and HR resetting it puts them back here.
  if (needsPasswordSetup(profile)) {
    return <Navigate to="/auth/setup-password" replace />
  }

  // Refusals land on /home rather than /dashboard so the redirect resolves to
  // whichever portal this account actually holds -- sending a cashier who
  // guessed an HR URL to /dashboard would only bounce them again.
  if (requireFinance && !isFinanceRole(profile.role)) {
    return <Navigate to="/home" replace />
  }

  if (requireEmployee && !profile.employee_id) {
    // No employment to show. /home resolves to whatever this account does hold,
    // which for an Administrator is the back office.
    return <Navigate to="/home" replace />
  }

  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    return <Navigate to="/home" replace />
  }

  // Straight to the back office rather than through /home: /home would resolve
  // an Administrator to /dashboard anyway, and saying so directly makes the
  // intent readable at the route.
  if (blockRoles?.includes(profile.role)) {
    return <Navigate to="/dashboard" replace />
  }

  if (requirePos && !posAccess.hasAccess) {
    return <Navigate to="/home" replace />
  }

  return <>{children}</>
}
