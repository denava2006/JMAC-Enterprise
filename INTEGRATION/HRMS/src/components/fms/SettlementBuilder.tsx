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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useCreateSettlement,
  useSettlementBranches,
  useTreasuryAccounts,
  useUnsettledCollections,
} from '@/hooks/useTreasury'
import { sanitizeMoneyInput } from '@/lib/currency'
import { ONLINE_METHODS, saleMethodLabel } from '@/lib/posTill'
import { formatSaleTimestamp } from '@/lib/financeSales'
import {
  RECORDED_SETTLEMENT_NOTE,
  formatTreasuryMoney,
  type SettlementKind,
} from '@/lib/treasury'

/**
 * The providers a settlement may be recorded against.
 *
 * ONLINE_METHODS from posTill, not a second list here. The list I wrote by
 * hand included both 'paymaya' and legacy 'maya', and SALE_METHOD_LABEL maps
 * both to "Maya" — so the menu read GCash / Maya / Maya / Card / QR Ph.
 *
 * Removing the legacy entry from the menu is safe only because the server
 * treats the two as one provider family: choosing Maya finds historical 'maya'
 * rows as well as current 'paymaya' ones. Without that, dropping it from the
 * list would have made those rows permanently unsettleable.
 */
export const PROVIDER_METHODS = ONLINE_METHODS

const ALL_BRANCHES = '__all__'

/**
 * Building a settlement out of the collections it actually covers.
 *
 * The amount is never typed. It is the sum of the sales the Accountant picks,
 * which is what makes the record reconcilable: every peso on it can be walked
 * back to a receipt. Only the provider's fee is stated, because only the
 * provider knows it.
 *
 * The list offers nothing that is already settled, and nothing that never
 * became a sale — a failed or abandoned online payment has no row to offer.
 */
