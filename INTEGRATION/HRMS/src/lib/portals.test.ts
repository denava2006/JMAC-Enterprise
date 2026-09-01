import { describe, expect, it } from 'vitest'
import {
  NO_POS_ACCESS,
  cashierBranchIds,
  hasAnyManagerAssignment,
  isPosManagerAt,
  managerBranchIds,
  roleForBranch,
  availablePortals,
  canAccessPortal,
  defaultPortalPath,
  portalForPath,
  portalsFor,
  type PosAccess,
} from '@/lib/portals'

const withPos = (...branchIds: string[]): PosAccess => ({
  hasAccess: true,
  branchIds,
  assignments: branchIds.map((branchId) => ({ branchId, role: 'cashier' as const })),
})
const asManager = (...branchIds: string[]): PosAccess => ({
  hasAccess: true,
  branchIds,
  assignments: branchIds.map((branchId) => ({ branchId, role: 'manager' as const })),
})
/** An Administrator: has_pos_access() is true, but they hold no assignment
 * rows, because their reach comes from profiles.role. */
const adminPos: PosAccess = { hasAccess: true, branchIds: [], assignments: [] }

describe('portalsFor', () => {
  it('gives every HR role the back office', () => {
    expect(portalsFor('admin', NO_POS_ACCESS)).toContain('admin')
    expect(portalsFor('hr_manager', NO_POS_ACCESS)).toContain('admin')
    expect(portalsFor('hr_staff', NO_POS_ACCESS)).toContain('admin')
  })

  it('does not give an employee the back office', () => {
    expect(portalsFor('employee', NO_POS_ACCESS, true)).toEqual(['employee'])
  })

  it('grants the POS from the assignment, never from the role', () => {
    // hr_staff is a senior HR role and still gets nothing at the till.
    expect(portalsFor('hr_staff', NO_POS_ACCESS)).not.toContain('pos')
    expect(portalsFor('hr_staff', withPos('branch-1'))).toContain('pos')
  })

  it('gives an administrator the back office and nothing else', () => {
    // has_pos_access() is still true for them, and the POS modules they need
    // are in their own sidebar. Handing them a second workspace would hide HR
    // from the person who administers it, so the parent system keeps them.
    expect(portalsFor('admin', adminPos)).toEqual(['admin'])
  })

  it('keeps an administrator out of the POS even with a stray assignment', () => {
    // A historical or mistaken pos_branch_assignments row must not bring the
    // workspace switcher back. The rule is stated on the role, not inferred
    // from the absence of data.
    expect(portalsFor('admin', withPos('branch-1'))).toEqual(['admin'])
  })

  it('gives a cashier the POS and self-service, and no HR modules', () => {
    expect(portalsFor('employee', withPos('branch-1'), true)).toEqual(['pos', 'employee'])
  })

  it('gives an unknown or missing role nothing', () => {
    expect(portalsFor(undefined, NO_POS_ACCESS)).toEqual([])
  })
})

describe('defaultPortalPath', () => {
  it('lands an administrator in the back office', () => {
    expect(defaultPortalPath('admin', adminPos)).toBe('/dashboard')
  })

  it('lands HR staff in the back office', () => {
    expect(defaultPortalPath('hr_staff', NO_POS_ACCESS)).toBe('/dashboard')
    expect(defaultPortalPath('hr_manager', NO_POS_ACCESS)).toBe('/dashboard')
  })

  it('keeps HR staff in the back office even when they also hold POS access', () => {
    expect(defaultPortalPath('hr_staff', withPos('branch-1'))).toBe('/dashboard')
  })

  it('lands POS staff at the portal, which then decides the screen', () => {
    // Not '/pos/till'. A cashier wants the till and a manager wants their
    // dashboard, and that test belongs in one place -- the /pos index route --
    // rather than being duplicated here and in App.tsx.
    expect(defaultPortalPath('employee', withPos('branch-1'), true)).toBe('/pos')
  })

  it('lands an employee without POS access in self-service', () => {
    // Its own route now. /dashboard is the HR dashboard for anyone who also
    // works in HR, so self-service cannot share it.
    expect(defaultPortalPath('employee', NO_POS_ACCESS, true)).toBe('/dashboard/my-dashboard')
  })

  it('still has somewhere to send an account holding no portal', () => {
    expect(defaultPortalPath(undefined, NO_POS_ACCESS)).toBe('/dashboard')
  })
})

