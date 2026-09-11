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

const state: {
  detail: Record<string, unknown> | null
  budgets: Array<Record<string, unknown>>
} = {
  detail: null,
  budgets: [
    { id: 'bud1', name: 'Operations 2026', status: 'active', amount: 50000, remaining: 43700 },
    { id: 'bud2', name: 'Draft Ceiling', status: 'draft', amount: 10000, remaining: 10000 },
  ],
}

vi.mock('@/hooks/useFinanceMasterData', () => ({
  useVendors: () => ({
    data: [
      { id: 'v1', name: 'Approved Supplier', is_active: true, approval_status: 'approved' },
      { id: 'v2', name: 'Proposed Supplier', is_active: true, approval_status: 'pending_approval' },
    ],
  }),
  useBudgets: () => ({ data: state.budgets }),
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
  state.budgets = [
    { id: 'bud1', name: 'Operations 2026', status: 'active', amount: 50000, remaining: 43700 },
    { id: 'bud2', name: 'Draft Ceiling', status: 'draft', amount: 10000, remaining: 10000 },
  ]
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
    // What the destination branch charges, resolved server-side. Pre-VAT: at a
    // 12% branch VAT fee the customer pays 33.60 for this.
    branch_selling_price: 30,
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

describe('the margin the order would be bought at', () => {
  /**
   * The business gap this closes: Finance typed a supplier cost with no idea
   * what the destination branch charges, so JMAC could buy a 30.00 product for
   * 35.00 and nobody would know until it was sold at a loss.
   *
   * The screen says what the server will. guard_purchase_order_margin reloads
   * the price itself at submission and again at approval, so nothing here is
   * the protection -- it is the warning that arrives before the refusal.
   */
  const priced = {
    source_kind: 'pos_restock',
    reference: 'Stock request',
    product_name: 'Coca-Cola 5.6',
    branch_name: 'Cavite Branch',
    requested_quantity: 20,
    ordered_quantity: 0,
    outstanding: 20,
    branch_selling_price: 30,
  }

  const typeCost = (value: string) =>
    fireEvent.change(screen.getByLabelText(/Unit cost/), { target: { value } })

  /** Vendor and budget chosen, so the only thing left deciding whether Submit
   *  opens is the margin. Without this the button is shut for reasons that have
   *  nothing to do with cost, and asserting on it would prove nothing. */
  function chooseVendorAndBudget() {
    fireEvent.click(screen.getByLabelText(/Vendor/))
    fireEvent.click(screen.getByRole('option', { name: 'Approved Supplier' }))
    fireEvent.click(screen.getByLabelText(/Budget/))
    fireEvent.click(screen.getByRole('option', { name: /Operations 2026/ }))
  }

  it('shows the destination branch price, and says it is before VAT', () => {
    state.detail = priced
    show(POS_SOURCE)

    expect(screen.getByText('Current selling price')).toBeTruthy()
    expect(screen.getByText('₱30.00')).toBeTruthy()
    // Which branch and which side of VAT: both are load-bearing. Another branch
    // may charge something else, and the customer pays 33.60 for this one.
    expect(screen.getByText(/Cavite Branch · before VAT/)).toBeTruthy()
  })

  it('reports ₱10.00 and 33.33% for a ₱20.00 cost, and allows submission', () => {
    state.detail = priced
    show(POS_SOURCE)
    chooseVendorAndBudget()
    typeCost('20')

    expect(screen.getByText('Gross margin / unit')).toBeTruthy()
    expect(screen.getByText('₱10.00')).toBeTruthy()
    expect(screen.getByText('33.33%')).toBeTruthy()
    // Margin, not markup: 50% would be markup and is the wrong metric.
    expect(screen.queryByText('50.00%')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Submit for approval' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('derives the review totals without persisting them', () => {
    state.detail = priced
    show(POS_SOURCE)
    typeCost('20')

    // Quantity defaults to the outstanding 20.
    expect(screen.getByText('Order cost')).toBeTruthy()
    expect(screen.getByText('₱400.00')).toBeTruthy()
    expect(screen.getByText('Potential retail value')).toBeTruthy()
    expect(screen.getByText('₱600.00')).toBeTruthy()
    expect(screen.getByText('Potential gross margin')).toBeTruthy()
    expect(screen.getByText('₱200.00')).toBeTruthy()
  })

  it('warns at zero margin but still allows submission', () => {
    state.detail = priced
    show(POS_SOURCE)
    chooseVendorAndBudget()
    typeCost('30')

    expect(screen.getByText(/Zero gross margin/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Submit for approval' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('blocks submission when the cost exceeds the price, and says by how much', () => {
    state.detail = priced
    show(POS_SOURCE)
    typeCost('35')

    expect(screen.getByText(/exceeds the current selling price by ₱5\.00 per unit/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Submit for approval' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('still lets that order be saved as a draft', () => {
    // A draft is not a purchasing commitment, and the server agrees: the guard
    // sits on the status transition, which a draft has not made.
    state.detail = priced
    show(POS_SOURCE)
    chooseVendorAndBudget()
    typeCost('35')

    // Submit is shut and draft is open, on the same form, at the same moment.
    // That contrast is the whole claim.
    expect(
      (screen.getByRole('button', { name: 'Submit for approval' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Save as draft' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('does not treat the VAT-inclusive customer total as the basis', () => {
    // 30.00 + 12% is 33.60 at the till. A 32.00 cost looks like a gain against
    // that number and is a 2.00 loss a unit against the one that is revenue.
    state.detail = priced
    show(POS_SOURCE)
    typeCost('32')

    expect(screen.getByText(/exceeds the current selling price by ₱2\.00 per unit/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Submit for approval' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('blocks submission when the branch has no price for the product', () => {
    state.detail = { ...priced, branch_selling_price: null }
    show(POS_SOURCE)
    typeCost('20')

    expect(screen.getByText(/does not have a valid selling price/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Submit for approval' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('does not read a zero price as a price', () => {
    // Comparing against 0.00 would report "cost exceeds price by ₱20" and send
    // Finance to renegotiate a supplier over an unpriced product.
    state.detail = { ...priced, branch_selling_price: 0 }
    show(POS_SOURCE)
    typeCost('20')

    expect(screen.getByText(/does not have a valid selling price/)).toBeTruthy()
    expect(screen.queryByText(/exceeds the current selling price/)).toBeNull()
  })

  it('offers Finance no way to change the selling price from here', () => {
    // Price belongs to POS. A control here would let Finance edit the number
    // that is checking them, which is no check at all.
    state.detail = { ...priced, branch_selling_price: 30 }
    show(POS_SOURCE)
    typeCost('35')

    expect(screen.queryByLabelText(/selling price/i)).toBeNull()
    const labels = screen.queryAllByRole('button').map((b) => b.textContent ?? '')
    expect(labels.some((l) => /selling price|set price|override/i.test(l))).toBe(false)
  })

  it('says nothing about margin on a general purchase', () => {
    // Stationery has no retail price. A margin panel would imply a question
    // that does not apply here.
    state.detail = {
      source_kind: 'finance_request',
      reference: 'PR-2026-0001',
      title: 'Office chairs',
      branch_name: 'Main Office',
      amount: 5000,
      branch_selling_price: null,
    }
    show(GENERAL_SOURCE)
    expect(screen.queryByText('Current selling price')).toBeNull()
  })
})

describe('only an approved vendor can be chosen', () => {
  it('leaves a proposed vendor out of the picker', () => {
    state.detail = { source_kind: 'pos_restock', reference: 'Stock request', outstanding: 20 }
    const { container } = show(POS_SOURCE)
    expect(container.textContent).not.toMatch(/Proposed Supplier/)
  })
})

describe('a POS order names the budget that pays for it', () => {
  const detail = {
    source_kind: 'pos_restock',
    reference: 'Stock request',
    product_name: 'Coca-Cola 5.6',
    branch_name: 'Cavite Branch',
    requested_quantity: 20,
    ordered_quantity: 0,
    outstanding: 20,
    // What the destination branch charges, resolved server-side. Pre-VAT: at a
    // 12% branch VAT fee the customer pays 33.60 for this.
    branch_selling_price: 30,
  }

  it('asks for a budget, and marks it required', () => {
    state.detail = detail
    show(POS_SOURCE)
    expect(screen.getByLabelText(/Budget/)).toBeTruthy()
  })

  it('treats a draft ceiling as no budget at all', () => {
    // A draft has not been approved by anybody and the server refuses one, so
    // offering it would only be a save that fails. Asserted through what the
    // page says rather than the dropdown's contents: Radix renders a Select's
    // items only once it is open, so a closed one proves nothing either way.
    state.detail = detail
    state.budgets = [
      { id: 'bud2', name: 'Draft Ceiling', status: 'draft', amount: 10000, remaining: 10000 },
    ]
    show(POS_SOURCE)
    expect(screen.getByText(/No active budget to charge this to/)).toBeTruthy()
  })

  it('says nothing of the sort when an approved ceiling exists', () => {
    state.detail = detail
    show(POS_SOURCE)
    expect(screen.queryByText(/No active budget to charge this to/)).toBeNull()
  })

  it('will not save without one, however complete the rest is', () => {
    state.detail = detail
    show(POS_SOURCE)
    fireEvent.change(screen.getByLabelText(/Unit cost/), { target: { value: '65' } })
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByRole('button', { name: 'Save as draft' })).toHaveProperty('disabled', true)
    expect(built).toEqual([])
  })
})

describe('a general purchase does not take a budget of its own', () => {
  const detail = {
    source_kind: 'finance_request',
    reference: 'PR-2026-0009',
    title: 'Office materials',
    requested_by_name: 'Jen Cruz',
    branch_name: 'Main Office',
    outstanding: null,
  }

  it('offers no budget field at all', () => {
    // The request reserved its money when it was approved. Charging the order
    // to a budget as well would commit the same pesos twice, and the server
    // refuses it -- so the field is absent rather than present and rejected.
    state.detail = detail
    show(GENERAL_SOURCE)
    expect(screen.queryByLabelText(/Budget/)).toBeNull()
  })
})
