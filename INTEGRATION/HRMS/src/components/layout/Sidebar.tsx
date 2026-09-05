import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  ScrollText,
  Users,
  Briefcase,
  ClipboardList,
  CalendarSearch,
  Truck,
  Building2,
  Layers,
  DollarSign,
  Settings,
  ShieldCheck,
  CalendarClock,
  CalendarCheck,
  Wallet,
  FileBarChart,
  MapPin,
  Store,
  Receipt,
  Package,
  Tags,
  Boxes,
  ShoppingCart,
  Receipt as ReceiptIcon,
  PiggyBank,
  Landmark,
  ReceiptText,
  PackageCheck,
  TrendingUp,
  ArrowDownLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { portalForPath } from '@/lib/portals'
import { canAccessModule } from '@/lib/roles'
import { JmacWordmark } from '@/components/Brand'
import { BuildStamp } from '@/components/BuildStamp'

export interface NavItem {
  label: string
  to: string
  icon: React.ComponentType<{ className?: string }>
  disabled?: boolean
}

const mainNav: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
  { label: 'Job Posting', to: '/dashboard/job-postings', icon: Briefcase },
  { label: 'Recruitment', to: '/dashboard/recruitment', icon: ClipboardList },
  { label: 'Interview Management', to: '/dashboard/interviews', icon: CalendarSearch },
  { label: 'Deployment', to: '/dashboard/deployment', icon: Truck },
  { label: 'Employees', to: '/dashboard/employees', icon: Users },
  { label: 'Attendance', to: '/dashboard/attendance', icon: CalendarClock },
  { label: 'Leave', to: '/dashboard/leave', icon: CalendarCheck },
  { label: 'Payroll', to: '/dashboard/payroll', icon: Wallet },
  { label: 'Reports', to: '/dashboard/reports', icon: FileBarChart },
]

// The Employee Portal is a much smaller, self-service-only slice of the same
// app -- its own nav array (rather than filtering mainNav) since the route
// targets are entirely different pages from the HR/Admin ones of the same name.
const employeeNav: NavItem[] = [
  { label: 'My Dashboard', to: '/dashboard/my-dashboard', icon: LayoutDashboard },
  { label: 'My Attendance', to: '/dashboard/my-attendance', icon: CalendarClock },
  { label: 'My Leave', to: '/dashboard/my-leave', icon: CalendarCheck },
  { label: 'My Payroll', to: '/dashboard/my-payroll', icon: Wallet },
  { label: 'My Requests', to: '/dashboard/my-requests', icon: ReceiptText },
]

// Reference data every HR role can reach. What each may actually *do* there
// differs by role (staff prepares change requests, manager approves, salary
// grades are manager-only) and is enforced in RLS — see
// 20260729070000_reference_data_approval_workflow.sql.
const referenceNav: NavItem[] = [
  { label: 'Departments', to: '/dashboard/admin/departments', icon: Building2 },
  { label: 'Positions', to: '/dashboard/admin/positions', icon: Layers },
  { label: 'Salary Grades', to: '/dashboard/admin/salary-grades', icon: DollarSign },
  { label: 'Work Schedules', to: '/dashboard/admin/work-schedules', icon: CalendarClock },
]

// Finance. Its own array rather than a filter over mainNav: a Finance Manager
// standing in /fms wants budgets and vendors, not the HR modules they have no
// access to. The same reasoning as employeeNav above.
const financeNav: NavItem[] = [
  { label: 'Overview', to: '/fms', icon: LayoutDashboard },
  { label: 'Requests', to: '/fms/requests', icon: ReceiptText },
  { label: 'Sales & Collections', to: '/fms/sales', icon: TrendingUp },
  { label: 'Procurement', to: '/fms/procurement', icon: PackageCheck },
  { label: 'Budgets', to: '/fms/budgets', icon: PiggyBank },
  { label: 'Settlements', to: '/fms/settlements', icon: ArrowDownLeft },
  { label: 'Supplier Invoices', to: '/fms/invoices', icon: FileBarChart },
  // The other two things Finance pays out: an employee's own money back, and
  // a finalized payroll. Grouped with the payables rather than scattered.
  { label: 'Reimbursements', to: '/fms/reimbursements', icon: Receipt },
  { label: 'Payroll Finance', to: '/fms/payroll', icon: Users },
  { label: 'Cash & Bank', to: '/fms/treasury', icon: Wallet },
  { label: 'Vendors', to: '/fms/vendors', icon: Store },
  { label: 'Categories', to: '/fms/categories', icon: Tags },
  { label: 'Chart of Accounts', to: '/fms/accounts', icon: Landmark },
]

// Genuinely Administrator-only.
const adminNav: NavItem[] = [
  { label: 'HR Accounts', to: '/dashboard/admin/accounts', icon: ShieldCheck },
  { label: 'Branches', to: '/dashboard/admin/branches', icon: MapPin },
  { label: 'Settings', to: '/dashboard/admin/settings', icon: Settings },
]

