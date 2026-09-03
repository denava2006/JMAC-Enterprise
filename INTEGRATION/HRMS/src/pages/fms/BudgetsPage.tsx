import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, PiggyBank, Plus } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { reportInvalid } from '@/lib/formFeedback'
import { useAuth } from '@/contexts/AuthContext'
import { canEditAllocation, financeCan } from '@/lib/financeAuthority'
import { formatMoney } from '@/lib/currency'
import { useDepartments } from '@/hooks/useDepartments'
import {
  type BudgetStatus,
  useBudgetAllocations,
  useBudgets,
  useFinanceCategories,
  useReleaseAllocation,
  useSaveAllocation,
  useSaveBudget,
  useSetBudgetStatus,
  useReviewBudget,
} from '@/hooks/useFinanceMasterData'

const NONE = '__none__'

const budgetSchema = z.object({
  name: z.string().min(1, 'A budget name is required').max(120),
  department_id: z.string().optional(),
  finance_category_id: z.string().optional(),
  period: z.enum(['monthly', 'quarterly', 'yearly']),
  fiscal_year: z.number({ error: 'Enter a fiscal year' }).int().min(2000).max(2100),
  amount: z.number({ error: 'Enter an amount' }).min(0, 'A ceiling cannot be negative'),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  status: z.enum(['draft', 'active', 'closed']),
})
type BudgetFormValues = z.infer<typeof budgetSchema>

