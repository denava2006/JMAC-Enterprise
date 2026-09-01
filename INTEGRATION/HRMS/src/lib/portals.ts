import type { PosRole, UserRole } from '@/lib/enums'

/** The three separate areas of the system. Each has its own layout, its own
 * sidebar, and its own landing route -- a cashier at a till and an HR Manager
 * approving payroll are doing unrelated jobs and should not share a menu. */
export type PortalKey = 'admin' | 'pos' | 'finance' | 'employee'

export interface Portal {
  key: PortalKey
  /** Shown in the portal switcher. */
  label: string
  /** Where this portal starts. */
  path: string
}

export const PORTALS: Record<PortalKey, Portal> = {
  admin: { key: 'admin', label: 'Human Resources', path: '/dashboard' },
  // Straight to the selling screen. A cashier signing in wants the till, not a
  // landing page describing that a till exists.
  // '/pos', not a specific screen: the index route decides where POS staff
  // land, because a cashier wants the till and a manager wants their dashboard.
  // Keeping that test in one place means defaultPortalPath() needs to know
  // nothing about POS roles.
  pos: { key: 'pos', label: 'Point of Sale', path: '/pos' },
  // Employee self-service lives under /dashboard with its own navigation
  // (see Sidebar's employeeNav) rather than a separate route root. It is still
  // a distinct portal -- an employee never sees an HR module -- the separation
  // is just enforced by role-gated routes instead of a different path prefix.
  // Its own landing route, not '/dashboard'. An HR Manager holds both this and
  // the back office, and two portals sharing one path cannot be switched
  // between or told apart in the switcher.
  // Finance is a portal like the others, not a separate application. Same
  // shell, same sidebar grammar, same switcher -- somebody moving between
  // Human Resources, the till and Finance stays inside JMAC Enterprise.
  finance: { key: 'finance', label: 'Finance', path: '/fms' },
  employee: { key: 'employee', label: 'My Workspace', path: '/dashboard/my-dashboard' },
}

/** The order a landing portal is chosen in when someone holds more than one.
 * POS before employee so a cashier lands at the till rather than on their own
 * payslips. */
const PORTAL_PRIORITY: PortalKey[] = ['admin', 'pos', 'finance', 'employee']

/** One POS assignment: a role AT a branch. The pair is the unit -- see
 * PosAccess for why it is never flattened. */
export interface PosAssignment {
  branchId: string
  role: PosRole
}

/** What the account can reach in the POS, resolved from the database. */
export interface PosAccess {
  /** True for an Administrator (every branch) or anyone holding an active
   * assignment. Mirrors public.has_pos_access(). */
  hasAccess: boolean
  /** Branches from pos_branch_assignments. Empty for an Administrator, whose
   * access is not branch-scoped -- never read this as "no branches" without
   * checking `hasAccess` first. */
  branchIds: string[]
  /**
   * The (branch, role) pairs, from public.my_pos_assignments().
   *
   * Kept as pairs on purpose. Somebody can be a Manager at one branch and a
   * Cashier at another, and collapsing that to a single "is a manager" flag
   * would offer them manager tools at the branch where they are a cashier.
   * Navigation may ask whether a manager role exists anywhere; anything
   * branch-sensitive must ask about the branch in hand.
   */
  assignments: PosAssignment[]
}

export const NO_POS_ACCESS: PosAccess = { hasAccess: false, branchIds: [], assignments: [] }

/* ------------------------------------------------------- reading the roles */

/** The role this account holds at one branch, or undefined. Administrators
 * hold no assignment rows, so this is undefined for them -- their reach comes
 * from profiles.role and is answered by is_admin()/has_pos_role(). */
export function roleForBranch(pos: PosAccess, branchId: string | undefined): PosRole | undefined {
  if (!branchId) return undefined
  return pos.assignments.find((a) => a.branchId === branchId)?.role
}

export function isPosManagerAt(pos: PosAccess, branchId: string | undefined): boolean {
  return roleForBranch(pos, branchId) === 'manager'
}

export function managerBranchIds(pos: PosAccess): string[] {
  return pos.assignments.filter((a) => a.role === 'manager').map((a) => a.branchId)
}

export function cashierBranchIds(pos: PosAccess): string[] {
  return pos.assignments.filter((a) => a.role === 'cashier').map((a) => a.branchId)
}

/** Whether manager-specific navigation is worth showing at all. Deliberately
 * NOT an authorization answer: what someone may do at a given branch is
 * `isPosManagerAt`, and what they may actually do is the database. */
export function hasAnyManagerAssignment(pos: PosAccess): boolean {
  return pos.assignments.some((a) => a.role === 'manager')
}

/* ------------------------------------------------------------- the portals */

