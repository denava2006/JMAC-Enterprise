import ExcelJS from 'exceljs'
import { saveAs } from 'file-saver'
import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun, WidthType } from 'docx'
import type { ReportResult } from '@/lib/reportTypes'

function fileBaseName(result: ReportResult): string {
  const date = new Date(result.generatedAt).toISOString().slice(0, 10)
  return `${result.title.replace(/\s+/g, '-')}_${date}`
}

export async function downloadReportAsExcel(result: ReportResult): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'JMAC Enterprise'
  workbook.created = new Date()

  const summarySheet = workbook.addWorksheet('Summary')
  summarySheet.columns = [
    { header: 'Metric', key: 'label', width: 32 },
    { header: 'Value', key: 'value', width: 24 },
  ]
  summarySheet.getRow(1).font = { bold: true }
  for (const stat of result.summary) summarySheet.addRow({ label: stat.label, value: stat.value })

  const detailSheet = workbook.addWorksheet('Details')
  detailSheet.columns = result.columns.map((c) => ({ header: c.header, key: c.key, width: 22 }))
  detailSheet.getRow(1).font = { bold: true }
  for (const row of result.rows) detailSheet.addRow(row)

  const buffer = await workbook.xlsx.writeBuffer()
  saveAs(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileBaseName(result)}.xlsx`)
}

export async function downloadReportAsDocx(result: ReportResult): Promise<void> {
  const summaryParagraphs = result.summary.map(
    (stat) =>
      new Paragraph({
        children: [new TextRun({ text: `${stat.label}: `, bold: true }), new TextRun(stat.value)],
      })
  )

  const headerRow = new TableRow({
    children: result.columns.map(
      (col) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: col.header, bold: true })] })],
        })
    ),
  })
  const dataRows = result.rows.map(
    (row) =>
      new TableRow({
        children: result.columns.map((col) => new TableCell({ children: [new Paragraph(String(row[col.key] ?? ''))] })),
      })
  )

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: result.title, heading: HeadingLevel.TITLE }),
          new Paragraph({ text: `Period: ${result.filters.dateFrom} to ${result.filters.dateTo}` }),
          new Paragraph({ text: `Generated: ${new Date(result.generatedAt).toLocaleString('en-PH')}` }),
          new Paragraph({ text: '' }),
          new Paragraph({ text: 'Summary', heading: HeadingLevel.HEADING_1 }),
          ...summaryParagraphs,
          new Paragraph({ text: '' }),
          new Paragraph({ text: 'Details', heading: HeadingLevel.HEADING_1 }),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...dataRows] }),
        ],
      },
    ],
  })

  const blob = await Packer.toBlob(doc)
  saveAs(blob, `${fileBaseName(result)}.docx`)
}
