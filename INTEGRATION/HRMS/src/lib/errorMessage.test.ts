import { describe, expect, it } from 'vitest'
import { errorMessage } from '@/lib/errorMessage'
import { describeRequestError } from '@/lib/posRequests'

/**
 * The "[object Object]" bug, and the shape that caused it.
 *
 * Supabase and PostgREST reject with a plain object, not an Error. The old
 * formatters tested `error instanceof Error` and fell through to
 * `String(error)`, which on a plain object is the literal text
 * "[object Object]" -- truthy, so it passed every `message || fallback` guard
 * and reached the screen.
 *
 * A POS Manager raising a duplicate stock request saw that instead of the
 * sentence the database had actually sent back.
 */

/** What supabase.rpc() hands back when a PL/pgSQL function raises. */
function postgrestError(message: string) {
  return { message, details: null, hint: null, code: 'P0001' }
}

describe('reading the message out of whatever was thrown', () => {
  it('reads a PostgREST error object, which is not an Error', () => {
    // The exact regression: this shape used to stringify to "[object Object]".
    expect(errorMessage(postgrestError('There is already an open request'))).toBe(
      'There is already an open request',
    )
  })

  it('reads a real Error too', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('reads a bare string', () => {
    expect(errorMessage('plain text')).toBe('plain text')
  })

  it('falls back to details or hint when message is empty', () => {
    // PostgREST fills these for constraint violations where message is terse.
    expect(errorMessage({ message: '', details: 'Key already exists' })).toBe('Key already exists')
    expect(errorMessage({ message: null, hint: 'Try another product' })).toBe('Try another product')
  })

  it('never returns the string that started all this', () => {
    for (const thrown of [{}, { code: 'X' }, null, undefined, 42, [], { message: 123 }]) {
      expect(errorMessage(thrown)).not.toContain('[object Object]')
    }
  })

  it('returns empty rather than something unreadable, so callers can substitute', () => {
    expect(errorMessage({})).toBe('')
    expect(errorMessage(null)).toBe('')
    expect(errorMessage({ message: '   ' })).toBe('')
  })
})

describe('the duplicate stock request, end to end', () => {
  it('shows the database sentence rather than [object Object]', () => {
    // Production has a pending Coca-Cola request for Cavite Branch, so a second
    // one is refused by the unique index -- deliberately, one open restock per
    // branch and product.
    const thrown = postgrestError(
      'There is already an open request for this product at this branch.',
    )
    expect(describeRequestError(thrown)).toBe(
      'There is already an open request for this product at this branch.',
    )
  })

  it('no longer produces [object Object] for any RPC rejection', () => {
    const cases = [
      'There is already an open request for this product at this branch.',
      'That request has already been reviewed',
      'This branch does not carry that product',
      'This branch already carries that product',
      'You cannot review a request you submitted yourself',
      'You do not manage that branch',
      'Sign in to cancel a request',
      'some message nobody wrote a friendly version of',
    ]
    for (const message of cases) {
      const shown = describeRequestError(postgrestError(message))
      expect(shown).not.toContain('[object Object]')
      expect(shown.length).toBeGreaterThan(0)
    }
  })

  it('still recognises the cases it has friendlier wording for', () => {
    expect(describeRequestError(postgrestError('already been reviewed'))).toMatch(
      /already decided this one/,
    )
    expect(describeRequestError(postgrestError('does not carry that product'))).toMatch(
      /ask for it to be carried first/,
    )
    expect(describeRequestError(postgrestError('do not manage that branch'))).toBe(
      'You do not manage that branch.',
    )
  })

  it('passes an unrecognised database sentence straight through', () => {
    // Better than a generic apology: the database wrote it for a person.
    expect(describeRequestError(postgrestError('Quantity must be between 1 and 10000'))).toBe(
      'Quantity must be between 1 and 10000',
    )
  })

  it('has something to say when the error carries no words at all', () => {
    expect(describeRequestError({})).toBe('That request could not be completed.')
    expect(describeRequestError(null)).toBe('That request could not be completed.')
  })
})
