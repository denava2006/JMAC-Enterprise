import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The public landing page, and where its one photograph lives.
 *
 * The building opens the page rather than closing it, and it is now the branded
 * shot: JMAC ENTERPRISE is mounted on the facade, which is the reason the asset
 * changed. Four things are worth pinning: it is in the hero, it stays decorative
 * — a CSS background, invisible to a screen reader — it appears exactly once,
 * and it is cropped and lit so the signage survives.
 *
 * The copy claim matters too: JMAC runs branches and employs people. It does
 * not sell software, and nothing on this page should read as though it does.
 */

// jsdom implements neither observer, and the page's scroll reveals want both.
// The stub reports nothing, which leaves elements in their initial state —
// present in the tree, which is all these assertions read.
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
// PublicLayout scrolls to the top on navigation, and jsdom implements no
// scrolling at all — left alone it prints a Not implemented error that reads
// like a real one.
vi.stubGlobal('scrollTo', () => {})

vi.mock('@/hooks/usePublicCareers', () => ({
  usePublicOpenJobPostings: () => ({ data: [], isLoading: false, isError: false }),
}))

vi.mock('@/hooks/usePublicBranches', () => ({
  usePublicBranches: () => ({ data: [], isLoading: false, isError: false }),
}))

import HomePage from '@/pages/public/HomePage'
import { PublicLayout } from '@/layouts/PublicLayout'

function show() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  )
}

// The hero is the first section on the page, and the only one the building
// belongs to.
function hero(container: HTMLElement) {
  return container.querySelector('section') as HTMLElement
}

function styleAttributes(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLElement>('[style]')).map(
    (el) => el.getAttribute('style') ?? ''
  )
}

afterEach(cleanup)

describe('the hero', () => {
  it('keeps the two links the public needs, pointing where they should', () => {
    const { container } = show()
    const careers = screen.getAllByRole('link', { name: /Explore Careers/i })
    const login = screen.getAllByRole('link', { name: /Employee Login/i })
    expect(careers.length).toBeGreaterThan(0)
    expect(login.length).toBeGreaterThan(0)
    for (const link of careers) expect(link.getAttribute('href')).toBe('/careers')
    for (const link of login) expect(link.getAttribute('href')).toBe('/login')
    // Both of them open the page rather than closing it.
    for (const link of [...careers, ...login]) expect(hero(container).contains(link)).toBe(true)
  })

  it('renders both actions as real links, so the keyboard reaches them', () => {
    show()
    // asChild renders an anchor, not a button with an onClick — focus and
    // right-click both behave the way a link should.
    for (const name of [/Explore Careers/i, /Employee Login/i]) {
      for (const el of screen.getAllByRole('link', { name })) {
        expect(el.tagName).toBe('A')
      }
    }
  })

  it('sets the text to the left of the frame, not centred over the glass', () => {
    const { container } = show()
    const column = hero(container).querySelector('[class*="items-start"][class*="text-left"]')
    expect(column).toBeTruthy()
  })
})

/**
 * jsdom does no layout, so these read intent from the classes rather than
 * measuring boxes. That is enough to catch the two ways this breaks: the
 * subtraction drifting away from the header's real height, and the minimum
 * hardening into a fixed height that would clip the rail on a short laptop.
 */
