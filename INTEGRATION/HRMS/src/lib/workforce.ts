import { POS_ROLE_LABEL } from '@/lib/posAccess'
import type { EntitlementSystem, PosRole } from '@/lib/enums'

/**
 * Workforce eligibility: the pure parts.
 *
 * The rule this phase exists to enforce: **your job decides which systems and
 * roles you may legitimately be assigned to.** An IT Support engineer is not a
 * POS Manager, however the assignment screen was used.
 *
 * Three layers stay separate, and nothing here collapses them:
 *
 *   profiles.role                    enterprise / HR identity
 *   pos_branch_assignments.pos_role  the actual branch authorization
 *   position_system_roles            eligibility only
 *
 * Every decision below is the database's. This file labels and shapes what it
 * returns; it never decides who may hold what. A candidate list filtered in
 * React is a candidate list that can be unfiltered in React.
 */

export const WORKFORCE_KEY = ['workforce'] as const

/** What the assignment picker offers. Identity and org placement only — no
 * salary, no pay grade, no personal data. The RPC does not return them, and a
 * contract test asserts its signature. */
export interface EligibleEmployee {
  profile_id: string
  employee_id: string
  full_name: string
  email: string
  employee_number: string | null
  department_name: string
  position_title: string
}

/** An active assignment whose holder is no longer eligible. */
export interface NoncompliantAssignment {
  assignment_id: string
  profile_id: string
  full_name: string
  branch_id: string
  branch_name: string
  pos_role: PosRole
  department_name: string
  position_title: string
  reason: string
}

/** One row per (position, system, role) the database returns; positions with no
 * entitlement come back with nulls. */
export interface PositionEntitlementRow {
  position_id: string
  position_title: string
  department_id: string
  department_name: string
  system: EntitlementSystem | null
  role_code: string | null
}

/** A position with its entitlements collected. */
export interface PositionEntitlements {
  positionId: string
  positionTitle: string
  departmentId: string
  departmentName: string
  pos: PosRole[]
  hrms: string[]
  fms: string[]
}

/** Reuse the established labels rather than defining a second set. posAccess.ts
 * calls the manager role "POS Manager" on purpose, so a row can never be
 * misread as the HR Manager role -- they are different authorization domains
 * that happen to share a word. */
export { POS_ROLE_LABEL }

/** Phase 9A enforces POS only. HRMS and FMS entitlements are configuration for
 * 9B and 9C, shown read-only so the model is legible rather than surprising. */
export const ENFORCED_SYSTEMS: EntitlementSystem[] = ['pos']

export const SYSTEM_LABEL: Record<EntitlementSystem, string> = {
  hrms: 'HRMS',
  pos: 'POS',
  fms: 'Finance (FMS)',
}

export function groupEntitlements(rows: PositionEntitlementRow[]): PositionEntitlements[] {
  const byPosition = new Map<string, PositionEntitlements>()

  for (const row of rows) {
    let entry = byPosition.get(row.position_id)
    if (!entry) {
      entry = {
        positionId: row.position_id,
        positionTitle: row.position_title,
        departmentId: row.department_id,
        departmentName: row.department_name,
        pos: [],
        hrms: [],
        fms: [],
      }
      byPosition.set(row.position_id, entry)
    }
    if (!row.system || !row.role_code) continue
    if (row.system === 'pos') entry.pos.push(row.role_code as PosRole)
    else if (row.system === 'hrms') entry.hrms.push(row.role_code)
    else entry.fms.push(row.role_code)
  }

  return [...byPosition.values()].sort(
    (a, b) =>
      a.departmentName.localeCompare(b.departmentName) ||
      a.positionTitle.localeCompare(b.positionTitle)
  )
}

/** What a position grants, in words. Employee Self-Service is the baseline and
 * is never an entitlement — every employee has it. */
export function describeEligibility(entry: PositionEntitlements): string {
  const parts: string[] = []
  // The labels already carry their system where it matters -- posAccess.ts
  // calls the manager role "POS Manager" so it cannot be read as HR Manager --
  // so no "POS" prefix is added here. The column this appears under is headed
  // "System access", which supplies the context for "Cashier".
  if (entry.pos.length > 0) {
    parts.push(entry.pos.map((r) => POS_ROLE_LABEL[r]).join(' and '))
  }
  if (entry.hrms.length > 0) parts.push(`HRMS ${entry.hrms.join(' and ')}`)
  if (entry.fms.length > 0) parts.push(`Finance ${entry.fms.join(' and ')}`)
  return parts.length > 0 ? parts.join(' · ') : 'Employee self-service only'
}

export function hasPosEligibility(entry: PositionEntitlements, role: PosRole): boolean {
  return entry.pos.includes(role)
}

export function describeWorkforceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')

  // The database's stable codes, turned into something a person can act on.
  if (message.includes('POS_ASSIGNMENT_NOT_ELIGIBLE')) {
    const detail = message.split('POS_ASSIGNMENT_NOT_ELIGIBLE:')[1]?.trim()
    return detail || 'That employee is not eligible for this POS role.'
  }
  if (message.includes('POS_ASSIGNMENT_CLOSED')) {
    return 'That assignment was closed. Grant a new one instead of reopening it.'
  }
  if (message.includes('POSITION_DEPARTMENT_MISMATCH')) {
    const detail = message.split('POSITION_DEPARTMENT_MISMATCH:')[1]?.trim()
    return detail || 'That position does not belong to that department.'
  }
  if (message.includes('POSITION_DEPARTMENT_IN_USE')) {
    const detail = message.split('POSITION_DEPARTMENT_IN_USE:')[1]?.trim()
    return detail || 'Employees still hold that position; move them first.'
  }
  if (message.includes('Only an Administrator')) return message
  if (message.includes('Sign in')) return 'Your session has expired. Sign in again.'
  return message || 'That change could not be saved.'
}
