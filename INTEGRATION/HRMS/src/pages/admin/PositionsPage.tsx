import * as React from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, Plus } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { PositionEligibilityDialog } from '@/components/admin/PositionEligibilityDialog'
import { usePositionEntitlements } from '@/hooks/useWorkforce'
import { describeEligibility, type PositionEntitlements } from '@/lib/workforce'
import { type Position, usePositions, useCreatePosition, useUpdatePosition, useDeletePosition } from '@/hooks/usePositions'
import { useAuth } from '@/contexts/AuthContext'
import { canApproveWork } from '@/lib/roles'
import { useSubmitChangeRequest } from '@/hooks/useChangeRequests'
import { useDepartments } from '@/hooks/useDepartments'
import { SystemAccessFields } from '@/components/admin/SystemAccessFields'
import { toSystemAccessPayload, type SystemAccessSelection } from '@/lib/workforce'

const positionSchema = z.object({
  title: z.string().min(1, 'Position title is required').max(100),
  department_id: z.string().min(1, 'Select a department'),
  description: z.string().max(500).optional(),
})
type PositionFormValues = z.infer<typeof positionSchema>

function PositionFormDialog({
  open,
  onOpenChange,
  position,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  position?: Position | null
}) {
  const isEdit = !!position
  const { profile } = useAuth()
  const canWriteDirect = canApproveWork(profile?.role)
  const { data: departments } = useDepartments()
  const createPos = useCreatePosition()
  const updatePos = useUpdatePosition()
  const submitRequest = useSubmitChangeRequest()
  // Eligibility is only offered while creating. An existing position is edited
  // through the System Access dialog on its row, so the two never disagree
  // about which one is authoritative.
  const [access, setAccess] = React.useState<SystemAccessSelection>({})
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PositionFormValues>({ resolver: zodResolver(positionSchema) })

  React.useEffect(() => {
    if (open) {
      reset({
        title: position?.title ?? '',
        department_id: position?.department_id ?? '',
        description: position?.description ?? '',
      })
      // A new position starts with no privileged access: Employee Self-Service
      // only, until somebody deliberately chooses otherwise.
      setAccess({})
    }
  }, [open, position, reset])

  const onSubmit = async (values: PositionFormValues) => {
    // Null rather than an empty object: "no privileged access" is the absence
    // of entitlements, never a role code meaning none.
    const systemAccess = isEdit ? null : toSystemAccessPayload(access)

    if (canWriteDirect) {
      if (isEdit) {
        await updatePos.mutateAsync({ id: position.id, values })
      } else {
        await createPos.mutateAsync({ values, systemAccess })
      }
    } else {
      await submitRequest.mutateAsync({
        targetTable: 'positions',
        operation: isEdit ? 'update' : 'create',
        targetId: position?.id,
        payload: {
          title: values.title,
          department_id: values.department_id,
          description: values.description || null,
        },
        summary: `${isEdit ? 'Update' : 'Create'} position: ${values.title}`,
        // Travels with the request and is applied by the database only if the
        // request is approved, so a rejected position leaves no entitlement.
        systemAccess,
      })
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit position' : 'New position'}</DialogTitle>
          <DialogDescription>
            {canWriteDirect
              ? 'Positions belong to a department and are assigned to employees and job postings.'
              : 'Your change goes to an HR Manager for approval before it takes effect.'}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input id="title" invalid={!!errors.title} {...register('title')} placeholder="e.g. HR Generalist" />
            {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>
              Department <span className="text-destructive">*</span>
            </Label>
            <Controller
              control={control}
              name="department_id"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger invalid={!!errors.department_id}>
                    <SelectValue placeholder="Select a department" />
                  </SelectTrigger>
                  <SelectContent>
                    {departments?.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.department_id && <p className="text-xs text-destructive">{errors.department_id.message}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" {...register('description')} placeholder="Optional" rows={3} />
          </div>

          {!isEdit && <SystemAccessFields value={access} onChange={setAccess} />}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {canWriteDirect ? (isEdit ? 'Save changes' : 'Create position') : 'Submit for approval'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function PositionsPage() {
  // What each position makes an employee eligible to hold. Phase 9A: this is
  // what replaced comparing position titles for authorization.
  const { data: entitlements } = usePositionEntitlements()
  const [eligibilityFor, setEligibilityFor] = React.useState<PositionEntitlements | null>(null)

  const { profile } = useAuth()
  const canWriteDirect = canApproveWork(profile?.role)
  const { data, isLoading } = usePositions()
  const deletePos = useDeletePosition()
  const submitRequest = useSubmitChangeRequest()
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Position | null>(null)
  const [deleting, setDeleting] = React.useState<Position | null>(null)

  const columns: ColumnDef<Position>[] = [
    { accessorKey: 'title', header: 'Title' },
    {
      id: 'department',
      header: 'Department',
      accessorFn: (row) => row.departments?.name ?? '',
      cell: ({ row }) =>
        row.original.departments?.name ? <Badge variant="secondary">{row.original.departments.name}</Badge> : '\u2014',
    },
    {
      accessorKey: 'description',
      header: 'Description',
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.description || '\u2014'}</span>,
    },
    {
      id: 'eligibility',
      header: 'System access',
      cell: ({ row }) => {
        const entry = (entitlements ?? []).find((e) => e.positionId === row.original.id)
        if (!entry) return <span className="text-muted-foreground">\u2014</span>
        return entry.pos.length > 0 ? (
          <Badge variant="success">{describeEligibility(entry)}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">{describeEligibility(entry)}</span>
        )
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                setEditing(row.original)
                setFormOpen(true)
              }}
            >
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const entry = (entitlements ?? []).find((e) => e.positionId === row.original.id)
                if (entry) setEligibilityFor(entry)
              }}
            >
              System access
            </DropdownMenuItem>
            <DropdownMenuItem destructive onClick={() => setDeleting(row.original)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground">Positions</h2>
        <p className="text-sm text-muted-foreground">Job titles within each department.</p>
      </div>

      <DataTable
        columns={columns}
        data={data ?? []}
        isLoading={isLoading}
        searchPlaceholder="Search positions..."
        searchColumn="title"
        emptyTitle="No positions yet"
        emptyDescription="Add a position once you have at least one department."
        toolbarAction={
          <Button
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            <Plus className="h-4 w-4" />
            New position
          </Button>
        }
      />

      <PositionFormDialog open={formOpen} onOpenChange={setFormOpen} position={editing} />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleting?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {canWriteDirect
                ? "This can't be undone. Positions assigned to employees or job postings can't be deleted until those are reassigned."
                : 'Deletions are reviewed by an HR Manager. Nothing is removed until they approve it.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (deleting) {
                  if (canWriteDirect) {
                    await deletePos.mutateAsync(deleting.id)
                  } else {
                    await submitRequest.mutateAsync({
                      targetTable: 'positions',
                      operation: 'delete',
                      targetId: deleting.id,
                      summary: `Delete position: ${deleting.title}`,
                    })
                  }
                }
                setDeleting(null)
              }}
            >
              {canWriteDirect ? 'Delete' : 'Submit for approval'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PositionEligibilityDialog
        position={eligibilityFor}
        onClose={() => setEligibilityFor(null)}
      />
    </div>
  )
}
