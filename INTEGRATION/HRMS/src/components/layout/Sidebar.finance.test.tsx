import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The Finance sidebar as it actually renders, per role.
 *
 * financeModules.test.ts proves the policy; this proves the menu is built from
 * it. The two are worth keeping apart -- a correct table rendered by a sidebar
 * that still holds its own list would pass the first and fail here.
 */

const state = { role: 'finance_staff' as string | null }

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: state.role ? { id: 'u1', role: state.role } : null }),
}))

vi.mock('@/components/BuildStamp', () => ({ BuildStamp: () => null }))

import { Sidebar } from '@/components/layout/Sidebar'

function renderAt(path: string, role: string) {
  state.role = role
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar />
    </MemoryRouter>,
  )
}

/** Every link in the sidebar, by its visible text. */
function links(): string[] {
  return screen.getAllByRole('link').map((a) => a.textContent?.trim() ?? '')
}

afterEach(cleanup)

describe('the Finance sidebar', () => {
  it('gives Finance Staff their own workspace and no Accounting', () => {
    renderAt('/fms', 'finance_staff')
    expect(links()).toEqual([
      'Overview',
      'Requests',
      'Procurement',
      'Budgets',
      'Supplier Invoices',
      'Reimbursements',
      'Vendors',
      'Categories',
    ])
    expect(screen.queryByText('Accounting')).toBeNull()
    expect(screen.getByText('Operations')).toBeTruthy()
    expect(screen.getByText('Reference')).toBeTruthy()
  })

  it('gives the Finance Manager review, monitoring and the books', () => {
    renderAt('/fms', 'finance_manager')
    const shown = links()
    expect(shown).toContain('Payroll Finance')
    expect(shown).toContain('Cash & Bank')
    expect(shown).toContain('Journal Entries')
    expect(shown).toContain('General Ledger')
    expect(shown).toContain('Trial Balance')
    expect(screen.getByText('Review & Approval')).toBeTruthy()
    expect(screen.getByText('Monitoring')).toBeTruthy()
    expect(screen.getByText('Accounting')).toBeTruthy()
  })

  it('gives the Accountant payments, treasury and the books — and no making', () => {
    renderAt('/fms', 'accountant')
    const shown = links()
    expect(shown).toEqual([
      'Overview',
      'Supplier Invoices',
      'Reimbursements',
      'Sales & Collections',
      'Settlements',
      'Payroll Finance',
      'Cash & Bank',
      'Chart of Accounts',
      'Journal Entries',
      'General Ledger',
      'Trial Balance',
      'Reports',
    ])
    expect(shown).not.toContain('Requests')
    expect(shown).not.toContain('Procurement')
    expect(shown).not.toContain('Budgets')
    expect(shown).not.toContain('Vendors')
    expect(shown).not.toContain('Categories')
  })

  // The same component, mounted for a different account: what changed is the
  // menu, not the application.
  it('follows the role on reload rather than remembering the last one', () => {
    const first = renderAt('/fms', 'accountant')
    expect(links()).toContain('General Ledger')
    first.unmount()

    renderAt('/fms', 'finance_staff')
    expect(links()).not.toContain('General Ledger')
    expect(links()).toContain('Requests')
  })

  it('still says Finance, and still stamps the build', () => {
    renderAt('/fms/journal', 'accountant')
    expect(screen.getByText('Finance')).toBeTruthy()
  })

  // The separation is inside /fms only. Standing in HR, an HR account gets the
  // HR menu exactly as before.
  it('leaves the HR sidebar alone', () => {
    renderAt('/dashboard', 'hr_manager')
    const shown = links()
    expect(shown).toContain('Dashboard')
    expect(shown).toContain('Employees')
    expect(shown).not.toContain('Journal Entries')
    expect(screen.getByText('Human Resources')).toBeTruthy()
    expect(screen.getByText('Reference Data')).toBeTruthy()
  })

  it('marks the page you are on', () => {
    renderAt('/fms/ledger', 'accountant')
    const active = screen.getByRole('link', { name: 'General Ledger' })
    expect(within(active.parentElement!).getByText('General Ledger')).toBeTruthy()
    expect(active.className).toContain('bg-primary')
  })
})
