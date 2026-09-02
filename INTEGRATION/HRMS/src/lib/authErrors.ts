/**
 * What actually went wrong when signing in.
 *
 * Every non-network failure was reported as "that email and password
 * combination doesn't match our records", which sent people hunting for a typo
 * when the real problem was a stale session, a rate limit, or Auth having a bad
 * minute. During hosted role-switching that produced the worst possible advice:
 * refresh the page a few times and try again.
 *
 * Provider text is never shown. These map to sentences written for the person
 * reading them, and the raw message stays in the console for whoever is
 * debugging.
 */

export type AuthFailure =
  | 'invalid_credentials'
  | 'session_expired'
  | 'email_not_confirmed'
  | 'rate_limited'
  | 'deactivated'
  | 'setup_incomplete'
  | 'transient'
  | 'unknown'

export interface ClassifiedAuthError {
  failure: AuthFailure
  message: string
  /** Only a transient fault is worth retrying. Retrying a rejection just
   *  rejects again, and retrying a rate limit makes it worse. */
  retryable: boolean
}

const MESSAGES: Record<AuthFailure, string> = {
  invalid_credentials: 'That email and password combination doesn’t match our records.',
  session_expired: 'Your previous session expired. Please sign in again.',
  email_not_confirmed: 'This account’s email address has not been confirmed yet.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
  deactivated: 'This account has been deactivated. Contact your administrator.',
  setup_incomplete:
    'This account still needs to finish password setup. Check your setup email or use Forgot password.',
  transient: 'We couldn’t complete sign-in right now. Please try again.',
  unknown: 'We couldn’t complete sign-in right now. Please try again.',
}

export function messageFor(failure: AuthFailure): string {
  return MESSAGES[failure]
}

interface RawAuthError {
  code?: string
  status?: number
  message?: string
  name?: string
}

/**
 * Classify without trusting any single field.
 *
 * supabase-js supplies `code` on recent versions, `status` mostly, and
 * `message` always. Older releases and fetch-level failures supply less, so
 * each signal is checked in order of how much it can be trusted.
 */
export function classifyAuthError(error: unknown): ClassifiedAuthError {
  const err = (error ?? {}) as RawAuthError
  const code = (err.code ?? '').toLowerCase()
  const message = (err.message ?? '').toLowerCase()
  const status = err.status

  const as = (failure: AuthFailure, retryable = false): ClassifiedAuthError => ({
    failure,
    message: MESSAGES[failure],
    retryable,
  })

  // A fetch that never reached Auth has no status at all. So does an aborted
  // request and a DNS failure -- all of them are worth exactly one retry.
  const looksLikeNetwork =
    err.name === 'TypeError' ||
    err.name === 'AbortError' ||
    /failed to fetch|networkerror|network request failed|timeout|timed out|abort/.test(message)

  if (looksLikeNetwork) return as('transient', true)
  if (status !== undefined && status >= 500) return as('transient', true)
  if (status === 0) return as('transient', true)

  if (code === 'over_request_rate_limit' || status === 429) return as('rate_limited')

  if (
    code === 'refresh_token_not_found' ||
    code === 'session_not_found' ||
    code === 'session_expired' ||
    /refresh token|session (not found|missing|expired)|jwt expired/.test(message)
  ) {
    return as('session_expired')
  }

  if (code === 'email_not_confirmed' || /email not confirmed/.test(message)) {
    return as('email_not_confirmed')
  }

  if (
    code === 'invalid_credentials' ||
    /invalid login credentials|invalid email or password/.test(message)
  ) {
    // Deliberately not probed further. Telling somebody "this account exists
    // but has no password yet" answers, for anyone who asks, whether an email
    // is registered here. The Forgot password path covers the real case
    // without saying which accounts exist.
    return as('invalid_credentials')
  }

  if (status === 400 || status === 401 || status === 403) return as('invalid_credentials')

  // No status, no code, nothing recognisable in the message. Say the honest
  // thing rather than accusing somebody of mistyping their password.
  return as('unknown')
}
