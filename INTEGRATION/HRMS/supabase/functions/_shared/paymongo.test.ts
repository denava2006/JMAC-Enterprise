import { describe, expect, it } from 'vitest'
import { expireCheckoutSession, readSessionState, settleSession } from './paymongo'

/**
 * The asymmetry these tests protect: wrongly deciding "not paid" expires a
 * session a customer may have paid, which loses their money. Wrongly deciding
 * "paid" or "cannot tell" only leaves an attempt pending, which costs a cashier
 * one button press. So every ambiguous case must fall on the cautious side.
 */

const session = (attrs: Record<string, unknown>) => ({ data: { id: 'cs_1', attributes: attrs } })

function stubFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`
    calls.push(key)
    const match = Object.keys(routes).find((r) => key.includes(r))
    const route = match ? routes[match] : { status: 404, body: { errors: [{ detail: 'no route' }] } }
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('reading whether a session was paid', () => {
  it('sees a paid payment on the session', () => {
    const s = readSessionState(session({ payments: [{ id: 'pay_1', attributes: { status: 'paid', amount: 10000 } }] }))
    expect(s).toEqual({ paid: true, paidCentavos: 10000, paymentId: 'pay_1', rawStatus: 'paid' })
  })

  it('sees a succeeded payment intent even with no payments array', () => {
    const s = readSessionState(session({ payment_intent: { attributes: { status: 'succeeded' } } }))
    expect(s.paid).toBe(true)
  })

  it('does not treat a failed payment as paid', () => {
    const s = readSessionState(session({ payments: [{ id: 'pay_1', attributes: { status: 'failed', amount: 10000 } }] }))
    expect(s.paid).toBe(false)
  })

  it('does not treat an awaiting intent as paid', () => {
    expect(readSessionState(session({ payment_intent: { attributes: { status: 'awaiting_payment_method' } } })).paid)
      .toBe(false)
  })

  it('reports not-paid for an empty or unrecognised payload rather than guessing', () => {
    expect(readSessionState({}).paid).toBe(false)
    expect(readSessionState(null).paid).toBe(false)
    expect(readSessionState(session({})).paid).toBe(false)
  })

  it('finds a paid payment among several', () => {
    const s = readSessionState(session({
      payments: [
        { id: 'pay_a', attributes: { status: 'failed', amount: 10000 } },
        { id: 'pay_b', attributes: { status: 'paid', amount: 10000 } },
      ],
    }))
    expect(s.paid).toBe(true)
    expect(s.paymentId).toBe('pay_b')
  })
})

describe('settling a session', () => {
  it('expires a session that was never paid', async () => {
    const { impl, calls } = stubFetch({
      'GET https://api.paymongo.com/v1/checkout_sessions/cs_1': { status: 200, body: session({}) },
      'POST https://api.paymongo.com/v1/checkout_sessions/cs_1/expire': { status: 200, body: session({}) },
    })
    expect(await settleSession('sk_test_x', 'cs_1', impl)).toEqual({ action: 'expire' })
    expect(calls.some((c) => c.startsWith('POST'))).toBe(true)
  })

  it('finalizes instead of expiring when the provider says it was paid', async () => {
    const { impl, calls } = stubFetch({
      'GET https://api.paymongo.com/v1/checkout_sessions/cs_1': {
        status: 200,
        body: session({ payments: [{ id: 'pay_1', attributes: { status: 'paid', amount: 10000 } }] }),
      },
    })
    expect(await settleSession('sk_test_x', 'cs_1', impl)).toEqual({
      action: 'finalize', paymentId: 'pay_1', paidCentavos: 10000,
    })
    // The crucial part: it must NOT have tried to expire a paid session.
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false)
  })

  it('leaves the attempt alone when the provider cannot be read', async () => {
    // A provider outage must never be read as "not paid, safe to kill".
    const { impl, calls } = stubFetch({
      'GET https://api.paymongo.com/v1/checkout_sessions/cs_1': { status: 500, body: null },
    })
    const out = await settleSession('sk_test_x', 'cs_1', impl)
    expect(out.action).toBe('leave')
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false)
  })

  it('finalizes when the customer pays in the gap between reading and expiring', async () => {
    // The genuine race: read says unpaid, expire is refused, and the re-read
    // shows why. Treating the refusal as a hard failure would strand a real
    // payment as pending forever.
    let reads = 0
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return { ok: false, status: 400, json: async () => ({ errors: [{ detail: 'already paid' }] }) } as unknown as Response
      }
      reads += 1
      const body = reads === 1
        ? session({})
        : session({ payments: [{ id: 'pay_late', attributes: { status: 'paid', amount: 10000 } }] })
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    }) as unknown as typeof fetch

    expect(await settleSession('sk_test_x', 'cs_1', impl)).toEqual({
      action: 'finalize', paymentId: 'pay_late', paidCentavos: 10000,
    })
  })

  it('leaves the attempt alone when expiry is refused for an unclear reason', async () => {
    const { impl } = stubFetch({
      'GET https://api.paymongo.com/v1/checkout_sessions/cs_1': { status: 200, body: session({}) },
      'POST https://api.paymongo.com/v1/checkout_sessions/cs_1/expire': {
        status: 400, body: { errors: [{ detail: 'something else' }] },
      },
    })
    const out = await settleSession('sk_test_x', 'cs_1', impl)
    expect(out.action).toBe('leave')
    if (out.action === 'leave') expect(out.reason).toContain('something else')
  })
})

describe('the expire call itself', () => {
  it('uses v1, because v2 has no expire endpoint', async () => {
    const { impl, calls } = stubFetch({
      'POST https://api.paymongo.com/v1/checkout_sessions/cs_9/expire': { status: 200, body: {} },
    })
    await expireCheckoutSession('sk_test_x', 'cs_9', impl)
    expect(calls[0]).toBe('POST https://api.paymongo.com/v1/checkout_sessions/cs_9/expire')
  })

  it('url-encodes the session id', async () => {
    const { impl, calls } = stubFetch({ 'POST': { status: 200, body: {} } })
    await expireCheckoutSession('sk_test_x', 'cs/../evil', impl)
    expect(calls[0]).toContain('cs%2F..%2Fevil')
  })
})
