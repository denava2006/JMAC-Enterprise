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

interface MarginRow {
  item_id: string
  description: string
  quantity_ordered: number
  unit_cost: number
  current_selling_price: number | null
  selling_price_snapshot: number | null
  branch_name: string | null
}

const state: {
  role: UserRole
  status: string
  received: number
  outstanding: number
  budgetName: string | null
  margins: MarginRow[]
} = {
  role: 'finance_staff',
  status: 'draft',
  received: 0,
  outstanding: 20,
  budgetName: null,
  margins: [],
}

/** One POS-sourced line, priced as the brief's example. */
function marginRow(overrides: Partial<MarginRow> = {}): MarginRow {
  return {
    item_id: 'line-1',
    description: 'ZZ Cola case',
    quantity_ordered: 10,
    unit_cost: 20,
    current_selling_price: 30,
    selling_price_snapshot: 30,
    branch_name: 'Cavite Branch',
    ...overrides,
  }
}

const ORDER = {
  id: 'po-1',
  po_number: 'PO-2026-0001',
  vendor_name: 'ZZ Supplier',
  expected_delivery_date: null,
  notes: null,
  subtotal: '1300.00',
  quantity_ordered: 20,
  committed_amount: '1300.00',
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { role: state.role } }),
}))

vi.mock('@/hooks/useBranches', () => ({ useBranches: () => ({ data: [] }) }))
vi.mock('@/hooks/usePosCatalogue', () => ({ usePosProducts: () => ({ data: [] }) }))

const actual = await vi.importActual<typeof import('@/hooks/useProcurement')>(
  '@/hooks/useProcurement',
)

