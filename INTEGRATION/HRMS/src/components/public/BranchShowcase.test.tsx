import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { PublicBranch } from '@/hooks/usePublicBranches'

/**
 * The public branches section.
 *
 * The claim that matters is that there is one source. The cards and the map are
 * both fed by the same query, so a branch cannot appear on one and be missing
 * from the other — which is exactly what a hardcoded list beside a live map
 * produces, and the disagreeing half is always the one nobody is looking at.
 */

// jsdom implements neither observer. Framer's whileInView needs the first for
// the scroll reveals; the stub reports nothing, which leaves elements in their
// initial state — visible enough for these assertions, since opacity is not
// what is being tested here.
class StubObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
vi.stubGlobal('IntersectionObserver', StubObserver)
vi.stubGlobal('ResizeObserver', StubObserver)

const state: {
  branches: PublicBranch[]
  isLoading: boolean
  isError: boolean
} = { branches: [], isLoading: false, isError: false }

/** What BranchMap was handed. The map itself is covered by its own tests. */
const mapProps: Array<{ branches: PublicBranch[]; variant?: string }> = []

vi.mock('@/hooks/usePublicBranches', () => ({
  usePublicBranches: () => ({
    data: state.branches,
    isLoading: state.isLoading,
    isError: state.isError,
  }),
}))

vi.mock('@/components/admin/BranchMap', () => ({
  BranchMap: (props: { branches: PublicBranch[]; variant?: string }) => {
    mapProps.push(props)
    return <div data-testid="branch-map" />
  },
}))

const { BranchShowcase } = await import('@/components/public/BranchShowcase')

function branch(over: Partial<PublicBranch> = {}): PublicBranch {
  return {
    id: 'b1',
    name: 'Cavite Branch',
    address: 'Aguinaldo Highway, Dasmariñas, Cavite',
    latitude: 14.3294,
    longitude: 120.9367,
    ...over,
  }
}

function show() {
  return render(
    <MemoryRouter>
      <BranchShowcase />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  state.branches = []
  state.isLoading = false
  state.isError = false
  mapProps.length = 0
})

describe('one source for the cards and the map', () => {
  it('renders a card for every fetched branch', () => {
    state.branches = [
      branch({ id: 'b1', name: 'Main Office', address: '123 Ayala Avenue, Makati City' }),
      branch({ id: 'b2', name: 'Cavite Branch' }),
    ]
    show()
    expect(screen.getByText('Main Office')).toBeTruthy()
    expect(screen.getByText('Cavite Branch')).toBeTruthy()
    expect(screen.getByText('123 Ayala Avenue, Makati City')).toBeTruthy()
  })

  it('hands the map exactly what the cards were built from', () => {
    state.branches = [branch({ id: 'b1' }), branch({ id: 'b2', name: 'Main Office' })]
    show()
    expect(mapProps.at(-1)?.branches).toEqual(state.branches)
  })

  it('picks up a branch the back office added, with no code change', () => {
    // The point of the whole section: this is a fetched list, not a literal.
    state.branches = [branch({ id: 'b3', name: 'Batangas Branch', address: 'Kumintang, Batangas' })]
    show()
    expect(screen.getByText('Batangas Branch')).toBeTruthy()
    expect(mapProps.at(-1)?.branches[0].name).toBe('Batangas Branch')
  })

  it('names no branch of its own', () => {
    // With an empty fetch nothing should appear. If "Main Office" or "Cavite
    // Branch" showed up here they would be hardcoded.
    state.branches = []
    const { container } = show()
    expect(container.textContent).not.toContain('Main Office')
    expect(container.textContent).not.toContain('Cavite Branch')
  })

  it('follows a rename and a moved address', () => {
    state.branches = [branch({ id: 'b1', name: 'Cavite Main', address: 'New Address 42' })]
    show()
    expect(screen.getByText('Cavite Main')).toBeTruthy()
    expect(screen.getByText('New Address 42')).toBeTruthy()
  })
})

describe('branches without coordinates', () => {
  it('still gets a card, and says it is not mapped', () => {
    state.branches = [branch({ latitude: null, longitude: null })]
    show()
    expect(screen.getByText('Cavite Branch')).toBeTruthy()
    expect(screen.getByText('Location not mapped yet')).toBeTruthy()
  })

  it('does not mark a located branch as unmapped', () => {
    state.branches = [branch()]
    show()
    expect(screen.queryByText('Location not mapped yet')).toBeNull()
  })

  it('still renders the map rather than failing on the missing pair', () => {
    state.branches = [branch({ id: 'b1', latitude: null, longitude: null }), branch({ id: 'b2' })]
    show()
    expect(screen.getByTestId('branch-map')).toBeTruthy()
    // Both are handed over; filtering an unlocated branch out of the markers is
    // the map's own job, and its tests cover it.
    expect(mapProps.at(-1)?.branches).toHaveLength(2)
  })

  it('says so plainly when nothing is pinned at all', () => {
    state.branches = [branch({ latitude: null, longitude: null })]
    show()
    expect(screen.getByText(/None of our branches are pinned yet/)).toBeTruthy()
  })

  it('counts the pinned ones when only some are', () => {
    state.branches = [branch({ id: 'b1' }), branch({ id: 'b2', latitude: null, longitude: null })]
    show()
    expect(screen.getByText(/1 of 2 locations pinned/)).toBeTruthy()
  })
})

describe('the public map is a showpiece, not a dialog preview', () => {
  it('asks for the public height rather than the compact one', () => {
    state.branches = [branch()]
    show()
    expect(mapProps.at(-1)?.variant).toBe('public')
    expect(mapProps.at(-1)?.variant).not.toBe('compact')
  })
})

describe('loading, empty and failure', () => {
  it('shows a skeleton while the branches are being fetched', () => {
    state.isLoading = true
    const { container } = show()
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('branch-map')).toBeNull()
  })

  it('invites the first branch when there are none', () => {
    state.branches = []
    show()
    expect(screen.getByText('Locations will appear here as branches are added.')).toBeTruthy()
  })

  it('fails without showing a visitor a database error', () => {
    state.isError = true
    const { container } = show()
    expect(screen.getByText(/Our locations could not be loaded just now/)).toBeTruthy()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/supabase|postgres|PGRST|permission denied|relation/i)
  })
})

describe('what the section can and cannot know', () => {
  it('reads the public view, never the branches table', () => {
    // Asserted against the hook's source: the boundary is that this page has no
    // path to the internal record at all, not that it happens to ask nicely.
    const hook = require('node:fs').readFileSync('src/hooks/usePublicBranches.ts', 'utf8')
    expect(hook).toContain('public_branch_locations')
    expect(hook).not.toMatch(/from\('branches'\)/)
  })

  it('has no field to render that is not public', () => {
    // PublicBranch is the whole vocabulary available here. If an operational
    // column were ever added to the view this would need updating deliberately.
    const hook = require('node:fs').readFileSync('src/hooks/usePublicBranches.ts', 'utf8')
    for (const forbidden of ['phone', 'is_active', 'created_at', 'updated_at']) {
      expect(hook).not.toContain(`${forbidden}:`)
    }
  })
})
