import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The Finance overview, and the two things F7 acceptance found wrong with it.
 *
 * It still carried its F2 note: "Requests, reimbursements, payments and the
 * ledger are later phases... reserved and spent stay at zero because nothing
 * can yet produce either number." True when written, and wrong for five phases
 * by the time an Accountant read it — with ₱6,000 actually reserved and ₱1,300
 * actually spent against the ceilings. And the figures themselves were not on
 * the page at all, so the only thing saying anything about them was that note.
 *
 * The numbers below are the accepted production baseline, so a regression here
 * is a regression against a state somebody has signed off.
 */

const BUDGETS = [
  {
    id: 'b1',
    name: 'F3 Smoke Test Budget',
    status: 'active',
    amount: 50000,
    allocated: 0,
    reserved: 6000,
    spent: 1300,
    remaining: 42700,
  },
  // Draft budgets are not live money and must not be summed into the figures.
  {
    id: 'b2',
    name: 'Next year, unapproved',
    status: 'draft',
    amount: 999999,
    allocated: 0,
    reserved: 111111,
    spent: 222222,
    remaining: 666666,
  },
]

const state: {
  budgets: typeof BUDGETS
  budgetsLoading: boolean
  budgetsError: boolean
  role: string
} = {
  budgets: BUDGETS,
  budgetsLoading: false,
  budgetsError: false,
  // The Finance Manager, because these tests are about the budget figures and
  // the Manager is a role whose workspace contains Budgets. It used to be the
  // Accountant, which stopped being a role that sees these cards when the
  // workspaces were separated -- an Accountant cannot open Budgets, so the
  // overview no longer offers them a ceiling they cannot go and look into.
  role: 'finance_manager',
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'u1', role: state.role, full_name: 'Ben Reyes' } }),
}))

vi.mock('@/hooks/useFinanceMasterData', () => ({
  useBudgets: () => ({
    data: state.budgets,
    isLoading: state.budgetsLoading,
    isError: state.budgetsError,
  }),
  useVendors: () => ({ data: [{ id: 'v1', is_active: true }], isLoading: false }),
  useFinanceCategories: () => ({ data: [{ id: 'c1', is_active: true }], isLoading: false }),
  useFinanceAccounts: () => ({ data: [{ id: 'a1', is_active: true }], isLoading: false }),
}))

vi.mock('@/hooks/useFinanceSales', () => ({
  useFinanceSalesPresets: () => ({ data: [{ preset: 'today', date_from: 'x', date_to: 'y' }] }),
  useFinanceSalesSummary: () => ({
    data: { net_sales: 0, total_collected: 0 },
    isLoading: false,
  }),
}))

// The queue is its own component with its own tests; this page only mounts it.
vi.mock('@/components/fms/WaitingOnYou', () => ({ WaitingOnYou: () => null }))

const FinanceHomePage = (await import('@/pages/fms/FinanceHomePage')).default

function show() {
  return render(
    <MemoryRouter>
      <FinanceHomePage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  state.budgets = BUDGETS
  state.budgetsLoading = false
  state.budgetsError = false
  state.role = 'finance_manager'
})

afterEach(cleanup)

describe('the money the overview reports', () => {
  it('shows what is actually reserved, not zero', () => {
    show()
    expect(screen.getByText('Reserved')).toBeTruthy()
    expect(screen.getByText('₱6,000.00')).toBeTruthy()
  })

  it('shows what has actually been spent, not zero', () => {
    show()
    expect(screen.getByText('Spent')).toBeTruthy()
    expect(screen.getByText('₱1,300.00')).toBeTruthy()
  })

  it('shows the remaining and the ceiling from the same source', () => {
    show()
    expect(screen.getByText('Remaining')).toBeTruthy()
    expect(screen.getByText('₱42,700.00')).toBeTruthy()
    expect(screen.getByText('Approved ceiling')).toBeTruthy()
    expect(screen.getByText('₱50,000.00')).toBeTruthy()
  })

  it('takes each figure from budget_status rather than recomputing it', () => {
    // remaining is amount − reserved − spent server-side. Handed a row whose
    // remaining disagrees with that arithmetic, the page must still report the
    // view's number: recomputing here is how two screens come to disagree.
    state.budgets = [{ ...BUDGETS[0], remaining: 12345 }]
    show()
    expect(screen.getByText('₱12,345.00')).toBeTruthy()
    expect(screen.queryByText('₱42,700.00')).toBeNull()
  })

  it('counts only live budgets, so a draft ceiling is not reported as money', () => {
    show()
    expect(screen.queryByText('₱999,999.00')).toBeNull()
    expect(screen.queryByText('₱222,222.00')).toBeNull()
  })

  it('formats money with the peso sign, separators and two decimals', () => {
    show()
    for (const shown of ['₱6,000.00', '₱1,300.00', '₱42,700.00', '₱50,000.00']) {
      expect(screen.getByText(shown), shown).toBeTruthy()
    }
  })
})

/** The value rendered beside one of the budget figure labels. Scoped, because
 *  today's sales are their own query on the same page and legitimately read
 *  ₱0.00 in these fixtures. */
function figureFor(label: string): string {
  return (screen.getByText(label).parentElement?.textContent ?? '').replace(label, '').trim()
}

const BUDGET_FIGURES = ['Approved ceiling', 'Reserved', 'Spent', 'Remaining']

