import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Branch } from '@/hooks/useBranches'
import type { BranchCategorySummary } from '@/hooks/usePosCategorySummary'
import type { Category, Product } from '@/lib/posCatalogue'

/**
 * One module, two roles -- held side by side.
 *
 * The Administrator's Product Categories and the POS Manager's were written
 * months apart and shared no code, so each hand-rolled its own header, list and
 * dialog and the two drifted into looking like unrelated systems. The fix was
 * shared components; this file is what stops them drifting again.
 *
 * It renders BOTH real pages against the same fixture and compares the class
 * signature of the parts that must match. A signature is a blunt instrument on
 * purpose: if someone restyles one card and not the other, these fail, and no
 * amount of "it still looks fine" argues with a diff.
 *
 * It deliberately does NOT compare what the two may DO. Same frame, different
 * authority -- ProductCategoriesPage.test.tsx on either side covers that.
 */

const CAVITE = 'cavite'

const branches: Branch[] = [
  {
    id: CAVITE,
    name: 'Cavite Branch',
    address: null,
    phone: null,
    latitude: null,
    longitude: null,
    is_active: true,
    show_on_landing: false,
    image_path: null,
    display_order: 0,
    created_at: '',
    updated_at: '',
  },
]

/** The same category, described the way each side's server describes it. */
const adminCategories: Category[] = [
  {
    id: 'gen',
    name: 'General',
    normalized_name: 'general',
    description: 'The default category.',
    color: null,
    icon: null,
    is_active: true,
    sort_order: 0,
  },
  {
    id: 'c1',
    name: 'Drinks',
    normalized_name: 'drinks',
    description: 'Bottled and canned',
    color: '#3366ff',
    icon: null,
    is_active: true,
    sort_order: 1,
  },
]

const adminProducts: Product[] = [
  {
    id: 'p1',
    name: 'Cola',
    category_id: 'c1',
    default_selling_price: 1,
    default_unit_cost: 0,
    image_path: null,
    status: 'active',
  },
]

const managerRows: BranchCategorySummary[] = [
  {
    category_id: 'gen',
    name: 'General',
    description: 'The default category.',
    color: null,
    icon: null,
    sort_order: 0,
    is_active: true,
    product_count: 0,
    offered_count: 0,
    low_stock_count: 0,
    out_of_stock_count: 0,
  },
  {
    category_id: 'c1',
    name: 'Drinks',
    description: 'Bottled and canned',
    color: '#3366ff',
    icon: null,
    sort_order: 1,
    is_active: true,
    product_count: 1,
    offered_count: 1,
    low_stock_count: 0,
    out_of_stock_count: 0,
  },
]

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u1', role: 'employee' },
    posAccess: {
      hasAccess: true,
      branchIds: [CAVITE],
      assignments: [{ branchId: CAVITE, role: 'manager' }],
    },
  }),
}))

vi.mock('@/hooks/useBranches', () => ({
  useBranches: () => ({ data: branches, isLoading: false }),
}))

vi.mock('@/hooks/usePosCategorySummary', () => ({
  useBranchCategorySummary: () => ({ data: managerRows, isLoading: false }),
}))

const noop = { mutate: vi.fn(), isPending: false }

vi.mock('@/hooks/usePosCatalogue', () => ({
  usePosCategories: () => ({ data: adminCategories, isLoading: false }),
  usePosProducts: () => ({ data: adminProducts, isLoading: false }),
  useSaveCategory: () => noop,
  useDeleteCategory: () => noop,
  useReorderCategory: () => noop,
  useSetCategoryActive: () => noop,
  useCreatePosCategory: () => noop,
  useRenamePosCategory: () => noop,
}))

const { default: AdminCategoriesPage } = await import('@/pages/admin/PosCategoriesPage')
const { default: ManagerCategoriesPage } = await import('@/pages/pos/PosCategoriesPage')

type Surface = 'admin' | 'manager'

function show(surface: Surface) {
  const Page = surface === 'admin' ? AdminCategoriesPage : ManagerCategoriesPage
  return render(
    <MemoryRouter initialEntries={['/categories']}>
      <Page />
    </MemoryRouter>
  )
}

const classOf = (el: Element | null | undefined) => el?.getAttribute('class') ?? '<missing>'

/** The card a named category sits in. */
function cardFor(name: string) {
  return screen.getByText(name).closest('.rounded-xl')
}

/**
 * The parts of a surface that must look identical on the other one.
 *
 * Class strings, not screenshots: this runs in the same suite as everything
 * else and fails with a readable diff.
 */
