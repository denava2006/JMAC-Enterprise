import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Branch } from '@/hooks/useBranches'
import type { InventoryRow } from '@/lib/posInventory'

/**
 * The Administrator's inventory screen -- the only POS screen that shows cost.
 *
 * What matters here: the preview must agree with what the database will do,
 * because an administrator decides whether to accept a delivery by reading it;
 * and no path may offer a mutation the RPC would refuse.
 */

const BRANCH_A = 'b1'

const branches: Branch[] = [
  { id: BRANCH_A, name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
]

interface Valuation {
  product_id: string
  quantity_on_hand: number
  average_unit_cost: number
  low_stock_threshold: number
}

const state: { rows: InventoryRow[]; valuation: Valuation[] } = { rows: [], valuation: [] }
const receive = vi.fn()
const adjust = vi.fn()
const setThreshold = vi.fn()

function row(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    product_id: 'p1',
    product_name: 'Cola 1.5L',
    category_name: 'Drinks',
    quantity_on_hand: 10,
    low_stock_threshold: 5,
    is_low_stock: false,
    is_available: true,
    product_status: 'active',
    ...overrides,
  }
}

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

vi.mock('@/hooks/usePosInventory', () => ({
  useBranchInventory: () => ({ data: state.rows, isLoading: false }),
  useBranchInventoryValuation: () => ({ data: state.valuation, isLoading: false }),
  useBranchMovementsWithCost: () => ({ data: [], isLoading: false }),
  useReceiveStock: () => ({ mutate: receive, isPending: false }),
  useAdjustStock: () => ({ mutate: adjust, isPending: false }),
  useSetLowStockThreshold: () => ({ mutate: setThreshold, isPending: false }),
}))

const { default: PosInventoryPage } = await import('@/pages/admin/PosInventoryPage')

afterEach(() => {
  cleanup()
  state.rows = []
  state.valuation = []
  receive.mockReset()
  adjust.mockReset()
  setThreshold.mockReset()
})

describe('the stock table', () => {
  it('shows quantity, cost and value -- this screen is Administrator-only', () => {
    state.rows = [row()]
    state.valuation = [{ product_id: 'p1', quantity_on_hand: 10, average_unit_cost: 45, low_stock_threshold: 5 }]
    render(<PosInventoryPage />)

    expect(screen.getByText('Cola 1.5L')).toBeTruthy()
    expect(screen.getByText('₱45.00')).toBeTruthy()
    // 10 x 45: once on the row, once in the branch total above it.
    expect(screen.getAllByText('₱450.00')).toHaveLength(2)
    expect(screen.getByText('Stock value at this branch')).toBeTruthy()
  })

  it('flags out of stock apart from low stock', () => {
    state.rows = [
      row({ product_id: 'p1', product_name: 'Empty', quantity_on_hand: 0, is_low_stock: true }),
      row({ product_id: 'p2', product_name: 'Nearly', quantity_on_hand: 2, is_low_stock: true }),
      row({ product_id: 'p3', product_name: 'Plenty', quantity_on_hand: 50, is_low_stock: false }),
    ]
    render(<PosInventoryPage />)

    expect(screen.getByText('Out of stock')).toBeTruthy()
    expect(screen.getByText('Low')).toBeTruthy()
    expect(screen.getByText('In stock')).toBeTruthy()
  })

  it('explains itself when the branch carries nothing', () => {
    render(<PosInventoryPage />)
    expect(screen.getByText(/carries no products yet/)).toBeTruthy()
  })
})

