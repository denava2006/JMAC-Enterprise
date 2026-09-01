import { Boxes, FileBarChart, LayoutDashboard, Package, Receipt, ReceiptText, ScrollText, ShoppingCart, Tags } from 'lucide-react'
import { NavRow, type NavItem } from '@/components/layout/Sidebar'
import { JmacWordmark } from '@/components/Brand'
import { useAuth } from '@/contexts/AuthContext'
import { hasAnyManagerAssignment } from '@/lib/portals'

/**
 * The POS portal's navigation.
 *
 * Two audiences work here, and they see different things.
 *
 *   Cashier   sells, and looks up what they themselves sold. Nothing else.
 *   Manager   the same, plus how the branch is trading, what it holds, and how
 *             its catalogue is filed.
 *
 * Manager reporting is operational and carries no cost or profit. Audit Logs
 * remain a later module; the enterprise HRMS audit log is not a branch's to
 * read.
 *
 * Visibility is not authorization. A cashier who types /pos/stock is redirected
 * by the route guard, and the database refuses them independently:
 * get_branch_inventory and get_branch_movements are manager-gated and return an
 * empty set. The same is true of every item here.
 *
 * `hasAnyManagerAssignment` decides only whether manager navigation is worth
 * offering. Anything branch-sensitive -- which branch may actually be managed
 * -- is decided per branch by the page, and finally by the database.
 */
const cashierNav: NavItem[] = [
  { label: 'POS', to: '/pos/till', icon: ShoppingCart },
  { label: 'Transactions', to: '/pos/transactions', icon: Receipt },
]

// Ordered and named to match the Administrator's POS Management group, so the
// two read as one system. Same names and icons; NOT the same permissions --
// each page decides what a manager may do, and the database decides again.
//
// POS Requests is reachable from Products and Inventory rather than sitting
// here: a request is something you raise about a product, not a place you go.
const managerNav: NavItem[] = [
  { label: 'Dashboard', to: '/pos/dashboard', icon: LayoutDashboard },
  { label: 'POS', to: '/pos/till', icon: ShoppingCart },
  { label: 'Products', to: '/pos/products', icon: Package },
  { label: 'Categories', to: '/pos/categories', icon: Tags },
  { label: 'Inventory', to: '/pos/stock', icon: Boxes },
  { label: 'Transactions', to: '/pos/transactions', icon: Receipt },
  { label: 'POS Reports', to: '/pos/reports', icon: FileBarChart },
  { label: 'POS Audit Logs', to: '/pos/audit-logs', icon: ScrollText },
  { label: 'POS Settings', to: '/pos/settings', icon: ReceiptText },
]

export function PosSidebar() {
  const { posAccess } = useAuth()
  const nav = hasAnyManagerAssignment(posAccess) ? managerNav : cashierNav

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex print:hidden">
      <div className="flex h-16 flex-col justify-center border-b border-border px-5">
        <JmacWordmark className="text-[15px] text-foreground" />
        <span className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Point of Sale
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {nav.map((item) => (
          <NavRow key={item.to} item={item} />
        ))}
      </nav>
    </aside>
  )
}
