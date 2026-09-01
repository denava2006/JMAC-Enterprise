import { describe, it, expect } from 'vitest'
import {
  IMPORTABLE_FIELDS,
  NEW_EMPLOYEE_STATUS,
  importedFields,
  resolveSubmittedApplicant,
  type ApplicantMaster,
  type ApplicationIdentitySnapshot,
} from './hiring'

// The application Clark Kint De Nava actually submitted.
const application: ApplicationIdentitySnapshot = {
  applicant_first_name: 'Clark Kint',
  applicant_middle_name: 'Ong',
  applicant_last_name: 'De Nava',
  applicant_email: 'clarkkintd@gmail.com',
  applicant_phone: '09171112222',
  applicant_province: 'Cavite',
  applicant_city: 'Dasmariñas',
  applicant_barangay: 'Santa Maria',
  applicant_address: 'Blk 5 Lot 9, Real Subdivision',
}

// The same person's contact record after a LATER application on the same email
// overwrote it. This is the row the screen used to read.
const masterAfterLaterApplication: ApplicantMaster = {
  first_name: 'ZZ',
  middle_name: null,
  last_name: 'CronCheck',
  email: 'clarkkintd@gmail.com',
  phone: '09179998888',
  province: 'Cavite',
  city: 'Imus',
  barangay: 'Barangay 1',
  address: 'Blk 1 Lot 2, Test Subdivision',
}

describe('resolveSubmittedApplicant', () => {
  it('takes the identity the application was submitted with', () => {
    const person = resolveSubmittedApplicant(application, masterAfterLaterApplication)
    expect(person.first_name).toBe('Clark Kint')
    expect(person.middle_name).toBe('Ong')
    expect(person.last_name).toBe('De Nava')
  })

  it('is not moved by a later application from the same person', () => {
    // The bug, stated directly: this is the hand-off that created an employee
    // record named after somebody else's application.
    const person = resolveSubmittedApplicant(application, masterAfterLaterApplication)
    expect(`${person.first_name} ${person.last_name}`).not.toBe('ZZ CronCheck')
    expect(person.phone).toBe('09171112222')
    expect(person.city).toBe('Dasmariñas')
    expect(person.address).toBe('Blk 5 Lot 9, Real Subdivision')
  })

  it('falls back to the contact record only where the application has no snapshot', () => {
    // Rows submitted before the snapshot existed. The contact record is then
    // the best answer available, not a wrong one.
    const legacy = resolveSubmittedApplicant({}, masterAfterLaterApplication)
    expect(legacy.first_name).toBe('ZZ')
    expect(legacy.city).toBe('Imus')
  })

  it('prefers the snapshot field by field, not all or nothing', () => {
    const partial = resolveSubmittedApplicant(
      { applicant_first_name: 'Clark Kint', applicant_last_name: 'De Nava' },
      masterAfterLaterApplication
    )
    expect(partial.first_name).toBe('Clark Kint')
    expect(partial.phone).toBe('09179998888')
  })

  it('never yields undefined for a field the form will bind to', () => {
    const empty = resolveSubmittedApplicant(null, null)
    for (const value of Object.values(empty)) expect(value).toBe('')
  })
})

describe('importedFields', () => {
  it('marks the fields the applicant actually supplied', () => {
    const fields = importedFields(resolveSubmittedApplicant(application))
    expect(fields).toContain('firstName')
    expect(fields).toContain('middleName')
    expect(fields).toContain('address')
    expect(fields).toHaveLength(Object.keys(IMPORTABLE_FIELDS).length)
  })

  it('does not mark a field that arrived empty', () => {
    // "Auto-filled" on an empty box claims the applicant supplied a value and
    // invites HR to skip past it.
    const fields = importedFields(resolveSubmittedApplicant({ ...application, applicant_middle_name: null }))
    expect(fields).not.toContain('middleName')
    expect(fields).toContain('firstName')
  })

  it('treats whitespace as empty', () => {
    const fields = importedFields(resolveSubmittedApplicant({ ...application, applicant_barangay: '   ' }))
    expect(fields).not.toContain('barangay')
  })

  it('marks nothing when there is no application to import from', () => {
    expect(importedFields(resolveSubmittedApplicant(null, null))).toEqual([])
  })

  it('never claims to have imported a field no application collects', () => {
    // Gender, birth date, civil status and nationality are asked for on the
    // employee form only. They must stay plainly unfilled.
    const importable: string[] = Object.keys(IMPORTABLE_FIELDS)
    for (const manual of ['gender', 'birthDate', 'civilStatus', 'nationality']) {
      expect(importable).not.toContain(manual)
    }
  })
})

describe('NEW_EMPLOYEE_STATUS', () => {
  it('is active', () => {
    expect(NEW_EMPLOYEE_STATUS).toBe('active')
  })
})
