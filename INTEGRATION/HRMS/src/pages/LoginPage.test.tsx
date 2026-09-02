/** One click, one sign-in.
 *
 * Part of the same hosted problem: while an attempt was in flight the form
 * stayed live, so an impatient second click could start a second sign-in
 * against an account that was already authenticating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const signIn = vi.fn()
const authState: { session: unknown; profile: unknown; sessionExpired: boolean } = {
  session: null,
  profile: null,
  sessionExpired: false,
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ ...authState, signIn }),
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => vi.fn() }
})

const { default: LoginPage } = await import('@/pages/LoginPage')

function show() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  )
}

function fillCredentials() {
  fireEvent.change(document.getElementById('email')!, { target: { value: 'a@b.test' } })
  fireEvent.change(document.getElementById('password')!, { target: { value: 'secret123' } })
}

beforeEach(() => {
  authState.session = null
  authState.profile = null
  authState.sessionExpired = false
  signIn.mockReset()
})

afterEach(cleanup)

describe('a sign-in in flight', () => {
  it('takes one click, however many times it is clicked', async () => {
    let release: (v: { error: null }) => void = () => {}
    signIn.mockImplementation(() => new Promise((resolve) => (release = resolve)))

    show()
    fillCredentials()

    const button = screen.getByRole('button', { name: /sign in/i })
    await act(async () => {
      fireEvent.click(button)
    })

    // The attempt is running: the control says so and refuses further clicks.
    await waitFor(() => expect(screen.getByRole('button', { name: /signing in/i })).toBeTruthy())
    expect(screen.getByRole('button', { name: /signing in/i })).toHaveProperty('disabled', true)

    fireEvent.click(button)
    fireEvent.click(button)

    await act(async () => {
      release({ error: null })
    })

    expect(signIn).toHaveBeenCalledTimes(1)
  })
})

describe('what the form says went wrong', () => {
  it('shows the reason sign-in gave, verbatim from the classifier', async () => {
    signIn.mockResolvedValue({ error: 'Your previous session expired. Please sign in again.' })

    show()
    fillCredentials()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    })

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Your previous session expired'),
    )
  })

  it('never advises refreshing the page', async () => {
    signIn.mockResolvedValue({ error: 'We couldn’t complete sign-in right now. Please try again.' })

    show()
    fillCredentials()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent?.toLowerCase()).not.toContain('refresh')
  })
})

describe('a session cleared during start-up', () => {
  it('explains why the person is back at the login form', () => {
    authState.sessionExpired = true
    show()
    expect(screen.getByRole('status').textContent).toContain('Your previous session expired')
  })

  it('says nothing when the visitor simply arrived here', () => {
    show()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
