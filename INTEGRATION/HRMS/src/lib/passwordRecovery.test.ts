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

  it('gives the same sentence for expired, used and malformed links', () => {
    // Deliberately uniform: telling them apart would disclose whether a
    // particular link had ever been valid.
    const expired = describeRecoveryError({ code: 'otp_expired', description: 'Email link has expired' })
    const used = describeRecoveryError({ code: 'access_denied', description: 'Email link has already been used' })
    const junk = describeRecoveryError({ code: 'whatever', description: '' })
    expect(expired).toBe('This password reset link is invalid or has expired.')
    expect(used).toBe(expired)
    expect(junk).toBe(expired)
  })

  it('never echoes the raw code back at the reader', () => {
    expect(describeRecoveryError({ code: 'otp_expired', description: 'x' })).not.toMatch(/otp_expired/)
  })
})