describe('receiving a delivery', () => {
  it('previews the new quantity and the new branch average', () => {
    // The worked example: 10 @ 40, receive 10 @ 50 -> 20 @ 45.
    state.rows = [row({ quantity_on_hand: 10 })]
    state.valuation = [{ product_id: 'p1', quantity_on_hand: 10, average_unit_cost: 40, low_stock_threshold: 5 }]
    render(<PosInventoryPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Receive Cola 1.5L' }))
    fireEvent.change(screen.getByLabelText('Quantity received'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Unit cost'), { target: { value: '50' } })

    expect(screen.getByText('20')).toBeTruthy()
    expect(screen.getByText('₱45.00')).toBeTruthy()
  })

  it('says the enterprise default cost is not affected', () => {
    state.rows = [row()]
    render(<PosInventoryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Receive Cola 1.5L' }))
    expect(screen.getByText(/default cost is unchanged/)).toBeTruthy()
  })

  it('refuses a zero quantity before the round trip', () => {
    state.rows = [row()]
    render(<PosInventoryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Receive Cola 1.5L' }))
    fireEvent.change(screen.getByLabelText('Quantity received'), { target: { value: '0' } })

    expect(screen.getByText(/more than zero/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Receive stock' }) as HTMLButtonElement).disabled).toBe(true)
    expect(receive).not.toHaveBeenCalled()
  })

  it('sends a valid delivery', () => {
    state.rows = [row()]
    render(<PosInventoryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Receive Cola 1.5L' }))
    fireEvent.change(screen.getByLabelText('Quantity received'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Unit cost'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Receive stock' }))

    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls[0][0]).toMatchObject({
      branchId: BRANCH_A,
      productId: 'p1',
      quantity: 5,
      unitCost: 30,
    })
  })
})

describe('adjusting a count', () => {
  it('says the average cost is left alone', () => {
    state.rows = [row()]
    render(<PosInventoryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Adjust Cola 1.5L' }))
    expect(screen.getByText(/average cost is left alone/)).toBeTruthy()
  })

  it('refuses a change that would go below zero, naming the result', () => {
    state.rows = [row({ quantity_on_hand: 3 })]
    render(<PosInventoryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Adjust Cola 1.5L' }))
    fireEvent.change(screen.getByLabelText('Change in units'), { target: { value: '-10' } })

    expect(screen.getByText(/leave -7 units/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Adjust stock' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends a valid adjustment', () => {
    state.rows = [row({ quantity_on_hand: 10 })]
    render(<PosInventoryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Adjust Cola 1.5L' }))
    fireEvent.change(screen.getByLabelText('Change in units'), { target: { value: '-3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Adjust stock' }))

    expect(adjust).toHaveBeenCalledTimes(1)
    expect(adjust.mock.calls[0][0]).toMatchObject({ quantityChange: -3, reason: 'recount' })
  })
})

describe('the low-stock level', () => {
  it('is saved on blur when it changes', () => {
    state.rows = [row({ low_stock_threshold: 5 })]
    render(<PosInventoryPage />)

    const field = screen.getByLabelText('Low-stock level for Cola 1.5L')
    fireEvent.change(field, { target: { value: '12' } })
    fireEvent.blur(field)

    expect(setThreshold).toHaveBeenCalledWith({ branchId: BRANCH_A, productId: 'p1', threshold: 12 })
  })

  it('does not save when the value is unchanged', () => {
    state.rows = [row({ low_stock_threshold: 5 })]
    render(<PosInventoryPage />)

    const field = screen.getByLabelText('Low-stock level for Cola 1.5L')
    fireEvent.blur(field)
    expect(setThreshold).not.toHaveBeenCalled()
  })

  it('does not save a negative level', () => {
    state.rows = [row({ low_stock_threshold: 5 })]
    render(<PosInventoryPage />)

    const field = screen.getByLabelText('Low-stock level for Cola 1.5L')
    fireEvent.change(field, { target: { value: '-1' } })
    fireEvent.blur(field)
    expect(setThreshold).not.toHaveBeenCalled()
  })
})

describe('the page never offers a direct quantity edit', () => {
  it('has no editable field for the quantity on hand', () => {
    state.rows = [row({ quantity_on_hand: 10 })]
    render(<PosInventoryPage />)

    // The only number inputs are the low-stock levels; stock itself is text.
    const numberInputs = screen.getAllByRole('spinbutton')
    expect(numberInputs).toHaveLength(1)
    expect(numberInputs[0].getAttribute('aria-label')).toContain('Low-stock level')
  })
})
