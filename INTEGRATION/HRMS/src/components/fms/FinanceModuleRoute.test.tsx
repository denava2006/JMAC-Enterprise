import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * Typing the URL of somebody else's module.
 *
 * This is the half that matters. Removing a link from a menu is housekeeping;
 * a workspace separation that can be walked around by editing the address bar
 * has not separated anything.
 */

const state = { role: 'finance_staff' as string | null, initializing: false }

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: state.role ? { id: 'u1', role: state.role } : null,
    initializing: state.initializing,
  }),
}))

import { FinanceModuleRoute } from '@/components/fms/FinanceModuleRoute'

/** Mount one guarded page at its own URL and report where the viewer ends up. */
function visit(route: string, role: string | null) {
  state.role = role
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/fms" element={<p>Finance overview</p>} />
        <Route
          path={route}
          element={
            <FinanceModuleRoute route={route}>
              <p>The page</p>
            </FinanceModuleRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

const rendered = () => !!screen.queryByText('The page')
const bouncedToOverview = () => !!screen.queryByText('Finance overview')

afterEach(() => {
  cleanup()
  state.initializing = false
})

describe('a Finance module reached by URL', () => {
  it.each([
    ['/fms/journal'],
    ['/fms/ledger'],
    ['/fms/trial-balance'],
    ['/fms/reports'],
    ['/fms/accounts'],
    ['/fms/payroll'],
    ['/fms/treasury'],
    ['/fms/settlements'],
    ['/fms/sales'],
  ])('refuses Finance Staff %s and returns them to the overview', (route) => {
    visit(route, 'finance_staff')
    expect(rendered()).toBe(false)
    expect(bouncedToOverview()).toBe(true)
  })

  it.each([['/fms/procurement'], ['/fms/requests'], ['/fms/budgets'], ['/fms/vendors']])(
    'refuses the Accountant %s',
    (route) => {
      visit(route, 'accountant')
      expect(rendered()).toBe(false)
      expect(bouncedToOverview()).toBe(true)
    },
  )

  it.each([['/fms/journal'], ['/fms/ledger'], ['/fms/trial-balance'], ['/fms/reports']])(
    'lets the Finance Manager read %s',
    (route) => {
      visit(route, 'finance_manager')
      expect(rendered()).toBe(true)
    },
  )

  it.each([['/fms/journal'], ['/fms/ledger'], ['/fms/accounts'], ['/fms/treasury']])(
    'lets the Accountant open %s',
    (route) => {
      visit(route, 'accountant')
      expect(rendered()).toBe(true)
    },
  )

  // The pages every Finance role shares. Separating the workspaces must not
  // have broken the deep links inside a workflow all three take part in.
  it.each([['finance_staff'], ['finance_manager'], ['accountant']])(
    'still lets %s open Reimbursements and Supplier Invoices',
    (role) => {
      visit('/fms/reimbursements', role)
      expect(rendered()).toBe(true)
      cleanup()
      visit('/fms/invoices', role)
      expect(rendered()).toBe(true)
    },
  )

  // Oversight: every module opens, including the ones no finance role holds
  // in full. What an Administrator may DO on them is decided elsewhere and is
  // unchanged.
  it.each([
    ['/fms/requests'],
    ['/fms/procurement'],
    ['/fms/budgets'],
    ['/fms/invoices'],
    ['/fms/reimbursements'],
    ['/fms/vendors'],
    ['/fms/categories'],
    ['/fms/sales'],
    ['/fms/settlements'],
    ['/fms/payroll'],
    ['/fms/treasury'],
    ['/fms/accounts'],
    ['/fms/journal'],
    ['/fms/ledger'],
    ['/fms/trial-balance'],
    ['/fms/reports'],
  ])('lets an Administrator open %s', (route) => {
    visit(route, 'admin')
    expect(rendered()).toBe(true)
  })

  it('refuses an account with no role at all', () => {
    visit('/fms/ledger', null)
    expect(rendered()).toBe(false)
  })

  // The profile arrives a moment after the session. Deciding in that gap would
  // bounce a legitimate Accountant off their own page on every hard refresh.
  it('decides nothing while the profile is still loading', () => {
    state.initializing = true
    visit('/fms/ledger', null)
    expect(rendered()).toBe(false)
    expect(bouncedToOverview()).toBe(false)
  })
})
