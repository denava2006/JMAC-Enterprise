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
}

const EVERYTHING = {
  vendorsPending: 2,
  categoriesPending: 1,
  budgetsDraft: 3,
  ordersToApprove: 4,
  requestsToValidate: 5,
  demandToAccept: 6,
  ordersReturned: 7,
}

describe('what is waiting on the checker', () => {
  it('lists only decisions a Finance Manager can actually make', () => {
    expect(waitingWork('finance_manager', EVERYTHING)).toEqual([
      { label: 'Purchase orders to approve', count: 4, to: '/fms/procurement' },
      { label: 'Budgets to approve', count: 3, to: '/fms/budgets' },
      { label: 'Vendors to approve', count: 2, to: '/fms/vendors' },
      { label: 'Categories to approve', count: 1, to: '/fms/categories' },
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
    ])
  })

  it('does not offer the maker an approval', () => {
    const labels = waitingWork('finance_staff', EVERYTHING).map((i) => i.label)
    expect(labels.some((l) => l.includes('to approve'))).toBe(false)
  })
})

describe('an empty desk', () => {
  it.each(['finance_manager', 'finance_staff'])('says nothing to %s when nothing waits', (role) => {
    expect(waitingWork(role, NOTHING)).toEqual([])
  })

  it('drops the rows that are at zero rather than listing them', () => {
    expect(waitingWork('finance_manager', { ...NOTHING, vendorsPending: 1 })).toEqual([
      { label: 'Vendors to approve', count: 1, to: '/fms/vendors' },
    ])
  })

  it.each(['accountant', 'admin', 'employee', null, undefined])(
    'has nothing for %s, who approves nothing in this phase',
    (role) => {
      expect(waitingWork(role, EVERYTHING)).toEqual([])
    },
  )
})
