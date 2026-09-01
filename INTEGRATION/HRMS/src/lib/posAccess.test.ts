import { describe, expect, it } from 'vitest'
import type { UserRole } from '@/lib/enums'
import {
  ASSIGNMENT_STATUS_LABEL,
  POS_ROLES,
  POS_ROLE_LABEL,
  activeBranchIdsFor,
  assignableProfiles,
  countByStatus,
  describeAssignmentError,
  filterByStatus,
  grantableBranches,
  hasActiveAssignmentAt,
  hasImplicitPosAccess,
  type AssignmentStatus,
  type ProfileOption,
} from '@/lib/posAccess'

function profile(role: UserRole, status: AssignmentStatus = 'active', id = role): ProfileOption {
  return { id, full_name: `${role} person`, email: `${id}@suite.com`, role, status }
}

function assignment(profile_id: string, branch_id: string, status: AssignmentStatus = 'active') {
  return { profile_id, branch_id, status }
}

describe('assignableProfiles', () => {
  it('never offers an Administrator', () => {
    // An admin already reaches every branch through profiles.role. An
    // assignment row would be a second, divergeable answer to the same
    // question.
    const result = assignableProfiles([profile('admin'), profile('employee')])
    expect(result.map((p) => p.role)).toEqual(['employee'])
  })

  it('never offers an inactive profile', () => {
    // has_pos_role() requires profiles.status = 'active', so this row would
    // grant nothing while appearing to.
    const result = assignableProfiles([profile('employee', 'inactive'), profile('hr_staff', 'active')])
    expect(result.map((p) => p.role)).toEqual(['hr_staff'])
  })

  it('offers every other active HR role -- POS access is not an HR role', () => {
    const result = assignableProfiles([
      profile('employee'),
      profile('hr_staff'),
      profile('hr_manager'),
    ])
    expect(result).toHaveLength(3)
  })

  it('returns nothing rather than throwing when there is nobody to assign', () => {
    expect(assignableProfiles([])).toEqual([])
    expect(assignableProfiles([profile('admin'), profile('employee', 'inactive')])).toEqual([])
  })
})

describe('hasImplicitPosAccess', () => {
  it('is true only for an Administrator', () => {
    expect(hasImplicitPosAccess('admin')).toBe(true)
    expect(hasImplicitPosAccess('hr_manager')).toBe(false)
    expect(hasImplicitPosAccess('hr_staff')).toBe(false)
    expect(hasImplicitPosAccess('employee')).toBe(false)
    expect(hasImplicitPosAccess(undefined)).toBe(false)
  })
})

describe('grantableBranches', () => {
  const branches = [
    { id: 'b1', name: 'Main Office', is_active: true },
    { id: 'b2', name: 'Cavite Branch', is_active: true },
    { id: 'b3', name: 'Closed Branch', is_active: false },
  ]

  it('hides a branch the person already works', () => {
    // pos_branch_assignments_active_unique would reject it anyway; better to
    // not offer it than to explain the rejection afterwards.
    expect(grantableBranches(branches, ['b2']).map((b) => b.id)).toEqual(['b1'])
  })

  it('hides inactive branches', () => {
    expect(grantableBranches(branches, []).map((b) => b.id)).toEqual(['b1', 'b2'])
  })

  it('still offers a branch the person was revoked from -- re-granting is allowed', () => {
    // Only *active* assignments are passed in, so revoked history never blocks.
    expect(grantableBranches(branches, []).map((b) => b.id)).toContain('b2')
  })
})

describe('activeBranchIdsFor', () => {
  const rows = [
    assignment('p1', 'b1', 'active'),
    assignment('p1', 'b2', 'inactive'),
    assignment('p2', 'b2', 'active'),
  ]

  it('counts only this person, and only their active rows', () => {
    expect(activeBranchIdsFor(rows, 'p1')).toEqual(['b1'])
  })

  it('is empty when nobody is selected', () => {
    expect(activeBranchIdsFor(rows, undefined)).toEqual([])
  })
})

