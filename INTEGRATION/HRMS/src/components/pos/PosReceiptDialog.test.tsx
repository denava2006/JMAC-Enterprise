import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { CatalogueRow } from '@/hooks/usePosCatalogue'
import type { Receipt } from '@/hooks/usePosTill'
import type { TransactionRow } from '@/lib/posTransactions'

/**
 * One receipt, two doors.
 *
 * The till used to render a hand-written summary of the sale it had just taken
 * while transaction history rendered SaleReceipt, so the same sale read
 * differently depending on which screen you were standing at -- the till showed
 * no receipt number, no branch address, no unit prices, no status, and offered
 * no way to print.
 *
 * The strongest thing to assert is not that either screen looks right, but that
 * they are the SAME: the test below drives a real cash sale through the till,
 * captures the printed receipt, then opens the same sale from history and
 * compares them character for character. Nothing short of that catches the two
 * drifting apart again.
 */

const BRANCH = 'b1'
const SALE = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

const branches: Branch[] = [
  { id: BRANCH, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
]

const catalogue: CatalogueRow[] = [
  {
    product_id: 'p1', name: 'Coca-Cola 1.5L', category_id: 'c1', category_name: 'Drinks',
    selling_price: 70, image_path: null, available_quantity: 10, is_low_stock: false,
  },
]

/**
 * The sale as the database returns it.
 *
 * Both entry points get this from the same builder -- `checkout_pos_sale` and
 * `get_sale_detail` each return `pos_sale_receipt(sale_id)` -- so one fixture
 * standing in for both is the shape production actually has, not a convenience.
 */
function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    sale_id: SALE,
    created_at: '2026-09-04T10:15:44.000Z',
    status: 'completed',
    company_name: 'JMAC Enterprise',
    branch_name: 'Cavite Branch',
    branch_address: '123 Aguinaldo Highway, Imus',
    branch_phone: '0917 000 0000',
    cashier_name: 'Liza Fernandez',
    items: [
      { product_name: 'Coca-Cola 1.5L', category_name: 'Drinks', quantity: 2, unit_price: 70, line_total: 140 },
    ],
    subtotal: 140,
    fees: [{ name: 'Service Charge', type: 'percent', value: 5, amount: 7 }],
    fees_total: 7,
    total_amount: 147,
    payment_method: 'cash',
    payment_reference: null,
    amount_tendered: 200,
    change_given: 53,
    ...overrides,
  }
}

const state: { receipt: Receipt } = { receipt: receipt() }
const checkoutMutate = vi.fn()

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: 'employee' },
    posAccess: { hasAccess: true, branchIds: [BRANCH], assignments: [{ branchId: BRANCH, role: 'cashier' }] },
  }),
}))
vi.mock('@/hooks/useBranches', () => ({ useBranches: () => ({ data: branches, isLoading: false }) }))
vi.mock('@/hooks/usePosCatalogue', () => ({
  usePosCatalogue: () => ({ data: catalogue, isLoading: false }),
  useProductImageUrls: () => ({ data: {}, isLoading: false }),
}))
vi.mock('@/hooks/usePosTill', () => ({
  useBranchFees: () => ({ data: [{ id: 'f1', name: 'Service Charge', type: 'percent', value: 5, enabled: true }] }),
  useCheckout: () => ({
    // The sale the SERVER made, handed straight back -- which is why the
    // receipt does not depend on the cart that produced it.
    mutate: (args: unknown, opts?: { onSuccess?: (r: Receipt) => void }) => {
      checkoutMutate(args)
      opts?.onSuccess?.(state.receipt)
    },
    isPending: false, isError: false, error: null,
  }),
}))
vi.mock('@/hooks/usePosPayment', () => ({
  useCreateOnlineCheckout: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  usePaymentAttempt: () => ({ data: null, isFetching: false, refetch: vi.fn() }),
  useCancelPaymentAttempt: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useRefreshAfterOnlineSale: () => () => {},
}))

const listRow = (): TransactionRow => ({
  sale_id: SALE, created_at: state.receipt.created_at, status: 'completed',
  branch_id: BRANCH, branch_name: 'Cavite Branch', cashier_name: 'Liza Fernandez',
  item_count: 2, subtotal: 140, fees_total: 7, total_amount: 147,
  payment_method: state.receipt.payment_method, payment_reference: state.receipt.payment_reference,
  amount_tendered: state.receipt.amount_tendered, change_given: state.receipt.change_given,
  total_count: 1,
})

vi.mock('@/hooks/usePosTransactions', () => ({
  usePosTransactions: () => ({ data: [listRow()], isLoading: false, isError: false, error: null }),
  useSaleDetail: (saleId: string | null) => ({
    data: saleId ? state.receipt : null,
    isLoading: false, isError: false, error: null,
  }),
}))

const { default: PosTillPage } = await import('@/pages/pos/PosTillPage')
const { PosTransactionsView } = await import('@/components/pos/PosTransactionsView')

/** Ring up a cash sale and land on the receipt. */
function sellForCash(tendered = '200') {
  render(
    <MemoryRouter>
      <PosTillPage />
    </MemoryRouter>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add Coca-Cola 1.5L' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add Coca-Cola 1.5L' }))
  fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: tendered } })
  fireEvent.click(screen.getByRole('button', { name: /Take payment/ }))
}

/** Open the same sale the way a cashier would tomorrow. */
function reprintFromHistory() {
  render(
    <MemoryRouter>
      <PosTransactionsView scope="mine" showCashier showBranch emptyMessage="none" />
    </MemoryRouter>
  )
  fireEvent.click(screen.getByRole('button', { name: /^Receipt for / }))
}

