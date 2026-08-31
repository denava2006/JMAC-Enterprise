// PayMongo webhook: the only thing that may turn a payment into a sale.
//
// This endpoint is public and unauthenticated -- PayMongo cannot present a
// Supabase JWT -- so the signature IS the authentication. Anyone on the
// internet can POST here, and the only reason a request is believed is that it
// carries a valid HMAC over its own raw body using a secret only PayMongo and
// this function know. Every early return below exists because skipping it
// would let a stranger mark an unpaid basket as paid.
//
// Two rules follow from that, and neither is negotiable:
//
//   * The signature is verified over the RAW body, before the JSON is parsed.
//     Parsing and re-serialising changes bytes (key order, whitespace, number
//     formatting) and the HMAC would no longer match what PayMongo signed.
//
//   * No secret is ever compared with ===. String equality short-circuits on
//     the first differing byte, which leaks the position of the mismatch to a
//     patient attacker. timingSafeEqual compares every byte regardless.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyPaymongoSignature } from '../_shared/paymongoSignature.ts'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Webhook deliveries older than this are refused, so a signature captured
 *  from an old request cannot be replayed indefinitely. */
const TOLERANCE_SECONDS = 300

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    const webhookSecret = Deno.env.get('PAYMONGO_WEBHOOK_SECRET')
    if (!webhookSecret) {
      console.error('PAYMONGO_WEBHOOK_SECRET is not set; refusing every delivery.')
      return json({ error: 'Webhook not configured.' }, 503)
    }

    // Raw bytes, before any parsing. See the note at the top.
    const rawBody = await req.text()

    const header = req.headers.get('paymongo-signature') ?? req.headers.get('Paymongo-Signature')

    const verified = await verifyPaymongoSignature({
      header,
      rawBody,
      secret: webhookSecret,
      toleranceSeconds: TOLERANCE_SECONDS,
    })

    if (!verified.ok) {
      // The reason is logged but never returned: telling an attacker whether
      // they got the timestamp wrong or the HMAC wrong is free information.
      console.error(`webhook signature rejected: ${verified.reason}`)
      return json({ error: 'Invalid signature.' }, 401)
    }

    // ---- only past this line is the payload trusted ----------------------

    const event = JSON.parse(rawBody)
    const eventAttrs = event?.data?.attributes ?? {}
    const eventType: string = eventAttrs.type ?? ''
    const resource = eventAttrs.data ?? {}
    const resourceAttrs = resource?.attributes ?? {}

    if (eventAttrs.livemode === true || resourceAttrs.livemode === true) {
      console.error('refusing a live-mode webhook in a test-only integration')
      return json({ error: 'Live mode is not accepted.' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceRoleKey)

    // Find the attempt without trusting anything a browser could have shaped.
    // Metadata first (we set it at creation), then the provider's own ids.
    const metadata = resourceAttrs.metadata ?? {}
    let attemptId: string | null = metadata.jmac_attempt_id ?? null

    if (!attemptId) {
      const sessionId: string | null =
        resource?.id ??
        resourceAttrs.checkout_session_id ??
        null
      const reference: string | null = resourceAttrs.reference_number ?? metadata.jmac_reference ?? null

      const query = admin.from('pos_payment_attempts').select('id').limit(1)
      const { data: found } = sessionId
        ? await query.eq('provider_checkout_session_id', sessionId).maybeSingle()
        : reference
          ? await query.eq('reference_number', reference).maybeSingle()
          : { data: null }
      attemptId = found?.id ?? null
    }

    if (!attemptId) {
      // 200, not 404: the delivery was authentic, it just isn't ours to act on
      // (another integration on the same account, or an event type we don't
      // handle). A non-2xx would make PayMongo retry it forever.
      console.log(`no matching attempt for event ${eventType}`)
      return json({ received: true, matched: false })
    }

    // The amount the provider actually collected, in centavos.
    const paidCentavos: number | null =
      typeof resourceAttrs.amount === 'number'
        ? resourceAttrs.amount
        : typeof resourceAttrs.payments?.[0]?.attributes?.amount === 'number'
          ? resourceAttrs.payments[0].attributes.amount
          : null

    const providerPaymentId: string | null =
      resourceAttrs.payments?.[0]?.id ?? resource?.id ?? null

    if (eventType === 'checkout_session.payment.paid' || eventType === 'payment.paid') {
      // finalize_pos_payment does the rest: it re-checks the amount, re-prices
      // the cart, and creates the sale through the one real checkout_pos_sale.
      // It is idempotent, so a redelivery of this same event is harmless.
      const { data: result, error } = await admin.rpc('finalize_pos_payment', {
        _attempt_id: attemptId,
        _provider_payment_id: providerPaymentId,
        _paid_centavos: paidCentavos,
      })

      if (error) {
        // 500 so PayMongo retries: the payment is real and the sale is missing,
        // which is exactly the case worth retrying.
        console.error('finalize_pos_payment failed:', error.message)
        return json({ error: 'Could not finalize.' }, 500)
      }

      console.log(`attempt ${attemptId} -> ${result?.status}`)
      return json({ received: true, status: result?.status })
    }

    if (eventType === 'payment.failed') {
      await admin.rpc('mark_pos_payment_state', {
        _attempt_id: attemptId, _status: 'failed', _reason: 'provider reported payment failed',
      })
      return json({ received: true, status: 'failed' })
    }

    if (eventType === 'checkout_session.expired') {
      await admin.rpc('mark_pos_payment_state', {
        _attempt_id: attemptId, _status: 'expired', _reason: 'checkout session expired',
      })
      return json({ received: true, status: 'expired' })
    }

    return json({ received: true, ignored: eventType })
  } catch (err) {
    console.error('paymongo-webhook unhandled:', err instanceof Error ? err.message : err)
    return json({ error: 'Webhook error.' }, 500)
  }
})
