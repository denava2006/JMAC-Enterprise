import { describe, expect, it } from 'vitest'
import {
  ENFORCED_SYSTEMS,
  ELIGIBILITY_SYSTEMS,
  entitlementChips,
  POS_ROLE_LABEL,
  SYSTEM_LABEL,
  describeEligibility,
  describeWorkforceError,
  groupEntitlements,
  hasPosEligibility,
  type EligibleEmployee,
  type PositionEntitlementRow,
} from '@/lib/workforce'

function row(overrides: Partial<PositionEntitlementRow> = {}): PositionEntitlementRow {
  return {
    position_id: 'p1',
    position_title: 'Cashier',
    department_id: 'd1',
    department_name: 'Store Operations',
    system: 'pos',
    role_code: 'cashier',
    ...overrides,
  }
}

describe('groupEntitlements', () => {
  it('collects a position that grants several roles', () => {
    // A position holds more than one role only where an Administrator
    // configured each of them; there is no implicit "manager implies cashier".
    const grouped = groupEntitlements([
      row({ position_title: 'Branch Supervisor', role_code: 'cashier' }),
      row({ position_title: 'Branch Supervisor', role_code: 'manager' }),
    ])
    expect(grouped).toHaveLength(1)
    expect(grouped[0].pos.sort()).toEqual(['cashier', 'manager'])
  })

  it('keeps a position that grants nothing, rather than dropping it', () => {
    // IT Support must be visible and configurable, not absent from the screen.
    const grouped = groupEntitlements([
      row({ position_id: 'p2', position_title: 'IT Support', department_name: 'IT', system: null, role_code: null }),
    ])
    expect(grouped).toHaveLength(1)
    expect(grouped[0].pos).toEqual([])
  })

  it('separates the three systems', () => {
    const grouped = groupEntitlements([
      row({ system: 'pos', role_code: 'cashier' }),
      row({ system: 'hrms', role_code: 'hr_staff' }),
      row({ system: 'fms', role_code: 'accountant' }),
    ])
    expect(grouped[0].pos).toEqual(['cashier'])
    expect(grouped[0].hrms).toEqual(['hr_staff'])
    expect(grouped[0].fms).toEqual(['accountant'])
  })

  it('orders by department then position, so the list reads like an org chart', () => {
    const grouped = groupEntitlements([
      row({ position_id: 'z', position_title: 'Cashier', department_name: 'Store Operations' }),
      row({ position_id: 'a', position_title: 'IT Support', department_name: 'IT', system: null, role_code: null }),
    ])
    expect(grouped.map((g) => g.departmentName)).toEqual(['IT', 'Store Operations'])
  })
})

describe('describeEligibility', () => {
  it('names what a job actually grants', () => {
    const [entry] = groupEntitlements([row()])
    expect(describeEligibility(entry)).toBe('Cashier')
  })

  it('says self-service only when a job grants nothing', () => {
    // The baseline is not an entitlement -- every employee has it.
    const [entry] = groupEntitlements([row({ system: null, role_code: null })])
    expect(describeEligibility(entry)).toBe('Employee self-service only')
  })

  it('shows HR entitlements as labels, not storage codes', () => {
    // The Positions column previously read "HRMS hr_manager".
    const [entry] = groupEntitlements([row({ system: 'hrms', role_code: 'hr_manager' })])
    expect(describeEligibility(entry)).toBe('HR Manager')
  })

  it('joins two POS roles rather than showing one', () => {
    const [entry] = groupEntitlements([
      row({ role_code: 'cashier' }),
      row({ role_code: 'manager' }),
    ])
    expect(describeEligibility(entry)).toMatch(/Cashier and POS Manager|POS Manager and Cashier/)
  })
})

describe('hasPosEligibility', () => {
  it('is per role, not per system', () => {
    // A Cashier is not half a Manager. Cross-over is the bug this phase closed.
    const [entry] = groupEntitlements([row({ role_code: 'cashier' })])
    expect(hasPosEligibility(entry, 'cashier')).toBe(true)
    expect(hasPosEligibility(entry, 'manager')).toBe(false)
  })
})

describe('what Phase 9A actually enforces', () => {
  it('enforces POS only', () => {
    // HRMS eligibility is Phase 9B and FMS is 9C. Claiming otherwise on screen
    // would be a promise the database does not keep.
    expect(ENFORCED_SYSTEMS).toEqual(['pos'])
  })

  it('still labels all three systems, so the model stays legible', () => {
    expect(Object.keys(SYSTEM_LABEL).sort()).toEqual(['fms', 'hrms', 'pos'])
  })
})

