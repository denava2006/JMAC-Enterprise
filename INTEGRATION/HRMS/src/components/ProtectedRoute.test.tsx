import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import type { UserRole } from '@/lib/enums'
import { NO_POS_ACCESS, type PosAccess } from '@/lib/portals'
import type { PosRole } from '@/lib/enums'

/** A POS account. The (branch, role) pairs are the unit -- a bare list of
 * branches could not tell a cashier from a manager. */
function pos(branchIds: string[] = [], role: PosRole = 'cashier'): PosAccess {
  return {
    hasAccess: true,
    branchIds,
    assignments: branchIds.map((branchId) => ({ branchId, role })),
  }
}

// The guard reads everything it needs from AuthContext, so the whole test is
// "given this signed-in account, where does the router put them".
const authState: {
  session: unknown
  profile: { role: UserRole; activated_at: string | null; employee_id: string | null } | null
  posAccess: PosAccess
  initializing: boolean
} = {
  session: null,
  profile: null,
  posAccess: NO_POS_ACCESS,
  initializing: false,
}

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState,
}))

const { ProtectedRoute } = await import('@/components/ProtectedRoute')
const { PortalRedirect } = await import('@/components/PortalRedirect')
// Imported after the AuthContext mock, like the two above: it reads posAccess.
const { PosIndexRedirect } = await import('@/components/pos/PosIndexRedirect')

/** `employeeId` is what makes an account an employee. Self-service follows the
 *  employment record rather than the role, so a test that wants self-service
 *  has to say the account actually has one. */
function signIn(
  role: UserRole,
  posAccess: PosAccess = NO_POS_ACCESS,
  employeeId: string | null = null
) {
  authState.session = { user: { id: 'u1' } }
  authState.profile = { role, activated_at: '2026-01-01T00:00:00Z', employee_id: employeeId }
  authState.posAccess = posAccess
  authState.initializing = false
}

function signOut() {
  authState.session = null
  authState.profile = null
  authState.posAccess = NO_POS_ACCESS
}

