import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { ManagerRequest } from '@/lib/posRequests'
import type { PosAssignment } from '@/lib/portals'

/**
 * What a POS Manager can ask the business for.
 *
 * The claims: they ask only for branches they manage, they see what happened to
 * their request, and nowhere does the page suggest that an approval put stock
 * on a lorry.
 */

const CAVITE = 'cavite'
const MAIN = 'main'

const branches: Branch[] = [
  { id: CAVITE, name: 'Cavite Branch', address: null, phone: null, is_active: true, created_at: '', updated_at: '' },
  { id: MAIN, name: 'Main Office', address: null, phone: null, is_active: true, created_at: '', updated_at: '' },
]

const state: {
  assignments: PosAssignment[]
  rows: ManagerRequest[]
  progress: Array<Record<string, unknown>>
} = {
  assignments: [],
  rows: [],
  progress: [],
}
const asked: string[] = []
const cancelled: string[] = []

function request(overrides: Partial<ManagerRequest> = {}): ManagerRequest {
  return {
    request_id: 'r1',
    branch_id: CAVITE,
    branch_name: 'Cavite Branch',
    product_id: 'p1',
    product_name: 'Cola 1.5L',
    request_type: 'restock',
    requested_quantity: 24,
    reason: 'Running low before the weekend',
    status: 'pending',
    requested_by: 'u1',
    requester_name: 'Jerome Castillo',
    requested_at: '2026-08-27T02:00:00Z',
    reviewer_name: null,
    reviewed_at: null,
    review_note: null,
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

vi.mock('@/hooks/usePosInventory', () => ({
  useBranchInventory: () => ({ data: [{ product_id: 'p1', product_name: 'Cola 1.5L' }], isLoading: false }),
}))

// Where procurement got to with each request. Quantities only -- the "no cost,
// price, budget or supplier" assertion below reads this rendered output, so the
// fixture deliberately carries a purchase order number and received counts and
// still must not produce a peso sign anywhere.
vi.mock('@/hooks/useProcurement', () => ({
  REQUEST_PROGRESS_LABEL: {
    with_finance: 'With Finance',
    ordered: 'Ordered — awaiting delivery',
    part_delivered: 'Part delivered',
    delivered: 'Delivered',
  },
  useBranchRequestProgress: () => ({ data: state.progress, isLoading: false }),
}))

vi.mock('@/hooks/usePosRequests', () => ({
  useManagerRequests: (branchId?: string) => {
    if (branchId) asked.push(branchId)
    return { data: state.rows, isLoading: false, isError: false, error: null }
  },
  useCarryableProducts: () => ({ data: [], isLoading: false }),
  useCreateStockRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateCarryRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelRequest: () => ({
    mutate: (id: string) => cancelled.push(id),
    isPending: false,
  }),
}))

const { default: PosRequestsPage } = await import('@/pages/pos/PosRequestsPage')

function show(url = '/pos/requests') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <PosRequestsPage />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  state.assignments = []
  state.rows = []
  state.progress = []
  asked.length = 0
  cancelled.length = 0
})

describe('what a manager sees', () => {
  it('lists their branch"s requests with what was asked for and why', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request()]
    show()

    expect(screen.getByText('Cola 1.5L')).toBeTruthy()
    expect(screen.getByText('24 units')).toBeTruthy()
    expect(screen.getByText('Running low before the weekend')).toBeTruthy()
    expect(screen.getByText('Awaiting review')).toBeTruthy()
  })

  it('says plainly that a request orders nothing', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request()]
    show()
    expect(screen.getByText(/does not order anything/)).toBeTruthy()
    expect(screen.getByText(/quantity changes only when a delivery is received/)).toBeTruthy()
  })

  it('spells out what an approval did and did not do', () => {
    // "Approved" is the word most likely to be read as "it is on its way".
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [
      request({ status: 'approved', reviewer_name: 'Administrator', reviewed_at: '2026-08-27T03:00:00Z' }),
    ]
    show()
    expect(screen.getByText(/No stock has been ordered or received/)).toBeTruthy()
    expect(screen.getByText(/Reviewed by Administrator/)).toBeTruthy()
  })

  it('shows why something was declined', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [
      request({ status: 'declined', review_note: 'Central warehouse is also short', reviewer_name: 'Administrator' }),
    ]
    show()
    expect(screen.getByText('Declined')).toBeTruthy()
    expect(screen.getByText('Central warehouse is also short')).toBeTruthy()
  })

  it('shows no cost, price, budget or supplier anywhere', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request(), request({ request_id: 'r2', status: 'approved' })]
    const { container } = show()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\bcost\b/i)
    expect(text).not.toMatch(/budget|supplier|vendor|invoice/i)
    expect(text).not.toMatch(/₱/)
  })

  it('explains an empty list', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    show()
    expect(screen.getByText('This branch has not asked for anything yet.')).toBeTruthy()
  })
})

