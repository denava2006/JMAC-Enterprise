import { Info } from 'lucide-react'
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
import { ELIGIBILITY_SYSTEMS, type PositionEntitlements } from '@/lib/workforce'
import type { EntitlementSystem } from '@/lib/enums'

/**
 * What a job makes somebody eligible to hold.
 *
 * This is the configuration that replaced comparing position titles. Nothing
 * here grants access: an employee with an eligible position and no assignment
 * still has none. It decides who may be *offered* on the POS Access screen, and
 * who the database will accept a grant for.
 *
 * HRMS and POS are shown with equal weight. An earlier version rendered POS as
 * the only real section and pushed HRMS into a read-only "Other systems" box,
 * which said "None configured" for every position and made HR eligibility look
 * like an afterthought rather than something an Administrator sets here.
 *
 * Employee Self-Service has no switch. Every employee has it, and an
 * entitlement switch for the baseline would imply it could be taken away.
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

  const held = (system: EntitlementSystem): string[] =>
    system === 'hrms' ? position.hrms : system === 'pos' ? position.pos : position.fms

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
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

          {ELIGIBILITY_SYSTEMS.map((group) => (
            <div key={group.system} className="flex flex-col gap-2">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </Label>

              {group.available ? (
                group.options.map((role) => (
                  <div
                    key={role.value}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">{role.label}</p>
                      <p className="text-xs text-muted-foreground">{role.description}</p>
                    </div>
                    <Switch
                      checked={held(group.system).includes(role.value)}
                      aria-label={`${role.label} eligibility for ${position.positionTitle}`}
                      disabled={setEntitlement.isPending}
                      onCheckedChange={(granted) =>
                        setEntitlement.mutate({
                          positionId: position.positionId,
                          system: group.system,
                          roleCode: role.value,
                          granted,
                        })
                      }
                    />
                  </div>
                ))
              ) : (
                // Finance is in the platform's scope but nothing reads FMS
                // entitlements yet. A switch that changes nothing would be a
                // promise the database does not keep.
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                  Planned — not configurable yet.
                </p>
              )}
            </div>
          ))}

          {/* HRMS eligibility is recorded and configurable, but HR authorization
              still runs on profiles.role until Phase 9B links accounts to
              positions. Saying so is cheaper than letting an Administrator
              believe a toggle here changes who can sign in to HR today. */}
          <p className="text-xs text-muted-foreground">
            POS eligibility is enforced today. HR eligibility is recorded here and takes effect when HR
            authorization moves onto positions.
          </p>

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
