import * as React from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Branch } from '@/hooks/useBranches'

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

export function BranchMap({ branches }: { branches: Branch[] }) {
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

    return () => {
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

    if (located.length === 1) {
      map.current.setView([Number(located[0].latitude), Number(located[0].longitude)], 15)
    } else if (located.length > 1) {
      map.current.fitBounds(
        L.latLngBounds(located.map((b) => [Number(b.latitude), Number(b.longitude)] as [number, number])),
        { padding: [40, 40], maxZoom: 15 },
      )
    }
  }, [located])

  const unlocated = branches.length - located.length

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={holder}
        role="region"
        aria-label="Branch locations"
        className="h-72 w-full overflow-hidden rounded-lg border border-border bg-muted text-accent sm:h-96"
      />
      <p className="text-xs text-muted-foreground">
        {located.length === 0
          ? 'No branch has coordinates yet. Add a latitude and longitude to a branch to pin it here.'
          : unlocated > 0
            ? `${located.length} of ${branches.length} branches pinned. The rest are listed below and appear here once their coordinates are set.`
            : `All ${located.length} branches pinned. Scroll-zoom is off; use the buttons or Ctrl and the wheel.`}
      </p>
    </div>
  )
}
