import type { Enums } from '@/lib/database.types'
import type { BadgeProps } from '@/components/ui/badge'

export type EmploymentType = Enums<'employment_type'>

export const EMPLOYMENT_TYPES: EmploymentType[] = ['regular', 'part_time']

/** How employment type reads when it describes a *person* or a *job* — an
 * employee record, a job posting, a salary grade. */
export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = {
  regular: 'Regular (Full-Time)',
  part_time: 'Part-Time (4-Hour Shift)',
}

/** Short form, for table cells and the chips on the careers list where the
 * parenthetical crowds the row out. */
export const EMPLOYMENT_TYPE_SHORT_LABEL: Record<EmploymentType, string> = {
  regular: 'Regular',
  part_time: 'Part-Time',
}

/** Label an employment type that arrived as a plain string.
 *
 *  The public Careers payload comes from a database function rather than a
 *  typed table row, so the value is `string | null` there. Indexing the record
 *  with it directly is a type error, and silently rendering "undefined" would
 *  be worse -- so an unrecognised or missing value falls back to a neutral
 *  word rather than a blank chip. */
export function employmentTypeShortLabel(value: string | null | undefined): string {
  if (!value) return 'Not specified'
  return EMPLOYMENT_TYPE_SHORT_LABEL[value as EmploymentType] ?? value
}

export function employmentTypeLabel(value: string | null | undefined): string {
  if (!value) return 'Not specified'
  return EMPLOYMENT_TYPE_LABEL[value as EmploymentType] ?? value
}

/** The same stored value answers a slightly different question on a work
 * schedule — "who is this shift for" — so it reads as Full-Time / Part-Time
 * there rather than Regular / Part-Time. One column, two vocabularies. */
export const SCHEDULE_TYPE_LABEL: Record<EmploymentType, string> = {
  regular: 'Full-Time',
  part_time: 'Part-Time',
}

export const EMPLOYMENT_TYPE_VARIANT: Record<EmploymentType, BadgeProps['variant']> = {
  regular: 'secondary',
  part_time: 'warning',
}
