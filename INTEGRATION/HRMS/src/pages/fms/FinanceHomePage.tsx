import { Link } from 'react-router-dom'
import { Lock, PiggyBank, Receipt, TrendingUp, Wallet } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { WaitingOnYou } from '@/components/fms/WaitingOnYou'
import { useAuth } from '@/contexts/AuthContext'
import { ROLE_LABEL } from '@/lib/roles'
import { firstName } from '@/lib/displayName'
import { formatMoney } from '@/lib/currency'
import {
  useBudgets,
  useFinanceAccounts,
  useFinanceCategories,
  useVendors,
} from '@/hooks/useFinanceMasterData'
import { useFinanceSalesPresets, useFinanceSalesSummary } from '@/hooks/useFinanceSales'
import { canAccessFinanceModule, financeOverviewTiles } from '@/lib/financeModules'

/**
 * The Finance overview.
 *
 * It used to be a master-data dashboard, and said so: "Requests, reimbursements,
 * payments and the ledger are later phases... reserved and spent stay at zero
 * because nothing can yet produce either number." That was true when it was
 * written and had been wrong for five phases by the time F7 acceptance read it
 * — requests, procurement, supplier invoices, reimbursements and payroll all
 * ship. A finance overview telling an Accountant that spending is structurally
 * zero, while ₱1,300 has actually been spent, is worse than one showing nothing.
 *
 * Every figure here is summed from budget_status, the same view the Budgets
 * page reads, which derives reserved and spent from the requests and payments
 * themselves. Nothing on this page computes money: adding a second opinion
 * about what has been spent is how two screens come to disagree.
 *
 * Today's sales come from the server query the Sales page uses, for the same
 * reason. Two numbers only -- the breakdown lives there.
 */
export default function FinanceHomePage() {
  const { profile } = useAuth()
  const { data: budgets = [], isLoading: budgetsLoading, isError: budgetsFailed } = useBudgets()
  const { data: vendors = [], isLoading: vendorsLoading } = useVendors()
  const { data: categories = [], isLoading: categoriesLoading } = useFinanceCategories()
  const { data: accounts = [], isLoading: accountsLoading } = useFinanceAccounts()

  // Today's trading. The preset carries the Philippine business date the
  // database computed, so the browser's clock never decides which day this is.
  const { data: presets } = useFinanceSalesPresets()
  const todayPreset = (presets ?? []).find((p) => p.preset === 'today')
  const { data: today, isLoading: todayLoading } = useFinanceSalesSummary({
    dateFrom: todayPreset?.date_from ?? '',
    dateTo: todayPreset?.date_to ?? '',
    branchId: null,
    paymentMethod: null,
    cashierId: null,
  })

  // Summed from budget_status, never recomputed. The view already derives each
  // budget's reserved from its approved requests and its spent from what has
  // actually been paid; remaining is amount − reserved − spent, server-side.
  // Adding those four up across the live budgets is the only arithmetic here.
  const activeBudgets = budgets.filter((b) => b.status === 'active')
  const total = (field: 'amount' | 'reserved' | 'spent' | 'remaining') =>
    activeBudgets.reduce((sum, b) => sum + Number(b[field] ?? 0), 0)
  const ceiling = total('amount')
  const reserved = total('reserved')
  const spent = total('spent')
  const remaining = total('remaining')

  const referenceLoading = budgetsLoading || vendorsLoading || categoriesLoading || accountsLoading

  // Summaries follow the workspace. Showing an Accountant a budget's Remaining
  // when Budgets is not theirs to open, or a Finance Staff today's takings when
  // Sales is not, is the same dead end as a tile that bounces you -- a figure
  // you cannot go and look into. Same policy as the sidebar and the guard.
  const can = (route: string) => canAccessFinanceModule(profile?.role, route)
  const showBudgetFigures = can('/fms/budgets')
  const showSalesFigures = can('/fms/sales')

  const referenceCounts = [
    showBudgetFigures ? `${activeBudgets.length} active budgets` : null,
    can('/fms/vendors') ? `${vendors.filter((v) => v.is_active).length} active vendors` : null,
    can('/fms/categories') ? `${categories.filter((c) => c.is_active).length} categories` : null,
    can('/fms/accounts') ? `${accounts.filter((a) => a.is_active).length} open accounts` : null,
  ].filter(Boolean)

  // The shortcuts, from the same table the sidebar and the route guard read.
  // They used to be four hard-coded links shown to everyone, which after the
  // workspaces were separated would have offered an Accountant three modules
  // their own URL now refuses -- a tile that bounces you is worse than no tile.
  const modules = financeOverviewTiles(profile?.role)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Finance`}
        description={`Welcome, ${firstName(profile?.full_name)}. Budgets, requests, procurement, reimbursements and payroll.`}
        action={profile?.role ? <Badge variant="secondary">{ROLE_LABEL[profile.role]}</Badge> : undefined}
      />

      <WaitingOnYou />

      {/* The four figures a budget actually has. Reserved is money approved and
          committed but not yet gone; spent is money that has left. They were
          absent here, and the note underneath asserted both were structurally
          zero — which is how an overview came to contradict its own Budgets
          page. Every one of them fails to "Unavailable" rather than to ₱0.00,
          because a figure nobody could load is not a figure of nought. */}
      {showBudgetFigures && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Approved ceiling"
            value={formatMoney(ceiling)}
            icon={PiggyBank}
            isLoading={budgetsLoading}
            isError={budgetsFailed}
          />
          <StatCard
            label="Reserved"
            value={formatMoney(reserved)}
            icon={Lock}
            isLoading={budgetsLoading}
            isError={budgetsFailed}
          />
          <StatCard
            label="Spent"
            value={formatMoney(spent)}
            icon={Receipt}
            isLoading={budgetsLoading}
            isError={budgetsFailed}
          />
          <StatCard
            label="Remaining"
            value={formatMoney(remaining)}
            icon={Wallet}
            isLoading={budgetsLoading}
            isError={budgetsFailed}
          />
        </div>
      )}

      {/* Today's trading, from the same server query the Sales page uses --
          two figures, not a second copy of that page. "Today" is the
          Philippine business day the database resolves, not the browser's. */}
      {showSalesFigures && (
        <div className="grid gap-3 sm:grid-cols-2">
          <StatCard
            label="Today's net sales"
            value={formatMoney(Number(today?.net_sales ?? 0))}
            icon={TrendingUp}
            isLoading={todayLoading}
          />
          <StatCard
            label="Today's collections"
            value={formatMoney(Number(today?.total_collected ?? 0))}
            icon={Wallet}
            isLoading={todayLoading}
          />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {modules.map((module) => (
          <Link key={module.route} to={module.route} className="group">
            <Card className="h-full transition-colors group-hover:border-accent/40">
              <CardContent className="flex items-start gap-3 p-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <module.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{module.label}</p>
                  <p className="text-sm text-muted-foreground">{module.blurb}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardContent className="flex flex-col gap-2 py-4">
          {/* Counting rows that have not arrived yet gives four zeroes, which
              reads as a finance function with nothing set up rather than as a
              page that is still loading. */}
          <p className="text-sm font-medium text-foreground">
            {referenceLoading ? 'Loading reference data…' : referenceCounts.join(' · ')}
          </p>
          <p className="text-xs text-muted-foreground">
            Purchase requests, procurement, supplier invoices, employee reimbursements and payroll
            payments are all in service — reserved and spent above are what those have actually
            committed and paid against the approved ceilings. Accounting entries and the general
            ledger are the next stage of this work. Your own attendance, leave and payslips are in
            My Workspace.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
