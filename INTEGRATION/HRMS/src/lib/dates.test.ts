import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  businessTodayISODate,
  formatBusinessDateTime,
  formatCalendarDate,
  toISODate,
  todayISODate,
} from '@/lib/dates'

/**
 * The bug this file exists for.
 *
 * A payment recorded at 00:50 on 5 September Manila time was stored as
 * 2026-09-04, on the payment and on its treasury movement. The Record payment
 * dialog defaulted its date with `new Date().toISOString().slice(0, 10)`, and
 * toISOString() converts to UTC first — at 00:50 Manila it is still 16:50 the
 * previous day in UTC.
 *
 * These tests pin the hour that broke it, and the boundaries around it.
 */

afterEach(() => vi.useRealTimers())

/** The exact instant of the failed acceptance: 2026-09-05 00:50 in Manila. */
const ACCEPTANCE_INSTANT = new Date('2026-09-04T16:50:00Z')

describe('the business date, when UTC and Manila disagree', () => {
  it('gives the Manila day at the hour that broke acceptance', () => {
    vi.useFakeTimers()
    vi.setSystemTime(ACCEPTANCE_INSTANT)
    expect(businessTodayISODate()).toBe('2026-09-05')
  })

  it('is exactly the day the old one-liner got wrong', () => {
    vi.useFakeTimers()
    vi.setSystemTime(ACCEPTANCE_INSTANT)
    // The defect, reproduced beside the fix so the difference is on the record.
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-04')
    expect(businessTodayISODate()).not.toBe(new Date().toISOString().slice(0, 10))
  })

  it('holds through the whole eight-hour window where they differ', () => {
    // 16:00 UTC is midnight in Manila; 23:59 UTC is 07:59 the same Manila day.
    for (const utc of ['16:00:00', '18:30:00', '21:15:00', '23:59:59']) {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(`2026-09-04T${utc}Z`))
      expect(businessTodayISODate()).toBe('2026-09-05')
      vi.useRealTimers()
    }
  })

  it('agrees with UTC for the rest of the day, so nothing else shifts', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T02:00:00Z')) // 10:00 Manila
    expect(businessTodayISODate()).toBe('2026-09-05')
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-05')
  })
})

describe('boundaries a calendar date has to survive', () => {
  const cases: Array<[string, string, string]> = [
    // New Year: 31 Dec 16:00 UTC is already 1 Jan in Manila.
    ['New Year', '2025-12-31T16:00:00Z', '2026-01-01'],
    // Month end, into a 30-day month.
    ['month end', '2026-04-30T16:30:00Z', '2026-05-01'],
    // Leap day: 2028 is a leap year, so 29 February exists.
    ['leap day eve', '2028-02-28T16:00:00Z', '2028-02-29'],
    ['leap day', '2028-02-29T16:00:00Z', '2028-03-01'],
    // A non-leap year rolls straight to March.
    ['non-leap February end', '2027-02-28T16:00:00Z', '2027-03-01'],
    // An ordinary midday, where nothing is interesting.
    ['ordinary date', '2026-06-15T04:00:00Z', '2026-06-15'],
  ]

  it.each(cases)('%s', (_name, instant, expected) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(instant))
    expect(businessTodayISODate()).toBe(expected)
  })
})

describe('the shape a date-only value travels in', () => {
  it('is always YYYY-MM-DD, zero-padded, with no time and no zone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-05T16:00:00Z'))
    const value = businessTodayISODate()
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(value).toBe('2026-01-06')
  })
})

