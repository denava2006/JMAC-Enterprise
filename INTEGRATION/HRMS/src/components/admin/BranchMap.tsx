import * as React from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Branch } from '@/hooks/useBranches'
import { cn } from '@/lib/utils'

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

function popupHtml(branch: Branch) {
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
} as const

export function BranchMap({
  branches,
  variant = 'page',
  caption = true,
}: {
  branches: Branch[]
  variant?: keyof typeof HEIGHT
  /** The page wants the "1 of 2 pinned" line; the dialog has its own copy. */
  caption?: boolean
}) {
  const holder = React.useRef<HTMLDivElement | null>(null)
  const map = React.useRef<L.Map | null>(null)
  const layer = React.useRef<L.LayerGroup | null>(null)

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

    for (const branch of located) {
      L.marker([Number(branch.latitude), Number(branch.longitude)], {
        icon: PIN,
        title: branch.name,
        alt: branch.name,
      })
        .bindPopup(popupHtml(branch))
        .addTo(layer.current)
    }

  }, [located])

  // Framing is keyed on the coordinates themselves, not on the array holding
  // them. In the branch dialog the preview list is rebuilt as somebody types
  // the name, and re-running this on every keystroke would yank the map back to
  // centre each time they touched an unrelated field.
  const frame = located.map((b) => `${b.latitude},${b.longitude}`).join('|')

  React.useEffect(() => {
    if (!map.current || located.length === 0) return

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
