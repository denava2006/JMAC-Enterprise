import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { PublicBranch } from '@/hooks/usePublicBranches'

/**
 * The public branch explorer.
 *
 * Two claims carry this section. The first is that there is ONE source: the
 * photograph, the identity, the counter and the map are all fed by the same
 * query and the same selection, so no branch can appear on one and be missing
 * from the other -- which is exactly what the cards-plus-map arrangement this
 * replaced produced, and the disagreeing half was always the one nobody looked
 * at. The second is that nothing here is typed into this file: a branch the back
 * office publishes appears without a code change.
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

/** What BranchMap was handed, and the handle to drive it back. The map itself
 *  is covered by its own tests; this records the conversation. */
interface MapCall {
  branches: PublicBranch[]
  variant?: string
  selectedId?: string | null
  onSelect?: (id: string) => void
}
const mapProps: MapCall[] = []

vi.mock('@/hooks/usePublicBranches', () => ({
  usePublicBranches: () => ({
    data: state.branches,
    isLoading: state.isLoading,
    isError: state.isError,
  }),
  // branch-images is the one public bucket, so the URL is derived rather than
  // signed. The shape is what matters here, not the host.
  branchImageUrl: (path: string | null | undefined) =>
    path ? `https://cdn.test/branch-images/${path}` : null,
}))

