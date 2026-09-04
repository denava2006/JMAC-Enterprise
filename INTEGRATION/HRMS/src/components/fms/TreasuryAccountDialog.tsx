import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useCreateTreasuryAccount, useSettlementBranches } from '@/hooks/useTreasury'
import { sanitizeMoneyInput } from '@/lib/currency'

const NONE = '__none__'

/**
 * Opening a place money can sit.
 *
 * The opening balance is a stated fact with a date, not a running total, and
 * the database fixes it the moment the account has any movement. So it is
 * asked for once, here, and never offered again — there is no edit-balance
 * control anywhere in the app, by design.
 */
export function TreasuryAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const create = useCreateTreasuryAccount()
  // The same Finance branch surface the settlement builder uses. This dialog is
  // Accountant-only too, so it had the identical empty-dropdown defect: it read
  // public.branches through the HR/Admin hook and got nothing back.
  const branches = useSettlementBranches()
  const branchOptions = branches.data ?? []

  const [name, setName] = React.useState('')
  const [accountType, setAccountType] = React.useState<'cash' | 'bank'>('bank')
  const [branchId, setBranchId] = React.useState<string>(NONE)
  const [opening, setOpening] = React.useState('')
  const [asOf, setAsOf] = React.useState(() => new Date().toISOString().slice(0, 10))

  React.useEffect(() => {
    if (!open) return
    setName('')
    setAccountType('bank')
    setBranchId(NONE)
    setOpening('')
    setAsOf(new Date().toISOString().slice(0, 10))
  }, [open])

  // A bank account belongs to the company; only a cash account can sit at a
  // branch. The form follows the same rule the database enforces.
  React.useEffect(() => {
    if (accountType === 'bank') setBranchId(NONE)
  }, [accountType])

  const openingValue = Number(opening || 0)
  const canSave = name.trim().length > 0 && !create.isPending

  async function save() {
    await create.mutateAsync({
      name: name.trim(),
      accountType,
      branchId: branchId === NONE ? null : branchId,
      openingBalance: openingValue,
      openingBalanceAsOf: openingValue > 0 ? asOf : null,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New treasury account</DialogTitle>
          <DialogDescription>
            A place money is held or paid from. The balance is worked out from what moves through
            it, so it is only stated once, here.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="ta-name">Name</Label>
            <Input
              id="ta-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Main Bank Account"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ta-type">Type</Label>
              <Select
                value={accountType}
                onValueChange={(v) => setAccountType(v as 'cash' | 'bank')}
              >
                <SelectTrigger id="ta-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank">Bank account</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ta-branch">Branch</Label>
              <Select
                value={branchId}
                onValueChange={setBranchId}
                disabled={accountType === 'bank' || branches.isLoading}
              >
                <SelectTrigger id="ta-branch">
                  <SelectValue
                    placeholder={branches.isLoading ? 'Loading branches…' : 'Company-wide'}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Company-wide</SelectItem>
                  {branchOptions.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {accountType === 'bank' ? (
                <p className="text-xs text-muted-foreground">
                  Bank accounts belong to the company, not to a branch.
                </p>
              ) : branches.isError ? (
                <p className="text-xs text-destructive">Branches could not be loaded.</p>
              ) : !branches.isLoading && branchOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No active branches are available.
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ta-opening">Opening balance</Label>
              <Input
                id="ta-opening"
                inputMode="decimal"
                value={opening}
                onChange={(e) => setOpening(sanitizeMoneyInput(e.target.value))}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ta-asof">As of</Label>
              <Input
                id="ta-asof"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                disabled={openingValue <= 0}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            After this, the balance changes only through confirmed settlements and recorded
            payments. There is no way to edit it directly.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            Add account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
