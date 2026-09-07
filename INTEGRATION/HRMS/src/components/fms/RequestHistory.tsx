import { APPROVAL_ACTION_LABEL, type RequestType } from '@/lib/financeRequests'
import { formatBusinessDateTime } from '@/lib/dates'
import { useRequestParticipants, useRequestTrail } from '@/hooks/useFinanceRequests'

/**
 * What a workflow event is called, in the words of the screen it happened on.
 *
 * 'validated' is the Finance Staff step, and on a purchase "Validated" is
 * exactly right. On a reimbursement the button that writes it says "Forward for
 * approval", so calling the resulting trail entry "Validated" makes somebody
 * check whether they pressed the wrong thing. Same event, same row, named after
 * the act the person performed.
 *
 * The fallback humanises rather than printing the token: a status nobody has
 * labelled yet should read as words, not as an enum leaking onto the page.
 */
export function historyActionLabel(action: string, type?: RequestType): string {
  if (type === 'reimbursement' && action === 'validated') return 'Forwarded for approval'
  const known = APPROVAL_ACTION_LABEL[action]
  if (known) return known
  const words = action.replace(/_/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Updated'
}

/**
 * The approval trail: who did what to this request, and when.
 *
 * finance_request_approvals is append-only and written only by
 * transition_finance_request, so this is the whole story and reading it changes
 * nothing. RLS decides who may: finance_request_approvals_read defers to
 * can_read_finance_request, which is the requester or a finance role — so the
 * Finance Manager gets the history of a claim they are being asked to approve
 * without anybody being granted anything new.
 *
 * This lived inside RequestDetail until F7 acceptance found the Finance Manager
 * approving RB-2026-0001 with no way to see that Marc had submitted it and
 * Alice had forwarded it. /fms/reimbursements is its own review surface and the
 * trail had never been wired into it — the same shape of defect as the missing
 * classification controls, and the same fix: extract the one that exists rather
 * than write a second one.
 *
 * Names come from finance_request_participants, a two-column RPC, because
 * Finance cannot read profiles and should not start being able to.
 */
export function RequestHistory({
  requestId,
  type,
}: {
  requestId: string | null | undefined
  /** Only to name the Finance Staff step correctly. */
  type?: RequestType
}) {
  const { data: trail = [], isLoading, isError, error } = useRequestTrail(requestId ?? undefined)
  const { data: names, isLoading: namesLoading } = useRequestParticipants()

  function actorName(actorId: string | null): string {
    const known = actorId ? names?.get(actorId) : undefined
    if (known) return known
    // Still arriving, versus arrived and not there. The second means the
    // account has since been removed, which is worth saying plainly rather
    // than leaving a row that looks half-rendered.
    if (namesLoading) return '…'
    return 'Unknown user'
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold text-foreground">History</p>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {isLoading ? (
          <p className="p-3 text-sm text-muted-foreground">Loading the history…</p>
        ) : isError ? (
          // Said rather than hidden. A trail that fails to load looks exactly
          // like a request nothing has happened to, and those are very
          // different things to approve against.
          <p className="p-3 text-sm text-destructive">
            The history could not be loaded, so this may not be the whole story.
            {error instanceof Error && error.message ? ` ${error.message}` : ''}
          </p>
        ) : trail.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            Nothing has happened to this request yet.
          </p>
        ) : (
          trail.map((entry) => (
            <div key={entry.id} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {historyActionLabel(entry.action, type)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {actorName(entry.actor_id)}
                  {entry.remarks ? ` — ${entry.remarks}` : ''}
                </p>
              </div>
              <p className="shrink-0 text-xs text-muted-foreground">
                {formatBusinessDateTime(entry.created_at) ?? ''}
              </p>
            </div>
          ))
        )}
      </div>
      {trail.length > 0 && (
        <p className="text-xs text-muted-foreground">Times are Philippine Standard Time.</p>
      )}
    </div>
  )
}
