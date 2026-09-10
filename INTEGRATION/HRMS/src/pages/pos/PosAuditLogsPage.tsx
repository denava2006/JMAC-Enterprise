import * as React from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { Label } from '@/components/ui/label'
import { ManagerBranchPicker, useManagerBranch } from '@/components/pos/ManagerBranchPicker'
import { PosAuditLogsView } from '@/components/pos/PosAuditLogsView'
import { useManagerAuditEvents } from '@/hooks/usePosAudit'
import type { PosReportRange } from '@/lib/posReports'
import type { PosAuditEntityType, PosAuditEventType } from '@/lib/enums'

/**
 * The audit log a POS Manager sees: their own branch, operational changes only.
 *
 * What reaches this page is decided entirely in the database.
 * `get_pos_manager_audit_events` filters on `manager_visible` in a predicate no
 * parameter can widen, and checks an active Manager assignment for the branch
 * asked about -- so an account that manages Cavite and works a till at Main
 * Office reads Cavite and nothing at Main Office, whatever this file does.
 *
 * Deliberately absent: POS access grants and revocations, and enterprise
 * catalogue changes. Those are administration, not branch operations, and stay
 * Administrator-only in this phase. Also absent: cost, COGS, margin and profit
 * -- the manager RPC declares no such column, so there is nothing here to hide.
 */
export default function PosAuditLogsPage() {
  const { branchId, setBranchId, managed, isLoading: branchesLoading } = useManagerBranch()

  const [range, setRange] = React.useState<PosReportRange | undefined>()
  const [page, setPage] = React.useState(1)
  const [eventType, setEventType] = React.useState<PosAuditEventType | undefined>()
  const [entityType, setEntityType] = React.useState<PosAuditEntityType | undefined>()

  // Changing branch resets the page: page 3 of Cavite is not page 3 of anywhere
  // else, and holding the number would show an empty page for no reason.
  const changeBranch = (id: string) => {
    setBranchId(id)
    setPage(1)
  }

  const query = useManagerAuditEvents({
    surface: 'manager',
    branchId: branchId || undefined,
    range,
    eventType,
    entityType,
    page,
  })

  const branchName = managed.find((b) => b.id === branchId)?.name ?? ''

  if (!branchesLoading && managed.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Audit logs are for the branch you manage. What your branch sells is shown on the POS
          screen.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Audit Logs"
        description={`What changed at ${branchName || 'this branch'}, who changed it, and when.`}
      />

      <PosAuditLogsView
        surface="manager"
        rows={query.data ?? []}
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        range={range}
        onRangeChange={setRange}
        page={page}
        onPageChange={setPage}
        eventType={eventType}
        onEventTypeChange={setEventType}
        entityType={entityType}
        onEntityTypeChange={setEntityType}
        emptyMessage="Nothing changed at this branch in that period."
        scopeControl={
          managed.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <Label>Branch</Label>
              <ManagerBranchPicker
                branchId={branchId}
                onChange={changeBranch}
                branches={managed}
              />
            </div>
          ) : undefined
        }
        note={
          'Branch operations: fees, payment QR, what this branch carries and offers, its selling ' +
          'prices and low-stock levels. Sales and stock movements are not repeated here — they ' +
          'are already recorded in Transactions and Inventory.'
        }
      />
    </div>
  )
}