describe('the candidate contract', () => {
  it('carries identity and org placement only', () => {
    // The picker must not become a payroll leak. The RPC does not select these
    // columns; this pins the client type to the same contract.
    const candidate: EligibleEmployee = {
      profile_id: 'u1',
      employee_id: 'e1',
      full_name: 'Cass Till',
      email: 'cass@example.com',
      employee_number: 'EMP-001',
      department_name: 'Store Operations',
      position_title: 'Cashier',
    }
    const keys = Object.keys(candidate)
    for (const forbidden of ['salary', 'basic_salary', 'salary_grade_id', 'birth_date', 'address', 'benefits']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})

describe('describeWorkforceError', () => {
  it('turns the ineligibility code into the database"s own explanation', () => {
    expect(
      describeWorkforceError(
        new Error('POS_ASSIGNMENT_NOT_ELIGIBLE: IT Support is not eligible for POS Manager.')
      )
    ).toBe('IT Support is not eligible for POS Manager.')
  })

  it('explains that a closed assignment needs a new grant, not reopening', () => {
    expect(describeWorkforceError(new Error('POS_ASSIGNMENT_CLOSED: that assignment was closed.'))).toMatch(
      /Grant a new one/
    )
  })

  it('explains a department/position mismatch', () => {
    expect(
      describeWorkforceError(new Error('POSITION_DEPARTMENT_MISMATCH: Cashier is not a position in IT'))
    ).toBe('Cashier is not a position in IT')
  })

  it('explains why a position cannot be moved between departments', () => {
    expect(
      describeWorkforceError(new Error('POSITION_DEPARTMENT_IN_USE: 3 employee(s) hold this position'))
    ).toMatch(/3 employee/)
  })

  it('never returns an empty string', () => {
    expect(describeWorkforceError(null)).toBe('That change could not be saved.')
  })
})

describe('POS role labels', () => {
  it('reuses the established labels, which distinguish POS Manager from HR Manager', () => {
    expect(POS_ROLE_LABEL.manager).toBe('POS Manager')
    expect(POS_ROLE_LABEL.cashier).toBe('Cashier')
  })
})

describe('the eligibility model', () => {
  it('offers HR Staff and HR Manager for HRMS', () => {
    // These were previously read-only in the dialog, which showed "None
    // configured" for every position and made HR look unconfigurable.
    const hrms = ELIGIBILITY_SYSTEMS.find((g) => g.system === 'hrms')
    expect(hrms?.available).toBe(true)
    expect(hrms?.options.map((o) => o.value).sort()).toEqual(['hr_manager', 'hr_staff'])
  })

  it('offers Cashier and POS Manager for POS, unchanged', () => {
    const pos = ELIGIBILITY_SYSTEMS.find((g) => g.system === 'pos')
    expect(pos?.available).toBe(true)
    expect(pos?.options.map((o) => o.value).sort()).toEqual(['cashier', 'manager'])
  })

  it('gives HRMS and POS equal standing', () => {
    // Both configurable, both with descriptions -- neither is a second-class
    // section in the dialog.
    for (const system of ['hrms', 'pos'] as const) {
      const group = ELIGIBILITY_SYSTEMS.find((g) => g.system === system)
      expect(group?.available).toBe(true)
      expect(group?.options.length).toBe(2)
      expect(group?.options.every((o) => o.description.length > 0)).toBe(true)
    }
  })

  it('lists FMS but keeps it unconfigurable', () => {
    const fms = ELIGIBILITY_SYSTEMS.find((g) => g.system === 'fms')
    expect(fms).toBeDefined()
    expect(fms?.available).toBe(false)
    expect(fms?.options).toEqual([])
  })

  it('never offers admin or employee as a grantable role', () => {
    // Administrator is an enterprise identity; Employee Self-Service is the
    // baseline. The database refuses both by name, and the UI must not present
    // them.
    const offered = ELIGIBILITY_SYSTEMS.flatMap((g) => g.options.map((o) => o.value))
    for (const forbidden of ['admin', 'administrator', 'employee']) {
      expect(offered).not.toContain(forbidden)
    }
  })

  it('labels the POS manager role so it cannot be read as HR Manager', () => {
    const pos = ELIGIBILITY_SYSTEMS.find((g) => g.system === 'pos')
    expect(pos?.options.find((o) => o.value === 'manager')?.label).toBe('POS Manager')
  })
})

describe('entitlementChips', () => {
  it('returns one neutral chip per entitlement, HR and POS alike', () => {
    const [entry] = groupEntitlements([
      row({ system: 'hrms', role_code: 'hr_staff' }),
      row({ system: 'pos', role_code: 'manager' }),
    ])
    expect(entitlementChips(entry).map((c) => c.label)).toEqual(['HR Staff', 'POS Manager'])
  })

  it('handles a position holding more than one role in a system', () => {
    const [entry] = groupEntitlements([
      row({ position_title: 'Branch Supervisor', role_code: 'cashier' }),
      row({ position_title: 'Branch Supervisor', role_code: 'manager' }),
    ])
    const labels = entitlementChips(entry).map((c) => c.label)
    expect(labels).toHaveLength(2)
    expect(labels.sort()).toEqual(['Cashier', 'POS Manager'])
  })

  it('gives an employee-only position no chips at all', () => {
    // The table shows muted "Employee self-service only" text instead, and it
    // is not an error or warning state.
    const [entry] = groupEntitlements([row({ system: null, role_code: null })])
    expect(entitlementChips(entry)).toEqual([])
  })

  it('uses labels, never storage codes', () => {
    const [entry] = groupEntitlements([row({ system: 'hrms', role_code: 'hr_manager' })])
    expect(entitlementChips(entry)[0].label).toBe('HR Manager')
    expect(entitlementChips(entry)[0].label).not.toBe('hr_manager')
  })

  it('keys each chip by system and role so two systems cannot collide', () => {
    const [entry] = groupEntitlements([
      row({ system: 'hrms', role_code: 'hr_manager' }),
      row({ system: 'pos', role_code: 'manager' }),
    ])
    const keys = entitlementChips(entry).map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
