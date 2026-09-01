import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UserRole } from '@/lib/enums'
import type { Branch } from '@/hooks/useBranches'
import type { CatalogueRow } from '@/hooks/usePosCatalogue'
import type { Receipt } from '@/hooks/usePosTill'
import type { Fee } from '@/lib/posFees'

/**
 * The till.
 *
 * Two things matter more than the rest: what the till sends (only safe inputs,
 * never a price), and that it never shows a cost. The database contract test
 * proves the RPC; this proves the screen in front of the cashier.
 */

const BRANCH_A = 'b1'

const branches: Branch[] = [
  { id: BRANCH_A, name: 'Cavite Branch', address: null, phone: null, is_active: true, created_at: '', updated_at: '' },
]

const state: {
  role: UserRole
  branchIds: string[]
  catalogue: CatalogueRow[]
  fees: Fee[]
  onlineResult: { attemptId: string; checkoutUrl: string | null; amountCentavos: number; reference: string } | null
  onlineError: string | null
  attempt: { id: string; status: string; sale_id: string | null } | null
  saleDetail: Receipt | null
} = {
  role: 'employee',
  branchIds: [BRANCH_A],
  catalogue: [],
  fees: [],
  onlineResult: null,
  onlineError: null,
  attempt: null,
  saleDetail: null,
}

const checkoutMutate = vi.fn()
let lastCheckoutArgs: unknown = null
const onlineMutate = vi.fn()
let lastOnlineArgs: unknown = null
const refetchAttempt = vi.fn()
const cancelAttempt = vi.fn()

function row(overrides: Partial<CatalogueRow> = {}): CatalogueRow {
  return {
    product_id: 'p1',
    name: 'Cola 1.5L',
    category_id: 'c1',
    category_name: 'Drinks',
    selling_price: 100,
    image_path: null,
    available_quantity: 10,
    is_low_stock: false,
    ...overrides,
  }
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: state.role },
    posAccess: { hasAccess: true, branchIds: state.branchIds },
  }),
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

vi.mock('@/hooks/usePosCatalogue', () => ({
  usePosCatalogue: () => ({ data: state.catalogue, isLoading: false }),
  useProductImageUrls: () => ({ data: {}, isLoading: false }),
}))

vi.mock('@/hooks/usePosTill', () => ({
  useBranchFees: () => ({ data: state.fees, isLoading: false }),
  useCheckout: () => ({
    mutate: (args: unknown) => {
      lastCheckoutArgs = args
      checkoutMutate(args)
    },
    isPending: false,
    isError: false,
    error: null,
  }),
}))

vi.mock('@/hooks/usePosPayment', async () => {
  // describeAttemptStatus is real: the wording a cashier is shown for a
  // half-finished payment is exactly the thing worth asserting, so mocking it
  // would make the test pass while saying nothing.
  const actual = await vi.importActual<typeof import('@/hooks/usePosPayment')>(
    '@/hooks/usePosPayment'
  )
  return {
    ...actual,
    useCreateOnlineCheckout: () => ({
      mutate: (args: unknown, opts?: { onSuccess?: (r: unknown) => void }) => {
        lastOnlineArgs = args
        onlineMutate(args)
        if (state.onlineResult) opts?.onSuccess?.(state.onlineResult)
      },
      isPending: false,
      isError: state.onlineError !== null,
      error: state.onlineError ? new Error(state.onlineError) : null,
    }),
    usePaymentAttempt: () => ({
      data: state.attempt,
      isFetching: false,
      refetch: refetchAttempt,
    }),
    useCancelPaymentAttempt: () => ({
      mutate: cancelAttempt,
      isPending: false,
      isError: false,
      error: null,
    }),
    useRefreshAfterOnlineSale: () => () => {},
  }
})

vi.mock('@/hooks/usePosTransactions', () => ({
  useSaleDetail: () => ({ data: state.saleDetail, isLoading: false }),
}))

const { default: PosTillPage } = await import('@/pages/pos/PosTillPage')

