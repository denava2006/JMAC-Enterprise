import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Branch } from '@/hooks/useBranches'

/**
 * The branch map.
 *
 * The claim worth holding is a negative one: this is display, and a branch
 * nobody has located is not a problem. It stays in the list, it simply has no
 * pin — and nothing operational reads a coordinate at all.
 *
 * Leaflet is mocked. Asserting that a real tile layer rendered would be testing
 * Leaflet; what is ours is which branches become markers and what the page says
 * about the ones that do not.
 */

const markers: Array<{
  at: [number, number]
  title: string
  popup: string
  draggable: boolean
  /** Moves the marker and fires dragend, the way a person would. */
  dragTo: (lat: number, lng: number) => void
}> = []
const views: Array<string> = []

/** Map-level handlers, so a test can click the map the way Leaflet would. */
const mapHandlers: Record<string, (e: unknown) => void> = {}

/** A click at a point, as Leaflet delivers it: a LatLng with .wrap(). */
function clickMap(lat: number, lng: number) {
  mapHandlers.click?.({ latlng: { lat, lng, wrap: () => ({ lat, lng }) } })
}

// jsdom has no ResizeObserver. The component uses one to call invalidateSize
// when its container is measured -- which is what makes the map draw correctly
// inside a dialog that animates open -- so the environment gets a stub rather
// than the component getting a guard for a browser API every target has.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', StubResizeObserver)

vi.mock('leaflet', () => {
  const marker = (at: [number, number], opts: { title: string; draggable?: boolean }) => {
    let position = { lat: at[0], lng: at[1] }
    const handlers: Record<string, () => void> = {}

    const entry = {
      at,
      title: opts.title,
      popup: '',
      draggable: !!opts.draggable,
      dragTo(lat: number, lng: number) {
        position = { lat, lng }
        handlers.dragend?.()
      },
    }

    const m = {
      bindPopup(html: string) {
        entry.popup = html
        return m
      },
      on(event: string, fn: () => void) {
        handlers[event] = fn
        return m
      },
      getLatLng: () => ({ ...position, wrap: () => position }),
      addTo() {
        markers.push(entry)
        return m
      },
    }
    return m
  }
  const layerGroup = () => ({
    clearLayers: () => markers.splice(0, markers.length),
    addTo() {
      return this
    },
  })
  return {
    default: {
      map: () => ({
        setView(at: [number, number], zoom: number) {
          views.push(`setView ${at[0]},${at[1]} @${zoom}`)
          return this
        },
        fitBounds() {
          views.push('fitBounds')
          return this
        },
        on(event: string, fn: (e: unknown) => void) {
          mapHandlers[event] = fn
          return this
        },
        invalidateSize() {},
        remove() {},
      }),
      tileLayer: () => ({ addTo() {} }),
      layerGroup,
      marker,
      divIcon: (o: unknown) => o,
      latLngBounds: (v: unknown) => v,
    },
  }
})

vi.mock('leaflet/dist/leaflet.css', () => ({}))

const { BranchMap } = await import('@/components/admin/BranchMap')

function branch(over: Partial<Branch> = {}): Branch {
  return {
    id: 'b1',
    name: 'Cavite Branch',
    address: 'Imus, Cavite',
    phone: null,
    latitude: null,
    longitude: null,
    is_active: true,
    created_at: '',
    updated_at: '',
    ...over,
  }
}

afterEach(() => {
  cleanup()
  markers.length = 0
  views.length = 0
  for (const k of Object.keys(mapHandlers)) delete mapHandlers[k]
})

describe('which branches get a pin', () => {
  it('pins a branch that has coordinates', () => {
    render(<BranchMap branches={[branch({ latitude: 14.4791, longitude: 120.897 })]} />)
    expect(markers).toHaveLength(1)
    expect(markers[0].at).toEqual([14.4791, 120.897])
    expect(markers[0].title).toBe('Cavite Branch')
  })

  it('leaves an unlocated branch off the map without complaining about it', () => {
    render(<BranchMap branches={[branch()]} />)
    expect(markers).toHaveLength(0)
    // Not an error and not a warning: it is a branch nobody has located yet.
    expect(screen.getByText(/No branch has coordinates yet/)).toBeTruthy()
  })

  it('says how many are pinned when only some are', () => {
    render(
      <BranchMap
        branches={[
          branch({ id: 'b1', latitude: 14.4791, longitude: 120.897 }),
          branch({ id: 'b2', name: 'Main Office' }),
        ]}
      />,
    )
    expect(markers).toHaveLength(1)
    expect(screen.getByText(/1 of 2 branches pinned/)).toBeTruthy()
  })

  it('ignores a half-set pair rather than pinning it at zero', () => {
    // Every (0, 0) ends up in the sea off west Africa. The database refuses a
    // half-set pair too, so this is belt and braces.
    render(<BranchMap branches={[branch({ latitude: 14.4791, longitude: null })]} />)
    expect(markers).toHaveLength(0)
  })
})

