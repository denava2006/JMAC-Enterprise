import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The public landing page, and its closing section in particular.
 *
 * The building image is the first real photograph on this page, and the two
 * things worth pinning about it are that it stays decorative — a CSS
 * background, invisible to a screen reader — and that the section still
 * carries the two links the public actually needs.
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

vi.mock('@/hooks/usePublicCareers', () => ({
  usePublicOpenJobPostings: () => ({ data: [], isLoading: false, isError: false }),
}))

vi.mock('@/hooks/usePublicBranches', () => ({
  usePublicBranches: () => ({ data: [], isLoading: false, isError: false }),
}))

import HomePage from '@/pages/public/HomePage'

function show() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  )
}

afterEach(cleanup)

describe('the closing section', () => {
  it('closes on the building CTA rather than the old centred one', () => {
    show()
    expect(screen.getByText(/Let.s build a stronger tomorrow/i)).toBeTruthy()
    // Replaced, not stacked: two closing calls to action would be one more
    // than the page needs.
    expect(screen.queryByText('Looking for a role at JMAC?')).toBeNull()
  })

  it('keeps the two links the public needs, pointing where they should', () => {
    show()
    const careers = screen.getAllByRole('link', { name: /Explore Careers/i })
    const login = screen.getAllByRole('link', { name: /Employee Login/i })
    expect(careers.length).toBeGreaterThan(0)
    expect(login.length).toBeGreaterThan(0)
    for (const link of careers) expect(link.getAttribute('href')).toBe('/careers')
    for (const link of login) expect(link.getAttribute('href')).toBe('/login')
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
})

describe('the building image', () => {
  it('is a background, not content — nothing announces it', () => {
    const { container } = show()
    // No <img> was added for it, and every decorative layer is hidden from
    // the accessibility tree.
    const images = container.querySelectorAll('img')
    for (const img of images) {
      expect(img.getAttribute('src') ?? '').not.toMatch(/jmac-footer-building/)
    }
    const section = container.querySelector('#contact')
    expect(section).toBeTruthy()
    const layers = section!.querySelectorAll('[aria-hidden="true"], [aria-hidden]')
    expect(layers.length).toBeGreaterThanOrEqual(3)
  })

  it('sits behind an overlay rather than under bare text', () => {
    const { container } = show()
    const section = container.querySelector('#contact') as HTMLElement
    const styles = Array.from(section.querySelectorAll<HTMLElement>('[style]')).map(
      (el) => el.getAttribute('style') ?? ''
    )
    // One layer carries the photograph, and at least one more carries a
    // gradient over it.
    expect(styles.some((s) => s.includes('url('))).toBe(true)
    expect(styles.some((s) => s.includes('linear-gradient'))).toBe(true)
  })

  it('is held to the right, so the words are not set over the glass', () => {
    const { container } = show()
    const section = container.querySelector('#contact') as HTMLElement
    const positioned = section.querySelector('[class*="background-position"]')
    expect(positioned).toBeTruthy()
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
