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
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = React.useState('')

  React.useEffect(() => {
    if (open) setReason('')
  }, [open])

  const blank = reason.trim().length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reason-text">
            Reason <span className="text-destructive">*</span>
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