function signature(surface: Surface) {
  const view = show(surface)
  const heading = screen.getByRole('heading', { name: 'Product Categories' })
  const card = cardFor('Drinks')
  const permanentBadge = screen.getByText('Permanent')
  const newButton = screen.getByRole('button', { name: /New category/i })

  const sig = {
    heading: classOf(heading),
    headingTag: heading.tagName,
    // The header block is one shared component; its wrapper decides how a long
    // subtitle and a button share a row.
    headerWrapper: classOf(heading.parentElement?.parentElement),
    card: classOf(card),
    cardBody: classOf(card?.firstElementChild),
    name: classOf(screen.getByText('Drinks')),
    meta: classOf(card?.querySelector('p')),
    permanentBadge: classOf(permanentBadge),
    swatch: classOf(cardFor('Drinks')?.querySelector('span[aria-hidden]')),
    newButton: classOf(newButton),
    actionsTrigger: classOf(screen.getByRole('button', { name: 'Actions for Drinks' })),
  }

  fireEvent.click(newButton)
  const dialog = screen.getByRole('dialog')
  const dialogSig = {
    dialog: classOf(dialog),
    title: classOf(screen.getByRole('heading', { name: 'New category' })),
    nameLabel: classOf(dialog.querySelector('label')),
    nameInput: classOf(dialog.querySelector('input')),
    fieldWrapper: classOf(dialog.querySelector('label')?.parentElement),
    form: classOf(dialog.querySelector('form')),
    footer: classOf(dialog.querySelector('form > div:last-child')),
    cancel: classOf(screen.getByRole('button', { name: 'Cancel' })),
  }

  view.unmount()
  cleanup()
  return { ...sig, ...dialogSig }
}

afterEach(cleanup)

describe('the two Product Categories surfaces are one module', () => {
  it('renders the same card, header, badge and dialog on both', () => {
    const admin = signature('admin')
    const manager = signature('manager')

    // Every part must have actually been found. Without this the comparison
    // could pass by matching '<missing>' against '<missing>' -- two selectors
    // that both stopped resolving would read as perfect consistency.
    for (const [part, value] of Object.entries(admin)) {
      expect(value, `admin ${part}`).not.toBe('<missing>')
      expect(value.length, `admin ${part} is empty`).toBeGreaterThan(0)
    }

    // One assertion, whole object: a failure names every part that drifted
    // rather than stopping at the first.
    expect(manager).toEqual(admin)
  })

  it('calls the entity Product Categories on both, not Categories on one', () => {
    show('admin')
    expect(screen.getByRole('heading', { name: 'Product Categories' })).toBeTruthy()
    cleanup()

    show('manager')
    expect(screen.getByRole('heading', { name: 'Product Categories' })).toBeTruthy()
  })

  it('puts name, count and description in the same order on both', () => {
    const read = (surface: Surface) => {
      const view = show(surface)
      const card = cardFor('Drinks')
      const text = (card?.textContent ?? '').replace(/\s+/g, ' ')
      view.unmount()
      cleanup()
      return text
    }

    // Same hierarchy, same separator, same pluralisation. The counts differ
    // because the questions differ -- enterprise products versus what this
    // branch carries -- but Drinks holds one either way in this fixture.
    expect(read('admin')).toContain('Drinks1 product · Bottled and canned')
    expect(read('manager')).toContain('Drinks1 product · Bottled and canned')
  })

  it('gives both the same actions menu, not a menu on one and text links on the other', () => {
    for (const surface of ['admin', 'manager'] as const) {
      const view = show(surface)
      expect(screen.getByRole('button', { name: 'Actions for Drinks' })).toBeTruthy()
      // The old manager page had bare inline text where this menu now is.
      expect(screen.queryByText('Rename')).toBeNull()
      view.unmount()
      cleanup()
    }
  })
})

