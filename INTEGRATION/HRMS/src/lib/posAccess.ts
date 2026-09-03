import type { PosRole, UserRole } from '@/lib/enums'
import { errorMessage } from '@/lib/errorMessage'

/**
 * The decisions behind the POS Access admin screen, kept out of the component
 * so they can be tested without a database or a router.
 *
 * The database is the real enforcement -- pos_branch_assignments is
 * Administrator-only through RLS, and has_pos_role() re-checks the profile is
 * still active on every call. Nothing here is a security boundary; it exists so
 * the UI never offers an action the database would only refuse.
 */

/** Offered in the grant dialog, cashier first: it is the common case. */
export const POS_ROLES = ['cashier', 'manager'] as const satisfies readonly PosRole[]

export const POS_ROLE_LABEL: Record<PosRole, string> = {
  cashier: 'Cashier',
  // "POS Manager" rather than "Manager" so a row can never be misread as the
  // HR Manager role -- they are different authorization domains that happen to
  // share a word.
  manager: 'POS Manager',
}

/** Mirrors public.account_status, which pos_branch_assignments reuses. */
export type AssignmentStatus = 'active' | 'inactive'

export const STATUS_FILTERS = ['all', 'active', 'inactive'] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]

export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'All',
  active: 'Active',
  // "Revoked", not "Inactive": the badge on the row already says Revoked, and
  // two words for one state on the same screen reads as two different things.
  inactive: 'Revoked',
}

/** The badge says "Revoked" while the filter says "Inactive": the filter names
 * the column value, the badge names what actually happened to the person. */
export const ASSIGNMENT_STATUS_LABEL: Record<AssignmentStatus, string> = {
  active: 'Active',
  inactive: 'Revoked',
}

export interface ProfileOption {
  id: string
  full_name: string
  email: string
  role: UserRole
  status: AssignmentStatus
}

export interface BranchOption {
  id: string
  name: string
  is_active: boolean
}

/**
 * An Administrator's POS access comes from profiles.role and covers every
 * branch, so giving them an assignment row would put the same fact in two
 * places -- exactly what 20260813000000_pos_branch_assignments.sql left
 * pos_role without an 'admin' value to avoid. They are therefore never
 * offered.
 *
 * Inactive profiles are excluded too. An assignment against one is dead on
 * arrival: has_pos_role() joins profiles and requires status = 'active', so the
 * row would grant nothing while looking like it had.
 */
export function assignableProfiles<T extends ProfileOption>(profiles: T[]): T[] {
  return profiles.filter((profile) => profile.role !== 'admin' && profile.status === 'active')
}

/** True when this account reaches the POS without any assignment row. */
export function hasImplicitPosAccess(role: UserRole | undefined): boolean {
  return role === 'admin'
}

/**
 * Branches this person can still be granted.
 *
 * pos_branch_assignments_active_unique allows only one *active* row per
 * (profile, branch), so a branch they already work is removed rather than
 * offered and then rejected. Revoked history does not block a re-grant, which
 * is why only active assignments are passed in.
 */
export function grantableBranches<T extends BranchOption>(
  branches: T[],
  activeBranchIdsForProfile: string[]
): T[] {
  return branches.filter((branch) => branch.is_active && !activeBranchIdsForProfile.includes(branch.id))
}

/** The branches a person currently holds, from the full assignment list. */
export function activeBranchIdsFor(
  assignments: { profile_id: string; branch_id: string; status: AssignmentStatus }[],
  profileId: string | undefined
): string[] {
  if (!profileId) return []
  return assignments
    .filter((a) => a.profile_id === profileId && a.status === 'active')
    .map((a) => a.branch_id)
}

export function filterByStatus<T extends { status: AssignmentStatus }>(
  rows: T[],
  filter: StatusFilter
): T[] {
  return filter === 'all' ? rows : rows.filter((row) => row.status === filter)
}

/**
 * Is there already an active assignment for this person at this branch?
 *
 * A revoked row keeps offering "Grant again" forever, which reads as though
 * the person has no access -- even when a newer active row for the same branch
 * is sitting a few lines above it. The database refuses the duplicate either
 * way (pos_branch_assignments_active_unique), so this changes no permission;
 * it stops the screen from inviting an action that cannot succeed and implying
 * a state that is not true.
 */
export function hasActiveAssignmentAt(
  rows: { profile_id: string; branch_id: string; status: AssignmentStatus }[],
  profileId: string,
  branchId: string
): boolean {
  return rows.some(
    (row) =>
      row.profile_id === profileId && row.branch_id === branchId && row.status === 'active'
  )
}

export function countByStatus(rows: { status: AssignmentStatus }[]): Record<StatusFilter, number> {
  return {
    all: rows.length,
    active: rows.filter((row) => row.status === 'active').length,
    inactive: rows.filter((row) => row.status === 'inactive').length,
  }
}

/**
 * Postgres speaks in constraint names. The three failures reachable from this
 * screen each get the sentence that says what to do next, following
 * useBranches' precedent for foreign-key errors.
 */
export function describeAssignmentError(error: unknown): string {
  const message = errorMessage(error)

  if (message.includes('pos_branch_assignments_active_unique')) {
    return 'That person already has active POS access at this branch. Revoke it first, then grant the new role.'
  }
  if (message.includes('row-level security policy')) {
    return 'Only an Administrator can change POS access.'
  }
  if (message.includes('violates foreign key constraint')) {
    return 'That account or branch no longer exists. Refresh the page and try again.'
  }
  return message || 'Something went wrong. Please try again.'
}
