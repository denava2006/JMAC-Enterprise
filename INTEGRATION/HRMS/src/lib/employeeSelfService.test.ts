/** Employee self-service — access model tests.
 *
 * HR Staff and HR Managers are employees. They have attendance, they take
 * leave, they are paid. Their HR privilege was treated as a replacement for
 * that rather than an addition to it: portalsFor only ever granted the
 * self-service portal to role === 'employee', and the /dashboard/my-* routes
 * were gated allowedRoles={['employee']}. Being granted HR privilege therefore
 * removed a person's own payslip.
 *
 * The rule these lock down is that self-service follows EMPLOYMENT, and
 * privilege follows the grant. The two are independent, so losing one cannot
 * take the other with it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NO_POS_ACCESS,
  availablePortals,
  canAccessPortal,
  defaultPortalPath,
  portalForPath,
  portalsFor,
  type PosAccess,
} from './portals'

const EMPLOYED = true
const NOT_EMPLOYED = false

const posCashier: PosAccess = {
  hasAccess: true,
  branchIds: ['b1'],
  assignments: [{ branchId: 'b1', role: 'cashier' }],
}

describe('who holds self-service', () => {
  it.each([
    ['employee', 'employee' as const],
    ['hr_staff', 'hr_staff' as const],
    ['hr_manager', 'hr_manager' as const],
  ])('%s keeps it while employed', (_label, role) => {
    expect(portalsFor(role, NO_POS_ACCESS, EMPLOYED)).toContain('employee')
  })

  it('gives HR both contexts, not one instead of the other', () => {
    for (const role of ['hr_staff', 'hr_manager'] as const) {
      const held = portalsFor(role, NO_POS_ACCESS, EMPLOYED)
      expect(held).toContain('admin')
      expect(held).toContain('employee')
    }
  })

  it('gives a cashier the till and their own records', () => {
    const held = portalsFor('employee', posCashier, EMPLOYED)
    expect(held).toContain('pos')
    expect(held).toContain('employee')
  })

  it('does not invent self-service for an Administrator who is not an employee', () => {
    // The deliberate exception: no employee record, so nothing to show.
    expect(portalsFor('admin', NO_POS_ACCESS, NOT_EMPLOYED)).toEqual(['admin'])
  })

  it('does give it to an Administrator who IS an employee', () => {
    expect(portalsFor('admin', NO_POS_ACCESS, EMPLOYED)).toContain('employee')
  })
})

describe('privilege and employment are independent', () => {
  it('revoking HR privilege leaves self-service intact', () => {
    // The account is demoted to 'employee'; the employment did not change.
    const before = portalsFor('hr_manager', NO_POS_ACCESS, EMPLOYED)
    const after = portalsFor('employee', NO_POS_ACCESS, EMPLOYED)

    expect(before).toContain('admin')
    expect(after).not.toContain('admin')
    expect(after).toContain('employee')
  })

  it('self-service does not depend on holding any HR role', () => {
    expect(canAccessPortal('employee', NO_POS_ACCESS, 'employee', EMPLOYED)).toBe(true)
  })

  it('HR privilege alone does not grant self-service', () => {
    // A privileged account with no employee record has no records to read.
    expect(canAccessPortal('hr_staff', NO_POS_ACCESS, 'employee', NOT_EMPLOYED)).toBe(false)
  })
})

describe('the two contexts stay apart', () => {
  it('HR lands in Human Resources, not in their own payslips', () => {
    expect(defaultPortalPath('hr_manager', NO_POS_ACCESS, EMPLOYED)).toBe('/dashboard')
  })

  it('but My Workspace is still offered to them', () => {
    const labels = availablePortals('hr_manager', NO_POS_ACCESS, EMPLOYED).map((p) => p.label)
    expect(labels).toContain('Human Resources')
    expect(labels).toContain('My Workspace')
  })

  it('a switcher is not offered to someone holding one context', () => {
    expect(availablePortals('admin', NO_POS_ACCESS, NOT_EMPLOYED)).toHaveLength(1)
  })

  it('tells an own-record page apart from the organization page', () => {
    expect(portalForPath('/dashboard/my-attendance')).toBe('employee')
    expect(portalForPath('/dashboard/attendance')).toBe('admin')
    expect(portalForPath('/dashboard/my-payroll')).toBe('employee')
    expect(portalForPath('/dashboard/payroll')).toBe('admin')
  })
})

/* ------------------------------------------------------------------------ */