vi.mock('@/components/admin/BranchMap', () => ({
  BranchMap: (props: MapCall) => {
    mapProps.push(props)
    return (
      <div data-testid="branch-map" data-selected={props.selectedId ?? ''}>
        {props.branches.map((b) => (
          <button
            key={b.id}
            type="button"
            data-testid={`pin-${b.id}`}
            onClick={() => props.onSelect?.(b.id)}
          >
            {b.name}
          </button>
        ))}
      </div>
    )
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
    image_path: 'cavite.webp',
    display_order: 0,
    ...over,
  }
}

const MAIN = branch({
  id: 'b2',
  name: 'Main Office',
  address: 'Makati City',
  latitude: 14.5547,
  longitude: 121.0244,
  image_path: 'main.webp',
  display_order: 1,
})

function show() {
  return render(
    <MemoryRouter>
      <BranchShowcase />
    </MemoryRouter>,
  )
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next location' }))
const previous = () => fireEvent.click(screen.getByRole('button', { name: 'Previous location' }))
const photo = () => screen.getByRole('img') as HTMLImageElement
/** The counter is split across elements -- the position is emphasised inside
 *  the line -- so it is read off the live region rather than matched whole. */
const counter = () =>
  (document.querySelector('[aria-live="polite"]')?.textContent ?? '').replace(/\s+/g, ' ')

afterEach(() => {
  cleanup()
  state.branches = []
  state.isLoading = false
  state.isError = false
  mapProps.length = 0
})

describe('what the section shows first', () => {
  it('opens on the first published branch, with its photograph, name and address', () => {
    state.branches = [branch(), MAIN]
    show()

    expect(photo().src).toContain('cavite.webp')
    expect(photo().alt).toBe('Cavite Branch location')
    expect(screen.getByRole('heading', { name: 'Cavite Branch' })).toBeTruthy()
    expect(screen.getByText('Aguinaldo Highway, Dasmariñas, Cavite')).toBeTruthy()
  })

  it('gives the map every published branch, not only the selected one', () => {
    // The spread is the point of the section. One pin would say nothing.
    state.branches = [branch(), MAIN]
    show()
    expect(mapProps.at(-1)?.branches).toEqual(state.branches)
    expect(screen.getByTestId('pin-b1')).toBeTruthy()
    expect(screen.getByTestId('pin-b2')).toBeTruthy()
  })

  it('tells the map which branch is selected, so it can emphasise that pin', () => {
    state.branches = [branch(), MAIN]
    show()
    expect(mapProps.at(-1)?.selectedId).toBe('b1')
  })

  it('counts the locations', () => {
    state.branches = [branch(), MAIN]
    show()
    expect(counter()).toBe('01 / 02 locations')
  })

  it('names no branch of its own', () => {
    // Nothing is typed into this file. A branch published in the back office
    // arrives here with no code change, which is the whole architecture.
    state.branches = [branch({ name: 'Batangas Branch', address: 'Lipa City' })]
    const { container } = show()
    expect(container.textContent).toContain('Batangas Branch')
    expect(container.textContent).not.toContain('Cavite')
  })
})

describe('one selection, and everything downstream of it', () => {
  it('moves photograph, identity, counter and map together on Next', () => {
    state.branches = [branch(), MAIN]
    show()
    next()

    expect(photo().src).toContain('main.webp')
    expect(screen.getByRole('heading', { name: 'Main Office' })).toBeTruthy()
    expect(screen.getByText('Makati City')).toBeTruthy()
    expect(counter()).toBe('02 / 02 locations')
    expect(mapProps.at(-1)?.selectedId).toBe('b2')
  })

  it('moves them all back together on Previous', () => {
    state.branches = [branch(), MAIN]
    show()
    next()
    previous()

    expect(photo().src).toContain('cavite.webp')
    expect(screen.getByRole('heading', { name: 'Cavite Branch' })).toBeTruthy()
    expect(mapProps.at(-1)?.selectedId).toBe('b1')
  })

  it('wraps at both ends rather than dead-ending', () => {
    state.branches = [branch(), MAIN]
    show()

    previous()
    expect(screen.getByRole('heading', { name: 'Main Office' })).toBeTruthy()
    next()
    expect(screen.getByRole('heading', { name: 'Cavite Branch' })).toBeTruthy()
  })

  it('selects from the map too -- the pin is an input, not just a picture', () => {
    state.branches = [branch(), MAIN]
    show()

    fireEvent.click(screen.getByTestId('pin-b2'))

    expect(screen.getByRole('heading', { name: 'Main Office' })).toBeTruthy()
    expect(photo().src).toContain('main.webp')
    expect(counter()).toBe('02 / 02 locations')
    expect(mapProps.at(-1)?.selectedId).toBe('b2')
  })

  it('jumps straight to a location from the progress rule', () => {
    state.branches = [branch(), MAIN]
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Show Main Office' }))
    expect(screen.getByRole('heading', { name: 'Main Office' })).toBeTruthy()
  })
})

describe('moving between locations', () => {
  /**
   * The section used to swap instantly, and the fade meant to soften it never
   * ran: the class named a `fade-in` keyframe that did not exist anywhere, so
   * the browser applied an animation with nothing to animate. These pin the
   * real keyframes by name -- a rename or a deletion fails here rather than
   * silently going back to an abrupt cut.
   */
  const identity = () => screen.getByRole('heading', { level: 3 }).parentElement!

  it('enters from the right when moving forward', () => {
    state.branches = [branch(), MAIN]
    show()
    next()
    expect(identity().className).toContain('animate-[branch-in-next_240ms_ease-out]')
  })

  it('enters from the left when moving back', () => {
    state.branches = [branch(), MAIN]
    show()
    previous()
    expect(identity().className).toContain('animate-[branch-in-previous_240ms_ease-out]')
  })

  it('uses a neutral fade for a map pin, which has no direction', () => {
    state.branches = [branch(), MAIN]
    show()
    fireEvent.click(screen.getByTestId('pin-b2'))
    expect(identity().className).toContain('animate-[branch-in_200ms_ease-out]')
  })

  it('uses the neutral fade from the progress rule too', () => {
    state.branches = [branch(), MAIN]
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Show Main Office' }))
    expect(identity().className).toContain('animate-[branch-in_200ms_ease-out]')
  })

  it('gates every entrance behind motion-safe', () => {
    state.branches = [branch(), MAIN]
    show()
    next()
    // A visitor who asked for reduced motion gets the swap and no animation.
    expect(identity().className).toContain('motion-safe:animate-[')
  })

  it('holds the previous photograph until the next one has decoded', () => {
    // The flash this prevents: keying an <img> on its src unmounts the old one
    // and mounts a new one with nothing to paint, so the panel blinks to its
    // background mid-transition.
    state.branches = [branch(), MAIN]
    const { container } = show()
    fireEvent.load(photo())

    next()
    const layers = container.querySelectorAll('img')
    expect(layers).toHaveLength(2)
    // The outgoing one is the old branch, still painted, and hidden from
    // assistive tech because the incoming image already describes the place.
    const underlay = container.querySelector('img[aria-hidden="true"]') as HTMLImageElement
    expect(underlay.src).toContain('cavite.webp')
    expect(underlay.alt).toBe('')
  })

  it('drops the held photograph once the new one is painted', () => {
    state.branches = [branch(), MAIN]
    const { container } = show()
    fireEvent.load(photo())
    next()
    fireEvent.load(photo())

    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(photo().className).toContain('opacity-100')
  })

  it('survives a visitor clicking faster than the images load', () => {
    state.branches = [branch(), MAIN, branch({ id: 'b3', name: 'Batangas Branch', image_path: 'bat.webp' })]
    show()

    next()
    next()
    next()

    // Three forward from the first of three lands back on the first, and the
    // identity, the photograph and the counter all agree about it.
    expect(screen.getByRole('heading', { name: 'Cavite Branch' })).toBeTruthy()
    expect(photo().src).toContain('cavite.webp')
    expect(counter()).toBe('01 / 03 locations')
    expect(mapProps.at(-1)?.selectedId).toBe('b1')
  })

  it('does not animate the map away and back -- it is never remounted', () => {
    // One map instance for the life of the section. A remount would flash grey
    // tiles on every arrow press, which is the opposite of coordinated.
    state.branches = [branch(), MAIN]
    const { container } = show()
    const before = container.querySelector('[data-testid="branch-map"]')
    next()
    expect(container.querySelector('[data-testid="branch-map"]')).toBe(before)
  })
})

describe('one location, and none', () => {
  it('shows no arrows or counter for a single branch', () => {
    // Navigation for a set of one is furniture that does nothing.
    state.branches = [branch()]
    show()

    expect(screen.queryByRole('button', { name: 'Next location' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Previous location' })).toBeNull()
    expect(screen.queryByText(/locations/)).toBeNull()
    // The branch itself is still fully shown.
    expect(screen.getByRole('heading', { name: 'Cavite Branch' })).toBeTruthy()
    expect(screen.getByTestId('branch-map')).toBeTruthy()
  })

  it('shows navigation as soon as there are two', () => {
    state.branches = [branch(), MAIN]
    show()
    expect(screen.getByRole('button', { name: 'Next location' })).toBeTruthy()
  })

  it('renders nothing at all when no branch is published', () => {
    // Not 0 / 0, not an empty map, not broken arrows. The section has no
    // subject, so it does not occupy a screen saying so.
    state.branches = []
    const { container } = show()
    expect(container.textContent).toBe('')
  })
})

describe('robustness', () => {
  it('uses a deliberate fallback when a branch has no photograph', () => {
    state.branches = [branch({ image_path: null })]
    show()

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('JMAC')).toBeTruthy()
    expect(screen.getByText(/photograph to follow/)).toBeTruthy()
  })

  it('still shows a branch that nobody has pinned yet', () => {
    // No coordinates is not an error. The address is the thing a visitor
    // actually needs, and it is still there.
    state.branches = [branch({ latitude: null, longitude: null }), MAIN]
    show()

    expect(screen.getByRole('heading', { name: 'Cavite Branch' })).toBeTruthy()
    expect(screen.getByText('Aguinaldo Highway, Dasmariñas, Cavite')).toBeTruthy()
    expect(screen.getByTestId('branch-map')).toBeTruthy()
  })

  it('says something sensible when a branch has no address', () => {
    state.branches = [branch({ address: null })]
    show()
    expect(screen.getByText('Address available on request.')).toBeTruthy()
  })

  it('shows a skeleton while loading, not a fake branch', () => {
    state.isLoading = true
    const { container } = show()
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('fails without showing a visitor a database error', () => {
    state.isError = true
    const { container } = show()

    expect(screen.getByText('Our locations are temporarily unavailable.')).toBeTruthy()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/supabase|postgres|PGRST|relation|permission denied/i)
  })
})

describe('what the section can and cannot know', () => {
  it('reads the public view, never the branches table', () => {
    // Asserted on the type it consumes: PublicBranch is the view's shape, and
    // an operational column has no field here to be rendered from.
    state.branches = [branch(), MAIN]
    const { container } = show()
    const text = container.textContent ?? ''

    for (const leak of ['is_active', 'phone', 'manager', 'created_at', 'b1', 'b2']) {
      expect(text).not.toContain(leak)
    }
  })

  it('renders no internal identifier anywhere', () => {
    state.branches = [branch({ id: 'de305d54-75b4-431b-adb2-eb6b9e546014' })]
    const { container } = show()
    // textContent, not innerHTML: the map here is a stub that puts ids in
    // data-testid so the test can click a pin. The real map renders none.
    expect(container.textContent).not.toContain('de305d54')
  })
})

describe('reachable without a mouse', () => {
  it('names both arrows for a screen reader', () => {
    state.branches = [branch(), MAIN]
    show()
    expect(screen.getByRole('button', { name: 'Previous location' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next location' })).toBeTruthy()
  })

  it('gives every progress control a name and marks the current one', () => {
    state.branches = [branch(), MAIN]
    show()

    const current = screen.getByRole('button', { name: 'Show Cavite Branch' })
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(
      screen.getByRole('button', { name: 'Show Main Office' }).getAttribute('aria-current'),
    ).toBeNull()
  })

  it('announces the position as it changes', () => {
    state.branches = [branch(), MAIN]
    const { container } = show()
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toMatch(/01/)
  })

  it('keeps focus visible on every control', () => {
    state.branches = [branch(), MAIN]
    show()
    for (const name of ['Previous location', 'Next location', 'Show Main Office']) {
      expect(screen.getByRole('button', { name }).className).toMatch(/focus-visible:ring/)
    }
  })
})