describe('filterByStatus', () => {
  const rows = [
    { id: '1', status: 'active' as const },
    { id: '2', status: 'inactive' as const },
    { id: '3', status: 'active' as const },
  ]

  it('shows revoked history rather than hiding it', () => {
    expect(filterByStatus(rows, 'all')).toHaveLength(3)
    expect(filterByStatus(rows, 'inactive').map((r) => r.id)).toEqual(['2'])
  })

  it('narrows to active', () => {
    expect(filterByStatus(rows, 'active').map((r) => r.id)).toEqual(['1', '3'])
  })
})

describe('countByStatus', () => {
  it('counts each bucket', () => {
    const counts = countByStatus([{ status: 'active' }, { status: 'inactive' }, { status: 'active' }])
    expect(counts).toEqual({ all: 3, active: 2, inactive: 1 })
  })

  it('handles an empty list', () => {
    expect(countByStatus([])).toEqual({ all: 0, active: 0, inactive: 0 })
  })
})

describe('describeAssignmentError', () => {
  it('explains a duplicate active assignment in terms of what to do next', () => {
    const message = describeAssignmentError(
      new Error('duplicate key value violates unique constraint "pos_branch_assignments_active_unique"')
    )
    expect(message).toContain('already has active POS access')
    expect(message).toContain('Revoke it first')
  })

  it('explains an RLS refusal without leaking the policy name', () => {
    const message = describeAssignmentError(
      new Error('new row violates row-level security policy for table "pos_branch_assignments"')
    )
    expect(message).toBe('Only an Administrator can change POS access.')
  })

  it('explains a dangling profile or branch', () => {
    expect(describeAssignmentError(new Error('violates foreign key constraint'))).toContain(
      'no longer exists'
    )
  })

  it('passes an unrecognised message through rather than swallowing it', () => {
    expect(describeAssignmentError(new Error('connection reset'))).toBe('connection reset')
  })

  it('never returns an empty string', () => {
    expect(describeAssignmentError(null)).toBe('Something went wrong. Please try again.')
    expect(describeAssignmentError(new Error(''))).toBe('Something went wrong. Please try again.')
  })
})

describe('labels', () => {
  it('distinguishes a POS Manager from an HR Manager', () => {
    expect(POS_ROLE_LABEL.manager).toBe('POS Manager')
    expect(POS_ROLE_LABEL.cashier).toBe('Cashier')
  })

  it('offers cashier before manager', () => {
    expect(POS_ROLES).toEqual(['cashier', 'manager'])
  })

  it('calls a revoked assignment revoked', () => {
    expect(ASSIGNMENT_STATUS_LABEL.inactive).toBe('Revoked')
    expect(ASSIGNMENT_STATUS_LABEL.active).toBe('Active')
  })
})

describe('hasActiveAssignmentAt', () => {
  const row = (profile_id: string, branch_id: string, status: 'active' | 'inactive') => ({
    profile_id,
    branch_id,
    status,
  })

  it('sees an active assignment for the same person and branch', () => {
    expect(hasActiveAssignmentAt([row('p1', 'b1', 'active')], 'p1', 'b1')).toBe(true)
  })

  it('is what makes a revoked row stop offering Grant again', () => {
    // The reported confusion: a revoked row from August sitting under an active
    // row from September, both for the same branch, with the old one still
    // inviting a re-grant the database would refuse.
    const rows = [row('p1', 'b1', 'inactive'), row('p1', 'b1', 'active')]
    expect(hasActiveAssignmentAt(rows, 'p1', 'b1')).toBe(true)
  })

  it('allows a re-grant when only revoked history exists', () => {
    expect(hasActiveAssignmentAt([row('p1', 'b1', 'inactive')], 'p1', 'b1')).toBe(false)
  })

  it('does not confuse another branch for this one', () => {
    // Holding a live grant at one branch says nothing about another till.
    expect(hasActiveAssignmentAt([row('p1', 'b2', 'active')], 'p1', 'b1')).toBe(false)
  })

  it('does not confuse another person for this one', () => {
    expect(hasActiveAssignmentAt([row('p2', 'b1', 'active')], 'p1', 'b1')).toBe(false)
  })

  it('handles an empty list', () => {
    expect(hasActiveAssignmentAt([], 'p1', 'b1')).toBe(false)
  })
})
