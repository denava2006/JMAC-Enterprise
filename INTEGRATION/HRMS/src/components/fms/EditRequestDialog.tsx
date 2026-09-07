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

/** What this form owns, read off a request row. One place, so opening the
 *  editor and reloading it cannot drift apart. */
function valuesOf(request: FinanceRequestRow): EditRequestValues {
  return {
    title: request.title,
    description: request.description ?? '',
    justification: request.justification ?? '',
    amount: Number(request.amount),
    needed_by: request.needed_by ?? '',
    expense_date: request.expense_date ?? '',
    priority: (request.priority as EditRequestValues['priority']) ?? 'medium',
  }
}

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
    defaultValues: valuesOf(request),
  })

  /**
   * Which version of the row this form is showing, and whether it has since
   * been overtaken.
   *
   * The first version of this dialog reset the form whenever `updated_at`
   * changed, on the reasoning that a reopened editor should show what the draft
   * says now. True when it is reopened; wrong while it is open. A background
   * refetch would land mid-correction and replace what was being typed —
   * 1250.50 back to 1100, the retyped details back to the stored ones — with
   * nothing on screen to say it had happened. Worse, the save that followed
   * carried the *newer* timestamp, so the staleness guard in
   * update_finance_request_draft saw a save that had read the current row and
   * let the replacement values through as though somebody had meant them.
   *
   * So the version is pinned to what was actually rendered, and a row that
   * moves underneath an untouched form is still followed — nothing is at stake
   * — while one that moves underneath a correction in progress stops and says
   * so.
   */
  const rendered = React.useRef<{ id: string; version: string | null } | null>(null)
  const [loadedVersion, setLoadedVersion] = React.useState<string | null>(null)
  const [overtaken, setOvertaken] = React.useState(false)

  // Read during render so the effect below is subscribed to it rather than
  // reading a stale value off the formState proxy.
  const isDirty = form.formState.isDirty

  // The inputs are uncontrolled, so a reset that changes no subscribed piece of
  // form state re-renders nothing and leaves the boxes showing the old values
  // while the form submits the new ones. Keying the form on the version loaded
  // into it rebuilds the inputs whenever one actually is, so what is on screen
  // is what would be saved.
  const load = React.useCallback(() => {
    form.reset(valuesOf(request))
    rendered.current = { id: request.id, version: request.updated_at }
    setLoadedVersion(request.updated_at)
    setOvertaken(false)
  }, [form, request])

  React.useEffect(() => {
    if (!open) {
      // Closed. Reopening starts from the draft as it stands then.
      rendered.current = null
      setOvertaken(false)
      return
    }
    if (!rendered.current || rendered.current.id !== request.id) {
      load()
      return
    }
    if (rendered.current.version === request.updated_at) return
    if (isDirty) {
      setOvertaken(true)
      return
    }
    load()
  }, [open, request.id, request.updated_at, isDirty, load])

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
      // The version these values were typed against, not whatever has arrived
      // since. If the row has moved on, the server refuses rather than
      // overwriting what came in between.
      expectedUpdatedAt: rendered.current?.version ?? request.updated_at,
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

        <form key={loadedVersion ?? 'initial'} onSubmit={onSubmit} className="flex flex-col gap-4">
          {/* Named, not silent. Whichever way this is resolved it is somebody's
              decision, so both ways out are on screen rather than one of them
              happening quietly. */}
          {overtaken && (
            <div
              role="status"
              className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
            >
              <p className="text-xs text-amber-700 dark:text-amber-400">
                This draft changed somewhere else while you were editing it. What you typed is
                still here and has not been saved.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={load}>
                  Use the newer version
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    // Overwriting deliberately: the version being replaced is
                    // the one the save now carries, so the server accepts it.
                    rendered.current = { id: request.id, version: request.updated_at }
                    setOvertaken(false)
                  }}
                >
                  Keep mine
                </Button>
              </div>
            </div>
          )}

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
