import * as React from 'react'
import { Button } from '@/components/ui/button'
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

/**
 * Ask why, before something stops.
 *
 * Every business transition that cancels, returns or refuses takes a reason,
 * and the database refuses a blank one -- so this exists to ask for it before
 * the round trip rather than to soften the rule. Closing this dialog transitions
 * nothing and is not a decision, which is why the escape route is plain Cancel
 * and costs nothing.
 *
 * The reason is shown in history afterwards, so the placeholder asks for the
 * thing a reader will want six weeks later: what actually happened.
 */
export function ReasonDialog({
  open,
  title,
  description,
  placeholder,
  confirmLabel,
  destructive = true,
  pending = false,
  label = 'Reason',
  optional = false,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  placeholder?: string
  confirmLabel: string
  destructive?: boolean
  pending?: boolean
  /** What this text is, for the person writing it. A refusal takes a reason; a
   *  step forward takes a note, and calling both "Reason" made forwarding read
   *  like refusing. */
  label?: string
  /**
   * Whether the transition actually requires it.
   *
   * Stopping something takes an explanation and the workflow demands one. Moving
   * something on does not — transition_finance_request accepts a null remark for
   * a validation, and the requests queue has always forwarded without asking. The
   * reimbursement queue asked anyway, with a rejection placeholder, so Finance
   * Staff had to invent a grievance to pass a claim along.
   */
  optional?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = React.useState('')

  React.useEffect(() => {
    if (open) setReason('')
  }, [open])

  const blank = !optional && reason.trim().length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reason-text">
            {label}{' '}
            {optional ? (
              <span className="text-muted-foreground">(optional)</span>
            ) : (
              <span className="text-destructive">*</span>
            )}
          </Label>
          <Textarea
            id="reason-text"
            rows={3}
            autoFocus
            value={reason}
            placeholder={placeholder ?? 'What happened, in a sentence.'}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            This is kept with the record and shown in its history.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={blank || pending}
            onClick={() => onConfirm(reason.trim())}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