/**
 * Reading a stored calendar date back out.
 *
 * F7 acceptance found a reimbursement's expense_date shown nowhere, so this
 * arrived with the field that displays it. The hazard is the mirror image of the
 * one above: the write side must not convert to UTC on the way out, and the read
 * side must not convert on the way in. `new Date('2026-09-07')` is parsed as UTC
 * midnight, which renders as the 6th for every reader west of Greenwich.
 *
 * Worth being straight about what these can and cannot prove here. Any runner at
 * a non-negative UTC offset — this one is +08 — renders both implementations
 * identically, so a literal expected string would pass whichever were in place.
 * The invariant below does not have that problem: it says the output must equal
 * the same calendar fields formatted locally, which is false for the UTC-parsing
 * version wherever the offset is negative, and true for the correct one
 * everywhere.
 */
describe('a stored calendar date, written out for a reader', () => {
  const en = { year: 'numeric', month: 'short', day: 'numeric' } as const

  it('renders the day that is in the column, not the day UTC lands on', () => {
    // Month is zero-based, so 8 is September. Constructed from the fields
    // rather than parsed from a string, which is the whole point.
    expect(formatCalendarDate('2026-09-07')).toBe(
      new Date(2026, 8, 7).toLocaleDateString('en-PH', en),
    )
  })

  it('holds at the boundaries a UTC conversion would push across', () => {
    for (const [iso, y, m, d] of [
      ['2026-01-01', 2026, 0, 1],
      ['2026-12-31', 2026, 11, 31],
      ['2028-02-29', 2028, 1, 29],
      ['2026-09-07', 2026, 8, 7],
    ] as const) {
      expect(formatCalendarDate(iso), iso).toBe(
        new Date(y, m, d).toLocaleDateString('en-PH', en),
      )
    }
  })

  it('has nothing to say about a date that is not there', () => {
    expect(formatCalendarDate(null)).toBeNull()
    expect(formatCalendarDate(undefined)).toBeNull()
    expect(formatCalendarDate('')).toBeNull()
    // A field arriving as rubbish should read as blank, not as "Invalid Date".
    expect(formatCalendarDate('not-a-date')).toBeNull()
  })
})

/**
 * An audit timestamp, which is the opposite problem to the one above.
 *
 * A date column must not be converted at all; a timestamptz is a real instant
 * and must be, and the only question is to what. The browser's own zone is the
 * tempting answer and it is wrong for an approval trail: two people comparing
 * notes about the same forwarding should be describing the same clock time
 * rather than discovering they are eight hours apart.
 */
describe('an instant, in the timezone the books run on', () => {
  const manila = (iso: string) =>
    new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso))

  it('renders an instant in Manila regardless of where it is read', () => {
    // 01:08Z is 09:08 in Manila. Stated as an invariant rather than a literal,
    // because a runner at UTC+8 cannot tell the two implementations apart.
    expect(formatBusinessDateTime('2026-09-07T01:08:00.000Z')).toBe(
      manila('2026-09-07T01:08:00.000Z'),
    )
  })

  it('holds across the day boundary UTC and Manila disagree about', () => {
    // 16:00Z on the 4th is already 00:00 on the 5th in Manila — the window
    // that cost F6 an acceptance, now on the read side.
    const at = '2026-09-04T16:00:00.000Z'
    expect(formatBusinessDateTime(at)).toBe(manila(at))
    expect(formatBusinessDateTime(at)).toContain('Sep 5')
  })

  it('has nothing to say about an instant that is not there', () => {
    expect(formatBusinessDateTime(null)).toBeNull()
    expect(formatBusinessDateTime(undefined)).toBeNull()
    expect(formatBusinessDateTime('')).toBeNull()
    expect(formatBusinessDateTime('not-a-timestamp')).toBeNull()
  })
})

describe('what the browser-local helper is still for', () => {
  // Not a replacement. A person filing leave means the day they are having;
  // a financial document means the day the company is having.
  it('reads the browser calendar, not UTC', () => {
    const d = new Date(2026, 8, 5, 0, 50) // 5 Sep 2026, 00:50 local
    expect(toISODate(d)).toBe('2026-09-05')
  })

  it('still exists alongside the business date', () => {
    expect(typeof todayISODate()).toBe('string')
    expect(todayISODate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
