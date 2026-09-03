import * as React from 'react'
import { MapPin, Plus, Building2, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
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
import { BranchMap } from '@/components/admin/BranchMap'
import {
  useBranches,
  useWorkLocations,
  useSaveBranch,
  useDeleteBranch,
  useSaveWorkLocation,
  useDeleteWorkLocation,
  type Branch,
  type WorkLocation,
} from '@/hooks/useBranches'

function BranchDialog({
  open,
  onOpenChange,
  branch,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  branch: Branch | null
}) {
  const save = useSaveBranch()
  const [name, setName] = React.useState('')
  const [address, setAddress] = React.useState('')
  const [phone, setPhone] = React.useState('')
  const [latitude, setLatitude] = React.useState('')
  const [longitude, setLongitude] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) {
      setName(branch?.name ?? '')
      setAddress(branch?.address ?? '')
      setPhone(branch?.phone ?? '')
      setLatitude(branch?.latitude != null ? String(branch.latitude) : '')
      setLongitude(branch?.longitude != null ? String(branch.longitude) : '')
      setError(null)
    }
  }, [open, branch])

  const submit = () => {
    if (!name.trim()) {
      setError('Branch name is required.')
      return
    }
    // Both or neither. A half-set pair puts the pin in the sea off west Africa,
    // which is where every (0, 0) ends up -- and the database refuses it too.
    const lat = latitude.trim()
    const lng = longitude.trim()
    if ((lat === '') !== (lng === '')) {
      setError('Give both a latitude and a longitude, or leave both empty.')
      return
    }
    if (lat !== '' && (Number.isNaN(Number(lat)) || Number.isNaN(Number(lng)))) {
      setError('Latitude and longitude must be numbers in decimal degrees.')
      return
    }
    if (lat !== '' && (Math.abs(Number(lat)) > 90 || Math.abs(Number(lng)) > 180)) {
      setError('Latitude is between -90 and 90, longitude between -180 and 180.')
      return
    }

    save.mutate(
      {
        id: branch?.id,
        name: name.trim(),
        address: address.trim() || undefined,
        phone: phone.trim() || undefined,
        latitude: lat === '' ? null : Number(lat),
        longitude: lng === '' ? null : Number(lng),
      },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{branch ? 'Edit branch' : 'New branch'}</DialogTitle>
          <DialogDescription>Branches are selectable when completing a deployment.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch_name">
              Branch Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="branch_name"
              invalid={!!error}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (error) setError(null)
              }}
              placeholder="Main Office"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch_address">Address</Label>
            <Input id="branch_address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Optional" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch_phone">Phone</Label>
            <Input
              id="branch_phone"
              value={phone}
              maxLength={40}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Optional — printed on POS receipts"
            />
          </div>
          {/* Where the branch is, for the map. Optional: a branch with no
              coordinates still lists everywhere it listed before, it simply is
              not pinned. Nothing operational reads these. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="branch_latitude">Latitude</Label>
              <Input
                id="branch_latitude"
                inputMode="decimal"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="14.4791"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="branch_longitude">Longitude</Label>
              <Input
                id="branch_longitude"
                inputMode="decimal"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="120.8970"
              />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Decimal degrees, both or neither. Leave empty until somebody knows where it is.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {branch ? 'Save changes' : 'Add branch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LocationDialog({
  open,
  onOpenChange,
  location,
  branches,
  defaultBranchId,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  location: WorkLocation | null
  branches: Branch[]
  defaultBranchId?: string
}) {
  const save = useSaveWorkLocation()
  const [branchId, setBranchId] = React.useState('')
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    if (open) {
      setBranchId(location?.branch_id ?? defaultBranchId ?? '')
      setName(location?.name ?? '')
      setDescription(location?.description ?? '')
      setErrors({})
    }
  }, [open, location, defaultBranchId])

  const submit = () => {
    const next: Record<string, string> = {}
    if (!branchId) next.branchId = 'Select a branch.'
    if (!name.trim()) next.name = 'Location name is required.'
    if (Object.keys(next).length) {
      setErrors(next)
      return
    }
    save.mutate(
      { id: location?.id, branchId, name: name.trim(), description: description.trim() || undefined },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{location ? 'Edit work location' : 'New work location'}</DialogTitle>
          <DialogDescription>A specific place to report to within a branch.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>
              Branch <span className="text-destructive">*</span>
            </Label>
            <Select
              value={branchId}
              onValueChange={(v) => {
                setBranchId(v)
                setErrors((p) => ({ ...p, branchId: '' }))
              }}
            >
              <SelectTrigger invalid={!!errors.branchId}>
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.branchId && <p className="text-xs text-destructive">{errors.branchId}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="location_name">
              Location Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="location_name"
              invalid={!!errors.name}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setErrors((p) => ({ ...p, name: '' }))
              }}
              placeholder="Sales Floor"
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="location_description">Description</Label>
            <Input
              id="location_description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {location ? 'Save changes' : 'Add location'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function BranchesPage() {
  const { data: branches, isLoading } = useBranches()
  const { data: locations } = useWorkLocations()
  const deleteBranch = useDeleteBranch()
  const deleteLocation = useDeleteWorkLocation()

  const [branchDialog, setBranchDialog] = React.useState<{ open: boolean; branch: Branch | null }>({
    open: false,
    branch: null,
  })
  const [locationDialog, setLocationDialog] = React.useState<{
    open: boolean
    location: WorkLocation | null
    branchId?: string
  }>({ open: false, location: null })
  const [deletingBranch, setDeletingBranch] = React.useState<Branch | null>(null)
  const [deletingLocation, setDeletingLocation] = React.useState<WorkLocation | null>(null)

  const locationsByBranch = React.useMemo(() => {
    const map = new Map<string, WorkLocation[]>()
    for (const l of locations ?? []) {
      if (!l.branch_id) continue
      map.set(l.branch_id, [...(map.get(l.branch_id) ?? []), l])
    }
    return map
  }, [locations])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">Branches &amp; Work Locations</h2>
          <p className="text-sm text-muted-foreground">
            Where employees are deployed. These populate the dropdowns when completing a deployment.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setLocationDialog({ open: true, location: null })}>
            <Plus className="h-4 w-4" />
            New location
          </Button>
          <Button onClick={() => setBranchDialog({ open: true, branch: null })}>
            <Plus className="h-4 w-4" />
            New branch
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : !branches?.length ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <Building2 className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No branches yet. Add one to get started.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <BranchMap branches={branches} />
          {branches.map((branch) => {
            const branchLocations = locationsByBranch.get(branch.id) ?? []
            return (
              <Card key={branch.id}>
                <CardContent className="flex flex-col gap-4 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                        <Building2 className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="font-medium text-foreground">{branch.name}</p>
                        <p className="text-xs text-muted-foreground">{branch.address ?? 'No address on file'}</p>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setBranchDialog({ open: true, branch })}>Edit</DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setLocationDialog({ open: true, location: null, branchId: branch.id })}
                        >
                          Add location
                        </DropdownMenuItem>
                        <DropdownMenuItem destructive onClick={() => setDeletingBranch(branch)}>
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {branchLocations.length > 0 ? (
                    <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                      {branchLocations.map((l) => (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() => setLocationDialog({ open: true, location: l })}
                          className="group inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs transition-colors hover:border-secondary/50"
                        >
                          <MapPin className="h-3 w-3 text-muted-foreground" />
                          {l.name}
                          <span
                            role="button"
                            tabIndex={-1}
                            aria-label={`Remove ${l.name}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              setDeletingLocation(l)
                            }}
                            className="ml-0.5 text-muted-foreground hover:text-destructive"
                          >
                            ×
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="border-t border-border pt-3">
                      <Badge variant="muted">No work locations yet</Badge>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <BranchDialog
        open={branchDialog.open}
        onOpenChange={(o) => setBranchDialog((s) => ({ ...s, open: o }))}
        branch={branchDialog.branch}
      />
      <LocationDialog
        open={locationDialog.open}
        onOpenChange={(o) => setLocationDialog((s) => ({ ...s, open: o }))}
        location={locationDialog.location}
        branches={branches ?? []}
        defaultBranchId={locationDialog.branchId}
      />

      <AlertDialog open={!!deletingBranch} onOpenChange={(o) => !o && setDeletingBranch(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deletingBranch?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its work locations are removed too. Branches already used on a deployment record can't be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deletingBranch) deleteBranch.mutate(deletingBranch.id)
                setDeletingBranch(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deletingLocation} onOpenChange={(o) => !o && setDeletingLocation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {deletingLocation?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This work location will no longer be selectable.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deletingLocation) deleteLocation.mutate(deletingLocation.id)
                setDeletingLocation(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
