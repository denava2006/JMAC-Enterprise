/** Where the applicant's tracking session lives.
 *
 * Applicants aren't Supabase Auth users, so there's no token to hang a session
 * on — their "login" is a reference code plus the email they applied with.
 * Holding that in component state meant the session died the moment they
 * clicked Careers or Home, since the page unmounts.
 *
 * `sessionStorage` (not `localStorage`) is the deliberate choice: the pair is
 * enough to read personal details and respond to a job offer, so it should not
 * outlive the browser tab. Closing the tab, clearing site data, or the expiry
 * below all end the session, as does the Sign out button.
 */

// Deliberately NOT renamed with the JMAC rebrand: this key is what an
// applicant's in-progress tracking session is stored under, so changing it
// would sign out everyone mid-application to fix a string nobody can see.
const STORAGE_KEY = 'harmony.applicant-session'

/** Long enough to browse the careers site and come back, short enough that an
 * unattended shared computer doesn't stay signed in all day. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000

export interface ApplicantSession {
  referenceCode: string
  email: string
}

interface StoredSession extends ApplicantSession {
  expiresAt: number
}

export function loadApplicantSession(): ApplicantSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (!parsed.referenceCode || !parsed.email || !parsed.expiresAt) return null
    if (Date.now() > parsed.expiresAt) {
      sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    return { referenceCode: parsed.referenceCode, email: parsed.email }
  } catch {
    // Private-browsing modes can throw on storage access; a missing session is
    // the right answer there rather than a crashed page.
    return null
  }
}

export function saveApplicantSession(session: ApplicantSession): void {
  try {
    const stored: StoredSession = { ...session, expiresAt: Date.now() + SESSION_TTL_MS }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // Non-fatal: the session just won't survive navigation.
  }
}

export function clearApplicantSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do — there's no session to leak if storage is unavailable.
  }
}
