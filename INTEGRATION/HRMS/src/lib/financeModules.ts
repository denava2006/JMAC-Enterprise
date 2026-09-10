import type { ComponentType } from 'react'
import {
  ArrowDownLeft,
  BookMarked,
  BookOpen,
  FileBarChart,
  Landmark,
  LayoutDashboard,
  PackageCheck,
  PiggyBank,
  Receipt,
  ReceiptText,
  Scale,
  Store,
  Tags,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import type { UserRole } from '@/lib/enums'

/**
 * Which Finance modules belong to whose workspace.
 *
 * The three Finance roles do different jobs -- Staff prepare and classify,
 * the Manager reviews and approves, the Accountant pays and keeps the books --
 * but until now they all opened the same thirteen-item sidebar. A workspace
 * listing nine modules a person has no action in is not neutral: it buries the
 * three that are theirs.
 *
 * This table is the one place that answers "may this role open this module".
 * The sidebar builds itself from it and the route guard asks it the same
 * question, so a module cannot be hidden from the menu while its URL stays
 * open -- which is the failure a second array would eventually produce.
 *
 * It is NOT a security boundary. RLS, the RPCs and the triggers are, and they
 * are unchanged by this file; a hidden module is a tidier desk, not a lock.
 * Nor does it decide what a role may DO on a page it can open -- that is
 * financeCan() in financeAuthority.ts, and the two are deliberately separate:
 * every role that reaches Reimbursements sees a different set of buttons there.
 *
 * The Administrator holds every module, and that separation is exactly why it
 * costs nothing: opening a page is not authority to act on it. Every write in
 * FMS is gated either on financeCan(), whose matrix gives 'admin' read and
 * nothing else, or on a `role === '<finance role>'` check that 'admin' does
 * not match -- and underneath both, on has_finance_privilege(), which requires
 * the profile's role to EQUAL the granted finance role. An Administrator
 * therefore sees every page and no button, in that order of guarantee.
 */

export type FinanceGroup =
  | 'Operations'
  | 'Reference'
  | 'Review & Approval'
  | 'Monitoring'
  | 'Payments & Treasury'
  | 'Finance Control'
  | 'Accounting'

/** The order groups appear in a sidebar. Overview sits above all of them. */
export const FINANCE_GROUP_ORDER: FinanceGroup[] = [
  'Operations',
  'Review & Approval',
  'Payments & Treasury',
  'Finance Control',
  'Monitoring',
  'Reference',
  'Accounting',
]

export interface FinanceModule {
  id: string
  label: string
  route: string
  icon: ComponentType<{ className?: string }>
  /**
   * Where this module sits for each role, and by its absence, whether the role
   * may open it at all. One field carries both because they are the same
   * decision: a module in nobody's group is in nobody's workspace.
   */
  placement: Partial<Record<UserRole, FinanceGroup | 'top'>>
  /** Shown on the Overview shortcut tiles. Modules without one are not tiles. */
  blurb?: string
}

/**
 * Every module under /fms, and who it belongs to.
 *
 * Read the placement column as the audit result, not as an aspiration. Where
 * the target matrix and the shipped workflow disagreed, the workflow won and
 * the reason is written beside it.
 */
export const FINANCE_MODULES: FinanceModule[] = [
  {
    id: 'overview',
    label: 'Overview',
    route: '/fms',
    icon: LayoutDashboard,
    placement: { finance_staff: 'top', finance_manager: 'top', accountant: 'top', admin: 'top' },
  },

  // ---------------------------------------------------------------- making
  {
    id: 'requests',
    label: 'Requests',
    route: '/fms/requests',
    icon: ReceiptText,
    placement: { finance_staff: 'Operations', finance_manager: 'Review & Approval', admin: 'Operations' },
  },
  {
    id: 'procurement',
    label: 'Procurement',
    route: '/fms/procurement',
    icon: PackageCheck,
    // Staff build the order, the Manager approves it. The Accountant picks the
    // chain up at the invoice, and create_purchase_order refuses them outright.
    placement: { finance_staff: 'Operations', finance_manager: 'Review & Approval', admin: 'Operations' },
  },
  {
    id: 'budgets',
    label: 'Budgets',
    route: '/fms/budgets',
    icon: PiggyBank,
    blurb: 'Approved ceilings, and the allocations drawn against them.',
    placement: { finance_staff: 'Operations', finance_manager: 'Monitoring', admin: 'Finance Control' },
  },
  {
    id: 'invoices',
    label: 'Supplier Invoices',
    route: '/fms/invoices',
    icon: FileBarChart,
    blurb: 'What suppliers have billed, and what is still owed on it.',
    // All three, for three different reasons: Staff prepare documents, the
    // Manager reviews, and the Accountant records and pays. One page.
    placement: {
      finance_staff: 'Operations',
      finance_manager: 'Review & Approval',
      accountant: 'Payments & Treasury',
      admin: 'Operations',
    },
  },
  {
    id: 'reimbursements',
    label: 'Reimbursements',
    route: '/fms/reimbursements',
    icon: Receipt,
    placement: {
      finance_staff: 'Operations',
      finance_manager: 'Review & Approval',
      accountant: 'Payments & Treasury',
      admin: 'Operations',
    },
  },

  // ------------------------------------------------------------- master data
  {
    id: 'vendors',
    label: 'Vendors',
    route: '/fms/vendors',
    icon: Store,
    blurb: 'Suppliers the company pays, and what each one supplies.',
    // The Manager is here because the shipped workflow makes them the approver
    // of a proposed vendor -- financeCan(finance_manager, 'vendors', 'approve')
    // is true, and their own Waiting-on-you queue links here. Hiding it would
    // strand every vendor Staff propose.
    //
    // The Accountant is not: they need a supplier's NAME on an invoice, which
    // the invoice already carries, not a vendor-management workspace.
    placement: { finance_staff: 'Reference', finance_manager: 'Review & Approval', admin: 'Finance Control' },
  },
  {
    id: 'categories',
    label: 'Categories',
    route: '/fms/categories',
    icon: Tags,
    blurb: 'How money is classified — separate from POS product categories.',
    // Same reason as vendors: Staff propose, the Manager approves.
    placement: { finance_staff: 'Reference', finance_manager: 'Review & Approval', admin: 'Finance Control' },
  },

  // -------------------------------------------------------- money in and out
  {
    id: 'sales',
    label: 'Sales & Collections',
    route: '/fms/sales',
    icon: TrendingUp,
    // Not Finance Staff. The audit looked for work they do here and found
    // none: this page is read-only over POS sales, and everything downstream
    // of it -- settlement, banking, the fee -- is accountant-only in RLS. It
    // was in their sidebar because it was in everyone's.
    placement: { finance_manager: 'Monitoring', accountant: 'Payments & Treasury', admin: 'Operations' },
  },
  {
    id: 'settlements',
    label: 'Settlements',
    route: '/fms/settlements',
    icon: ArrowDownLeft,
    blurb: 'Collections banked, and the fees taken out of them.',
    placement: { finance_manager: 'Monitoring', accountant: 'Payments & Treasury', admin: 'Operations' },
  },
  {
    id: 'payroll',
    label: 'Payroll Finance',
    route: '/fms/payroll',
    icon: Users,
    // Finance Staff are absent here in the database too: payroll_finance_items
    // admits only accountant and finance_manager, so this is the one module
    // where hiding it and refusing it agree with RLS exactly.
    placement: { finance_manager: 'Review & Approval', accountant: 'Payments & Treasury', admin: 'Finance Control' },
  },
  {
    id: 'treasury',
    label: 'Cash & Bank',
    route: '/fms/treasury',
    icon: Wallet,
    blurb: 'Where the money is, and every movement through it.',
    // Finance Control for the Administrator: where the money sits is a
    // standing position to oversee, not a day's work to get through.
    placement: {
      finance_manager: 'Monitoring',
      accountant: 'Payments & Treasury',
      admin: 'Finance Control',
    },
  },

  // ------------------------------------------------------------- the books
  {
    id: 'accounts',
    label: 'Chart of Accounts',
    route: '/fms/accounts',
    icon: Landmark,
    blurb: 'The accounts money moves through, and what it is posted against.',
    // The Manager reads it; only the Accountant gets New account, which
    // financeCan already decides on the page itself.
    placement: { finance_manager: 'Accounting', accountant: 'Accounting', admin: 'Accounting' },
  },
  {
    id: 'journal',
    label: 'Journal Entries',
    route: '/fms/journal',
    icon: BookOpen,
    placement: { finance_manager: 'Accounting', accountant: 'Accounting', admin: 'Accounting' },
  },
  {
    id: 'ledger',
    label: 'General Ledger',
    route: '/fms/ledger',
    icon: BookMarked,
    placement: { finance_manager: 'Accounting', accountant: 'Accounting', admin: 'Accounting' },
  },
  {
    id: 'trial-balance',
    label: 'Trial Balance',
    route: '/fms/trial-balance',
    icon: Scale,
    placement: { finance_manager: 'Accounting', accountant: 'Accounting', admin: 'Accounting' },
  },
  {
    id: 'reports',
    label: 'Reports',
    route: '/fms/reports',
    icon: FileBarChart,
    placement: { finance_manager: 'Accounting', accountant: 'Accounting', admin: 'Accounting' },
  },
]

const BY_ROUTE = new Map(FINANCE_MODULES.map((m) => [m.route, m]))

/**
 * May this role open this module?
 *
 * The sidebar and the route guard both call this, which is the whole point:
 * hiding a link and refusing its URL are one decision made once.
 *
 * A route this table does not know is allowed through. Refusing it would mean
 * every new /fms page is silently dark until somebody remembers this file, and
 * a guard that fails closed on its own ignorance is a guard people route
 * around.
 */
export function canAccessFinanceModule(
  role: UserRole | null | undefined,
  route: string,
): boolean {
  const moduleDef = BY_ROUTE.get(route)
  if (!moduleDef) return true
  if (!role) return false
  return moduleDef.placement[role] !== undefined
}

export interface FinanceNavSection {
  /** Undefined for the ungrouped rows at the top of the sidebar. */
  group?: FinanceGroup
  modules: FinanceModule[]
}

/**
 * The sidebar for one role: the ungrouped rows first, then each group that has
 * anything in it, in FINANCE_GROUP_ORDER. Built rather than written out, so
 * three sidebars cannot drift apart from the table above.
 */
export function financeNavFor(role: UserRole | null | undefined): FinanceNavSection[] {
  if (!role) return []
  const mine = FINANCE_MODULES.filter((m) => m.placement[role] !== undefined)

  const sections: FinanceNavSection[] = []
  const top = mine.filter((m) => m.placement[role] === 'top')
  if (top.length) sections.push({ modules: top })

  for (const group of FINANCE_GROUP_ORDER) {
    const modules = mine.filter((m) => m.placement[role] === group)
    if (modules.length) sections.push({ group, modules })
  }
  return sections
}

/**
 * The shortcut tiles on the Overview.
 *
 * Filtered through the same policy, because a tile pointing at a module the
 * viewer will be turned away from is worse than no tile. Capped so the
 * Overview stays a summary rather than becoming a second sidebar.
 */
export function financeOverviewTiles(role: UserRole | null | undefined, limit = 4): FinanceModule[] {
  if (!role) return []
  return FINANCE_MODULES.filter(
    (m) => m.blurb && m.placement[role] !== undefined,
  ).slice(0, limit)
}
