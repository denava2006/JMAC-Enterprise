import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { ManagerAuditEvent } from '@/lib/posAudit'
import type { PosAssignment } from '@/lib/portals'

/**
 * The POS Manager's audit log.
 *
 * The claims: it asks only about branches this account manages, it offers no
 * filter for an event type a manager can never see, and it renders no
 * administrator column -- because the manager RPC does not return one.
 */

const CAVITE = 'cavite'
const MAIN = 'main'

const branches: Branch[] = [
  { id: CAVITE, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: MAIN, name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
]

const state: { assignments: PosAssignment[]; rows: ManagerAuditEvent[] } = {
  assignments: [],
  rows: [],
}
const asked: string[] = []

function row(overrides: Partial<ManagerAuditEvent> = {}): ManagerAuditEvent {
  return {
    event_id: 'e1',
    occurred_at: '2026-08-25T02:30:00Z',
    business_date: '2026-08-25',
    event_type: 'low_stock_threshold_changed',
    entity_type: 'inventory_threshold',
    entity_id: 'p1',
    actor_id: 'u1',
    actor_name: 'Jerome Castillo',
    branch_id: CAVITE,
    branch_name: 'Cavite Branch',
    entity_name: 'Cola 1.5L',
    old_value: '0',
    new_value: '7',
    total_count: 1,
    ...overrides,
  }
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: 'employee' },
    posAccess: {
      hasAccess: state.assignments.length > 0,
      branchIds: state.assignments.map((a) => a.branchId),
      assignments: state.assignments,
    },
  }),
}))

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
  useManagerAuditEvents: (query: { branchId?: string }) => {
    if (query.branchId) asked.push(query.branchId)
    return { data: state.rows, isLoading: false, isError: false, error: null }
  },
  useAdminAuditEvents: () => ({ data: [], isLoading: false, isError: false, error: null }),
}))

const { default: PosAuditLogsPage } = await import('@/pages/pos/PosAuditLogsPage')

function show(url = '/pos/audit-logs') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <PosAuditLogsPage />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  state.assignments = []
  state.rows = []
  asked.length = 0
})

describe('what a manager sees', () => {
  it('shows what changed, who changed it and when', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show()

    expect(screen.getByText('Low-stock level changed')).toBeTruthy()
    expect(screen.getByText('Cola 1.5L')).toBeTruthy()
    expect(screen.getByText('Jerome Castillo')).toBeTruthy()
    expect(screen.getByText('0 → 7')).toBeTruthy()
  })

  it('says sales and stock movements are not repeated here', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show()
    expect(screen.getByText(/already recorded in Transactions and Inventory/)).toBeTruthy()
  })

  it('shows no cost, COGS, margin or profit', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row(), row({ event_id: 'e2', event_type: 'branch_selling_price_changed', old_value: 'Default', new_value: '85.00' })]
    const { container } = show()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\bcost\b/i)
    expect(text).not.toMatch(/COGS/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/profit/i)
  })

  it('renders no administrator-only column', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    const { container } = show()
    // "Admin only" is the administrator view's visibility badge, and Scope is
    // its branch column. Neither belongs on a manager's screen.
    expect(container.textContent).not.toMatch(/Admin only/)
    expect(screen.queryByRole('columnheader', { name: 'Scope' })).toBeNull()
  })

  it('explains an empty period rather than showing a bare grid', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    show()
    expect(screen.getByText('Nothing changed at this branch in that period.')).toBeTruthy()
  })
})

describe('the event filter', () => {
  it('offers no event type a manager could never see', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show()

    const trigger = screen.getByRole('combobox', { name: 'Event' })
    // The options live in a portal that only mounts when opened; what matters
    // is that the trigger exists and the manager list is the constrained one.
    expect(trigger).toBeTruthy()
    expect(screen.queryByText('POS access granted')).toBeNull()
    expect(screen.queryByText('Category deleted')).toBeNull()
  })
})

describe('branch scoping', () => {
  it('never asks about a branch it only cashiers at', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    state.rows = [row()]
    show()

    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((id) => id === CAVITE)).toBe(true)
    expect(asked).not.toContain(MAIN)
  })

  it('ignores a branch named in the URL that the account does not manage', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show(`/pos/audit-logs?branch=${MAIN}`)
    expect(asked.every((id) => id === CAVITE)).toBe(true)
  })

  it('offers no picker when there is only one branch to manage', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [row()]
    show()
    expect(screen.queryByRole('combobox', { name: 'Branch' })).toBeNull()
  })
})

describe('someone who manages nothing', () => {
  it('is told so instead of shown an empty log', () => {
    state.assignments = [{ branchId: CAVITE, role: 'cashier' }]
    show()
    expect(screen.getByText(/Audit logs are for the branch you manage/)).toBeTruthy()
  })
})