/**
 * Which portals this account holds.
 *
 * An Administrator holds the back office and nothing else, stated explicitly
 * rather than left to the fact that admins usually have no assignment row. They
 * administer the parent system, and the POS modules they need are in their own
 * sidebar -- switching workspaces would hide HR from them, which is backwards
 * for the system that owns everything else. A stray historical assignment must
 * not bring the switcher back.
 *
 * For everyone else the POS comes from an actual assignment, which is the same
 * rule the database applies.
 */
/** The finance roles, as they appear on a profile. Access still requires an
 *  active grant behind the role -- this only decides whether the portal is
 *  offered at all. */
const FINANCE_ROLES = ['finance_staff', 'finance_manager', 'accountant']

export function isFinanceRole(role: UserRole | undefined): boolean {
  return !!role && FINANCE_ROLES.includes(role)
}

export function portalsFor(
  role: UserRole | undefined,
  pos: PosAccess,
  /** Whether this account is linked to an employee record. Self-service is
   *  about a person's own employment, so this -- not their role -- is what
   *  decides whether they have any. */
  hasEmployeeRecord = false
): PortalKey[] {
  const held: PortalKey[] = []

  if (role === 'admin') {
    held.push('admin')
    // Administrators are usually not employees, and the ESS pages would have
    // no record to read. One who IS an employee keeps their own self-service
    // rather than being the single role that cannot see its own payslip.
    if (hasEmployeeRecord) held.push('employee')
    return held
  }

  if (role === 'hr_manager' || role === 'hr_staff') held.push('admin')
  if (pos.assignments.length > 0) held.push('pos')
  // The role on the profile is only ever written alongside a grant, and the
  // database refuses to authorize one without the other -- so offering the
  // portal on the role is offering it to somebody the server will admit.
  if (isFinanceRole(role)) held.push('finance')

  // Additive, deliberately. HR staff and cashiers are employees who also do a
  // privileged job; their own attendance, leave and payslips do not stop
  // existing because they were granted HR privilege, and losing that privilege
  // must not take their employment records with it.
  //
  // The employee record is the whole condition, including for role 'employee'.
  // Granting the portal on the role alone contradicted the route guard, which
  // asks for employment: an employee-role account with no linked record was
  // landed on self-service, refused there, sent to /home, and landed on
  // self-service again -- a redirect loop. The portal and the guard have to be
  // answering the same question.
  if (hasEmployeeRecord) held.push('employee')

  return held
}

export function availablePortals(
  role: UserRole | undefined,
  pos: PosAccess,
  hasEmployeeRecord = false
): Portal[] {
  const held = portalsFor(role, pos, hasEmployeeRecord)
  return PORTAL_PRIORITY.filter((key) => held.includes(key)).map((key) => PORTALS[key])
}

export function canAccessPortal(
  role: UserRole | undefined,
  pos: PosAccess,
  portal: PortalKey,
  hasEmployeeRecord = false
): boolean {
  return portalsFor(role, pos, hasEmployeeRecord).includes(portal)
}

/** Where to send someone immediately after sign-in.
 *
 * This is the whole reason /home exists. The login form cannot answer it: when
 * the password is accepted the profile and POS queries have not resolved yet,
 * so a cashier would be computed into the back office and then bounced out of
 * it. Under ProtectedRoute both are loaded before the decision is made. */
export function defaultPortalPath(
  role: UserRole | undefined,
  pos: PosAccess,
  hasEmployeeRecord = false
): string {
  const held = portalsFor(role, pos, hasEmployeeRecord)
  const landing = PORTAL_PRIORITY.find((key) => held.includes(key))
  // No portal at all (an inactive or half-provisioned account) still needs
  // somewhere to go. /dashboard renders its own "nothing to show you" state,
  // which is more useful than a blank screen or a redirect loop.
  return landing ? PORTALS[landing].path : PORTALS.admin.path
}

/** Which portal a path belongs to, for marking the switcher. */
export function portalForPath(pathname: string): PortalKey {
  if (pathname === '/pos' || pathname.startsWith('/pos/')) return 'pos'
  if (pathname === '/fms' || pathname.startsWith('/fms/')) return 'finance'
  // Self-service lives under /dashboard but is a separate context: "My
  // Attendance" is this person's own record, "Attendance" is the organization's.
  // The prefix is what tells the two apart for navigation and the switcher.
  if (pathname.startsWith(`${ESS_PREFIX}`)) return 'employee'
  return 'admin'
}

/** Everything under here is somebody's own record rather than the
 *  organization's. Shared so the routes, the sidebar and the switcher cannot
 *  disagree about which pages are self-service. */
export const ESS_PREFIX = '/dashboard/my-'
