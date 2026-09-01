/**
 * The PayMongo calls JMAC makes after a checkout has been created.
 *
 * Split out from the functions that use it for two reasons: the sweeper and the
 * cancel endpoint need exactly the same "is it paid, and can I kill it" logic,
 * and reading the provider's answer is the part most worth testing. Getting
 * `readSessionState` wrong in the pessimistic direction expires a session the
 * customer already paid for.
 *
 * Note the API versions. Checkout sessions are CREATED on /v2, but retrieve and
 * expire only exist on /v1 -- /v2/checkout_sessions/{id}/expire returns 404,
 * confirmed against this account. That asymmetry is PayMongo's, not a mistake
 * here, so it is pinned per-call rather than shared.
 */

const V1 = 'https://api.paymongo.com/v1'

export interface PaymongoSessionState {
  /** True only when the provider actually shows a successful payment. */
  paid: boolean
  paidCentavos: number | null
  paymentId: string | null
  rawStatus: string | null
}

/**
 * Decide whether a checkout session has been paid.
 *
 * Deliberately looks for positive evidence of payment rather than absence of
 * evidence: an unrecognised payload shape reports `paid: false` for the fields
 * but the caller still refuses to expire on a failed *request*, so a provider
 * outage can never be read as "not paid, safe to kill".
 */
export function readSessionState(body: unknown): PaymongoSessionState {
  const attrs = (body as { data?: { attributes?: Record<string, unknown> } })?.data?.attributes ?? {}

  const payments = Array.isArray(attrs.payments) ? attrs.payments : []
  for (const p of payments) {
    const pa = (p as { id?: string; attributes?: Record<string, unknown> })?.attributes ?? {}
    if (pa.status === 'paid') {
      return {
        paid: true,
        paidCentavos: typeof pa.amount === 'number' ? pa.amount : null,
        paymentId: (p as { id?: string })?.id ?? null,
        rawStatus: 'paid',
      }
    }
  }

  const intentStatus = (attrs.payment_intent as { attributes?: { status?: string } } | undefined)
    ?.attributes?.status ?? null

  if (intentStatus === 'succeeded') {
    return { paid: true, paidCentavos: null, paymentId: null, rawStatus: intentStatus }
  }

  return {
    paid: false,
    paidCentavos: null,
    paymentId: null,
    rawStatus: intentStatus ?? (typeof attrs.status === 'string' ? attrs.status : null),
  }
}

function authHeader(secret: string) {
  return 'Basic ' + btoa(`${secret}:`)
}

export interface ProviderResult<T> {
  ok: boolean
  status: number
  data: T | null
  detail: string | null
}

export async function getCheckoutSession(
  secret: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderResult<unknown>> {
  const res = await fetchImpl(`${V1}/checkout_sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: authHeader(secret) },
  })
  const body = await res.json().catch(() => null)
  return {
    ok: res.ok,
    status: res.status,
    data: body,
    detail: res.ok ? null : String(
      (body as { errors?: { detail?: string }[] })?.errors?.[0]?.detail ?? `HTTP ${res.status}`
    ).slice(0, 300),
  }
}

/**
 * Expire a checkout session so its URL can never be paid again.
 *
 * A 4xx here is not always a failure worth retrying: PayMongo refuses to expire
 * a session that has already been paid, which is precisely the answer the
 * caller needs. The caller distinguishes them by re-reading the session.
 */
export async function expireCheckoutSession(
  secret: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderResult<unknown>> {
  const res = await fetchImpl(`${V1}/checkout_sessions/${encodeURIComponent(sessionId)}/expire`, {
    method: 'POST',
    headers: { Authorization: authHeader(secret), 'Content-Type': 'application/json' },
  })
  const body = await res.json().catch(() => null)
  return {
    ok: res.ok,
    status: res.status,
    data: body,
    detail: res.ok ? null : String(
      (body as { errors?: { detail?: string }[] })?.errors?.[0]?.detail ?? `HTTP ${res.status}`
    ).slice(0, 300),
  }
}

export type SettleOutcome =
  | { action: 'finalize'; paymentId: string | null; paidCentavos: number | null }
  | { action: 'expire' }
  | { action: 'leave'; reason: string }

/**
 * The decision both the sweep and the cancel button need.
 *
 * Reads the session, then either says "this was paid, finalize it" or "this is
 * dead, expire it". Anything it cannot establish is left alone: an attempt that
 * stays pending costs a cashier one more Cancel press, whereas wrongly expiring
 * a paid session costs a customer their money.
 */
export async function settleSession(
  secret: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SettleOutcome> {
  const read = await getCheckoutSession(secret, sessionId, fetchImpl)
  if (!read.ok) {
    return { action: 'leave', reason: `could not read session: ${read.detail}` }
  }

  const state = readSessionState(read.data)
  if (state.paid) {
    return { action: 'finalize', paymentId: state.paymentId, paidCentavos: state.paidCentavos }
  }

  const expired = await expireCheckoutSession(secret, sessionId, fetchImpl)
  if (expired.ok) return { action: 'expire' }

  // Refused. Re-read rather than assume why: the common reason is that the
  // customer paid in the moment between the read and the expire.
  const again = await getCheckoutSession(secret, sessionId, fetchImpl)
  if (again.ok) {
    const now = readSessionState(again.data)
    if (now.paid) {
      return { action: 'finalize', paymentId: now.paymentId, paidCentavos: now.paidCentavos }
    }
  }
  return { action: 'leave', reason: `expire refused: ${expired.detail}` }
}
