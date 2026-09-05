import { Link } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/contexts/AuthContext'
import { useBudgets, useFinanceCategories, useVendors } from '@/hooks/useFinanceMasterData'
import { useFinanceRequests } from '@/hooks/useFinanceRequests'
import { useProcurementDemand, usePurchaseOrders } from '@/hooks/useProcurement'
import {
  useSupplierInvoices,
  useInvoiceablePurchaseOrders,
} from '@/hooks/useSupplierInvoices'
import { useReimbursements, useReimbursementPayments } from '@/hooks/useReimbursements'
import { usePayrollFinanceBatches, usePayrollDisbursements } from '@/hooks/usePayrollFinance'

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
    draftsInProgress: number
    vendorsReturned: number
    categoriesReturned: number
    invoicesToReview: number
    invoiceDrafts: number
    invoicesReturned: number
    ordersToInvoice: number
    // F7. Claims and payables are different counts and stay separate rows:
    // one is a document to decide, the other is money to send.
    reimbursementsToReview: number
    reimbursementsToApprove: number
    reimbursementsToPay: number
    reimbursementPaymentsToApprove: number
    payrollToDisburse: number
    payrollDisbursementsToApprove: number
  },
): WaitingItem[] {
  if (role === 'finance_manager') {
    return [
      { label: 'Purchase orders to approve', count: data.ordersToApprove, to: '/fms/procurement' },
      { label: 'Budgets to approve', count: data.budgetsDraft, to: '/fms/budgets' },
      { label: 'Vendors to approve', count: data.vendorsPending, to: '/fms/vendors' },
      { label: 'Categories to approve', count: data.categoriesPending, to: '/fms/categories' },
      { label: 'Supplier invoices to review', count: data.invoicesToReview, to: '/fms/invoices' },
      {
        label: 'Reimbursements to approve',
        count: data.reimbursementsToApprove,
        to: '/fms/reimbursements',
      },
      {
        label: 'Reimbursement payments to approve',
        count: data.reimbursementPaymentsToApprove,
        to: '/fms/reimbursements',
      },
      {
        label: 'Payroll disbursements to approve',
        count: data.payrollDisbursementsToApprove,
        to: '/fms/payroll',
      },
    ].filter((i) => i.count > 0)
  }

  // The Accountant's own desk. They own the chart of accounts and, from F5,
  // the accounts payable side: recording what suppliers billed and putting it
  // in front of the Manager. They approve nothing, so nothing here is an
  // approval.
  if (role === 'accountant') {
    return [
      { label: 'Invoices returned to you', count: data.invoicesReturned, to: '/fms/invoices' },
      { label: 'Invoice drafts to submit', count: data.invoiceDrafts, to: '/fms/invoices' },
      // A count of PURCHASE ORDERS, not of invoices: delivered orders with no
      // live supplier invoice against them. "to invoice" read like a number of
      // invoice records, which is a different figure on a different page.
      // Clicking it opens Record invoice with those orders listed.
      {
        label: 'Delivered orders awaiting invoice',
        count: data.ordersToInvoice,
        to: '/fms/invoices?record=1',
      },
      // Approved claims and finalized payroll: money authorised and waiting
      // for the Accountant to send it.
      {
        label: 'Approved reimbursements awaiting payment',
        count: data.reimbursementsToPay,
        to: '/fms/reimbursements',
      },
      {
        label: 'Payroll awaiting disbursement',
        count: data.payrollToDisburse,
        to: '/fms/payroll',
      },
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
      { label: 'Drafts you have not submitted', count: data.draftsInProgress, to: '/fms/procurement' },
      { label: 'Vendors sent back', count: data.vendorsReturned, to: '/fms/vendors' },
      { label: 'Categories sent back', count: data.categoriesReturned, to: '/fms/categories' },
      {
        label: 'Reimbursements awaiting review',
        count: data.reimbursementsToReview,
        to: '/fms/reimbursements',
      },
    ].filter((i) => i.count > 0)
  }

  // Everybody else -- an Administrator has oversight, not a work queue.
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
  const { data: invoices = [] } = useSupplierInvoices()
  const { data: invoiceable = [] } = useInvoiceablePurchaseOrders()
  const { data: claims = [] } = useReimbursements()
  const { data: reimbursementPayments = [] } = useReimbursementPayments()
  const { data: payrollBatches = [] } = usePayrollFinanceBatches()
  const { data: payrollDisbursements = [] } = usePayrollDisbursements()

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
    draftsInProgress: orders.filter((o) => o.status === 'draft').length,
    vendorsReturned: vendors.filter((v) => v.approval_status === 'rejected').length,
    categoriesReturned: categories.filter((c) => c.approval_status === 'rejected').length,
    invoicesToReview: invoices.filter((i) => i.status === 'for_review').length,
    invoiceDrafts: invoices.filter((i) => i.status === 'draft').length,
    invoicesReturned: invoices.filter((i) => i.status === 'returned').length,
    ordersToInvoice: invoiceable.length,
    // Every F7 count is derived from authoritative state, never stored.
    reimbursementsToReview: claims.filter((c) => c.status === 'pending_validation').length,
    reimbursementsToApprove: claims.filter((c) => c.status === 'pending_approval').length,
    // Approved claims that still owe something — not a count of claims, and
    // not a count of payments.
    reimbursementsToPay: claims.filter(
      (c) => c.status === 'approved' && Number(c.balance_due ?? 0) > 0,
    ).length,
    reimbursementPaymentsToApprove: reimbursementPayments.filter(
      (p) => p.status === 'for_approval',
    ).length,
    payrollToDisburse: payrollBatches.filter(
      (b) => Number(b.available_to_prepare ?? 0) > 0,
    ).length,
    payrollDisbursementsToApprove: payrollDisbursements.filter(
      (d) => d.status === 'for_approval',
    ).length,
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
