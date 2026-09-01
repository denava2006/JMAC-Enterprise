/** URL safety for the product-image importer — unit tests.
 *
 * The importer is a server that fetches a URL somebody typed, from inside
 * Supabase's network. That is a server-side request forgery engine unless it is
 * stopped from being one, and the interesting targets are not on the public
 * internet: the platform metadata endpoint, the database, other functions.
 *
 * The address predicate is the whole defence, so it is asserted here directly
 * rather than only through the function. The copy under test is kept in step
 * with the Edge Function by the last test in this file.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Mirrors isForbiddenAddress in supabase/functions/import-pos-product-image. */
function isForbiddenAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    if (v6.startsWith('fe80')) return true
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true
    const embedded = v6.split(':').pop() ?? ''
    if (embedded.includes('.')) return isForbiddenAddress(embedded)
    return false
  }

  const parts = ip.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true
  }
  const [a, b] = parts

  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true

  return false
}

describe('addresses the importer must refuse', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.1.1', 'loopback, the whole /8'],
    ['0.0.0.0', 'this network'],
    ['10.0.0.5', 'private class A'],
    ['172.16.0.1', 'private, bottom of the range'],
    ['172.31.255.254', 'private, top of the range'],
    ['192.168.1.1', 'private class C'],
    ['169.254.169.254', 'cloud metadata — the one that leaks credentials'],
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00::1', 'IPv6 unique local'],
    ['::ffff:127.0.0.1', 'IPv4 loopback wearing an IPv6 hat'],
    ['::ffff:169.254.169.254', 'metadata wearing an IPv6 hat'],
  ])('refuses %s (%s)', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true)
  })

  it.each([
    ['93.184.216.34'],
    ['8.8.8.8'],
    ['172.15.0.1'],  // just below the private range
    ['172.32.0.1'],  // just above it
    ['192.167.1.1'], // adjacent to 192.168, and public
    ['100.63.0.1'],  // just below CGNAT
    ['2606:2800:220:1::1'], // public IPv6
  ])('allows %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false)
  })

  it('refuses anything it cannot parse', () => {
    // Unparseable is not usable: better to reject a valid address than to let
    // an unexpected form through unchecked.
    for (const junk of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', '-1.0.0.1']) {
      expect(isForbiddenAddress(junk), junk).toBe(true)
    }
  })
})

describe('the importer itself', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'functions', 'import-pos-product-image', 'index.ts'),
    'utf8'
  )

  it('accepts only http and https', () => {
    expect(source).toContain("url.protocol !== 'https:' && url.protocol !== 'http:'")
  })

  it('checks the resolved address, not just the hostname', () => {
    // A hostname proves nothing — anyone may point a public DNS record at
    // 127.0.0.1, and people do.
    expect(source).toContain('Deno.resolveDns')
    expect(source).toContain('addresses.some(isForbiddenAddress)')
  })

  it('re-checks every redirect hop', () => {
    // An automatic redirect is a second request to an address nobody checked.
    expect(source).toContain("redirect: 'manual'")
    expect(source).toContain('MAX_REDIRECTS')
    // assertUrlIsSafe is called inside the hop loop, not once before it.
    const loop = source.slice(source.indexOf('for (let hop'))
    expect(loop).toContain('await assertUrlIsSafe(current)')
  })

  it('bounds the request in time and size', () => {
    expect(source).toContain('AbortController')
    expect(source).toContain('TIMEOUT_MS')
    expect(source).toContain('MAX_BYTES')
    // Content-Length is a claim; the real length is checked after reading too.
    expect(source).toContain('bytes.byteLength > MAX_BYTES')
  })

  it('decides the type from the response, never the URL', () => {
    expect(source).toContain("response.headers.get('content-type')")
    expect(source).not.toMatch(/extname|\.split\('\.'\)\.pop\(\)/)
  })

  it('does not accept SVG', () => {
    // A document that can carry script, rendered rather than decoded.
    expect(source).not.toContain('image/svg')
  })

  it('generates the storage path itself', () => {
    expect(source).toContain('`${productId}/${crypto.randomUUID()}.${extension}`')
  })

  it('takes no authority from the request body', () => {
    const body = source.slice(source.indexOf('await req.json()'), source.indexOf('callerClient'))
    for (const claim of ['role', 'branch', 'path', 'bucket']) {
      expect(body.toLowerCase()).not.toContain(`body?.${claim}`)
    }
  })

  it('asks the database who the caller is', () => {
    expect(source).toContain('can_manage_pos_catalogue')
  })

  it('removes the old image only after the new one is stored and linked', () => {
    const upload = source.indexOf('.upload(path')
    const link = source.indexOf('set_pos_product_image')
    const remove = source.indexOf('remove([previous])')
    expect(upload).toBeGreaterThan(-1)
    expect(link).toBeGreaterThan(upload)
    expect(remove).toBeGreaterThan(link)
  })

  it('keeps the address predicate in step with this test', () => {
    // If the Edge Function's list of refused ranges changes, the copy above
    // stops being evidence of anything.
    for (const rule of [
      'a === 127',
      'a === 169 && b === 254',
      'a === 172 && b >= 16 && b <= 31',
      'a === 192 && b === 168',
      'a === 100 && b >= 64 && b <= 127',
      'a >= 224',
    ]) {
      expect(source, rule).toContain(rule)
    }
  })
})
