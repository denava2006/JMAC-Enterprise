import * as React from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { cn } from '@/lib/utils'

/**
 * What the map needs to know about a branch, and no more.
 *
 * Declared here rather than importing the internal Branch type, so the public
 * landing page can pass rows from public_branch_locations without dragging the
 * back-office record -- and its operational columns -- into a public bundle.
 * The admin Branch type satisfies this structurally.
 */
export interface MappableBranch {
  id: string
  name: string
  address: string | null
  phone?: string | null
  latitude: number | null
  longitude: number | null
}

/**
 * Where the branches are.
 *
 * Display only, and deliberately inert: nothing here writes, and no operational
 * screen depends on it. A branch with no coordinates is not an error and not a
 * warning -- it stays in the table below and simply has no pin yet, which is
 * the honest rendering of "nobody has located it".
 *
 * Leaflet is imperative and owns its own DOM, so it is created once against a
 * ref and told about marker changes afterwards. Rendering markers as React
 * children would mean React and Leaflet both believing they own the same nodes.
 */

/**
 * Leaflet's default marker icon is referenced by a relative URL that assumes
 * the images sit next to the stylesheet. Bundled, they do not, and the marker
 * silently renders as a broken image. Drawing the pin as an inline SVG avoids
 * the asset question altogether and keeps it on the app's own accent colour.
 */
const PIN = L.divIcon({
  className: 'jmac-pin',
  html: `<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M13 0C5.82 0 0 5.82 0 13c0 9.2 11.6 20.2 12.1 20.6a1.3 1.3 0 0 0 1.8 0C14.4 33.2 26 22.2 26 13 26 5.82 20.18 0 13 0z"
          fill="currentColor"/>
    <circle cx="13" cy="12.7" r="4.8" fill="#fff"/>
  </svg>`,
  iconSize: [26, 34],
  iconAnchor: [13, 34],
  popupAnchor: [0, -30],
})

/**
 * Six decimal places is about a tenth of a metre, which is far finer than
 * anybody pinning a shopfront needs and well inside numeric(9,6) -- the column
 * would round anyway, and rounding here means the field shows what was stored.
 */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function popupHtml(branch: MappableBranch) {
  // Escaped by hand: a branch name is administrator-entered text going into an
  // innerHTML popup, and Leaflet does no escaping of its own.
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
    )

  const name = escape(branch.name)
  const address = branch.address ? `<p style="margin:2px 0 0">${escape(branch.address)}</p>` : ''
  const phone = branch.phone ? `<p style="margin:2px 0 0">${escape(branch.phone)}</p>` : ''
  const external =
    branch.latitude != null && branch.longitude != null
      ? `<a href="https://www.openstreetmap.org/?mlat=${branch.latitude}&mlon=${branch.longitude}#map=17/${branch.latitude}/${branch.longitude}"
            target="_blank" rel="noreferrer noopener"
            style="display:inline-block;margin-top:6px">Open in maps</a>`
      : ''

  return `<div style="font:inherit"><strong>${name}</strong>${address}${phone}${external}</div>`
}

/**
 * Two sizes, both fixed.
 *
 * The height is always a class on the container, never left to the content:
 * Leaflet fills whatever box it is given, and a box with no height of its own
 * grows until it owns the page.
 */
const HEIGHT = {
  /** The Branches page, where the map is the point of the section. */
  page: 'h-72 sm:h-96',
  /** Inside a dialog, where it sits between the branch details and the
   *  coordinate fields and must leave both of them on screen. */
  compact: 'h-[200px] sm:h-[260px]',
  /** The public landing page, where the map is a showpiece and has a whole
   *  section to itself -- taller than the dialog, shorter than the admin page
   *  it shares a screen with nothing else on. */
  public: 'h-[280px] sm:h-[400px]',
} as const

