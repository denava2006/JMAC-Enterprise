/** Shortening a name for the screen, never in the record.
 *
 * Full legal names in this system run to four or five parts. In a greeting or
 * the corner of a header they push everything else sideways and read as
 * officialese rather than as somebody being addressed.
 *
 * Nothing here writes anything. The employee record, the applicant record,
 * payroll, contracts, audit entries and formal reports all keep the full legal
 * name, because in those places the whole name is the point.
 */

/** The name somebody is called. "Clark Kint Ong De Nava" -> "Clark". */
export function firstName(fullName: string | null | undefined, fallback = 'there'): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0]
  return first || fallback
}

/** Short role labels for compact identity. Absent roles fall back to the name
 *  alone rather than inventing an abbreviation. */
const ROLE_SHORT: Record<string, string> = {
  admin: 'Admin',
  hr_manager: 'HRM',
  hr_staff: 'HR Staff',
}

/**
 * A compact identity: a short role and a first name, e.g. "HRM Clark".
 *
 * Used where space is tight and the person is looking at their own name -- the
 * account header. Anywhere the reader needs to identify SOMEBODY ELSE
 * definitively, show the full name.
 */
export function compactIdentity(fullName: string | null | undefined, role: string | undefined): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? ''
  const short = role ? ROLE_SHORT[role] : undefined
  if (!first) return short ?? ''
  return short ? `${short} ${first}` : first
}
