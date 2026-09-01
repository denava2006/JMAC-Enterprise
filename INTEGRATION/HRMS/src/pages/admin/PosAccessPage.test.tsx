import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PosAssignment } from '@/hooks/usePosAccess'

/**
 * The page's job is to show POS access honestly: revoked rows are kept, an
 * Administrator is never shown as holding a branch, and an assignment against a
 * deactivated account is visibly dead rather than quietly listed as working.
 *
 * The hooks are mocked because none of that depends on the network -- what the
 * database allows is pinned separately by supabase/tests/pos_access_rls.sql.
 */

function assignment(overrides: Partial<PosAssignment> = {}): PosAssignment {
  return {
    id: 'a1',
    profile_id: 'p1',
    branch_id: 'b2',
    pos_role: 'cashier',
    status: 'active',
    created_by: 'admin-1',
    created_at: '2026-08-12T18:18:21Z',
    updated_at: '2026-08-12T18:18:21Z',
    profile: {
      id: 'p1',
      full_name: 'Liza Fernandez',
      email: 'liza.fernandez@example.com',
      role: 'employee',
      status: 'active',
    },
    branch: { id: 'b2', name: 'Cavite Branch' },
    granted_by: { full_name: 'Administrator' },
    ...overrides,
  }
}

const state: { assignments: PosAssignment[] } = { assignments: [] }

/** Candidates the database says may hold the chosen role at the chosen branch. */
let eligibleEmployees: {
  profile_id: string; employee_id: string; full_name: string; email: string
  employee_number: string | null; department_name: string; position_title: string
}[] = []
/** Active assignments whose holder is no longer eligible. */
let noncompliant: {
  assignment_id: string; profile_id: string; full_name: string; branch_id: string
  branch_name: string; pos_role: 'manager' | 'cashier'; department_name: string
  position_title: string; reason: string
}[] = []

vi.mock('@/hooks/usePosAccess', () => ({
  usePosAssignments: () => ({ data: state.assignments, isLoading: false }),
  useAssignableProfiles: () => ({ data: [] }),
  useGrantPosAccess: () => ({ mutateAsync: vi.fn() }),
  useRevokePosAccess: () => ({ mutate: vi.fn() }),
}))

// Phase 9A: the page now asks the database who is eligible, and shows a panel
// for assignments that no longer authorize. Both are RPC-backed.
vi.mock('@/hooks/useWorkforce', () => ({
  useEligiblePosEmployees: () => ({ data: eligibleEmployees, isLoading: false }),
  useNoncompliantAssignments: () => ({ data: noncompliant, isLoading: false }),
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: [{ id: 'b2', name: 'Cavite Branch', is_active: true }] }),
}))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'admin-1', role: 'admin' } }),
}))

const { default: PosAccessPage } = await import('@/pages/admin/PosAccessPage')

afterEach(() => {
  cleanup()
  state.assignments = []
})