const root = join(__dirname, '..', '..')
const portalHooks = readFileSync(join(root, 'src', 'hooks', 'useEmployeePortal.ts'), 'utf8')
const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8')

describe('self-service shows one person their own records', () => {
  it('every query is scoped to the signed-in employee', () => {
    // The whole risk of opening these pages to HR: a query that leans on RLS
    // for scoping would widen the moment a privileged account opened it.
    const selects = portalHooks.split('\n').filter((l) => l.includes(".from('"))
    expect(selects.length).toBeGreaterThan(0)

    const ownRecordTables = ['attendance_records', 'leave_requests', 'payroll_records']
    for (const table of ownRecordTables) {
      const idx = portalHooks.indexOf(`.from('${table}')`)
      expect(idx, `${table} is not queried`).toBeGreaterThan(-1)
      // The employee filter must appear in the same chain, before the next query.
      const chain = portalHooks.slice(idx, idx + 400)
      expect(chain, `${table} is not scoped to one employee`).toContain("eq('employee_id'")
    }
  })

  it('scopes from the session, never from a page parameter', () => {
    // employee_id comes off the signed-in profile. Reading it from the URL
    // would let anyone with the page open type someone else's id.
    expect(portalHooks).toContain('profile?.employee_id')
    expect(portalHooks).not.toMatch(/useParams\(\)/)
  })

  it('gates the routes on employment rather than on a role', () => {
    for (const route of ['my-dashboard', 'my-attendance', 'my-leave', 'my-payroll']) {
      const idx = app.indexOf(`path="${route}"`)
      expect(idx, `${route} is not routed`).toBeGreaterThan(-1)
      const block = app.slice(idx, idx + 240)
      expect(block, `${route} still gates on a role`).toContain('requireEmployee')
      expect(block).not.toContain("allowedRoles={['employee']}")
    }
  })
})

describe('the Finance portal', () => {
  it('is held by each finance role', () => {
    for (const role of ['finance_staff', 'finance_manager', 'accountant'] as const) {
      expect(portalsFor(role, NO_POS_ACCESS, EMPLOYED)).toContain('finance')
    }
  })

  it('comes with My Workspace, like every other privilege', () => {
    // Finance people are employees. Their own attendance, leave and payslips do
    // not stop existing because they were granted a finance role.
    const held = portalsFor('finance_manager', NO_POS_ACCESS, EMPLOYED)
    expect(held).toContain('finance')
    expect(held).toContain('employee')
    expect(held).not.toContain('admin')
  })

  it('is not held by an Administrator', () => {
    // They grant finance access and read its audit trail. Validating, approving
    // and paying belong to the three finance roles -- modelling the
    // Administrator as all of them rebuilds, inside one account, the
    // combination the one-active-role index forbids for everyone else.
    expect(portalsFor('admin', NO_POS_ACCESS, NOT_EMPLOYED)).not.toContain('finance')
    expect(portalsFor('admin', NO_POS_ACCESS, EMPLOYED)).not.toContain('finance')
  })

  it('is not held by HR or POS staff', () => {
    expect(portalsFor('hr_manager', NO_POS_ACCESS, EMPLOYED)).not.toContain('finance')
    expect(portalsFor('employee', posCashier, EMPLOYED)).not.toContain('finance')
  })

  it('lands a finance employee in Finance, not in their own payslips', () => {
    expect(defaultPortalPath('finance_staff', NO_POS_ACCESS, EMPLOYED)).toBe('/fms')
  })

  it('tells a finance page apart from every other portal', () => {
    expect(portalForPath('/fms')).toBe('finance')
    expect(portalForPath('/fms/budgets')).toBe('finance')
    expect(portalForPath('/dashboard/my-attendance')).toBe('employee')
    expect(portalForPath('/pos/till')).toBe('pos')
    expect(portalForPath('/dashboard/employees')).toBe('admin')
  })

  it('offers both names in the switcher', () => {
    const labels = availablePortals('accountant', NO_POS_ACCESS, EMPLOYED).map((p) => p.label)
    expect(labels).toEqual(['Finance', 'My Workspace'])
  })
})
