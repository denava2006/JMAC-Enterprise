import * as React from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { ColumnDef } from '@tanstack/react-table'
import { Info, MoreHorizontal, Plus, ShieldCheck, Store } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useBranches } from '@/hooks/useBranches'
import { useEligiblePosEmployees, useNoncompliantAssignments } from '@/hooks/useWorkforce'
import { AlertTriangle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import {
  type PosAssignment,
  useGrantPosAccess,
  usePosAssignments,
  useRevokePosAccess,
} from '@/hooks/usePosAccess'
import {
  ASSIGNMENT_STATUS_LABEL,
  POS_ROLES,
  POS_ROLE_LABEL,
  STATUS_FILTERS,
  STATUS_FILTER_LABEL,
  countByStatus,
  filterByStatus,
  type StatusFilter,
} from '@/lib/posAccess'
import { ROLE_LABEL } from '@/lib/roles'

/**
 * POS Access lives in the HR Workspace, not in the POS sidebar.
 *
 * Deciding who may work a till is account administration, which this system
 * already treats as the Administrator's job (HR Accounts, Branches). A POS
 * Manager runs a branch; they do not hand out access to it.
 */

const grantSchema = z.object({
  profileId: z.string().min(1, 'Choose who this is for'),
  branchId: z.string().min(1, 'Choose a branch'),
  posRole: z.enum(POS_ROLES),
})
type GrantFormValues = z.infer<typeof grantSchema>

/** What a re-grant starts from: the revoked row the Administrator clicked. */
export interface GrantPrefill {
  profileId: string
  branchId: string
  posRole: GrantFormValues['posRole']
}

/**
 * Branch -> POS Role -> Eligible Employee.
 *
 * The order matters. Before Phase 9A this asked for a person first and offered
 * every assignable account, which is how an IT Support engineer came to hold
 * POS Manager. Now the branch and the role are chosen first, and the candidate
 * list comes from `get_eligible_pos_employees` -- a database RPC returning only
 * people whose current job configures them for that role.
 *
 * The list is not fetched-then-filtered here. A list filtered in React is a list
 * that can be unfiltered in React, and the database refuses an ineligible grant
 * regardless of what the client sends.
 */
function GrantAccessDialog({
  open,
  onOpenChange,
  prefill,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  prefill: GrantPrefill | null
}) {
  const grant = useGrantPosAccess()
  const { data: branches } = useBranches()

  const {
    control,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<GrantFormValues>({ resolver: zodResolver(grantSchema) })

  React.useEffect(() => {
    if (!open) return
    reset({
      profileId: prefill?.profileId ?? '',
      branchId: prefill?.branchId ?? '',
      posRole: prefill?.posRole ?? 'cashier',
    })
  }, [open, prefill, reset])

  const selectedBranchId = watch('branchId')
  const selectedRole = watch('posRole')
  const selectedProfileId = watch('profileId')

  const { data: candidates, isLoading: candidatesLoading } = useEligiblePosEmployees(
    selectedBranchId || undefined,
    selectedRole
  )
  const people = candidates ?? []
  const availableBranches = (branches ?? []).filter((b) => b.is_active)

  // Changing the branch or the role changes who is eligible, so somebody chosen
  // under the previous combination must not silently carry over.
  React.useEffect(() => {
    if (selectedProfileId && !people.some((person) => person.profile_id === selectedProfileId)) {
      setValue('profileId', '')
    }
  }, [people, selectedProfileId, setValue])

  const onSubmit = async (values: GrantFormValues) => {
    await grant.mutateAsync(values)
    onOpenChange(false)
  }

  const selectedPerson = people.find((person) => person.profile_id === selectedProfileId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{prefill ? 'Grant POS access again' : 'Grant POS access'}</DialogTitle>
          <DialogDescription>
            {prefill
              ? 'This creates a new assignment. The revoked one stays on record.'
              : 'Only employees whose job makes them eligible for the role can be chosen.'}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label>
              Branch <span className="text-destructive">*</span>
            </Label>
            <Controller
              control={control}
              name="branchId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger aria-label="Branch">
                    <SelectValue placeholder="Choose a branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBranches.map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.branchId && <p className="text-xs text-destructive">{errors.branchId.message}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>POS role</Label>
            <Controller
              control={control}
              name="posRole"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger aria-label="POS role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POS_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {POS_ROLE_LABEL[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              Access applies to the chosen branch only. To change someone's role later, revoke this assignment and
              grant a new one.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>
              Employee <span className="text-destructive">*</span>
            </Label>
            <Controller
              control={control}
              name="profileId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={!selectedBranchId}>
                  <SelectTrigger aria-label="Employee">
                    <SelectValue
                      placeholder={
                        selectedBranchId ? 'Choose an eligible employee' : 'Choose a branch first'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {people.map((person) => (
                      <SelectItem key={person.profile_id} value={person.profile_id}>
                        {person.full_name} &mdash; {person.position_title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.profileId && <p className="text-xs text-destructive">{errors.profileId.message}</p>}
            {selectedBranchId && !candidatesLoading && people.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nobody is eligible for POS {POS_ROLE_LABEL[selectedRole]} here. Eligibility comes from an
                employee&apos;s position &mdash; configure it on the Positions page, or check they are not
                already assigned at this branch.
              </p>
            )}
            {selectedPerson && (
              <p className="text-xs text-muted-foreground">
                {selectedPerson.department_name} &middot; {selectedPerson.position_title}
              </p>
            )}
          </div>


          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              Grant access
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}


/**
 * Assignments that no longer authorize.
 *
 * A grant made before Phase 9A -- or one whose holder has since been
 * transferred -- keeps its row but stops working. Without this panel that would
 * be an invisible outage; with it, an Administrator can see exactly who is
 * affected and why, and close or re-grant deliberately.
 *
 * Only ACTIVE assignments appear. Closed history is not a problem to fix.
 */
function NoncompliantPanel() {
  const { data: rows, isLoading } = useNoncompliantAssignments()
  const items = rows ?? []

  if (isLoading || items.length === 0) return null

  return (
    <Card className="border-warning/40">
      <CardContent className="flex flex-col gap-3 py-5">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <h3 className="text-sm font-semibold text-foreground">
            {items.length} assignment{items.length === 1 ? '' : 's'} no longer authorize
          </h3>
        </div>
        <p className="text-xs text-muted-foreground">
          These accounts still hold an assignment, but their current job does not make them eligible for it, so
          the database refuses them access. Nothing was deleted &mdash; revoke them, or move the employee into an
          eligible position.
        </p>
        <div className="flex flex-col gap-2">
          {items.map((row) => (
            <div
              key={row.assignment_id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border p-3"
            >
              <span className="text-sm font-medium text-foreground">{row.full_name}</span>
              <Badge variant="secondary">
                {row.branch_name} &middot; {POS_ROLE_LABEL[row.pos_role]}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {row.department_name} &middot; {row.position_title}
              </span>
              <span className="w-full text-xs text-warning">{row.reason}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export default function PosAccessPage() {
  const { data, isLoading } = usePosAssignments()
  const revoke = useRevokePosAccess()
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('active')
  const [grantOpen, setGrantOpen] = React.useState(false)
  const [prefill, setPrefill] = React.useState<GrantPrefill | null>(null)
  const [revoking, setRevoking] = React.useState<PosAssignment | null>(null)

  const assignments = data ?? []
  const counts = countByStatus(assignments)
  const rows = filterByStatus(assignments, statusFilter)

  const openGrant = (next: GrantPrefill | null) => {
    setPrefill(next)
    setGrantOpen(true)
  }

  const columns: ColumnDef<PosAssignment>[] = [
    {
      // Search-only: the visible columns hold nested objects, which the table's
      // default search would stringify to "[object Object]".
      id: '_search',
      accessorFn: (row) =>
        [row.profile?.full_name, row.profile?.email, row.branch?.name, POS_ROLE_LABEL[row.pos_role]]
          .filter(Boolean)
          .join(' '),
    },
    {
      id: 'person',
      header: 'Person',
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">{row.original.profile?.full_name ?? 'Unknown account'}</span>
          <span className="text-xs text-muted-foreground">{row.original.profile?.email}</span>
        </div>
      ),
    },
    {
      id: 'hr_role',
      header: 'HR role',
      cell: ({ row }) => {
        const role = row.original.profile?.role
        if (!role) return null
        return (
          <div className="flex items-center gap-2">
            <Badge variant="outline">{ROLE_LABEL[role]}</Badge>
            {row.original.profile?.status === 'inactive' && <Badge variant="muted">Account inactive</Badge>}
          </div>
        )
      },
    },
    {
      id: 'branch',
      header: 'Branch',
      cell: ({ row }) => (
        <span className="text-foreground">{row.original.branch?.name ?? 'Unknown branch'}</span>
      ),
    },
    {
      id: 'pos_role',
      header: 'POS role',
      cell: ({ row }) => (
        <Badge variant={row.original.pos_role === 'manager' ? 'secondary' : 'outline'}>
          {row.original.pos_role === 'manager' && <ShieldCheck className="h-3 w-3" />}
          {POS_ROLE_LABEL[row.original.pos_role]}
        </Badge>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={row.original.status === 'active' ? 'success' : 'muted'}>
          {ASSIGNMENT_STATUS_LABEL[row.original.status]}
        </Badge>
      ),
    },
    {
      id: 'granted',
      header: 'Granted',
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="text-foreground">{new Date(row.original.created_at).toLocaleDateString()}</span>
          {row.original.granted_by?.full_name && (
            <span className="text-xs text-muted-foreground">by {row.original.granted_by.full_name}</span>
          )}
        </div>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Assignment actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.original.status === 'active' ? (
              <DropdownMenuItem destructive onClick={() => setRevoking(row.original)}>
                Revoke access
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onClick={() =>
                  openGrant({
                    profileId: row.original.profile_id,
                    branchId: row.original.branch_id,
                    posRole: row.original.pos_role,
                  })
                }
              >
                Grant again
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground">POS Access</h2>
        <p className="text-sm text-muted-foreground">
          Who may open the Point of Sale, and at which branch. Access is granted to an existing Harmony Suite account —
          nobody gets a second login for the till.
        </p>
      </div>

      <NoncompliantPanel />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Administrators reach every branch's POS through their role, so they are never listed here and cannot be
          assigned a branch. An HR role never grants POS access on its own — only an assignment below does.
        </p>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        searchColumn="_search"
        searchPlaceholder="Search by name, email or branch..."
        emptyTitle={statusFilter === 'inactive' ? 'No revoked assignments' : 'No POS assignments yet'}
        emptyDescription={
          statusFilter === 'active'
            ? 'Grant access to give someone a till at a branch.'
            : undefined
        }
        toolbarAction={
          <div className="flex items-center gap-2">
            {/* Three buttons rather than a dropdown: all three counts stay
                visible, so the revoked history is discoverable instead of
                hidden behind a click. */}
            <div
              role="group"
              aria-label="Filter by status"
              className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
            >
              {STATUS_FILTERS.map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={statusFilter === value ? 'secondary' : 'ghost'}
                  aria-pressed={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                >
                  {STATUS_FILTER_LABEL[value]} ({counts[value]})
                </Button>
              ))}
            </div>
            <Button onClick={() => openGrant(null)}>
              <Plus className="h-4 w-4" />
              Grant access
            </Button>
          </div>
        }
      />

      <GrantAccessDialog
        open={grantOpen}
        onOpenChange={(open) => {
          setGrantOpen(open)
          if (!open) setPrefill(null)
        }}
        prefill={prefill}
      />

      <AlertDialog open={!!revoking} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke {revoking?.profile?.full_name}'s access at {revoking?.branch?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They lose the POS immediately. The assignment stays on record as revoked, and you can grant it again
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revoking) revoke.mutate(revoking)
                setRevoking(null)
              }}
            >
              Revoke access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Store className="h-3.5 w-3.5" />
        Selling, products and reports are migrated in later phases. This screen controls access only.
      </p>
    </div>
  )
}
