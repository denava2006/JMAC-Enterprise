/**
 * Where a Supabase recovery link comes back to.
 *
 * Shared so the sender and the receiver cannot disagree: `resetPasswordForEmail`
 * builds `window.location.origin + RESET_PASSWORD_PATH`, and the router mounts
 * the page at exactly this path. Deriving the origin rather than configuring it
 * is what makes the same build work on localhost and on the production domain.
 *
 * Supabase still only honours a redirect that matches its allow-list, so both
 * origins have to be listed in the project's Auth settings. That is a dashboard
 * setting, not something this file can assert.
 */
export const RESET_PASSWORD_PATH = '/auth/reset-password'

/**
 * Where a first-time account setup link comes back to.
 *
 * Separate from RESET_PASSWORD_PATH on purpose. Somebody who has never had a
 * password is not "resetting" one, and the page that greets them says so. It is
 * also the route ProtectedRoute sends an un-activated employee to, so the
 * invitation must land on the same place the guards would.
 *
 * An invitation with no explicit redirect falls back to the project's Site URL,
 * which is the public landing page -- a signed-in employee stranded on a
 * marketing page with no indication they were meant to choose a password. That
 * is what this constant exists to prevent.
 */
export const SETUP_PASSWORD_PATH = '/auth/setup-password'

/** What Supabase appends to the redirect when a link has already been used or
 *  has expired. Both arrive in the URL fragment, not the query string. */
export interface RecoveryLinkError {
  code: string
  description: string
}

/**
 * Read an error out of a recovery redirect.
 *
 * Supabase puts these in the hash (`#error=...&error_description=...`) because
 * the fragment never reaches a server. A reused or expired link lands here, and
 * the difference matters to the person reading it: one means "you already did
 * this", the other means "ask for a new one".
 */
export function readRecoveryError(hash: string): RecoveryLinkError | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const params = new URLSearchParams(raw)
  const code = params.get('error_code') ?? params.get('error')
  if (!code) return null
  return {
    code,
    description: params.get('error_description')?.replace(/\+/g, ' ') ?? '',
  }
}

/**
 * One sentence for every bad link.
 *
 * Expired, already used and malformed are deliberately NOT told apart. The
 * reader's next action is the same in all three cases, and distinguishing them
 * would disclose whether a given link had ever been valid -- which is the same
 * enumeration leak the neutral "if an account exists" wording avoids on the
 * request side.
 */
export function describeRecoveryError(error: RecoveryLinkError | null): string | null {
  if (!error) return null
  return 'This password reset link is invalid or has expired.'
}