describe('the assignment list', () => {
  it('shows who has access, where, and as what', () => {
    state.assignments = [assignment()]
    render(<PosAccessPage />)

    expect(screen.getByText('Liza Fernandez')).toBeTruthy()
    expect(screen.getByText('liza.fernandez@example.com')).toBeTruthy()
    expect(screen.getByText('Cavite Branch')).toBeTruthy()
    expect(screen.getByText('Cashier')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
  })

  it('names a POS Manager distinctly from an HR Manager', () => {
    state.assignments = [assignment({ pos_role: 'manager' })]
    render(<PosAccessPage />)

    expect(screen.getByText('POS Manager')).toBeTruthy()
    // The person's HR role is shown alongside and is unaffected by it.
    expect(screen.getByText('Employee')).toBeTruthy()
  })

  it('records who granted the access', () => {
    state.assignments = [assignment()]
    render(<PosAccessPage />)
    expect(screen.getByText('by Administrator')).toBeTruthy()
  })
})

describe('revoked history', () => {
  it('is kept, not deleted -- the counts show it even before you look at it', () => {
    state.assignments = [assignment({ id: 'a2', status: 'inactive' })]
    render(<PosAccessPage />)

    // The default filter is Active, so the revoked row is not listed...
    expect(screen.queryByText('Liza Fernandez')).toBeNull()
    // ...but the filter still counts it, which is how the reader knows it is
    // there rather than gone.
    expect(screen.getByRole('button', { name: 'Revoked (1)' })).toBeTruthy()
  })

  it('is reachable, and labels the assignment "Revoked"', () => {
    state.assignments = [assignment(), assignment({ id: 'a2', status: 'inactive', branch_id: 'b1' })]
    render(<PosAccessPage />)

    expect(screen.getByRole('button', { name: 'All (2)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Active (1)' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Revoked (1)' }))

    expect(screen.getByText('Revoked')).toBeTruthy()
    expect(screen.queryByText('Active')).toBeNull()
  })

  it('shows both an active and a revoked assignment together under All', () => {
    state.assignments = [assignment(), assignment({ id: 'a2', status: 'inactive', branch_id: 'b1' })]
    render(<PosAccessPage />)

    fireEvent.click(screen.getByRole('button', { name: 'All (2)' }))

    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Revoked')).toBeTruthy()
  })
})

describe('an assignment against a deactivated account', () => {
  it('is shown as inactive rather than as working access', () => {
    // The database already refuses it -- has_pos_access() returns false because
    // has_pos_role() requires profiles.status = 'active'. The row would
    // otherwise read as live access, so it is flagged.
    state.assignments = [
      assignment({
        profile: {
          id: 'p1',
          full_name: 'Liza Fernandez',
          email: 'liza.fernandez@example.com',
          role: 'employee',
          status: 'inactive',
        },
      }),
    ]
    render(<PosAccessPage />)

    expect(screen.getByText('Account inactive')).toBeTruthy()
  })
})

describe('administrators', () => {
  it('are explained rather than listed as holding a branch', () => {
    state.assignments = []
    render(<PosAccessPage />)

    expect(screen.getByText(/Administrators reach every branch/)).toBeTruthy()
    expect(screen.getByText(/never listed here/)).toBeTruthy()
  })

  it('is stated that an HR role alone grants nothing', () => {
    render(<PosAccessPage />)
    expect(screen.getByText(/An HR role never grants POS access on its own/)).toBeTruthy()
  })
})

describe('the grant entry point', () => {
  it('is offered', () => {
    render(<PosAccessPage />)
    expect(screen.getByRole('button', { name: 'Grant access' })).toBeTruthy()
  })
})

describe('Phase 9A eligibility', () => {
  it('lists an assignment that no longer authorizes, and says why', () => {
    // A grant made before the workforce rules -- or one whose holder has since
    // been transferred -- keeps its row but stops working. Silence would be an
    // invisible outage.
    noncompliant = [
      {
        assignment_id: 'a1',
        profile_id: 'u9',
        full_name: 'Jerome Castillo',
        branch_id: 'b1',
        branch_name: 'Cavite Branch',
        pos_role: 'manager',
        department_name: 'IT',
        position_title: 'IT Support',
        reason: 'IT Support is not eligible for POS Manager.',
      },
    ]
    render(<PosAccessPage />)
    // The count and the noun are separate text nodes, so match the heading
    // element rather than a text fragment.
    expect(
      screen.getByRole('heading', { name: '1 assignment no longer authorize' })
    ).toBeTruthy()
    expect(screen.getByText('IT Support is not eligible for POS Manager.')).toBeTruthy()
    expect(screen.getByText(/Nothing was deleted/)).toBeTruthy()
  })

  it('shows no compliance panel when every assignment is valid', () => {
    noncompliant = []
    render(<PosAccessPage />)
    expect(screen.queryByText(/no longer authorize/)).toBeNull()
  })
})

describe('re-granting a revoked assignment', () => {
  const openRowMenu = () => {
    // Radix opens on keydown; a synthetic click alone does not in jsdom.
    const triggers = screen.getAllByRole('button', { name: 'Assignment actions' })
    fireEvent.keyDown(triggers[0], { key: 'Enter' })
  }

  it('offers "Grant again" when only revoked history exists', () => {
    state.assignments = [
      assignment({ id: 'a1', status: 'inactive', pos_role: 'manager' }),
    ]
    render(<PosAccessPage />)
    fireEvent.click(screen.getByRole('button', { name: /^All / }))
    openRowMenu()

    expect(screen.getByText('Grant again')).toBeTruthy()
    expect(screen.queryByText('Already active')).toBeNull()
  })

  it('replaces it with "Already active" when a live grant covers the same branch', () => {
    // The reported confusion: an August revoked row and a September active row
    // for the same person and branch looked like two accounts, and the old row
    // still invited a re-grant the database would refuse.
    state.assignments = [
      assignment({ id: 'old', status: 'inactive', pos_role: 'manager', created_at: '2026-08-25T00:00:00Z' }),
      assignment({ id: 'new', status: 'active', pos_role: 'manager', created_at: '2026-09-01T00:00:00Z' }),
    ]
    render(<PosAccessPage />)
    fireEvent.click(screen.getByRole('button', { name: /^Revoked / }))
    openRowMenu()

    expect(screen.getByText('Already active')).toBeTruthy()
    expect(screen.queryByText('Grant again')).toBeNull()
  })

  it('still offers "Grant again" when the live grant is at a different branch', () => {
    // A grant at one till says nothing about another.
    state.assignments = [
      assignment({ id: 'old', branch_id: 'b2', status: 'inactive' }),
      assignment({ id: 'other', branch_id: 'b9', status: 'active', branch: { id: 'b9', name: 'Other Branch' } }),
    ]
    render(<PosAccessPage />)
    fireEvent.click(screen.getByRole('button', { name: /^Revoked / }))
    openRowMenu()

    expect(screen.getByText('Grant again')).toBeTruthy()
  })

  it('labels the revoked filter "Revoked", matching the badge', () => {
    state.assignments = [assignment({ status: 'inactive' })]
    render(<PosAccessPage />)
    expect(screen.getByRole('button', { name: /^Revoked / })).toBeTruthy()
  })
})
