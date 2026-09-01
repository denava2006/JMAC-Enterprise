import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Fee } from '@/lib/posFees'

/**
 * The branch's POS Settings screen.
 *
 * Read-only by design, not by omission. Fees decide what every customer at the
 * branch pays, and this system already reserves customer pricing to
 * Administrators in two other places -- the branch selling-price trigger and
 * branch_pos_settings being is_admin() for writes. The page exists so a manager
 * can answer "why is this receipt higher than the shelf price" without moving
 * that authority, so the tests care mostly about what it does NOT offer.
 */

const BRANCH_A = 'b1'

const state: { fees: Fee[]; branchIds: string[] } = { fees: [], branchIds: [BRANCH_A] }

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: 'employee' },
    posAccess: { hasAccess: true, branchIds: state.branchIds, assignments: [] },
  }),
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({
    data: [{ id: BRANCH_A, name: 'Cavite Branch', is_active: true }],
    isLoading: false,
  }),
}))

vi.mock('@/hooks/usePosTill', () => ({
  useBranchFees: () => ({ data: state.fees, isLoading: false }),
}))

const { default: PosSettingsPage } = await import('@/pages/pos/PosSettingsPage')

afterEach(() => {
  cleanup()
  state.fees = []
  state.branchIds = [BRANCH_A]
})

const fee = (overrides: Partial<Fee> = {}): Fee => ({
  id: 'f1',
  name: 'Service Charge',
  type: 'percent',
  value: 10,
  enabled: true,
  ...overrides,
})

describe('what a manager can see', () => {
  it('shows the fees the till is applying', () => {
    state.fees = [fee()]
    render(<PosSettingsPage />)
    expect(screen.getByText('Service Charge')).toBeTruthy()
    expect(screen.getByText('10%')).toBeTruthy()
    expect(screen.getByText('Applied')).toBeTruthy()
  })

  it('shows a disabled fee too, because it explains a past total', () => {
    state.fees = [fee({ enabled: false })]
    render(<PosSettingsPage />)
    expect(screen.getByText('Not applied')).toBeTruthy()
  })

  it('says plainly when a branch adds nothing', () => {
    state.fees = []
    render(<PosSettingsPage />)
    expect(screen.getByText(/adds no fees/i)).toBeTruthy()
  })
})

describe('what it must not offer', () => {
  it('has no way to change what customers are charged', () => {
    state.fees = [fee()]
    render(<PosSettingsPage />)

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('button', { name: /save|add fee|edit/i })).toBeNull()
  })

  it('tells the manager who does change it', () => {
    state.fees = [fee()]
    render(<PosSettingsPage />)
    expect(screen.getByText(/set by an Administrator/i)).toBeTruthy()
  })

  it('shows nothing resembling a secret or a provider key', () => {
    // branch_pos_settings stores only fees and a QR path; the PayMongo key,
    // webhook secret and Brevo key live in Edge Function secrets and Vault,
    // which no browser session can read. This asserts the screen never grows
    // a field that pretends otherwise.
    state.fees = [fee()]
    render(<PosSettingsPage />)
    const text = document.body.textContent ?? ''
    for (const word of ['secret', 'sk_test', 'sk_live', 'API key', 'webhook', 'Brevo', 'PayMongo']) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase())
    }
  })

  it('explains itself when the account holds no branch', () => {
    state.branchIds = []
    render(<PosSettingsPage />)
    expect(screen.getByText(/not assigned to a branch/i)).toBeTruthy()
  })
})
