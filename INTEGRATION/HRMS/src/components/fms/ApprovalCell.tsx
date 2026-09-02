import { Badge } from '@/components/ui/badge'

/**
 * Where a proposed record stands, and why that matters on this row.
 *
 * Display only. Whether the viewer may do anything about it is a separate
 * question the page asks financeCan, and the database answers again.
 */
export function ApprovalBadge({ status }: { status: string | null | undefined }) {
  if (status === 'pending_approval') {
    return <Badge variant="warning">Awaiting approval</Badge>
  }
  if (status === 'rejected') {
    return <Badge variant="destructive">Rejected</Badge>
  }
  return <Badge variant="outline">Approved</Badge>
}

/**
 * A one-line explanation for the maker, on a record that is not yet in force.
 *
 * Without this, a vendor simply fails to appear in the purchase-order picker
 * and the reason is invisible -- which is the kind of silence that gets
 * diagnosed as "the system is broken" rather than "somebody has to approve it".
 */
export function PendingApprovalNote({
  status,
  noun,
  reviewNote,
}: {
  status: string | null | undefined
  noun: string
  reviewNote?: string | null
}) {
  if (status === 'pending_approval') {
    return (
      <p className="text-xs text-muted-foreground">
        Waiting for a Finance Manager to approve it. Until then this {noun} cannot be used on a
        purchase order.
      </p>
    )
  }
  if (status === 'rejected') {
    return (
      <p className="text-xs text-destructive">
        Rejected{reviewNote ? `: ${reviewNote}` : '.'} Edit it to put it forward again.
      </p>
    )
  }
  return null
}
