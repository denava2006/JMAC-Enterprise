import { Info } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useSetPositionEntitlement } from '@/hooks/useWorkforce'
import { POS_ROLE_LABEL, type PositionEntitlements } from '@/lib/workforce'
import { POS_ROLES } from '@/lib/posAccess'

/**
 * What a job makes somebody eligible to hold.
 *
 * This is the configuration that replaced comparing position titles. Nothing
 * here grants access: an employee with an eligible position and no assignment
 * still has none. It decides who may be *offered* on the POS Access screen, and
 * who the database will accept a grant for.
 *
 * Employee Self-Service has no switch. Every employee has it, and an
 * entitlement checkbox for the baseline would imply it could be taken away.
 */
export function PositionEligibilityDialog({
  position,
  onClose,
}: {
  position: PositionEntitlements | null
  onClose: () => void
}) {
  const setEntitlement = useSetPositionEntitlement()

  if (!position) return null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{position.positionTitle}</DialogTitle>
          <DialogDescription>
            {position.departmentName} · what this job makes an employee eligible to hold.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Eligibility is not access. Somebody in this position still needs an assignment before they can do
              anything — but nobody outside it can be given one. Moving an employee out of this position closes
              their POS access straight away.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Point of Sale
            </Label>
            {POS_ROLES.map((role) => (
              <div
                key={role}
                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{POS_ROLE_LABEL[role]}</p>
                  <p className="text-xs text-muted-foreground">
                    {role === 'manager'
                      ? 'Runs a branch: stock, catalogue, transactions, reports and requests.'
                      : 'Works a till and looks up their own sales.'}
                  </p>
                </div>
                <Switch
                  checked={position.pos.includes(role)}
                  aria-label={`${POS_ROLE_LABEL[role]} eligibility for ${position.positionTitle}`}
                  disabled={setEntitlement.isPending}
                  onCheckedChange={(granted) =>
                    setEntitlement.mutate({
                      positionId: position.positionId,
                      system: 'pos',
                      roleCode: role,
                      granted,
                    })
                  }
                />
              </div>
            ))}
          </div>

          {/* HRMS and Finance eligibility is recorded but not yet enforced --
              Phase 9B and 9C. Showing it read-only keeps the model legible
              instead of pretending POS is the only system. */}
          <div className="flex flex-col gap-2">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Other systems
            </Label>
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3">
              {position.hrms.length === 0 && position.fms.length === 0 ? (
                <span className="text-xs text-muted-foreground">None configured.</span>
              ) : (
                <>
                  {position.hrms.map((code) => (
                    <Badge key={`hrms-${code}`} variant="secondary">
                      HRMS {code}
                    </Badge>
                  ))}
                  {position.fms.map((code) => (
                    <Badge key={`fms-${code}`} variant="secondary">
                      Finance {code}
                    </Badge>
                  ))}
                </>
              )}
              <span className="w-full text-xs text-muted-foreground">
                Recorded for later phases. Only POS eligibility is enforced today.
              </span>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Employee self-service needs no entitlement — every employee has it.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
