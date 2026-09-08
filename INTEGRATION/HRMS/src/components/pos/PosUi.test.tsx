import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PosProductCard } from '@/components/pos/PosProductCard'
import { PosPaymentMethod } from '@/components/pos/PosPaymentMethod'
import { PosSummaryCard } from '@/components/pos/PosSummaryCard'
import { TILL_METHODS } from '@/lib/posTill'
import type { CatalogueProduct } from '@/lib/posTill'

/**
 * The three pieces the till and the register are now built from.
 *
 * The page tests prove the workflows; these prove the parts in isolation --
 * particularly the payment selector, which replaced a dropdown and is the one
 * control where showing a method the server does not accept would be a real
 * fault rather than a cosmetic one.
 */

function product(overrides: Partial<CatalogueProduct> = {}): CatalogueProduct {
  return {
    product_id: 'p1',
    name: 'Cola 1.5L',
    category_name: 'Drinks',
    selling_price: 70,
    image_path: null,
    available_quantity: 37,
    is_low_stock: false,
    ...overrides,
  }
}

afterEach(cleanup)

describe('the product tile', () => {
  it('shows the name, category, price and stock a cashier scans for', () => {
    render(<PosProductCard product={product()} inCart={0} onAdd={() => {}} />)
    expect(screen.getByText('Cola 1.5L')).toBeTruthy()
    expect(screen.getByText('Drinks')).toBeTruthy()
    expect(screen.getByText('₱70.00')).toBeTruthy()
    expect(screen.getByText('37 in stock')).toBeTruthy()
  })

  it('is one big target, and adds on tap', () => {
    const onAdd = vi.fn()
    render(<PosProductCard product={product()} inCart={0} onAdd={onAdd} />)
    const card = screen.getByRole('button', { name: 'Add Cola 1.5L' })
    fireEvent.click(card)
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('says how many are already on the sale', () => {
    render(<PosProductCard product={product()} inCart={3} onAdd={() => {}} />)
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('refuses a sold-out product and says why', () => {
    const onAdd = vi.fn()
    render(
      <PosProductCard product={product({ available_quantity: 0 })} inCart={0} onAdd={onAdd} />
    )
    const card = screen.getByRole('button', { name: 'Add Cola 1.5L' }) as HTMLButtonElement
    expect(card.disabled).toBe(true)
    expect(screen.getByText('Out of stock')).toBeTruthy()
    fireEvent.click(card)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('refuses to add beyond what the branch holds', () => {
    const card = render(
      <PosProductCard product={product({ available_quantity: 2 })} inCart={2} onAdd={() => {}} />
    )
    expect((card.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('All in cart')).toBeTruthy()
  })

  it('warns on low stock without shouting', () => {
    render(
      <PosProductCard
        product={product({ available_quantity: 2, is_low_stock: true })}
        inCart={0}
        onAdd={() => {}}
      />
    )
    expect(screen.getByText('2 left')).toBeTruthy()
  })

  it('shows the whole product rather than cropping it', () => {
    const { container } = render(
      <PosProductCard
        product={product({ image_path: 'img/p1.png' })}
        imageUrl="https://signed.test/p1.png"
        inCart={0}
        onAdd={() => {}}
      />
    )
    const img = container.querySelector('img')!
    expect(img.className).toContain('object-contain')
    // Decorative: the name is right underneath, so a screen reader announcing
    // the filename would only repeat it.
    expect(img.getAttribute('alt')).toBe('')
  })
})

describe('the payment selector', () => {
  const show = (value = 'cash' as (typeof TILL_METHODS)[number], onChange = vi.fn()) => {
    render(<PosPaymentMethod value={value} onChange={onChange} />)
    return onChange
  }

  it('offers exactly the methods the till supports, and no others', () => {
    show()
    const labels = screen.getAllByRole('radio').map((r) => (r.textContent ?? '').trim())
    expect(labels).toEqual(['Cash', 'GCash', 'Maya', 'Card', 'QR Ph'])
    expect(labels).toHaveLength(TILL_METHODS.length)

    // The ones a reference mockup might invite and the system cannot settle.
    for (const invented of ['Debit', 'Bank transfer', 'Voucher', 'Split']) {
      expect(screen.queryByRole('radio', { name: invented })).toBeNull()
    }
  })

  it('marks the selected method for a screen reader, not only in colour', () => {
    show('gcash')
    expect(screen.getByRole('radio', { name: 'GCash' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Cash' }).getAttribute('aria-checked')).toBe('false')
  })

  it('reports the value the server expects, not the label', () => {
    const onChange = show()
    fireEvent.click(screen.getByRole('radio', { name: 'Maya' }))
    // 'paymaya' is the stored enum value; 'Maya' is only what it is called.
    expect(onChange).toHaveBeenCalledWith('paymaya')
  })

  it('moves with the arrow keys, the way a radio set should', () => {
    const onChange = show('cash')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Cash' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('gcash')

    cleanup()
    const back = vi.fn()
    render(<PosPaymentMethod value="cash" onChange={back} />)
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Cash' }), { key: 'ArrowLeft' })
    // Wraps to the end rather than dead-ending on the first tile.
    expect(back).toHaveBeenCalledWith('qrph')
  })

  it('keeps one stop in the tab order for the whole group', () => {
    show('card')
    const tabbable = screen
      .getAllByRole('radio')
      .filter((r) => r.getAttribute('tabindex') === '0')
      .map((r) => (r.textContent ?? '').trim())
    expect(tabbable).toEqual(['Card'])
  })

  it('can be locked while a payment is in flight', () => {
    render(<PosPaymentMethod value="cash" onChange={vi.fn()} disabled />)
    for (const tile of screen.getAllByRole('radio')) {
      expect((tile as HTMLButtonElement).disabled).toBe(true)
    }
  })
})

describe('the register summary card', () => {
  it('shows a figure and the quiet line under it', () => {
    render(<PosSummaryCard label="Sales on this page" value={5} hint="of 5 transactions" />)
    expect(screen.getByText('Sales on this page')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()
    expect(screen.getByText('of 5 transactions')).toBeTruthy()
  })

  it('takes a formatted amount as readily as a count', () => {
    render(<PosSummaryCard label="Total taken" value="₱350.00" />)
    expect(screen.getByText('₱350.00')).toBeTruthy()
  })
})
