/** A vendor's details, checked before the database has to refuse them.
 *
 * The hosted walkthrough accepted a vendor whose TIN, phone and contact person
 * were whatever somebody typed. supabase/tests/procurement_receiving_rls.sql
 * proves the database now refuses the same values; these prove the form says so
 * first, and in a sentence rather than a constraint name.
 */
import { describe, it, expect } from 'vitest'
import { formatTin, isValidTin, tinDigits, vendorSchema } from './vendorValidation'

function check(field: string, value: string) {
  const result = vendorSchema.safeParse({ name: 'ZZ Supplier', [field]: value })
  return {
    ok: result.success,
    message: result.success
      ? null
      : result.error.issues.find((i) => i.path[0] === field)?.message ?? null,
  }
}

describe('TIN', () => {
  it('formats digits as it is typed', () => {
    expect(formatTin('1')).toBe('1')
    expect(formatTin('1234')).toBe('123-4')
    expect(formatTin('123456789')).toBe('123-456-789')
    expect(formatTin('12345678901234')).toBe('123-456-789-01234')
  })

  it('reformats whatever separators arrive into the one canonical shape', () => {
    for (const typed of ['12345678901234', '123 456 789 01234', '123-456-789-01234']) {
      expect(formatTin(typed), typed).toBe('123-456-789-01234')
    }
  })

  it('stops at fourteen digits rather than growing', () => {
    expect(tinDigits(formatTin('123456789012349999'))).toHaveLength(14)
  })

  it('accepts a valid TIN', () => {
    expect(check('tin', '123-456-789-01234').ok).toBe(true)
    expect(isValidTin('12345678901234')).toBe(true)
  })

  it('says how many digits are missing rather than "invalid"', () => {
    expect(check('tin', '123456').message).toBe('TIN must contain 14 digits.')
  })

  it.each(['ABC-456-789-01234', '123/456/789/01234', '123.456.789.01234', '123=456=789=01234'])(
    'refuses %s',
    (value) => {
      expect(check('tin', value).ok).toBe(false)
    },
  )

  it('stays optional when the business rule says it is', () => {
    expect(check('tin', '').ok).toBe(true)
  })
})

describe('email', () => {
  it('accepts a real address', () => {
    expect(check('email', 'supplier@example.com').ok).toBe(true)
  })

  it.each(['supplier', 'supplier@', '@example.com', 'supplier@example', 'supplier example@example.com'])(
    'refuses %s',
    (value) => {
      const result = check('email', value)
      expect(result.ok).toBe(false)
      expect(result.message).toBe('Enter a valid email address.')
    },
  )

  it('trims and lowercases before judging', () => {
    const parsed = vendorSchema.parse({ name: 'ZZ', email: '  Supplier@Example.COM  ' })
    expect(parsed.email).toBe('supplier@example.com')
  })

  it('is optional', () => {
    expect(check('email', '').ok).toBe(true)
  })
})

describe('phone', () => {
  it.each(['09171234567', '639171234567'])('accepts %s', (value) => {
    expect(check('phone', value).ok).toBe(true)
  })

  it.each(['+639171234567', '0917-123-4567', '0917 123 4567', 'abc0917', '(0917)1234567', '0917'])(
    'refuses %s',
    (value) => {
      expect(check('phone', value).ok).toBe(false)
    },
  )

  it('explains the rule instead of naming a pattern', () => {
    expect(check('phone', '+639171234567').message).toMatch(/digits only/)
  })

  it('is optional', () => {
    expect(check('phone', '').ok).toBe(true)
  })
})

describe('contact person', () => {
  it.each(['Juan Dela Cruz', 'Maria Santos', 'José Ángel Núñez'])('accepts %s', (value) => {
    expect(check('contact_person', value).ok).toBe(true)
  })

  it.each(['Juan123', 'Juan/Cruz', 'Juan.Cruz', 'Juan_Cruz', 'Juan+Cruz', 'Juan=Cruz'])(
    'refuses %s',
    (value) => {
      const result = check('contact_person', value)
      expect(result.ok).toBe(false)
      expect(result.message).toBe('Contact person may contain letters and spaces only.')
    },
  )

  it('collapses runs of spaces before storing', () => {
    const parsed = vendorSchema.parse({ name: 'ZZ', contact_person: '  Juan   Dela Cruz  ' })
    expect(parsed.contact_person).toBe('Juan Dela Cruz')
  })
})

describe('vendor name keeps its own rule', () => {
  it.each(['7-Eleven & Co.', 'Metro Utilities Corp.', 'A1 Trading', 'Cruz & Sons, Inc.'])(
    'accepts %s, which the contact-person rule would refuse',
    (value) => {
      expect(vendorSchema.safeParse({ name: value }).success).toBe(true)
    },
  )

  it('still requires something', () => {
    expect(vendorSchema.safeParse({ name: '   ' }).success).toBe(false)
  })
})
