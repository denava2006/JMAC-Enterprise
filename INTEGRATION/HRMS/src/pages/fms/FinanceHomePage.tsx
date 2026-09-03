import { Link } from 'react-router-dom'
import { Landmark, PiggyBank, Store, Tags, TrendingUp, Wallet } from 'lucide-react'
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

/**
 * The Finance overview.
 *
 * Master data is what exists so far, so this counts master data and says what
 * it is for. It deliberately shows no spending figure: nothing in JMAC can yet
 * produce one, and a dashboard reporting ₱0.00 spent would be read as a fact
 * about the business rather than as a phase that has not been built.
 *
 * Today's sales are the exception, and they earn it: POS genuinely records
 * them, so the figure means what it says. Two numbers only -- the Sales &
 * Collections page is where the breakdown lives, and duplicating it here would
 * give the enterprise two places to disagree about a day's takings.
 */
export default function FinanceHomePage() {
  const { profile } = useAuth()
  const { data: budgets = [], isLoading: budgetsLoading } = useBudgets()
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

  const activeBudgets = budgets.filter((b) => b.status === 'active')
  const ceiling = activeBudgets.reduce((sum, b) => sum + Number(b.amount), 0)
  const allocated = activeBudgets.reduce((sum, b) => sum + Number(b.allocated), 0)

  const modules = [
    {
      to: '/fms/budgets',
      icon: PiggyBank,
      title: 'Budgets',
      body: 'Approved ceilings, and the allocations drawn against them.',
    },
    {
      to: '/fms/vendors',
      icon: Store,
      title: 'Vendors',
      body: 'Suppliers the company pays, and what each one supplies.',
    },
    {
      to: '/fms/categories',
      icon: Tags,
      title: 'Categories',
      body: 'How money is classified — separate from POS product categories.',
    },
    {
      to: '/fms/accounts',
      icon: Landmark,
      title: 'Chart of Accounts',
      body: 'The cash, bank and e-wallet accounts money moves through.',
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Finance`}
        description={`Welcome, ${firstName(profile?.full_name)}. Master data for JMAC Enterprise.`}
        action={profile?.role ? <Badge variant="secondary">{ROLE_LABEL[profile.role]}</Badge> : undefined}
      />

      <WaitingOnYou />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active budgets"
          value={activeBudgets.length}
          icon={PiggyBank}
          isLoading={budgetsLoading}
        />
        <StatCard
          label="Approved ceiling"
          value={formatMoney(ceiling)}
          icon={PiggyBank}
          isLoading={budgetsLoading}
        />
        <StatCard
          label="Allocated"
          value={formatMoney(allocated)}
          icon={PiggyBank}
          isLoading={budgetsLoading}
        />
        <StatCard
          label="Active vendors"
          value={vendors.filter((v) => v.is_active).length}
          icon={Store}
          isLoading={vendorsLoading}
        />
      </div>

      {/* Today's trading, from the same server query the Sales page uses --
          two figures, not a second copy of that page. "Today" is the
          Philippine business day the database resolves, not the browser's. */}
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

      <div className="grid gap-3 sm:grid-cols-2">
        {modules.map((module) => (
          <Link key={module.to} to={module.to} className="group">
            <Card className="h-full transition-colors group-hover:border-accent/40">
              <CardContent className="flex items-start gap-3 p-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <module.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{module.title}</p>
                  <p className="text-sm text-muted-foreground">{module.body}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardContent className="flex flex-col gap-2 py-4">
          <p className="text-sm font-medium text-foreground">
            {categories.filter((c) => c.is_active).length} categories ·{' '}
            {accounts.filter((a) => a.is_active).length} open accounts
            {categoriesLoading || accountsLoading ? '' : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            Requests, reimbursements, payments and the ledger are later phases. Until they exist,
            a budget reports what was approved and what has been allocated — reserved and spent stay
            at zero because nothing can yet produce either number. Your own attendance, leave and
            payslips are in My Workspace.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
