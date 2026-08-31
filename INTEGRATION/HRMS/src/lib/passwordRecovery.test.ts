import { describe, expect, it } from 'vitest'
import { RESET_PASSWORD_PATH, describeRecoveryError, readRecoveryError } from '@/lib/passwordRecovery'

describe('the recovery redirect', () => {
  it('is the path the router actually mounts', () => {
    // The sender builds origin + this, and App.tsx mounts exactly this. If they
    // ever disagree every reset link 404s, which is why it is one constant.
    expect(RESET_PASSWORD_PATH).toBe('/auth/reset-password')
    expect(RESET_PASSWORD_PATH.startsWith('/')).toBe(true)
  })
})

describe('readRecoveryError', () => {
  it('finds nothing in a clean redirect', () => {
    expect(readRecoveryError('')).toBeNull()
    expect(readRecoveryError('#access_token=abc&type=recovery')).toBeNull()
  })

  it('reads the error out of the fragment, where Supabase puts it', () => {
    // The fragment, not the query string: it never reaches a server.
    const found = readRecoveryError(
      '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'
    )
    expect(found?.code).toBe('otp_expired')
    expect(found?.description).toBe('Email link is invalid or has expired')
  })

  it('copes with a leading hash or none', () => {
    expect(readRecoveryError('error_code=otp_expired')?.code).toBe('otp_expired')
  })

  it('falls back to the generic error when there is no specific code', () => {
    expect(readRecoveryError('#error=access_denied')?.code).toBe('access_denied')
  })
})

describe('describeRecoveryError', () => {
  it('says nothing when the link is fine', () => {
    expect(describeRecoveryError(null)).toBeNull()
  })

  it('tells an expired link apart from a used one', () => {
    // These need different actions from the reader, so they get different
    // sentences rather than one shrug.
    expect(
      describeRecoveryError({ code: 'otp_expired', description: 'Email link is invalid or has expired' })
    ).toMatch(/expired/i)
    expect(
      describeRecoveryError({ code: 'access_denied', description: 'Email link has already been used' })
    ).toMatch(/already been used/i)
  })

  it('always ends with something the reader can do', () => {
    for (const code of ['otp_expired', 'access_denied', 'something_new']) {
      expect(describeRecoveryError({ code, description: '' })).toMatch(/request a new one/i)
    }
  })

  it('never echoes the raw code back at the reader', () => {
    const message = describeRecoveryError({ code: 'otp_expired', description: 'x' })
    expect(message).not.toMatch(/otp_expired/)
  })
})