describe('the hero fills the first screen', () => {
  it('subtracts exactly the height the sticky header takes', () => {
    const { container } = show()
    expect(hero(container).className).toContain('sm:min-h-[calc(100svh-65px)]')
  })

  it('is measured against the header this site actually renders', () => {
    // 65px is h-16 plus the header's bottom border. The header is sticky, not
    // fixed, so it really does take that out of the first screen — and if it
    // ever stops being 64+1, the hero's subtraction has to move with it.
    const { container } = render(
      <MemoryRouter>
        <PublicLayout />
      </MemoryRouter>
    )
    const header = container.querySelector('header') as HTMLElement
    expect(header.className).toContain('sticky')
    expect(header.className).toContain('border-b')
    expect(header.querySelector('[class*="h-16"]')).toBeTruthy()
  })

  it('leaves the phone content-driven', () => {
    const { container } = show()
    // The rule is sm-and-up only. An unprefixed min-h would force a full screen
    // on a phone, where the copy should simply take the room it needs.
    expect(hero(container).className).not.toMatch(/(^|\s)min-h-\[/)
  })

  it('grows rather than clips when the content needs more room', () => {
    const { container } = show()
    // A minimum, never a height, and never h-screen.
    expect(hero(container).className).not.toMatch(/(^|:)h-screen/)
    expect(hero(container).className).not.toMatch(/(^|:)h-\[calc/)
  })

  it('spends the extra height between the copy and the rail, not on padding', () => {
    const { container } = show()
    const inner = hero(container).querySelector('[class*="justify-between"]') as HTMLElement
    expect(inner).toBeTruthy()
    expect(inner.className).toContain('flex-1')
    // The rail's old top margin became the container's gap, so justify-between
    // has something to distribute around rather than fight.
    expect(inner.className).toContain('gap-14')
  })
})

describe('the building image', () => {
  it('is a background, not content — nothing announces it', () => {
    const { container } = show()
    // No <img> was added for it, and every decorative layer is hidden from
    // the accessibility tree.
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('src') ?? '').not.toMatch(/jmac-enterprise-building/)
    }
    const layers = hero(container).querySelectorAll('[aria-hidden="true"]')
    expect(layers.length).toBeGreaterThanOrEqual(3)
  })

  it('sits behind an overlay rather than under bare text', () => {
    const { container } = show()
    const styles = styleAttributes(hero(container))
    // One layer carries the photograph, and at least one more carries a
    // gradient over it.
    expect(styles.some((s) => s.includes('url('))).toBe(true)
    expect(styles.some((s) => s.includes('linear-gradient'))).toBe(true)
  })

  it('is anchored to keep the building signage in frame', () => {
    const { container } = show()
    // The JMAC ENTERPRISE sign sits at roughly 68-78% across the photograph,
    // which is the whole reason this asset replaced the last one. These two
    // anchors are what keep it inside the crop: 72% once the viewport is wide
    // enough to show nearly the whole image, 80% below that, where the crop
    // eats the left and the sign has to stay near the middle of what is left.
    const layer = hero(container).querySelector('[class*="background-position"]') as HTMLElement
    expect(layer).toBeTruthy()
    expect(layer.className).toContain('[background-position:80%_center]')
    expect(layer.className).toContain('lg:[background-position:72%_center]')
    expect(layer.className).toContain('bg-cover')
    expect(layer.className).toContain('bg-no-repeat')
  })

  it('appears exactly once on the page', () => {
    const { container } = show()
    const carriers = styleAttributes(container).filter((s) => s.includes('jmac-enterprise-building'))
    expect(carriers.length).toBe(1)
    // And it is the hero that carries it.
    expect(styleAttributes(hero(container)).some((s) => s.includes('jmac-enterprise-building'))).toBe(
      true
    )
  })

  it('is the branded building, with the old one gone rather than alongside it', () => {
    const { container } = show()
    const everything = styleAttributes(container).join(' ')
    expect(everything).not.toContain('jmac-footer-building')
  })

  it('leaves the right side light enough for the signage to read', () => {
    const { container } = show()
    const desktop = styleAttributes(hero(container)).find(
      (s) => s.includes('linear-gradient(90deg') || s.includes('linear-gradient(90deg,')
    )
    expect(desktop).toBeTruthy()
    // The photograph is a night shot whose own sky is darker than --navy, so
    // the overlay exists to settle the left rather than to darken the right.
    // Anything approaching the old 78%/42% pair over the signage would put the
    // lettering back under a wash it does not need.
    const overSignage = /--navy\) (\d+)%, transparent\) 72%/.exec(desktop!)
    expect(overSignage).toBeTruthy()
    expect(Number(overSignage![1])).toBeLessThanOrEqual(35)
  })
})

/**
 * The page ends on About and then the site footer. It briefly carried a closing
 * careers band, which was one ask too many: the header offers Careers, Track
 * Application and Login on every page, and the footer repeats all three
 * directly underneath.
 */
describe('the page does not close on another call to action', () => {
  it('ends on About, with no section after it', () => {
    const { container } = show()
    const sections = Array.from(container.querySelectorAll('section'))
    expect(sections.at(-1)?.getAttribute('id')).toBe('about')
    expect(container.querySelector('#contact')).toBeNull()
  })

  it('does not ask a third time for what the header and footer already offer', () => {
    show()
    expect(screen.queryByText('Looking for a role at JMAC?')).toBeNull()
    expect(screen.queryByRole('link', { name: /See open positions/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /Track an application/i })).toBeNull()
  })
})

describe('what the page says it is', () => {
  it('reads as an employer, not a software vendor', () => {
    const { container } = show()
    const text = container.textContent ?? ''
    for (const phrase of [
      /free trial/i,
      /book a demo/i,
      /request a demo/i,
      /pricing/i,
      /contact sales/i,
      /transform your business/i,
      /trusted by thousands/i,
    ]) {
      expect(text).not.toMatch(phrase)
    }
  })
})
