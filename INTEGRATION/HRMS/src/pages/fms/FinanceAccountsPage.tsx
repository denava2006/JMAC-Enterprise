import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { ColumnDef } from '@tanstack/react-table'
import { Landmark, MoreHorizontal, Plus } from 'lucide-react'
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
import { financeCan } from '@/lib/financeAuthority'
import { formatMoney } from '@/lib/currency'
import {
  type FinanceAccount,
  useFinanceAccounts,
  useSaveFinanceAccount,
  useSetFinanceAccountActive,
} from '@/hooks/useFinanceMasterData'

/** The statement side, and the instrument that sits on it. The pair is
 *  constrained in the database; this is the same table, for the form. */
const SUBTYPES: Record<string, { value: string; label: string }[]> = {
  asset: [
    { value: 'bank', label: 'Bank account' },
    { value: 'cash', label: 'Cash on hand' },
    { value: 'e_wallet', label: 'E-wallet' },
    { value: 'receivable', label: 'Receivable' },
    { value: 'other', label: 'Other asset' },
  ],
  liability: [
    { value: 'payable', label: 'Payable' },
    { value: 'accrual', label: 'Accrual' },
    { value: 'other', label: 'Other liability' },
  ],
  equity: [{ value: 'other', label: 'Equity' }],
  revenue: [
    { value: 'operating', label: 'Operating revenue' },
    { value: 'other', label: 'Other revenue' },
  ],
  expense: [
    { value: 'operating', label: 'Operating expense' },
    { value: 'other', label: 'Other expense' },
  ],
}

const TYPE_LABEL: Record<string, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expense',
}

