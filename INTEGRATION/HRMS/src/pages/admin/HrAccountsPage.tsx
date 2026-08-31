import * as React from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, Plus, ShieldCheck } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { useAuth } from '@/contexts/AuthContext'
import {
  type HrAccount,
  useHrAccounts,
  useCreateHrAccount,
  useUpdateHrAccount,
  useSetAccountStatus,
} from '@/hooks/useHrAccounts'
// This page only ever manages Admin/HR Manager/HR Staff logins — employee
// logins (added by the Employee Management module) live in the same `profiles`
// table but are excluded from useHrAccounts()'s query and never appear here.
import { ROLE_LABEL, CREATABLE_HR_ROLES, DEFAULT_ROLE_PASSWORD } from '@/lib/roles'

const createSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
  full_name: z.string().min(1, 'Full name is required').max(150),
  role: z.enum(CREATABLE_HR_ROLES),
})
type CreateFormValues = z.infer<typeof createSchema>

const editSchema = z.object({
  full_name: z.string().min(1, 'Full name is required').max(150),
  role: z.enum(['admin', 'hr_manager', 'hr_staff']),
})
type EditFormValues = z.infer<typeof editSchema>

function CreateAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const createAccount = useCreateHrAccount()
  const {
    register,
    control,
    watch,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateFormValues>({ resolver: zodResolver(createSchema) })

  React.useEffect(() => {
    if (open) reset({ email: '', full_name: '', role: 'hr_staff' })
  }, [open, reset])

  const onSubmit = async (values: CreateFormValues) => {
    await createAccount.mutateAsync(values)
    onOpenChange(false)
  }

  const selectedRole = watch('role')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New HR account</DialogTitle>
          <DialogDescription>
            They can sign in immediately with the email below and the default password{' '}
            <strong>{DEFAULT_ROLE_PASSWORD[selectedRole ?? 'hr_staff']}</strong>.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="full_name">
              Full name <span className="text-destructive">*</span>
            </Label>
            <Input id="full_name" invalid={!!errors.full_name} {...register('full_name')} placeholder="Juan Dela Cruz" />
            {errors.full_name && <p className="text-xs text-destructive">{errors.full_name.message}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">
              Email <span className="text-destructive">*</span>
            </Label>
            <Input id="email" type="email" invalid={!!errors.email} {...register('email')} placeholder="juan@company.com" />
            {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Role</Label>
            <Controller
              control={control}
              name="role"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CREATABLE_HR_ROLES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {ROLE_LABEL[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              {selectedRole === 'hr_manager'
                ? 'HR Managers can do everything HR Staff can, plus approve payroll for release and decide leave requests.'
                : 'HR Staff run the day-to-day workflow. Payroll release and leave decisions need an HR Manager.'}{' '}
              Administrator accounts can't be created from the UI.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditAccountDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: HrAccount | null
}) {
  const updateAccount = useUpdateHrAccount()
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EditFormValues>({ resolver: zodResolver(editSchema) })

  React.useEffect(() => {
    if (open && account) reset({ full_name: account.full_name, role: account.role as 'admin' | 'hr_manager' | 'hr_staff' })
  }, [open, account, reset])

  if (!account) return null
  const isAdmin = account.role === 'admin'

  const onSubmit = async (values: EditFormValues) => {
    await updateAccount.mutateAsync({ id: account.id, values })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit account</DialogTitle>
          <DialogDescription>{account.email}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit_full_name">Full name</Label>
            <Input id="edit_full_name" invalid={!!errors.full_name} {...register('full_name')} />
            {errors.full_name && <p className="text-xs text-destructive">{errors.full_name.message}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Role</Label>
            <Controller
              control={control}
              name="role"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={isAdmin}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {isAdmin ? (
                      <SelectItem value="admin">{ROLE_LABEL.admin}</SelectItem>
                    ) : (
                      CREATABLE_HR_ROLES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {ROLE_LABEL[value]}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
            />
            {isAdmin && (
              <p className="text-xs text-muted-foreground">Administrator accounts cannot have their role changed.</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function HrAccountsPage() {
  const { profile: currentProfile } = useAuth()
  const { data, isLoading } = useHrAccounts()
  const setStatus = useSetAccountStatus()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<HrAccount | null>(null)
  const [deactivating, setDeactivating] = React.useState<HrAccount | null>(null)

  const columns: ColumnDef<HrAccount>[] = [
    {
      accessorKey: 'full_name',
      header: 'Name',
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{row.original.full_name}</span>
          {row.original.id === currentProfile?.id && <Badge variant="muted">You</Badge>}
        </div>
      ),
    },
    { accessorKey: 'email', header: 'Email' },
    {
      accessorKey: 'role',
      header: 'Role',
      cell: ({ row }) => (
        <Badge variant={row.original.role === 'admin' ? 'secondary' : row.original.role === 'hr_manager' ? 'warning' : 'outline'}>
          {(row.original.role === 'admin' || row.original.role === 'hr_manager') && <ShieldCheck className="h-3 w-3" />}
          {ROLE_LABEL[row.original.role]}
        </Badge>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={row.original.status === 'active' ? 'success' : 'muted'}>
          {row.original.status === 'active' ? 'Active' : 'Deactivated'}
        </Badge>
      ),
    },
    {
      accessorKey: 'last_login_at',
      header: 'Last login',
      cell: ({ row }) =>
        row.original.last_login_at ? new Date(row.original.last_login_at).toLocaleDateString() : 'Never',
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const isSelf = row.original.id === currentProfile?.id
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(row.original)}>Edit</DropdownMenuItem>
              {row.original.status === 'active' ? (
                <DropdownMenuItem
                  destructive
                  disabled={isSelf || row.original.role === 'admin'}
                  onClick={() => setDeactivating(row.original)}
                >
                  Deactivate
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setStatus.mutate({ id: row.original.id, status: 'active' })}>
                  Reactivate
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground">HR Accounts</h2>
        <p className="text-sm text-muted-foreground">Everyone with sign-in access to JMAC Enterprise.</p>
      </div>

      <DataTable
        columns={columns}
        data={data ?? []}
        isLoading={isLoading}
        searchPlaceholder="Search by name or email..."
        emptyTitle="No accounts yet"
        toolbarAction={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New account
          </Button>
        }
      />

      <CreateAccountDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditAccountDialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)} account={editing} />

      <AlertDialog open={!!deactivating} onOpenChange={(open) => !open && setDeactivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactivating?.full_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They'll be immediately signed out and blocked from signing back in until reactivated. This doesn't delete
              their account or history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deactivating) setStatus.mutate({ id: deactivating.id, status: 'inactive' })
                setDeactivating(null)
              }}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
