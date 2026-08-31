import type { UserRole } from '@/lib/enums'

export const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Administrator',
  hr_manager: 'HR Manager',
  hr_staff: 'HR Staff',
  employee: 'Employee',
}

/** Roles an Administrator can create from HR Accounts. Administrators are
 * deliberately not creatable from the UI (see create-hr-account). */
export const CREATABLE_HR_ROLES = ['hr_staff', 'hr_manager'] as const
export type CreatableHrRole = (typeof CREATABLE_HR_ROLES)[number]

/** Approving payroll for release and deciding leave requests are the HR
 * Manager's calls, not HR Staff's. Mirrors the database's
 * is_hr_manager_or_admin() — the triggers are the real enforcement, this just
 * keeps the UI from offering an action that would always be rejected. */
export function canApproveWork(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'hr_manager'
}

/** Creating, editing, publishing, and closing job postings is HR Staff's own
 * process — HR Manager doesn't run the job board. Mirrors the database's
 * is_hr_staff_or_admin(). */
export function canPostJobs(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'hr_staff'
}

/** Creating a payroll period, generating the figures, adjusting them, and
 * submitting for approval is HR Staff's work. An HR Manager who could also
 * generate would be on both sides of the review — they approve payroll, so
 * they must not be the one who produced it. Mirrors the database's
 * protect_payroll_generation(). */
export function canPreparePayroll(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'hr_staff'
}

/** Deciding whether an application is qualified or rejected is an approval, so
 * it belongs to the HR Manager alongside payroll and leave. HR Staff picks the
 * pipeline back up at Interview Management, which lists qualified applicants
 * in its own right. Mirrors the database's screening trigger. */
export function canScreenApplicants(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'hr_manager'
}

/** Modules a role has no action in are hidden outright rather than shown with
 * every control disabled — a manager staring at a Job Posting page they can't
 * touch is just clutter. This is the single source of truth behind both the
 * sidebar and the route guards in App.tsx; the database enforces the same
 * split independently, so hiding a module is never the only thing stopping
 * someone. */
export function canAccessModule(role: UserRole | undefined, path: string): boolean {
  if (path === '/dashboard/job-postings') return canPostJobs(role)
  if (path === '/dashboard/recruitment') return canScreenApplicants(role)
  // Salary grades are set by HR Managers. HR Staff had a read-only copy of the
  // page with every button replaced by a "view only" badge, which is a module
  // that costs a click and gives nothing back — the figures they actually need
  // show up in the job offer and employee forms that consume them.
  if (path === '/dashboard/admin/salary-grades') return canApproveWork(role)
  return true
}
