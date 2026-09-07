import { z } from 'zod'

/**
 * What a person may type into a request, in one place.
 *
 * Raising a request and correcting a draft ask for the same things and have to
 * refuse the same things. They were about to be two schemas -- the second copied
 * from the first -- and copies drift: the moment one of them allowed a 200
 * character title, a request could be created that could not then be edited, or
 * edited into a shape it could not have been created in.
 *
 * The database refuses all of this again in update_finance_request_draft. That
 * is not duplication for its own sake: this exists so a person is told before
 * they press Save, and that one exists so it is true.
 */

/** Field names as the form labels them, for error messages that name the field
 *  somebody is looking at rather than the column it is stored in. */
export const REQUEST_FIELD_LABELS = {
  title: 'What this is for',
  amount: 'Amount',
  expense_date: 'Date spent',
  needed_by: 'Needed by',
}

/**
 * The largest amount the column can hold: finance_requests.amount is
 * numeric(14,2), so twelve digits before the point and two after.
 *
 * Without this the form accepts 1000000000000 happily and the database answers
 * "numeric field overflow", which is a sentence about a column rather than
 * about the claim somebody just tried to file. The bound belongs here, next to
 * the other limits, and update_finance_request_draft states it again so a
 * caller that never loads this form is told the same thing.
 */
export const AMOUNT_CEILING = 999999999999.99
const TOO_MUCH = 'Keep the amount under 1,000,000,000,000'

const shape = {
  title: z.string().min(1, 'Say what this is for').max(150, 'Keep this under 150 characters'),
  description: z.string().max(1000, 'Keep the details under 1000 characters').optional(),
  justification: z.string().max(1000, 'Keep the reason under 1000 characters').optional(),
  amount: z
    .number({ error: 'Enter an amount' })
    .positive('An amount must be more than zero')
    .max(AMOUNT_CEILING, TOO_MUCH),
  needed_by: z.string().optional(),
  expense_date: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']),
}

const ONLY_A_REIMBURSEMENT_HAS_ONE =
  'Only a reimbursement has a date the money was already spent'

/** Raising one. The type is chosen here and never again. */
export const newRequestSchema = z
  .object({ type: z.enum(['purchase', 'reimbursement']), ...shape })
  .refine((v) => v.type === 'reimbursement' || !v.expense_date, {
    message: ONLY_A_REIMBURSEMENT_HAS_ONE,
    path: ['expense_date'],
  })

/**
 * Correcting one. No type: a draft's type is fixed at the database, because the
 * reference number was drawn from a per-type sequence when the request was
 * raised — changing purchase to reimbursement would leave a PR- number on a
 * reimbursement. The dialog shows the expense date only for a reimbursement,
 * and the server clears it for anything else regardless.
 */
export const editRequestSchema = z.object(shape)

export type NewRequestValues = z.infer<typeof newRequestSchema>
export type EditRequestValues = z.infer<typeof editRequestSchema>
