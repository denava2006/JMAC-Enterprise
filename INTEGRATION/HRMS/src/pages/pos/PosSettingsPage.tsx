import * as React from 'react'
import { Info } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { useAuth } from '@/contexts/AuthContext'
import { useBranches } from '@/hooks/useBranches'
import { useBranchFees } from '@/hooks/usePosTill'
import { peso } from '@/lib/posInventory'

/**
 * What this branch's till is configured to charge, for its POS Manager.
 *
 * Read-only, and that is the whole design rather than an unfinished screen.
 * Fees decide what every customer at this branch pays, and this system already
 * reserves customer pricing to Administrators in two other places: the trigger
 * enforce_branch_product_boundaries refuses a manager's selling price, and
 * branch_pos_settings is is_admin() for every write. Making fees editable here
 * would contradict both, so the page answers the question a manager actually
 * has -- "what is my till charging, and why is that receipt total higher than
 * the shelf price" -- without moving the authority.
 *
 * branch_pos_settings holds only fees and the payment QR path. No secret is
 * reachable from here because none is stored here: the PayMongo key, the
 * webhook secret and the Brevo key live in Edge Function secrets and Vault,
 * which no browser session can read at all.
 *
 * The SELECT policy is branch-scoped (has_pos_role(branch_id, manager|cashier)),
 * so a manager who edits the branch id in a request still sees nothing for a
 * branch they do not hold.
 */
export default function PosSettingsPage() {
  const { profile, posAccess } = useAuth()
  const { data: branches } = useBranches()
  const isAdministrator = profile?.role === 'admin'

  const myBranches = React.useMemo(() => {
    const active = (branches ?? []).filter((b) => b.is_active)
    return isAdministrator ? active : active.filter((b) => posAccess.branchIds.includes(b.id))
  }, [branches, posAccess.branchIds, isAdministrator])

  const [branchId, setBranchId] = React.useState('')
  React.useEffect(() => {
    if (!branchId && myBranches.length > 0) setBranchId(myBranches[0].id)
  }, [branchId, myBranches])

  const { data: fees, isLoading } = useBranchFees(branchId || undefined)
  const enabled = (fees ?? []).filter((f) => f.enabled)

  if (myBranches.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          You are not assigned to a branch yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">POS Settings</h2>
          <p className="text-sm text-muted-foreground">
            What this branch's till adds to a sale.
          </p>
        </div>
        {myBranches.length > 1 && (
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger className="w-52" aria-label="Branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {myBranches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <Card>
        <CardContent className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Customer fees are set by an Administrator, like product prices. This page shows what
            your till is applying so a receipt total is never a surprise — ask an Administrator to
            change it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex flex-col gap-2 p-6">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (fees ?? []).length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              This branch adds no fees. A sale totals exactly the products on it.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fee</TableHead>
                  <TableHead>Charge</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(fees ?? []).map((fee) => (
                  <TableRow key={fee.id}>
                    <TableCell className="font-medium text-foreground">{fee.name}</TableCell>
                    <TableCell className="tabular-nums text-foreground">
                      {fee.type === 'percent' ? `${fee.value}%` : peso(Number(fee.value))}
                    </TableCell>
                    <TableCell>
                      {/* A disabled fee is configuration a manager should still
                          see: it explains why a total changed last week. */}
                      <Badge variant={fee.enabled ? 'success' : 'muted'}>
                        {fee.enabled ? 'Applied' : 'Not applied'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {enabled.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {enabled.length === 1 ? 'One fee is' : `${enabled.length} fees are`} currently added to
          every sale at this branch.
        </p>
      )}
    </div>
  )
}
