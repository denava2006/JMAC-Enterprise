import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * The stale History, at the layer it actually went wrong.
 *
 * Angelo approved RB-2026-0001 once. The status changed in the open dialog and
 * the History block below it went on saying the claim had only been submitted
 * and forwarded; a full reload showed the approval, and the database had
 * recorded exactly one.
 *
 * So nothing was wrong with the write. Two mutations call the same RPC —
 * useTransitionRequest from the requests queue, useTransitionReimbursement from
 * the reimbursement queue — and they carried different invalidation lists. The
 * first cleared the trail. The second cleared ['reimbursements'] and the
 * budgets, and ['reimbursements'] is not a prefix of
 * ['finance','requests',id,'trail'], so the trail was never told it was stale.
 *
 * These run the real mutation through a real QueryClient and then ask the cache
 * which queries were marked stale — the thing that makes a mounted query
 * refetch. Whether the block re-renders is covered in ReimbursementsPage.test.
 */

const rpc = vi.fn()
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }))
vi.mock('@/components/ui/sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { useTransitionReimbursement } = await import('@/hooks/useReimbursements')
const { useTransitionRequest, REQUEST_KEYS } = await import('@/hooks/useFinanceRequests')

const CLAIM = 'rb1'

/**
 * The queries a reviewer has on screen while approving, seeded so
 * invalidateQueries has something real to match. Asserting on a spy's arguments
 * would prove only which strings were passed; this proves the queries were
 * marked stale.
 */
function seededClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  for (const key of [
    REQUEST_KEYS.all,
    REQUEST_KEYS.one(CLAIM),
    REQUEST_KEYS.trail(CLAIM),
    ['finance', 'budgets'],
    ['finance', 'request-participants'],
    ['reimbursements', 'list'],
  ]) {
    client.setQueryData(key, [])
  }
  return client
}

function stateOf(client: QueryClient) {
  const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated === true
  return {
    list: stale(REQUEST_KEYS.all),
    one: stale(REQUEST_KEYS.one(CLAIM)),
    trail: stale(REQUEST_KEYS.trail(CLAIM)),
    budgets: stale(['finance', 'budgets']),
    participants: stale(['finance', 'request-participants']),
    reimbursements: stale(['reimbursements', 'list']),
  }
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children)
}

async function approveFromReimbursements(client: QueryClient) {
  const { result } = renderHook(() => useTransitionReimbursement(), { wrapper: wrapper(client) })
  await result.current.mutateAsync({ id: CLAIM, to: 'approved' })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
}

async function approveFromRequests(client: QueryClient) {
  const { result } = renderHook(() => useTransitionRequest(), { wrapper: wrapper(client) })
  await result.current.mutateAsync({ requestId: CLAIM, to: 'approved' })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
}

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ error: null })
})

afterEach(() => vi.clearAllMocks())

describe('approving from the reimbursement queue', () => {
  it('marks the trail stale, so the History block refetches without a reload', async () => {
    const client = seededClient()
    await approveFromReimbursements(client)
    // The defect, named: this was false.
    expect(stateOf(client).trail).toBe(true)
  })

  it('marks everything else the approval changed stale too', async () => {
    const client = seededClient()
    await approveFromReimbursements(client)
    const state = stateOf(client)
    expect(state.list).toBe(true)
    expect(state.one).toBe(true)
    // Approval reserves budget, so the ceiling moved.
    expect(state.budgets).toBe(true)
    // A new actor appears in the trail and needs a name.
    expect(state.participants).toBe(true)
    // And the queue this was done from.
    expect(state.reimbursements).toBe(true)
  })

  it('goes through the one authoritative RPC, exactly once', async () => {
    const client = seededClient()
    await approveFromReimbursements(client)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][0]).toBe('transition_finance_request')
    expect(rpc.mock.calls[0][1]).toMatchObject({ _request_id: CLAIM, _to_status: 'approved' })
  })

  it('writes nothing into the cache itself, so a refetch cannot double an event', async () => {
    // No optimistic row appended anywhere: the trail stays whatever the server
    // last returned. An optimistic entry plus a refetch is how one approval
    // comes to be listed twice.
    const client = seededClient()
    await approveFromReimbursements(client)
    expect(client.getQueryData(REQUEST_KEYS.trail(CLAIM))).toEqual([])
  })

  it('invalidates nothing at all when the transition fails', async () => {
    rpc.mockResolvedValue({ error: { message: 'refused' } })
    const client = seededClient()
    const { result } = renderHook(() => useTransitionReimbursement(), { wrapper: wrapper(client) })
    await expect(result.current.mutateAsync({ id: CLAIM, to: 'approved' })).rejects.toBeTruthy()
    // A refused approval has changed nothing, so nothing needs refetching.
    expect(stateOf(client).trail).toBe(false)
  })
})

describe('the requests queue is not regressed', () => {
  it('invalidates exactly the same set, because it is now the same list', async () => {
    const fromRequests = seededClient()
    await approveFromRequests(fromRequests)

    const fromReimbursements = seededClient()
    await approveFromReimbursements(fromReimbursements)

    // Two mutations over one RPC carrying two different lists is what caused
    // this. They cannot drift apart again without this failing.
    expect(stateOf(fromRequests)).toEqual(stateOf(fromReimbursements))
    expect(stateOf(fromRequests).trail).toBe(true)
  })

  it.each(['pending_validation', 'pending_approval', 'returned', 'rejected'])(
    'refreshes the trail after %s too, not only after an approval',
    async (to) => {
      const client = seededClient()
      const { result } = renderHook(() => useTransitionReimbursement(), {
        wrapper: wrapper(client),
      })
      await result.current.mutateAsync({ id: CLAIM, to })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(stateOf(client).trail).toBe(true)
    },
  )
})
