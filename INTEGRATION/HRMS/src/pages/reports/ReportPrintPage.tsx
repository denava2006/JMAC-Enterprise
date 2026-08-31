import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { ReportChartCard } from '@/components/reports/ReportChartCard'
import { useSystemSettings } from '@/hooks/useSystemSettings'
import type { ReportResult } from '@/lib/reportTypes'

function formatDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
}

export default function ReportPrintPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { data: settings } = useSystemSettings()
  const result = (location.state as { result?: ReportResult } | null)?.result

  if (!result) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 px-6 py-24 text-center">
        <h1 className="font-display text-2xl font-bold text-foreground">No report to display</h1>
        <p className="text-muted-foreground">Generate a report first, then export it as PDF.</p>
        <Button variant="outline" onClick={() => navigate('/dashboard/reports/new')}>
          <ArrowLeft className="h-4 w-4" />
          Back to Generate Report
        </Button>
      </div>
    )
  }

  const companyName = settings?.company_name || 'JMAC Enterprise'

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 print:p-0">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard/reports/new">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <Button size="sm" onClick={() => window.print()}>
          <Printer className="h-4 w-4" />
          Print / Save as PDF
        </Button>
      </div>

      <article className="flex flex-col gap-8 rounded-xl border border-border bg-card p-10 shadow-sm print:rounded-none print:border-0 print:shadow-none">
        <header className="flex flex-col items-center gap-1 border-b border-border pb-6 text-center">
          <h1 className="font-display text-2xl font-bold text-foreground">{companyName}</h1>
          <p className="text-sm text-muted-foreground">{result.title}</p>
          <p className="text-xs text-muted-foreground">
            {formatDate(result.filters.dateFrom)} — {formatDate(result.filters.dateTo)}
          </p>
          <p className="text-xs text-muted-foreground">Generated {new Date(result.generatedAt).toLocaleString('en-PH')}</p>
        </header>

        <section className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {result.summary.map((stat) => (
            <div key={stat.label} className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">{stat.label}</p>
              <p className="font-display text-lg font-bold text-foreground">{stat.value}</p>
            </div>
          ))}
        </section>

        {result.charts.length > 0 && (
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 print:break-inside-avoid">
            {result.charts.map((chart) => (
              <ReportChartCard key={chart.title} chart={chart} />
            ))}
          </section>
        )}

        <section className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Details</p>
          <Table>
            <TableHeader>
              <TableRow>
                {result.columns.map((col) => (
                  <TableHead key={col.key}>{col.header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((row, i) => (
                <TableRow key={i}>
                  {result.columns.map((col) => (
                    <TableCell key={col.key}>{row[col.key]}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      </article>
    </div>
  )
}
