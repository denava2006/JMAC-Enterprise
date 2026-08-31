// Hands an applicant a short-lived download link for a file that belongs to
// them — their signed employment contract, or a document HR filed against
// their new employee record.
//
// The `contracts` and `employee-documents` buckets are private and their
// storage policies only admit active HR staff, which is correct: applicants
// aren't Auth users and there is no session to scope a policy to. Signing a URL
// requires the service_role key, so it has to happen here rather than in the
// browser.
//
// This function does NOT decide ownership itself. It calls
// applicant_owns_file(), which re-checks the reference-code + email pairing
// against the application's own contract and documents — the same check every
// other applicant entry point makes. A path that doesn't belong to the caller
// is refused even though the key used to sign it could reach any object.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/** Long enough to click through and download, short enough that a leaked link
 * is worthless by the time it's shared. */
const SIGNED_URL_TTL_SECONDS = 120

const ALLOWED_BUCKETS = ['contracts', 'employee-documents']

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json().catch(() => null)
    const referenceCode: string | undefined = body?.referenceCode
    const email: string | undefined = body?.email
    const bucket: string | undefined = body?.bucket
    const path: string | undefined = body?.path

    if (!referenceCode || !email || !bucket || !path) {
      return json({ error: 'referenceCode, email, bucket, and path are all required.' }, 400)
    }
    if (!ALLOWED_BUCKETS.includes(bucket)) {
      return json({ error: 'That file cannot be downloaded from here.' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Elevated client — service_role key, server-side only, never sent to the browser.
    const adminClient = createClient(supabaseUrl, serviceRoleKey)

    const { data: owns, error: ownsError } = await adminClient.rpc('applicant_owns_file', {
      p_reference_code: referenceCode,
      p_email: email,
      p_bucket: bucket,
      p_path: path,
    })
    // The database's own message is not the applicant's business: it can name
    // tables and columns. Log it where an operator can read it and hand back
    // the same refusal they would get for any other bad request.
    if (ownsError) {
      console.error('applicant_owns_file failed:', ownsError.message)
      return json({ error: 'That file cannot be downloaded from here.' }, 400)
    }

    // Deliberately the same message whether the pairing was wrong or the file
    // simply isn't theirs — telling them apart would confirm which reference
    // codes exist.
    if (!owns) return json({ error: 'That file cannot be downloaded from here.' }, 403)

    const { data: signed, error: signError } = await adminClient.storage
      .from(bucket)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)

    if (signError || !signed?.signedUrl) {
      console.error('createSignedUrl failed:', signError?.message ?? 'no url returned')
      return json({ error: 'Could not prepare that download.' }, 400)
    }

    // SUPABASE_URL inside the runtime is the container-internal gateway
    // (http://kong:8000 on a local stack), a host the browser can't resolve.
    // Only the signed path and token are ours to hand back; the caller joins
    // it to whichever origin it already talks to.
    const marker = '/storage/v1/'
    const cut = signed.signedUrl.indexOf(marker)
    const signedPath = cut === -1 ? signed.signedUrl : signed.signedUrl.slice(cut)

    return json({ path: signedPath, expiresIn: SIGNED_URL_TTL_SECONDS })
  } catch (err) {
    // Never surface the thrown message: at this point it could be anything the
    // runtime produced, including connection strings in a driver error.
    console.error('applicant-file unhandled:', err instanceof Error ? err.message : err)
    return json({ error: 'Could not prepare that download.' }, 500)
  }
})
