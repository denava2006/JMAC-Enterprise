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