export function SettlementBuilder({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const create = useCreateSettlement()
  const { data: accounts = [] } = useTreasuryAccounts()
  // Finance's own branch surface, not the HR/Admin one — see useSettlementBranches.
  const branches = useSettlementBranches()

  const [kind, setKind] = React.useState<SettlementKind>('branch_cash')
  const [branchId, setBranchId] = React.useState<string>('')
  const [method, setMethod] = React.useState<string>('gcash')
  const [accountId, setAccountId] = React.useState<string>('')
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10))
  const [fee, setFee] = React.useState('')
  const [reference, setReference] = React.useState('')
  const [picked, setPicked] = React.useState<Set<string>>(new Set())

  // A cash remittance is always one branch emptying its own drawer, so a
  // branch is required. A provider payout may genuinely span branches, so
  // there it is optional -- but an Accountant reconciling one branch can still
  // ask for one, which they could not before.
  const ready = kind === 'branch_cash' ? !!branchId && branchId !== ALL_BRANCHES : !!method
  const scopedBranch = branchId === ALL_BRANCHES ? null : branchId || null
  const unsettled = useUnsettledCollections(
    kind,
    {
      branchId: scopedBranch,
      paymentMethod: kind === 'provider' ? method : null,
    },
    open && ready
  )

  React.useEffect(() => {
    if (!open) return
    setKind('branch_cash')
    setBranchId('')
    setMethod('gcash')
    setAccountId('')
    setDate(new Date().toISOString().slice(0, 10))
    setFee('')
    setReference('')
    setPicked(new Set())
  }, [open])

  // Changing what is being settled invalidates what was picked. A sale chosen
  // under Cavite + GCash must not still be ticked after switching to Main
  // Office + Maya -- the server would refuse it, and the total shown in the
  // meantime would be describing a settlement that cannot exist.
  React.useEffect(() => setPicked(new Set()), [kind, branchId, method])

  // Switching to a cash remittance leaves All branches selected, which a
  // remittance cannot use: one drawer, one branch.
  React.useEffect(() => {
    if (kind === 'branch_cash' && branchId === ALL_BRANCHES) setBranchId('')
  }, [kind, branchId])

  // The function already returns only active branches, so there is nothing to
  // filter here — and nothing that could quietly stop filtering.
  const branchOptions = branches.data ?? []
  const rows = unsettled.data ?? []
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.sale_id))
  const gross = rows
    .filter((r) => picked.has(r.sale_id))
    .reduce((sum, r) => sum + Number(r.amount ?? 0), 0)
  const feeValue = kind === 'provider' ? Number(fee || 0) : 0
  const net = gross - feeValue

  // Deposits into a bank are what F6 supports; a branch drawer is where cash
  // comes from, not where a remittance goes.
  const destinations = accounts.filter((a) => a.is_active)

  const canSave =
    picked.size > 0 && !!accountId && ready && feeValue <= gross && net > 0 && !create.isPending

  function toggle(saleId: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(saleId)) next.delete(saleId)
      else next.add(saleId)
      return next
    })
  }

  async function save(submit: boolean) {
    await create.mutateAsync({
      kind,
      destinationAccountId: accountId,
      settlementDate: date,
      saleIds: [...picked],
      // A provider settlement carries its branch when one was chosen, and the
      // server then holds every line to it.
      branchId: scopedBranch,
      paymentMethod: kind === 'provider' ? method : null,
      feeAmount: feeValue,
      reference: reference.trim() || null,
      submit,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record a settlement</DialogTitle>
          <DialogDescription>
            Pick the collections this settlement covers. The total comes from the sales themselves,
            so it can always be reconciled back to receipts.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="st-kind">What is being settled</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as SettlementKind)}>
                <SelectTrigger id="st-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="branch_cash">Branch cash remittance</SelectItem>
                  <SelectItem value="provider">Payment provider settlement</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Branch is asked for either way now. A cash remittance must name
                one; a provider payout may span branches, so there it also
                offers All branches -- but an Accountant reconciling a single
                branch's payout can finally say so. */}
            <div className="space-y-1.5">
              <Label htmlFor="st-branch">Branch</Label>
              {/* Each state said out loud. An empty dropdown that could mean
                  "still loading", "the request failed" or "there are none" is
                  how the earlier defect stayed invisible: it looked like a
                  branch list with nothing in it. */}
              <Select
                value={branchId}
                onValueChange={setBranchId}
                disabled={branches.isLoading || branches.isError || branchOptions.length === 0}
              >
                <SelectTrigger id="st-branch">
                  {/* Short in the control, and the full sentence below it —
                      the same words twice would be two things to read and two
                      places to keep in step. */}
                  <SelectValue
                    placeholder={
                      branches.isLoading
                        ? 'Loading branches…'
                        : branches.isError
                          ? 'Unavailable'
                          : branchOptions.length === 0
                            ? 'None available'
                            : 'Choose a branch'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {kind === 'provider' && (
                    <SelectItem value={ALL_BRANCHES}>All branches</SelectItem>
                  )}
                  {branchOptions.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {branches.isError && (
                <p className="text-xs text-destructive">Branches could not be loaded.</p>
              )}
              {!branches.isLoading && !branches.isError && branchOptions.length === 0 && (
                <p className="text-xs text-muted-foreground">No active branches are available.</p>
              )}
            </div>
          </div>

          {kind === 'provider' && (
            <div className="space-y-1.5 sm:max-w-[calc(50%-0.5rem)]">
              <Label htmlFor="st-method">Payment method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="st-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {saleMethodLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            {/* Named for what it actually lists, so it is obvious why a branch
                cash remittance shows no GCash: it is a cash list. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>
                {kind === 'branch_cash'
                  ? 'Unremitted cash sales'
                  : 'Unsettled provider collections'}
              </Label>
              {rows.length > 0 && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {picked.size} of {rows.length} selected
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setPicked(
                        allPicked ? new Set() : new Set(rows.map((r) => r.sale_id))
                      )
                    }
                  >
                    {allPicked ? 'Clear all' : 'Select all'}
                  </Button>
                </div>
              )}
            </div>
            {!ready ? (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                {kind === 'branch_cash'
                  ? 'Choose a branch to see its unremitted cash.'
                  : 'Choose a payment method to see its unsettled collections.'}
              </p>
            ) : unsettled.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-11 w-full" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing is waiting to be settled here.
              </p>
            ) : (
              <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
                {rows.map((r) => (
                  <li key={r.sale_id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/60">
                      {/* A native checkbox: the design system has no checkbox
                          primitive, and one list does not justify adding a
                          dependency that every other page would then have to
                          learn about. */}
                      <input
                        type="checkbox"
                        className="h-4 w-4 shrink-0 accent-[--color-accent] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        checked={picked.has(r.sale_id)}
                        onChange={() => toggle(r.sale_id)}
                        aria-label={`Include ${r.payment_reference ?? r.sale_id.slice(0, 8)}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">
                          {r.payment_reference ?? r.sale_id.slice(0, 8).toUpperCase()}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {formatSaleTimestamp(r.sold_at)} · {r.branch_name} · {r.cashier_name}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums text-foreground">
                        {formatTreasuryMoney(r.amount)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="st-account">Destination account</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="st-account">
                  <SelectValue placeholder="Where the money arrived" />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-date">Settlement date</Label>
              <Input id="st-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {kind === 'provider' && (
              <div className="space-y-1.5">
                <Label htmlFor="st-fee">Provider fee</Label>
                <Input
                  id="st-fee"
                  inputMode="decimal"
                  value={fee}
                  onChange={(e) => setFee(sanitizeMoneyInput(e.target.value))}
                  placeholder="0.00"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="st-ref">
                {kind === 'branch_cash' ? 'Deposit reference' : 'Settlement reference'}
              </Label>
              <Input
                id="st-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder={kind === 'branch_cash' ? 'DEP-2026-001' : 'From the settlement advice'}
              />
            </div>
          </div>

          {/* The three figures kept apart, because the customer paid the gross
              and the company received the net. */}
          <div className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-muted/40 p-3">
            <Figure label="Gross collected" value={formatTreasuryMoney(gross)} />
            <Figure label="Provider fee" value={formatTreasuryMoney(feeValue)} />
            <Figure label="Net received" value={formatTreasuryMoney(net)} strong />
          </div>

          {feeValue > gross && (
            <p className="text-sm text-destructive">
              The fee cannot be more than the amount collected.
            </p>
          )}

          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>{RECORDED_SETTLEMENT_NOTE}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => save(false)} disabled={!canSave}>
            Save as draft
          </Button>
          <Button onClick={() => save(true)} disabled={!canSave}>
            Submit for review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`tabular-nums ${strong ? 'text-base font-semibold text-foreground' : 'text-sm text-foreground'}`}
      >
        {value}
      </p>
    </div>
  )
}
