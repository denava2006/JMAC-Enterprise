import { describe, expect, it } from 'vitest'
import { roleBadge } from '@/lib/roleBadge'
import { NO_POS_ACCESS, type PosAccess } from '@/lib/portals'

function posAccess(...pairs: Array<['manager' | 'cashier', string]>): PosAccess {
  return {
    hasAccess: pairs.length > 0,
    branchIds: pairs.map(([, branchId]) => branchId),
    assignments: pairs.map(([role, branchId]) => ({ role, branchId })),
  }
}

describe('the role badge', () => {
  it.each([
    ['admin', 'ADM', 'Administrator'],
    ['hr_manager', 'HRM', 'HR Manager'],
    ['hr_staff', 'HRS', 'HR Staff'],
    ['finance_staff', 'FS', 'Finance Staff'],
    ['finance_manager', 'FM', 'Finance Manager'],
    ['accountant', 'ACC', 'Accountant'],
    ['employee', 'EMP', 'Employee'],
  ] as const)('shows %s as %s', (role, short, full) => {
    expect(roleBadge(role, NO_POS_ACCESS)).toEqual({ short, full })
  })

  it('has nothing to show before the profile has loaded', () => {
    expect(roleBadge(null, NO_POS_ACCESS)).toBeNull()
    expect(roleBadge(undefined, undefined)).toBeNull()
  })
})

describe('POS roles, which are not profile roles', () => {
  // A POS Manager and a Cashier both carry role 'employee'. Reading the role
  // alone would badge them identically, which is exactly the confusion the
  // badge exists to remove.
  it('badges a branch manager as POSM rather than EMP', () => {
    expect(roleBadge('employee', posAccess(['manager', 'branch-a']))).toEqual({
      short: 'POSM',
      full: 'POS Manager',
    })
  })

  it('badges a cashier as POSC', () => {
    expect(roleBadge('employee', posAccess(['cashier', 'branch-a']))).toEqual({
      short: 'POSC',
      full: 'Cashier',
    })
  })

  it('badges somebody who manages one branch and cashiers at another as a manager', () => {
    expect(
      roleBadge('employee', posAccess(['cashier', 'branch-a'], ['manager', 'branch-b'])),
    ).toEqual({ short: 'POSM', full: 'POS Manager' })
  })

  it('leaves an Administrator an Administrator inside the POS', () => {
    // An Administrator's branch reach comes from being an admin, not from an
    // assignment. Relabelling them as branch staff would misdescribe both what
    // they are and where their authority comes from.
    expect(roleBadge('admin', { hasAccess: true, branchIds: [], assignments: [] })).toEqual({
      short: 'ADM',
      full: 'Administrator',
    })
  })

  it('does not let a till assignment relabel a Finance Manager as a cashier', () => {
    // The badge should never hide the more consequential of two roles behind
    // the lesser one.
    expect(roleBadge('finance_manager', posAccess(['cashier', 'branch-a']))).toEqual({
      short: 'FM',
      full: 'Finance Manager',
    })
  })
})
