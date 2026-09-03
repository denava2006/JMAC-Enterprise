import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { UserRole } from '@/lib/enums'

/**
 * Who may write a purchase order, asked of the screen.
 *
 * A hosted screenshot showed a Finance Manager reviewing an order with the line
 * editor and the delete icons still on it -- the checker being offered the
 * maker's controls on the document they were about to approve. The database now
 * refuses those writes outright, and these tests hold the other half: that the
 * controls are not on the page to begin with. A control that appears and then
 * fails is worse than one that was never offered.
 */

const state: { role: UserRole; status: string } = { role: 'finance_staff', status: 'draft' }

const ORDER = {
  id: 'po-1',
  po_number: 'PO-2026-0001',
  vendor_name: 'ZZ Supplier',
  expected_delivery_date: null,
  notes: null,
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { role: state.role } }),
}))

vi.mock('@/hooks/useBranches', () => ({ useBranches: () => ({ data: [] }) }))
vi.mock('@/hooks/usePosCatalogue', () => ({ usePosProducts: () => ({ data: [] }) }))

vi.mock('@/hooks/useProcurement', () => ({
  PO_STATUS_LABEL: {
    draft: 'Draft',
    pending_approval: 'Pending approval',
    approved: 'Approved',
    returned: 'Returned',
  },
  usePurchaseOrders: () => ({ data: [{ ...ORDER, status: state.status }] }),
  usePurchaseOrderItems: () => ({
    data: [
      {
        id: 'line-1',
        description: 'ZZ Cola case',
        quantity_ordered: 10,
        unit_of_measure: 'case',
        unit_cost: '55.00',
        line_total: '550.00',
        quantity_cancelled: 0,
        pos_product_id: null,
        pos_products: null,
        branches: null,
      },
    ],
  }),
  usePurchaseOrderSources: () => ({ data: [] }),
  useRemovePurchaseOrderItem: () => ({ mutate: vi.fn(), isPending: false }),
  useSavePurchaseOrderItem: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useTransitionPurchaseOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDiscardDraft: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelRemainder: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

const { PurchaseOrderDetail } = await import('@/components/fms/PurchaseOrderDetail')

function show() {
  return render(<PurchaseOrderDetail orderId="po-1" onOpenChange={() => {}} />)
}

afterEach(() => {
  cleanup()
  state.role = 'finance_staff'
  state.status = 'draft'
})

describe('the maker, on an order they may still work on', () => {
  it.each(['draft', 'returned'])('offers the line editor on a %s order', (status) => {
    state.status = status
    show()
    expect(screen.getByLabelText('Description')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove line' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toBeTruthy()
  })

  it('takes the editor away once the order has been submitted', () => {
    state.status = 'pending_approval'
    show()
    expect(screen.queryByLabelText('Description')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove line' })).toBeNull()
  })

  it('does not offer the maker an approval', () => {
    state.status = 'pending_approval'
    show()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })
})

describe('the checker never sees the maker’s controls', () => {
  it.each(['draft', 'returned', 'pending_approval', 'approved'])(
    'gives a Finance Manager no line editor on a %s order',
    (status) => {
      state.role = 'finance_manager'
      state.status = status
      show()
      expect(screen.queryByLabelText('Description')).toBeNull()
      expect(screen.queryByLabelText('Quantity')).toBeNull()
      expect(screen.queryByLabelText('Unit cost')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Remove line' })).toBeNull()
    },
  )

  it('gives a Finance Manager no way to submit an order for their own approval', () => {
    state.role = 'finance_manager'
    state.status = 'draft'
    show()
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull()
  })

  it('still lets the Finance Manager decide a submitted order', () => {
    state.role = 'finance_manager'
    state.status = 'pending_approval'
    show()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Return for revision' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
  })

  it('shows the order itself either way, because reviewing means reading it', () => {
    state.role = 'finance_manager'
    state.status = 'pending_approval'
    show()
    expect(screen.getByText('PO-2026-0001')).toBeTruthy()
    expect(screen.getByText(/ZZ Cola case/)).toBeTruthy()
  })
})

describe('everybody else', () => {
  it.each(['accountant', 'admin', 'employee'] as const)(
    'gives %s neither editing nor decisions',
    (role) => {
      state.role = role
      state.status = 'pending_approval'
      show()
      expect(screen.queryByLabelText('Description')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Remove line' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull()
    },
  )
})
