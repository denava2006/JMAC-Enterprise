import { describe, expect, it } from 'vitest'
import {
  FINANCE_MODULES,
  canAccessFinanceModule,
  financeNavFor,
  financeOverviewTiles,
} from '@/lib/financeModules'
import { waitingWork } from '@/components/fms/WaitingOnYou'

/**
 * The module-access policy, per role.
 *
 * These read as a table on purpose: the point of this work is that who may
 * open what is one list rather than a condition scattered through a sidebar,
 * and a test that walks the same list would prove nothing. Each expectation
 * below is written out as the answer a person would give.
 */

const ROLES = ['finance_staff', 'finance_manager', 'accountant'] as const

/** Every module route, so a new one cannot be added without a decision here. */
const ALL_ROUTES = FINANCE_MODULES.map((m) => m.route)

function labelsFor(role: (typeof ROLES)[number]): string[] {
  return financeNavFor(role).flatMap((s) => s.modules.map((m) => m.label))
}

function groupsFor(role: (typeof ROLES)[number]): string[] {
  return financeNavFor(role)
    .map((s) => s.group)
    .filter((g): g is NonNullable<typeof g> => !!g)
}

describe('Finance Staff', () => {
  const nav = () => labelsFor('finance_staff')

  it('sees Overview', () => {
    expect(nav()).toContain('Overview')
  })

  it('sees the modules they make work in', () => {
    expect(nav()).toEqual(
      expect.arrayContaining([
        'Requests',
        'Procurement',
        'Budgets',
        'Supplier Invoices',
        'Reimbursements',
      ]),
    )
  })

  it('sees the reference data their classification work needs', () => {
    expect(nav()).toEqual(expect.arrayContaining(['Vendors', 'Categories']))
    expect(groupsFor('finance_staff')).toContain('Reference')
  })

  it('does not see Payroll Finance', () => {
    expect(nav()).not.toContain('Payroll Finance')
    expect(canAccessFinanceModule('finance_staff', '/fms/payroll')).toBe(false)
  })

  it('does not see Cash & Bank', () => {
    expect(nav()).not.toContain('Cash & Bank')
    expect(canAccessFinanceModule('finance_staff', '/fms/treasury')).toBe(false)
  })

  it('does not see Settlements', () => {
    expect(canAccessFinanceModule('finance_staff', '/fms/settlements')).toBe(false)
  })

  // The audit found no Finance Staff work behind this page: it is read-only
  // over POS sales, and settlement -- everything downstream of it -- is
  // accountant-only in RLS. It was in their sidebar because it was in
  // everybody's.
  it('does not see Sales & Collections', () => {
    expect(nav()).not.toContain('Sales & Collections')
    expect(canAccessFinanceModule('finance_staff', '/fms/sales')).toBe(false)
  })

  it('has no Accounting navigation at all', () => {
    expect(groupsFor('finance_staff')).not.toContain('Accounting')
    for (const route of [
      '/fms/accounts',
      '/fms/journal',
      '/fms/ledger',
      '/fms/trial-balance',
      '/fms/reports',
    ]) {
      expect(canAccessFinanceModule('finance_staff', route)).toBe(false)
    }
  })
})

describe('Finance Manager', () => {
  const nav = () => labelsFor('finance_manager')

  it('sees the work submitted for their review', () => {
    expect(nav()).toEqual(
      expect.arrayContaining([
        'Requests',
        'Procurement',
        'Supplier Invoices',
        'Reimbursements',
        'Payroll Finance',
      ]),
    )
  })

  it('sees Payroll Finance', () => {
    expect(canAccessFinanceModule('finance_manager', '/fms/payroll')).toBe(true)
  })

  it('sees Cash & Bank for monitoring', () => {
    expect(nav()).toContain('Cash & Bank')
    expect(groupsFor('finance_manager')).toContain('Monitoring')
  })

  it('sees the Accounting section and can open every page in it', () => {
    expect(groupsFor('finance_manager')).toContain('Accounting')
    for (const route of [
      '/fms/accounts',
      '/fms/journal',
      '/fms/ledger',
      '/fms/trial-balance',
      '/fms/reports',
    ]) {
      expect(canAccessFinanceModule('finance_manager', route)).toBe(true)
    }
  })

  // Not from the target sidebar, but from the shipped workflow: the Manager is
  // the approver of a proposed vendor and category, and their own queue links
  // here. Hiding these would strand everything Staff propose.
  it('keeps the master data they are the approver of', () => {
    expect(nav()).toEqual(expect.arrayContaining(['Vendors', 'Categories']))
  })
})

describe('Accountant', () => {
  const nav = () => labelsFor('accountant')

  it('sees the payment and treasury modules', () => {
    expect(nav()).toEqual(
      expect.arrayContaining([
        'Sales & Collections',
        'Settlements',
        'Supplier Invoices',
        'Reimbursements',
        'Payroll Finance',
        'Cash & Bank',
      ]),
    )
  })

  it('sees every Accounting page', () => {
    expect(nav()).toEqual(
      expect.arrayContaining([
        'Chart of Accounts',
        'Journal Entries',
        'General Ledger',
        'Trial Balance',
        'Reports',
      ]),
    )
    expect(groupsFor('accountant')).toContain('Accounting')
  })

  it('does not get the procurement maker workspace', () => {
    expect(nav()).not.toContain('Procurement')
    expect(nav()).not.toContain('Requests')
    expect(canAccessFinanceModule('accountant', '/fms/procurement')).toBe(false)
    expect(canAccessFinanceModule('accountant', '/fms/requests')).toBe(false)
  })

  it('does not get a master-data or budgeting workspace', () => {
    for (const route of ['/fms/budgets', '/fms/vendors', '/fms/categories']) {
      expect(canAccessFinanceModule('accountant', route)).toBe(false)
    }
  })
})

