import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/contexts/AuthContext'
import { useBudgets, useFinanceCategories, useVendors } from '@/hooks/useFinanceMasterData'
import { useUpdateFinanceRequest } from '@/hooks/useFinanceRequests'

const UNSET = '__unset__'

/** The shape both review surfaces can supply. A reimbursement has no vendor —
 *  the employee already paid, there is nobody to pay instead. */
export interface Classifiable {
  id: string
  status: string
  requester_id: string
  budget_id: string | null
  finance_category_id: string | null
  vendor_id?: string | null
}

/**
 * Whether these controls belong in front of this person, for this record.
 *
 * Not authorization — finance_requests_classify decides that, and the trigger
 * decides it again for anyone who never loads a page. This decides what to
 * show, so nobody is offered a control that is about to be refused.
 *
 * Three conditions, and the third is the one that is easy to forget: holding
 * finance_staff does not make your own claim somebody else's to check. The
 * database says the same thing in protect_finance_request.
 */
export function canClassify(
  record: Pick<Classifiable, 'status' | 'requester_id'>,
  role: string | undefined,
  viewerId: string | undefined,
): boolean {
  return (
    role === 'finance_staff' &&
    record.status === 'pending_validation' &&
    !!viewerId &&
    record.requester_id !== viewerId
  )
}

/** What still has to be true before this can be forwarded. Empty means ready. */
export function missingBeforeForwarding(record: Pick<Classifiable, 'budget_id'>): string[] {
  // Budget only. It is what approval reserves against, so a request without one
  // is approved and reserves nothing. A category is for reporting, and every
  // budget already carries its own — asking twice would be asking for something
  // already known.
  return record.budget_id ? [] : ['a budget']
}

/**
 * Which budget line a request is charged to.
 *
 * The requester cannot choose this: budgets, categories and vendors are Finance
 * master data and they cannot read any of it. Deciding it is what "Finance Staff
 * check the documents and the budget" means, so it belongs to validation — and
 * after validation it is fixed, because what was approved was approved against a
 * particular line.
 *
 * This lived inside RequestDetail until F7 acceptance found the reimbursement
 * queue had no classification controls at all: /fms/reimbursements is its own
 * review surface, and the panel had never been wired into it. Extracting it was
 * the fix rather than writing a second one — a second set of controls is a
 * second set of rules to keep in step with the database.
 */
export function ClassificationPanel({
  record,
  showVendor = true,
  nextOwner = 'the Finance Manager',
}: {
  record: Classifiable
  showVendor?: boolean
  /** Who receives it when it is forwarded, so the screen says where it goes. */
  nextOwner?: string
}) {
  const { profile } = useAuth()
  const { data: budgets = [] } = useBudgets()
  const { data: categories = [] } = useFinanceCategories()
  const { data: vendors = [] } = useVendors()
  const update = useUpdateFinanceRequest()

  const [budgetId, setBudgetId] = React.useState(record.budget_id ?? UNSET)
  const [categoryId, setCategoryId] = React.useState(record.finance_category_id ?? UNSET)
  const [vendorId, setVendorId] = React.useState(record.vendor_id ?? UNSET)

  React.useEffect(() => {
    setBudgetId(record.budget_id ?? UNSET)
    setCategoryId(record.finance_category_id ?? UNSET)
    setVendorId(record.vendor_id ?? UNSET)
  }, [record.id, record.budget_id, record.finance_category_id, record.vendor_id])

  if (!canClassify(record, profile?.role, profile?.id)) return null

  const dirty =
    budgetId !== (record.budget_id ?? UNSET) ||
    categoryId !== (record.finance_category_id ?? UNSET) ||
    (showVendor && vendorId !== (record.vendor_id ?? UNSET))

  const missing = missingBeforeForwarding({ budget_id: record.budget_id })

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-semibold text-foreground">Classification</p>
        <p className="text-xs text-muted-foreground">
          Charge this to a budget before forwarding it. After it leaves you these are fixed, because
          what is approved is approved against a particular line.
        </p>
      </div>

      <div className={showVendor ? 'grid gap-3 sm:grid-cols-3' : 'grid gap-3 sm:grid-cols-2'}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="classify-budget">
            Budget <span className="text-destructive">*</span>
          </Label>
          <Select value={budgetId} onValueChange={setBudgetId}>
            <SelectTrigger id="classify-budget">
              <SelectValue placeholder="No budget" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>No budget</SelectItem>
              {/* Active only. A draft or closed budget cannot receive a
                  commitment, and the server refuses one at forwarding. */}
              {budgets
                .filter((b) => b.status === 'active' && b.id)
                .map((b) => (
                  <SelectItem key={b.id!} value={b.id!}>
                    {b.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="classify-category">Category</Label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger id="classify-category">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>None</SelectItem>
              {categories
                .filter((c) => c.kind === 'expense' && c.is_active)
                .map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        {showVendor && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="classify-vendor">Vendor</Label>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger id="classify-vendor">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>None</SelectItem>
                {vendors
                  .filter((v) => v.is_active)
                  .map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* What is still required, and where it goes next — said here rather
            than left to be discovered by pressing a disabled button. */}
        <p className="text-xs text-muted-foreground">
          {missing.length > 0
            ? `Still needed before forwarding: ${missing.join(', ')}.`
            : `Ready to forward to ${nextOwner}.`}
        </p>
        <Button
          variant="outline"
          disabled={!dirty || update.isPending}
          onClick={() =>
            update.mutate({
              id: record.id,
              values: {
                budget_id: budgetId === UNSET ? null : budgetId,
                finance_category_id: categoryId === UNSET ? null : categoryId,
                ...(showVendor ? { vendor_id: vendorId === UNSET ? null : vendorId } : {}),
              },
            })
          }
        >
          {update.isPending ? 'Saving…' : 'Save classification'}
        </Button>
      </div>
    </div>
  )
}
