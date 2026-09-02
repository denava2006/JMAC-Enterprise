import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { useAuth } from '@/contexts/AuthContext'
import { formatMoney } from '@/lib/currency'
import {
  APPROVAL_ACTION_LABEL,
  REQUEST_TYPE_LABEL,
  STATUS_TONE,
  actionsFor,
  statusLabel,
  type RequestAction,
  type RequestStatus,
  type RequestType,
} from '@/lib/financeRequests'
import {
  useFinanceRequest,
  useRequestParticipants,
  useRequestTrail,
  useTransitionRequest,
  useUpdateFinanceRequest,
} from '@/hooks/useFinanceRequests'
import { useBudgets, useFinanceCategories, useVendors } from '@/hooks/useFinanceMasterData'

export function StatusBadge({
  status,
  type = 'purchase',
}: {
  status: RequestStatus
  /** Approved means "awaiting procurement" for a purchase and "awaiting
   *  payment" for a reimbursement. Neither has happened. */
  type?: RequestType
}) {
  const tone = STATUS_TONE[status]
  return (
    <Badge variant={tone === 'good' ? 'default' : tone === 'bad' ? 'destructive' : 'secondary'}>
      {statusLabel(status, type)}
    </Badge>
  )
}

const UNSET = '__unset__'

/**
 * Which budget line a request is charged to.
 *
 * The requester cannot choose this: budgets, categories and vendors are Finance
 * master data and they cannot read any of it. Deciding it is what "Finance Staff
 * check the documents and the budget" means, so it belongs to validation — and
 * after validation it is fixed, because what was approved was approved against a
 * particular line.
 */
