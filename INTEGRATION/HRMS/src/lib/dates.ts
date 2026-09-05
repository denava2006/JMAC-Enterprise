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
