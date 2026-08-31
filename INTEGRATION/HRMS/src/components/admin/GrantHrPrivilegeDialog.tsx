import * as React from 'react'
import { Info } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import {
  useCreateHrAccountForEmployee,
  useGrantHrPrivilege,
  useHrCandidates,
} from '@/hooks/useHrPrivilege'
import { ROLE_LABEL } from '@/lib/roles'

/**
 * Give an employee HR privilege.
 *
 * The old dialog asked for a full name, an email and a role, and created a
 * standalone HR login from them. That produced accounts with no employee, no
 * department and no position — nothing that could ever make the access wrong.
 *
 * Now the Administrator picks a **person**. The list comes from the database
 * and contains only employees whose position confers an HR role, so IT Support
 * and Cashier never appear; the roles offered are the ones that employee's own
 * position confers, so an HR Staff cannot be made an HR Manager here. The
 * server re-checks both regardless of what this sends.
 */
export function GrantHrPrivilegeDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data: candidates, isLoading } = useHrCandidates()
  const grantExisting = useGrantHrPrivilege()
  const provision = useCreateHrAccountForEmployee()

  const [employeeId, setEmployeeId] = React.useState('')
  const [hrRole, setHrRole] = React.useState('')

  React.useEffect(() => {
    if (open) {
      setEmployeeId('')
      setHrRole('')
    }
  }, [open])

  const chosen = (candidates ?? []).find((c) => c.employee_id === employeeId)

  // Only what this employee's position actually confers.
  const offeredRoles = chosen?.eligible_roles ?? []

  React.useEffect(() => {
    if (chosen && offeredRoles.length === 1) setHrRole(offeredRoles[0])
    else setHrRole('')
  }, [employeeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const pending = grantExisting.isPending || provision.isPending

  const onSubmit = () => {
    if (!chosen || !hrRole) return
    // An employee who already has a login keeps it: the same account is
    // upgraded. Only somebody with no account at all needs one created.
    if (chosen.has_account && chosen.profile_id) {
      grantExisting.mutate(
        { profileId: chosen.profile_id, hrRole },
        { onSuccess: () => onOpenChange(false) }
      )
    } else {
      provision.mutate({ employeeId: chosen.employee_id, hrRole }, { onSuccess: () => onOpenChange(false) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Grant HR privilege</DialogTitle>
          <DialogDescription>
            HR authority follows the job. Only employees whose position confers an HR role can be given one.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>
              Employee <span className="text-destructive">*</span>
            </Label>
            <Select value={employeeId} onValueChange={setEmployeeId} disabled={isLoading}>
              <SelectTrigger aria-label="Employee">
                <SelectValue placeholder={isLoading ? 'Loading…' : 'Select an eligible employee'} />
              </SelectTrigger>
              <SelectContent>
                {(candidates ?? []).map((c) => (
                  <SelectItem key={c.employee_id} value={c.employee_id}>
                    {c.full_name} &mdash; {c.position_title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!isLoading && (candidates ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nobody is eligible. HR eligibility comes from a position&apos;s System access, configured under
                Positions.
              </p>
            )}
          </div>

          {chosen && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-foreground">{chosen.full_name}</span>
                <Badge variant="outline" className="bg-card font-normal">
                  {chosen.department_name} · {chosen.position_title}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {chosen.has_account
                  ? 'They already have a login. It will be upgraded in place — no second account is created.'
                  : 'They have no login yet. One will be created and a setup link emailed to them.'}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label>
              HR role <span className="text-destructive">*</span>
            </Label>
            <Select value={hrRole} onValueChange={setHrRole} disabled={!chosen}>
              <SelectTrigger aria-label="HR role">
                <SelectValue placeholder={chosen ? 'Select a role' : 'Choose an employee first'} />
              </SelectTrigger>
              <SelectContent>
                {offeredRoles.map((role) => (
                  <SelectItem key={role} value={role}>
                    {ROLE_LABEL[role as keyof typeof ROLE_LABEL] ?? role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {chosen && offeredRoles.length === 1 && (
              <p className="text-xs text-muted-foreground">
                This is the only HR role {chosen.position_title} confers.
              </p>
            )}
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Privilege closes by itself if they are transferred out, leave, or the position stops conferring the
              role. It does not come back on its own — a returning employee must be granted again.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" loading={pending} disabled={!chosen || !hrRole} onClick={onSubmit}>
            Grant privilege
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