const printed = () => document.querySelector('#printable-receipt')?.textContent ?? ''

afterEach(() => {
  cleanup()
  state.receipt = receipt()
  checkoutMutate.mockReset()
})

describe('after taking payment at the till', () => {
  it('puts the receipt in front of the cashier straight away', () => {
    sellForCash()
    expect(screen.getByText('Sale complete')).toBeTruthy()
    expect(printed()).not.toBe('')
  })

  it('offers Print without a trip to Transactions', () => {
    sellForCash()
    expect(screen.getByRole('button', { name: /print/i })).toBeTruthy()
    // The old flow's only route to a printable receipt was the other page.
    expect(screen.queryByRole('link', { name: /transactions/i })).toBeNull()
  })

  it('shows what the server saved, not what the cart held', () => {
    // The cart was two at ₱70 with a 5% fee. The receipt reads the sale, so if
    // the server had priced it differently that is what would appear.
    sellForCash()
    const text = printed()
    expect(text).toContain('Coca-Cola 1.5L')
    expect(text).toContain('₱147.00')
    expect(text).toContain('Liza Fernandez')
    expect(text).toContain('123 Aguinaldo Highway, Imus')
  })

  it('survives the cart being cleared, because it never read it', () => {
    sellForCash()
    // The cart is empty behind the dialog and the receipt is still whole.
    expect(printed()).toContain('Coca-Cola 1.5L')
    expect(screen.getByText(/Tap a product to start a sale/)).toBeTruthy()
  })
})

describe('the same sale, from either door', () => {
  it('renders one identical receipt', () => {
    sellForCash()
    const fromTill = printed()
    cleanup()

    reprintFromHistory()
    const fromHistory = printed()

    expect(fromTill).not.toBe('')
    expect(fromTill).toBe(fromHistory)
  })

  it.each([
    ['receipt number', '7C9E6679'],
    ['branch', 'Cavite Branch'],
    ['branch address', '123 Aguinaldo Highway, Imus'],
    ['item and quantity', 'Coca-Cola 1.5L'],
    ['unit price', '@ ₱70.00'],
    ['line total', '₱140.00'],
    ['fee', 'Service Charge'],
    ['total', '₱147.00'],
    ['payment method', 'Cash'],
    ['cashier', 'Liza Fernandez'],
    ['status', 'Completed'],
  ])('carries the same %s on both', (_label, expected) => {
    sellForCash()
    expect(printed(), 'till').toContain(expected)
    cleanup()

    reprintFromHistory()
    expect(printed(), 'history').toContain(expected)
  })

  // The receipt reference is the sale id's first eight characters because the
  // POS has no business receipt number -- there is no such column, and the
  // transaction register shows the same eight. What matters is that a whole
  // uuid is never put in front of anyone.
  it('never prints a raw uuid', () => {
    sellForCash()
    expect(printed()).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    )
  })
})

describe('cash and everything else', () => {
  it('counts the money back on a cash sale', () => {
    sellForCash()
    const text = printed()
    expect(text).toContain('Cash received')
    expect(text).toContain('₱200.00')
    expect(text).toContain('Change')
    expect(text).toContain('₱53.00')
  })

  it('says nothing about cash on a sale that took none', () => {
    // A GCash sale stores no tendered amount. Printing "Cash received ₱0.00 /
    // Change ₱0.00" would describe a cash drawer that was never opened.
    state.receipt = receipt({
      payment_method: 'gcash',
      payment_reference: 'JMAC-POS-9F2A11',
      amount_tendered: null,
      change_given: null,
    })
    reprintFromHistory()

    const text = printed()
    expect(text).toContain('GCash')
    expect(text).toContain('JMAC-POS-9F2A11')
    expect(text).not.toContain('Cash received')
    expect(text).not.toContain('Change')
  })
})

describe('a receipt is read-only', () => {
  it('takes payment once, however the receipt is handled', () => {
    sellForCash()
    expect(checkoutMutate).toHaveBeenCalledTimes(1)

    // Everything a cashier can do to a receipt: print it, then close it.
    fireEvent.click(screen.getByRole('button', { name: /print/i }))
    for (const close of screen.getAllByRole('button', { name: /close/i })) {
      fireEvent.click(close)
    }

    expect(checkoutMutate).toHaveBeenCalledTimes(1)
  })

  it('opening one from history charges nobody', () => {
    reprintFromHistory()
    fireEvent.click(screen.getByRole('button', { name: /print/i }))
    expect(checkoutMutate).not.toHaveBeenCalled()
  })

  it('offers no control that could imply the sale is not yet recorded', () => {
    sellForCash()
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/confirm|finish|record|save sale|submit|retry/i)
    }
  })
})

describe('the next customer', () => {
  it('leaves the till clear once the receipt is closed', () => {
    sellForCash()
    for (const close of screen.getAllByRole('button', { name: /close/i })) {
      fireEvent.click(close)
    }

    expect(screen.queryByText('Sale complete')).toBeNull()
    expect(screen.getByText(/Tap a product to start a sale/)).toBeTruthy()
    // The cash field is empty, so the next sale does not inherit the last
    // customer's money.
    expect((screen.getByLabelText('Cash received') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Subtotal (0 items)')).toBeTruthy()
  })

  it('can ring up the next sale immediately', () => {
    sellForCash()
    for (const close of screen.getAllByRole('button', { name: /close/i })) {
      fireEvent.click(close)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Add Coca-Cola 1.5L' }))
    expect(screen.getByText('Subtotal (1 items)')).toBeTruthy()
  })
})
