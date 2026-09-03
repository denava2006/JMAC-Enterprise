/** Recruitment and HR navigation — behaviour tests.
 *
 * Covers the parts of this stabilisation that live in the browser: what an
 * applicant is shown on Track Application, what Create Employee carries over,
 * who sees reference-data management, and how the header names somebody.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MILESTONE_LABEL } from '@/hooks/useApplicantPortal'
import { canAccessModule } from '@/lib/roles'
import { IMPORTABLE_FIELDS, importedFields, resolveSubmittedApplicant } from '@/lib/hiring'

const root = join(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8')

describe('the applicant timeline', () => {
  it('names every milestone the applicant is shown', () => {
    for (const event of [
      'submitted',
      'reviewed',
      'qualified',
      'initial_interview_scheduled',
      'initial_interview_rescheduled',
      'initial_interview_passed',
      'initial_interview_cancelled',
      'final_interview_scheduled',
      'final_interview_rescheduled',
      'final_interview_cancelled',
      'job_offer_prepared',
      'hired',
      'deployment_completed',
    ]) {
      expect(MILESTONE_LABEL[event], `${event} has no applicant-facing label`).toBeTruthy()
    }
  })

  it("reads as the applicant's own journey, not HR's vocabulary", () => {
    expect(MILESTONE_LABEL.reviewed).toBe('Under Review')
    expect(MILESTONE_LABEL.qualified).toBe('Shortlisted')
    expect(MILESTONE_LABEL.job_offer_prepared).toBe('Offer Sent')
    expect(MILESTONE_LABEL.initial_interview_passed).toBe('Initial Interview Passed')
  })

  it('has no label for an internal event', () => {
    // Without a label the row is not rendered at all, so an internal milestone
    // cannot reach the applicant by simply existing.
    for (const internal of [
      'final_interview_passed',
      'initial_interview_started',
      'final_interview_started',
      'initial_interview_rejected',
      'rejection_email_queued',
      'contract_signed',
    ]) {
      expect(MILESTONE_LABEL[internal], `${internal} is shown to applicants`).toBeUndefined()
    }
  })
})

describe('what Create Employee carries over', () => {
  const application = {
    applicant_first_name: 'Ana',
    applicant_last_name: 'Cruz',
    applicant_email: 'ana@example.com',
    applicant_phone: '09171112222',
    applicant_province: 'Cavite',
    applicant_city: 'Imus',
    applicant_barangay: 'Barangay 1',
    applicant_address: 'Blk 2 Lot 4',
    applicant_birth_date: '2000-05-04',
    applicant_government_id_path: 'government-ids/abc.pdf',
    applicant_gender: 'Female',
    applicant_nationality: 'Filipino',
  }

  it('brings the date of birth the applicant gave', () => {
    expect(resolveSubmittedApplicant(application).birth_date).toBe('2000-05-04')
    expect(importedFields(resolveSubmittedApplicant(application))).toContain('birthDate')
  })

  it('brings the government ID as a path, never a URL', () => {
    const id = resolveSubmittedApplicant(application).government_id_path
    expect(id).toBe('government-ids/abc.pdf')
    expect(id).not.toMatch(/^https?:/)
  })

  it('brings the gender and nationality the applicant stated', () => {
    const person = resolveSubmittedApplicant(application)
    expect(person.gender).toBe('Female')
    expect(person.nationality).toBe('Filipino')
    expect(importedFields(person)).toEqual(expect.arrayContaining(['gender', 'nationality']))
  })

  it('still does not claim to have imported what no application collects', () => {
    // Civil status is the last field HR genuinely has to supply.
    expect(Object.keys(IMPORTABLE_FIELDS)).not.toContain('civilStatus')
  })

  it('does not invent a date of birth for an older application', () => {
    // Neither field was ever stored on the applicant master, so there is no
    // fallback to reach for -- an application from before they were collected
    // simply has none.
    const legacy = resolveSubmittedApplicant({}, { first_name: 'Ana', last_name: 'Cruz' })
    expect(legacy.birth_date).toBeNull()
    expect(legacy.government_id_path).toBeNull()
    expect(importedFields(legacy)).not.toContain('birthDate')
  })
})

describe('reference data is management work', () => {
  const REFERENCE = [
    '/dashboard/admin/departments',
    '/dashboard/admin/positions',
    '/dashboard/admin/salary-grades',
    '/dashboard/admin/work-schedules',
  ]

  it.each(REFERENCE)('%s is reachable by an Administrator', (path) => {
    expect(canAccessModule('admin', path)).toBe(true)
  })

  it.each(REFERENCE)('%s is reachable by an HR Manager', (path) => {
    expect(canAccessModule('hr_manager', path)).toBe(true)
  })

  it.each(REFERENCE)('%s is not offered to HR Staff', (path) => {
    expect(canAccessModule('hr_staff', path)).toBe(false)
  })

  it('does not take away the operational modules HR Staff works in', () => {
    // Losing the management pages must not cost them the pages that consume
    // those values -- an offer needs a salary grade, a deployment needs a shift.
    for (const path of [
      '/dashboard/employees',
      '/dashboard/attendance',
      '/dashboard/leave',
      '/dashboard/payroll',
      '/dashboard/interviews',
      '/dashboard/deployment',
    ]) {
      expect(canAccessModule('hr_staff', path)).toBe(true)
    }
  })
})

describe('the general Approvals screen', () => {
  const app = read('src', 'App.tsx')
  const sidebar = read('src', 'components', 'layout', 'Sidebar.tsx')

  it('is off the navigation', () => {
    expect(sidebar).not.toContain('/dashboard/admin/approvals')
  })

  it('is no longer routed', () => {
    expect(app).not.toContain('path="admin/approvals"')
  })

  it('leaves the change-request records alone', () => {
    // The navigation went; the data did not. Removing a screen is not a reason
    // to drop the history behind it.
    const hooks = read('src', 'hooks', 'useChangeRequests.ts')
    expect(hooks).toContain("from('change_requests')")
  })
})

describe('the header identity', () => {
  it('is the name, not the name with the role stapled to the front', () => {
    // compactIdentity used to render "HR Staff Sam" in the top bar, which meant
    // the role appeared there three times over: in the name, again in full on
    // the line beneath, and again as the badge. The helper is gone with it.
    const helpers = read('src', 'lib', 'displayName.ts')
    expect(helpers).not.toContain('compactIdentity')
    expect(helpers).not.toContain('ROLE_SHORT')

    const navbar = read('src', 'components', 'layout', 'Navbar.tsx')
    expect(navbar).not.toContain('compactIdentity')
    expect(navbar).toContain('profile?.full_name')
  })

  it('is presentation only — the stored name is untouched', () => {
    const helpers = read('src', 'lib', 'displayName.ts')
    expect(helpers).not.toMatch(/supabase|update|insert/i)
  })
})
