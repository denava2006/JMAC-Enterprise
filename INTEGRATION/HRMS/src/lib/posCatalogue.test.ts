import { describe, expect, it } from 'vitest'
import {
  categorySwatchColor,
  describeCatalogueError,
  effectivePrice,
  isGeneralCategory,
  isOfferable,
  normalizeName,
  productImagePath,
  validateCategory,
  validateProduct,
  type Category,
  type Product,
} from '@/lib/posCatalogue'

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'c1',
    name: 'Drinks',
    normalized_name: 'drinks',
    description: null,
    color: null,
    icon: null,
    is_active: true,
    sort_order: 1,
    ...overrides,
  }
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    name: 'Cola 1.5L',
    category_id: 'c1',
    default_selling_price: 85,
    default_unit_cost: 60,
    image_path: null,
    status: 'active',
    ...overrides,
  }
}

describe('isGeneralCategory', () => {
  it('recognises General regardless of how it was typed', () => {
    expect(isGeneralCategory({ normalized_name: 'general' })).toBe(true)
    expect(isGeneralCategory({ normalized_name: 'drinks' })).toBe(false)
  })
})

describe('effectivePrice', () => {
  it('uses the enterprise default when a branch has no override', () => {
    expect(effectivePrice(product(), { selling_price_override: null })).toBe(85)
    expect(effectivePrice(product(), null)).toBe(85)
    expect(effectivePrice(product(), undefined)).toBe(85)
  })

  it('uses the branch override when one is set', () => {
    expect(effectivePrice(product(), { selling_price_override: 90 })).toBe(90)
  })

  it('treats a zero override as a real price, not as absent', () => {
    // `|| default` would silently charge 85 here.
    expect(effectivePrice(product(), { selling_price_override: 0 })).toBe(0)
  })
})

describe('isOfferable', () => {
  it('needs an active product AND branch availability', () => {
    expect(isOfferable(product({ status: 'active' }), { is_available: true })).toBe(true)
    expect(isOfferable(product({ status: 'active' }), { is_available: false })).toBe(false)
    expect(isOfferable(product({ status: 'draft' }), { is_available: true })).toBe(false)
    expect(isOfferable(product({ status: 'archived' }), { is_available: true })).toBe(false)
  })

  it('is false when the branch does not carry the product at all', () => {
    expect(isOfferable(product(), null)).toBe(false)
    expect(isOfferable(product(), undefined)).toBe(false)
  })

  it('does not claim sellability -- Phase 3 has no stock to check', () => {
    // Documents the boundary: offerable means "carried and active", and Phase 4
    // adds "and stock > 0". If this ever starts meaning sellable, it must gain
    // a stock argument.
    expect(isOfferable(product(), { is_available: true })).toBe(true)
  })
})

describe('normalizeName', () => {
  it('matches what the database unique index compares', () => {
    expect(normalizeName('  Drinks  ')).toBe('drinks')
    expect(normalizeName('DRINKS')).toBe('drinks')
  })
})

describe('validateCategory', () => {
  const existing = [category({ id: 'c1', normalized_name: 'drinks' })]

  it('accepts a clean category', () => {
    expect(validateCategory({ name: 'Snacks', description: '', color: '' }, existing)).toEqual([])
  })

  it('rejects an empty name', () => {
    expect(validateCategory({ name: '   ', description: '', color: '' }, existing).join(' ')).toContain(
      'needs a name'
    )
  })

  it('rejects a duplicate regardless of case or padding', () => {
    expect(
      validateCategory({ name: '  DRINKS ', description: '', color: '' }, existing).join(' ')
    ).toContain('already exists')
  })

  it('lets a category keep its own name while being edited', () => {
    expect(validateCategory({ name: 'Drinks', description: '', color: '' }, existing, 'c1')).toEqual([])
  })

  it('rejects a malformed colour', () => {
    expect(
      validateCategory({ name: 'Snacks', description: '', color: 'blue' }, existing).join(' ')
    ).toContain('six-digit hex')
  })

  it('accepts a well-formed colour', () => {
    expect(validateCategory({ name: 'Snacks', description: '', color: '#1D6FA5' }, existing)).toEqual([])
  })

  it('rejects an over-long name and description', () => {
    expect(
      validateCategory({ name: 'x'.repeat(81), description: '', color: '' }, existing).join(' ')
    ).toContain('longer than 80')
    expect(
      validateCategory({ name: 'Snacks', description: 'y'.repeat(501), color: '' }, existing).join(' ')
    ).toContain('longer than 500')
  })
})

