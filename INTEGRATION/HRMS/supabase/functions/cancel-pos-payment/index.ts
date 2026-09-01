// Cancel an online payment from the till.
//
// This exists because cancelling used to be a plain RPC the browser called,
// which marked the attempt cancelled locally and left the PayMongo session
// live. That is the one sequence that lets a customer pay a basket the shop has
// already written off: the till has forgotten the sale, but the URL still
// works.
//
// So cancellation is now server-mediated and ordered: verify the cashier may
// touch this branch, kill the session at PayMongo, and only then record the
// cancellation. If PayMongo says the payment already succeeded, the request is
// refused and the payment is finalized into a sale instead -- the customer's
// money has moved and a sale must exist for it.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { settleSession } from '../_shared/paymongo.ts'

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const secret = Deno.env.get('PAYMONGO_SECRET_KEY')
    if (!secret) return json({ error: 'Online payments are not configured.' }, 503)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization header.' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const caller = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data: { user }, error: userError } = await caller.auth.getUser()
    if (userError || !user) return json({ error: 'Not authenticated.' }, 401)

    const body = await req.json().catch(() => null)
    const checkoutKey: string | undefined = body?.checkoutKey
    if (!checkoutKey) return json({ error: 'A checkout key is required.' }, 400)

    const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Which payment, and whose branch. Read with the service role because the
    // caller may not see the row until we know they are allowed to.
    const { data: attempt } = await admin
      .from('pos_payment_attempts')
      .select('id, branch_id, status, provider_checkout_session_id')
      .eq('checkout_key', checkoutKey)
      .maybeSingle()

    if (!attempt) return json({ error: 'Unknown payment.' }, 404)

    // Branch authority decided by the database, running AS THE CALLER, using
    // the same has_pos_role() every other POS surface uses -- so a cashier
    // cannot cancel another branch's payment by knowing its key, and a revoked
    // cashier cannot cancel at all.
    const { data: allowed, error: authzError } = await caller.rpc('has_pos_role', {
      _branch_id: attempt.branch_id,
      _roles: ['cashier', 'manager'],
    })
    if (authzError || allowed !== true) {
      return json({ error: 'You do not have POS access at that branch.' }, 403)
    }

    const row = {
      attempt_id: attempt.id,
      status: attempt.status,
      provider_checkout_session_id: attempt.provider_checkout_session_id,
    }

    if (row.status === 'paid') {
      return json({ error: 'That payment already succeeded. It cannot be cancelled.', status: 'paid' }, 409)
    }
    if (row.status !== 'pending') {
      return json({ ok: true, status: row.status, unchanged: true })
    }

    // Nothing was ever created at the provider, so nothing can be paid.
    if (!row.provider_checkout_session_id) {
      const { data: won } = await admin.rpc('mark_pos_payment_state', {
        _attempt_id: row.attempt_id, _status: 'cancelled', _reason: 'cancelled at the till',
      })
      return json({ ok: true, status: won ? 'cancelled' : 'unchanged' })
    }

    const outcome = await settleSession(secret, row.provider_checkout_session_id)

    if (outcome.action === 'finalize') {
      // Refuse the cancellation. The money moved, so a sale must exist for it;
      // finalize through the same routine the webhook uses.
      const { data: result } = await admin.rpc('finalize_pos_payment', {
        _attempt_id: row.attempt_id,
        _provider_payment_id: outcome.paymentId,
        _paid_centavos: outcome.paidCentavos,
      })
      console.log(`cancel refused, payment already succeeded: ${row.attempt_id}`)
      return json({
        error: 'The customer has already paid. Completing the sale instead.',
        status: (result as { status?: string })?.status ?? 'paid',
        finalized: true,
      }, 409)
    }

    if (outcome.action === 'leave') {
      // The provider could not confirm the session is dead. Cancelling anyway
      // would leave a payable URL behind.
      console.error(`cancel could not settle ${row.attempt_id}: ${outcome.reason}`)
      return json({ error: 'Could not reach the payment provider. Try again in a moment.' }, 502)
    }

    const { data: won } = await admin.rpc('mark_pos_payment_state', {
      _attempt_id: row.attempt_id, _status: 'cancelled', _reason: 'cancelled at the till',
    })

    // Losing the compare-and-set means a webhook finalized it a moment ago.
    if (!won) {
      const { data: current } = await admin
        .from('pos_payment_attempts')
        .select('status')
        .eq('id', row.attempt_id)
        .maybeSingle()
      return json({ ok: true, status: current?.status ?? 'unchanged', unchanged: true })
    }

    console.log(`cancelled ${row.attempt_id} and expired its session`)
    return json({ ok: true, status: 'cancelled' })
  } catch (err) {
    console.error('cancel-pos-payment unhandled:', err instanceof Error ? err.message : err)
    return json({ error: 'Could not cancel that payment.' }, 500)
  }
})
