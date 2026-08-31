import * as React from 'react'
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
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { MoneyInput } from '@/components/MoneyInput'
import { useSalaryGrades } from '@/hooks/useSalaryGrades'
import { useWorkSchedules } from '@/hooks/useWorkSchedules'
import { useUpdateEmployee, type Employee } from '@/hooks/useEmployees'
import { EMPLOYMENT_TYPE_LABEL } from '@/lib/jobPostingLabels'
import { DEFAULT_CURRENCY } from '@/lib/currency'
import { EMPLOYMENT_STATUS_LABEL, SELECTABLE_EMPLOYMENT_STATUSES } from '@/lib/employeeLabels'
import type { EmploymentStatus } from '@/lib/enums'

export function EditEmploymentInfoDialog({
  open,
  onOpenChange,
  employee,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  employee: Employee
}) {
  const { data: salaryGrades } = useSalaryGrades()
  const { data: workSchedules } = useWorkSchedules()
  const updateEmployee = useUpdateEmployee()

  // An employee hired through recruitment carries the type from the job posting
  // they applied to; it isn't HR's to change here. Someone added directly has no
  // posting behind them, so it stays editable for them.
  const typeIsInherited = !!employee.application_id

  const [employmentType, setEmploymentType] = React.useState<'regular' | 'part_time'>('regular')
  const [employmentStatus, setEmploymentStatus] = React.useState<EmploymentStatus>('active')
  const [salaryGradeId, setSalaryGradeId] = React.useState('')
  const [basicSalary, setBasicSalary] = React.useState('')
  const [hireDate, setHireDate] = React.useState('')
  const [workScheduleId, setWorkScheduleId] = React.useState('')
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    if (open) {
      setEmploymentType(employee.employment_type)
      setEmploymentStatus(employee.employment_status)
      setSalaryGradeId(employee.salary_grade_id ?? '')
      setBasicSalary(String(employee.basic_salary))
      setHireDate(employee.hire_date)
      setWorkScheduleId(employee.work_schedule_id ?? '')
      setErrors({})
    }
  }, [open, employee])

  // Only resources matching the employee's type can be assigned — the database
  // refuses the pairing, so the options are narrowed to what will be accepted.
  const assignableGrades = React.useMemo(
    () => (salaryGrades ?? []).filter((g) => g.employment_type === employmentType),
    [salaryGrades, employmentType]
  )
  const assignableSchedules = React.useMemo(
    () => (workSchedules ?? []).filter((s) => s.employment_type === employmentType),
    [workSchedules, employmentType]
  )

  const onSubmit = () => {
    const nextErrors: Record<string, string> = {}
    if (!basicSalary || Number(basicSalary) <= 0) nextErrors.basicSalary = 'Basic salary is required.'
    if (!hireDate) nextErrors.hireDate = 'Date hired is required.'
    if (!workScheduleId) nextErrors.workScheduleId = 'Work schedule is required.'
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }

    updateEmployee.mutate(
      {
        id: employee.id,
        values: {
          employment_type: employmentType,
          employment_status: employmentStatus,
          salary_grade_id: salaryGradeId || null,
          basic_salary: Number(basicSalary),
          currency: DEFAULT_CURRENCY,
          hire_date: hireDate,
          work_schedule_id: workScheduleId,
        },
      },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Employment Information</DialogTitle>
          <DialogDescription>
            Pay, standing and schedule. To move this employee to a different job, use Transfer or promote.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Read-only. A position decides which systems its holder may be
              assigned to, so moving somebody is a deliberate act with its own
              action -- not a dropdown beside their salary. */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <div className="text-sm">
              <p className="font-medium text-foreground">
                {employee.departments?.name ?? '\u2014'} \u00b7 {employee.positions?.title ?? '\u2014'}
              </p>
              <p className="text-xs text-muted-foreground">
                Change this under Transfer or promote.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Employment Type</Label>
              <Select
                value={employmentType}
                disabled={typeIsInherited}
                onValueChange={(v) => {
                  setEmploymentType(v as 'regular' | 'part_time')
                  // Whatever was picked under the old type no longer applies.
                  setSalaryGradeId('')
                  setWorkScheduleId('')
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {typeIsInherited && (
                <p className="text-xs text-muted-foreground">Set by the job posting this employee was hired through.</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Employment Status</Label>
              <Select value={employmentStatus} onValueChange={(v) => setEmploymentStatus(v as EmploymentStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SELECTABLE_EMPLOYMENT_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {EMPLOYMENT_STATUS_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Salary Grade (optional)</Label>
              <Select value={salaryGradeId} onValueChange={setSalaryGradeId}>
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {assignableGrades.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.grade_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_hire_date">Date Hired</Label>
              <Input id="edit_hire_date" type="date" invalid={!!errors.hireDate} value={hireDate} onChange={(e) => setHireDate(e.target.value)} />
              {errors.hireDate && <p className="text-xs text-destructive">{errors.hireDate}</p>}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Work Schedule</Label>
            <Select
              value={workScheduleId}
              onValueChange={(v) => {
                setWorkScheduleId(v)
                if (errors.workScheduleId) setErrors((prev) => ({ ...prev, workScheduleId: '' }))
              }}
            >
              <SelectTrigger invalid={!!errors.workScheduleId}>
                <SelectValue placeholder="Select a shift" />
              </SelectTrigger>
              <SelectContent>
                {assignableSchedules.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                    {s.is_default ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.workScheduleId ? (
              <p className="text-xs text-destructive">{errors.workScheduleId}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Changing this affects future attendance only — records already logged keep the figures calculated under
                the old shift.
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit_basic_salary">Basic Salary</Label>
              <MoneyInput id="edit_basic_salary" invalid={!!errors.basicSalary} value={basicSalary} onValueChange={setBasicSalary} />
              {errors.basicSalary && <p className="text-xs text-destructive">{errors.basicSalary}</p>}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" loading={updateEmployee.isPending} onClick={onSubmit}>
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