describe('categorySwatchColor', () => {
  it('passes through a colour the column would accept', () => {
    expect(categorySwatchColor('#1D6FA5')).toBe('#1D6FA5')
    expect(categorySwatchColor('#abcdef')).toBe('#abcdef')
    expect(categorySwatchColor('  #123456  ')).toBe('#123456')
  })

  it('returns null for no colour, which is the ordinary case', () => {
    // Colour is an optional flourish. Creating a category never asks for one,
    // so most rows have none -- null here means "paint the neutral token",
    // not "something went wrong".
    expect(categorySwatchColor(null)).toBeNull()
    expect(categorySwatchColor(undefined)).toBeNull()
    expect(categorySwatchColor('')).toBeNull()
    expect(categorySwatchColor('   ')).toBeNull()
  })

  it('returns null for anything malformed, rather than handing it to the DOM', () => {
    // The column's CHECK constraint means these cannot be stored, so this is
    // defence in depth. It matters because the failure it prevents is silent:
    // React drops a backgroundColor it cannot parse and the swatch renders
    // empty, which is the exact bug the neutral fallback exists to kill.
    for (const bad of ['blue', '#12345', '#1234567', '1D6FA5', '#GGGGGG', 'rgb(0,0,0)']) {
      expect(categorySwatchColor(bad), bad).toBeNull()
    }
  })

  it('agrees with validateCategory about what a colour is', () => {
    // Both read the same pattern, so the editor cannot accept a value the
    // card then refuses to paint.
    const existing: Pick<Category, 'id' | 'normalized_name'>[] = []
    for (const value of ['#1D6FA5', 'blue', '#12345', '']) {
      const rejected = validateCategory({ name: 'Snacks', description: '', color: value }, existing)
        .some((e) => e.includes('six-digit hex'))
      const paintable = categorySwatchColor(value) !== null
      // An empty colour is valid AND unpaintable; anything non-empty must be
      // either both or neither.
      if (value !== '') expect(paintable, value).toBe(!rejected)
      else expect(rejected).toBe(false)
    }
  })
})

describe('validateProduct', () => {
  const existing = [product({ id: 'p1', name: 'Cola 1.5L' })]
  const draft = { name: 'Chips', categoryId: 'c1', sellingPrice: 20, unitCost: 12 }

  it('accepts a clean product', () => {
    expect(validateProduct(draft, existing)).toEqual([])
  })

  it('rejects a duplicate name -- one physical product, one record', () => {
    expect(validateProduct({ ...draft, name: ' cola 1.5l ' }, existing).join(' ')).toContain(
      'already exists'
    )
  })

  it('lets a product keep its own name while being edited', () => {
    expect(validateProduct({ ...draft, name: 'Cola 1.5L' }, existing, 'p1')).toEqual([])
  })

  it('requires a category', () => {
    expect(validateProduct({ ...draft, categoryId: '' }, existing).join(' ')).toContain('Choose a category')
  })

  it('rejects negative money', () => {
    expect(validateProduct({ ...draft, sellingPrice: -1 }, existing).join(' ')).toContain(
      'selling price cannot be negative'
    )
    expect(validateProduct({ ...draft, unitCost: -1 }, existing).join(' ')).toContain(
      'unit cost cannot be negative'
    )
  })

  it('allows a zero price -- a giveaway is a real configuration', () => {
    expect(validateProduct({ ...draft, sellingPrice: 0 }, existing)).toEqual([])
  })
})

describe('productImagePath', () => {
  it('puts the object in the product folder the CHECK constraint requires', () => {
    expect(productImagePath('p1', 'photo.png')).toMatch(/^p1\/[a-z0-9-]+\.png$/)
  })

  it('sanitises the extension, which becomes part of the object path', () => {
    expect(productImagePath('p1', 'evil.pn g/../x')).toMatch(/^p1\/[a-z0-9-]+\.[a-z0-9]+$/)
    expect(productImagePath('p1', 'noextension')).toMatch(/\.png$/)
  })
})

describe('describeCatalogueError', () => {
  it('explains a duplicate product', () => {
    expect(
      describeCatalogueError(new Error('duplicate key value violates unique constraint "pos_products_normalized_name_key"'))
    ).toContain('product with that name already exists')
  })

  it('explains a duplicate category', () => {
    expect(
      describeCatalogueError(
        new Error('duplicate key value violates unique constraint "pos_product_categories_normalized_name_key"')
      )
    ).toContain('category with that name already exists')
  })

  it('passes the General guard sentence through', () => {
    expect(describeCatalogueError(new Error('The General category cannot be renamed'))).toContain(
      'General category cannot be renamed'
    )
  })

  it('explains an RLS refusal without leaking the policy name', () => {
    expect(
      describeCatalogueError(new Error('new row violates row-level security policy for table "pos_products"'))
    ).toBe('Only an Administrator can change the product catalogue.')
  })

  it('never returns an empty string', () => {
    expect(describeCatalogueError(null)).toBe('Something went wrong. Please try again.')
  })
})
