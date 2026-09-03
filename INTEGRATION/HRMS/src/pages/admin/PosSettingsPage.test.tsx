import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Branch } from '@/hooks/useBranches'
import { emptySettings, type BranchPosSettings } from '@/lib/posSettings'
import type { Fee } from '@/lib/posFees'

/**
 * The page has one behaviour that matters more than the rest: a branch with no
 * branch_pos_settings row must render as "no fees, no QR" rather than crashing.
 * That is the normal state of every branch until someone configures it.
 */

const CAVITE = 'b1000000-0000-0000-0000-000000000002'

const branches: Branch[] = [
  { id: 'b1', name: 'Main Office', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: CAVITE, name: 'Cavite Branch', address: null, phone: null, latitude: null, longitude: null, is_active: true, created_at: '', updated_at: '' },
  { id: 'b3', name: 'Closed Branch', address: null, phone: null, latitude: null, longitude: null, is_active: false, created_at: '', updated_at: '' },
]

const state: { settings: BranchPosSettings | null; branches: Branch[] } = {
  settings: null,
  branches,
}

const saveFees = vi.fn()

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: state.branches, isLoading: false }),
}))

// Mocked wholesale rather than with importActual: the real module imports the
// Supabase client, which crashes the vitest worker fork on load.
vi.mock('@/hooks/useBranchPosSettings', () => ({
  QR_BUCKET: 'pos-payment-qr',
  useAllBranchPosSettings: () => ({ data: [], isLoading: false }),
  useBranchPosSettings: (branchId: string | undefined) => ({
    data: branchId ? (state.settings ?? emptySettings(branchId)) : undefined,
    isLoading: false,
    isConfigured: !!state.settings,
  }),
  usePaymentQrUrl: () => ({ data: null, isLoading: false }),
  useSaveBranchFees: () => ({ mutate: saveFees, isPending: false }),
  useUploadPaymentQr: () => ({ mutate: vi.fn(), isPending: false }),
  useRemovePaymentQr: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { default: PosSettingsPage } = await import('@/pages/admin/PosSettingsPage')

function fee(overrides: Partial<Fee> = {}): Fee {
  return { id: 'f1', name: 'Service Charge', type: 'percent', value: 10, enabled: true, ...overrides }
}

afterEach(() => {
  cleanup()
  state.settings = null
  state.branches = branches
  saveFees.mockReset()
})

describe('a branch with no settings row', () => {
  it('renders as no fees and no QR rather than crashing', () => {
    render(<PosSettingsPage />)

    expect(screen.getByText(/No additional fees/)).toBeTruthy()
    expect(screen.getByText('No QR uploaded')).toBeTruthy()
  })

  it('says so, so the reader knows nothing was lost', () => {
    render(<PosSettingsPage />)
    expect(screen.getByText(/no POS configuration yet/)).toBeTruthy()
  })
})

describe('a configured branch', () => {
  it('shows its fees', () => {
    state.settings = { ...emptySettings('b1'), fees: [fee({ name: 'Service Charge' })] }
    render(<PosSettingsPage />)

    expect(screen.getByDisplayValue('Service Charge')).toBeTruthy()
    expect(screen.queryByText(/no POS configuration yet/)).toBeNull()
  })

  it('previews what the fees add, and says the server is the authority', () => {
    state.settings = { ...emptySettings('b1'), fees: [fee({ type: 'percent', value: 10 })] }
    render(<PosSettingsPage />)

    // 10% of the 1,000 preview basket, shown twice: once as the fee's own line
    // and once as the total added to the basket.
    expect(screen.getAllByText('₱100.00')).toHaveLength(2)
    expect(screen.getByText('Added to the basket')).toBeTruthy()
    expect(screen.getByText(/calculated by the server at checkout/)).toBeTruthy()
  })
})

describe('validation before the round trip', () => {
  it('refuses to save a negative fee and explains why', () => {
    state.settings = { ...emptySettings('b1'), fees: [fee({ value: -5 })] }
    render(<PosSettingsPage />)

    expect(screen.getByText(/cannot be negative/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save fees' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses a percentage over 100', () => {
    state.settings = { ...emptySettings('b1'), fees: [fee({ type: 'percent', value: 150 })] }
    render(<PosSettingsPage />)

    expect(screen.getByText(/cannot exceed 100%/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save fees' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('allows saving a valid configuration', () => {
    state.settings = { ...emptySettings('b1'), fees: [fee({ type: 'fixed', value: 25 })] }
    render(<PosSettingsPage />)

    const save = screen.getByRole('button', { name: 'Save fees' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(saveFees).toHaveBeenCalledTimes(1)
  })
})

describe('editing', () => {
  it('adds a fee locally without saving', () => {
    render(<PosSettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Add fee' }))

    expect(screen.queryByText(/No additional fees/)).toBeNull()
    // A new row is nameless, so validation objects until it is filled in.
    expect(screen.getByText(/Every fee needs a name/)).toBeTruthy()
    expect(saveFees).not.toHaveBeenCalled()
  })

  it('removes a fee', () => {
    state.settings = { ...emptySettings('b1'), fees: [fee({ name: 'Service Charge' })] }
    render(<PosSettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Service Charge' }))
    expect(screen.getByText(/No additional fees/)).toBeTruthy()
  })
})

describe('branch selection', () => {
  it('offers only active branches', () => {
    render(<PosSettingsPage />)
    // The trigger shows the first active branch; the closed one is never an
    // option because a branch that is not trading has no till to configure.
    expect(screen.getByLabelText('Branch').textContent).toContain('Main Office')
    expect(screen.queryByText('Closed Branch')).toBeNull()
  })

  it('explains itself when there are no active branches at all', () => {
    state.branches = [branches[2]]
    render(<PosSettingsPage />)
    expect(screen.getByText(/no active branches yet/)).toBeTruthy()
  })
})

describe('the payment QR', () => {
  it('is described as display configuration, not proof of payment', () => {
    render(<PosSettingsPage />)
    expect(screen.getByText(/never proof that a payment was received/)).toBeTruthy()
  })

  it('says the image is served privately through a signed link', () => {
    render(<PosSettingsPage />)
    expect(screen.getByText(/short-lived signed link, never a public URL/)).toBeTruthy()
  })
})
