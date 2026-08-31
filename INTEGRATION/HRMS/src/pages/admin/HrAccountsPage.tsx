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
  useUpdateHrAccount,
  useSetAccountStatus,
} from '@/hooks/useHrAccounts'
// This page only ever manages Admin/HR Manager/HR Staff logins — employee
// logins (added by the Employee Management module) live in the same `profiles`
// table but are excluded from useHrAccounts()'s query and never appear here.
import { ROLE_LABEL, CREATABLE_HR_ROLES } from '@/lib/roles'
import { GrantHrPrivilegeDialog } from '@/components/admin/GrantHrPrivilegeDialog'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useCloseHrPrivilege, useHrAccounts as useHrPrivilegeRows } from '@/hooks/useHrPrivilege'

const editSchema = z.object({
  full_name: z.string().min(1, 'Full name is required').max(150),
  role: z.enum(['admin', 'hr_manager', 'hr_staff']),
})
type EditFormValues = z.infer<typeof editSchema>

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


/** Local, matching how the other screens format a timestamp. */
function formatDateTime(iso: string | null) {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/**
 * Who currently holds HR authority, and on what basis.
 *
 * Three separate things decide it, and the table shows all three rather than a
 * single badge: the role the account claims, the grant an Administrator made,
 * and whether the position still confers it. A row can hold a live grant and
 * still not authorize -- that is what "no longer authorizes" means, and it is
 * the state this screen exists to make visible.
 */
function HrPrivilegeTable() {
  const { data: rows, isLoading } = useHrPrivilegeRows()
  const closePrivilege = useCloseHrPrivilege()
  const items = rows ?? []

  if (isLoading) return <Skeleton className="h-40 w-full" />
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">
            Nobody holds HR privilege yet. Grant it to an employee whose position confers an HR role.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-semibold">Employee</th>
              <th className="px-4 py-3 font-semibold">Department</th>
              <th className="px-4 py-3 font-semibold">Position</th>
              <th className="px-4 py-3 font-semibold">HR role</th>
              <th className="px-4 py-3 font-semibold">Account</th>
              <th className="px-4 py-3 font-semibold">Eligibility</th>
              <th className="px-4 py-3 font-semibold">Last login</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={`${row.profile_id}-${row.granted_at}`} className="border-b border-border last:border-0">
                <td className="px-4 py-3">
                  <p className="font-medium text-foreground">{row.full_name ?? row.email}</p>
                  <p className="text-xs text-muted-foreground">{row.email}</p>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{row.department_name ?? '\u2014'}</td>
                <td className="px-4 py-3 text-muted-foreground">{row.position_title ?? '\u2014'}</td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className="bg-muted/60 font-normal">
                    {ROLE_LABEL[row.hr_role as keyof typeof ROLE_LABEL] ?? row.hr_role}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  {/* Colour here IS a status: the account is on or off. */}
                  <Badge variant={row.account_status === 'active' ? 'success' : 'muted'}>
                    {row.account_status === 'active' ? 'Active' : 'Disabled'}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  {row.grant_status !== 'active' ? (
                    <span className="text-xs text-muted-foreground">
                      Closed{row.closed_reason ? ` \u00b7 ${row.closed_reason.replace(/_/g, ' ')}` : ''}
                    </span>
                  ) : row.authorizes_now ? (
                    <span className="text-xs text-muted-foreground">Authorizes</span>
                  ) : (
                    <span className="text-xs text-warning">
                      Granted, but the position no longer confers it
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{formatDateTime(row.last_login_at)}</td>
                <td className="px-4 py-3 text-right">
                  {row.grant_status === 'active' && (
                    <Button
                      variant="outline"
                      size="sm"
                      loading={closePrivilege.isPending}
                      onClick={() =>
                        closePrivilege.mutate({ profileId: row.profile_id, reason: 'revoked by administrator' })
                      }
                    >
                      Close
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
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
        <p className="text-sm text-muted-foreground">
          HR authority follows the job. An account authorizes only while it claims the role, holds a grant, and its
          position still confers it.
        </p>
      </div>

      <HrPrivilegeTable />

      <DataTable
        columns={columns}
        data={data ?? []}
        isLoading={isLoading}
        searchPlaceholder="Search by name or email..."
        emptyTitle="No accounts yet"
        toolbarAction={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Grant HR privilege
          </Button>
        }
      />

      <GrantHrPrivilegeDialog open={createOpen} onOpenChange={setCreateOpen} />
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
