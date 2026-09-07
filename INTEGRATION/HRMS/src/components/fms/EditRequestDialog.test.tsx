import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * What happens to a half-typed correction when the row underneath it moves.
 *
 * The editor is open, the claimant has retyped the amount, and a refetch lands
 * a newer version of the same draft — another tab, a background invalidation,
 * a poll. The first version of this dialog reset the form on every change of
 * `updated_at`, so the correction being typed was replaced by whatever arrived.
 * Reproduced before the fix: an amount of 1250.50 went back to 1100, retyped
 * details went back to the stored ones, and the save that followed sent
 *
 *   { amount: 1100, expectedUpdatedAt: <the NEW timestamp> }
 *
 * which is the worse half. Carrying the newer version told the staleness guard
 * in update_finance_request_draft that these values had been typed against the
 * current row, so it had nothing to refuse and the replacement amount was
 * written as though somebody had meant it.
 *
 * These assert on what is submitted rather than only on what is displayed: the
 * form's values and the boxes on screen are not the same thing, and it was the
 * values that got sent.
 *
 * What the browser is not allowed to decide — who may edit, in what state, and
 * which columns — is settled in update_finance_request_draft and proved in
 * supabase/tests/reimbursement_draft_edit_rls.sql.
 */

type Request = {
  id: string
  request_no: string
  type: string
  title: string
  description: string | null
  justification: string | null
  requester_id: string
  amount: number
  priority: string
  status: string
  expense_date: string | null
  needed_by: string | null
  updated_at: string
}

const T1 = '2026-09-07T01:00:00.000Z'
const T2 = '2026-09-07T02:00:00.000Z'

function claim(over: Partial<Request> = {}): Request {
  return {
    id: 'rb1',
    request_no: 'RB-2026-0001',
    type: 'reimbursement',
    title: 'Client meeting transport',
    description: 'Grab fares',
    justification: 'Site visit',
    requester_id: 'marc',
    amount: 1000,
    priority: 'medium',
    status: 'draft',
    expense_date: '2026-09-07',
    needed_by: null,
    updated_at: T1,
    ...over,
  }
}

const saved: Array<Record<string, unknown>> = []

vi.mock('@/hooks/useFinanceRequests', () => ({
  useUpdateRequestDraft: () => ({
    mutateAsync: async (input: Record<string, unknown>) => {
      saved.push(input)
    },
    isPending: false,
  }),
}))

const { EditRequestDialog } = await import('@/components/fms/EditRequestDialog')

function editor(request: Request) {
  return <EditRequestDialog request={request as never} open onOpenChange={() => {}} />
}

const amountBox = () => screen.getByLabelText('Amount') as HTMLInputElement
const detailsBox = () => screen.getByLabelText('Details') as HTMLTextAreaElement
const notice = () => screen.queryByRole('status')

async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(saved.length).toBe(1))
  return saved[0]
}

beforeEach(() => {
  saved.length = 0
})

afterEach(cleanup)

describe('a refetch under an open editor', () => {
  it('does not replace what is being typed', async () => {
    const { rerender } = render(editor(claim()))

    fireEvent.change(amountBox(), { target: { value: '1250.50' } })
    fireEvent.change(detailsBox(), { target: { value: 'Grab fares, corrected' } })

    // The same draft comes back with different content and a newer version.
    rerender(editor(claim({ amount: 1100, description: 'Grab fares', updated_at: T2 })))
    await waitFor(() => expect(notice()).not.toBeNull())

    expect(amountBox().value).toBe('1250.50')
    expect(detailsBox().value).toBe('Grab fares, corrected')

    const sent = await save()
    expect(sent.amount).toBe(1250.5)
    expect(sent.description).toBe('Grab fares, corrected')
  })

  it('says so, rather than letting it pass unremarked', async () => {
    const { rerender } = render(editor(claim()))
    fireEvent.change(amountBox(), { target: { value: '1250.50' } })
    expect(notice()).toBeNull()

    rerender(editor(claim({ amount: 1100, updated_at: T2 })))

    await waitFor(() => expect(notice()?.textContent).toMatch(/changed somewhere else/i))
  })

  it('saves against the version the form was rendered from, so a clash is refused', async () => {
    const { rerender } = render(editor(claim()))
    fireEvent.change(amountBox(), { target: { value: '1250.50' } })

    rerender(editor(claim({ amount: 1100, updated_at: T2 })))
    await waitFor(() => expect(notice()).not.toBeNull())

    // Not T2. Carrying the newer timestamp is exactly what let the replacement
    // values be written as though they had been read.
    expect((await save()).expectedUpdatedAt).toBe(T1)
  })

  it('offers the newer version rather than only refusing to show it', async () => {
    const { rerender } = render(editor(claim()))
    fireEvent.change(amountBox(), { target: { value: '1250.50' } })

    rerender(editor(claim({ amount: 1100, updated_at: T2 })))
    await waitFor(() => expect(notice()).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Use the newer version' }))
    await waitFor(() => expect(notice()).toBeNull())
    expect(amountBox().value).toBe('1100')

    const sent = await save()
    expect(sent.amount).toBe(1100)
    expect(sent.expectedUpdatedAt).toBe(T2)
  })

  it('lets the correction win when that is what the claimant means', async () => {
    const { rerender } = render(editor(claim()))
    fireEvent.change(amountBox(), { target: { value: '1250.50' } })

    rerender(editor(claim({ amount: 1100, updated_at: T2 })))
    await waitFor(() => expect(notice()).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(notice()).toBeNull())
    expect(amountBox().value).toBe('1250.50')

    // Overwriting on purpose is somebody's decision, so the save carries the
    // version it is overwriting and the server accepts it.
    const sent = await save()
    expect(sent.amount).toBe(1250.5)
    expect(sent.expectedUpdatedAt).toBe(T2)
  })

  it('still follows the row when there is nothing typed to lose', async () => {
    // The reason the reset existed. Untouched, the editor should show — and
    // send — what the draft actually says now; there is no correction at stake.
    const { rerender } = render(editor(claim()))

    rerender(editor(claim({ amount: 1100, updated_at: T2 })))

    await waitFor(() => expect(amountBox().value).toBe('1100'))
    expect(notice()).toBeNull()

    const sent = await save()
    expect(sent.amount).toBe(1100)
    expect(sent.expectedUpdatedAt).toBe(T2)
  })
})

describe('reopening the editor', () => {
  it('starts from the draft as it stands now', async () => {
    const { rerender } = render(editor(claim()))
    fireEvent.change(amountBox(), { target: { value: '1250.50' } })

    rerender(<EditRequestDialog request={claim() as never} open={false} onOpenChange={() => {}} />)
    rerender(editor(claim({ amount: 1100, updated_at: T2 })))

    await waitFor(() => expect(amountBox().value).toBe('1100'))
    expect(notice()).toBeNull()
    expect((await save()).amount).toBe(1100)
  })
})

describe('an amount the column cannot hold', () => {
  // finance_requests.amount is numeric(14,2). Before this, the form accepted
  // 1000000000000 and the database answered "numeric field overflow", which the
  // error mapper then put on screen.
  it('is refused here rather than as a numeric field overflow', async () => {
    render(editor(claim()))

    fireEvent.change(amountBox(), { target: { value: '1000000000000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.getByText(/1,000,000,000,000/)).toBeTruthy())
    expect(saved.length).toBe(0)
  })

  it('still accepts the largest amount that fits', async () => {
    render(editor(claim()))

    fireEvent.change(amountBox(), { target: { value: '999999999999.99' } })

    expect((await save()).amount).toBe(999999999999.99)
  })
})
