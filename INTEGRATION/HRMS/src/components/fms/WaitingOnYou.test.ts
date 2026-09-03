import { describe, expect, it } from 'vitest'
import { waitingWork } from '@/components/fms/WaitingOnYou'

const NOTHING = {
  vendorsPending: 0,
  categoriesPending: 0,
  budgetsDraft: 0,
  ordersToApprove: 0,
  requestsToValidate: 0,
  demandToAccept: 0,
  ordersReturned: 0,
  draftsInProgress: 0,
  vendorsReturned: 0,
  categoriesReturned: 0,
  invoicesToReview: 0,
  invoiceDrafts: 0,
  invoicesReturned: 0,
  ordersToInvoice: 0,
}

const EVERYTHING = {
  vendorsPending: 2,
  categoriesPending: 1,
  budgetsDraft: 3,
  ordersToApprove: 4,
  requestsToValidate: 5,
  demandToAccept: 6,
  ordersReturned: 7,
  draftsInProgress: 10,
  vendorsReturned: 8,
  categoriesReturned: 9,
  invoicesToReview: 11,
  invoiceDrafts: 12,
  invoicesReturned: 13,
  ordersToInvoice: 14,
}

describe('what is waiting on the checker', () => {
  it('lists only decisions a Finance Manager can actually make', () => {
    expect(waitingWork('finance_manager', EVERYTHING)).toEqual([
      { label: 'Purchase orders to approve', count: 4, to: '/fms/procurement' },
      { label: 'Budgets to approve', count: 3, to: '/fms/budgets' },
      { label: 'Vendors to approve', count: 2, to: '/fms/vendors' },
      { label: 'Categories to approve', count: 1, to: '/fms/categories' },
      { label: 'Supplier invoices to review', count: 11, to: '/fms/invoices' },
    ])
  })

  it('does not put the maker’s work on the checker’s desk', () => {
    const labels = waitingWork('finance_manager', EVERYTHING).map((i) => i.label)
    expect(labels).not.toContain('Requests to validate')
    expect(labels).not.toContain('Branch demand to act on')
    expect(labels).not.toContain('Orders returned to you')
  })
})

describe('what is waiting on the maker', () => {
  it('lists only work Finance Staff can actually clear', () => {
    expect(waitingWork('finance_staff', EVERYTHING)).toEqual([
      { label: 'Requests to validate', count: 5, to: '/fms/requests' },
      { label: 'Branch demand to act on', count: 6, to: '/fms/procurement' },
      { label: 'Orders returned to you', count: 7, to: '/fms/procurement' },
      { label: 'Drafts you have not submitted', count: 10, to: '/fms/procurement' },
      { label: 'Vendors sent back', count: 8, to: '/fms/vendors' },
      { label: 'Categories sent back', count: 9, to: '/fms/categories' },
    ])
  })

  it('does not offer the maker an approval', () => {
    const labels = waitingWork('finance_staff', EVERYTHING).map((i) => i.label)
    expect(labels.some((l) => l.includes('to approve'))).toBe(false)
  })
})

describe('what is waiting on the Accountant', () => {
  // F5 gave them a desk. Before supplier invoices existed this list was empty
  // and the test said so; recording what suppliers billed is now their work.
  it('lists the accounts payable work only they can clear', () => {
    expect(waitingWork('accountant', EVERYTHING)).toEqual([
      { label: 'Invoices returned to you', count: 13, to: '/fms/invoices' },
      { label: 'Invoice drafts to submit', count: 12, to: '/fms/invoices' },
      { label: 'Delivered orders to invoice', count: 14, to: '/fms/invoices' },
    ])
  })

  it('offers them no approval, because they approve nothing', () => {
    const labels = waitingWork('accountant', EVERYTHING).map((i) => i.label)
    expect(labels.some((l) => l.includes('to approve'))).toBe(false)
    expect(labels.some((l) => l.includes('to review'))).toBe(false)
  })

  it('does not put the maker’s procurement work on their desk', () => {
    const labels = waitingWork('accountant', EVERYTHING).map((i) => i.label)
    expect(labels).not.toContain('Branch demand to act on')
    expect(labels).not.toContain('Requests to validate')
  })
})

describe('an empty desk', () => {
  it.each(['finance_manager', 'finance_staff', 'accountant'])(
    'says nothing to %s when nothing waits',
    (role) => {
      expect(waitingWork(role, NOTHING)).toEqual([])
    },
  )

  it('drops the rows that are at zero rather than listing them', () => {
    expect(waitingWork('finance_manager', { ...NOTHING, vendorsPending: 1 })).toEqual([
      { label: 'Vendors to approve', count: 1, to: '/fms/vendors' },
    ])
  })

  it.each(['admin', 'employee', null, undefined])(
    'has nothing for %s, who has oversight rather than a work queue',
    (role) => {
      expect(waitingWork(role, EVERYTHING)).toEqual([])
    },
  )
})
