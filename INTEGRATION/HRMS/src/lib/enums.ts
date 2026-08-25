import type { Enums } from '@/lib/database.types'

/**
 * Friendly names for the database's enum types.
 *
 * `supabase gen types typescript` emits `Enums<'user_role'>` and nothing more
 * readable, so these aliases exist for the ~40 call sites that want a name.
 * They used to be appended by hand to the *end of the generated file*, which
 * meant every regeneration silently deleted them and produced 44 `TS2305`
 * errors in modules that had nothing to do with the change being made. This
 * module is application-owned, so regeneration can no longer touch it.
 *
 * Every alias wraps `Enums<'…'>` rather than restating the values as a string
 * union. That keeps the database the single source of truth: rename a value in
 * a migration, regenerate, and every affected call site fails to compile —
 * which is the whole point. A hand-written union would go on compiling and
 * quietly disagree with the database instead.
 *
 * Not everything belongs here. Six modules already own the alias for the enum
 * they are about, next to the labels that use it —
 * `applicationStatusLabels.ts` (`ApplicationStatus`), `jobPostingLabels.ts`
 * (`EmploymentType`), `deploymentLabels.ts` (`OfferStatus`,
 * `ContractStatus`), `posInventory.ts` (`MovementType`) and
 * `posTransactions.ts` (`SaleStatus`). Those stay where they are. This module
 * is for the aliases that have no single natural home, or that several
 * unrelated areas share.
 */

/* ------------------------------------------------------------ identity */

/** Enterprise role on `profiles.role`. Global and single-valued. */
export type UserRole = Enums<'user_role'>

/** POS role on `pos_branch_assignments.pos_role`. Branch-scoped: the same
 * person can be a manager at one branch and a cashier at another. */
export type PosRole = Enums<'pos_role'>

/* ------------------------------------------------------------------ HR */

export type AttendanceStatus = Enums<'attendance_status'>
export type EmploymentStatus = Enums<'employment_status'>
export type InterviewStatus = Enums<'interview_status'>
export type InterviewType = Enums<'interview_type'>
export type JobPostingStatus = Enums<'job_posting_status'>
export type LeaveRequestStatus = Enums<'leave_request_status'>
export type PayrollStatus = Enums<'payroll_status'>
export type ReportFormat = Enums<'report_format'>

/** Reference-data change requests. Both were hand-written string unions in
 * `useChangeRequests.ts` until this cleanup — they happened to match the
 * database, but nothing would have failed if they stopped matching. */
export type ChangeRequestOperation = Enums<'change_request_operation'>
export type ChangeRequestStatus = Enums<'change_request_status'>

/* ----------------------------------------------------------------- POS */

export type PosProductStatus = Enums<'pos_product_status'>
export type PosRequestType = Enums<'pos_request_type'>
export type PosRequestStatus = Enums<'pos_request_status'>
export type PosAuditEventType = Enums<'pos_audit_event_type'>
export type PosAuditEntityType = Enums<'pos_audit_entity_type'>
