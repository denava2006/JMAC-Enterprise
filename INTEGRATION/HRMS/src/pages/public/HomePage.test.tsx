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

// Framer Motion reads prefers-reduced-motion once, when it is first imported,
// so stubbing matchMedia from inside a test arrives too late to change it.
// Mocking the hook instead tests the thing that is actually ours: what the hero
// renders when the answer comes back true.
const motion = { reduced: false }
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  useReducedMotion: () => motion.reduced,
}))
function reduceMotion(on: boolean) {
  motion.reduced = on
}

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

afterEach(() => {
  cleanup()
  reduceMotion(false)
})

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

function sceneLayers(container: HTMLElement) {
  return Array.from(hero(container).querySelectorAll('img'))
}

describe('the building scene', () => {
  it('is two cut-out layers rather than one flat photograph', () => {
    const { container } = show()
    const srcs = sceneLayers(container).map((el) => el.getAttribute('src') ?? '')
    expect(srcs.length).toBe(2)
    // Spelled as the file is spelled on disk, missing "r" and all.
    expect(srcs[0]).toMatch(/backgound-buildings/)
    expect(srcs[1]).toMatch(/main-building-base/)
  })

  it('has retired the flat hero image entirely', () => {
    const { container } = show()
    const everything = [
      ...styleAttributes(container),
      ...Array.from(container.querySelectorAll('img')).map((el) => el.getAttribute('src') ?? ''),
    ].join(' ')
    expect(everything).not.toContain('jmac-enterprise-building')
    expect(everything).not.toContain('jmac-footer-building')
    // main-building-logo is the unbranded facade. It is deliberately unused:
    // it is a different render of the building rather than the same one
    // without its sign, so crossfading to it would swap the architecture.
    expect(everything).not.toContain('main-building-logo')
  })

  it('announces nothing and intercepts nothing', () => {
    const { container } = show()
    for (const el of sceneLayers(container)) {
      expect(el.getAttribute('alt')).toBe('')
      expect(el.getAttribute('aria-hidden')).toBe('true')
      expect(el.className).toContain('pointer-events-none')
      expect(el.className).toContain('select-none')
    }
  })

  it('crops both layers identically, so they stay registered', () => {
    const { container } = show()
    // The three assets share one 1672x941 canvas, so an identical cover crop is
    // the whole coordinate system — no per-breakpoint pixel values anywhere.
    const [back, main] = sceneLayers(container)
    expect(back.className).toBe(main.className.replace('z-20', 'z-10'))
    for (const el of [back, main]) {
      expect(el.className).toContain('object-cover')
      expect(el.className).toContain('object-[80%_center]')
      expect(el.className).toContain('lg:object-[72%_center]')
      expect(el.className).toContain('absolute inset-0')
    }
  })

  it('stacks sky under buildings under overlay under text', () => {
    const { container } = show()
    const section = hero(container)
    const zOf = (selector: string) => {
      const el = section.querySelector(selector)
      return el ? /(?:^|\s)z-(\d+)/.exec(el.className)?.[1] : undefined
    }
    const [back, main] = sceneLayers(container)
    expect(zOf('[style*="to top right"]')).toBe('0')
    expect(/(?:^|\s)z-(\d+)/.exec(back.className)?.[1]).toBe('10')
    expect(/(?:^|\s)z-(\d+)/.exec(main.className)?.[1]).toBe('20')
    expect(zOf('[style*="linear-gradient(90deg"]')).toBe('30')
    expect(zOf('[class*="justify-between"]')).toBe('40')
  })

  it('keeps the navy readability gradient above the architecture', () => {
    const { container } = show()
    const styles = styleAttributes(hero(container))
    expect(styles.some((s) => s.includes('linear-gradient(90deg'))).toBe(true)
    // The overlay still gets out of the way where the signage is.
    const desktop = styles.find((s) => s.includes('linear-gradient(90deg'))!
    const overSignage = /--navy\) (\d+)%, transparent\) 72%/.exec(desktop)
    expect(overSignage).toBeTruthy()
    expect(Number(overSignage![1])).toBeLessThanOrEqual(35)
  })

  it('paints a sky, because the layers no longer carry one', () => {
    const { container } = show()
    // Sampled from the photograph where the cut-outs are transparent. If this
    // ever became a --navy token the rooflines would show a seam.
    // jsdom reports the parsed colours, which is the more legible assertion
    // anyway: these are the pixels the photograph actually has at those points.
    const sky = styleAttributes(hero(container)).find((s) => s.includes('to top right'))
    expect(sky).toBeTruthy()
    expect(sky).toContain('rgb(2, 23, 50)')
    expect(sky).toContain('rgb(11, 69, 132)')
  })
})

/**
 * The entrance, read from the styles Framer Motion renders on the first pass.
 * These pin the two things that matter: the buildings start below and arrive,
 * and a visitor who asked for less motion gets the finished scene instead of a
 * blank one waiting on a timer.
 */
describe('the entrance', () => {
  it('starts both layers below their resting position and faded', () => {
    const { container } = show()
    const [back, main] = sceneLayers(container).map((el) => el.getAttribute('style') ?? '')
    expect(back).toMatch(/translateY\(40px\)/)
    expect(main).toMatch(/translateY\(64px\)/)
    // Faded, not invisible — the scene reveals rather than pops.
    expect(back).toMatch(/opacity:\s*0\.3/)
    expect(main).toMatch(/opacity:\s*0\.15/)
  })

  it('renders the finished scene immediately under reduced motion', () => {
    reduceMotion(true)
    const { container } = show()
    for (const el of sceneLayers(container)) {
      const style = el.getAttribute('style') ?? ''
      expect(style).not.toMatch(/translateY\((?!0px\))/)
      expect(style).toMatch(/opacity:\s*1/)
    }
    // And the copy is there too, rather than waiting on its own delay.
    expect(screen.getByText(/One unified enterprise platform/i)).toBeTruthy()
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
