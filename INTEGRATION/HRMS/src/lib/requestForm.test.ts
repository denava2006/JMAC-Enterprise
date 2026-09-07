import { describe, expect, it } from 'vitest'
import {
  AMOUNT_CEILING,
  editRequestSchema,
  newRequestSchema,
  type EditRequestValues,
} from '@/lib/requestForm'

/**
 * The bound the column imposes, said before the save rather than after it.
 *
 * finance_requests.amount is numeric(14,2), so an amount of 1000000000000 is
 * one the database cannot store. Nothing said so: the schema asked only that
 * the amount be positive, the save went out, and Postgres answered "numeric
 * field overflow" -- which the error mapper then put on the screen.
 *
 * Raising a request and correcting one share this shape deliberately, so both
 * are checked: a claim that could be created but not edited, or edited into a
 * shape it could not have been created in, is the drift the shared schema
 * exists to prevent.
 */

const valid: EditRequestValues = {
  title: 'Client meeting transport',
  description: 'Grab fares',
  justification: 'Site visit',
  amount: 1000,
  needed_by: '',
  expense_date: '2026-09-07',
  priority: 'medium',
}

function editWith(amount: number) {
  return editRequestSchema.safeParse({ ...valid, amount })
}
function raiseWith(amount: number) {
  return newRequestSchema.safeParse({ ...valid, type: 'reimbursement', amount })
}

describe('an amount the column cannot hold', () => {
  it('is refused when correcting a draft', () => {
    const result = editWith(1000000000000)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toMatch(/1,000,000,000,000/)
  })

  it('is refused when raising one too, so the two cannot drift', () => {
    expect(raiseWith(1000000000000).success).toBe(false)
  })

  it('accepts the largest amount numeric(14,2) can store', () => {
    // Twelve digits before the point and two after: 10^12 is the first value
    // that overflows, so the last that fits is this.
    expect(AMOUNT_CEILING).toBe(999999999999.99)
    expect(editWith(AMOUNT_CEILING).success).toBe(true)
    expect(raiseWith(AMOUNT_CEILING).success).toBe(true)
  })

  it('still refuses zero and negatives, which was never the question', () => {
    expect(editWith(0).success).toBe(false)
    expect(editWith(-50).success).toBe(false)
  })
})
