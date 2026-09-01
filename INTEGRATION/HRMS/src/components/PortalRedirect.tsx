import { Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { defaultPortalPath } from '@/lib/portals'

/**
 * `/home` -- the one hop every sign-in goes through.
 *
 * It exists because the login form cannot answer "which portal?". At the moment
 * the password is accepted, the profile and POS-access queries have not
 * resolved, so a cashier would be computed into the back office and then
 * bounced straight out of it. This route sits inside ProtectedRoute, so by the
 * time it renders both are loaded and the answer is knowable.
 *
 * It is also what stops one user's route deciding the next user's portal: there
 * is no remembered path here, only the account that is signed in right now.
 */
export function PortalRedirect() {
  const { profile, posAccess } = useAuth()
  return <Navigate to={defaultPortalPath(profile?.role, posAccess, !!profile?.employee_id)} replace />
}