/** The real route table's shape, reduced to the parts Slice 1 decides. */
function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route
          path="/home"
          element={
            <ProtectedRoute>
              <PortalRedirect />
            </ProtectedRoute>
          }
        />
        <Route
          path="/pos"
          element={
            <ProtectedRoute requirePos blockRoles={['admin']}>
              <>
                <p>pos portal</p>
                <Outlet />
              </>
            </ProtectedRoute>
          }
        >
          {/* The real index redirect, not a stand-in: where POS staff land is
              decided here and nowhere else, so the harness has to exercise it. */}
          <Route index element={<PosIndexRedirect />} />
        </Route>
        <Route
          path="/pos/dashboard"
          element={
            <ProtectedRoute requirePos blockRoles={['admin']}>
              <p>manager dashboard</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/pos/categories"
          element={
            <ProtectedRoute requirePos blockRoles={['admin']}>
              <p>manager categories</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <p>back office</p>
            </ProtectedRoute>
          }
        />
        {/* Self-service has its own landing route now: an HR Manager holds both
            this and the back office, so they cannot share /dashboard. */}
        <Route
          path="/dashboard/my-dashboard"
          element={
            <ProtectedRoute requireEmployee>
              <p>my workspace</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/employees"
          element={
            <ProtectedRoute allowedRoles={['admin', 'hr_manager', 'hr_staff']}>
              <p>employees page</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/admin/pos-access"
          element={
            <ProtectedRoute allowedRoles={['admin']}>
              <p>pos access page</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/admin/pos-settings"
          element={
            <ProtectedRoute allowedRoles={['admin']}>
              <p>pos settings page</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/admin/pos-products"
          element={
            <ProtectedRoute allowedRoles={['admin']}>
              <p>pos products page</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/admin/pos-categories"
          element={
            <ProtectedRoute allowedRoles={['admin']}>
              <p>pos categories page</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/pos/stock"
          element={
            <ProtectedRoute requirePos blockRoles={['admin']}>
              <p>branch stock</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/pos/transactions"
          element={
            <ProtectedRoute requirePos blockRoles={['admin']}>
              <p>pos transactions</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/pos/till"
          element={
            <ProtectedRoute requirePos blockRoles={['admin']}>
              <p>the till</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/admin/pos"
          element={
            <ProtectedRoute allowedRoles={['admin']}>
              <p>admin till</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/admin/pos-transactions"
          element={
            <ProtectedRoute allowedRoles={['admin']}>
              <p>admin transactions</p>
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/admin/pos-inventory"
          element={
            <ProtectedRoute allowedRoles={['admin']}>
              <p>pos inventory page</p>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  signOut()
})

describe('signed out', () => {
  it('sends anyone to the login page', () => {
    renderApp('/dashboard')
    expect(screen.getByText('login page')).toBeTruthy()
  })
})

describe('/home decides the portal', () => {
  it('lands an administrator in the back office', () => {
    signIn('admin', pos())
    renderApp('/home')
    expect(screen.getByText('back office')).toBeTruthy()
  })

  it('lands HR staff in the back office', () => {
    signIn('hr_staff')
    renderApp('/home')
    expect(screen.getByText('back office')).toBeTruthy()
  })

  it('lands a cashier directly on the selling screen', () => {
    // Not on a portal index: the Overview placeholder is gone, and a cashier
    // signing in wants the till.
    signIn('employee', pos(['branch-1']))
    renderApp('/home')
    expect(screen.getByText('the till')).toBeTruthy()
  })

  it('lands an employee without POS access in self-service', () => {
    signIn('employee', NO_POS_ACCESS, 'emp-1')
    renderApp('/home')
    expect(screen.getByText('my workspace')).toBeTruthy()
  })
})

describe('POS access', () => {
  it('turns an Administrator away -- they belong in the parent system', () => {
    // has_pos_access() is still true for them; this is a deliberate product
    // decision, not a permission. The POS workspace hides every HR module, and
    // the person who administers HRMS should not lose it to reach a till. Their
    // POS modules, including the till, are in the back office.
    signIn('admin', pos())
    renderApp('/pos')
    expect(screen.queryByText('pos portal')).toBeNull()
    expect(screen.getByText('back office')).toBeTruthy()
  })

  it('lets an assigned cashier in, and forwards them to the till', () => {
    signIn('employee', pos(['branch-1']))
    renderApp('/pos')
    expect(screen.getByText('the till')).toBeTruthy()
  })

  it('forwards a POS manager to their dashboard instead', () => {
    // The same URL, a different screen. A cashier opens the app to sell; a
    // manager opens it to see how the branch is trading.
    signIn('employee', pos(['branch-1'], 'manager'))
    renderApp('/pos')
    expect(screen.getByText('manager dashboard')).toBeTruthy()
    expect(screen.queryByText('the till')).toBeNull()
  })

  it('forwards someone who manages one branch and cashiers at another to the dashboard', () => {
    // Manager anywhere is enough to have a dashboard worth landing on. Which
    // branch it shows is decided later, per branch, by managerBranchIds and by
    // the database.
    signIn('employee', {
      hasAccess: true,
      branchIds: ['branch-1', 'branch-2'],
      assignments: [
        { branchId: 'branch-1', role: 'manager' },
        { branchId: 'branch-2', role: 'cashier' },
      ],
    })
    renderApp('/pos')
    expect(screen.getByText('manager dashboard')).toBeTruthy()
  })

  it('refuses an employee with no assignment', () => {
    signIn('employee')
    renderApp('/pos')
    expect(screen.queryByText('pos portal')).toBeNull()
    expect(screen.getByText('back office')).toBeTruthy()
  })

  it('refuses HR staff with no assignment -- role never grants the till', () => {
    signIn('hr_staff')
    renderApp('/pos')
    expect(screen.queryByText('pos portal')).toBeNull()
    expect(screen.getByText('back office')).toBeTruthy()
  })
})

describe('back office access', () => {
  it('keeps a cashier out of employee management', () => {
    signIn('employee', pos(['branch-1']))
    renderApp('/dashboard/employees')
    expect(screen.queryByText('employees page')).toBeNull()
    // Refused into /home, which resolves to the till -- not to /dashboard,
    // which would only refuse them again.
    expect(screen.getByText('the till')).toBeTruthy()
  })

  it('lets HR staff into employee management', () => {
    signIn('hr_staff')
    renderApp('/dashboard/employees')
    expect(screen.getByText('employees page')).toBeTruthy()
  })
})

describe('POS Access administration is Administrator-only', () => {
  it('lets an administrator in', () => {
    signIn('admin', pos())
    renderApp('/dashboard/admin/pos-access')
    expect(screen.getByText('pos access page')).toBeTruthy()
  })

  it('keeps HR staff out', () => {
    signIn('hr_staff')
    renderApp('/dashboard/admin/pos-access')
    expect(screen.queryByText('pos access page')).toBeNull()
    expect(screen.getByText('back office')).toBeTruthy()
  })

  it('keeps an HR manager out', () => {
    signIn('hr_manager')
    renderApp('/dashboard/admin/pos-access')
    expect(screen.queryByText('pos access page')).toBeNull()
    expect(screen.getByText('back office')).toBeTruthy()
  })

  it('keeps an employee out', () => {
    signIn('employee')
    renderApp('/dashboard/admin/pos-access')
    expect(screen.queryByText('pos access page')).toBeNull()
  })

  it('keeps a POS manager out -- running a till is not granting access to one', () => {
    // The strongest POS role there is still cannot reach this screen, and RLS
    // refuses them independently even if they hand-typed the URL.
    signIn('employee', pos(['branch-1']))
    renderApp('/dashboard/admin/pos-access')
    expect(screen.queryByText('pos access page')).toBeNull()
    expect(screen.getByText('the till')).toBeTruthy()
  })
})

describe('POS Settings is Administrator-only', () => {
  it('lets an administrator in', () => {
    signIn('admin', pos())
    renderApp('/dashboard/admin/pos-settings')
    expect(screen.getByText('pos settings page')).toBeTruthy()
  })

  it('keeps HR staff and HR managers out', () => {
    signIn('hr_staff')
    const first = renderApp('/dashboard/admin/pos-settings')
    expect(screen.queryByText('pos settings page')).toBeNull()
    first.unmount()

    signIn('hr_manager')
    renderApp('/dashboard/admin/pos-settings')
    expect(screen.queryByText('pos settings page')).toBeNull()
  })

  it('keeps a POS manager out -- trading at a branch is not setting its fees', () => {
    signIn('employee', pos(['branch-1']))
    renderApp('/dashboard/admin/pos-settings')
    expect(screen.queryByText('pos settings page')).toBeNull()
    expect(screen.getByText('the till')).toBeTruthy()
  })
})

describe('product administration is Administrator-only', () => {
  for (const path of ['/dashboard/admin/pos-products', '/dashboard/admin/pos-categories']) {
    it(`lets an administrator into ${path}`, () => {
      signIn('admin', pos())
      renderApp(path)
      expect(screen.getByText(/pos (products|categories) page/)).toBeTruthy()
    })

    it(`keeps a POS manager out of ${path}`, () => {
      // The strongest POS role still does not administer the product master --
      // creating products is an enterprise decision, and RLS on pos_products
      // refuses them independently of this guard.
      signIn('employee', pos(['branch-1']))
      renderApp(path)
      expect(screen.queryByText(/pos (products|categories) page/)).toBeNull()
      expect(screen.getByText('the till')).toBeTruthy()
    })

    it(`keeps HR staff out of ${path}`, () => {
      signIn('hr_staff')
      renderApp(path)
      expect(screen.queryByText(/pos (products|categories) page/)).toBeNull()
    })
  }
})

describe('inventory administration is Administrator-only', () => {
  it('lets an administrator in', () => {
    signIn('admin', pos())
    renderApp('/dashboard/admin/pos-inventory')
    expect(screen.getByText('pos inventory page')).toBeTruthy()
  })

  it('keeps a POS manager out -- receiving stock is not theirs in this phase', () => {
    signIn('employee', pos(['branch-1']))
    renderApp('/dashboard/admin/pos-inventory')
    expect(screen.queryByText('pos inventory page')).toBeNull()
    expect(screen.getByText('the till')).toBeTruthy()
  })

  it('keeps HR staff and HR managers out', () => {
    signIn('hr_staff')
    const first = renderApp('/dashboard/admin/pos-inventory')
    expect(screen.queryByText('pos inventory page')).toBeNull()
    first.unmount()

    signIn('hr_manager')
    renderApp('/dashboard/admin/pos-inventory')
    expect(screen.queryByText('pos inventory page')).toBeNull()
  })
})

describe('the POS stock page is POS-gated', () => {
  it('admits assigned POS staff', () => {
    signIn('employee', pos(['branch-1']))
    renderApp('/pos/stock')
    expect(screen.getByText('branch stock')).toBeTruthy()
  })

  it('refuses an employee with no POS access', () => {
    signIn('employee')
    renderApp('/pos/stock')
    expect(screen.queryByText('branch stock')).toBeNull()
  })

  it('refuses HR staff -- an HR role never grants the till', () => {
    signIn('hr_staff')
    renderApp('/pos/stock')
    expect(screen.queryByText('branch stock')).toBeNull()
  })
})

describe('the till is POS-gated', () => {
  it('admits an assigned cashier', () => {
    signIn('employee', pos(['branch-1']))
    renderApp('/pos/till')
    expect(screen.getByText('the till')).toBeTruthy()
  })

  it('turns an Administrator away, who uses the till from the back office', () => {
    signIn('admin', pos())
    renderApp('/pos/till')
    expect(screen.queryByText('the till')).toBeNull()
    expect(screen.getByText('back office')).toBeTruthy()
  })

  it('refuses HR staff with no assignment', () => {
    signIn('hr_staff')
    renderApp('/pos/till')
    expect(screen.queryByText('the till')).toBeNull()
    expect(screen.getByText('back office')).toBeTruthy()
  })

  it('refuses an employee with no POS access', () => {
    signIn('employee')
    renderApp('/pos/till')
    expect(screen.queryByText('the till')).toBeNull()
  })
})

describe('the previous user must not decide the next user’s portal', () => {
  it('does not strand HR staff in the POS after a cashier was there', () => {
    // 1. A cashier is working the till. (This used to be an Administrator;
    //    they no longer enter the POS workspace at all, but the hazard the test
    //    guards against -- the previous user's route deciding the next user's
    //    portal -- is unchanged.)
    signIn('employee', pos(['branch-1']))
    const first = renderApp('/pos/till')
    expect(screen.getByText('the till')).toBeTruthy()
    first.unmount()

    // 2. They sign out. The guard sends them to /login WITHOUT stashing /pos.
    signOut()
    const second = renderApp('/pos/till')
    expect(screen.getByText('login page')).toBeTruthy()
    second.unmount()

    // 3. HR staff signs in. LoginPage always routes to /home, never to a
    //    remembered path, so they land in the back office and not at a till
    //    they have no access to.
    signIn('hr_staff')
    renderApp('/home')
    expect(screen.getByText('back office')).toBeTruthy()
    expect(screen.queryByText('the till')).toBeNull()
  })
})
