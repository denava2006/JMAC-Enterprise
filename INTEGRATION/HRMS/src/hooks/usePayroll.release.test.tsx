import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Releasing payroll from the browser.
 *
 * The F7 preflight found this assembled out of four unrelated requests: read
 * the period, read its approved records, insert a payslip per record in a loop,
 * then flip the records to released. The payslip inserts discarded their errors
 * — the result of `supabase.from('payslips').insert(...)` was never looked at —
 * so payroll released whether or not the employees got payslips. With no
 * uniqueness on payslips.payroll_record_id, a retry issued them twice.
 *
 * It is one RPC now. These pin that the client does not go back to doing the
 * work itself: no payslip table writes, no records update, no audit insert, and
 * a failure surfaced rather than swallowed.
 */

const rpc = vi.fn()
const from = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    // Any table access from the release path is a regression, so this records
    // the attempt loudly rather than quietly returning a builder.
    from: (table: string) => {
      from(table)
      throw new Error(`release must not touch tables directly, but reached "${table}"`)
    },
  },
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('@/components/ui/sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'hr-manager-1', role: 'hr_manager' } }),
}))

const { useReleasePayroll } = await import('@/hooks/usePayroll')

const PERIOD = 'period-1'

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
}

function release() {
  return renderHook(() => useReleasePayroll(), { wrapper: wrapper() })
}

beforeEach(() => {
  rpc.mockReset()
  from.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  rpc.mockResolvedValue({ data: 'batch-1', error: null })
})

afterEach(() => vi.clearAllMocks())

describe('releasing payroll', () => {
  it('is one call to the authoritative operation', async () => {
    const { result } = release()
    await result.current.mutateAsync({ periodId: PERIOD })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][0]).toBe('release_payroll_period')
    expect(rpc.mock.calls[0][1]).toEqual({ _period_id: PERIOD })
  })

  it('writes no payslip, no record and no audit row of its own', async () => {
    // The four requests this replaced. Any of them coming back means the client
    // has started doing transactional work outside the transaction again.
    const { result } = release()
    await result.current.mutateAsync({ periodId: PERIOD })
    expect(from).not.toHaveBeenCalled()
  })

  it('returns the Finance batch the server made', async () => {
    const { result } = release()
    const batch = await result.current.mutateAsync({ periodId: PERIOD })
    expect(batch).toBe('batch-1')
  })

  it('says so when it worked', async () => {
    const { result } = release()
    await result.current.mutateAsync({ periodId: PERIOD })
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(toastSuccess.mock.calls[0][0]).toMatch(/released/i)
  })
})

describe('when the server refuses', () => {
  it('fails rather than treating a refusal as success', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'Payroll for 2026-09-01 to 2026-09-30 has 2 employee record(s) that are not approved yet.' },
    })
    const { result } = release()
    await expect(result.current.mutateAsync({ periodId: PERIOD })).rejects.toBeTruthy()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('shows what the server said, not a generic message', async () => {
    // The server names the employee count or the missing payslip. Replacing
    // that with "Release failed" throws away the only useful part.
    const message = 'Payroll for 2026-09-01 to 2026-09-30 has 2 employee record(s) with no payslip.'
    rpc.mockResolvedValue({ data: null, error: { message } })
    const { result } = release()
    await result.current.mutateAsync({ periodId: PERIOD }).catch(() => {})
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toBe(message)
  })

  it('does not fall back to releasing anything itself', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'refused' } })
    const { result } = release()
    await result.current.mutateAsync({ periodId: PERIOD }).catch(() => {})
    // A partial client-side release after a server refusal is precisely the
    // behaviour the preflight found.
    expect(from).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})

describe('retrying', () => {
  it('calls the same idempotent operation again and takes its answer', async () => {
    // The server decides what a retry means: an already-released period reads
    // back its existing batch rather than releasing twice. The client's job is
    // not to be clever about it.
    const { result } = release()
    await result.current.mutateAsync({ periodId: PERIOD })
    await result.current.mutateAsync({ periodId: PERIOD })

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls.every((c) => c[0] === 'release_payroll_period')).toBe(true)
    expect(from).not.toHaveBeenCalled()
  })
})