describe('what a pin says', () => {
  it('carries the name and address into the popup', () => {
    render(<BranchMap branches={[branch({ latitude: 14.4791, longitude: 120.897 })]} />)
    expect(markers[0].popup).toContain('Cavite Branch')
    expect(markers[0].popup).toContain('Imus, Cavite')
  })

  it('offers an external map link for the pinned point', () => {
    render(<BranchMap branches={[branch({ latitude: 14.4791, longitude: 120.897 })]} />)
    expect(markers[0].popup).toContain('Open in maps')
    expect(markers[0].popup).toContain('mlat=14.4791')
  })

  it('escapes a branch name rather than trusting it into innerHTML', () => {
    render(
      <BranchMap
        branches={[
          branch({ name: '<img src=x onerror=alert(1)>', latitude: 1, longitude: 2, address: null }),
        ]}
      />,
    )
    expect(markers[0].popup).not.toContain('<img')
    expect(markers[0].popup).toContain('&lt;img')
  })

  it('omits the address line when there is no address', () => {
    render(<BranchMap branches={[branch({ address: null, latitude: 1, longitude: 2 })]} />)
    expect(markers[0].popup).not.toContain('undefined')
    expect(markers[0].popup).not.toContain('null')
  })
})

describe('framing', () => {
  it('zooms to the single branch when only one is located', () => {
    render(<BranchMap branches={[branch({ latitude: 14.4791, longitude: 120.897 })]} />)
    expect(views.some((v) => v.startsWith('setView 14.4791,120.897'))).toBe(true)
  })

  it('fits all of them when several are located', () => {
    render(
      <BranchMap
        branches={[
          branch({ id: 'b1', latitude: 14.4791, longitude: 120.897 }),
          branch({ id: 'b2', name: 'Main Office', latitude: 14.5995, longitude: 120.9842 }),
        ]}
      />,
    )
    expect(views).toContain('fitBounds')
  })
})

describe('staying inside its box', () => {
  function container() {
    return screen.getByRole('region', { name: 'Branch locations' })
  }

  it('creates its own stacking context so it cannot paint over a modal', () => {
    // The bug this fixes: Leaflet gives its panes z-index 400-1000 while the
    // dialog sits at z-50, so an open modal had the map drawn straight over the
    // top of it. `isolate` resolves those numbers inside this element instead.
    render(<BranchMap branches={[branch({ latitude: 1, longitude: 2 })]} />)
    expect(container().className).toContain('isolate')
    expect(container().className).toContain('z-0')
  })

  it('clips anything Leaflet draws past its edges', () => {
    render(<BranchMap branches={[branch()]} />)
    expect(container().className).toContain('overflow-hidden')
    expect(container().className).toContain('w-full')
    expect(container().className).toContain('rounded-lg')
  })

  it('takes a fixed height rather than growing to fit its content', () => {
    render(<BranchMap branches={[branch()]} />)
    // Page variant: tall, because the map is the point of that section.
    expect(container().className).toMatch(/\bh-72\b/)
    expect(container().className).toMatch(/sm:h-96/)
  })

  it('uses a compact height in a dialog, on both viewports', () => {
    // 200px on a phone and 260px above sm — inside the 180-220 / 240-280
    // targets, and short enough to leave the coordinate fields and the footer
    // buttons on screen underneath.
    render(<BranchMap branches={[branch()]} variant="compact" />)
    expect(container().className).toContain('h-[200px]')
    expect(container().className).toContain('sm:h-[260px]')
    expect(container().className).not.toMatch(/\bh-72\b/)
  })

  it('drops the page caption where the dialog supplies its own', () => {
    render(<BranchMap branches={[branch()]} variant="compact" caption={false} />)
    expect(screen.queryByText(/No branch has coordinates yet/)).toBeNull()
  })
})

