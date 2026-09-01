// Start a PayMongo Hosted Checkout for a POS sale. Test mode only.
//
// Why Hosted Checkout v2 rather than Payment Intents: a capability probe
// against this account confirmed /v2/checkout_sessions accepts card, gcash,
// paymaya and qrph, all with livemode false. Hosted Checkout keeps card entry
// on PayMongo's page, so JMAC never receives a PAN, a CVC or an expiry, and one
// integration covers all four methods. Payment Intents would mean building card
// capture and 3DS handling here for no gain.
//
// The single most important property of this function: the browser does not
// decide the amount. It names a branch and a cart; the server prices that cart
// from the branch's own catalogue and charges the result. A client that sends
// a total is ignored, because it is never read.

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

const METHODS = ['gcash', 'paymaya', 'card', 'qrph'] as const
const APP_ORIGIN = 'https://jmac-enterprise.vercel.app'

/** PayMongo's documented floor for these methods is PHP 1.00. */
const MIN_CENTAVOS = 100

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const secret = Deno.env.get('PAYMONGO_SECRET_KEY')

    if (!secret) return json({ error: 'Card and wallet payments are not configured.' }, 503)

    // Never start a payment that cannot be finalized.
    //
    // The sale is created by the webhook and by nothing else, so without the
    // webhook secret every payment taken here would be money collected against
    // a sale that can never exist -- each one a manual refund. Refusing up
    // front makes a half-configured integration visibly unavailable instead of
    // quietly harmful.
    if (!Deno.env.get('PAYMONGO_WEBHOOK_SECRET')) {
      console.error('PAYMONGO_WEBHOOK_SECRET is not set; refusing to start payments.')
      return json({ error: 'Online payments are not available yet. Take another payment method.' }, 503)
    }

    // Test mode is asserted here, not assumed. A live key must never reach this
    // phase, and refusing before the call means no real money can move even if
    // the key is swapped underneath us.
    if (!secret.startsWith('sk_test_')) {
      console.error('PAYMONGO_SECRET_KEY is not a test key; refusing.')
      return json({ error: 'Payment provider is not in test mode. Refusing.' }, 503)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization header.' }, 401)

    const caller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data: { user }, error: userError } = await caller.auth.getUser()
    if (userError || !user) return json({ error: 'Not authenticated.' }, 401)

    const body = await req.json().catch(() => null)
    const branchId: string | undefined = body?.branchId
    const method: string | undefined = body?.method
    const checkoutKey: string | undefined = body?.checkoutKey
    const items = body?.items

    if (!branchId || !method || !checkoutKey || !Array.isArray(items) || items.length === 0) {
      return json({ error: 'branchId, method, checkoutKey and items are all required.' }, 400)
    }
    if (!METHODS.includes(method as typeof METHODS[number])) {
      return json({ error: 'Unsupported payment method.' }, 400)
    }

    // POS authority for THIS branch, decided by the database. A cashier at one
    // branch cannot start a payment for another, and the check is the same
    // has_pos_role() every POS screen uses -- which since Phase 9A also means
    // their position must still make them eligible.
    const { data: allowed, error: roleError } = await caller.rpc('has_pos_role', {
      _branch_id: branchId,
      _roles: ['cashier', 'manager'],
    })
    if (roleError || allowed !== true) {
      return json({ error: 'You do not have POS access at that branch.' }, 403)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey)

    // If this checkout key already has an attempt, return it rather than
    // creating a second provider session. This is what makes a double-clicked
    // Pay button, a refresh mid-redirect and a retried request all converge.
    const { data: existing } = await admin
      .from('pos_payment_attempts')
      .select('id, status, checkout_url, amount_centavos, provider_checkout_session_id, method')
      .eq('checkout_key', checkoutKey)
      .maybeSingle()

    if (existing) {
      if (existing.status === 'paid') {
        return json({ error: 'That sale has already been paid.', status: 'paid' }, 409)
      }
      if (existing.status === 'pending' && existing.checkout_url) {
        return json({
          attemptId: existing.id,
          checkoutUrl: existing.checkout_url,
          amountCentavos: existing.amount_centavos,
          method: existing.method,
          reused: true,
          testMode: true,
        })
      }
      return json({ error: `That payment is ${existing.status}. Start a new sale.` }, 409)
    }

    // ---- the amount, priced by the database ------------------------------
    // The client sends product ids and quantities, never a price and never a
    // total. price_pos_cart applies the same rules checkout_pos_sale will apply
    // when this becomes a sale: branch override else product default, then
    // branch fees, each rounded before summing.
    //
    // Pricing here in TypeScript was the original approach and it was wrong:
    // it summed the line prices and ignored branch_pos_settings.fees entirely,
    // so every branch with a configured fee would have been undercharged.
    const lines: { product_id: string; quantity: number }[] = []
    for (const raw of items) {
      const productId = raw?.productId ?? raw?.product_id
      const quantity = Number(raw?.quantity)
      if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
        return json({ error: 'Each cart line needs a product and a whole quantity of 1-999.' }, 400)
      }
      lines.push({ product_id: productId, quantity })
    }

    const { data: pricing, error: priceError } = await admin
      .rpc('price_pos_cart', { _branch_id: branchId, _items: lines })

    if (priceError || !pricing) {
      // The database's message here is a cashier-facing one ("One of those
      // products is no longer available at this branch"), so it is safe to show.
      console.error('pricing failed:', priceError?.message)
      return json({ error: priceError?.message ?? 'Could not price that cart.' }, 400)
    }

    const amountCentavos = Number(pricing.total_centavos)
    const feesCentavos = Math.round(Number(pricing.fees_total) * 100)

    if (!Number.isInteger(amountCentavos) || amountCentavos < MIN_CENTAVOS) {
      return json({ error: 'The provider requires a total of at least PHP 1.00.' }, 400)
    }

    // Line items for the provider's page. selling_price is numeric(12,2), so
    // pesos-to-centavos is exact and the parts must sum to the whole; if they
    // ever do not, refuse rather than charge a total the receipt won't match.
    const payMongoLines: { name: string; amount: number; currency: string; quantity: number }[] =
      (pricing.lines as { name: string; quantity: number; unit_price: string }[]).map((l) => ({
        name: l.name,
        amount: Math.round(Number(l.unit_price) * 100),
        currency: 'PHP',
        quantity: l.quantity,
      }))

    if (feesCentavos > 0) {
      payMongoLines.push({ name: 'Service fees', amount: feesCentavos, currency: 'PHP', quantity: 1 })
    }

    const lineSum = payMongoLines.reduce((sum, l) => sum + l.amount * l.quantity, 0)
    if (lineSum !== amountCentavos) {
      console.error(`line items sum to ${lineSum}, cart totals ${amountCentavos}`)
      return json({ error: 'Could not price that cart.' }, 400)
    }

    // A JMAC-owned reference: traceable to exactly one checkout, and carrying
    // nothing about the employee, the customer or the database.
    const reference = `JMAC-POS-${checkoutKey.replace(/-/g, '').slice(0, 12).toUpperCase()}`

    // Recorded BEFORE the provider call, so a session that is created but whose
    // response is lost is still ours to reconcile rather than an orphan.
    const { data: attempt, error: insertError } = await admin
      .from('pos_payment_attempts')
      .insert({
        branch_id: branchId,
        cashier_profile_id: user.id,
        checkout_key: checkoutKey,
        method,
        amount_centavos: amountCentavos,
        items: lines,
        reference_number: reference,
        livemode: false,
      })
      .select('id')
      .single()

    if (insertError || !attempt) {
      // A unique violation means another request won the race with the same
      // key; that is the idempotency working, so read theirs back.
      const { data: raced } = await admin
        .from('pos_payment_attempts')
        .select('id, checkout_url, amount_centavos, method')
        .eq('checkout_key', checkoutKey)
        .maybeSingle()
      if (raced?.checkout_url) {
        return json({
          attemptId: raced.id, checkoutUrl: raced.checkout_url,
          amountCentavos: raced.amount_centavos, method: raced.method,
          reused: true, testMode: true,
        })
      }
      console.error('attempt insert failed:', insertError?.message)
      return json({ error: 'Could not start that payment.' }, 400)
    }

    // ---- the provider call ----------------------------------------------
    const res = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${secret}:`),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          attributes: {
            line_items: payMongoLines,
            payment_method_types: [method],
            reference_number: reference,
            description: `JMAC POS ${reference}`,
            success_url: `${APP_ORIGIN}/pos/till?attempt=${encodeURIComponent(checkoutKey)}`,
            cancel_url: `${APP_ORIGIN}/pos/till?attempt=${encodeURIComponent(checkoutKey)}&cancelled=1`,
            // Metadata is echoed back on the webhook, so the attempt can be
            // found without trusting anything the browser carries.
            metadata: { jmac_attempt_id: attempt.id, jmac_reference: reference },
          },
        },
      }),
    })

    const providerBody = await res.json().catch(() => null)

    if (!res.ok) {
      const detail = (providerBody?.errors?.[0]?.detail ?? `HTTP ${res.status}`).slice(0, 300)
      console.error('checkout_session create failed:', detail)
      await admin.from('pos_payment_attempts')
        .update({ status: 'failed', failed_at: new Date().toISOString(), last_error: detail })
        .eq('id', attempt.id)
      return json({ error: 'The payment provider could not start that payment.' }, 502)
    }

    const attrs = providerBody?.data?.attributes ?? {}

    const livemode = attrs.livemode ?? attrs.live_mode ?? false

    if (livemode === true) {
      // Belt and braces: the key said test, the object says live. Refuse and
      // leave nothing payable behind.
      console.error('provider returned livemode=true under a test key; refusing.')
      await admin.from('pos_payment_attempts')
        .update({ status: 'failed', failed_at: new Date().toISOString(), last_error: 'livemode true' })
        .eq('id', attempt.id)
      return json({ error: 'Payment provider is not in test mode. Refusing.' }, 503)
    }

    const sessionId: string | null = providerBody?.data?.id ?? null
    const checkoutUrl: string | null = attrs.checkout_url ?? attrs.url ?? null

    // What v2 actually returns, confirmed by logging the response keys against
    // this account: checkout_url, livemode, created_at, updated_at. There is no
    // payment intent id and no expiry, so neither is stored here -- the earlier
    // code read attrs.payment_intent and attrs.expires_at and silently wrote
    // NULL every time, which is why a payment.failed event had nothing to match
    // on. The webhook now identifies those by the JMAC reference instead.
    await admin.from('pos_payment_attempts')
      .update({
        provider_checkout_session_id: sessionId,
        checkout_url: checkoutUrl,
        livemode: false,
      })
      .eq('id', attempt.id)

    // Only safe data goes back: no key, no provider payload, no card fields.
    return json({
      attemptId: attempt.id,
      checkoutUrl,
      amountCentavos,
      method,
      reference,
      testMode: true,
    })
  } catch (err) {
    console.error('create-paymongo-checkout unhandled:', err instanceof Error ? err.message : err)
    return json({ error: 'Could not start that payment.' }, 500)
  }
})