describe('canAccessPortal', () => {
  it('refuses the POS to an employee with no assignment', () => {
    expect(canAccessPortal('employee', NO_POS_ACCESS, 'pos')).toBe(false)
  })

  it('refuses the POS to HR staff with no assignment', () => {
    expect(canAccessPortal('hr_staff', NO_POS_ACCESS, 'pos')).toBe(false)
  })

  it('allows the POS once an assignment exists', () => {
    expect(canAccessPortal('employee', withPos('branch-1'), 'pos')).toBe(true)
  })

  it('does not give an administrator the POS workspace', () => {
    // They administer the POS from the back office instead; the workspace is
    // the operational one, for Managers and Cashiers.
    expect(canAccessPortal('admin', adminPos, 'pos')).toBe(false)
    expect(canAccessPortal('admin', adminPos, 'admin')).toBe(true)
  })

  it('refuses the back office to a cashier', () => {
    expect(canAccessPortal('employee', withPos('branch-1'), 'admin')).toBe(false)
  })
})

describe('availablePortals', () => {
  it('offers nothing to switch between when only one portal is held', () => {
    expect(availablePortals('hr_staff', NO_POS_ACCESS)).toHaveLength(1)
    expect(availablePortals('employee', NO_POS_ACCESS, true)).toHaveLength(1)
  })

  it('offers an administrator a single workspace, so no switcher appears', () => {
    // The Navbar renders the switcher only when more than one portal is held,
    // so one entry is what removes it.
    expect(availablePortals('admin', adminPos).map((p) => p.key)).toEqual(['admin'])
  })

  it('offers the till before self-service to a cashier', () => {
    expect(availablePortals('employee', withPos('b1'), true).map((p) => p.key)).toEqual(['pos', 'employee'])
  })
})

describe('portalForPath', () => {
  it('recognises the POS portal', () => {
    expect(portalForPath('/pos')).toBe('pos')
    expect(portalForPath('/pos/till')).toBe('pos')
  })

  it('does not mistake a lookalike path for the POS', () => {
    expect(portalForPath('/position')).toBe('admin')
    expect(portalForPath('/dashboard/admin/positions')).toBe('admin')
  })
})

describe('branch/role pairs', () => {
  // A person can manage one branch and work a till at another. Collapsing that
  // to a single flag would hand them manager tools where they are a cashier.
  const mixed: PosAccess = {
    hasAccess: true,
    branchIds: ['cavite', 'main'],
    assignments: [
      { branchId: 'cavite', role: 'manager' },
      { branchId: 'main', role: 'cashier' },
    ],
  }

  it('reads the role for the branch in hand', () => {
    expect(roleForBranch(mixed, 'cavite')).toBe('manager')
    expect(roleForBranch(mixed, 'main')).toBe('cashier')
    expect(roleForBranch(mixed, 'elsewhere')).toBeUndefined()
    expect(roleForBranch(mixed, undefined)).toBeUndefined()
  })

  it('does not leak manager authority across branches', () => {
    expect(isPosManagerAt(mixed, 'cavite')).toBe(true)
    expect(isPosManagerAt(mixed, 'main')).toBe(false)
    expect(isPosManagerAt(mixed, 'elsewhere')).toBe(false)
  })

  it('separates the managed branches from the ones they cash up at', () => {
    expect(managerBranchIds(mixed)).toEqual(['cavite'])
    expect(cashierBranchIds(mixed)).toEqual(['main'])
  })

  it('answers whether manager navigation is worth offering at all', () => {
    expect(hasAnyManagerAssignment(mixed)).toBe(true)
    expect(hasAnyManagerAssignment(withPos('main'))).toBe(false)
    expect(hasAnyManagerAssignment(asManager('main'))).toBe(true)
    expect(hasAnyManagerAssignment(NO_POS_ACCESS)).toBe(false)
  })

  it('gives an Administrator no assignments to read', () => {
    expect(managerBranchIds(adminPos)).toEqual([])
    expect(hasAnyManagerAssignment(adminPos)).toBe(false)
    expect(roleForBranch(adminPos, 'cavite')).toBeUndefined()
  })
})

describe('where POS staff land', () => {
  it('is the POS portal, whose index route decides between till and dashboard', () => {
    expect(defaultPortalPath('employee', withPos('branch-1'), true)).toBe('/pos')
  })

  it('is the same entry point whether they manage a branch or work a till', () => {
    // The landing path does not encode the POS role; PosIndexRedirect does.
    const cashier = { hasAccess: true, branchIds: ['b1'], assignments: [{ branchId: 'b1', role: 'cashier' as const }] }
    const manager = { hasAccess: true, branchIds: ['b1'], assignments: [{ branchId: 'b1', role: 'manager' as const }] }
    expect(defaultPortalPath('employee', cashier, true)).toBe(defaultPortalPath('employee', manager, true))
  })
})
