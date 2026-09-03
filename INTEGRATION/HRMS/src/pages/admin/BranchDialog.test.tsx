import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Branch } from '@/hooks/useBranches'

/**
 * Pinning a branch on the map.
 *
 * The point of the change: nobody should have to look up decimal degrees to
 * say where a shop is. The map is the input, the numbers are the readout, and
 * what reaches the save call is whatever the map produced.
 */

const saved: Array<Record<string, unknown>> = []

/** The map, reduced to what this dialog needs from it: somewhere to click. */
let pickHandler: ((lat: number, lng: number) => void) | null = null
const mapProps: Array<{ branches: Branch[]; onPick?: unknown }> = []

vi.mock('@/components/admin/BranchMap', () => ({
  BranchMap: (props: {
    branches: Branch[]
    onPick?: (lat: number, lng: number) => void
  }) => {
    pickHandler = props.onPick ?? null
    mapProps.push(props)
    return <div data-testid="branch-map" />
  },
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: [], isLoading: false }),
  useWorkLocations: () => ({ data: [], isLoading: false }),
  useSaveBranch: () => ({
    mutate: (values: Record<string, unknown>, opts?: { onSuccess?: () => void }) => {
      saved.push(values)
      opts?.onSuccess?.()
    },
    isPending: false,
  }),
  useDeleteBranch: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveWorkLocation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteWorkLocation: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { BranchDialog } = await import('@/pages/admin/BranchesPage')

function branch(over: Partial<Branch> = {}): Branch {
  return {
    id: 'b1',
    name: 'Cavite Branch',
    address: 'Aguinaldo Highway, Dasmariñas, Cavite',
    phone: null,
    latitude: null,
    longitude: null,
    is_active: true,
    created_at: '',
    updated_at: '',
    ...over,
  }
}

function show(existing: Branch | null = null) {
  return render(<BranchDialog open branch={existing} onOpenChange={() => {}} />)
}

/**
 * A click on the map, as the real component reports one.
 *
 * Wrapped in act because this is a bare callback rather than a DOM event --
 * fireEvent does that for you, a direct call does not, and the state update
 * would otherwise not be flushed before the assertions run.
 */
function pin(lat: number, lng: number) {
  act(() => {
    pickHandler?.(lat, lng)
  })
}

afterEach(() => {
  cleanup()
  saved.length = 0
  mapProps.length = 0
  pickHandler = null
})

describe('adding a branch, map first', () => {
  it('says nothing is pinned before anything is', () => {
    show()
    expect(screen.getByText('No location pinned yet')).toBeTruthy()
  })

  it('explains how to pin one', () => {
    show()
    expect(screen.getByText(/Click anywhere on the map to pin/)).toBeTruthy()
    expect(screen.getByText(/drag the marker to adjust/)).toBeTruthy()
  })

  it('fills both coordinates from a click on the map', () => {
    show()
    pin(14.3294, 120.9367)

    expect(screen.getByText('Location pinned')).toBeTruthy()
    expect(screen.getByText('14.3294, 120.9367')).toBeTruthy()
  })

  it('moves the pin when a second place is clicked', () => {
    show()
    pin(14.3294, 120.9367)
    pin(14.5995, 120.9842)

    expect(screen.getByText('14.5995, 120.9842')).toBeTruthy()
    expect(screen.queryByText('14.3294, 120.9367')).toBeNull()
  })

  it('hands the pinned point to the map, so the marker follows', () => {
    show()
    pin(14.3294, 120.9367)

    const shown = mapProps.at(-1)?.branches ?? []
    expect(shown).toHaveLength(1)
    expect(shown[0].latitude).toBe(14.3294)
    expect(shown[0].longitude).toBe(120.9367)
  })

  it('saves what the map produced', () => {
    show()
    fireEvent.change(screen.getByLabelText(/Branch Name/), { target: { value: 'Dasma Branch' } })
    pin(14.3294, 120.9367)
    fireEvent.click(screen.getByRole('button', { name: 'Add branch' }))

    expect(saved).toHaveLength(1)
    expect(saved[0].latitude).toBe(14.3294)
    expect(saved[0].longitude).toBe(120.9367)
    expect(saved[0].name).toBe('Dasma Branch')
  })
})

describe('the coordinates are a readout, not the input', () => {
  it('shows them read-only', () => {
    show()
    pin(14.3294, 120.9367)

    expect(screen.getByLabelText('Latitude')).toHaveProperty('readOnly', true)
    expect(screen.getByLabelText('Longitude')).toHaveProperty('readOnly', true)
  })

  it('carries the pinned values into those fields', () => {
    show()
    pin(14.3294, 120.9367)

    expect(screen.getByLabelText('Latitude')).toHaveProperty('value', '14.3294')
    expect(screen.getByLabelText('Longitude')).toHaveProperty('value', '120.9367')
  })

  it('can clear a pin deliberately', () => {
    show()
    pin(14.3294, 120.9367)
    fireEvent.click(screen.getByRole('button', { name: 'Clear pin' }))

    expect(screen.getByText('No location pinned yet')).toBeTruthy()
    expect(mapProps.at(-1)?.branches).toHaveLength(0)
  })

  it('saves nulls for a branch nobody pinned', () => {
    // Unpinned stays a legitimate state: the branch lists, it simply is not on
    // a map yet.
    show()
    fireEvent.change(screen.getByLabelText(/Branch Name/), { target: { value: 'No Pin Branch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add branch' }))

    expect(saved[0].latitude).toBeNull()
    expect(saved[0].longitude).toBeNull()
  })
})

describe('editing a branch that already has a location', () => {
  const located = branch({ latitude: 14.3294, longitude: 120.9367 })

  it('starts with the marker where the branch already is', () => {
    show(located)

    const shown = mapProps.at(-1)?.branches ?? []
    expect(shown).toHaveLength(1)
    expect(shown[0].latitude).toBe(14.3294)
    expect(shown[0].longitude).toBe(120.9367)
    expect(screen.getByText('Location pinned')).toBeTruthy()
    expect(screen.getByText('14.3294, 120.9367')).toBeTruthy()
  })

  it('moves it when somewhere else is clicked', () => {
    show(located)
    pin(14.5995, 120.9842)

    expect(screen.getByText('14.5995, 120.9842')).toBeTruthy()
    expect(mapProps.at(-1)?.branches[0].latitude).toBe(14.5995)
  })

  it('persists the adjusted position', () => {
    // Dragging the marker reports through the same callback a click does, so
    // this covers both routes to a new position.
    show(located)
    pin(14.331, 120.938)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(saved[0].latitude).toBe(14.331)
    expect(saved[0].longitude).toBe(120.938)
    expect(saved[0].id).toBe('b1')
  })

  it('reopens on the saved position', () => {
    // What the record holds is what the map is handed next time.
    const { unmount } = show(located)
    unmount()
    mapProps.length = 0

    show(branch({ latitude: 14.331, longitude: 120.938 }))
    expect(mapProps.at(-1)?.branches[0].latitude).toBe(14.331)
    expect(mapProps.at(-1)?.branches[0].longitude).toBe(120.938)
  })
})

describe('the map is the one that can pin', () => {
  it('is given a pick handler here, unlike the read-only maps elsewhere', () => {
    show()
    expect(mapProps.at(-1)?.onPick).toBeTypeOf('function')
  })
})
