/** The F2 role matrix, checked against docs/fms-authorization.md.
 *
 * These do not test security — RLS does that, and supabase/tests/
 * finance_master_data_rls.sql proves it against the database. What they lock
 * down is that the UI offers exactly the controls the database will accept, so
 * nobody is shown a button that answers "your finance role does not cover that
 * action".
 */
import { describe, it, expect } from 'vitest'
import { canEditAllocation, canWriteAnyFinanceModule, financeCan } from './financeAuthority'
import type { FinanceAction, FinanceModule } from './financeAuthority'

const MODULES: FinanceModule[] = [
  'categories',
  'vendors',
  'vendorCategories',
  'accounts',
  'budgets',
  'allocations',
]

describe('everyone in Finance can read Finance', () => {
  it.each(['finance_staff', 'finance_manager', 'accountant'] as const)('%s reads every module', (role) => {
    for (const moduleName of MODULES) {
      expect(financeCan(role, moduleName, 'read'), moduleName).toBe(true)
    }
  })

  it('and so does the Administrator — oversight, stated explicitly', () => {
    for (const moduleName of MODULES) {
      expect(financeCan('admin', moduleName, 'read'), moduleName).toBe(true)
    }
  })

  it('but nobody outside Finance does', () => {
    for (const role of ['employee', 'hr_staff', 'hr_manager'] as const) {
      for (const moduleName of MODULES) {
        expect(financeCan(role, moduleName, 'read'), `${role}/${moduleName}`).toBe(false)
      }
    }
  })

  it('and neither does a signed-out visitor', () => {
    expect(financeCan(null, 'budgets', 'read')).toBe(false)
    expect(financeCan(undefined, 'vendors', 'read')).toBe(false)
  })
})

describe('the Administrator sets no amounts', () => {
  it.each(MODULES)('cannot create, edit or archive %s', (moduleName) => {
    for (const action of ['create', 'edit', 'archive'] as FinanceAction[]) {
      expect(financeCan('admin', moduleName, action), action).toBe(false)
    }
  })

  it('holds no write anywhere in Finance', () => {
    // The standalone FMS granted has_role('administrator', ...) write access on
    // every finance table, and its rbac.ts made the Administrator a budget
    // allocator. Neither is reproduced here.
    expect(canWriteAnyFinanceModule('admin')).toBe(false)
  })
})

describe('a ceiling is drafted by one person and put in force by another', () => {
  // F2 gave budgets to the Finance Manager alone, which made one person both
  // the author and the approver of what the company may spend. F4.2 splits it.
  it('Staff draft the ceiling', () => {
    expect(financeCan('finance_staff', 'budgets', 'create')).toBe(true)
    expect(financeCan('finance_manager', 'budgets', 'create')).toBe(false)
    expect(financeCan('accountant', 'budgets', 'create')).toBe(false)
    expect(financeCan('admin', 'budgets', 'create')).toBe(false)
  })

  it('the Manager approves it, and nobody else can', () => {
    expect(financeCan('finance_manager', 'budgets', 'approve')).toBe(true)
    expect(financeCan('finance_staff', 'budgets', 'approve')).toBe(false)
    expect(financeCan('accountant', 'budgets', 'approve')).toBe(false)
    expect(financeCan('admin', 'budgets', 'approve')).toBe(false)
  })

  it('closing a ceiling stays the Manager’s', () => {
    expect(financeCan('finance_manager', 'budgets', 'archive')).toBe(true)
    expect(financeCan('finance_staff', 'budgets', 'archive')).toBe(false)
    expect(financeCan('accountant', 'budgets', 'archive')).toBe(false)
  })
})