describe('the policy itself', () => {
  it('is the same answer for navigation and for a URL', () => {
    // Not two arrays that agree today: financeNavFor and canAccessFinanceModule
    // read one placement table, and this asserts they cannot come apart.
    for (const role of ROLES) {
      const navRoutes = financeNavFor(role).flatMap((s) => s.modules.map((m) => m.route))
      for (const route of ALL_ROUTES) {
        expect(canAccessFinanceModule(role, route)).toBe(navRoutes.includes(route))
      }
    }
  })

  it('gives every Finance role an Overview and nothing above it', () => {
    for (const role of ROLES) {
      const sections = financeNavFor(role)
      expect(sections[0].group).toBeUndefined()
      expect(sections[0].modules.map((m) => m.route)).toEqual(['/fms'])
    }
  })

  it('refuses a signed-out or non-Finance role everything', () => {
    for (const route of ALL_ROUTES) {
      expect(canAccessFinanceModule(undefined, route)).toBe(false)
      expect(canAccessFinanceModule('employee', route)).toBe(false)
      // Administrators are kept out of /fms entirely by the existing portal
      // guard; this table does not readmit them.
      expect(canAccessFinanceModule('admin', route)).toBe(false)
    }
  })

  // A guard that fails closed on a route it has never heard of makes every new
  // page silently dark, which is how people learn to route around it.
  it('allows a route it does not know, for a role that has some access', () => {
    expect(canAccessFinanceModule('accountant', '/fms/something-new')).toBe(true)
  })

  it('never leaves a role with an empty workspace', () => {
    for (const role of ROLES) {
      expect(financeNavFor(role).length).toBeGreaterThan(1)
    }
  })
})

describe('the Overview shortcuts', () => {
  it('only ever point at modules the viewer may open', () => {
    for (const role of ROLES) {
      for (const tile of financeOverviewTiles(role)) {
        expect(canAccessFinanceModule(role, tile.route)).toBe(true)
        expect(tile.blurb).toBeTruthy()
      }
    }
  })

  it('gives each role something, and does not become a second sidebar', () => {
    for (const role of ROLES) {
      const tiles = financeOverviewTiles(role)
      expect(tiles.length).toBeGreaterThan(0)
      expect(tiles.length).toBeLessThanOrEqual(4)
    }
  })
})

/**
 * The link half of "Waiting on you".
 *
 * The queues themselves were settled in F6/F7 and are not touched here, but
 * separating the workspaces could have left a role with a count that opens a
 * page they are now refused. Every count is forced above zero so every row is
 * produced and every link is checked.
 */
describe('Waiting on you', () => {
  const everything = {
    vendorsPending: 1,
    categoriesPending: 1,
    budgetsDraft: 1,
    ordersToApprove: 1,
    requestsToValidate: 1,
    demandToAccept: 1,
    ordersReturned: 1,
    draftsInProgress: 1,
    vendorsReturned: 1,
    categoriesReturned: 1,
    invoicesToReview: 1,
    invoiceDrafts: 1,
    invoicesReturned: 1,
    ordersToInvoice: 1,
    reimbursementsToReview: 1,
    reimbursementsToApprove: 1,
    reimbursementsToPay: 1,
    reimbursementPaymentsToApprove: 1,
    reimbursementPaymentsToRecord: 1,
    payrollToDisburse: 1,
    payrollDisbursementsToApprove: 1,
    payrollDisbursementsToRecord: 1,
  }

  it('never links a role to a module they would be turned away from', () => {
    for (const role of ROLES) {
      for (const item of waitingWork(role, everything)) {
        // Queue links may carry a query string; the module is the path.
        const route = item.to.split('?')[0]
        expect(
          canAccessFinanceModule(role, route),
          `${role} is offered "${item.label}" at ${route}`,
        ).toBe(true)
      }
    }
  })

  it('contains only the work the logged-in role can actually clear', () => {
    const staff = waitingWork('finance_staff', everything).map((i) => i.label)
    const manager = waitingWork('finance_manager', everything).map((i) => i.label)
    const accountant = waitingWork('accountant', everything).map((i) => i.label)

    // "to approve" is the action; "Approved ..." is the state of the thing
    // being described, and the Accountant's queue is full of the latter --
    // approved money is exactly what they are waiting to send.
    const isAnApproval = (l: string) => /\bto approve\b/i.test(l)

    // The maker is never shown an approval, and never shown money to send.
    expect(staff.some(isAnApproval)).toBe(false)
    expect(staff.some((l) => /payment|disburse|payroll/i.test(l))).toBe(false)

    // The checker approves; they do not prepare or record.
    expect(manager.some(isAnApproval)).toBe(true)
    expect(manager.every((l) => !/to record|to submit|awaiting payment/i.test(l))).toBe(true)

    // The Accountant records and pays; they approve nothing.
    expect(accountant.some(isAnApproval)).toBe(false)
    expect(accountant.some((l) => /to record as paid/i.test(l))).toBe(true)

    // An Administrator has oversight, not a desk.
    expect(waitingWork('admin', everything)).toEqual([])
  })
})