const schema = z
  .object({
    name: z.string().min(1, 'A name is required').max(120),
    account_code: z.string().max(30).optional(),
    account_type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
    account_subtype: z.string().min(1),
    opening_balance: z.number({ error: 'Enter an amount' }).min(0, 'An opening balance cannot be negative'),
    opening_balance_as_of: z.string().optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((v) => v.opening_balance === 0 || !!v.opening_balance_as_of, {
    // The same rule the check constraint holds: a balance with no date is a
    // number nobody can place in time.
    message: 'An opening balance needs the date it was true',
    path: ['opening_balance_as_of'],
  })
type FormValues = z.infer<typeof schema>

function AccountDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account?: FinanceAccount | null
}) {
  const isEdit = !!account
  const save = useSaveFinanceAccount()
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      account_code: '',
      account_type: 'asset',
      account_subtype: 'bank',
      opening_balance: 0,
      opening_balance_as_of: '',
      notes: '',
    },
  })

  const accountType = form.watch('account_type')

  React.useEffect(() => {
    if (!open) return
    form.reset({
      name: account?.name ?? '',
      account_code: account?.account_code ?? '',
      account_type: (account?.account_type as FormValues['account_type']) ?? 'asset',
      account_subtype: account?.account_subtype ?? 'bank',
      opening_balance: Number(account?.opening_balance ?? 0),
      opening_balance_as_of: account?.opening_balance_as_of ?? '',
      notes: account?.notes ?? '',
    })
  }, [open, account, form])

  const onSubmit = form.handleSubmit(async (values) => {
    await save.mutateAsync({
      id: account?.id,
      values: {
        name: values.name.trim(),
        account_code: values.account_code?.trim() || null,
        account_type: values.account_type,
        account_subtype: values.account_subtype,
        opening_balance: values.opening_balance,
        opening_balance_as_of: values.opening_balance_as_of || null,
        notes: values.notes?.trim() || null,
      },
    })
    onOpenChange(false)
  }, reportInvalid({ opening_balance_as_of: 'Opening balance date', account_subtype: 'Kind' }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit account' : 'New account'}</DialogTitle>
          <DialogDescription>
            An account in the chart. The statement side and the instrument are recorded separately,
            so a bank account is an asset that happens to be a bank.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-name">Account name</Label>
            <Input id="account-name" {...form.register('name')} autoFocus />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-type">Statement side</Label>
              <Select
                value={accountType}
                onValueChange={(value) => {
                  form.setValue('account_type', value as FormValues['account_type'])
                  form.setValue('account_subtype', SUBTYPES[value][0].value)
                }}
              >
                <SelectTrigger id="account-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(SUBTYPES).map((type) => (
                    <SelectItem key={type} value={type}>
                      {TYPE_LABEL[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-subtype">Kind</Label>
              <Select
                value={form.watch('account_subtype')}
                onValueChange={(value) => form.setValue('account_subtype', value)}
              >
                <SelectTrigger id="account-subtype">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(SUBTYPES[accountType] ?? []).map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-code">Account code</Label>
              <Input id="account-code" {...form.register('account_code')} placeholder="1000" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-opening">Opening balance</Label>
              <Input id="account-opening" type="number" step="0.01" min="0" {...form.register('opening_balance', { valueAsNumber: true })} />
              {form.formState.errors.opening_balance && (
                <p className="text-xs text-destructive">{form.formState.errors.opening_balance.message}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-as-of">Opening balance as of</Label>
            <Input id="account-as-of" type="date" {...form.register('opening_balance_as_of')} />
            {form.formState.errors.opening_balance_as_of && (
              <p className="text-xs text-destructive">
                {form.formState.errors.opening_balance_as_of.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-notes">Notes</Label>
            <Textarea id="account-notes" rows={2} {...form.register('notes')} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving...' : 'Save account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function FinanceAccountsPage() {
  const { profile } = useAuth()
  const { data: accounts = [], isLoading } = useFinanceAccounts()
  const setActive = useSetFinanceAccountActive()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<FinanceAccount | null>(null)

  const canCreate = financeCan(profile?.role, 'accounts', 'create')
  const canEdit = financeCan(profile?.role, 'accounts', 'edit')
  const canArchive = financeCan(profile?.role, 'accounts', 'archive')

  const columns = React.useMemo<ColumnDef<FinanceAccount>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Account',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-medium text-foreground">{row.original.name}</p>
            {row.original.account_code && (
              <p className="text-xs text-muted-foreground">{row.original.account_code}</p>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'account_type',
        header: 'Classification',
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5">
            <Badge variant="outline">{TYPE_LABEL[row.original.account_type]}</Badge>
            <span className="text-xs text-muted-foreground">
              {(SUBTYPES[row.original.account_type] ?? []).find(
                (s) => s.value === row.original.account_subtype,
              )?.label ?? row.original.account_subtype}
            </span>
          </div>
        ),
      },
      {
        id: 'opening',
        header: 'Opening balance',
        cell: ({ row }) => (
          <div className="text-right tabular-nums">
            <p className="font-medium text-foreground">
              {formatMoney(Number(row.original.opening_balance))}
            </p>
            <p className="text-xs text-muted-foreground">
              {row.original.opening_balance_as_of
                ? `as of ${row.original.opening_balance_as_of}`
                : 'no opening balance'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'is_active',
        header: 'Status',
        cell: ({ row }) =>
          row.original.is_active ? (
            <Badge variant="outline">Open</Badge>
          ) : (
            <Badge variant="secondary">Closed</Badge>
          ),
      },
      ...(canEdit || canArchive
        ? [
            {
              id: 'actions',
              cell: ({ row }) => (
                <div className="flex justify-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Account actions">
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
                      {canArchive && (
                        <DropdownMenuItem
                          onClick={() =>
                            setActive.mutate({ id: row.original.id, isActive: !row.original.is_active })
                          }
                        >
                          {row.original.is_active ? 'Close account' : 'Reopen'}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ),
            } as ColumnDef<FinanceAccount>,
          ]
        : []),
    ],
    [canEdit, canArchive, setActive],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Chart of Accounts"
        description="The accounts money moves through. Maintained by the Accountant."
        action={
          canCreate ? (
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              New account
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(['asset', 'liability', 'revenue', 'expense'] as const).map((type) => (
          <StatCard
            key={type}
            label={`${TYPE_LABEL[type]} accounts`}
            value={accounts.filter((a) => a.account_type === type && a.is_active).length}
            icon={Landmark}
            isLoading={isLoading}
          />
        ))}
      </div>

      <DataTable
        columns={columns}
        data={accounts}
        isLoading={isLoading}
        searchColumn="name"
        searchPlaceholder="Search accounts..."
        emptyTitle="The chart is empty"
        emptyDescription="Add the cash, bank and e-wallet accounts the company actually uses."
      />

      <Card>
        <CardContent className="py-4">
          <p className="text-xs text-muted-foreground">
            Balances are not carried on these records. An opening balance says what was true on a
            stated day; the running balance becomes derivable when the journal is built, so nothing
            here shows a total that no posting produced.
          </p>
        </CardContent>
      </Card>

      <AccountDialog open={dialogOpen} onOpenChange={setDialogOpen} account={editing} />
    </div>
  )
}
