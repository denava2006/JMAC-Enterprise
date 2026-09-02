import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, Plus, Store } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { reportInvalid } from '@/lib/formFeedback'
import { useAuth } from '@/contexts/AuthContext'
import { financeCan } from '@/lib/financeAuthority'
import {
  type Vendor,
  useFinanceCategories,
  useSaveVendor,
  useSetVendorActive,
  useVendorCategories,
  useVendors,
} from '@/hooks/useFinanceMasterData'

const schema = z.object({
  name: z.string().min(1, 'A vendor name is required').max(150),
  contact_person: z.string().max(150).optional(),
  email: z.string().email('That is not a valid email address').or(z.literal('')).optional(),
  // Digits with an optional leading +, matching how the rest of JMAC stores a
  // phone number. Formatting is a display concern, not a storage one.
  phone: z
    .string()
    .regex(/^\+?\d{7,15}$/, 'Digits only, with an optional leading +')
    .or(z.literal(''))
    .optional(),
  tin: z.string().max(30).optional(),
  address: z.string().max(300).optional(),
  notes: z.string().max(500).optional(),
})
type FormValues = z.infer<typeof schema>

function VendorDialog({
  open,
  onOpenChange,
  vendor,
  categoryIds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  vendor?: Vendor | null
  categoryIds: string[]
}) {
  const isEdit = !!vendor
  const save = useSaveVendor()
  const { data: categories = [] } = useFinanceCategories()
  const [selected, setSelected] = React.useState<string[]>([])

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', contact_person: '', email: '', phone: '', tin: '', address: '', notes: '' },
  })

  React.useEffect(() => {
    if (!open) return
    form.reset({
      name: vendor?.name ?? '',
      contact_person: vendor?.contact_person ?? '',
      email: vendor?.email ?? '',
      phone: vendor?.phone ?? '',
      tin: vendor?.tin ?? '',
      address: vendor?.address ?? '',
      notes: vendor?.notes ?? '',
    })
    setSelected(categoryIds)
  }, [open, vendor, categoryIds, form])

  const expenseCategories = categories.filter((c) => c.kind === 'expense' && c.is_active)

  const onSubmit = form.handleSubmit(async (values) => {
    await save.mutateAsync({
      id: vendor?.id,
      values: {
        name: values.name.trim(),
        contact_person: values.contact_person?.trim() || null,
        email: values.email?.trim() || null,
        phone: values.phone?.trim() || null,
        tin: values.tin?.trim() || null,
        address: values.address?.trim() || null,
        notes: values.notes?.trim() || null,
      },
      categoryIds: selected,
    })
    onOpenChange(false)
  }, reportInvalid({ contact_person: 'Contact person', tin: 'TIN' }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit vendor' : 'New vendor'}</DialogTitle>
          <DialogDescription>
            A supplier the company pays. What a vendor supplies decides where it can be charged.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="vendor-name">Vendor name</Label>
            <Input id="vendor-name" {...form.register('name')} autoFocus />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vendor-contact">Contact person</Label>
              <Input id="vendor-contact" {...form.register('contact_person')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vendor-tin">TIN</Label>
              <Input id="vendor-tin" {...form.register('tin')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vendor-email">Email</Label>
              <Input id="vendor-email" type="email" {...form.register('email')} />
              {form.formState.errors.email && (
                <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vendor-phone">Phone</Label>
              <Input id="vendor-phone" {...form.register('phone')} placeholder="+639171234567" />
              {form.formState.errors.phone && (
                <p className="text-xs text-destructive">{form.formState.errors.phone.message}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="vendor-address">Address</Label>
            <Input id="vendor-address" {...form.register('address')} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>What this vendor supplies</Label>
            <p className="text-xs text-muted-foreground">
              Leave everything unticked for a general supplier — it stays available everywhere.
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {expenseCategories.map((category) => {
                const on = selected.includes(category.id)
                return (
                  <button
                    key={category.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setSelected((prev) =>
                        on ? prev.filter((id) => id !== category.id) : [...prev, category.id],
                      )
                    }
                    className={
                      on
                        ? 'rounded-full border border-accent bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent transition-colors'
                        : 'rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-accent/40 hover:text-foreground'
                    }
                  >
                    {category.name}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="vendor-notes">Notes</Label>
            <Textarea id="vendor-notes" rows={2} {...form.register('notes')} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving...' : 'Save vendor'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function VendorsPage() {
  const { profile } = useAuth()
  const { data: vendors = [], isLoading } = useVendors()
  const { data: links } = useVendorCategories()
  const { data: categories = [] } = useFinanceCategories()
  const setActive = useSetVendorActive()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Vendor | null>(null)

  const canCreate = financeCan(profile?.role, 'vendors', 'create')
  const canEdit = financeCan(profile?.role, 'vendors', 'edit')
  const canArchive = financeCan(profile?.role, 'vendors', 'archive')

  const categoryName = React.useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  )

  const columns = React.useMemo<ColumnDef<Vendor>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Vendor',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-medium text-foreground">{row.original.name}</p>
            {row.original.contact_person && (
              <p className="truncate text-xs text-muted-foreground">{row.original.contact_person}</p>
            )}
          </div>
        ),
      },
      {
        id: 'supplies',
        header: 'Supplies',
        cell: ({ row }) => {
          const ids = links?.get(row.original.id) ?? []
          if (ids.length === 0) {
            return <span className="text-xs text-muted-foreground">General supplier</span>
          }
          return (
            <div className="flex flex-wrap gap-1">
              {ids.map((id) => (
                <Badge key={id} variant="secondary">
                  {categoryName.get(id) ?? 'Unknown'}
                </Badge>
              ))}
            </div>
          )
        },
      },
      {
        id: 'contact',
        header: 'Contact',
        cell: ({ row }) => (
          <div className="text-xs text-muted-foreground">
            {row.original.email && <p className="truncate">{row.original.email}</p>}
            {row.original.phone && <p>{row.original.phone}</p>}
            {!row.original.email && !row.original.phone && <span>—</span>}
          </div>
        ),
      },
      {
        accessorKey: 'is_active',
        header: 'Status',
        cell: ({ row }) =>
          row.original.is_active ? (
            <Badge variant="outline">Active</Badge>
          ) : (
            <Badge variant="secondary">Retired</Badge>
          ),
      },
      ...(canEdit || canArchive
        ? [
            {
              id: 'actions',
              cell: ({ row }) => (
                <div className="flex justify-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Vendor actions">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {canEdit && (
                        <DropdownMenuItem
                          onClick={() => {
                            setEditing(row.original)
                            setDialogOpen(true)
                          }}
                        >
                          Edit
                        </DropdownMenuItem>
                      )}
                      {canArchive && (
                        <DropdownMenuItem
                          onClick={() =>
                            setActive.mutate({ id: row.original.id, isActive: !row.original.is_active })
                          }
                        >
                          {row.original.is_active ? 'Retire vendor' : 'Reinstate'}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ),
            } as ColumnDef<Vendor>,
          ]
        : []),
    ],
    [canEdit, canArchive, links, categoryName, setActive],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Vendors"
        description="Suppliers the company pays, and what each one supplies."
        action={
          canCreate ? (
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              New vendor
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Active vendors"
          value={vendors.filter((v) => v.is_active).length}
          icon={Store}
          isLoading={isLoading}
        />
        <StatCard
          label="Retired"
          value={vendors.filter((v) => !v.is_active).length}
          icon={Store}
          isLoading={isLoading}
        />
        <StatCard
          label="General suppliers"
          value={vendors.filter((v) => (links?.get(v.id) ?? []).length === 0).length}
          icon={Store}
          isLoading={isLoading}
        />
      </div>

      <DataTable
        columns={columns}
        data={vendors}
        isLoading={isLoading}
        searchColumn="name"
        searchPlaceholder="Search vendors..."
        emptyTitle="No vendors yet"
        emptyDescription="Add the suppliers the company buys from so requests can name them."
      />

      <VendorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        vendor={editing}
        categoryIds={editing ? (links?.get(editing.id) ?? []) : []}
      />
    </div>
  )
}
