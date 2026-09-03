import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProcurementSourceRef } from '@/hooks/useProcurement'

/**
 * Building an order from demand, asked of the screen.
 *
 * Two hosted defects live here. The old dialog wrote a numbered purchase order
 * the moment it opened, so closing it left a zero-line order behind for ever.
 * And it asked Finance to pick a POS product from a table Finance cannot read,
 * so the only option was "Not POS stock" and the resulting order could never be
 * received by the branch that asked for it.
 */

const built: unknown[] = []

const POS_SOURCE: ProcurementSourceRef = {
  kind: 'pos_restock',
  id: 'req-1',
  label: 'Branch stock',
}
const GENERAL_SOURCE: ProcurementSourceRef = {
  kind: 'finance_request',
  id: 'fr-1',
  label: 'PR-2026-0009',
}

const state: { detail: Record<string, unknown> | null } = { detail: null }

vi.mock('@/hooks/useFinanceMasterData', () => ({
  useVendors: () => ({
    data: [
      { id: 'v1', name: 'Approved Supplier', is_active: true, approval_status: 'approved' },
      { id: 'v2', name: 'Proposed Supplier', is_active: true, approval_status: 'pending_approval' },
    ],
  }),
}))

vi.mock('@/hooks/useProcurement', () => ({
  useProcurementSource: () => ({ data: state.detail, isLoading: false, error: null }),
  useBuildPurchaseOrder: () => ({
    mutateAsync: async (input: unknown) => {
      built.push(input)
      return { id: 'po-new', submitted: (input as { submit: boolean }).submit }
    },
    isPending: false,
  }),
}))

const { PurchaseOrderBuilder } = await import('@/components/fms/PurchaseOrderBuilder')

function show(source: ProcurementSourceRef | null) {
  return render(
    <PurchaseOrderBuilder source={source} onOpenChange={() => {}} onCreated={() => {}} />,
  )
}

afterEach(() => {
  cleanup()
  built.length = 0
  state.detail = null
})

describe('an order exists only when somebody meant to save one', () => {
  it('writes nothing when the builder simply opens', () => {
    state.detail = { source_kind: 'pos_restock', reference: 'Stock request', outstanding: 20 }
    show(POS_SOURCE)
    expect(built).toEqual([])
  })

  it('offers Cancel, Save as draft and Submit as three separate endings', () => {
    state.detail = { source_kind: 'pos_restock', reference: 'Stock request', outstanding: 20 }
    show(POS_SOURCE)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save as draft' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toBeTruthy()
  })

  it('writes nothing when Cancel is pressed', () => {
    state.detail = { source_kind: 'pos_restock', reference: 'Stock request', outstanding: 20 }
    show(POS_SOURCE)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(built).toEqual([])
  })
})

describe('a POS stock request builds itself', () => {
  const detail = {
    source_kind: 'pos_restock',
    reference: 'Stock request',
    product_name: 'Coca-Cola 5.6',
    branch_name: 'Cavite Branch',
    requested_quantity: 20,
    ordered_quantity: 0,
    outstanding: 20,
  }

  it('shows the product and destination the request already named', () => {
    state.detail = detail
    show(POS_SOURCE)
    expect(screen.getByText('Coca-Cola 5.6')).toBeTruthy()
    expect(screen.getByText('Cavite Branch')).toBeTruthy()
  })

  it('never offers a "Not POS stock" choice, because there is nothing to choose', () => {
    // The defect this replaces: a product dropdown fed by a table Finance
    // cannot read, whose only option was the one that broke receiving.
    state.detail = detail
    const { container } = show(POS_SOURCE)
    expect(container.textContent).not.toMatch(/Not POS stock/i)
    expect(screen.queryByLabelText('POS product')).toBeNull()
    expect(screen.queryByLabelText('Description')).toBeNull()
  })

  it('carries the requested quantity through instead of defaulting to 1', () => {
    state.detail = detail
    show(POS_SOURCE)
    expect(screen.getByLabelText(/Quantity to order/)).toHaveProperty('value', '20')
  })

  it('defaults to what is still outstanding when part is already ordered', () => {
    state.detail = { ...detail, ordered_quantity: 12, outstanding: 8 }
    show(POS_SOURCE)
    expect(screen.getByLabelText(/Quantity to order/)).toHaveProperty('value', '8')
  })

  it('will not save until a vendor and a unit cost exist', () => {
    // Both endings stay shut, not just Submit: a draft with no cost is a draft
    // somebody has to reopen, and the server refuses it anyway.
    state.detail = detail
    show(POS_SOURCE)
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByRole('button', { name: 'Save as draft' })).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByLabelText(/Unit cost/), { target: { value: '55' } })
    // Still no vendor, so still shut.
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(built).toEqual([])
  })
})

describe('a general purchase is a different shape', () => {
  const detail = {
    source_kind: 'finance_request',
    reference: 'PR-2026-0009',
    title: 'Office materials',
    requested_by_name: 'Jen Cruz',
    branch_name: 'Main Office',
    outstanding: null,
  }

  it('lets Finance construct the items, because the request names none', () => {
    state.detail = detail
    show(GENERAL_SOURCE)
    expect(screen.getByLabelText('Description')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add item' })).toBeTruthy()
  })

  it('does not ask for a POS quantity or unit cost on a general order', () => {
    state.detail = detail
    show(GENERAL_SOURCE)
    expect(screen.queryByLabelText(/Quantity to order/)).toBeNull()
  })

  it('shows where it is delivered, taken from the request rather than asked for', () => {
    state.detail = detail
    show(GENERAL_SOURCE)
    expect(screen.getByText('Deliver to')).toBeTruthy()
    expect(screen.getByText('Main Office')).toBeTruthy()
  })

  it('says so plainly when the request carried no branch', () => {
    state.detail = { ...detail, branch_name: null }
    show(GENERAL_SOURCE)
    expect(screen.getByText(/No branch recorded/)).toBeTruthy()
  })
})

describe('only an approved vendor can be chosen', () => {
  it('leaves a proposed vendor out of the picker', () => {
    state.detail = { source_kind: 'pos_restock', reference: 'Stock request', outstanding: 20 }
    const { container } = show(POS_SOURCE)
    expect(container.textContent).not.toMatch(/Proposed Supplier/)
  })
})
