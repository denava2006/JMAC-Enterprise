import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * What an invoice will let Finance prepare.
 *
 * The hosted defect: two instructions of ₱1,300 were accepted against a
 * ₱1,300 invoice. The ceiling was balance_due, which subtracts only completed
 * payments — correctly, since an unsent instruction has not paid anybody — so
 * after preparing the first, the balance still read ₱1,300.
 *
 * The screen now shows both numbers, because they answer different questions:
 * what is owed, and what is still unclaimed.
 */

const state: {
  role: string
  invoice: Record<string, unknown>
  payments: Array<Record<string, unknown>>
} = { role: 'accountant', invoice: {}, payments: [] }

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'acc-1', role: state.role } }),
}))

vi.mock('@/hooks/useTreasury', () => ({
  useSupplierPayments: () => ({ data: state.payments, isLoading: false }),
  useTransitionPayment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useCreatePayment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTreasuryAccounts: () => ({
    data: [{ id: 'acc1', name: 'Main Bank Account', is_active: true, balance: 25000 }],
    isLoading: false,
  }),
}))

import { InvoicePayments } from '@/components/fms/InvoicePayments'

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: 'inv1',
    supplier_invoice_number: 'SI-93842',
    vendor_name: 'Sahara Inc.',
    total_amount: 1300,
    amount_paid: 0,
    balance_due: 1300,
    pending_payment_amount: 0,
    available_to_prepare: 1300,
    status: 'approved',
    ...over,
  }
}

beforeEach(() => {
  state.role = 'accountant'
  state.invoice = invoice()
  state.payments = []
})

afterEach(cleanup)

describe('the four figures an invoice carries', () => {
  it('shows owed and claimed as separate numbers', () => {
    render(<InvoicePayments invoice={state.invoice as never} />)
    expect(screen.getByText('Paid so far')).toBeTruthy()
    expect(screen.getByText('Pending for payment')).toBeTruthy()
    expect(screen.getByText('Balance due')).toBeTruthy()
    expect(screen.getByText('Available to prepare')).toBeTruthy()
  })

  // The exact production shape: nothing paid, everything instructed.
  it('reports a fully instructed invoice as still owing, but with nothing available', () => {
    state.invoice = invoice({ pending_payment_amount: 1300, available_to_prepare: 0 })
    render(<InvoicePayments invoice={state.invoice as never} />)
    // Balance due and pending both read 1,300 — the balance has not moved,
    // because nothing has been paid.
    expect(screen.getAllByText(/1,300\.00/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText(/^₱?0\.00$/).length).toBeGreaterThanOrEqual(2)
  })
})

describe('whether another instruction may be prepared', () => {
  it('offers Prepare payment when something is still available', () => {
    render(<InvoicePayments invoice={state.invoice as never} />)
    expect(screen.getByRole('button', { name: 'Prepare payment' })).toBeTruthy()
  })

  it('withdraws the button entirely once the balance is fully instructed', () => {
    state.invoice = invoice({ pending_payment_amount: 1300, available_to_prepare: 0 })
    render(<InvoicePayments invoice={state.invoice as never} />)
    // Not disabled — absent. A greyed control invites clicking to find out why.
    expect(screen.queryByRole('button', { name: 'Prepare payment' })).toBeNull()
    expect(
      screen.getByText('The remaining balance is already covered by payment instructions.')
    ).toBeTruthy()
  })

  it('still offers it when only part of the balance is instructed', () => {
    state.invoice = invoice({ pending_payment_amount: 800, available_to_prepare: 500 })
    render(<InvoicePayments invoice={state.invoice as never} />)
    expect(screen.getByRole('button', { name: 'Prepare payment' })).toBeTruthy()
  })

  it('offers nothing to a role that does not prepare payments', () => {
    state.role = 'finance_manager'
    render(<InvoicePayments invoice={state.invoice as never} />)
    expect(screen.queryByRole('button', { name: 'Prepare payment' })).toBeNull()
  })
})

describe('the builder ceiling', () => {
  function openBuilder(over: Record<string, unknown> = {}) {
    state.invoice = invoice(over)
    render(<InvoicePayments invoice={state.invoice as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare payment' }))
    return screen.getByLabelText('Amount') as HTMLInputElement
  }

  it('defaults to what is available, not to what is owed', () => {
    const amount = openBuilder({ pending_payment_amount: 800, available_to_prepare: 500 })
    expect(amount.value).toBe('500.00')
  })

  it('refuses an amount above what is available, naming the figure', () => {
    const amount = openBuilder({ pending_payment_amount: 800, available_to_prepare: 500 })
    fireEvent.change(amount, { target: { value: '600' } })
    expect(screen.getByText(/Available to prepare: ₱?500\.00\./)).toBeTruthy()
  })

  it('accepts exactly what is available', () => {
    const amount = openBuilder({ pending_payment_amount: 800, available_to_prepare: 500 })
    fireEvent.change(amount, { target: { value: '500' } })
    expect(screen.queryByText(/Available to prepare: ₱?500\.00\./)).toBeNull()
  })

  it('says how much is already instructed, so the ceiling is explicable', () => {
    openBuilder({ pending_payment_amount: 800, available_to_prepare: 500 })
    expect(screen.getByText(/already instructed/)).toBeTruthy()
  })
})
