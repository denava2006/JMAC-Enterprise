import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Button } from '@/components/ui/button'

/**
 * The one distinction this file exists to hold.
 *
 * JMAC's teal, #12a594, is the brand accent and is right for the things it has
 * always been right for -- icon backplates, rules, focus rings, borders. It is
 * not right for WORDS on a light surface: white on it measures 3.07:1 and it on
 * mist measures 2.83:1, against the 4.5:1 normal text requires and the 3:1 even
 * large text requires.
 *
 * So there are two tokens now, and which one a component reaches for says
 * whether it is drawing a shape or setting language. These assertions are on
 * the shared primitive rather than on twenty call sites, because that is where
 * the decision lives.
 */

afterEach(cleanup)

describe('the accent button carries readable text', () => {
  it('fills with the darker teal rather than the brand accent', () => {
    // Not bg-accent: white on #12a594 is 3.07:1 and this button's label is
    // normal-size text. #0c8377 carries white at 4.64:1.
    render(<Button variant="accent">Explore Careers</Button>)
    const button = screen.getByRole('button', { name: 'Explore Careers' })

    expect(button.className).toContain('bg-teal-2')
    expect(button.className).not.toContain('bg-accent')
  })

  it('darkens on hover rather than lightening back onto the failing colour', () => {
    render(<Button variant="accent">Explore Careers</Button>)
    const button = screen.getByRole('button', { name: 'Explore Careers' })

    expect(button.className).toContain('hover:bg-teal-ink')
    expect(button.className).not.toContain('hover:bg-accent')
  })

  it('animates its colours and its press, never its box', () => {
    // The catch-all transition puts width, height, padding and margin on the
    // critical path for every hover. Tailwind's `transition` is the same list
    // without the box metrics, so nothing looks different.
    render(<Button>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })

    expect(button.className).toContain('transition')
    expect(button.className).not.toContain('transition-all')
  })

  it('leaves the other variants alone', () => {
    // This was a contrast correction, not a restyle: no other variant's
    // hierarchy or colour changed.
    for (const [variant, expected] of [
      ['default', 'bg-primary'],
      ['secondary', 'bg-secondary'],
      ['destructive', 'bg-destructive'],
    ] as const) {
      const { unmount } = render(<Button variant={variant}>Act</Button>)
      expect(screen.getByRole('button', { name: 'Act' }).className, variant).toContain(expected)
      unmount()
    }
  })
})
