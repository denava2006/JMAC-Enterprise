import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { ColumnDef } from '@tanstack/react-table'
import { Plus, ReceiptText } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Button } from '@/components/ui/button'
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
import { reportInvalid } from '@/lib/formFeedback'
import { useAuth } from '@/contexts/AuthContext'
import { formatMoney } from '@/lib/currency'
import {
  REQUEST_TYPE_LABEL,
  isOpen,
  type RequestStatus,
  type RequestType,
} from '@/lib/financeRequests'
import { RequestDetail, StatusBadge } from '@/components/fms/RequestDetail'
import {
  useCreateAndSubmitRequest,
  useCreateFinanceRequest,
  useFinanceRequests,
  type FinanceRequestRow,
} from '@/hooks/useFinanceRequests'

const schema = z
  .object({
    type: z.enum(['purchase', 'reimbursement']),
    title: z.string().min(1, 'Say what this is for').max(150),
    description: z.string().max(1000).optional(),
    justification: z.string().max(1000).optional(),
    amount: z.number({ error: 'Enter an amount' }).positive('An amount must be more than zero'),
    needed_by: z.string().optional(),
    expense_date: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high']),
  })
  .refine((v) => v.type === 'reimbursement' || !v.expense_date, {
    message: 'Only a reimbursement has a date the money was already spent',
    path: ['expense_date'],
  })
type FormValues = z.infer<typeof schema>

function NewRequestDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { profile } = useAuth()
  const saveDraft = useCreateFinanceRequest()
  const submitNow = useCreateAndSubmitRequest()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      type: 'purchase',
      title: '',
      description: '',
      justification: '',
      amount: 0,
      needed_by: '',
      expense_date: '',
      priority: 'medium',
    },
  })

  const type = form.watch('type')

  const labels = { title: 'What this is for', expense_date: 'Date spent', needed_by: 'Needed by' }

  function toRow(values: FormValues) {
    return {
      requester_id: profile!.id,
      type: values.type,
      title: values.title.trim(),
      description: values.description?.trim() || null,
      justification: values.justification?.trim() || null,
      amount: values.amount,
      needed_by: values.needed_by || null,
      expense_date: values.type === 'reimbursement' ? values.expense_date || null : null,
      priority: values.priority,
    }
  }

  // Filling in this form usually means intending to send it. Saving a draft is
  // the deliberate other choice, so both are offered and neither is hidden
  // behind the other.
  const onSaveDraft = form.handleSubmit(async (values) => {
    if (!profile?.id) return
    await saveDraft.mutateAsync(toRow(values))
    form.reset()
    onOpenChange(false)
  }, reportInvalid(labels))

  const onSubmitNow = form.handleSubmit(async (values) => {
    if (!profile?.id) return
    await submitNow.mutateAsync(toRow(values))
    form.reset()
    onOpenChange(false)
  }, reportInvalid(labels))

  const busy = saveDraft.isPending || submitNow.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New request</DialogTitle>
          <DialogDescription>
            Send this request to Finance now, or save it as a draft to finish later. Nothing reaches
            Finance until you submit it, and you can still change it if it comes back to you.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmitNow} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="request-type">Type</Label>
              <Select
                value={type}
                onValueChange={(value) => form.setValue('type', value as RequestType)}
              >
                <SelectTrigger id="request-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="purchase">Purchase — something to be bought</SelectItem>
                  <SelectItem value="reimbursement">Reimbursement — money already spent</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="request-amount">Amount</Label>
              <Input
                id="request-amount"
                type="number"
                step="0.01"
                min="0"
                {...form.register('amount', { valueAsNumber: true })}
              />
              {form.formState.errors.amount && (
                <p className="text-xs text-destructive">{form.formState.errors.amount.message}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request-title">What is this for?</Label>
            <Input id="request-title" {...form.register('title')} autoFocus />
            {form.formState.errors.title && (
              <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request-description">Details</Label>
            <Textarea id="request-description" rows={3} {...form.register('description')} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request-justification">Why is it needed?</Label>
            <Textarea id="request-justification" rows={2} {...form.register('justification')} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="request-priority">Priority</Label>
              <Select
                value={form.watch('priority')}
                onValueChange={(value) => form.setValue('priority', value as FormValues['priority'])}
              >
                <SelectTrigger id="request-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {type === 'reimbursement' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="request-expense-date">Date spent</Label>
                <Input id="request-expense-date" type="date" {...form.register('expense_date')} />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="request-needed-by">Needed by</Label>
                <Input id="request-needed-by" type="date" {...form.register('needed_by')} />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" variant="outline" onClick={onSaveDraft} disabled={busy}>
              {saveDraft.isPending ? 'Saving…' : 'Save as Draft'}
            </Button>
            <Button type="submit" disabled={busy}>
              {submitNow.isPending ? 'Submitting…' : 'Submit Request'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A person's own purchases and reimbursements.
 *
 * Lives in My Workspace rather than in Finance: raising a request is something
 * any employee does, and most of them will never hold a finance role. RLS shows
 * a requester their own requests and nobody else's, so this page does not have
 * to filter for that — but it says whose they are anyway, because a list that
 * silently depends on the server for its scope is one nobody can check.
 */
export default function MyRequestsPage() {
  const { profile } = useAuth()
  const { data: all = [], isLoading } = useFinanceRequests()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [openId, setOpenId] = React.useState<string | null>(null)

  const mine = React.useMemo(
    () => all.filter((r) => r.requester_id === profile?.id),
    [all, profile?.id],
  )

  const openCount = mine.filter((r) => isOpen(r.status as RequestStatus)).length
  const awaitingMe = mine.filter((r) => r.status === 'returned' || r.status === 'draft').length
  const paid = mine
    .filter((r) => r.status === 'completed')
    .reduce((sum, r) => sum + Number(r.amount), 0)

  const columns = React.useMemo<ColumnDef<FinanceRequestRow>[]>(
    () => [
      {
        accessorKey: 'request_no',
        header: 'Reference',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-mono text-xs text-muted-foreground">
              {row.original.request_no ?? 'Draft'}
            </p>
            <p className="truncate font-medium text-foreground">{row.original.title}</p>
          </div>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {REQUEST_TYPE_LABEL[row.original.type as RequestType]}
          </span>
        ),
      },
      {
        id: 'amount',
        header: 'Amount',
        cell: ({ row }) => (
          <span className="tabular-nums">{formatMoney(Number(row.original.amount))}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusBadge status={row.original.status as RequestStatus} />,
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="My Requests"
        description="Purchases and reimbursements you have asked Finance for."
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            New request
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Open" value={openCount} icon={ReceiptText} isLoading={isLoading} />
        <StatCard label="Needs your attention" value={awaitingMe} icon={ReceiptText} isLoading={isLoading} />
        <StatCard label="Reimbursed to date" value={formatMoney(paid)} icon={ReceiptText} isLoading={isLoading} />
      </div>

      <DataTable
        columns={columns}
        data={mine}
        isLoading={isLoading}
        searchColumn="request_no"
        searchPlaceholder="Search your requests..."
        emptyTitle="You have not asked for anything yet"
        emptyDescription="Raise a purchase request or claim a reimbursement, and track it here."
        onRowClick={(row) => setOpenId(row.id)}
      />

      <NewRequestDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <RequestDetail requestId={openId} onOpenChange={(open) => !open && setOpenId(null)} />
    </div>
  )
}
