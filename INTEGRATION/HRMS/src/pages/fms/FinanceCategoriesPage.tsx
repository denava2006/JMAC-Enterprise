import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, Plus, Tags } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { ApprovalBadge } from '@/components/fms/ApprovalCell'
import {
  type FinanceCategory,
  useFinanceCategories,
  useSaveFinanceCategory,
  useSetFinanceCategoryActive,
  useReviewFinanceCategory,
} from '@/hooks/useFinanceMasterData'

const schema = z.object({
  name: z.string().min(1, 'A name is required').max(100),
  kind: z.enum(['income', 'expense']),
  description: z.string().max(500).optional(),
})
type FormValues = z.infer<typeof schema>

function CategoryDialog({
  open,
  onOpenChange,
  category,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  category?: FinanceCategory | null
}) {
  const isEdit = !!category
  const save = useSaveFinanceCategory()
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', kind: 'expense', description: '' },
  })

  React.useEffect(() => {
    if (!open) return
    form.reset({
      name: category?.name ?? '',
      kind: (category?.kind as 'income' | 'expense') ?? 'expense',
      description: category?.description ?? '',
    })
  }, [open, category, form])

  const onSubmit = form.handleSubmit(async (values) => {
    await save.mutateAsync({
      id: category?.id,
      values: {
        name: values.name.trim(),
        kind: values.kind,
        description: values.description?.trim() || null,
      },
    })
    onOpenChange(false)
  }, reportInvalid({ kind: 'Side' }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit category' : 'New category'}</DialogTitle>
          <DialogDescription>
            How money is classified. This is separate from POS product categories, which say what
            shelf a product sits on.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category-name">Name</Label>
            <Input id="category-name" {...form.register('name')} autoFocus />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category-kind">Side</Label>
            <Select
              value={form.watch('kind')}
              onValueChange={(value) => form.setValue('kind', value as 'income' | 'expense')}
            >
              <SelectTrigger id="category-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="expense">Expense — money going out</SelectItem>
                <SelectItem value="income">Income — money coming in</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category-description">Description</Label>
            <Textarea id="category-description" rows={3} {...form.register('description')} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving...' : 'Save category'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function FinanceCategoriesPage() {
  const { profile } = useAuth()
  const { data: categories = [], isLoading } = useFinanceCategories()
  const setActive = useSetFinanceCategoryActive()
  const review = useReviewFinanceCategory()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<FinanceCategory | null>(null)

  const canCreate = financeCan(profile?.role, 'categories', 'create')
  const canEdit = financeCan(profile?.role, 'categories', 'edit')
  const canArchive = financeCan(profile?.role, 'categories', 'archive')
  const canApprove = financeCan(profile?.role, 'categories', 'approve')

  const expenseCount = categories.filter((c) => c.kind === 'expense' && c.is_active).length
  const incomeCount = categories.filter((c) => c.kind === 'income' && c.is_active).length

  const columns = React.useMemo<ColumnDef<FinanceCategory>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Category',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-medium text-foreground">{row.original.name}</p>
            {row.original.description && (
              <p className="truncate text-xs text-muted-foreground">{row.original.description}</p>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'kind',
        header: 'Side',
        cell: ({ row }) => (
          <Badge variant={row.original.kind === 'income' ? 'default' : 'secondary'}>
            {row.original.kind === 'income' ? 'Income' : 'Expense'}
          </Badge>
        ),
      },
      {
        accessorKey: 'is_active',
        header: 'Status',
        cell: ({ row }) =>
          row.original.is_active ? (
            <Badge variant="outline">In use</Badge>
          ) : (
            <Badge variant="secondary">Archived</Badge>
          ),
      },
      {
        accessorKey: 'approval_status',
        header: 'Approval',
        cell: ({ row }) => <ApprovalBadge status={row.original.approval_status} />,
      },
      ...(canEdit || canArchive || canApprove
        ? [
            {
              id: 'actions',
              cell: ({ row }) => (
                <div className="flex justify-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Category actions">
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
                      {canApprove && row.original.approval_status === 'pending_approval' && (
                        <>
                          <DropdownMenuItem
                            onClick={() => review.mutate({ id: row.original.id, approve: true })}
                          >
                            Approve category
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            destructive
                            onClick={() => review.mutate({ id: row.original.id, approve: false })}
                          >
                            Reject category
                          </DropdownMenuItem>
                        </>
                      )}
                      {canArchive && (
                        <DropdownMenuItem
                          onClick={() =>
                            setActive.mutate({ id: row.original.id, isActive: !row.original.is_active })
                          }
                        >
                          {row.original.is_active ? 'Archive' : 'Restore'}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ),
            } as ColumnDef<FinanceCategory>,
          ]
        : []),
    ],
    [canEdit, canArchive, canApprove, setActive, review],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Finance Categories"
        description="How money is classified. Kept apart from POS product categories, which are a different taxonomy."
        action={
          canCreate ? (
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              New category
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Expense categories" value={expenseCount} icon={Tags} isLoading={isLoading} />
        <StatCard label="Income categories" value={incomeCount} icon={Tags} isLoading={isLoading} />
        <StatCard label="Archived" value={categories.filter((c) => !c.is_active).length} icon={Tags} isLoading={isLoading} />
      </div>

      <DataTable
        columns={columns}
        data={categories}
        isLoading={isLoading}
        searchColumn="name"
        searchPlaceholder="Search categories..."
        emptyTitle="No categories yet"
        emptyDescription="Categories classify what money is spent on and where it comes from."
      />

      <CategoryDialog open={dialogOpen} onOpenChange={setDialogOpen} category={editing} />
    </div>
  )
}
