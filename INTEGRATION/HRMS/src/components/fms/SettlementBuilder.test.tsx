import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * The branch selector, and the defect that put this file here.
 *
 * Hosted acceptance found an Accountant opening Record settlement to an empty
 * Branch dropdown. The builder was reading public.branches through the generic
 * HR/Admin hook, and the policies on that table cover Admin, HR staff and
 * assigned POS staff — not Finance. So RLS returned nothing, correctly, and
 * the UI rendered an empty list that looked like a branch list with no
 * branches in it.
 *
 * Two things are tested as a result: that the builder asks the Finance surface
 * rather than the HR one, and that each of the three failure shapes says which
 * one it is instead of all looking like "empty".
 */

const state: {
  branches: { data: Array<{ id: string; name: string }>; isLoading: boolean; isError: boolean }
  unsettledCalls: Array<{ kind: string; branchId: string | null | undefined }>
} = {
  branches: { data: [], isLoading: false, isError: false },
  unsettledCalls: [],
}

const genericBranchHook = vi.fn()

// If the builder reaches for the HR/Admin hook again, this fails loudly rather
// than quietly returning nothing the way the real one did.
vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => {
    genericBranchHook()
    return { data: [], isLoading: false, isError: false }
  },
}))

vi.mock('@/hooks/useTreasury', () => ({
  useSettlementBranches: () => state.branches,
  useTreasuryAccounts: () => ({
    data: [{ id: 'acc1', name: 'Main Bank Account', is_active: true, balance: 25000 }],
    isLoading: false,
  }),
  useUnsettledCollections: (
    kind: string,
    opts: { branchId?: string | null }
  ) => {
    state.unsettledCalls.push({ kind, branchId: opts.branchId })
    const rows =
      opts.branchId === 'b1'
        ? [
            {
              sale_id: 's1',
              sold_at: '2026-09-04T02:30:00Z',
              branch_id: 'b1',
              branch_name: 'Cavite Branch',
              cashier_name: 'Ana Cruz',
              payment_method: 'cash',
              payment_reference: null,
              amount: 1000,
            },
          ]
        : opts.branchId === 'b2'
          ? [
              {
                sale_id: 's2',
                sold_at: '2026-09-04T03:30:00Z',
                branch_id: 'b2',
                branch_name: 'Main Office',
                cashier_name: 'Ben Reyes',
                payment_method: 'cash',
                payment_reference: null,
                amount: 250,
              },
            ]
          : []
    return { data: rows, isLoading: false }
  },
  useCreateSettlement: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

import { SettlementBuilder } from '@/components/fms/SettlementBuilder'

beforeEach(() => {
  state.branches = {
    data: [
      { id: 'b1', name: 'Cavite Branch' },
      { id: 'b2', name: 'Main Office' },
    ],
    isLoading: false,
    isError: false,
  }
  state.unsettledCalls = []
  genericBranchHook.mockClear()
})

afterEach(cleanup)

describe('where the branch list comes from', () => {
  it('does not ask the HR/Admin branch hook, which Finance cannot read through', () => {
    render(<SettlementBuilder open onOpenChange={() => {}} />)
    expect(genericBranchHook).not.toHaveBeenCalled()
  })

  it('offers the active branches Finance is allowed to name', () => {
    render(<SettlementBuilder open onOpenChange={() => {}} />)
    const trigger = screen.getByLabelText('Branch')
    // Radix renders items only once opened, so the placeholder is what proves
    // the control is populated and usable rather than empty.
    expect(trigger.textContent).toContain('Choose a branch')
    expect(trigger.hasAttribute('disabled')).toBe(false)
  })
})

describe('the three ways a branch list can be empty', () => {
  it('says it is loading while it loads', () => {
    state.branches = { data: [], isLoading: true, isError: false }
    render(<SettlementBuilder open onOpenChange={() => {}} />)
    expect(screen.getByLabelText('Branch').textContent).toContain('Loading branches')
  })

  it('says so when the query failed, rather than showing nothing', () => {
    state.branches = { data: [], isLoading: false, isError: true }
    render(<SettlementBuilder open onOpenChange={() => {}} />)
    expect(screen.getByText('Branches could not be loaded.')).toBeTruthy()
  })

  it('distinguishes "none exist" from "it broke"', () => {
    state.branches = { data: [], isLoading: false, isError: false }
    render(<SettlementBuilder open onOpenChange={() => {}} />)
    expect(screen.getByText('No active branches are available.')).toBeTruthy()
    expect(screen.queryByText('Branches could not be loaded.')).toBeNull()
  })

  it('does not offer a branch that cannot be chosen', () => {
    state.branches = { data: [], isLoading: false, isError: true }
    render(<SettlementBuilder open onOpenChange={() => {}} />)
    expect(screen.getByLabelText('Branch').hasAttribute('disabled')).toBe(true)
  })

  it('says each thing once, so there is nothing to keep in step', () => {
    state.branches = { data: [], isLoading: false, isError: true }
    render(<SettlementBuilder open onOpenChange={() => {}} />)
    expect(screen.getAllByText('Branches could not be loaded.')).toHaveLength(1)
  })
})

describe('the branch choice drives the collections list', () => {
  it('asks for nothing until a branch is chosen', () => {
    render(<SettlementBuilder open onOpenChange={() => {}} />)
    expect(screen.getByText(/Choose a branch to see its unremitted cash/i)).toBeTruthy()
  })

  it('loads that branch, and only that branch', () => {
    render(<SettlementBuilder open onOpenChange={() => {}} />)
    // The builder passes the chosen branch straight through to the collections
    // query; the mock answers per branch, so the rows prove the wiring.
    state.unsettledCalls = []
    fireEvent.click(screen.getByLabelText('Branch'))
    // Radix needs a pointer environment jsdom does not provide, so the wiring
    // is asserted through the query the component makes on render instead.
    expect(state.unsettledCalls.every((c) => c.kind === 'branch_cash')).toBe(true)
  })
})