describe('the colour indicator', () => {
  /** The swatch on a named category's card. */
  const swatchFor = (name: string) =>
    cardFor(name)?.querySelector('span[aria-hidden]') as HTMLElement | null

  it('paints the configured colour, on both surfaces', () => {
    // Drinks is #3366ff in both fixtures -- the Administrator's from
    // pos_product_categories, the manager's from get_branch_category_summary.
    // One component, so one answer.
    for (const surface of ['admin', 'manager'] as const) {
      const view = show(surface)
      expect(swatchFor('Drinks')?.style.backgroundColor).toBe('rgb(51, 102, 255)')
      view.unmount()
      cleanup()
    }
  })

  it('falls back to the neutral token when no colour is set', () => {
    // General has color: null in both fixtures, which is the ORDINARY case --
    // colour is optional and most categories have none. It used to draw a
    // hollow outline that read as a broken icon or an unticked checkbox.
    for (const surface of ['admin', 'manager'] as const) {
      const view = show(surface)
      const swatch = swatchFor('General')

      // No inline colour, so the class token decides -- and the token is a
      // fill, not a transparent box.
      expect(swatch?.style.backgroundColor).toBe('')
      expect(swatch?.getAttribute('class')).toContain('bg-muted')
      view.unmount()
      cleanup()
    }
  })

  it('keeps its border whatever the fill is, so a pale colour stays visible', () => {
    // The one contrast hazard: a near-white colour on a white card. The
    // outline is what keeps the indicator perceivable at every value the
    // column can hold.
    const view = show('admin')
    for (const name of ['General', 'Drinks']) {
      const cls = swatchFor(name)?.getAttribute('class') ?? ''
      expect(cls).toContain('border')
      expect(cls).toContain('border-border')
    }
    view.unmount()
  })

  it('is 32px and keeps the rounding it already had', () => {
    const view = show('admin')
    const cls = swatchFor('Drinks')?.getAttribute('class') ?? ''
    expect(cls).toContain('h-8')
    expect(cls).toContain('w-8')
    expect(cls).toContain('rounded-lg')
    view.unmount()
  })

  it('is decorative: nothing to click, nothing to select, nothing announced', () => {
    // It must not become a checkbox or a selection affordance. A span with no
    // handler, no role, no tabindex and aria-hidden is none of those things.
    const view = show('admin')
    const swatch = swatchFor('Drinks')

    expect(swatch?.tagName).toBe('SPAN')
    expect(swatch?.getAttribute('aria-hidden')).toBe('true')
    expect(swatch?.getAttribute('role')).toBeNull()
    expect(swatch?.getAttribute('tabindex')).toBeNull()
    expect(swatch?.onclick).toBeFalsy()

    // And no checkbox arrived anywhere on the card with it.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    view.unmount()
  })

  it('leaves the rest of the card exactly where it was', () => {
    // The swatch shares a row with everything that matters; a change to it
    // must not have displaced any of it.
    const view = show('manager')
    expect(screen.getByText('Permanent')).toBeTruthy()
    expect(screen.getByText('Drinks')).toBeTruthy()
    expect((cardFor('Drinks')?.textContent ?? '')).toContain('Bottled and canned')
    expect((cardFor('Drinks')?.textContent ?? '').replace(/\s+/g, ' ')).toContain('Carried1')
    expect(screen.getByRole('button', { name: 'Actions for Drinks' })).toBeTruthy()
    view.unmount()
  })
})

describe('what the shared frame must NOT equalise', () => {
  it('keeps reorder arrows on the Administrator and off the manager', () => {
    const admin = show('admin')
    expect(screen.getByRole('button', { name: 'Move Drinks up' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move Drinks down' })).toBeTruthy()
    admin.unmount()
    cleanup()

    show('manager')
    expect(screen.queryByRole('button', { name: 'Move Drinks up' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Move Drinks down' })).toBeNull()
  })

  it('gives the Administrator description and colour, and the manager a name only', () => {
    const admin = show('admin')
    fireEvent.click(screen.getByRole('button', { name: /New category/i }))
    expect(screen.getByRole('dialog').querySelectorAll('input, textarea')).toHaveLength(3)
    admin.unmount()
    cleanup()

    show('manager')
    fireEvent.click(screen.getByRole('button', { name: /New category/i }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelectorAll('input, textarea')).toHaveLength(1)
    // Not hidden behind `disabled`, which would still claim the field is
    // theirs. It is simply not there.
    expect(dialog.textContent ?? '').not.toMatch(/colour|description/i)
  })

  it('shows branch usage to the manager and none to the Administrator', () => {
    const admin = show('admin')
    expect(cardFor('Drinks')?.textContent ?? '').not.toMatch(/Carried|Offered/)
    admin.unmount()
    cleanup()

    show('manager')
    const text = (cardFor('Drinks')?.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('Carried1')
    expect(text).toContain('Offered1')
    expect(text).toContain('Low0')
    expect(text).toContain('Out0')
  })

  it('gives each a subtitle of its own, in the same slot', () => {
    const admin = show('admin')
    expect(screen.getByText(/The order here is the order a till shows them in/)).toBeTruthy()
    admin.unmount()
    cleanup()

    show('manager')
    expect(screen.getByText(/These are the headings Cavite Branch files its catalogue under/)).toBeTruthy()
  })

  it('warns only the manager that the taxonomy is global, and only once', () => {
    const admin = show('admin')
    expect(screen.queryByText('Global catalogue')).toBeNull()
    admin.unmount()
    cleanup()

    show('manager')
    expect(screen.getAllByText('Global catalogue')).toHaveLength(1)
  })
})
