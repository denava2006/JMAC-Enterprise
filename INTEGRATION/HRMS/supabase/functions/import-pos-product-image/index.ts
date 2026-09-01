// Import a product image from a URL the manager pasted.
//
// This exists because the browser cannot do it: an arbitrary product photo on
// someone else's website will not send CORS headers, so fetch() from the page
// fails. The server can fetch it — which is exactly why this function is the
// most dangerous thing in the POS codebase and is written accordingly.
//
// A server that fetches a URL a user supplied is a server-side request forgery
// engine unless it is stopped from being one. It sits inside Supabase's network,
// where the interesting targets are not on the public internet: the platform's
// own metadata endpoint, the database, other functions. So the URL is checked,
// its DNS is resolved and the resulting ADDRESS is checked, and both happen
// again after every redirect — a host that resolves publicly on the first look
// and privately on the second is the standard bypass.
//
// What is stored is a copy. pos_products.image_path always points inside the
// pos-product-images bucket, never at someone else's server: a product photo
// that vanishes when a supplier redesigns their website is not a product photo.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** What a product photo may be. Deliberately narrow.
 *
 *  SVG is absent on purpose: it is a document, it can carry script, and it is
 *  rendered by the browser rather than decoded as pixels. */
const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const MAX_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 8000

/**
 * Is this address somewhere we must never reach?
 *
 * Written against the resolved address rather than the hostname, because a
 * hostname proves nothing: anyone can point a public DNS record at 127.0.0.1 or
 * at a cloud metadata service, and plenty of people have.
 */
function isForbiddenAddress(ip: string): boolean {
  // IPv6, including the forms that carry an IPv4 address inside them.
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true          // loopback, unspecified
    if (v6.startsWith('fe80')) return true                 // link-local
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true  // unique local
    // ::ffff:127.0.0.1 and friends — check the embedded v4.
    const embedded = v6.split(':').pop() ?? ''
    if (embedded.includes('.')) return isForbiddenAddress(embedded)
    return false
  }

  const parts = ip.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true // unparseable is not usable
  }
  const [a, b] = parts

  if (a === 0) return true                        // "this network"
  if (a === 10) return true                       // private
  if (a === 127) return true                      // loopback
  if (a === 169 && b === 254) return true         // link-local AND cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true         // private
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a >= 224) return true                       // multicast, reserved, broadcast

  return false
}

/**
 * Check one URL: scheme, then every address its host resolves to.
 *
 * Every address, not the first: a host with one public and one private A record
 * would otherwise pass the check and then be connected to on the private one.
 */
async function assertUrlIsSafe(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('IMAGE_URL_INVALID')
  }

  // file:, data:, ftp:, gopher: and the rest are not ways to fetch a photograph.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('IMAGE_URL_SCHEME')
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  // Named loopback never reaches DNS on some resolvers, so it is refused by name.
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    throw new Error('IMAGE_URL_BLOCKED')
  }

  // A literal address needs no lookup, and must not get one — resolveDns would
  // throw on it and the check would be skipped.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isForbiddenAddress(host)) throw new Error('IMAGE_URL_BLOCKED')
    return url
  }

  let addresses: string[] = []
  try {
    const [v4, v6] = await Promise.allSettled([
      Deno.resolveDns(host, 'A'),
      Deno.resolveDns(host, 'AAAA'),
    ])
    if (v4.status === 'fulfilled') addresses.push(...v4.value)
    if (v6.status === 'fulfilled') addresses.push(...v6.value)
  } catch {
    throw new Error('IMAGE_URL_UNREACHABLE')
  }

  if (addresses.length === 0) throw new Error('IMAGE_URL_UNREACHABLE')
  if (addresses.some(isForbiddenAddress)) throw new Error('IMAGE_URL_BLOCKED')

  return url
}

/**
 * Fetch, following redirects by hand.
 *
 * Manual because an automatic redirect is a second request to an address nobody
 * checked. Each hop is re-validated from scratch, which is what closes the
 * DNS-rebinding and redirect-to-metadata routes.
 */