describe('the checker does not author master data', () => {
  // The hosted screenshot that started F4.2: a Finance Manager looking at a
  // purchase order with the line editor still on it. The same principle
  // applies to the vendor and category lists behind it.
  it.each(['vendors', 'categories'] as const)('gives %s authorship to Staff alone', (module) => {
    for (const action of ['create', 'edit'] as FinanceAction[]) {
      expect(financeCan('finance_staff', module, action)).toBe(true)
      expect(financeCan('finance_manager', module, action)).toBe(false)
      expect(financeCan('accountant', module, action)).toBe(false)
      expect(financeCan('admin', module, action)).toBe(false)
    }
  })

  it.each(['vendors', 'categories'] as const)('keeps %s approval with the Manager', (module) => {
    expect(financeCan('finance_manager', module, 'approve')).toBe(true)
    expect(financeCan('finance_staff', module, 'approve')).toBe(false)
  })

  it.each(['vendors', 'categories'] as const)(
    'leaves archiving %s with the Manager, as F2 decided',
    (module) => {
      // Withdrawing a record changes how every past use of it reads, which is
      // governance rather than authorship.
      expect(financeCan('finance_manager', module, 'archive')).toBe(true)
      expect(financeCan('finance_staff', module, 'archive')).toBe(false)
    },
  )

  it('does not let the checker link what a vendor supplies', () => {
    expect(financeCan('finance_staff', 'vendorCategories', 'create')).toBe(true)
    expect(financeCan('finance_manager', 'vendorCategories', 'create')).toBe(false)
  })
})

describe('the chart of accounts has one owner', () => {
  it('the Accountant maintains it', () => {
    for (const action of ['create', 'edit', 'archive'] as FinanceAction[]) {
      expect(financeCan('accountant', 'accounts', action)).toBe(true)
    }
  })

  it('and the Finance Manager cannot gain that authority', () => {
    for (const action of ['create', 'edit', 'archive'] as FinanceAction[]) {
      expect(financeCan('finance_manager', 'accounts', action)).toBe(false)
      expect(financeCan('finance_staff', 'accounts', action)).toBe(false)
    }
  })
})

describe('Finance Staff curate, the Manager retires', () => {
  it('Staff create and edit categories and vendors', () => {
    for (const moduleName of ['categories', 'vendors'] as FinanceModule[]) {
      expect(financeCan('finance_staff', moduleName, 'create')).toBe(true)
      expect(financeCan('finance_staff', moduleName, 'edit')).toBe(true)
    }
  })

  it('Staff do not archive them', () => {
    expect(financeCan('finance_staff', 'categories', 'archive')).toBe(false)
    expect(financeCan('finance_staff', 'vendors', 'archive')).toBe(false)
    expect(financeCan('finance_manager', 'categories', 'archive')).toBe(true)
    expect(financeCan('finance_manager', 'vendors', 'archive')).toBe(true)
  })

  it('the Accountant curates neither', () => {
    expect(financeCan('accountant', 'vendors', 'create')).toBe(false)
    expect(financeCan('accountant', 'categories', 'create')).toBe(false)
  })

  it('a vendor/category link is created or removed, never edited', () => {
    expect(financeCan('finance_staff', 'vendorCategories', 'create')).toBe(true)
    expect(financeCan('finance_staff', 'vendorCategories', 'archive')).toBe(true)
    expect(financeCan('finance_manager', 'vendorCategories', 'edit')).toBe(false)
  })
})

describe('correcting a draw against a budget', () => {
  const mine = { status: 'active', created_by: 'me' }
  const theirs = { status: 'active', created_by: 'someone-else' }
  const released = { status: 'released', created_by: 'me' }

  it('the Manager may correct any allocation', () => {
    expect(canEditAllocation('finance_manager', theirs, 'me')).toBe(true)
    expect(canEditAllocation('finance_manager', released, 'me')).toBe(true)
  })

  it('Staff may correct their own, while it is still active', () => {
    expect(canEditAllocation('finance_staff', mine, 'me')).toBe(true)
    expect(canEditAllocation('finance_staff', released, 'me')).toBe(false)
  })

  it('Staff may not correct somebody else’s', () => {
    expect(canEditAllocation('finance_staff', theirs, 'me')).toBe(false)
  })

  it('the Accountant and the Administrator correct none', () => {
    expect(canEditAllocation('accountant', mine, 'me')).toBe(false)
    expect(canEditAllocation('admin', mine, 'me')).toBe(false)
  })

  it('releasing is the ceiling authority’s, not the drawer’s', () => {
    expect(financeCan('finance_staff', 'allocations', 'archive')).toBe(false)
    expect(financeCan('finance_manager', 'allocations', 'archive')).toBe(true)
  })

  it('the Accountant does not draw against budgets', () => {
    expect(financeCan('accountant', 'allocations', 'create')).toBe(false)
  })
})
