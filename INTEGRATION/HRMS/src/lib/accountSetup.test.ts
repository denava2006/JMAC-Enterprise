/** First-time account setup — contract tests.
 *
 * An invited employee received the invitation, clicked it, and landed on the
 * public marketing page holding a valid session, with nothing telling them they
 * were supposed to choose a password.
 *
 * Nothing was broken in the setup page or the route guards. inviteUserByEmail
 * was called with no redirectTo, so Supabase fell back to the project's Site
 * URL -- the landing page. Because that page is public, no guard ran to correct
 * the mistake. The one line that would have sent them to the right place was
 * the line that was missing.
 *
 * These lock down the rule in both directions: the sender must name the
 * destination, and it must be the same destination the guards use.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RESET_PASSWORD_PATH, SETUP_PASSWORD_PATH } from './passwordRecovery'

const root = join(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8')

const employeeFn = read('supabase', 'functions', 'create-employee-account', 'index.ts')
const hrFn = read('supabase', 'functions', 'create-hr-account', 'index.ts')
const guard = read('src', 'components', 'ProtectedRoute.tsx')
const app = read('src', 'App.tsx')

describe('the setup destination', () => {
  it('is a route the app actually serves', () => {
    expect(app).toContain(`path="${SETUP_PASSWORD_PATH}"`)
  })

  it('is where the guards send an un-activated employee', () => {
    // Sender and guard must agree, or the employee ping-pongs between them.
    expect(guard).toContain(SETUP_PASSWORD_PATH)
  })

  it('is not the password reset page', () => {
    // Somebody who has never had a password is not resetting one.
    expect(SETUP_PASSWORD_PATH).not.toBe(RESET_PASSWORD_PATH)
  })

  it('is reachable without being signed in first', () => {
    // The invited user arrives with a session but no completed setup. If this
    // route sat behind the ordinary portal guard it would never render.
    const routeLine = app.split('\n').find((l) => l.includes(`path="${SETUP_PASSWORD_PATH}"`))
    expect(routeLine).toBeDefined()
    expect(routeLine).not.toContain('ProtectedRoute')
  })
})

describe.each([
  ['create-employee-account', employeeFn],
  ['create-hr-account', hrFn],
])('%s', (_name, source) => {
  it('tells Supabase where the invitation should land', () => {
    expect(source).toContain('inviteUserByEmail')
    expect(source).toContain('redirectTo')
  })

  it('sends it to the setup page', () => {
    expect(source).toContain(SETUP_PASSWORD_PATH)
  })

  it('does not fall back to the project Site URL', () => {
    // The fallback is the landing page, and it looks like success.
    expect(source).toContain('APP_URL is not configured')
    const guardAt = source.indexOf('APP_URL is not configured')
    const inviteAt = source.indexOf('inviteUserByEmail(')
    expect(guardAt).toBeGreaterThan(-1)
    expect(inviteAt).toBeGreaterThan(guardAt)
  })

  it('reads the base URL from configuration, not a literal', () => {
    expect(source).toContain("Deno.env.get('APP_URL')")
    expect(source).not.toMatch(/redirectTo:\s*['"]https?:\/\//)
  })

  it('still never transmits a password', () => {
    expect(source).not.toMatch(/password:\s*['"][^'"]+['"]/)
  })
})

describe('the invitation is not a sign-in link', () => {
  it('no code path uses a magic link or OTP to set up an account', () => {
    // "Your sign-in link" is the Magic Link template. A first password is
    // chosen, not bypassed, so nothing here may take that route.
    for (const source of [employeeFn, hrFn]) {
      expect(source).not.toContain('signInWithOtp')
      expect(source).not.toContain('/magiclink')
    }
  })
})
