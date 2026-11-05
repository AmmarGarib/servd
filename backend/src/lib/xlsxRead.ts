// Reads the FIRST worksheet of an Excel (.xlsx) file into CSV text — for bank statement imports (owner, 2026-11-05:
// "Option to import bank statement through Excel/CSV"). No library: the ZIP reader of lib/docx.ts and a small XML
// scan. Cell values only (shared strings, inline strings, numbers, booleans; formulas give their cached value). Dates
// stay Excel serial numbers — reconciliation/service.ts parseStatementDate reads them.
import { readZip } from './docx.js'
import { AppError } from './errors.js'

const bad = (msg = 'The Excel file could not be read — save it again as .xlsx (or export the statement as CSV) and upload that') =>
  new AppError('BAD_EXCEL_FILE', msg, 400)

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&')
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join('')

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function xlsxFirstSheetCsv(buf: Buffer): string {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw bad()
  let entries
  try { entries = readZip(buf) } catch { throw bad() }
  const file = new Map(entries.map((e) => [e.name.replace(/^\//, ''), e.data.toString('utf8')]))
  const shared = [...(file.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!))

  // The first sheet in the workbook's order (its relationship target), else sheet1.
  let sheetPath = 'xl/worksheets/sheet1.xml'
  const wb = file.get('xl/workbook.xml') ?? ''
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1]
  if (rid) {
    const rels = file.get('xl/_rels/workbook.xml.rels') ?? ''
    const target = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
      ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1]
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  }
  const sheet = file.get(sheetPath)
  if (!sheet) throw bad()

  const rows: string[][] = []
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = []
    let next = 0
    for (const cm of rm[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const idx = ref ? colIndex(ref) : next
      next = idx + 1
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const body = cm[2] ?? ''
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let value = ''
      if (type === 's') value = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') value = textOf(body)
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE'
      else value = v != null ? decode(v) : ''
      row[idx] = value.trim()
    }
    for (let i = 0; i < row.length; i++) row[i] ??= ''
    if (row.some((c) => c !== '')) rows.push(row)
  }
  if (rows.length === 0) throw bad('The Excel file has no rows on its first sheet')
  // Skip title rows above the header: the header is the first row naming a date column.
  const headerAt = rows.findIndex((r) => r.some((c) => /^(transaction |posted |value )?date$/i.test(c)))
  const body = headerAt > 0 ? rows.slice(headerAt) : rows
  return body.map((r) => r.map(csvCell).join(',')).join('\n')
}
