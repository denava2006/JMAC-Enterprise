import { describe, expect, it } from 'vitest'
import {
  hexToBytes,
  hmacSha256Hex,
  parseSignatureHeader,
  timingSafeEqual,
  verifyPaymongoSignature,
} from './paymongoSignature'

/**
 * The webhook endpoint is public and unauthenticated. The signature is the only
 * thing standing between a stranger with curl and a POS sale marked paid, so
 * these tests are mostly about what must be REFUSED.
 */

const SECRET = 'whsk_test_example_secret'
const BODY = '{"data":{"attributes":{"type":"checkout_session.payment.paid"}}}'
const NOW = 1_800_000_000

async function signedHeader(opts: {
  secret?: string
  body?: string
  timestamp?: number
  component?: 'te' | 'li'
} = {}) {
  const ts = opts.timestamp ?? NOW
  const hex = await hmacSha256Hex(opts.secret ?? SECRET, `${ts}.${opts.body ?? BODY}`)
  return `t=${ts},${opts.component ?? 'te'}=${hex}`
}

const verify = (header: string | null, body = BODY, nowSeconds = NOW) =>
  verifyPaymongoSignature({ header, rawBody: body, secret: SECRET, toleranceSeconds: 300, nowSeconds })

describe('a genuine delivery', () => {
  it('is accepted', async () => {
    expect(await verify(await signedHeader())).toEqual({ ok: true })
  })

  it('is accepted at the edge of the tolerance window', async () => {
    const header = await signedHeader({ timestamp: NOW - 300 })
    expect((await verify(header)).ok).toBe(true)
  })
})

describe('forgeries and mistakes', () => {
  it('refuses a request with no signature header at all', async () => {
    expect(await verify(null)).toEqual({ ok: false, reason: 'missing_header' })
  })

  it('refuses a header with no timestamp', async () => {
    const hex = await hmacSha256Hex(SECRET, `${NOW}.${BODY}`)
    expect(await verify(`te=${hex}`)).toEqual({ ok: false, reason: 'missing_header' })
  })

  it('refuses a signature made with the wrong secret', async () => {
    const header = await signedHeader({ secret: 'whsk_test_someone_elses_secret' })
    expect(await verify(header)).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('refuses a body that changed after it was signed', async () => {
    // The exact attack the signature exists to stop: a real delivery, replayed
    // with the amount edited.
    const header = await signedHeader()
    const tampered = BODY.replace('paid', 'paid","amount":"1')
    expect(await verify(header, tampered)).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('refuses a delivery older than the tolerance window', async () => {
    const header = await signedHeader({ timestamp: NOW - 301 })
    expect(await verify(header)).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('refuses a delivery timestamped in the future', async () => {
    const header = await signedHeader({ timestamp: NOW + 3600 })
    expect(await verify(header)).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('refuses a non-numeric timestamp', async () => {
    const hex = await hmacSha256Hex(SECRET, `abc.${BODY}`)
    expect(await verify(`t=abc,te=${hex}`)).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('refuses a live-mode delivery, which carries li and no te', async () => {
    // This integration is test-only. A live signature must never be accepted,
    // even if it is perfectly valid, because real money would be involved.
    const header = await signedHeader({ component: 'li' })
    expect(await verify(header)).toEqual({ ok: false, reason: 'missing_test_signature' })
  })

  it('refuses a signature that is not hex', async () => {
    expect(await verify(`t=${NOW},te=zzzznothex`)).toEqual({ ok: false, reason: 'malformed_signature' })
  })

  it('refuses an empty signature', async () => {
    expect(await verify(`t=${NOW},te=`)).toEqual({ ok: false, reason: 'missing_test_signature' })
  })

  it('refuses a truncated signature of the right alphabet', async () => {
    const hex = await hmacSha256Hex(SECRET, `${NOW}.${BODY}`)
    expect(await verify(`t=${NOW},te=${hex.slice(0, 32)}`)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })
})

describe('the primitives', () => {
  it('parses the documented header shape', () => {
    expect(parseSignatureHeader('t=123,te=aa,li=bb')).toEqual({
      timestamp: '123',
      test: 'aa',
      live: 'bb',
    })
  })

  it('tolerates whitespace around the segments', () => {
    expect(parseSignatureHeader('t=123, te=aa')).toEqual({ timestamp: '123', test: 'aa', live: null })
  })

  it('rejects odd-length and non-hex strings rather than guessing', () => {
    expect(hexToBytes('abc')).toBeNull()
    expect(hexToBytes('zz')).toBeNull()
    expect(hexToBytes('')).toBeNull()
    expect(hexToBytes('00ff')).toEqual(new Uint8Array([0, 255]))
  })

  it('compares equal and unequal byte strings correctly', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    // Differs in the FIRST byte: a short-circuiting compare would return here
    // measurably faster than for a difference in the last.
    expect(timingSafeEqual(new Uint8Array([9, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(false)
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it('produces a stable 64-character hex digest', async () => {
    const hex = await hmacSha256Hex(SECRET, `${NOW}.${BODY}`)
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
    expect(await hmacSha256Hex(SECRET, `${NOW}.${BODY}`)).toBe(hex)
  })
})
