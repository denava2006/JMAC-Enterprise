import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { UserRole } from '@/lib/enums'

const state: { role: UserRole } = { role: 'admin' }

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { role: state.role } }),
}))

const { Sidebar } = await import('@/components/layout/Sidebar')

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