vi.mock('@/hooks/useProcurement', () => ({
  PO_STATUS_LABEL: {
    draft: 'Draft',
    pending_approval: 'Pending approval',
    approved: 'Approved',
    returned: 'Returned',
  },
  usePurchaseOrders: () => ({
    data: [
      {
        ...ORDER,
        status: state.status,
        quantity_received: state.received,
        quantity_outstanding: state.outstanding,
        budget_name: state.budgetName,
      },
    ],
  }),
  fulfillmentOf: actual.fulfillmentOf,
  fulfillmentNote: actual.fulfillmentNote,
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
  // POS-sourced lines only, so most of these cases have none. The margin
  // review's own behaviour is covered below and in procurementMargin.test.ts.
  usePurchaseOrderMargins: () => ({ data: state.margins }),
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
  state.received = 0
  state.outstanding = 20
  state.budgetName = null
  state.margins = []
})

describe('what the approver is told about margin', () => {
  /**
   * The Finance Manager is the one committing the company. Recomputed on read,
   * never replayed from what Staff typed -- and if the branch has moved its
   * price since submission, said so plainly rather than folded into a figure.
   */
  it('shows the current price, the submitted cost and the margin both ways', () => {
    state.role = 'finance_manager'
    state.status = 'pending_approval'
    state.margins = [marginRow()]
    show()

    expect(screen.getByText('Current selling price')).toBeTruthy()
    expect(screen.getByText('₱30.00')).toBeTruthy()
    expect(screen.getByText('Submitted unit cost')).toBeTruthy()
    expect(screen.getByText('₱20.00')).toBeTruthy()
    expect(screen.getByText('₱10.00')).toBeTruthy()
    expect(screen.getByText('33.33%')).toBeTruthy()
    expect(screen.getByText(/Cavite Branch · before VAT/)).toBeTruthy()
  })

  it('says when the price has moved since the order was submitted', () => {
    // Submitted at 30 against a 28 cost; the branch has since cut to 25. The
    // approval must not proceed as though the margin is still positive.
    state.role = 'finance_manager'
    state.status = 'pending_approval'
    state.margins = [marginRow({ unit_cost: 28, current_selling_price: 25, selling_price_snapshot: 30 })]
    show()

    expect(screen.getByText(/selling price has changed since this order was submitted/)).toBeTruthy()
    expect(screen.getByText(/it was ₱30\.00 then/)).toBeTruthy()
    expect(screen.getByText(/exceeds the current selling price by ₱3\.00 per unit/)).toBeTruthy()
  })

  it('warns on a zero margin without calling it an error', () => {
    state.role = 'finance_manager'
    state.status = 'pending_approval'
    state.margins = [marginRow({ unit_cost: 30 })]
    show()
    expect(screen.getByText(/Zero gross margin/)).toBeTruthy()
  })

  it('offers the approver no control over the selling price', () => {
    // Price belongs to POS. A Finance control to edit it here would make the
    // whole check ceremonial.
    state.role = 'finance_manager'
    state.status = 'pending_approval'
    state.margins = [marginRow({ unit_cost: 35 })]
    show()

    const labels = screen.queryAllByRole('button').map((b) => b.textContent ?? '')
    expect(labels.some((l) => /selling price|set price|edit price/i.test(l))).toBe(false)
    expect(screen.queryByLabelText(/selling price/i)).toBeNull()
  })

  it('says nothing at all when the order has no POS lines', () => {
    // A stationery order has no retail price and no margin. An empty panel
    // would imply the question applies and was not answered.
    state.role = 'finance_manager'
    state.status = 'pending_approval'
    state.margins = []
    show()
    expect(screen.queryByText('Selling price and margin')).toBeNull()
  })
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

describe('what the order says has arrived', () => {
  it('does not claim nothing was received when everything was', () => {
    // The reported defect: this card read "Nothing has been received" directly
    // under "20 of 20 received".
    state.role = 'finance_manager'
    state.status = 'approved'
    state.received = 20
    state.outstanding = 0
    const { container } = show()
    expect(container.textContent).not.toMatch(/nothing has been received/i)
    // "ready to close" is deliberately in two places -- the badge and the note
    // -- so this matches the sentence that only the note carries.
    expect(screen.getByText(/Delivery complete\. All 20 units/)).toBeTruthy()
  })

  it('counts what arrived and what has not, on a partial', () => {
    state.role = 'finance_manager'
    state.status = 'approved'
    state.received = 6
    state.outstanding = 14
    show()
    expect(screen.getByText(/6 of 20 units have arrived/)).toBeTruthy()
    expect(screen.getByText(/14 remain outstanding/)).toBeTruthy()
  })

  it('says nothing has arrived only when nothing has', () => {
    state.role = 'finance_manager'
    state.status = 'approved'
    show()
    expect(screen.getByText(/No units have been received yet/)).toBeTruthy()
  })

  it('badges a fully received order as ready to close, not as awaiting delivery', () => {
    state.role = 'finance_manager'
    state.status = 'approved'
    state.received = 20
    state.outstanding = 0
    const { container } = show()
    expect(screen.getByText('Fully received — ready to close')).toBeTruthy()
    expect(container.textContent).not.toContain('awaiting delivery')
  })
})

describe('the funding source is shown, never edited here', () => {
  it('names the budget the order is charged to', () => {
    state.role = 'finance_manager'
    state.status = 'pending_approval'
    state.budgetName = 'Operations 2026'
    show()
    expect(screen.getByText('Charged to')).toBeTruthy()
    expect(screen.getByText('Operations 2026')).toBeTruthy()
  })

  it('gives the reviewing Manager no control to change it', () => {
    // The checker approves the funding the maker chose. Being able to change it
    // while approving is choosing and approving.
    state.role = 'finance_manager'
    state.status = 'pending_approval'
    state.budgetName = 'Operations 2026'
    show()
    expect(screen.queryByLabelText(/Budget/)).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('says nothing about a budget on an order that has none', () => {
    state.role = 'finance_staff'
    state.status = 'draft'
    state.budgetName = null
    const { container } = show()
    expect(container.textContent).not.toContain('Charged to')
  })
})
