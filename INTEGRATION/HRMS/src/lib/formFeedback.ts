import type { FieldErrors, FieldValues } from 'react-hook-form'
import { toast } from '@/components/ui/sonner'

/** first_name -> "First name". Good enough for any field whose name is the
 *  column it writes to, which is all of them here. */
export function humaniseFieldName(name: string): string {
  const words = name
    .replace(/(_id|Id)$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

/**
 * Say why a form did not submit.
 *
 * React Hook Form's handleSubmit takes a second callback for the invalid case.
 * Left out — as it was on every dialog in Finance — a failed validation returns
 * without submitting and without a word, and the only feedback is inline error
 * text next to whichever fields happen to render it. A dialog with eight fields
 * and error text on two of them has six ways to make Save look broken.
 *
 * This reports the first invalid field by name, so "nothing happened" is never
 * the answer. Inline errors still render where they exist; this is the backstop
 * that guarantees at least one visible explanation.
 *
 * Field order in the errors object follows registration order, which is the
 * order the fields appear, so the message names the first problem rather than
 * an arbitrary one.
 */
export function reportInvalid(labels: Record<string, string> = {}) {
  return (errors: FieldErrors<FieldValues>) => {
    const first = Object.keys(errors)[0]
    if (!first) {
      toast.error('That could not be saved. Check the highlighted fields.')
      return
    }

    const message = errors[first]?.message
    const label = labels[first] ?? humaniseFieldName(first)

    // A resolver message written for a developer ("Invalid input: expected
    // number, received nan") is worse than no message at all.
    const readable =
      typeof message === 'string' && message && !/^Invalid input/i.test(message) ? message : null

    toast.error(readable ?? `${label} is required.`)
  }
}
