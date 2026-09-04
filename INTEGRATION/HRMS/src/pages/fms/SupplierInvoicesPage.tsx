import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ColumnDef } from '@tanstack/react-table'
import { FileText, Clock, AlertTriangle } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { useAuth } from '@/contexts/AuthContext'
import { formatMoney } from '@/lib/currency'
import {
  invoiceStateLabel,
  useSupplierInvoices,
  type SupplierInvoice,
} from '@/hooks/useSupplierInvoices'
import { SupplierInvoiceBuilder } from '@/components/fms/SupplierInvoiceBuilder'
import { SupplierInvoiceDetail } from '@/components/fms/SupplierInvoiceDetail'

type Scope = 'invoices' | 'payables'

/**
 * Supplier invoices, and what the company owes on them.
 *
 * One page rather than two: an account payable is not a separate document, it
 * is an approved supplier invoice that nobody has paid. Splitting them into
 * two screens would mean maintaining two lists of the same rows and explaining
 * the difference to people who already understand it.
 *
 * Nothing here pays anything. An approved invoice sits at Awaiting payment
 * because the phase that settles it does not exist yet, and saying so plainly
 * is better than a status that implies otherwise.
 */
export default function SupplierInvoicesPage() {
  const { profile } = useAuth()
  const { data: invoices = [], isLoading, isError, error } = useSupplierInvoices()
  const [scope, setScope] = React.useState<Scope>('invoices')
  // ?record=1 arrives from the Overview's "Delivered orders awaiting invoice",
  // so that count lands on the thing it is counting rather than on a list of
  // invoices, which is a different figure entirely.
  const [search, setSearch] = useSearchParams()
  const [creating, setCreating] = React.useState(search.get('record') === '1')
  const [openInvoice, setOpenInvoice] = React.useState<string | null>(null)

  // Recording an invoice is the Accountant's. The Finance Manager reviews what
  // was recorded, so they get no New invoice button -- a checker who can author
  // the document is approving their own work under another name.
  const canRecord = profile?.role === 'accountant'

  // The parameter has done its job once the dialog is open; leaving it in the
  // URL would reopen the builder on every back-navigation.
  React.useEffect(() => {
    if (search.get('record') !== '1') return
    const next = new URLSearchParams(search)
    next.delete('record')
    setSearch(next, { replace: true })
  }, [search, setSearch])

  const payables = invoices.filter((i) => i.status === 'approved')
  const owed = payables.reduce((sum, i) => sum + Number(i.balance_due ?? 0), 0)
  const overdue = payables.filter((i) => i.payment_state === 'overdue')
  const awaitingReview = invoices.filter((i) => i.status === 'for_review')

  const rows = scope === 'payables' ? payables : invoices

  const columns = React.useMemo<ColumnDef<SupplierInvoice>[]>(
    () => [
      {
        accessorKey: 'supplier_invoice_number',
        header: 'Invoice',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">
              {row.original.supplier_invoice_number}
            </p>
            <p className="font-mono text-xs text-muted-foreground">{row.original.invoice_no}</p>
          </div>
        ),
      },
      {
        accessorKey: 'vendor_name',
        header: 'Supplier',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate text-foreground">{row.original.vendor_name}</p>
            <p className="font-mono text-xs text-muted-foreground">{row.original.po_number}</p>
          </div>
        ),
      },
      {
        accessorKey: 'invoice_date',
        header: 'Dated',
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">{row.original.invoice_date}</span>
        ),
      },
      {
        accessorKey: 'due_date',
        header: 'Due',
        cell: ({ row }) => {
          const state = row.original.payment_state
          const days = row.original.days_until_due
          if (!row.original.due_date) return <span className="text-muted-foreground">—</span>
          return (
            <div className="min-w-0">
              <p className="tabular-nums text-foreground">{row.original.due_date}</p>
              {state && (
                <p
                  className={
                    state === 'overdue'
                      ? 'text-xs font-medium text-destructive'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  {state === 'overdue'
                    ? `${Math.abs(Number(days ?? 0))} day(s) overdue`
                    : `in ${days} day(s)`}
                </p>
              )}
            </div>
          )
        },
      },
      {
        id: 'total',
        header: 'Total',
        cell: ({ row }) => (
          <span className="tabular-nums">{formatMoney(Number(row.original.total_amount ?? 0))}</span>
        ),
      },
      {
        id: 'balance',
        header: 'Balance due',
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">
            {row.original.status === 'approved'
              ? formatMoney(Number(row.original.balance_due ?? 0))
              : '—'}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.status === 'approved'
                ? 'success'
                : ['rejected', 'voided'].includes(row.original.status ?? '')
                  ? 'destructive'
                  : row.original.status === 'returned'
                    ? 'warning'
                    : 'secondary'
            }
          >
            {invoiceStateLabel(row.original)}
          </Badge>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Supplier Invoices"
        description="What suppliers have billed for delivered goods, and what the company owes on it."
        action={
          canRecord ? (
            <Button onClick={() => setCreating(true)}>
              <FileText className="h-4 w-4" />
              Record invoice
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Awaiting review" value={awaitingReview.length} icon={Clock} isLoading={isLoading} />
        <StatCard label="Payable invoices" value={payables.length} icon={FileText} isLoading={isLoading} />
        <StatCard label="Total owed" value={formatMoney(owed)} icon={FileText} isLoading={isLoading} />
        <StatCard label="Overdue" value={overdue.length} icon={AlertTriangle} isLoading={isLoading} />
      </div>

      <p className="-mt-2 text-xs text-muted-foreground">
        An approved invoice is a debt the company acknowledges, not a payment. Nothing here moves
        money, changes a budget, or touches branch stock — supplier payment is a later phase.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant={scope === 'invoices' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setScope('invoices')}
        >
          All invoices ({invoices.length})
        </Button>
        <Button
          variant={scope === 'payables' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setScope('payables')}
        >
          Accounts payable ({payables.length})
        </Button>
      </div>

      {isError ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm font-medium text-destructive">
              Supplier invoices could not be loaded.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {(error as { message?: string } | null)?.message ??
                'Try again, and tell an administrator if it persists.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          searchColumn="supplier_invoice_number"
          searchPlaceholder="Search by invoice number..."
          emptyTitle={
            scope === 'payables' ? 'Nothing is payable yet' : 'No supplier invoices yet'
          }
          emptyDescription={
            scope === 'payables'
              ? 'An invoice appears here once a Finance Manager has approved it.'
              : 'Record one against a purchase order whose goods have arrived.'
          }
          onRowClick={(row) => row.id && setOpenInvoice(row.id)}
        />
      )}

      <SupplierInvoiceBuilder
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => {
          setCreating(false)
          setOpenInvoice(id)
        }}
      />
      <SupplierInvoiceDetail
        invoiceId={openInvoice}
        onOpenChange={(open) => !open && setOpenInvoice(null)}
      />
    </div>
  )
}