function ClassificationPanel({
  request,
}: {
  request: { id: string; budget_id: string | null; finance_category_id: string | null; vendor_id: string | null }
}) {
  const { data: budgets = [] } = useBudgets()
  const { data: categories = [] } = useFinanceCategories()
  const { data: vendors = [] } = useVendors()
  const update = useUpdateFinanceRequest()

  const [budgetId, setBudgetId] = React.useState(request.budget_id ?? UNSET)
  const [categoryId, setCategoryId] = React.useState(request.finance_category_id ?? UNSET)
  const [vendorId, setVendorId] = React.useState(request.vendor_id ?? UNSET)

  React.useEffect(() => {
    setBudgetId(request.budget_id ?? UNSET)
    setCategoryId(request.finance_category_id ?? UNSET)
    setVendorId(request.vendor_id ?? UNSET)
  }, [request.id, request.budget_id, request.finance_category_id, request.vendor_id])

  const dirty =
    budgetId !== (request.budget_id ?? UNSET) ||
    categoryId !== (request.finance_category_id ?? UNSET) ||
    vendorId !== (request.vendor_id ?? UNSET)

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-semibold text-foreground">Classification</p>
        <p className="text-xs text-muted-foreground">
          Charge this to a budget before validating it. After validation these are fixed.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="classify-budget">
            Budget <span className="text-destructive">*</span>
          </Label>
          <Select value={budgetId} onValueChange={setBudgetId}>
            <SelectTrigger id="classify-budget">
              <SelectValue placeholder="No budget" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>No budget</SelectItem>
              {budgets
                .filter((b) => b.status === 'active' && b.id)
                .map((b) => (
                  <SelectItem key={b.id!} value={b.id!}>
                    {b.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="classify-category">Category</Label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger id="classify-category">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>None</SelectItem>
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
          <Label htmlFor="classify-vendor">Vendor</Label>
          <Select value={vendorId} onValueChange={setVendorId}>
            <SelectTrigger id="classify-vendor">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>None</SelectItem>
              {vendors
                .filter((v) => v.is_active)
                .map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          variant="outline"
          disabled={!dirty || update.isPending}
          onClick={() =>
            update.mutate({
              id: request.id,
              values: {
                budget_id: budgetId === UNSET ? null : budgetId,
                finance_category_id: categoryId === UNSET ? null : categoryId,
                vendor_id: vendorId === UNSET ? null : vendorId,
              },
            })
          }
        >
          {update.isPending ? 'Saving…' : 'Save classification'}
        </Button>
      </div>
    </div>
  )
}

/** Where a request has got to, and who owns it now.
 *
 * Four stages rather than eight statuses: the statuses are what the database
 * enforces, this is what a person needs to know. A returned, rejected or
 * cancelled request says so instead, because it is not progressing. */
function RequestStages({ status, type }: { status: RequestStatus; type: RequestType }) {
  const stages = [
    'Submitted',
    'Finance validation',
    'Manager approval',
    type === 'reimbursement' ? 'Payment' : 'Procurement',
  ]

  const reached: Record<string, number> = {
    draft: 0,
    pending_validation: 1,
    pending_approval: 2,
    approved: 3,
    completed: 4,
  }

  if (status === 'returned' || status === 'rejected' || status === 'cancelled') {
    return (
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {status === 'returned'
          ? 'Sent back to the requester. It returns to Finance when they resubmit it.'
          : status === 'rejected'
            ? 'Refused. Nothing is reserved against the budget.'
            : 'Withdrawn by the requester before Finance acted on it.'}
      </div>
    )
  }

  const current = reached[status] ?? 0

  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs" aria-label="Progress">
      {stages.map((stage, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={stage} className="flex items-center gap-1.5">
            <span
              className={
                done
                  ? 'rounded-full bg-accent/15 px-2 py-0.5 font-medium text-accent'
                  : active
                    ? 'rounded-full bg-accent px-2 py-0.5 font-medium text-accent-foreground'
                    : 'rounded-full bg-muted px-2 py-0.5 text-muted-foreground'
              }
              aria-current={active ? 'step' : undefined}
            >
              {stage}
            </span>
            {i < stages.length - 1 && <span className="text-muted-foreground/60">→</span>}
          </li>
        )
      })}
    </ol>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value ?? '—'}</p>
    </div>
  )
}

/**
 * One request, its history, and whatever this person may do to it next.
 *
 * The buttons come from actionsFor, which mirrors the database's transition
 * table. Nothing here decides authority — it decides what to offer, so that a
 * button never comes back refused.
 */
export function RequestDetail({
  requestId,
  onOpenChange,
}: {
  requestId: string | null
  onOpenChange: (open: boolean) => void
}) {
  const { profile } = useAuth()
  const { data: request, isLoading } = useFinanceRequest(requestId ?? undefined)
  const { data: trail = [] } = useRequestTrail(requestId ?? undefined)
  const { data: names } = useRequestParticipants()
  const transition = useTransitionRequest()

  const [pending, setPending] = React.useState<RequestAction | null>(null)
  const [remarks, setRemarks] = React.useState('')

  React.useEffect(() => {
    if (!requestId) {
      setPending(null)
      setRemarks('')
    }
  }, [requestId])

  const actions = request
    ? actionsFor(
        profile?.role,
        { status: request.status as RequestStatus, requester_id: request.requester_id },
        profile?.id,
      )
    : []

  // A purchase charged to no budget reserves nothing on approval, so the
  // ceiling it is supposed to be drawn against never sees it. Better to say so
  // at validation, where it can still be fixed, than to let it through silently.
  const needsBudget =
    !!request &&
    request.status === 'pending_validation' &&
    request.type === 'purchase' &&
    !request.budget_id

  async function run(action: RequestAction) {
    if (!request) return
    if (action.requiresRemarks && !remarks.trim()) return

    await transition.mutateAsync({
      requestId: request.id,
      to: action.to,
      remarks: remarks.trim() || null,
    })
    setPending(null)
    setRemarks('')
    onOpenChange(false)
  }

  return (
    <Dialog open={!!requestId} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {isLoading || !request ? (
          <DialogHeader>
            <DialogTitle>Loading…</DialogTitle>
            <DialogDescription>Fetching the request.</DialogDescription>
          </DialogHeader>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {request.request_no}
                <StatusBadge
                  status={request.status as RequestStatus}
                  type={request.type as RequestType}
                />
              </DialogTitle>
              <DialogDescription>
                {REQUEST_TYPE_LABEL[request.type as RequestType]} ·{' '}
                {names?.get(request.requester_id) ?? '…'}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <RequestStages
                status={request.status as RequestStatus}
                type={request.type as RequestType}
              />

              <div>
                <p className="font-medium text-foreground">{request.title}</p>
                {request.description && (
                  <p className="text-sm text-muted-foreground">{request.description}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Field
                  label="Amount"
                  value={
                    <span className="font-display text-base font-bold tabular-nums">
                      {formatMoney(Number(request.amount))}
                    </span>
                  }
                />
                <Field label="Budget" value={request.budgets?.name} />
                <Field label="Category" value={request.finance_categories?.name} />
                <Field label="Vendor" value={request.vendors?.name} />
                <Field label="Needed by" value={request.needed_by} />
                <Field label="Priority" value={request.priority} />
              </div>

              {request.justification && (
                <div>
                  <p className="text-xs text-muted-foreground">Justification</p>
                  <p className="text-sm text-foreground">{request.justification}</p>
                </div>
              )}

              {request.status === 'approved' && (
                <Card>
                  <CardContent className="flex flex-col gap-1 py-3">
                    <p className="text-sm font-medium text-foreground">
                      {request.type === 'reimbursement'
                        ? 'Approved — awaiting payment'
                        : 'Approved — awaiting procurement'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {request.type === 'reimbursement'
                        ? 'Finance approved this reimbursement and reserved its budget. Payment is the next step.'
                        : 'Finance approved this request and reserved its budget. Procurement is the next step.'}
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* The trail. Append-only, so this is the whole story. */}
              <div className="flex flex-col gap-2">
                <p className="text-sm font-semibold text-foreground">History</p>
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                  {trail.length === 0 ? (
                    <p className="p-3 text-sm text-muted-foreground">
                      Nothing has happened to this request yet.
                    </p>
                  ) : (
                    trail.map((entry) => (
                      <div key={entry.id} className="flex items-start justify-between gap-3 p-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {APPROVAL_ACTION_LABEL[entry.action] ?? entry.action}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {(entry.actor_id && names?.get(entry.actor_id)) ?? '…'}
                            {entry.remarks ? ` — ${entry.remarks}` : ''}
                          </p>
                        </div>
                        <p className="shrink-0 text-xs text-muted-foreground">
                          {new Date(entry.created_at).toLocaleString()}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {profile?.role === 'finance_staff' &&
                request.status === 'pending_validation' &&
                request.requester_id !== profile?.id && <ClassificationPanel request={request} />}

              {/* What this person may do next. */}
              {actions.length > 0 && (
                <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                  {pending?.requiresRemarks && (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="request-remarks">
                        Why? The requester sees this, so make it actionable.
                      </Label>
                      <Textarea
                        id="request-remarks"
                        rows={2}
                        value={remarks}
                        onChange={(e) => setRemarks(e.target.value)}
                        autoFocus
                      />
                    </div>
                  )}

                  {needsBudget && !pending && (
                    <p className="text-xs text-warning">
                      Assign a budget before validating this request.
                    </p>
                  )}

                  <div className="flex flex-wrap justify-end gap-2">
                    {pending ? (
                      <>
                        <Button variant="outline" onClick={() => setPending(null)}>
                          Back
                        </Button>
                        <Button
                          variant={pending.tone === 'destructive' ? 'destructive' : 'default'}
                          disabled={transition.isPending || (pending.requiresRemarks && !remarks.trim())}
                          onClick={() => run(pending)}
                        >
                          {transition.isPending ? 'Working…' : `Confirm — ${pending.label}`}
                        </Button>
                      </>
                    ) : (
                      actions.map((action) => {
                        // Only the forward move is blocked. Returning or
                        // rejecting an unclassified request is exactly what
                        // somebody should be able to do with one.
                        const blocked = needsBudget && action.tone === 'primary'
                        return (
                          <Button
                            key={action.to + action.label}
                            variant={
                              action.tone === 'primary'
                                ? 'default'
                                : action.tone === 'destructive'
                                  ? 'destructive'
                                  : 'outline'
                            }
                            disabled={transition.isPending || blocked}
                            title={blocked ? 'Assign a budget before validating this request.' : undefined}
                            onClick={() => (action.requiresRemarks ? setPending(action) : run(action))}
                          >
                            {action.label}
                          </Button>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
