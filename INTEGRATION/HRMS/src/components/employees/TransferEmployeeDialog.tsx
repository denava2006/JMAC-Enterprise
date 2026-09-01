import * as React from 'react'
import { ArrowRight, TriangleAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { useDepartments } from '@/hooks/useDepartments'
import { usePositions } from '@/hooks/usePositions'
import { useUpdateEmployee, type Employee } from '@/hooks/useEmployees'
import { usePositionEntitlements } from '@/hooks/useWorkforce'
import { entitlementChips } from '@/lib/workforce'
import { toast } from '@/components/ui/sonner'

/**
 * Move an employee to a different job.
 *
 * Department and position used to sit in the ordinary "Edit employment
 * information" form, one dropdown away from a salary change. They are not the
 * same kind of edit: a position decides what systems its holder may be
 * assigned to, so changing it silently closes POS access that somebody was
 * relying on that morning. Correcting a pay grade should not live next to a
 * control that can do that.
 *
 * So this is its own action, it asks why, and it says plainly what will happen
 * before it happens. The database enforces the rest either way -- a position
 * must belong to its department, and losing eligibility closes access on its
 * own -- but an Administrator should not learn that from the consequences.
 */
export function TransferEmployeeDialog({
  open,
  onOpenChange,
  employee,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  employee: Employee
}) {
  const { data: departments } = useDepartments()
  const { data: positions } = usePositions()
  const updateEmployee = useUpdateEmployee()
  const { data: entitlements } = usePositionEntitlements()

  const [departmentId, setDepartmentId] = React.useState('')
  const [positionId, setPositionId] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    if (open) {
      setDepartmentId(employee.department_id ?? '')
      setPositionId(employee.position_id ?? '')
      setReason('')
      setErrors({})
    }
  }, [open, employee])

  // Only positions filed under the chosen department. The database refuses any
  // other pairing (POSITION_DEPARTMENT_MISMATCH), so offering them would be
  // offering a guaranteed failure.
  const filteredPositions = React.useMemo(
    () => (positions ?? []).filter((p) => p.department_id === departmentId),
    [positions, departmentId]
  )

  const fromDepartment = employee.departments?.name ?? '—'
  const fromPosition = employee.positions?.title ?? '—'
  const toDepartment = departments?.find((d) => d.id === departmentId)?.name ?? '—'
  const toPosition = (positions ?? []).find((p) => p.id === positionId)?.title ?? '—'

  const unchanged = departmentId === employee.department_id && positionId === employee.position_id

  const onSubmit = () => {
    const next: Record<string, string> = {}
    if (!departmentId) next.departmentId = 'Choose a department.'
    if (!positionId) next.positionId = 'Choose a position.'
    if (!reason.trim()) next.reason = 'Say why this employee is moving.'
    if (unchanged) next.positionId = 'This is the job they already hold.'
    if (Object.keys(next).length > 0) {
      setErrors(next)
      return
    }

    updateEmployee.mutate(
      {
        id: employee.id,
        values: { department_id: departmentId, position_id: positionId },
        notes: `${fromDepartment} / ${fromPosition} → ${toDepartment} / ${toPosition}. ${reason.trim()}`,
      },
      {
        onSuccess: () => {
          onOpenChange(false)

          // A transfer into a privileged position is the moment people expect
          // access to appear, and it deliberately does not. Saying so here --
          // once, at the moment of the change -- is the difference between a
          // security model and an apparent bug.
          const entry = (entitlements ?? []).find((e) => e.positionId === positionId)
          const chips = entry ? entitlementChips(entry) : []
          if (chips.length > 0) {
            toast.info(
              `This position is eligible for ${chips.map((c) => c.label).join(' and ')} access. ` +
                'System access must be granted separately.',
              { duration: 8000 }
            )
          }
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transfer or promote</DialogTitle>
          <DialogDescription>
            Move {employee.first_name} {employee.last_name} to a different job. Pay is changed separately, under Edit
            employment information.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <span className="text-muted-foreground">
              {fromDepartment} · {fromPosition}
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium text-foreground">
              {toDepartment} · {toPosition}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>
                Department <span className="text-destructive">*</span>
              </Label>
              <Select
                value={departmentId}
                onValueChange={(v) => {
                  setDepartmentId(v)
                  setPositionId('')
                }}
              >
                <SelectTrigger invalid={!!errors.departmentId} aria-label="Department">
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  {departments?.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.departmentId && <p className="text-xs text-destructive">{errors.departmentId}</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>
                Position <span className="text-destructive">*</span>
              </Label>
              <Select value={positionId} onValueChange={setPositionId} disabled={!departmentId}>
                <SelectTrigger invalid={!!errors.positionId} aria-label="Position">
                  <SelectValue placeholder="Select position" />
                </SelectTrigger>
                <SelectContent>
                  {filteredPositions.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.positionId && <p className="text-xs text-destructive">{errors.positionId}</p>}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="transfer_reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="transfer_reason"
              rows={2}
              value={reason}
              placeholder="e.g. Promoted to POS Manager for Cavite Branch"
              onChange={(e) => {
                setReason(e.target.value)
                if (errors.reason) setErrors((prev) => ({ ...prev, reason: '' }))
              }}
            />
            {errors.reason ? (
              <p className="text-xs text-destructive">{errors.reason}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Kept on the employee&apos;s history alongside the move.
              </p>
            )}
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">
              A job decides which systems its holder may be assigned to. If this employee holds POS access that the
              new position is not eligible for, that access closes immediately and will need granting again — it is
              not restored by moving them back.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" loading={updateEmployee.isPending} onClick={onSubmit}>
            Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
