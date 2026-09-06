import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
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
import {
  REQUEST_FIELD_LABELS,
  editRequestSchema,
  type EditRequestValues,
} from '@/lib/requestForm'
import type { RequestType } from '@/lib/financeRequests'
import { useUpdateRequestDraft, type FinanceRequestRow } from '@/hooks/useFinanceRequests'

/**
 * Correcting a draft before it goes to Finance.
 *
 * Acceptance found a draft reimbursement with Submit, Cancel and Close and no
 * way to fix a wrong amount — so the only route to a correct claim was to
 * cancel and retype it, leaving a cancelled record behind and a new reference
 * number on the real one.
 *
 * What it does not offer is as deliberate as what it does. No budget, category
 * or vendor: those are Finance's during validation, and the requester cannot
 * read the master data to choose one anyway. No type: the reference number was
 * drawn from a per-type sequence when the request was raised. No status: that
 * is what Submit is for. The server refuses all four independently.
 */
export function EditRequestDialog({
  request,
  open,
  onOpenChange,
}: {
  request: FinanceRequestRow
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const save = useUpdateRequestDraft()
  const isReimbursement = (request.type as RequestType) === 'reimbursement'

  const form = useForm<EditRequestValues>({
    resolver: zodResolver(editRequestSchema),
    defaultValues: {
      title: request.title,
      description: request.description ?? '',
      justification: request.justification ?? '',
      amount: Number(request.amount),
      needed_by: request.needed_by ?? '',
      expense_date: request.expense_date ?? '',
      priority: (request.priority as EditRequestValues['priority']) ?? 'medium',
    },
  })

  // Reopening the dialog on a request that has since changed — someone saved in
  // another tab, or the row was refetched — has to start from what is there now
  // rather than from what was there when this component first mounted.
  React.useEffect(() => {
    if (!open) return
    form.reset({
      title: request.title,
      description: request.description ?? '',
      justification: request.justification ?? '',
      amount: Number(request.amount),
      needed_by: request.needed_by ?? '',
      expense_date: request.expense_date ?? '',
      priority: (request.priority as EditRequestValues['priority']) ?? 'medium',
    })
  }, [open, request.id, request.updated_at])

  const onSubmit = form.handleSubmit(async (values) => {
    await save.mutateAsync({
      requestId: request.id,
      title: values.title.trim(),
      amount: values.amount,
      priority: values.priority,
      description: values.description?.trim() || null,
      justification: values.justification?.trim() || null,
      expenseDate: isReimbursement ? values.expense_date || null : null,
      neededBy: isReimbursement ? null : values.needed_by || null,
      // What this form was rendered from. If the row has moved on, the server
      // refuses rather than overwriting whatever arrived in between.
      expectedUpdatedAt: request.updated_at,
    })
    onOpenChange(false)
  }, reportInvalid(REQUEST_FIELD_LABELS))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {request.request_no ?? 'draft'}</DialogTitle>
          <DialogDescription>
            This is still a draft, so nothing has reached Finance yet. Correct whatever is wrong and
            submit it when it is right.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-title">What is this for?</Label>
            <Input id="edit-title" {...form.register('title')} autoFocus />
            {form.formState.errors.title && (
              <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-amount">Amount</Label>
              <Input
                id="edit-amount"
                type="number"
                step="0.01"
                min="0"
                {...form.register('amount', { valueAsNumber: true })}
              />
              {form.formState.errors.amount && (
                <p className="text-xs text-destructive">{form.formState.errors.amount.message}</p>
              )}
            </div>

            {isReimbursement ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-expense-date">Date spent</Label>
                <Input id="edit-expense-date" type="date" {...form.register('expense_date')} />
                {form.formState.errors.expense_date && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.expense_date.message}
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-needed-by">Needed by</Label>
                <Input id="edit-needed-by" type="date" {...form.register('needed_by')} />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-description">Details</Label>
            <Textarea id="edit-description" rows={3} {...form.register('description')} />
            {form.formState.errors.description && (
              <p className="text-xs text-destructive">{form.formState.errors.description.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-justification">Why is it needed?</Label>
            <Textarea id="edit-justification" rows={2} {...form.register('justification')} />
            {form.formState.errors.justification && (
              <p className="text-xs text-destructive">
                {form.formState.errors.justification.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5 sm:max-w-[50%]">
            <Label htmlFor="edit-priority">Priority</Label>
            <Select
              value={form.watch('priority')}
              onValueChange={(value) =>
                form.setValue('priority', value as EditRequestValues['priority'])
              }
            >
              <SelectTrigger id="edit-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            {/* Disabled while saving, so a second click cannot send a second
                write. The server refuses a stale one regardless — this only
                stops the user watching it happen. */}
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
