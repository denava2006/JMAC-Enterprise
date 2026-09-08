import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { BookOpen, Scale } from 'lucide-react'
import { DataTable } from '@/components/data-table'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCalendarDate } from '@/lib/dates'
import { formatMoney } from '@/lib/currency'
import {
  JOURNAL_SOURCE_LABEL,
  moneyOrBlank,
  sourceLabel,
  type JournalEntry,
} from '@/lib/accounting'
import { useJournalEntries, useJournalEntryLines } from '@/hooks/useAccounting'

/**
 * The journal register.
 *
 * Every row here was written by the database when money actually moved. There
 * is no "New entry" button and no edit action, which is the accounting control
 * rather than an omission: an entry that a person could type is an entry that
 * does not have to match anything that happened.
 */

function EntryDetail({
  entry,
  onOpenChange,
}: {
  entry: JournalEntry | null
  onOpenChange: (open: boolean) => void
}) {
  const { data: lines = [], isLoading } = useJournalEntryLines(entry?.id ?? null)

  const totals = lines.reduce(
    (acc, l) => ({
      debit: acc.debit + Number(l.debit ?? 0),
      credit: acc.credit + Number(l.credit ?? 0),
    }),
    { debit: 0, credit: 0 },
  )

  return (
    <Sheet open={!!entry} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{entry?.journal_no ?? 'Journal entry'}</SheetTitle>
          <SheetDescription>{entry?.description}</SheetDescription>
        </SheetHeader>

        <SheetBody className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Posted</p>
              <p className="font-medium text-foreground">
                {formatCalendarDate(entry?.posting_date) ?? '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Source</p>
              <p className="font-medium text-foreground">
                {entry ? sourceLabel(entry.source_type) : '—'}
              </p>
            </div>
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground">Source document</p>
              {/* The business reference, never the row id. A person looking for
                  this transaction knows it as RB-2026-0001. */}
              <p className="font-medium text-foreground">
                {entry?.source_reference ?? 'Reference not recorded on the source'}
              </p>
            </div>
          </div>

          <div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-sm text-muted-foreground">
                      Loading lines...
                    </TableCell>
                  </TableRow>
                ) : (
                  lines.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell>
                        <p className="font-medium text-foreground">{line.account_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {line.account_code}
                          {line.line_description ? ` · ${line.line_description}` : ''}
                        </p>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {moneyOrBlank(line.debit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {moneyOrBlank(line.credit)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
                <TableRow>
                  <TableCell className="font-medium text-foreground">Total</TableCell>
                  <TableCell className="text-right font-medium tabular-nums text-foreground">
                    {formatMoney(totals.debit)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums text-foreground">
                    {formatMoney(totals.credit)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">
                Posted automatically when the source transaction was completed, and unchangeable
                afterwards. To correct an entry, correct the transaction it came from — accounting
                records what the business did, and cannot amend it from here.
              </p>
            </CardContent>
          </Card>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

export default function JournalEntriesPage() {
  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [sourceType, setSourceType] = React.useState('all')
  const [selected, setSelected] = React.useState<JournalEntry | null>(null)

  const {
    data: entries = [],
    isLoading,
    isError,
  } = useJournalEntries({
    from: from || undefined,
    to: to || undefined,
    sourceType: sourceType === 'all' ? undefined : sourceType,
  })

  const totalDebit = entries.reduce((sum, e) => sum + e.total_debit, 0)
  const totalCredit = entries.reduce((sum, e) => sum + e.total_credit, 0)

  const columns = React.useMemo<ColumnDef<JournalEntry>[]>(
    () => [
      {
        accessorKey: 'journal_no',
        header: 'Entry',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="font-medium text-foreground">{row.original.journal_no ?? '—'}</p>
            <p className="truncate text-xs text-muted-foreground">{row.original.description}</p>
          </div>
        ),
      },
      {
        accessorKey: 'posting_date',
        header: 'Posted',
        cell: ({ row }) => (
          <span className="text-sm">{formatCalendarDate(row.original.posting_date) ?? '—'}</span>
        ),
      },
      {
        id: 'source',
        header: 'Source',
        cell: ({ row }) => (
          <div className="min-w-0">
            <Badge variant="outline">{sourceLabel(row.original.source_type)}</Badge>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.original.source_reference ?? 'no reference'}
            </p>
          </div>
        ),
      },
      {
        id: 'amount',
        header: 'Amount',
        cell: ({ row }) => (
          <p className="text-right font-medium tabular-nums text-foreground">
            {formatMoney(row.original.total_debit)}
          </p>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: () => <Badge variant="outline">Posted</Badge>,
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Journal Entries"
        description="What the books recorded, and the transaction each entry came from."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Entries"
          value={entries.length}
          icon={BookOpen}
          isLoading={isLoading}
          isError={isError}
        />
        <StatCard
          label="Total debits"
          value={formatMoney(totalDebit)}
          icon={Scale}
          isLoading={isLoading}
          isError={isError}
        />
        <StatCard
          label="Total credits"
          value={formatMoney(totalCredit)}
          icon={Scale}
          isLoading={isLoading}
          isError={isError}
        />
      </div>

      <Card>
        <CardContent className="grid gap-4 py-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="journal-from">Posted from</Label>
            <Input
              id="journal-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="journal-to">Posted to</Label>
            <Input id="journal-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="journal-source">Source</Label>
            <Select value={sourceType} onValueChange={setSourceType}>
              <SelectTrigger id="journal-source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {Object.entries(JOURNAL_SOURCE_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <DataTable
        columns={columns}
        data={entries}
        isLoading={isLoading}
        searchColumn="journal_no"
        searchPlaceholder="Search by entry number..."
        density="compact"
        onRowClick={(row) => setSelected(row)}
        emptyTitle="No journal entries yet"
        emptyDescription="Entries appear here when a payment, payroll release or collection settlement completes."
      />

      <Card>
        <CardContent className="py-4">
          <p className="text-xs text-muted-foreground">
            Entries are posted by the system from completed transactions. Nothing on this page
            creates, edits or approves one — the journal follows the money, it does not authorise
            it.
          </p>
        </CardContent>
      </Card>

      <EntryDetail entry={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  )
}
