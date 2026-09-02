import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
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
  useRequestTrail,
  useTransitionRequest,
} from '@/hooks/useFinanceRequests'

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
                {request.profiles?.full_name ?? 'Unknown requester'}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
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
                  <CardContent className="py-3">
                    <p className="text-xs text-muted-foreground">
                      Approved and reserved against the budget.{' '}
                      {request.type === 'reimbursement'
                        ? 'Payment is settled in a later phase — approval is authorization to pay, not a payment.'
                        : 'Procurement happens in a later phase — approval is authorization to buy, not a purchase.'}
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
                            {entry.profiles?.full_name ?? 'Unknown'}
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
                      actions.map((action) => (
                        <Button
                          key={action.to + action.label}
                          variant={
                            action.tone === 'primary'
                              ? 'default'
                              : action.tone === 'destructive'
                                ? 'destructive'
                                : 'outline'
                          }
                          disabled={transition.isPending}
                          onClick={() => (action.requiresRemarks ? setPending(action) : run(action))}
                        >
                          {action.label}
                        </Button>
                      ))
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