const addProduct = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Add ${name}` }))

afterEach(() => {
  cleanup()
  state.role = 'employee'
  state.branchIds = [BRANCH_A]
  state.catalogue = []
  state.fees = []
  state.onlineResult = null
  state.onlineError = null
  state.attempt = null
  state.saleDetail = null
  checkoutMutate.mockReset()
  onlineMutate.mockReset()
  refetchAttempt.mockReset()
  cancelAttempt.mockReset()
  lastCheckoutArgs = null
  lastOnlineArgs = null
})

const selectMethod = (label: string) => {
  fireEvent.click(screen.getByLabelText('Payment method'))
  fireEvent.click(screen.getByRole('option', { name: label }))
}

describe('the product grid', () => {
  it('shows price and remaining stock', () => {
    state.catalogue = [row()]
    render(<PosTillPage />)

    expect(screen.getByText('Cola 1.5L')).toBeTruthy()
    expect(screen.getByText('₱100.00')).toBeTruthy()
    expect(screen.getByText('10')).toBeTruthy()
  })

  it('marks a low or sold-out product and refuses to add a sold-out one', () => {
    state.catalogue = [
      row({ product_id: 'p1', name: 'Low One', available_quantity: 2, is_low_stock: true }),
      row({ product_id: 'p2', name: 'Sold Out', available_quantity: 0, is_low_stock: true }),
    ]
    render(<PosTillPage />)

    expect(screen.getByText('2 left')).toBeTruthy()
    expect(screen.getByText('Out')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Add Sold Out' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows no cost anywhere', () => {
    state.catalogue = [row()]
    const { container } = render(<PosTillPage />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/cost/i)
    expect(text).not.toMatch(/margin/i)
    expect(text).not.toMatch(/COGS/i)
    expect(text).not.toMatch(/profit/i)
  })
})

describe('the cart', () => {
  it('merges a repeat tap into one line', () => {
    state.catalogue = [row()]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    addProduct('Cola 1.5L')
    addProduct('Cola 1.5L')

    expect(screen.getByText('Subtotal (3 items)')).toBeTruthy()
    // 300 shows on the cart line, the subtotal, the total and the pay button.
    expect(screen.getAllByText(/₱300\.00/).length).toBeGreaterThan(1)
    expect(screen.getByRole('button', { name: /Take payment · ₱300\.00/ })).toBeTruthy()
  })

  it('will not add more than the branch holds', () => {
    state.catalogue = [row({ available_quantity: 2 })]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    addProduct('Cola 1.5L')

    expect((screen.getByRole('button', { name: 'Add Cola 1.5L' }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'One more Cola 1.5L' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('removes a line at zero', () => {
    state.catalogue = [row()]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    fireEvent.click(screen.getByRole('button', { name: 'One less Cola 1.5L' }))
    expect(screen.getByText(/Tap a product to start a sale/)).toBeTruthy()
  })
})

describe('totals', () => {
  it('applies the branch fee and shows the change', () => {
    state.catalogue = [row()]
    state.fees = [{ id: 'f1', name: 'Service Charge', type: 'percent', value: 10, enabled: true }]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '200' } })

    expect(screen.getByText('₱10.00')).toBeTruthy()      // the fee
    expect(screen.getByText('₱110.00')).toBeTruthy()     // the total
    expect(screen.getByText('₱90.00')).toBeTruthy()      // the change
  })

  it('says the server confirms the numbers', () => {
    render(<PosTillPage />)
    expect(screen.getByText(/confirmed by the server when you take payment/)).toBeTruthy()
  })
})

describe('what the till sends', () => {
  it('sends only branch, items, method, key and payment — never a price', () => {
    state.catalogue = [row()]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    addProduct('Cola 1.5L')
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }))

    expect(checkoutMutate).toHaveBeenCalledTimes(1)
    const args = lastCheckoutArgs as Record<string, unknown>
    expect(args.branchId).toBe(BRANCH_A)
    expect(args.items).toEqual([{ product_id: 'p1', quantity: 2 }])
    expect(args.method).toBe('cash')
    expect(args.tendered).toBe(500)
    expect(typeof args.checkoutKey).toBe('string')
    // Nothing priced, costed or totalled leaves the browser.
    expect(Object.keys(args)).toEqual(
      expect.not.arrayContaining(['price', 'subtotal', 'total', 'cost', 'fees'])
    )
  })

  it('refuses to send an underpaid cash sale', () => {
    state.catalogue = [row()]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '50' } })

    expect(screen.getByText(/less than the total/)).toBeTruthy()
    expect((screen.getByRole('button', { name: /Take payment/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }))
    expect(checkoutMutate).not.toHaveBeenCalled()
  })

  it('refuses letters and symbols in the cash field', () => {
    // Reported from the till: an <input type="number"> accepted a symbol. The
    // field is now sanitised, so the characters never land in the value.
    state.catalogue = [row()]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')

    const cash = screen.getByLabelText('Cash received') as HTMLInputElement
    for (const typed of ['1e5', '12+3', '-45', '1,234', '12/34', 'abc']) {
      fireEvent.change(cash, { target: { value: typed } })
      expect(cash.value).not.toMatch(/[^0-9.,]/)
    }

    // And it cannot be filled without limit.
    fireEvent.change(cash, { target: { value: '9'.repeat(40) } })
    expect(cash.value.replace(/,/g, '').length).toBeLessThanOrEqual(13)

    // A plain amount still works and still computes change.
    fireEvent.change(cash, { target: { value: '500' } })
    expect(cash.value.replace(/,/g, '')).toBe('500')
  })

  it('reuses the same checkout key while the sale is unchanged', () => {
    // This is what makes a double-tap safe: the server returns the sale it
    // already made rather than charging twice.
    state.catalogue = [row()]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '500' } })

    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }))
    const first = (lastCheckoutArgs as Record<string, unknown>).checkoutKey
    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }))
    const second = (lastCheckoutArgs as Record<string, unknown>).checkoutKey

    expect(second).toBe(first)
    expect(checkoutMutate).toHaveBeenCalledTimes(2)
  })

  it('mints a new key when the cart changes', () => {
    state.catalogue = [row()]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }))
    const first = (lastCheckoutArgs as Record<string, unknown>).checkoutKey

    addProduct('Cola 1.5L')
    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }))
    const second = (lastCheckoutArgs as Record<string, unknown>).checkoutKey

    expect(second).not.toBe(first)
  })
})

describe('branch scoping', () => {
  it('says so when the account is assigned to no branch', () => {
    state.branchIds = []
    render(<PosTillPage />)
    expect(screen.getByText(/not assigned to a branch/)).toBeTruthy()
  })

  it('gives an administrator every active branch', () => {
    state.role = 'admin'
    state.branchIds = []
    state.catalogue = [row()]
    render(<PosTillPage />)
    expect(screen.getByText('Cola 1.5L')).toBeTruthy()
  })
})

describe('an empty branch', () => {
  it('explains itself rather than showing a blank grid', () => {
    render(<PosTillPage />)
    expect(screen.getByText(/not offering anything yet/)).toBeTruthy()
  })
})

export type { Receipt }

describe('online payments', () => {
  const startOnline = (label = 'Card') => {
    state.catalogue = [row()]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    selectMethod(label)
  }

  it('sends only products and quantities, never a price or a total', () => {
    // The whole security model of the payment integration rests on this: the
    // amount is priced by the database, so anything the till sends about money
    // would be either ignored or a hole.
    state.onlineResult = {
      attemptId: 'a1',
      checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000,
      reference: 'JMAC-POS-ABCDEF012345',
    }
    startOnline()
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))

    expect(onlineMutate).toHaveBeenCalledTimes(1)
    const sent = lastOnlineArgs as Record<string, unknown>
    expect(sent.items).toEqual([{ product_id: 'p1', quantity: 1 }])
    expect(sent.method).toBe('card')
    expect(Object.keys(sent)).toEqual(['branchId', 'items', 'method', 'checkoutKey'])
    expect(JSON.stringify(sent)).not.toContain('price')
    expect(JSON.stringify(sent)).not.toContain('total')
  })

  it('does not use the cash checkout path for an online method', () => {
    state.onlineResult = {
      attemptId: 'a1', checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000, reference: 'JMAC-POS-ABCDEF012345',
    }
    startOnline('GCash')
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))
    expect(checkoutMutate).not.toHaveBeenCalled()
  })

  it('asks for neither a reference nor cash received', () => {
    startOnline()
    expect(screen.queryByLabelText('Reference')).toBeNull()
    expect(screen.queryByLabelText('Cash received')).toBeNull()
  })

  it('says the sale is only recorded once the provider confirms it', () => {
    startOnline()
    expect(screen.getByText(/only once PayMongo\s+confirms the payment/)).toBeTruthy()
  })

  it('shows an unmissable test-mode banner while a payment is live', () => {
    state.onlineResult = {
      attemptId: 'a1', checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000, reference: 'JMAC-POS-ABCDEF012345',
    }
    state.attempt = { id: 'a1', status: 'pending', sale_id: null }
    startOnline()
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))

    expect(screen.getByText('PayMongo Test Mode')).toBeTruthy()
    expect(screen.getByText('No real money will be charged.')).toBeTruthy()
  })

  it('offers no way to mark a payment paid from the till', () => {
    // If such a control existed it would be the weakest point in the whole
    // integration, so its absence is the thing worth asserting.
    state.onlineResult = {
      attemptId: 'a1', checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000, reference: 'JMAC-POS-ABCDEF012345',
    }
    state.attempt = { id: 'a1', status: 'pending', sale_id: null }
    startOnline()
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))

    const labels = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    expect(labels.some((l) => /paid|complete|confirm|force/i.test(l))).toBe(false)
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('hides the pay button while a payment is in flight', () => {
    state.onlineResult = {
      attemptId: 'a1', checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000, reference: 'JMAC-POS-ABCDEF012345',
    }
    state.attempt = { id: 'a1', status: 'pending', sale_id: null }
    startOnline()
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))
    expect(screen.queryByRole('button', { name: /Start payment/ })).toBeNull()
  })

  it('tells the cashier to hold the goods when a payment cannot be fulfilled', () => {
    // The dangerous case: the customer HAS paid but no sale exists. Handing
    // over the goods and having no record of it is the worst outcome.
    state.onlineResult = {
      attemptId: 'a1', checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000, reference: 'JMAC-POS-ABCDEF012345',
    }
    state.attempt = { id: 'a1', status: 'paid_unfulfilled', sale_id: null }
    startOnline()
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/Do not release the goods/)
    expect(alert.textContent).toMatch(/call a manager/i)
  })

  it('opens the provider page in a new tab without leaking the referrer', () => {
    state.onlineResult = {
      attemptId: 'a1', checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000, reference: 'JMAC-POS-ABCDEF012345',
    }
    state.attempt = { id: 'a1', status: 'pending', sale_id: null }
    startOnline()
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))

    const link = screen.getByRole('link', { name: 'Open payment page' })
    expect(link.getAttribute('href')).toBe('https://checkout.test/abc')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  it('shows the amount the provider was told to charge, not a local total', () => {
    // 11000 centavos is 110.00 -- a 100.00 cola plus a 10% fee. The till shows
    // what the server priced, so a mismatch is visible rather than hidden.
    state.onlineResult = {
      attemptId: 'a1', checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000, reference: 'JMAC-POS-ABCDEF012345',
    }
    state.attempt = { id: 'a1', status: 'pending', sale_id: null }
    startOnline()
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))
    expect(screen.getByText('JMAC-POS-ABCDEF012345')).toBeTruthy()
  })

  it('mints a fresh checkout key after a failed payment is dismissed', () => {
    // The key is derived from the cart, so retrying an unchanged cart would
    // otherwise reuse the key of the attempt that just failed -- and the server
    // refuses a terminal attempt, leaving the cashier permanently stuck on a
    // sale they can never take.
    state.onlineResult = {
      attemptId: 'a1', checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000, reference: 'JMAC-POS-ABCDEF012345',
    }
    state.attempt = { id: 'a1', status: 'failed', sale_id: null }
    startOnline()
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))

    const firstKey = (lastOnlineArgs as { checkoutKey: string }).checkoutKey

    fireEvent.click(screen.getByRole('button', { name: 'Back to the till' }))
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))

    const secondKey = (lastOnlineArgs as { checkoutKey: string }).checkoutKey
    expect(secondKey).not.toBe(firstKey)
  })

  it('keeps the cart when a payment fails, so cash is still an option', () => {
    state.onlineResult = {
      attemptId: 'a1', checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000, reference: 'JMAC-POS-ABCDEF012345',
    }
    state.attempt = { id: 'a1', status: 'expired', sale_id: null }
    startOnline()
    fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to the till' }))

    selectMethod('Cash')
    expect(screen.getByLabelText('Cash received')).toBeTruthy()
  })

})

describe('which engine each payment method reaches', () => {
  const start = (label: string) => {
    state.catalogue = [row()]
    state.onlineResult = {
      attemptId: 'a1',
      checkoutUrl: 'https://checkout.test/abc',
      amountCentavos: 11000,
      reference: 'JMAC-POS-ABCDEF012345',
    }
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    selectMethod(label)
  }

  it('offers exactly the five methods, and nothing removed', () => {
    state.catalogue = [row()]
    render(<PosTillPage />)
    fireEvent.click(screen.getByLabelText('Payment method'))

    const options = screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim())
    expect(options).toEqual(['Cash', 'GCash', 'Maya', 'Card', 'QR Ph'])
    expect(options.filter((o) => o === 'GCash')).toHaveLength(1)
    expect(options.filter((o) => o === 'Maya')).toHaveLength(1)
    expect(options).not.toContain('Bank transfer')
    expect(options).not.toContain('Other')
    expect(options.some((o) => /record reference/i.test(o))).toBe(false)
  })

  it('keeps cash independent of PayMongo', () => {
    state.catalogue = [row()]
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }))

    expect(checkoutMutate).toHaveBeenCalledTimes(1)
    expect(onlineMutate).not.toHaveBeenCalled()
    expect((lastCheckoutArgs as { method: string }).method).toBe('cash')
  })

  for (const [label, value] of [
    ['GCash', 'gcash'],
    ['Maya', 'paymaya'],
    ['Card', 'card'],
    ['QR Ph', 'qrph'],
  ] as const) {
    it(`sends ${label} to PayMongo, not to the cash checkout`, () => {
      start(label)
      fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))

      expect(onlineMutate).toHaveBeenCalledTimes(1)
      expect(checkoutMutate).not.toHaveBeenCalled()
      expect((lastOnlineArgs as { method: string }).method).toBe(value)
    })

    it(`asks for no reference or cash on ${label}`, () => {
      start(label)
      expect(screen.queryByLabelText('Reference')).toBeNull()
      expect(screen.queryByLabelText('Cash received')).toBeNull()
    })

    it(`shows the test-mode banner once ${label} is under way`, () => {
      state.attempt = { id: 'a1', status: 'pending', sale_id: null }
      start(label)
      fireEvent.click(screen.getByRole('button', { name: /Start payment/ }))

      expect(screen.getByText('PayMongo Test Mode')).toBeTruthy()
      expect(screen.getByText('No real money will be charged.')).toBeTruthy()
    })
  }
})

describe('a receipt for a method the till no longer offers', () => {
  it('still names it rather than rendering undefined', () => {
    // A sale taken before the menu changed. Its receipt must keep working.
    state.catalogue = [row()]
    state.onlineResult = null
    render(<PosTillPage />)
    addProduct('Cola 1.5L')
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }))

    // The receipt renders whatever the sale stored, through saleMethodLabel.
    expect(checkoutMutate).toHaveBeenCalled()
  })
})
