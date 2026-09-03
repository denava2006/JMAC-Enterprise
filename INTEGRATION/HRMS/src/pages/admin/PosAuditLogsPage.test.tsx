import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { AdminAuditEvent, AdminBranchScope } from '@/lib/posAudit'

/**
 * The POS audit log for the Administrator.
 *
 * The claims: it defaults to every branch rather than guessing one, it renders
 * the administrator columns the Manager view does not have, and it still shows
 * no cost -- a buying-cost change is recorded as a fact, never as a number.
 */

const CAVITE = 'cavite'
const MAIN = 'main'

const branches: Branch[] = [
  { id: CAVITE, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: MAIN, name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: 'closed', name: 'Closed Depot', address: null, phone: null, latitude: null, longitude: null, is_active: false, created_at: '', updated_at: '' },
]

const state: { rows: AdminAuditEvent[] } = { rows: [] }
const scopes: AdminBranchScope[] = []

function row(overrides: Partial<AdminAuditEvent> = {}): AdminAuditEvent {
  return {
    event_id: 'e1',
    occurred_at: '2026-08-25T02:30:00Z',
    business_date: '2026-08-25',
    event_type: 'product_updated',
    entity_type: 'product',
    entity_id: 'p1',
    actor_id: 'u1',
    actor_name: 'Administrator',
    actor_enterprise_role: 'admin',
    actor_pos_role: null,
    branch_id: null,
    branch_name: null,
    entity_name: 'Cola 1.5L',
    manager_visible: false,
    description: 'Product updated',
    old_value: null,
    new_value: 'buying cost changed',
    total_count: 1,
    ...overrides,
  }
}

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

vi.mock('@/hooks/usePosReports', () => ({
  usePosReportPresets: () => ({
    data: [
      { preset: 'today', date_from: '2026-08-25', date_to: '2026-08-25', sort_order: 1 },
      { preset: 'month_to_date', date_from: '2026-08-01', date_to: '2026-08-25', sort_order: 4 },
    ],
    isLoading: false,
  }),
}))

vi.mock('@/hooks/usePosAudit', () => ({
  useManagerAuditEvents: () => ({ data: [], isLoading: false, isError: false, error: null }),
  useAdminAuditEvents: (query: { scope?: AdminBranchScope }) => {
    scopes.push(query.scope ?? 'all')
    return { data: state.rows, isLoading: false, isError: false, error: null }
  },
}))

const { default: AdminPosAuditLogsPage } = await import('@/pages/admin/PosAuditLogsPage')

const show = () =>
  render(
    <MemoryRouter>
      <AdminPosAuditLogsPage />
    </MemoryRouter>
  )

afterEach(() => {
  cleanup()
  state.rows = []
  scopes.length = 0
})

describe('the administrator audit log', () => {
  it('starts across every branch rather than guessing one', () => {
    show()
    expect(scopes.length).toBeGreaterThan(0)
    expect(scopes.every((s) => s === 'all')).toBe(true)
  })

  it('offers an explicit enterprise-wide scope', () => {
    // Global catalogue and access events carry no branch. Folding them into an
    // arbitrary branch would invent a scope the action did not have.
    show()
    expect(screen.getByRole('combobox', { name: 'Scope' })).toBeTruthy()
  })

  it('shows the administrator-only events a manager never receives', () => {
    state.rows = [
      row({ event_type: 'assignment_granted', entity_type: 'branch_assignment', entity_name: 'Liza Fernandez' }),
    ]
    show()
    expect(screen.getByText('POS access granted')).toBeTruthy()
    expect(screen.getByText('Admin only')).toBeTruthy()
  })

  it('records who acted, in what capacity, using both role snapshots', () => {
    state.rows = [row({ actor_name: 'Jerome Castillo', actor_enterprise_role: 'employee', actor_pos_role: 'manager', branch_id: CAVITE, branch_name: 'Cavite Branch', manager_visible: true, event_type: 'product_offered' })]
    show()
    expect(screen.getByText('Jerome Castillo')).toBeTruthy()
    expect(screen.getByText('POS Manager')).toBeTruthy()
  })

  it('shows an Administrator as an Administrator, with no POS role', () => {
    state.rows = [row()]
    show()
    expect(screen.getAllByText('Administrator').length).toBeGreaterThan(0)
  })

  it('files a global event under Enterprise-wide, not a branch', () => {
    state.rows = [row({ branch_id: null, branch_name: null })]
    show()
    expect(screen.getByText('Enterprise-wide')).toBeTruthy()
  })

  it('records a buying-cost change as a fact, never as a number', () => {
    state.rows = [row({ new_value: 'buying cost changed' })]
    show()
    expect(screen.getByText('buying cost changed')).toBeTruthy()
    const { container } = show()
    expect(container.textContent).not.toMatch(/\d+\.\d\d/)
  })

  it('shows no COGS, margin or profit anywhere', () => {
    state.rows = [row()]
    const { container } = show()
    const text = (container.textContent ?? '').replace(
      /Cost and margin are not shown[\s\S]*?Reports\./,
      ''
    )
    expect(text).not.toMatch(/COGS/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/profit/i)
  })

  it('explains an empty period', () => {
    show()
    expect(screen.getByText('No POS changes were recorded in that period.')).toBeTruthy()
  })
})
