/** Calendar-date helpers in the browser's own timezone.
 *
 * `new Date().toISOString().slice(0, 10)` is the tempting one-liner and it is
 * wrong here — it converts to UTC first, so anyone in Asia/Manila gets
 * yesterday's date for the first eight hours of every day. These build the
 * string from the local calendar fields instead, which is also what a
 * `<input type="date">` picker considers "today".
 */

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function todayISODate(): string {
  return toISODate(new Date())
}

/** The earliest date a form may accept when today itself is not allowed —
 * leave has to be filed in advance, and an offer's start date can't be a day
 * that's already underway. */
export function tomorrowISODate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return toISODate(d)
}

/** The timezone JMAC's books run on. The database says the same thing through
 *  pos_business_timezone(); this is the browser's copy of that one fact. */
export const BUSINESS_TIMEZONE = 'Asia/Manila'

/**
 * Today, as JMAC's books reckon it.
 *
 * Not the same question as todayISODate(). That one asks the browser what day
 * it is, which is right for a personal form — somebody filing leave means the
 * day they are having. A financial document means the day the company is
 * having, and the company is in Manila whether or not the person filling in
 * the form is.
 *
 * The one-liner this replaces cost a real acceptance: at 00:50 on 5 September
 * in Manila it is still 4 September in UTC, so a payment recorded that morning
 * was dated the previous day and the treasury movement followed it.
 *
 * en-CA formats as YYYY-MM-DD, which is exactly what a <input type="date">
 * and a PostgreSQL `date` both want, with no instant in between to be
 * converted through.
 */
export function businessTodayISODate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/**
 * A stored calendar date, written out for a reader.
 *
 * `new Date('2026-09-07')` parses as UTC midnight, which in Manila is 8am on
 * the 7th — fine — but for anyone west of Greenwich it renders as the 6th. The
 * date in the column is a calendar date with no instant attached, so the fix is
 * to stop it becoming one: appending T00:00:00 with no Z makes it local
 * midnight, and the day survives the trip to the screen wherever the reader is.
 *
 * The same one-liner is inlined in a dozen places across the portal already.
 * New callers get it from here.
 */
/**
 * An instant, written out in the timezone the books run on.
 *
 * Different from formatCalendarDate below, and the difference is the point. A
 * date column is a calendar date with no instant attached, so it must not be
 * converted at all. An audit timestamp is a real instant, so it must be
 * converted — the only question is to what.
 *
 * The browser's own zone is the tempting answer and it is wrong for this.
 * Approval trails are read by more than one person, and two of them comparing
 * notes about "the 9:08 forwarding" should be talking about the same event
 * rather than discovering they are eight hours apart. JMAC's books are in
 * Manila, so that is what the trail is stamped in, and the zone is named on
 * screen so nobody has to guess whose clock it is.
 */
export function formatBusinessDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: BUSINESS_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at)
}

export function formatCalendarDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}