export function BranchMap({
  branches,
  variant = 'page',
  caption = true,
  onPick,
}: {
  branches: MappableBranch[]
  variant?: keyof typeof HEIGHT
  /** The page wants the "1 of 2 pinned" line; the dialog has its own copy. */
  caption?: boolean
  /**
   * Turns the map into the way a location is chosen: click to pin, drag to
   * adjust. Absent, the map stays exactly what it was -- a read-only display,
   * which is what both the Branches page and the public landing page want.
   */
  onPick?: (latitude: number, longitude: number) => void
}) {
  const holder = React.useRef<HTMLDivElement | null>(null)
  const map = React.useRef<L.Map | null>(null)
  const layer = React.useRef<L.LayerGroup | null>(null)

  // Leaflet handlers are registered once against a map that outlives every
  // render, so they would close over the first onPick for ever. The ref keeps
  // them calling the current one without re-registering anything.
  const pick = React.useRef(onPick)
  pick.current = onPick

  const located = React.useMemo(
    () => branches.filter((b) => b.latitude != null && b.longitude != null),
    [branches],
  )

  React.useEffect(() => {
    if (!holder.current || map.current) return

    map.current = L.map(holder.current, {
      // A map inside a page scrolls past; grabbing the wheel to zoom is the
      // behaviour people complain about. Ctrl+wheel and the buttons still zoom.
      scrollWheelZoom: false,
      attributionControl: true,
    }).setView([12.8797, 121.774], 5) // the Philippines, until there are pins

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map.current)

    layer.current = L.layerGroup().addTo(map.current)

    // Click anywhere to pin. Registered unconditionally and gated on the ref,
    // so a component that gains or loses onPick does not need the map rebuilt
    // underneath it.
    map.current.on('click', (e: L.LeafletMouseEvent) => {
      // Leaflet hands back whatever the projection produced, and dragging past
      // the antimeridian can put longitude outside -180..180. wrap() folds it
      // back, which matters because the database constraint refuses the rest.
      const { lat, lng } = e.latlng.wrap()
      pick.current?.(round6(lat), round6(lng))
    })

    // Leaflet measures its container once, on creation. Inside a dialog that
    // container is mid-animation and often still zero-height, so the tiles come
    // out grey or half-drawn and stay that way. Watching the element covers the
    // open animation, a viewport resize and the responsive height switch with
    // one mechanism, and needs no guessed timeout.
    const observer = new ResizeObserver(() => map.current?.invalidateSize())
    observer.observe(holder.current)

    return () => {
      observer.disconnect()
      map.current?.remove()
      map.current = null
      layer.current = null
    }
  }, [])

  React.useEffect(() => {
    if (!map.current || !layer.current) return
    layer.current.clearLayers()

    const pinnable = !!pick.current

    for (const branch of located) {
      const marker = L.marker([Number(branch.latitude), Number(branch.longitude)], {
        icon: PIN,
        title: branch.name,
        alt: branch.name,
        draggable: pinnable,
        // Touch devices need this to pick the marker up rather than pan the
        // map underneath it.
        autoPan: pinnable,
      })

      if (pinnable) {
        // Fine-tuning after the first click. dragend rather than drag: updating
        // on every frame would re-render the form sixty times a second, and the
        // number that matters is where the pin was let go.
        marker.on('dragend', () => {
          const { lat, lng } = marker.getLatLng().wrap()
          pick.current?.(round6(lat), round6(lng))
        })
      } else {
        // A popup on a draggable pin fights the drag: press-and-hold to move it
        // reads as a click and opens the bubble instead.
        marker.bindPopup(popupHtml(branch))
      }

      marker.addTo(layer.current)
    }

  }, [located])

  // Framing is keyed on the coordinates themselves, not on the array holding
  // them. In the branch dialog the preview list is rebuilt as somebody types
  // the name, and re-running this on every keystroke would yank the map back to
  // centre each time they touched an unrelated field.
  const frame = located.map((b) => `${b.latitude},${b.longitude}`).join('|')

  // In pick mode the map frames once and then leaves the view alone. Every
  // click and every drag changes the coordinates, and re-centring on each one
  // would yank the map out from under the person placing the pin -- clicking
  // at a wide zoom would snap to zoom 15 mid-gesture. Opening the dialog on an
  // existing branch still centres on where that branch already is, which is
  // the framing that was actually wanted.
  const framed = React.useRef(false)

  React.useEffect(() => {
    if (!map.current || located.length === 0) return
    if (pick.current && framed.current) return
    framed.current = true

    if (located.length === 1) {
      map.current.setView([Number(located[0].latitude), Number(located[0].longitude)], 15)
    } else {
      map.current.fitBounds(
        L.latLngBounds(located.map((b) => [Number(b.latitude), Number(b.longitude)] as [number, number])),
        { padding: [40, 40], maxZoom: 15 },
      )
    }
    // located is deliberately absent: `frame` is its coordinate content, and
    // depending on both would reinstate the behaviour this avoids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame])

  const unlocated = branches.length - located.length

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={holder}
        role="region"
        aria-label="Branch locations"
        className={cn(
          'w-full overflow-hidden rounded-lg border border-border bg-muted text-accent',
          HEIGHT[variant],
          // The important class. Leaflet gives its internal panes z-index 400
          // to 1000 -- tile pane, markers, popups, controls -- while the dialog
          // sits at z-50. Without a stacking context of its own the map paints
          // straight through an open modal and over the form, which looks like
          // the map has escaped its box when in fact it never left it.
          //
          // `isolate` makes this element a stacking context, so all of those
          // numbers are resolved against each other inside this box and none of
          // them can compete with anything outside it.
          'isolate relative z-0',
          // Says the map is something you act on, before anybody clicks to
          // find out.
          onPick && '[&_.leaflet-container]:cursor-crosshair',
        )}
      />
      {caption && (
        <p className="text-xs text-muted-foreground">
          {located.length === 0
            ? 'No branch has coordinates yet. Add a latitude and longitude to a branch to pin it here.'
            : unlocated > 0
              ? `${located.length} of ${branches.length} branches pinned. The rest are listed below and appear here once their coordinates are set.`
              : `All ${located.length} branches pinned. Scroll-zoom is off; use the buttons or Ctrl and the wheel.`}
        </p>
      )}
    </div>
  )
}