async function fetchImage(startUrl: string): Promise<Response> {
  let current = startUrl

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertUrlIsSafe(current)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'image/*' },
      })
    } catch {
      throw new Error('IMAGE_URL_UNREACHABLE')
    } finally {
      clearTimeout(timer)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('IMAGE_URL_UNREACHABLE')
      current = new URL(location, url).toString()
      continue
    }

    if (!response.ok) throw new Error('IMAGE_URL_UNREACHABLE')
    return response
  }

  throw new Error('IMAGE_URL_REDIRECTS')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization header.' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const body = await req.json().catch(() => null)
    const productId: string | undefined = body?.productId
    const imageUrl: string | undefined = body?.imageUrl

    if (!productId || !imageUrl) {
      return json({ error: 'productId and imageUrl are both required.' }, 400)
    }

    // Scoped to the caller's own token. Authorization is derived from who they
    // are, never from anything the request claimed: no role, no branch and no
    // destination path is accepted from the client.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })

    const {
      data: { user },
      error: userError,
    } = await callerClient.auth.getUser()
    if (userError || !user) return json({ error: 'Not authenticated.' }, 401)

    // The same authority that governs every other catalogue mutation. An
    // Administrator qualifies; a cashier does not, at any branch.
    const { data: mayManage, error: roleError } = await callerClient.rpc('can_manage_pos_catalogue')
    if (roleError || mayManage !== true) {
      return json({ error: 'You do not have permission to change product images.' }, 403)
    }

    // ---------------------------------------------------------------- fetch
    const response = await fetchImage(imageUrl)

    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    const extension = ALLOWED_TYPES[contentType]
    if (!extension) {
      // An HTML error page is the common case here, and storing one as a
      // product photo would leave a broken image nobody can explain.
      return json({ error: 'IMAGE_TYPE_UNSUPPORTED' }, 400)
    }

    // Checked before reading where the server offers it, and again after, since
    // Content-Length is a claim rather than a fact.
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_BYTES) return json({ error: 'IMAGE_TOO_LARGE' }, 400)

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) return json({ error: 'IMAGE_URL_UNREACHABLE' }, 400)
    if (bytes.byteLength > MAX_BYTES) return json({ error: 'IMAGE_TOO_LARGE' }, 400)

    // --------------------------------------------------------------- store
    // Generated here. The source URL's filename is attacker-controlled text and
    // never becomes a path.
    const path = `${productId}/${crypto.randomUUID()}.${extension}`

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    })

    // What the product had before, so it can be removed once — and only once —
    // the replacement is safely stored and referenced.
    const { data: existing } = await admin
      .from('pos_products')
      .select('image_path')
      .eq('id', productId)
      .maybeSingle()

    const { error: uploadError } = await admin.storage
      .from('pos-product-images')
      .upload(path, bytes, { contentType, upsert: false })
    if (uploadError) {
      console.error('product image upload failed:', uploadError.message)
      return json({ error: 'IMAGE_STORE_FAILED' }, 502)
    }

    // Recorded through the same RPC the upload path uses, so this function
    // cannot write any column the manager could not write themselves.
    const { error: linkError } = await callerClient.rpc('set_pos_product_image', {
      _product_id: productId,
      _image_path: path,
    })
    if (linkError) {
      // Roll back the orphan rather than leave a file nothing points at.
      await admin.storage.from('pos-product-images').remove([path])
      console.error('product image link failed:', linkError.message)
      return json({ error: 'IMAGE_STORE_FAILED' }, 502)
    }

    // Only now. Deleting the old object before the new one is stored and linked
    // would mean a failure halfway leaves the product with no image at all.
    const previous = existing?.image_path
    if (previous && previous !== path) {
      const { error: removeError } = await admin.storage
        .from('pos-product-images')
        .remove([previous])
      // A leftover file is untidy; a broken product image is a real problem.
      if (removeError) console.error('previous image not removed:', removeError.message)
    }

    return json({ imagePath: path })
  } catch (err) {
    const code = err instanceof Error ? err.message : 'IMAGE_URL_INVALID'
    const known = [
      'IMAGE_URL_INVALID',
      'IMAGE_URL_SCHEME',
      'IMAGE_URL_BLOCKED',
      'IMAGE_URL_UNREACHABLE',
      'IMAGE_URL_REDIRECTS',
    ]
    if (known.includes(code)) return json({ error: code }, 400)

    console.error('import-pos-product-image unhandled:', code)
    return json({ error: 'We could not import that image. Please try again.' }, 500)
  }
})
