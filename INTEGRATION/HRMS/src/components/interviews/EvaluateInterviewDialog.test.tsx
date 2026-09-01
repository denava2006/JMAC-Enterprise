import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { FinalInterviewerOption } from '@/hooks/useInterviews'

/**
 * Assigning the final interviewer.
 *
 * Written after a production dead end: hosted JMAC had no HR Manager, the
 * screen offered only HR Managers, and so no initial interview could be
 * passed — recruitment stopped at the first candidate.
 *
 * The database always allowed an Administrator here
 * (protect_final_interviewer_assignment accepts hr_manager OR admin, and
 * supabase/tests/final_interviewer_rls.sql pins that). These tests are about
 * the screen offering what the rule already permits, and about it staying
 * honest for someone who genuinely is blocked.
 */

const state: {
  role: 'admin' | 'hr_staff' | 'hr_manager'
  interviewers: FinalInterviewerOption[]
} = { role: 'admin', interviewers: [] }

const manager = (name = 'Marissa Cruz'): FinalInterviewerOption => ({
  id: 'mgr-1',
  full_name: name,
  email: 'marissa@jmac.test',
  isFallback: false,
})

const administrator = (): FinalInterviewerOption => ({
  id: 'admin-1',
  full_name: 'Clark Administrator',
  email: 'admin@jmac.test',
  isFallback: true,
})

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'u1', role: state.role } }),
}))

vi.mock('@/hooks/useInterviews', () => ({
  useAvailableFinalInterviewers: () => ({ data: state.interviewers, isLoading: false }),
  useSubmitInitialEvaluation: () => ({ mutate: vi.fn(), isPending: false }),
  useSubmitFinalEvaluation: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { EvaluateInterviewDialog } = await import(
  '@/components/interviews/EvaluateInterviewDialog'
)

// The initial stage is the one that assigns who runs the final interview.
const show = () =>
  render(
    <EvaluateInterviewDialog
      open
      onOpenChange={() => {}}
      applicationId="app-1"
      interviewId="iv-1"
      stage="initial"
    />
  )

const openInterviewerList = () => {
  fireEvent.keyDown(screen.getByLabelText(/Assign Final Interviewer/i), { key: 'Enter' })
}

afterEach(() => {
  cleanup()
  state.role = 'admin'
  state.interviewers = []
})

describe('when no HR Manager exists', () => {
  it('lets an Administrator stand in rather than blocking recruitment', () => {
    // The exact production situation.
    state.role = 'admin'
    state.interviewers = [administrator()]
    show()

    expect(screen.getByText(/An Administrator can conduct the final interview/i)).toBeTruthy()
    // Not a red blocking state: the actor can resolve this themselves.
    expect(screen.queryByText(/^No HR Manager is available\./)).toBeNull()
  })

  it('marks the Administrator as a fallback rather than a peer', () => {
    state.role = 'admin'
    state.interviewers = [administrator()]
    show()
    openInterviewerList()
    expect(screen.getByText(/Clark Administrator — fallback/)).toBeTruthy()
  })

  it('still blocks HR Staff, and says who can unblock them', () => {
    // HR Staff do not become final interviewers because HR is short-staffed.
    // The database refuses it too; this is the screen agreeing.
    state.role = 'hr_staff'
    state.interviewers = []
    show()

    expect(
      screen.getByText(/An Administrator must assign or conduct the final interview/i)
    ).toBeTruthy()
  })
})

describe('when an HR Manager exists', () => {
  it('offers the HR Manager as the normal choice', () => {
    state.role = 'admin'
    state.interviewers = [manager(), administrator()]
    show()
    openInterviewerList()

    expect(screen.getByText('Marissa Cruz')).toBeTruthy()
  })

  it('shows neither the fallback notice nor a blocking message', () => {
    state.role = 'admin'
    state.interviewers = [manager(), administrator()]
    show()

    expect(screen.queryByText(/An Administrator can conduct the final interview/i)).toBeNull()
    expect(screen.queryByText(/An Administrator must assign or conduct/i)).toBeNull()
  })

  it('keeps HR Staff working normally when a manager is available', () => {
    state.role = 'hr_staff'
    state.interviewers = [manager()]
    show()

    expect(screen.queryByText(/An Administrator must assign or conduct/i)).toBeNull()
    expect(screen.getByText(/run by an HR Manager, not HR Staff/i)).toBeTruthy()
  })
})
