/** Signing in, and recovering from a session that went stale.
 *
 * Hosted role-switching produced repeated "that email and password combination
 * doesn't match our records" for accounts whose passwords were correct, and the
 * only advice that worked was to refresh the page a few times. That advice was
 * a symptom: getSession restores whatever is in local storage without asking
 * whether it is still true, so a revoked session came back to life and then
 * failed on the first real request. Each reload was another chance for the
 * token to be refreshed or discarded.
 *
 * These lock down that the app clears a stale session itself, retries only what
 * a retry can fix, and never asks anybody to refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { UserRole } from '@/lib/enums'

const auth = {
  getSession: vi.fn(),
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}

const profileRow: { role: UserRole; status: string } = { role: 'employee', status: 'active' }

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth,
    // profiles: select().eq().single() for the read, update().eq() for last_login
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: profileRow, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc: async (name: string) =>
      name === 'has_pos_access' ? { data: false, error: null } : { data: [], error: null },
  },
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQueryClient: () => ({ clear: vi.fn() }) }
})

const { AuthProvider, useAuth } = await import('@/contexts/AuthContext')

let lastResult: { error: string | null } | null = null

function Probe() {
  const { session, profile, initializing, sessionExpired, signIn } = useAuth()
  return (
    <div>
      <span data-testid="state">
        {initializing ? 'loading' : session && profile ? 'signed-in' : 'signed-out'}
      </span>
      <span data-testid="expired">{sessionExpired ? 'expired' : ''}</span>
      <button
        onClick={async () => {
          lastResult = await signIn('a@b.test', 'pw')
        }}
      >
        sign in
      </button>
    </div>
  )
}

function show() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  )
}

const SESSION = { user: { id: 'u1' } }

beforeEach(() => {
  lastResult = null
  profileRow.role = 'employee'
  profileRow.status = 'active'
  auth.getSession.mockResolvedValue({ data: { session: null } })
  auth.getUser.mockResolvedValue({ data: { user: SESSION.user }, error: null })
  auth.signInWithPassword.mockResolvedValue({ data: { user: SESSION.user }, error: null })
  auth.signOut.mockResolvedValue({ error: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function clickSignIn() {
  await act(async () => {
    screen.getByText('sign in').click()
  })
}

describe('a session restored from storage', () => {
  it('is checked against the server, not trusted', async () => {
    auth.getSession.mockResolvedValue({ data: { session: SESSION } })
    show()
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-in'))
    expect(auth.getUser).toHaveBeenCalled()
  })

  it('is cleared through the SDK when the server rejects it', async () => {
    auth.getSession.mockResolvedValue({ data: { session: SESSION } })
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: 'refresh_token_not_found', status: 400, message: 'Invalid Refresh Token' },
    })

    show()

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))
    expect(auth.signOut).toHaveBeenCalled()
    expect(screen.getByTestId('expired').textContent).toBe('expired')
  })

  it('and the same account can then sign in without a page refresh', async () => {
    auth.getSession.mockResolvedValue({ data: { session: SESSION } })
    auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: 'refresh_token_not_found', status: 400, message: 'Invalid Refresh Token' },
    })

    show()
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))

    await clickSignIn()

    expect(lastResult).toEqual({ error: null })
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1)
  })

  it('does not call getUser when there was no session to begin with', async () => {
    show()
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))
    expect(auth.getUser).not.toHaveBeenCalled()
    expect(screen.getByTestId('expired').textContent).toBe('')
  })
})

describe('what is retried, and what is not', () => {
  it('retries a network failure exactly once', async () => {
    auth.signInWithPassword
      .mockResolvedValueOnce({ data: {}, error: { name: 'TypeError', message: 'Failed to fetch' } })
      .mockResolvedValueOnce({ data: { user: SESSION.user }, error: null })

    show()
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))
    await clickSignIn()

    expect(auth.signInWithPassword).toHaveBeenCalledTimes(2)
    expect(lastResult).toEqual({ error: null })
  })

  it('gives up after one retry rather than looping', async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { status: 503, message: 'Service Unavailable' },
    })

    show()
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))
    await clickSignIn()

    expect(auth.signInWithPassword).toHaveBeenCalledTimes(2)
    expect(lastResult?.error).toMatch(/couldn’t complete sign-in right now/)
  })

  it('never retries a rejected password', async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
    })

    show()
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))
    await clickSignIn()

    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1)
    expect(lastResult?.error).toMatch(/doesn’t match our records/)
  })

  it('never retries a rate limit', async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { code: 'over_request_rate_limit', status: 429, message: 'rate limit' },
    })

    show()
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))
    await clickSignIn()

    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1)
    expect(lastResult?.error).toMatch(/Wait a moment/)
  })

  it('never tells anybody to refresh the page', async () => {
    for (const error of [
      { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
      { status: 500, message: 'boom' },
      { code: 'refresh_token_not_found', status: 400, message: 'Invalid Refresh Token' },
    ]) {
      auth.signInWithPassword.mockResolvedValue({ data: {}, error })
      cleanup()
      show()
      await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))
      await clickSignIn()
      expect(String(lastResult?.error).toLowerCase()).not.toContain('refresh')
    }
  })
})

describe('a deactivated account', () => {
  it('is refused with its own reason, and signed back out', async () => {
    profileRow.status = 'inactive'

    show()
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))
    await clickSignIn()

    expect(lastResult?.error).toMatch(/deactivated/)
    expect(auth.signOut).toHaveBeenCalled()
  })
})

describe('authentication is role-neutral', () => {
  it.each([
    'admin',
    'hr_manager',
    'hr_staff',
    'finance_staff',
    'finance_manager',
    'accountant',
    'employee',
  ] as const)('%s signs in through the same path', async (role) => {
    profileRow.role = role

    show()
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))
    await clickSignIn()

    expect(lastResult).toEqual({ error: null })
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1)
  })

  it('and a POS account is no different — the till comes from assignments, not the role', async () => {
    // A POS Manager and a Cashier both carry role 'employee'; what separates
    // them is pos_branch_assignments, which sign-in does not consult.
    profileRow.role = 'employee'

    show()
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('signed-out'))
    await clickSignIn()

    expect(lastResult).toEqual({ error: null })
  })
})