describe('withdrawing', () => {
  it('offers Withdraw on their own pending request', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request({ requested_by: 'u1', status: 'pending' })]
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
    expect(cancelled).toEqual(['r1'])
  })

  it('offers nothing once a decision has been made', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request({ requested_by: 'u1', status: 'approved', reviewer_name: 'Administrator' })]
    show()
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull()
  })

  it('offers nothing on somebody else"s request', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request({ requested_by: 'someone-else' })]
    show()
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull()
  })
})

describe('branch scoping', () => {
  it('never asks about a branch it only cashiers at', () => {
    state.assignments = [
      { branchId: CAVITE, role: 'manager' },
      { branchId: MAIN, role: 'cashier' },
    ]
    state.rows = [request()]
    show()
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((id) => id === CAVITE)).toBe(true)
    expect(asked).not.toContain(MAIN)
  })

  it('ignores a branch named in the URL that the account does not manage', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request()]
    show(`/pos/requests?branch=${MAIN}`)
    expect(asked.every((id) => id === CAVITE)).toBe(true)
  })
})

describe('someone who manages nothing', () => {
  it('is told so instead of shown an empty queue', () => {
    state.assignments = [{ branchId: CAVITE, role: 'cashier' }]
    show()
    expect(screen.getByText(/Stock requests are for the branch you manage/)).toBeTruthy()
  })
})

describe('what became of it', () => {
  function progressFor(overrides: Record<string, unknown> = {}) {
    return {
      request_id: 'r1',
      product_id: 'p1',
      product_name: 'Cola 1.5L',
      requested_quantity: 24,
      requested_at: '2026-08-27T02:00:00Z',
      request_status: 'approved',
      po_number: 'PO-2026-0007',
      po_status: 'approved',
      quantity_ordered: 24,
      quantity_received: 10,
      quantity_outstanding: 14,
      progress: 'part_delivered',
      ...overrides,
    }
  }

  it('tells the branch where procurement got to, and against which order', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request({ status: 'approved', reviewer_name: 'Alice Dela Cruz' })]
    state.progress = [progressFor()]
    show()
    expect(screen.getByText(/Part delivered/)).toBeTruthy()
    expect(screen.getByText(/PO-2026-0007/)).toBeTruthy()
    expect(screen.getByText('10 of 24 received')).toBeTruthy()
  })

  it('still shows no cost, price, budget or supplier once progress is on screen', () => {
    // The guarantee that matters: the branch learns what arrived, never what it
    // cost or who supplied it. The function feeding this returns no such column.
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request({ status: 'approved', reviewer_name: 'Alice Dela Cruz' })]
    state.progress = [progressFor()]
    const { container } = show()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\bcost\b/i)
    expect(text).not.toMatch(/budget|supplier|vendor|invoice|margin/i)
    expect(text).not.toMatch(/₱/)
  })

  it('says nothing at all for a request procurement has not touched', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request()]
    state.progress = []
    show()
    expect(screen.queryByText(/received$/)).toBeNull()
    expect(screen.queryByText(/PO-/)).toBeNull()
  })

  it('does not attach one request’s progress to another', () => {
    state.assignments = [{ branchId: CAVITE, role: 'manager' }]
    state.rows = [request({ request_id: 'r1' }), request({ request_id: 'r2' })]
    state.progress = [progressFor({ request_id: 'r2', quantity_received: 3 })]
    show()
    // One row has progress; the other must not borrow it.
    expect(screen.getAllByText('3 of 24 received')).toHaveLength(1)
  })
})
