import type { Database } from './database.types'

type UserRole = Database['public']['Enums']['user_role']

export type FinanceRole = 'finance_staff' | 'finance_manager' | 'accountant'

export type FinanceModule =
  | 'categories'
  | 'vendors'
  | 'vendorCategories'
  | 'accounts'
  | 'budgets'
  | 'allocations'

/**
 * archive covers "archive", "retire", "close" and "release" — the reversible
 * end of a record's life. Nothing in Finance master data is deleted.
 *
 * approve is the checker's half of maker/checker: admitting a proposed vendor
 * or category, or putting a drafted budget in force. It is deliberately not
 * the same cell as edit, because the whole point is that one person cannot
 * hold both on the same record.
 */
export type FinanceAction = 'read' | 'create' | 'edit' | 'archive' | 'approve'

/**
 * The role matrix from docs/fms-authorization.md, in one place.
 *
 * This does not GRANT anything: every cell is enforced by RLS, and a person who
 * gets past the navigation still gets 42501 from the database. What it does is
 * stop the UI offering buttons that cannot work — an Accountant should not see
 * "New Budget" and then be told no.
 *
 * Written as data rather than as conditionals so it can be read against the
 * document, and so a change is a line moved rather than a branch rewritten.
 */
const MATRIX: Record<FinanceModule, Record<FinanceAction, readonly UserRole[]>> = {
  categories: {
    read: ['finance_staff', 'finance_manager', 'accountant', 'admin'],
    // F4.2: authorship is the maker's alone. A checker who can also write the
    // record is approving their own work under another name.
    create: ['finance_staff'],
    edit: ['finance_staff'],
    // Archiving changes how past classifications read, so it stays governance
    // rather than authorship — the checker's, as F2 decided.
    archive: ['finance_manager'],
    approve: ['finance_manager'],
  },
  vendors: {
    read: ['finance_staff', 'finance_manager', 'accountant', 'admin'],
    create: ['finance_staff'],
    edit: ['finance_staff'],
    // Retiring a supplier the company has transacted with.
    archive: ['finance_manager'],
    approve: ['finance_manager'],
  },
  vendorCategories: {
    read: ['finance_staff', 'finance_manager', 'accountant', 'admin'],
    // What a vendor supplies is part of describing the vendor.
    create: ['finance_staff'],
    // A link row has nothing to edit: it exists or it does not.
    edit: [],
    archive: ['finance_staff'],
    approve: [],
  },
  accounts: {
    read: ['finance_staff', 'finance_manager', 'accountant', 'admin'],
    // The chart of accounts has a single owner.
    create: ['accountant'],
    edit: ['accountant'],
    archive: ['accountant'],
    // No maker/checker here yet: the chart is the Accountant's, and F4.2 does
    // not open accounting.
    approve: [],
  },
  budgets: {
    read: ['finance_staff', 'finance_manager', 'accountant', 'admin'],
    // F4.2: Staff draft the ceiling, the Manager puts it in force. This was
    // Manager-only, which made one person both author and approver of what the
    // company is allowed to spend.
    create: ['finance_staff'],
    edit: ['finance_staff', 'finance_manager'],
    archive: ['finance_manager'],
    approve: ['finance_manager'],
  },
  allocations: {
    read: ['finance_staff', 'finance_manager', 'accountant', 'admin'],
    create: ['finance_staff', 'finance_manager'],
    // Staff may edit their OWN active draw — see canEditAllocation.
    edit: ['finance_staff', 'finance_manager'],
    // Releasing returns money to the ceiling.
    archive: ['finance_manager'],
    approve: [],
  },
}

export function financeCan(
  role: UserRole | null | undefined,
  moduleName: FinanceModule,
  action: FinanceAction,
): boolean {
  if (!role) return false
  return MATRIX[moduleName][action].includes(role)
}

/**
 * Correcting a draw against a budget.
 *
 * The Finance Manager may edit any allocation. Finance Staff may edit their own
 * while it is still active — the same rule the RLS policy applies, restated
 * here only so the pencil icon does not appear on rows where it would fail.
 */
export function canEditAllocation(
  role: UserRole | null | undefined,
  allocation: { status: string; created_by: string | null },
  viewerId: string | null | undefined,
): boolean {
  if (role === 'finance_manager') return true
  if (role !== 'finance_staff') return false
  return allocation.status === 'active' && !!viewerId && allocation.created_by === viewerId
}

/** Does this person have any reason to be shown a write control in Finance? */
export function canWriteAnyFinanceModule(role: UserRole | null | undefined): boolean {
  if (!role) return false
  return (Object.keys(MATRIX) as FinanceModule[]).some((m) =>
    (['create', 'edit', 'archive', 'approve'] as FinanceAction[]).some((a) =>
      financeCan(role, m, a),
    ),
  )
}
