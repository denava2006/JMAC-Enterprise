/**
 * The text inside a thrown thing, whatever shape it arrived in.
 *
 * Every error formatter in this codebase used to start with:
 *
 *     error instanceof Error ? error.message : String(error ?? '')
 *
 * which is wrong for the errors we actually get. Supabase and PostgREST reject
 * with a plain object -- `{ message, details, hint, code }` -- and a plain
 * object is not an Error, so `String(error)` produced the literal text
 * "[object Object]". Every `.includes()` check downstream then missed, and
 * because "[object Object]" is truthy it sailed through the `message || 'fallback'`
 * ending and onto the screen.
 *
 * That is how a POS Manager raising a duplicate stock request was told
 * "[object Object]" instead of "There is already an open request for this
 * product at this branch." The database had said exactly the right thing; the
 * client threw the sentence away.
 *
 * So this reads the message off anything that carries one, and guarantees it
 * never returns that string: a caller can trust a non-empty result to be words.
 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error.trim()

  if (error && typeof error === 'object') {
    const candidate = error as {
      message?: unknown
      error_description?: unknown
      details?: unknown
      hint?: unknown
    }
    // In order of how specific each field is to what went wrong. PostgREST
    // fills `details` and `hint` for constraint violations where `message` is
    // sometimes the terser half.
    for (const field of [
      candidate.message,
      candidate.error_description,
      candidate.details,
      candidate.hint,
    ]) {
      if (typeof field === 'string' && field.trim()) return field.trim()
    }
  }

  // Deliberately empty rather than String(error): every caller treats '' as
  // "nothing useful to say" and substitutes its own sentence, and returning
  // "[object Object]" here is the whole bug this exists to prevent.
  return ''
}
