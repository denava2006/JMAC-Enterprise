import type { UserRole } from '@/lib/enums'
import { ROLE_LABEL } from '@/lib/roles'
import { hasAnyManagerAssignment, type PosAccess } from '@/lib/portals'

/**
 * A short badge for the signed-in person's operational role.
 *
 * DISPLAY ONLY. Nothing may branch on this. Authorization lives in the database
 * and in the route guards; a label that starts deciding things is a label that
 * will eventually disagree with them.
 *
 * POS roles are not profile roles. A POS Manager and a Cashier both carry
 * role 'employee', and what separates them is pos_branch_assignments -- so the
 * badge has to look there rather than at the role alone.
 */
export interface RoleBadge {
  short: string
  full: string
}

const SHORT: Record<UserRole, string> = {
  admin: 'ADM',
  hr_manager: 'HRM',
  hr_staff: 'HRS',
  finance_manager: 'FM',
  finance_staff: 'FS',
  accountant: 'ACC',
  employee: 'EMP',
}

export function roleBadge(
  role: UserRole | null | undefined,
  pos?: PosAccess | null,
): RoleBadge | null {
  if (!role) return null

  // Only a plain employee is described by their POS assignment. An
  // Administrator's branch reach comes from being an admin rather than from an
  // assignment, and badging a Finance Manager who also works a till as
  // "Cashier" would hide the more consequential of the two roles behind the
  // lesser one.
  if (role === 'employee' && pos && pos.assignments.length > 0) {
    return hasAnyManagerAssignment(pos)
      ? { short: 'POSM', full: 'POS Manager' }
      : { short: 'POSC', full: 'Cashier' }
  }

  return { short: SHORT[role], full: ROLE_LABEL[role] }
}
