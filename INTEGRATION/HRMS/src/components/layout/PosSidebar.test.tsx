import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { PosAssignment } from '@/lib/portals'

/**
 * What the POS portal offers each audience.
 *
 * This pins the lists themselves. Navigation is not authorization -- the route
 * guard and the database refuse a cashier who types /pos/stock regardless --
 * but an entry that appears and then bounces the person who clicks it is a
 * broken promise, so the lists are worth holding still.
 */

const state: { assignments: PosAssignment[] } = { assignments: [] }

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    posAccess: {
      hasAccess: state.assignments.length > 0,
      branchIds: state.assignments.map((a) => a.branchId),
      assignments: state.assignments,
    },
  }),
}))

const { PosSidebar } = await import('@/components/layout/PosSidebar')

const labels = () =>
  screen.getAllByRole('link').map((a) => (a.textContent ?? '').trim())

function show() {
  render(
    <MemoryRouter>
      <PosSidebar />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  state.assignments = []
})

describe('a cashier', () => {
  it('is offered exactly the two things they do: sell, and look up their own sales', () => {
    state.assignments = [{ branchId: 'b1', role: 'cashier' }]
    show()
    expect(labels()).toEqual(['POS', 'Transactions'])
  })

  it('is not shown branch stock, which the database would refuse them anyway', () => {
    state.assignments = [{ branchId: 'b1', role: 'cashier' }]
    show()
    expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull()
  })

  it('is offered no audit log at all', () => {
    state.assignments = [{ branchId: 'b1', role: 'cashier' }]
    show()
    expect(screen.queryByRole('link', { name: 'Audit Logs' })).toBeNull()
  })

  it('is offered no manager dashboard or category summary', () => {
    state.assignments = [{ branchId: 'b1', role: 'cashier' }]
    show()
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Categories' })).toBeNull()
  })

  it('gains nothing from the manager list growing', () => {
    // Products and POS Settings are manager modules. A cashier's list stayed
    // exactly two items when they were added.
    state.assignments = [{ branchId: 'b1', role: 'cashier' }]
    show()
    expect(screen.queryByRole('link', { name: 'Products' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'POS Settings' })).toBeNull()
    expect(labels()).toHaveLength(2)
  })
})

describe('a POS manager', () => {
  it('runs the branch: how it is trading, what it holds, how it is filed', () => {
    state.assignments = [{ branchId: 'b1', role: 'manager' }]
    show()
    expect(labels()).toEqual(
      ['Dashboard', 'POS', 'Products', 'Categories', 'Inventory',
    'Deliveries', 'Transactions', 'POS Reports', 'POS Audit Logs', 'POS Settings']
    )
  })

  it('gets operational Reports and a POS-scoped Audit Log', () => {
    state.assignments = [{ branchId: 'b1', role: 'manager' }]
    show()
    expect(screen.getByRole('link', { name: 'POS Reports' }).getAttribute('href')).toBe(
      '/pos/reports'
    )
    // A POS operational audit at /pos/audit-logs -- NOT the enterprise HRMS
    // audit log, which a branch manager has no claim on. The RPC behind it
    // returns branch-operational events only.
    expect(screen.getByRole('link', { name: 'POS Audit Logs' }).getAttribute('href')).toBe(
      '/pos/audit-logs'
    )
  })

  it('still gives requests no entry of their own -- they are raised about a product', () => {
    // Unchanged intent, new count. The list grew to nine when Products and POS
    // Settings arrived, but a request is still something you raise from
    // Products or the Inventory tab strip, not a place you navigate to.
    state.assignments = [{ branchId: 'b1', role: 'manager' }]
    show()
    expect(screen.queryByRole('link', { name: 'Requests' })).toBeNull()
    expect(labels()).toHaveLength(10)
  })

  it('mirrors the Administrator POS group, so the two read as one system', () => {
    // Same names, same order, same icons as posAdminNav. Deliberately NOT the
    // same permissions: each page decides what a manager may do, and the
    // database decides again.
    state.assignments = [{ branchId: 'b1', role: 'manager' }]
    show()
    expect(screen.getByRole('link', { name: 'Products' }).getAttribute('href')).toBe(
      '/pos/products'
    )
    expect(screen.getByRole('link', { name: 'POS Settings' }).getAttribute('href')).toBe(
      '/pos/settings'
    )
  })

  it('lands its Dashboard entry on the manager dashboard', () => {
    state.assignments = [{ branchId: 'b1', role: 'manager' }]
    show()
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('href')).toBe(
      '/pos/dashboard'
    )
  })

  it('keeps manager navigation while also cashiering elsewhere', () => {
    // The nav answers "is this account a manager anywhere". Which branch they
    // may actually manage is decided per branch, by the page and the database.
    state.assignments = [
      { branchId: 'b1', role: 'cashier' },
      { branchId: 'b2', role: 'manager' },
    ]
    show()
    expect(labels()).toEqual(
      ['Dashboard', 'POS', 'Products', 'Categories', 'Inventory',
    'Deliveries', 'Transactions', 'POS Reports', 'POS Audit Logs', 'POS Settings']
    )
  })
})

describe('the retired screens', () => {
  it('offers no Catalogue anywhere: pause and resume live on Products', () => {
    state.assignments = [{ branchId: 'b1', role: 'manager' }]
    show()
    expect(screen.queryByRole('link', { name: 'Catalogue' })).toBeNull()
  })

  it('sends the POS label at the till, not "Till"', () => {
    state.assignments = [{ branchId: 'b1', role: 'cashier' }]
    show()
    const pos = screen.getByRole('link', { name: 'POS' })
    expect(pos.getAttribute('href')).toBe('/pos/till')
  })
})
