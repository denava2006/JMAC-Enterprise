import { Link } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/contexts/AuthContext'
import { useBudgets, useFinanceCategories, useVendors } from '@/hooks/useFinanceMasterData'
import { useFinanceRequests } from '@/hooks/useFinanceRequests'
import { useProcurementDemand, usePurchaseOrders } from '@/hooks/useProcurement'

export interface WaitingItem {
  label: string
  count: number
  to: string
}

/**
 * What is actually sitting on this person's desk.
 *
 * Every item is work only this role can clear, which is why the two Finance
 * roles see different lists: with a maker and a checker, "pending" is not one
 * queue but two, and showing everybody everything is how a two-step control
 * turns back into a formality nobody feels responsible for.
 *
 * Counting is done from data the viewer can already read -- the same queries
 * the pages behind these links use -- so a count can never reveal something the
 * row-level policies would not.
 */
export function waitingWork(
  role: string | null | undefined,
  data: {
    vendorsPending: number
    categoriesPending: number
    budgetsDraft: number
    ordersToApprove: number
    requestsToValidate: number
    demandToAccept: number
    ordersReturned: number
    vendorsReturned: number
    categoriesReturned: number
  },
): WaitingItem[] {
  if (role === 'finance_manager') {
    return [
      { label: 'Purchase orders to approve', count: data.ordersToApprove, to: '/fms/procurement' },
      { label: 'Budgets to approve', count: data.budgetsDraft, to: '/fms/budgets' },
      { label: 'Vendors to approve', count: data.vendorsPending, to: '/fms/vendors' },
      { label: 'Categories to approve', count: data.categoriesPending, to: '/fms/categories' },
    ].filter((i) => i.count > 0)
  }

  if (role === 'finance_staff') {
    // The maker's side of the conversation. A returned proposal is work coming
    // back, and it is the half that is easiest to lose: the checker acts and
    // then nothing tells the maker anything happened.
    return [
      { label: 'Requests to validate', count: data.requestsToValidate, to: '/fms/requests' },
      { label: 'Branch demand to act on', count: data.demandToAccept, to: '/fms/procurement' },
      { label: 'Orders returned to you', count: data.ordersReturned, to: '/fms/procurement' },
      { label: 'Vendors sent back', count: data.vendorsReturned, to: '/fms/vendors' },
      { label: 'Categories sent back', count: data.categoriesReturned, to: '/fms/categories' },
    ].filter((i) => i.count > 0)
  }

  // The Accountant owns the chart of accounts and approves nothing in F4.2, so
  // an empty list here is the honest answer rather than a gap to fill.
  return []
}

export function WaitingOnYou() {
  const { profile } = useAuth()
  const { data: vendors = [] } = useVendors()
  const { data: categories = [] } = useFinanceCategories()
  const { data: budgets = [] } = useBudgets()
  const { data: orders = [] } = usePurchaseOrders()
  const { data: requests = [] } = useFinanceRequests()
  const { data: demand = [] } = useProcurementDemand()

  const items = waitingWork(profile?.role, {
    vendorsPending: vendors.filter((v) => v.approval_status === 'pending_approval').length,
    categoriesPending: categories.filter((c) => c.approval_status === 'pending_approval').length,
    budgetsDraft: budgets.filter((b) => b.status === 'draft').length,
    ordersToApprove: orders.filter((o) => o.status === 'pending_approval').length,
    requestsToValidate: requests.filter((r) => r.status === 'pending_validation').length,
    // Both halves of the maker's procurement work: demand nobody has accepted
    // yet, and demand accepted but not yet turned into an order. Demand that is
    // already ordered is waiting on a delivery, not on a person.
    demandToAccept: demand.filter(
      (d) =>
        d.demand_state === 'awaiting_finance_review' ||
        d.demand_state === 'accepted_for_procurement',
    ).length,
    ordersReturned: orders.filter((o) => o.status === 'returned').length,
    vendorsReturned: vendors.filter((v) => v.approval_status === 'rejected').length,
    categoriesReturned: categories.filter((c) => c.approval_status === 'rejected').length,
  })

  if (items.length === 0) return null

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Waiting on you</h2>
          <Badge variant="warning">{items.reduce((sum, i) => sum + i.count, 0)}</Badge>
        </div>
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.label}>
              <Link
                to={item.to}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted"
              >
                <span>{item.label}</span>
                <span className="tabular-nums font-semibold">{item.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
