/** Sign-in failures, told apart.
 *
 * Hosted role-switching produced repeated "that email and password combination
 * doesn't match our records" for accounts whose passwords were correct, and the
 * only working advice was to refresh until it went through. These lock down
 * that a stale session, a rate limit and Auth having a bad minute are each said
 * plainly, and that only a genuine transient fault is ever retried.
 */
import { describe, it, expect } from 'vitest'
import { classifyAuthError, messageFor } from './authErrors'

describe('a genuinely wrong password', () => {
  it.each([
    { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
    { status: 400, message: 'Invalid login credentials' },
    { status: 401, message: 'Unauthorized' },
  ])('is reported as such (%o)', (error) => {
    const result = classifyAuthError(error)
    expect(result.failure).toBe('invalid_credentials')
    expect(result.message).toMatch(/doesn’t match our records/)
    expect(result.retryable).toBe(false)
  })
})

describe('a stale or expired session', () => {
  it.each([
    { code: 'refresh_token_not_found', status: 400, message: 'Invalid Refresh Token' },
    { code: 'session_not_found', status: 404, message: 'Session from session_id not found' },
    { status: 401, message: 'JWT expired' },
  ])('says so instead of blaming the password (%o)', (error) => {
    const result = classifyAuthError(error)
    expect(result.failure).toBe('session_expired')
    expect(result.message).toBe('Your previous session expired. Please sign in again.')
    expect(result.retryable).toBe(false)
  })
})

describe('a transient fault', () => {
  it.each([
    { name: 'TypeError', message: 'Failed to fetch' },
    { message: 'NetworkError when attempting to fetch resource' },
    { message: 'The operation timed out' },
    { name: 'AbortError', message: 'The user aborted a request' },
    { status: 500, message: 'Internal Server Error' },
    { status: 503, message: 'Service Unavailable' },
    { status: 0, message: '' },
  ])('is retryable, and does not accuse anyone of mistyping (%o)', (error) => {
    const result = classifyAuthError(error)
    expect(result.failure).toBe('transient')
    expect(result.retryable).toBe(true)
    expect(result.message).toMatch(/couldn’t complete sign-in right now/)
  })
})

describe('things that must never be retried', () => {
  it.each([
    [{ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }],
    [{ code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' }],
    [{ code: 'over_request_rate_limit', status: 429, message: 'rate limit' }],
    [{ code: 'refresh_token_not_found', status: 400, message: 'Invalid Refresh Token' }],
    [{ status: 403, message: 'Forbidden' }],
  ])('%o', (error) => {
    expect(classifyAuthError(error).retryable).toBe(false)
  })
})

describe('a rate limit', () => {
  it('is named, because waiting is the fix and retrying is not', () => {
    const result = classifyAuthError({ code: 'over_request_rate_limit', status: 429 })
    expect(result.failure).toBe('rate_limited')
    expect(result.message).toMatch(/Wait a moment/)
  })
})

describe('an unconfirmed email', () => {
  it('is not a password problem', () => {
    expect(classifyAuthError({ code: 'email_not_confirmed', status: 400 }).failure).toBe(
      'email_not_confirmed',
    )
  })
})

describe('something nobody recognises', () => {
  it('admits it rather than guessing', () => {
    const result = classifyAuthError({ status: 418, message: 'unexpected' })
    expect(result.failure).toBe('unknown')
    expect(result.message).toMatch(/couldn’t complete sign-in right now/)
    expect(result.retryable).toBe(false)
  })

  it('survives being handed nothing at all', () => {
    expect(classifyAuthError(undefined).failure).toBe('unknown')
    expect(classifyAuthError(null).failure).toBe('unknown')
    expect(classifyAuthError({}).failure).toBe('unknown')
  })
})

describe('no provider text ever reaches the screen', () => {
  it('does not pass raw messages through', () => {
    const raw = 'Invalid login credentials'
    expect(classifyAuthError({ status: 400, message: raw }).message).not.toContain(raw)
  })

  it('never suggests refreshing the page', () => {
    for (const error of [
      { status: 400, message: 'Invalid login credentials' },
      { code: 'refresh_token_not_found' },
      { status: 500 },
      {},
    ]) {
      expect(classifyAuthError(error).message.toLowerCase()).not.toContain('refresh')
    }
  })
})

describe('the messages the app promises', () => {
  it.each([
    ['deactivated', 'This account has been deactivated. Contact your administrator.'],
    ['session_expired', 'Your previous session expired. Please sign in again.'],
  ] as const)('%s', (failure, expected) => {
    expect(messageFor(failure)).toBe(expected)
  })

  it('points at the setup path when an account never finished it', () => {
    expect(messageFor('setup_incomplete')).toMatch(/Forgot password/)
  })
})
