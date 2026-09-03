import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { QueuedRequest } from '@/lib/posRequests'

/**
 * The POS request review queue.
 *
 * The claims: it defaults to what is waiting, it offers Review only where the
 * database says the caller may act, and it never lets "approved" read as
 * "ordered" or "received".
 */

const CAVITE = 'cavite'

const branches: Branch[] = [
  { id: CAVITE, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: 'main', name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
]

const state: { rows: QueuedRequest[] } = { rows: [] }
const queries: { branchId?: string; status?: string }[] = []
const reviews: { requestId: string; approve: boolean; note: string }[] = []

function queued(overrides: Partial<QueuedRequest> = {}): QueuedRequest {
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
    requester_enterprise_role: 'employee',
    requested_at: '2026-08-27T02:00:00Z',
    reviewer_name: null,
    reviewed_at: null,
    review_note: null,
    can_review: true,
    total_count: 1,
    ...overrides,
  }
}

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

vi.mock('@/hooks/usePosRequests', () => ({
  useRequestQueue: (branchId?: string, status?: string) => {
    queries.push({ branchId, status })
    return { data: state.rows, isLoading: false, isError: false, error: null }
  },
  useReviewRequest: () => ({
    mutate: (input: { requestId: string; approve: boolean; note: string }) => {
      reviews.push(input)
    },
    isPending: false,
  }),
}))

const { default: AdminPosRequestsPage } = await import('@/pages/admin/PosRequestsPage')

const show = () =>
  render(
    <MemoryRouter>
      <AdminPosRequestsPage />
    </MemoryRouter>
  )

afterEach(() => {
  cleanup()
  state.rows = []
  queries.length = 0
  reviews.length = 0
})

describe('the review queue', () => {
  it('opens on what is waiting, across every branch', () => {
    show()
    expect(queries[0].status).toBe('pending')
    expect(queries[0].branchId).toBeUndefined()
  })

  it('shows what was asked for, by whom, and where', () => {
    state.rows = [queued()]
    show()
    expect(screen.getByText('Cola 1.5L')).toBeTruthy()
    expect(screen.getByText('Cavite Branch')).toBeTruthy()
    expect(screen.getByText(/Jerome Castillo/)).toBeTruthy()
    expect(screen.getByText('24 units')).toBeTruthy()
  })

  it('says an approval settles no budget, supplier, order or stock', () => {
    state.rows = [queued()]
    show()
    expect(
      screen.getByText(/does not approve a budget, choose a supplier, place an order, or change stock/)
    ).toBeTruthy()
  })

  it('says restock review is destined for Finance', () => {
    // The Administrator is a stand-in here, not the business owner of restock.
    show()
    expect(screen.getByText(/Restock demand will move to Finance once FMS is integrated/)).toBeTruthy()
  })

  it('explains an empty queue', () => {
    show()
    expect(screen.getByText('Nothing is waiting for review.')).toBeTruthy()
  })
})

describe('what may be acted on', () => {
  it('offers Review where the database says the caller may act', () => {
    state.rows = [queued({ can_review: true })]
    show()
    expect(screen.getByRole('button', { name: /Review Cola 1\.5L/ })).toBeTruthy()
  })

  it('offers nothing where the database says otherwise', () => {
    // can_review comes from the same predicate the write path uses -- a request
    // they raised themselves, or one already decided.
    state.rows = [queued({ can_review: false, status: 'approved', reviewer_name: 'Administrator' })]
    show()
    expect(screen.queryByRole('button', { name: /Review/ })).toBeNull()
  })
})

describe('reviewing', () => {
  it('cannot decline without a reason', () => {
    state.rows = [queued()]
    show()
    fireEvent.click(screen.getByRole('button', { name: /Review Cola 1\.5L/ }))
    expect((screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('declines with the reason attached', () => {
    state.rows = [queued()]
    show()
    fireEvent.click(screen.getByRole('button', { name: /Review Cola 1\.5L/ }))
    fireEvent.change(screen.getByLabelText(/Note/), {
      target: { value: 'Central warehouse is short too' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(reviews).toEqual([
      { requestId: 'r1', approve: false, note: 'Central warehouse is short too' },
    ])
  })

  it('approves without requiring a note', () => {
    state.rows = [queued()]
    show()
    fireEvent.click(screen.getByRole('button', { name: /Review Cola 1\.5L/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(reviews[0]).toMatchObject({ requestId: 'r1', approve: true })
  })

  it('tells the reviewer what approving a restock actually does', () => {
    state.rows = [queued({ request_type: 'restock' })]
    show()
    fireEvent.click(screen.getByRole('button', { name: /Review Cola 1\.5L/ }))
    expect(screen.getByText(/clears it to proceed to procurement/)).toBeTruthy()
    expect(screen.getByText(/does not approve a budget, choose a supplier, place an order, or add any stock/)).toBeTruthy()
  })

  it('tells the reviewer a carry approval leaves it off and empty', () => {
    state.rows = [queued({ request_type: 'carry_existing_product', requested_quantity: null })]
    show()
    fireEvent.click(screen.getByRole('button', { name: /Review Cola 1\.5L/ }))
    expect(screen.getByText(/created switched off with no stock/)).toBeTruthy()
  })
})

describe('the FMS boundary on screen', () => {
  it('shows no amount, budget, vendor or cost field', () => {
    state.rows = [queued()]
    const { container } = show()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\bcost\b/i)
    expect(text).not.toMatch(/vendor|invoice|purchase order|budget of/i)
    expect(text).not.toMatch(/₱/)
  })
})