describe('pinning a location on the map', () => {
  it('reports where somebody clicked, so nothing has to be typed', () => {
    const picked: Array<[number, number]> = []
    render(<BranchMap branches={[]} onPick={(lat, lng) => picked.push([lat, lng])} />)

    clickMap(14.3294, 120.9367)
    expect(picked).toEqual([[14.3294, 120.9367]])
  })

  it('reports the second click too, so the pin can be moved', () => {
    const picked: Array<[number, number]> = []
    render(<BranchMap branches={[]} onPick={(lat, lng) => picked.push([lat, lng])} />)

    clickMap(14.3294, 120.9367)
    clickMap(14.5995, 120.9842)
    expect(picked).toHaveLength(2)
    expect(picked[1]).toEqual([14.5995, 120.9842])
  })

  it('rounds to six places, which is what the column stores', () => {
    // numeric(9,6) would round anyway; doing it here means the field shows the
    // number that was actually saved rather than one that differs in the tail.
    const picked: Array<[number, number]> = []
    render(<BranchMap branches={[]} onPick={(lat, lng) => picked.push([lat, lng])} />)

    clickMap(14.32941234567, 120.93671234567)
    expect(picked[0]).toEqual([14.329412, 120.936712])
  })

  it('makes the marker draggable, and reports where it was dropped', () => {
    const picked: Array<[number, number]> = []
    render(
      <BranchMap
        branches={[branch({ latitude: 14.3294, longitude: 120.9367 })]}
        onPick={(lat, lng) => picked.push([lat, lng])}
      />,
    )

    expect(markers[0].draggable).toBe(true)
    markers[0].dragTo(14.331, 120.938)
    expect(picked).toEqual([[14.331, 120.938]])
  })

  it('leaves the map read-only when nothing is being picked', () => {
    // The Branches page and the public landing page both render this, and
    // neither should let a visitor drag a branch somewhere else.
    render(<BranchMap branches={[branch({ latitude: 14.3294, longitude: 120.9367 })]} />)
    expect(markers[0].draggable).toBe(false)

    // And a click reports nothing, because there is nobody to report it to.
    expect(() => clickMap(1, 2)).not.toThrow()
  })

  it('gives a draggable pin no popup to fight the drag with', () => {
    // Press-and-hold to move a marker reads as a click, so a bound popup opens
    // instead of the drag starting.
    render(
      <BranchMap
        branches={[branch({ latitude: 14.3294, longitude: 120.9367 })]}
        onPick={() => {}}
      />,
    )
    expect(markers[0].popup).toBe('')
  })

  it('shows the crosshair only where the map can be pinned', () => {
    const { unmount } = render(<BranchMap branches={[]} onPick={() => {}} />)
    expect(screen.getByRole('region', { name: 'Branch locations' }).className).toContain(
      'cursor-crosshair',
    )
    unmount()

    render(<BranchMap branches={[]} />)
    expect(screen.getByRole('region', { name: 'Branch locations' }).className).not.toContain(
      'cursor-crosshair',
    )
  })
})

describe('framing while pinning', () => {
  it('centres on a branch that already has a location', () => {
    // Opening Edit Branch should show where the branch is, not the whole country.
    render(
      <BranchMap
        branches={[branch({ latitude: 14.3294, longitude: 120.9367 })]}
        onPick={() => {}}
      />,
    )
    expect(views.some((v) => v.startsWith('setView 14.3294,120.9367'))).toBe(true)
  })

  it('does not yank the view back on every click', () => {
    // Re-centring mid-gesture is the thing that makes a pinnable map unusable:
    // clicking at a wide zoom would snap to zoom 15 under the cursor.
    const { rerender } = render(<BranchMap branches={[]} onPick={() => {}} />)

    rerender(
      <BranchMap
        branches={[branch({ latitude: 14.3294, longitude: 120.9367 })]}
        onPick={() => {}}
      />,
    )
    const afterFirst = views.length

    rerender(
      <BranchMap
        branches={[branch({ latitude: 14.5995, longitude: 120.9842 })]}
        onPick={() => {}}
      />,
    )
    expect(views).toHaveLength(afterFirst)
  })

  it('still re-frames a read-only map when its branches change', () => {
    // The public map has no pinning and should follow its data.
    const { rerender } = render(
      <BranchMap branches={[branch({ latitude: 14.3294, longitude: 120.9367 })]} />,
    )
    const afterFirst = views.length
    rerender(<BranchMap branches={[branch({ latitude: 14.5995, longitude: 120.9842 })]} />)
    expect(views.length).toBeGreaterThan(afterFirst)
  })
})
