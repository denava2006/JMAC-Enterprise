/** Why a form did not submit.
 *
 * Every Finance dialog called handleSubmit with no invalid callback. A failed
 * validation returned silently, and the only feedback was inline error text next
 * to whichever fields happened to render it — two of eight in the budget dialog.
 * Clearing "Fiscal year" made Save do nothing, with nothing on screen to say so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const errorToast = vi.fn()
vi.mock('@/components/ui/sonner', () => ({ toast: { error: errorToast, success: vi.fn() } }))

const { reportInvalid, humaniseFieldName } = await import('./formFeedback')

beforeEach(() => errorToast.mockReset())

describe('naming a field a person would recognise', () => {
  it.each([
    ['fiscal_year', 'Fiscal year'],
    ['allocated_to', 'Allocated to'],
    ['opening_balance', 'Opening balance'],
    ['budget_id', 'Budget'],
    ['finance_category_id', 'Finance category'],
    ['name', 'Name'],
  ])('%s reads as "%s"', (field, expected) => {
    expect(humaniseFieldName(field)).toBe(expected)
  })
})

describe('reporting the first problem', () => {
  it('uses the schema message when it was written for a person', () => {
    reportInvalid()({ amount: { type: 'too_small', message: 'A ceiling cannot be negative' } })
    expect(errorToast).toHaveBeenCalledWith('A ceiling cannot be negative')
  })

  it('names the field when the resolver message is jargon', () => {
    // What zod says for a cleared number field.
    reportInvalid()({
      fiscal_year: { type: 'invalid_type', message: 'Invalid input: expected number, received nan' },
    })
    expect(errorToast).toHaveBeenCalledWith('Fiscal year is required.')
  })

  it('names the field when there is no message at all', () => {
    reportInvalid()({ workScheduleId: { type: 'required' } })
    expect(errorToast).toHaveBeenCalledWith('Work schedule is required.')
  })

  it('prefers the label the page supplies', () => {
    reportInvalid({ amount: 'Approved ceiling' })({ amount: { type: 'invalid_type' } })
    expect(errorToast).toHaveBeenCalledWith('Approved ceiling is required.')
  })

  it('reports the first field, not an arbitrary one', () => {
    reportInvalid()({
      name: { type: 'too_small', message: 'A budget name is required' },
      amount: { type: 'invalid_type', message: 'Invalid input' },
    })
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast).toHaveBeenCalledWith('A budget name is required')
  })

  it('still says something when the error object is empty', () => {
    reportInvalid()({})
    expect(errorToast).toHaveBeenCalledWith('That could not be saved. Check the highlighted fields.')
  })

  it('never leaves the person with nothing', () => {
    for (const errors of [
      { a: { type: 'x' } },
      { b: { type: 'x', message: '' } },
      { c: { type: 'x', message: 'Invalid input: expected string, received undefined' } },
      {},
    ]) {
      errorToast.mockReset()
      reportInvalid()(errors)
      expect(errorToast).toHaveBeenCalledTimes(1)
      expect(String(errorToast.mock.calls[0][0]).length).toBeGreaterThan(0)
    }
  })
})
