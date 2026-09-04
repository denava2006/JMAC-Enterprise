import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { UserRole } from '@/lib/enums'

const state: { role: UserRole } = { role: 'admin' }

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { role: state.role } }),
}))

const { Sidebar, isPortalRoot } = await import('@/components/layout/Sidebar')

function show(at = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Sidebar />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  state.role = 'admin'
})

describe('back-office navigation', () => {
  it('keeps HR Reports and POS Reports as distinct Administrator links', () => {
    show()
    expect(screen.getByRole('link', { name: 'Reports' }).getAttribute('href')).toBe(
      '/dashboard/reports'
    )
    expect(screen.getByRole('link', { name: 'POS Reports' }).getAttribute('href')).toBe(
      '/dashboard/admin/pos-reports'
    )
  })

  it('does not expose Administrator POS Reports to HR staff', () => {
    state.role = 'hr_staff'
    show()
    expect(screen.queryByRole('link', { name: 'POS Reports' })).toBeNull()
  })
})

describe('the Finance menu follows the portal, not the role', () => {
  it('shows Finance modules to a Finance Manager standing in /fms', () => {
    state.role = 'finance_manager'
    show('/fms/budgets')
    expect(screen.getByRole('link', { name: 'Budgets' }).getAttribute('href')).toBe('/fms/budgets')
    expect(screen.getByRole('link', { name: 'Chart of Accounts' }).getAttribute('href')).toBe(
      '/fms/accounts'
    )
    expect(screen.getByText('Finance')).toBeTruthy()
  })

  it('does not put HR modules in the Finance menu', () => {
    state.role = 'accountant'
    show('/fms')
    expect(screen.queryByRole('link', { name: 'Recruitment' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Payroll' })).toBeNull()
    expect(screen.queryByText('Reference Data')).toBeNull()
  })

  it('does not carry the back office into Finance for an Administrator', () => {
    // An Administrator holds no operational finance role, so they should not be
    // standing here at all. If a link ever put them here, the menu must not
    // bring the whole of HR and POS along with them.
    state.role = 'admin'
    show('/fms')
    expect(screen.queryByRole('link', { name: 'POS Reports' })).toBeNull()
    expect(screen.queryByText('Administration')).toBeNull()
  })
})

/**
 * The active row is how somebody knows where they are. Two lit rows is not a
 * cosmetic problem: Overview stayed highlighted on every /fms/* page, so the
 * menu said "Overview" while the screen said "Vendors".
 */
describe('exactly one navigation row is ever active', () => {
  function activeLinkNames() {
    return screen
      .getAllByRole('link')
      .filter((el) => el.getAttribute('aria-current') === 'page')
      .map((el) => el.textContent?.trim())
  }

  it.each([
    ['/fms', 'Overview'],
    ['/fms/requests', 'Requests'],
    ['/fms/sales', 'Sales & Collections'],
    ['/fms/settlements', 'Settlements'],
    ['/fms/treasury', 'Cash & Bank'],
    ['/fms/procurement', 'Procurement'],
    ['/fms/budgets', 'Budgets'],
    ['/fms/vendors', 'Vendors'],
    ['/fms/categories', 'Categories'],
    ['/fms/accounts', 'Chart of Accounts'],
  ])('marks only %s active, as %s', (path, expected) => {
    state.role = 'finance_staff'
    show(path)
    expect(activeLinkNames()).toEqual([expected])
  })

  it('does not leave Finance Overview lit on a child route', () => {
    // The regression itself, named: /fms is a prefix of /fms/vendors, so
    // without exact matching both rows light up.
    state.role = 'finance_manager'
    show('/fms/vendors')
    const overview = screen.getByRole('link', { name: 'Overview' })
    expect(overview.getAttribute('aria-current')).toBeNull()
  })

  it.each([
    ['/dashboard', 'Dashboard'],
    ['/dashboard/employees', 'Employees'],
  ])('applies the same rule in the back office: %s', (path, expected) => {
    state.role = 'admin'
    show(path)
    expect(activeLinkNames()).toEqual([expected])
  })

  it('treats a portal root as exact and a page within one as a prefix', () => {
    expect(isPortalRoot('/fms')).toBe(true)
    expect(isPortalRoot('/dashboard')).toBe(true)
    expect(isPortalRoot('/pos')).toBe(true)
    expect(isPortalRoot('/fms/vendors')).toBe(false)
    expect(isPortalRoot('/dashboard/admin/work-schedules')).toBe(false)
  })
})
