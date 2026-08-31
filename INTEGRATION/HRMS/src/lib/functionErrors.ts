import { FunctionsHttpError } from '@supabase/supabase-js'

/**
 * Turn an Edge Function failure into something a person can act on.
 *
 * `supabase.functions.invoke()` throws a FunctionsHttpError whose `.message` is
 * always the same string — "Edge Function returned a non-2xx status code" —
 * regardless of what actually happened. The useful part is in the response
 * body, which has to be read separately.
 *
 * Three shapes turn up in practice, and they are not interchangeable:
 *
 *   { error: "This employee already has an account." }
 *       the function's own answer. Always preferred — it is the only one that
 *       knows anything about the request.
 *
 *   { message: "name resolution failed" }
 *       Kong, when the functions container is not running. A gateway fault.
 *
 *   { code: "BOOT_ERROR", message: "Worker failed to boot ..." }
 *       the Edge Runtime, when the worker cannot start. Also a gateway fault.
 *
 * The last two say nothing an administrator can act on and everything about
 * our internals, so they are reported as an outage instead. Both were observed
 * live while diagnosing the 503 this helper exists because of.
 */
export async function describeFunctionError(
  error: unknown,
  serviceName = 'service'
): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const status = error.context?.status
    const body = await error.context.json().catch(() => null)

    // The function's own message wins wherever it exists, at any status: the
    // 400 "already has an account" and the 404 "record not found" are the
    // answers worth showing.
    if (typeof body?.error === 'string' && body.error.trim()) return body.error

    // Gateway and runtime faults. A 5xx here is infrastructure, not a decision
    // about this request, and its wording ("name resolution failed") would only
    // mislead the person reading it.
    if (typeof status === 'number' && status >= 500) {
      return `The ${serviceName} is temporarily unavailable. Please try again, or contact the administrator if it continues.`
    }
    if (body?.code === 'BOOT_ERROR') {
      return `The ${serviceName} is temporarily unavailable. Please try again, or contact the administrator if it continues.`
    }

    // A non-JSON body means an HTML error page from somewhere in the chain.
    // Never surface it: it carries no answer and may carry internals.
    if (body === null) {
      return `The ${serviceName} did not respond correctly. Please try again, or contact the administrator if it continues.`
    }

    // A JSON body with only a runtime `message` (the 401 auth pre-check shape).
    if (typeof body?.msg === 'string' && body.msg.trim()) return body.msg.replace(/^Error:\s*/, '')
  }

  if (error instanceof Error) {
    // The generic invoke() message tells the reader nothing; anything else is
    // usually a network failure worth naming.
    if (/non-2xx status code/i.test(error.message)) {
      return `The ${serviceName} could not be reached. Please try again, or contact the administrator if it continues.`
    }
    if (/failed to fetch|networkerror|load failed/i.test(error.message)) {
      return 'Could not reach the server. Check your connection and try again.'
    }
    return error.message
  }

  return 'Something went wrong. Please try again.'
}
