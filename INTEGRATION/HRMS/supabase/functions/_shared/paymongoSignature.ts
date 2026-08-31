/**
 * PayMongo webhook signature verification.
 *
 * Extracted from the webhook handler so it can actually be tested. This is the
 * one piece of the payment integration that decides whether an anonymous HTTP
 * request is believed, and "we read the docs carefully" is not evidence that
 * the implementation is right. The tests next to this file cover the forgeries
 * it has to refuse.
 *
 * Uses only Web Crypto and TextEncoder, so it runs unchanged in Deno (the Edge
 * Function) and in Node (the test runner).
 */

export interface SignatureParts {
  timestamp: string
  test: string | null
  live: string | null
}

/** Header format: t=<unix>,te=<test hmac>,li=<live hmac> */
export function parseSignatureHeader(header: string | null): SignatureParts | null {
  if (!header) return null
  const parts = new Map<string, string>()
  for (const segment of header.split(',')) {
    const idx = segment.indexOf('=')
    if (idx > 0) parts.set(segment.slice(0, idx).trim(), segment.slice(idx + 1).trim())
  }
  const timestamp = parts.get('t')
  if (!timestamp) return null
  return {
    timestamp,
    test: parts.get('te') ?? null,
    live: parts.get('li') ?? null,
  }
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Constant-time comparison.
 *
 * Length is compared first and returns early, which is safe: the length of a
 * SHA-256 digest is not a secret. Beyond that every byte is compared even once
 * a difference is found, because `===` short-circuits and would leak the
 * position of the first mismatch to anyone willing to time enough requests.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export type VerifyFailure =
  | 'missing_header'
  | 'missing_test_signature'
  | 'stale_timestamp'
  | 'malformed_signature'
  | 'signature_mismatch'

export interface VerifyResult {
  ok: boolean
  reason?: VerifyFailure
}

/**
 * Verify a delivery.
 *
 * `rawBody` must be the exact bytes received. Parsing the JSON and
 * re-serialising it changes key order, whitespace and number formatting, and
 * the HMAC would no longer match what PayMongo signed.
 *
 * Only the test-mode component is ever checked. This integration is test-only,
 * so a live-mode delivery -- which carries `li` and no `te` -- is refused here
 * rather than being finalized by accident.
 */
export async function verifyPaymongoSignature(opts: {
  header: string | null
  rawBody: string
  secret: string
  toleranceSeconds: number
  nowSeconds?: number
}): Promise<VerifyResult> {
  const parsed = parseSignatureHeader(opts.header)
  if (!parsed) return { ok: false, reason: 'missing_header' }
  if (!parsed.test) return { ok: false, reason: 'missing_test_signature' }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const sent = Number(parsed.timestamp)
  if (!Number.isFinite(sent)) return { ok: false, reason: 'stale_timestamp' }
  if (Math.abs(now - sent) > opts.toleranceSeconds) return { ok: false, reason: 'stale_timestamp' }

  const provided = hexToBytes(parsed.test)
  if (!provided) return { ok: false, reason: 'malformed_signature' }

  const expectedHex = await hmacSha256Hex(opts.secret, `${parsed.timestamp}.${opts.rawBody}`)
  const expected = hexToBytes(expectedHex)!

  return timingSafeEqual(expected, provided)
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' }
}
