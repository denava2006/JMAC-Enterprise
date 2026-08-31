import { describe, expect, it } from 'vitest'
import {
  MAX_MONEY_WHOLE_DIGITS,
  parseMoney,
  sanitizeMoneyInput,
} from '@/lib/currency'

describe('money input hardening', () => {
  it('strips the letters and symbols a number field would have accepted', () => {
    // The reported bug: an <input type="number"> accepts e, E, + and -, so a
    // symbol reached the cash field.
    for (const [typed, expected] of [
      ['1e5', '15'],
      ['12+3', '123'],
      ['-45', '45'],
      ['1,234', '1234'],
      ['12/34', '1234'],
      ['12\\34', '1234'],
      ['₱250', '250'],
      ['abc', ''],
    ] as const) {
      expect(sanitizeMoneyInput(typed)).toBe(expected)
    }
  })

  it('keeps one decimal point and at most two decimals', () => {
    expect(sanitizeMoneyInput('12.34.56')).toBe('12.3456'.slice(0, 5))
    expect(sanitizeMoneyInput('12.999')).toBe('12.99')
  })

  it('caps the whole part so the field cannot grow without limit', () => {
    const long = '9'.repeat(40)
    expect(sanitizeMoneyInput(long)).toHaveLength(MAX_MONEY_WHOLE_DIGITS)
  })

  it('parses a plain amount', () => {
    expect(parseMoney('250')).toBe(250)
    expect(parseMoney('250.50')).toBe(250.5)
    expect(parseMoney(' 250 ')).toBe(250)
  })

  it('refuses everything Number() would have quietly accepted', () => {
    // Each of these is a real Number() foot-gun: Number('1e5') is 100000,
    // Number('0x10') is 16, Number('') is 0, Number('Infinity') is Infinity.
    for (const bad of ['1e5', '0x10', 'Infinity', '-1', '+1', '1.2.3', '', 'abc', '1 2']) {
      expect(parseMoney(bad)).toBeNull()
    }
  })

  it('refuses an amount longer than the cap', () => {
    expect(parseMoney('9'.repeat(14))).toBeNull()
    expect(parseMoney('9'.repeat(13))).toBe(Number('9'.repeat(13)))
  })
})