describe('an unknown figure does not become a zero', () => {
  it('shows nothing rather than ₱0.00 while the budgets are loading', () => {
    state.budgetsLoading = true
    state.budgets = []
    show()
    // Skeletons, not figures. ₱0.00 while loading is indistinguishable from a
    // business that has reserved and spent nothing.
    for (const label of BUDGET_FIGURES) {
      expect(figureFor(label), label).toBe('')
    }
  })

  it('says Unavailable rather than ₱0.00 when the query failed', () => {
    state.budgetsError = true
    state.budgets = []
    show()
    for (const label of BUDGET_FIGURES) {
      expect(figureFor(label), label).toBe('Unavailable')
    }
    expect(screen.getAllByText('Unavailable').length).toBe(4)
  })

  it('still reports a real zero as a zero', () => {
    // The point is not that zero is forbidden — a budget with nothing drawn
    // against it genuinely reserves nothing. The point is that a zero must
    // mean it.
    state.budgets = [{ ...BUDGETS[0], reserved: 0, spent: 0, remaining: 50000 }]
    show()
    expect(figureFor('Reserved')).toBe('₱0.00')
    expect(figureFor('Remaining')).toBe('₱50,000.00')
  })

  it('does not report four zero counts while reference data is still loading', () => {
    state.budgetsLoading = true
    state.budgets = []
    show()
    expect(screen.getByText(/Loading reference data/)).toBeTruthy()
    expect(screen.queryByText(/0 active budgets/)).toBeNull()
  })
})

/**
 * The overview summarises the workspace it belongs to.
 *
 * A figure from a page the viewer will be turned away from is a dead end: they
 * can read the number and can never go and look into it. So the summaries and
 * the shortcut tiles are filtered through the same policy as the sidebar and
 * the route guard.
 */
describe('the overview follows the role', () => {
  const tiles = () => screen.getAllByRole('link').map((a) => a.getAttribute('href'))

  it('shows the Accountant sales and settlement, not budgets', () => {
    state.role = 'accountant'
    show()
    expect(screen.queryByText('Approved ceiling')).toBeNull()
    expect(screen.queryByText('Reserved')).toBeNull()
    expect(screen.getByText("Today's net sales")).toBeTruthy()
  })

  it('shows Finance Staff budgets, not the sales they have no work in', () => {
    state.role = 'finance_staff'
    show()
    expect(screen.getByText('Approved ceiling')).toBeTruthy()
    expect(screen.queryByText("Today's net sales")).toBeNull()
  })

  it('shows the Finance Manager both', () => {
    show()
    expect(screen.getByText('Approved ceiling')).toBeTruthy()
    expect(screen.getByText("Today's net sales")).toBeTruthy()
  })

  it('never offers a shortcut to a module the viewer cannot open', () => {
    state.role = 'accountant'
    show()
    expect(tiles()).not.toContain('/fms/budgets')
    expect(tiles()).not.toContain('/fms/vendors')
    expect(tiles()).not.toContain('/fms/categories')
    expect(tiles()).toContain('/fms/accounts')
  })

  it('gives Finance Staff shortcuts into their own work', () => {
    state.role = 'finance_staff'
    show()
    expect(tiles()).toContain('/fms/budgets')
    expect(tiles()).not.toContain('/fms/accounts')
  })

  it('counts only the reference data the role can reach', () => {
    state.role = 'accountant'
    show()
    expect(screen.queryByText(/active vendors/)).toBeNull()
    expect(screen.getByText(/open accounts/)).toBeTruthy()
  })
})

describe('what the overview says the system can do', () => {
  it('no longer calls live functionality a later phase', () => {
    const { container } = show()
    const text = container.textContent ?? ''
    // The exact sentence acceptance read, and the claim inside it.
    expect(text).not.toContain('are later phases')
    expect(text).not.toContain('reserved and spent stay at zero')
    expect(text).not.toContain('nothing can yet produce either number')
    expect(text).not.toContain('Master data for JMAC Enterprise')
  })

  it('describes reimbursements and payments as operational', () => {
    const { container } = show()
    const text = container.textContent ?? ''
    expect(text).toMatch(/reimbursements and payroll\s*\n?\s*payments are all in service/)
  })

  it('still does not claim the ledger is built', () => {
    // F8 is not done. Saying so is accurate; saying nothing would invite the
    // reader to assume it exists.
    const { container } = show()
    const text = container.textContent ?? ''
    expect(text).toMatch(/general\s*\n?\s*ledger are the next stage/)
  })
})

describe('what the overview does not do', () => {
  it('renders no salary figures or employee-private detail', () => {
    const { container } = show()
    const text = (container.textContent ?? '').toLowerCase()
    // "payslips are in My Workspace" is a signpost and stays — it tells an
    // employee where their own are, which is the opposite of exposing anybody
    // else's. What must not appear is somebody's pay.
    for (const leak of ['salary', 'net pay', 'gross pay', 'take-home', 'basic pay']) {
      expect(text, leak).not.toContain(leak)
    }
    expect(text).toContain('payslips are in my workspace')
  })

  it('reads only — nothing on this page can write', () => {
    // Every hook this page uses is a query. If a mutation is ever added here,
    // this mock set stops resolving and the suite says so rather than the
    // overview quietly gaining the ability to change money.
    const { container } = show()
    expect(container.querySelectorAll('button').length).toBe(0)
  })
})