function BudgetDialog({
  open,
  onOpenChange,
  budget,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  budget?: BudgetStatus | null
}) {
  const isEdit = !!budget
  const save = useSaveBudget()
  const { data: departments = [] } = useDepartments()
  const { data: categories = [] } = useFinanceCategories()

  const form = useForm<BudgetFormValues>({
    resolver: zodResolver(budgetSchema),
    defaultValues: {
      name: '',
      department_id: NONE,
      finance_category_id: NONE,
      period: 'monthly',
      fiscal_year: new Date().getFullYear(),
      amount: 0,
      start_date: '',
      end_date: '',
      status: 'draft',
    },
  })

  React.useEffect(() => {
    if (!open) return
    form.reset({
      name: budget?.name ?? '',
      department_id: budget?.department_id ?? NONE,
      finance_category_id: budget?.finance_category_id ?? NONE,
      period: (budget?.period as BudgetFormValues['period']) ?? 'monthly',
      fiscal_year: budget?.fiscal_year ?? new Date().getFullYear(),
      amount: Number(budget?.amount ?? 0),
      start_date: budget?.start_date ?? '',
      end_date: budget?.end_date ?? '',
      status: (budget?.status as BudgetFormValues['status']) ?? 'draft',
    })
  }, [open, budget, form])

  const onSubmit = form.handleSubmit(async (values) => {
    await save.mutateAsync({
      id: budget?.id ?? undefined,
      values: {
        name: values.name.trim(),
        department_id: values.department_id === NONE ? null : values.department_id,
        finance_category_id: values.finance_category_id === NONE ? null : values.finance_category_id,
        period: values.period,
        fiscal_year: values.fiscal_year,
        amount: values.amount,
        start_date: values.start_date || null,
        end_date: values.end_date || null,
        status: values.status,
      },
    })
    onOpenChange(false)
  }, reportInvalid({ amount: 'Approved ceiling', fiscal_year: 'Fiscal year' }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit budget' : 'New budget'}</DialogTitle>
          <DialogDescription>
            The approved ceiling. Allocations are drawn against it and can never exceed it.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="budget-name">Budget name</Label>
            <Input id="budget-name" {...form.register('name')} autoFocus />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="budget-department">Department</Label>
              <Select
                value={form.watch('department_id')}
                onValueChange={(value) => form.setValue('department_id', value)}
              >
                <SelectTrigger id="budget-department">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Company-wide</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="budget-category">Category</Label>
              <Select
                value={form.watch('finance_category_id')}
                onValueChange={(value) => form.setValue('finance_category_id', value)}
              >
                <SelectTrigger id="budget-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Any category</SelectItem>
                  {categories
                    .filter((c) => c.kind === 'expense' && c.is_active)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="budget-amount">Approved ceiling</Label>
              <Input id="budget-amount" type="number" step="0.01" min="0" {...form.register('amount', { valueAsNumber: true })} />
              {form.formState.errors.amount && (
                <p className="text-xs text-destructive">{form.formState.errors.amount.message}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="budget-year">Fiscal year</Label>
              <Input id="budget-year" type="number" {...form.register('fiscal_year', { valueAsNumber: true })} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="budget-period">Period</Label>
              <Select
                value={form.watch('period')}
                onValueChange={(value) => form.setValue('period', value as BudgetFormValues['period'])}
              >
                <SelectTrigger id="budget-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="budget-status">Status</Label>
              <Select
                value={form.watch('status')}
                onValueChange={(value) => form.setValue('status', value as BudgetFormValues['status'])}
              >
                <SelectTrigger id="budget-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft — nothing can be drawn yet</SelectItem>
                  {/* Active is deliberately absent. A ceiling comes into force
                      when a Finance Manager approves it, not when the person
                      who drafted it selects "Active" -- which is the whole
                      point of drafting it separately. */}
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="budget-start">Starts</Label>
              <Input id="budget-start" type="date" {...form.register('start_date')} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="budget-end">Ends</Label>
              <Input id="budget-end" type="date" {...form.register('end_date')} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving...' : 'Save budget'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const allocationSchema = z.object({
  amount: z.number({ error: 'Enter an amount' }).positive('An allocation must be more than zero'),
  allocated_to: z.string().min(1, 'Say what this is allocated to').max(150),
  reference: z.string().max(80).optional(),
  note: z.string().max(300).optional(),
})
type AllocationFormValues = z.infer<typeof allocationSchema>

/** The four numbers a budget has, and the two that have no source yet. */
function BudgetFigures({ budget }: { budget: BudgetStatus }) {
  const rows: { label: string; value: string; hint?: string }[] = [
    { label: 'Approved ceiling', value: formatMoney(Number(budget.amount)) },
    { label: 'Allocated', value: formatMoney(Number(budget.allocated)) },
    { label: 'Unallocated', value: formatMoney(Number(budget.unallocated)) },
    {
      label: 'Reserved',
      value: formatMoney(Number(budget.reserved)),
      hint: 'approved requests and orders',
    },
    { label: 'Spent', value: formatMoney(Number(budget.spent)), hint: 'when payments exist' },
    {
      label: 'Available',
      value: formatMoney(Number(budget.remaining)),
      hint: 'ceiling less reserved',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {rows.map((row) => (
        <div key={row.label} className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{row.label}</p>
          <p className="font-display text-base font-bold tabular-nums text-foreground">{row.value}</p>
          {row.hint && <p className="text-[11px] text-muted-foreground">{row.hint}</p>}
        </div>
      ))}
    </div>
  )
}

function AllocationsDialog({
  budget,
  onOpenChange,
}: {
  budget: BudgetStatus | null
  onOpenChange: (open: boolean) => void
}) {
  const { profile } = useAuth()
  const budgetId = budget?.id ?? undefined
  const { data: allocations = [], isLoading } = useBudgetAllocations(budgetId)
  const save = useSaveAllocation(budgetId)
  const release = useReleaseAllocation(budgetId)
  const [editingId, setEditingId] = React.useState<string | null>(null)

  const canDraw = financeCan(profile?.role, 'allocations', 'create') && budget?.status === 'active'
  const canRelease = financeCan(profile?.role, 'allocations', 'archive')

  const form = useForm<AllocationFormValues>({
    resolver: zodResolver(allocationSchema),
    defaultValues: { amount: 0, allocated_to: '', reference: '', note: '' },
  })

  React.useEffect(() => {
    if (!budget) {
      setEditingId(null)
      form.reset({ amount: 0, allocated_to: '', reference: '', note: '' })
    }
  }, [budget, form])

  const onSubmit = form.handleSubmit(async (values) => {
    if (!budgetId) return
    await save.mutateAsync({
      id: editingId ?? undefined,
      values: {
        budget_id: budgetId,
        amount: values.amount,
        allocated_to: values.allocated_to.trim(),
        reference: values.reference?.trim() || null,
        note: values.note?.trim() || null,
      },
    })
    setEditingId(null)
    form.reset({ amount: 0, allocated_to: '', reference: '', note: '' })
  }, reportInvalid({ allocated_to: 'Allocated to' }))

  return (
    <Dialog open={!!budget} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{budget?.name}</DialogTitle>
          <DialogDescription>
            {budget?.department_name ?? 'Company-wide'} · {budget?.period} · FY {budget?.fiscal_year}
          </DialogDescription>
        </DialogHeader>

        {budget && <BudgetFigures budget={budget} />}

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">Allocations</h3>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : allocations.length === 0 ? (
            <Card>
              <CardContent className="py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  Nothing has been drawn against this ceiling yet.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {allocations.map((allocation) => (
                <div key={allocation.id} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {allocation.allocated_to}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {allocation.reference ? `${allocation.reference} · ` : ''}
                      {allocation.note ?? 'No note'}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                    {formatMoney(Number(allocation.amount))}
                  </p>
                  {allocation.status === 'released' ? (
                    <Badge variant="secondary">Released</Badge>
                  ) : (
                    <Badge variant="outline">Active</Badge>
                  )}
                  {(canEditAllocation(profile?.role, allocation, profile?.id) ||
                    (canRelease && allocation.status === 'active')) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Allocation actions">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canEditAllocation(profile?.role, allocation, profile?.id) && (
                          <DropdownMenuItem
                            onClick={() => {
                              setEditingId(allocation.id)
                              form.reset({
                                amount: Number(allocation.amount),
                                allocated_to: allocation.allocated_to,
                                reference: allocation.reference ?? '',
                                note: allocation.note ?? '',
                              })
                            }}
                          >
                            Edit
                          </DropdownMenuItem>
                        )}
                        {canRelease && allocation.status === 'active' && (
                          <DropdownMenuItem onClick={() => release.mutate({ id: allocation.id })}>
                            Release
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {canDraw && (
          <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <h3 className="text-sm font-semibold text-foreground">
              {editingId ? 'Correct this allocation' : 'Draw an allocation'}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="allocation-to">Allocated to</Label>
                <Input id="allocation-to" {...form.register('allocated_to')} />
                {form.formState.errors.allocated_to && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.allocated_to.message}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="allocation-amount">Amount</Label>
                <Input
                  id="allocation-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  {...form.register('amount', { valueAsNumber: true })}
                />
                {form.formState.errors.amount && (
                  <p className="text-xs text-destructive">{form.formState.errors.amount.message}</p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="allocation-reference">Reference</Label>
                <Input id="allocation-reference" {...form.register('reference')} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="allocation-note">Note</Label>
                <Textarea id="allocation-note" rows={1} {...form.register('note')} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              {editingId && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditingId(null)
                    form.reset({ amount: 0, allocated_to: '', reference: '', note: '' })
                  }}
                >
                  Cancel
                </Button>
              )}
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving...' : editingId ? 'Save correction' : 'Allocate'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default function BudgetsPage() {
  const { profile } = useAuth()
  const { data: budgets = [], isLoading } = useBudgets()
  const setStatus = useSetBudgetStatus()
  const review = useReviewBudget()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<BudgetStatus | null>(null)
  const [viewing, setViewing] = React.useState<BudgetStatus | null>(null)

  const canCreate = financeCan(profile?.role, 'budgets', 'create')
  const canEdit = financeCan(profile?.role, 'budgets', 'edit')
  const canClose = financeCan(profile?.role, 'budgets', 'archive')
  const canApprove = financeCan(profile?.role, 'budgets', 'approve')

  const active = budgets.filter((b) => b.status === 'active')
  const ceiling = active.reduce((sum, b) => sum + Number(b.amount), 0)
  // Allocated answers "how has this been earmarked internally", which is a real
  // question but not the one somebody opens this page asking. Reserved and
  // available answer "how much can Finance still commit", so those lead now.
  // Allocation is untouched and still has its column and its detail figures.
  const reserved = active.reduce((sum, b) => sum + Number(b.reserved), 0)
  const spent = active.reduce((sum, b) => sum + Number(b.spent), 0)
  const availableTotal = active.reduce((sum, b) => sum + Number(b.remaining), 0)

  const columns = React.useMemo<ColumnDef<BudgetStatus>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Budget',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-medium text-foreground">{row.original.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {row.original.department_name ?? 'Company-wide'} · FY {row.original.fiscal_year} ·{' '}
              {row.original.period}
            </p>
          </div>
        ),
      },
      {
        id: 'amount',
        header: 'Ceiling',
        cell: ({ row }) => (
          <span className="tabular-nums">{formatMoney(Number(row.original.amount))}</span>
        ),
      },
      {
        id: 'allocated',
        header: 'Allocated',
        cell: ({ row }) => (
          <div className="min-w-[7rem]">
            <span className="tabular-nums">{formatMoney(Number(row.original.allocated))}</span>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={
                  (row.original.allocated_pct ?? 0) >= (row.original.alert_threshold ?? 80)
                    ? 'h-full rounded-full bg-destructive'
                    : 'h-full rounded-full bg-accent'
                }
                style={{ width: `${Math.min(100, row.original.allocated_pct ?? 0)}%` }}
              />
            </div>
          </div>
        ),
      },
      // Unallocated moves to the detail panel, where the allocation figures
      // belong together. What the list needs is what is committed and what is
      // left, which is the question people open it with.
      {
        id: 'reserved',
        header: 'Reserved',
        cell: ({ row }) => (
          <span className="tabular-nums">{formatMoney(Number(row.original.reserved))}</span>
        ),
      },
      {
        id: 'spent',
        header: 'Spent',
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {formatMoney(Number(row.original.spent))}
          </span>
        ),
      },
      {
        id: 'available',
        header: 'Available',
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">
            {formatMoney(Number(row.original.remaining))}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => {
          const status = row.original.status ?? 'draft'
          return (
            <Badge variant={status === 'active' ? 'outline' : 'secondary'}>
              {status === 'active' ? 'Active' : status === 'draft' ? 'Draft' : 'Closed'}
            </Badge>
          )
        },
      },
      ...(canEdit || canClose || canApprove
        ? [
            {
              id: 'actions',
              cell: ({ row }) => (
                <div className="flex justify-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Budget actions">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {canEdit && (
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(row.original)
                            setDialogOpen(true)
                          }}
                        >
                          Edit
                        </DropdownMenuItem>
                      )}
                      {canApprove && row.original.status === 'draft' && row.original.id && (
                        <>
                          <DropdownMenuItem
                            onClick={() => review.mutate({ id: row.original.id!, approve: true })}
                          >
                            Approve ceiling
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            destructive
                            onClick={() => review.mutate({ id: row.original.id!, approve: false })}
                          >
                            Return for revision
                          </DropdownMenuItem>
                        </>
                      )}
                      {canClose && row.original.status !== 'closed' && row.original.id && (
                        <DropdownMenuItem
                          onClick={() => setStatus.mutate({ id: row.original.id!, status: 'closed' })}
                        >
                          Close budget
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ),
            } as ColumnDef<BudgetStatus>,
          ]
        : []),
    ],
    [canEdit, canClose, canApprove, setStatus, review],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Budgets"
        description="Approved ceilings and what has been drawn against them."
        action={
          canCreate ? (
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              New budget
            </Button>
          ) : undefined
        }
      />

      {/* Ceiling, reserved, spent, available -- the four that answer "how much
          is left". The ceiling does not shrink when money is committed; what
          moves is reserved, and available is what remains after it. Spent stays
          zero until something can actually settle a payment, and is shown
          rather than hidden so nobody reads reserved as spent. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Approved ceiling" value={formatMoney(ceiling)} icon={PiggyBank} isLoading={isLoading} />
        <StatCard label="Reserved" value={formatMoney(reserved)} icon={PiggyBank} isLoading={isLoading} />
        <StatCard label="Spent" value={formatMoney(spent)} icon={PiggyBank} isLoading={isLoading} />
        <StatCard label="Available" value={formatMoney(availableTotal)} icon={PiggyBank} isLoading={isLoading} />
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Across {active.length} active budget{active.length === 1 ? '' : 's'}. Reserved is money
        committed by an approved request or purchase order; it becomes spent only when a payment
        settles it, which no phase of JMAC can do yet.
      </p>

      <DataTable
        columns={columns}
        data={budgets}
        isLoading={isLoading}
        searchColumn="name"
        searchPlaceholder="Search budgets..."
        emptyTitle="No budgets yet"
        emptyDescription="A budget sets the ceiling that allocations and, later, requests are drawn against."
        onRowClick={(row) => setViewing(row)}
      />

      <BudgetDialog open={dialogOpen} onOpenChange={setDialogOpen} budget={editing} />
      <AllocationsDialog budget={viewing} onOpenChange={(open) => !open && setViewing(null)} />
    </div>
  )
}
