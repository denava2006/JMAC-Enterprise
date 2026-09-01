/** Turning a hired application into an employee.
 *
 * The rules here exist because both of them were once broken in production:
 * an employee record was created under the wrong person's name, and the form
 * offered to hire somebody as already resigned.
 */

/** What an application recorded about the person who submitted it. */
export interface SubmittedApplicant {
  first_name: string
  middle_name: string
  last_name: string
  email: string
  phone: string
  province: string
  city: string
  barangay: string
  address: string
  /** The CV and letter submitted with THIS application. Overwritten on the
   *  applicants row by every new submission, so an old application would
   *  otherwise show the newest CV to whoever is interviewing. */
  resume_url: string | null
  cover_letter: string | null
}

/** The application's own immutable snapshot columns. */
export interface ApplicationIdentitySnapshot {
  applicant_first_name?: string | null
  applicant_middle_name?: string | null
  applicant_last_name?: string | null
  applicant_email?: string | null
  applicant_phone?: string | null
  applicant_province?: string | null
  applicant_city?: string | null
  applicant_barangay?: string | null
  applicant_address?: string | null
  applicant_resume_url?: string | null
  applicant_cover_letter?: string | null
}

/** The applicants row: one per email, rewritten by each new submission. */
export interface ApplicantMaster {
  first_name?: string | null
  middle_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  province?: string | null
  city?: string | null
  barangay?: string | null
  address?: string | null
  resume_url?: string | null
  cover_letter?: string | null
}

/**
 * Who an application was submitted by.
 *
 * Always the application's own snapshot. The applicants row is the person's
 * current contact record and moves forward with their newest submission, so
 * reading it here is precisely how a second application retroactively renamed
 * an earlier one -- and put the wrong name on a real employee. It is consulted
 * only for rows that predate the snapshot, where it is the best answer left.
 */
export function resolveSubmittedApplicant(
  application: ApplicationIdentitySnapshot | null | undefined,
  master?: ApplicantMaster | null
): SubmittedApplicant {
  const pick = (snapshot: string | null | undefined, fallback: string | null | undefined) =>
    snapshot ?? fallback ?? ''

  return {
    first_name: pick(application?.applicant_first_name, master?.first_name),
    middle_name: pick(application?.applicant_middle_name, master?.middle_name),
    last_name: pick(application?.applicant_last_name, master?.last_name),
    email: pick(application?.applicant_email, master?.email),
    phone: pick(application?.applicant_phone, master?.phone),
    province: pick(application?.applicant_province, master?.province),
    city: pick(application?.applicant_city, master?.city),
    barangay: pick(application?.applicant_barangay, master?.barangay),
    address: pick(application?.applicant_address, master?.address),
    resume_url: application?.applicant_resume_url ?? master?.resume_url ?? null,
    cover_letter: application?.applicant_cover_letter ?? master?.cover_letter ?? null,
  }
}

/** Form fields that can be carried over from an application, and the submitted
 *  value behind each. Gender, birth date, civil status and nationality are
 *  deliberately absent: an application never asks for them, so they are HR's to
 *  enter and must never be shown as though the applicant had supplied them. */
export const IMPORTABLE_FIELDS = {
  firstName: 'first_name',
  middleName: 'middle_name',
  lastName: 'last_name',
  phone: 'phone',
  email: 'email',
  province: 'province',
  city: 'city',
  barangay: 'barangay',
  address: 'address',
} as const satisfies Record<string, keyof SubmittedApplicant>

export type ImportableField = keyof typeof IMPORTABLE_FIELDS

/**
 * Which fields actually arrived with something in them.
 *
 * "Auto-filled" is a claim that the applicant supplied this value, so an empty
 * box must never carry the badge: it would tell HR the field had been verified
 * when in fact nobody has ever filled it in.
 */
export function importedFields(applicant: SubmittedApplicant): ImportableField[] {
  return (Object.keys(IMPORTABLE_FIELDS) as ImportableField[]).filter(
    (field) => (applicant[IMPORTABLE_FIELDS[field]] ?? '').trim() !== ''
  )
}

/** A new employee starts here, always. Resigned, terminated and retired are
 *  lifecycle transitions that can only follow creation -- enforced in the
 *  database by force_new_employee_active() as well, because a form that stops
 *  asking is a hidden field, not a rule. */
export const NEW_EMPLOYEE_STATUS = 'active'
