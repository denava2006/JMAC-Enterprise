import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { UserRole } from '@/lib/enums'
import type { PosAssignment } from '@/lib/portals'

/**
 * The top bar, across every role and portal.
 *
 * One shared Navbar serves HRMS, FMS, POS and My Workspace, so these cover all
 * four. The claim is a counting one: exactly one visible role indicator, and it
 * is the badge.
 *
 * It used to say the role three times over -- prefixed to the name by a display
 * helper ("HR Staff Chan"), spelled out on the line beneath ("HR Staff"), and
 * again as the badge ("HRS").
 */

const state: {
  role: UserRole
  fullName: string | null
  email: string
  assignments: PosAssignment[]
  employee: { positions?: { title: string }; departments?: { name: string } } | null
} = {
  role: 'admin',
  fullName: 'Clark De Nava',
  email: 'denavaclark@gmail.com',
  assignments: [],
  employee: null,
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: {
      id: 'u1',
      role: state.role,
      full_name: state.fullName,
      email: state.email,
      employee_id: state.employee ? 'e1' : null,
    },
    posAccess: {
      hasAccess: state.assignments.length > 0,
      branchIds: state.assignments.map((a) => a.branchId),
      assignments: state.assignments,
    },
    signOut: vi.fn(),
  }),
}))

vi.mock('@/hooks/useEmployeePortal', () => ({
  useMyEmployeeRecord: () => ({ data: state.employee }),
}))

vi.mock('@/components/layout/CalendarWidget', () => ({ CalendarWidget: () => null }))
vi.mock('@/components/layout/ClockWidget', () => ({ ClockWidget: () => null }))

const { Navbar } = await import('@/components/layout/Navbar')

function show() {
  return render(
    <MemoryRouter>
      <Navbar />
    </MemoryRouter>,
  )
}

/** Every full role label the app knows. None of these may appear in the bar. */
const FULL_LABELS = [
  'Administrator',
  'HR Manager',
  'HR Staff',
  'Finance Staff',
  'Finance Manager',
  'Accountant',
  'POS Manager',
  'Cashier',
  'Employee',
]

afterEach(() => {
  cleanup()
  state.role = 'admin'
  state.fullName = 'Clark De Nava'
  state.email = 'denavaclark@gmail.com'
  state.assignments = []
  state.employee = null
})

describe('exactly one role indicator, for every role', () => {
  it.each([
    ['admin', 'ADM'],
    ['hr_manager', 'HRM'],
    ['hr_staff', 'HRS'],
    ['finance_staff', 'FS'],
    ['finance_manager', 'FM'],
    ['accountant', 'ACC'],
    ['employee', 'EMP'],
  ] as const)('shows %s as a single %s badge and nothing else', (role, short) => {
    state.role = role
    const { container } = show()

    expect(screen.getByText(short)).toBeTruthy()

    // The full wording appears nowhere in the rendered bar. The badge's
    // tooltip and accessible label carry it, which is markup rather than text.
    const visible = container.textContent ?? ''
    for (const label of FULL_LABELS) {
      expect(visible).not.toContain(label)
    }
  })

  it.each([
    ['manager' as const, 'POSM'],
    ['cashier' as const, 'POSC'],
  ])('shows a POS %s as %s, from the branch assignment', (posRole, short) => {
    state.role = 'employee'
    state.assignments = [{ branchId: 'b1', role: posRole }]
    const { container } = show()

    expect(screen.getByText(short)).toBeTruthy()
    expect(container.textContent ?? '').not.toContain('POS Manager')
    expect(container.textContent ?? '').not.toContain('Cashier')
  })

  it('renders the badge once, not once per portal it could belong to', () => {
    state.role = 'finance_manager'
    show()
    expect(screen.getAllByText('FM')).toHaveLength(1)
  })
})

describe('the identity line', () => {
  it('is the name, with no role stapled to the front', () => {
    state.role = 'hr_staff'
    state.fullName = 'Sam Chan'
    show()
    expect(screen.getByText('Sam Chan')).toBeTruthy()
    // The old helper produced "HR Staff Sam".
    expect(screen.queryByText(/HR Staff Sam/)).toBeNull()
  })

  it('falls back to the email when there is no name', () => {
    state.role = 'admin'
    state.fullName = null
    show()
    expect(screen.getByText('denavaclark@gmail.com')).toBeTruthy()
  })

  it("keeps an employee's position and department, which are not their role", () => {
    // A Cashier reads "Cashier · Operations" here and POSC on the badge. Those
    // are two different facts, so this line is not duplication.
    state.role = 'employee'
    state.assignments = [{ branchId: 'b1', role: 'cashier' }]
    state.employee = { positions: { title: 'Cashier' }, departments: { name: 'Operations' } }
    show()
    expect(screen.getByText('Cashier · Operations')).toBeTruthy()
    expect(screen.getByText('POSC')).toBeTruthy()
  })

  it('shows no second line for a back-office account', () => {
    state.role = 'finance_staff'
    state.fullName = 'Alice Dela Cruz'
    const { container } = show()
    expect(container.textContent).toContain('Alice Dela Cruz')
    expect(container.textContent).toContain('FS')
    expect(container.textContent).not.toContain('Finance Staff')
  })
})

describe('accessibility keeps the full wording', () => {
  it('names the role on the badge for a screen reader', () => {
    state.role = 'accountant'
    show()
    expect(screen.getByLabelText('Signed in as Accountant')).toBeTruthy()
  })

  it('offers it as a tooltip for anyone who does not know the abbreviation', () => {
    state.role = 'hr_manager'
    show()
    expect(screen.getByText('HRM').getAttribute('title')).toBe('HR Manager')
  })
})