// The POS modules an Administrator owns, grouped so they read as one subsystem
// inside the parent system rather than as a second application.
//
// An Administrator never leaves this layout. They administer HRMS/JMAC, and the
// POS is part of it -- switching to the POS workspace would hide HR from the
// person responsible for it. The first entry is the selling screen itself: the
// same PosTillPage a cashier uses, rendered here so an Administrator can work a
// till without stepping out of the back office.
//
// Audit Logs belong in this group eventually. POS Reports is deliberately
// distinct from the existing HR Reports module above.
const posAdminNav: NavItem[] = [
  { label: 'POS', to: '/dashboard/admin/pos', icon: ShoppingCart },
  // Granting till access is account administration, so it belongs here rather
  // than in the POS sidebar, which is the cashier's working set.
  { label: 'POS Access', to: '/dashboard/admin/pos-access', icon: Store },
  { label: 'Products', to: '/dashboard/admin/pos-products', icon: Package },
  { label: 'Categories', to: '/dashboard/admin/pos-categories', icon: Tags },
  { label: 'Inventory', to: '/dashboard/admin/pos-inventory', icon: Boxes },
  { label: 'Transactions', to: '/dashboard/admin/pos-transactions', icon: ReceiptIcon },
  { label: 'POS Reports', to: '/dashboard/admin/pos-reports', icon: FileBarChart },
  // Fees and the payment QR, per branch. Its own item rather than a section of
  // Settings: that page is system-wide, this is per-branch trading config.
  { label: 'POS Requests', to: '/dashboard/admin/pos-requests', icon: ClipboardList },
  { label: 'POS Audit Logs', to: '/dashboard/admin/pos-audit-logs', icon: ScrollText },
  { label: 'POS Settings', to: '/dashboard/admin/pos-settings', icon: Receipt },
]

/**
 * A portal's landing route -- /dashboard, /fms, /pos -- is a prefix of every
 * page inside that portal, so it has to match exactly or it stays highlighted
 * everywhere. This used to name /dashboard specifically, which left Finance
 * with two lit rows on every /fms/* page: Overview and the page you were
 * actually on. One path segment means a portal root; anything deeper is a page
 * within one, and new portals get the right behaviour without being listed.
 */
export function isPortalRoot(to: string): boolean {
  return to.split('/').filter(Boolean).length === 1
}

/** Shared with the POS sidebar so both portals render navigation identically. */
export function NavRow({ item, end }: { item: NavItem; end?: boolean }) {
  const Icon = item.icon
  if (item.disabled) {
    return (
      <div className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground/50">
        <Icon className="h-4 w-4" />
        {item.label}
        <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">Soon</span>
      </div>
    )
  }
  return (
    <NavLink
      to={item.to}
      end={end ?? isPortalRoot(item.to)}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          isActive ? 'bg-primary text-primary-foreground shadow-sm' : 'text-foreground hover:bg-muted'
        )
      }
    >
      <Icon className="h-4 w-4" />
      {item.label}
    </NavLink>
  )
}

export function Sidebar() {
  const { profile } = useAuth()
  const { pathname } = useLocation()

  // Which menu to show follows the portal the person is standing in, not their
  // role. An HR Manager is an employee too: on their own attendance page they
  // need self-service navigation, and on the organization's they need HR's.
  // Reading this from the role is what made those two mutually exclusive.
  const portal = portalForPath(pathname)
  const inSelfService = portal === 'employee'
  const inFinance = portal === 'finance'
  const visibleMainNav = inSelfService
    ? employeeNav
    : inFinance
      ? financeNav
      : mainNav.filter((item) => canAccessModule(profile?.role, item.to))

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex print:hidden">
      <div className="flex h-16 flex-col justify-center border-b border-border px-5">
        <JmacWordmark className="text-[15px] text-foreground" />
        <span className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {inSelfService ? 'My Workspace' : inFinance ? 'Finance' : 'Human Resources'}
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {visibleMainNav.map((item) => (
          <NavRow key={item.to} item={item} />
        ))}

        {!inSelfService && !inFinance && (
          <>
            <p className="mb-1 mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Reference Data
            </p>
            {referenceNav
              .filter((item) => canAccessModule(profile?.role, item.to))
              .map((item) => (
                <NavRow key={item.to} item={item} />
              ))}
          </>
        )}

        {profile?.role === 'admin' && !inFinance && (
          <>
            <p className="mb-1 mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Administration
            </p>
            {adminNav.map((item) => (
              <NavRow key={item.to} item={item} />
            ))}

            <p className="mb-1 mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              POS Management
            </p>
            {posAdminNav.map((item) => (
              <NavRow key={item.to} item={item} />
            ))}
          </>
        )}
      </nav>

      {/* Which build, which environment, which database. Small enough to ignore
          and specific enough to settle an argument. */}
      <div className="border-t border-border p-2">
        <BuildStamp />
      </div>
    </aside>
  )
}
