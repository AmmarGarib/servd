// A bank statement PDF → the statement CSV that parseStatementCsv reads (owner, 2026-11-06: "Add pdf format option
// also for bank statement import").
//
// Only a PDF the bank GENERATED (its text is in the file) can be read. A scanned / photographed statement has no
// text — it is refused with a plain message (export the CSV / Excel instead); nothing guesses at an image.
//
// How the table is found: the words of each page are grouped into lines by their height on the page; the header line
// is the first one that names a date column and either an amount column or debit + credit columns (the same words
// parseStatementCsv accepts, plus the usual variants — "Txn Date", "Withdrawal", "Deposit", "Narration"…). Each word
// below it goes to the column whose header it sits under (boundaries halfway between the headers' centres). A line
// whose date cell is a date starts a transaction; a line with no date and no amount adds to the previous one's
// description (narrations that wrap); everything else (page footers, totals, "balance b/f") is ignored. A page with
// no header of its own (continuation pages) keeps the previous page's columns. The balance column is read only as a
// boundary — the import's opening / closing balances are typed on the form, as for CSV and Excel.
import { AppError } from '../../lib/errors.js'
import { parseStatementDate } from './service.js'

type Role = 'date' | 'description' | 'reference' | 'debit' | 'credit' | 'amount' | 'balance' | 'other'

interface Word { x: number; right: number; y: number; text: string }
interface Column { role: Role; left: number; right: number; center: number }

const bad = (msg: string) => new AppError('BAD_PDF_STATEMENT', msg, 400)

function roleOf(header: string): Role {
  const h = header.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!h) return 'other'
  if (/\bbalance\b/.test(h)) return 'balance'
  if (/\bdate\b|\bdt\b/.test(h)) return 'date'
  if (/\b(debit|debits|withdrawal|withdrawals|dr|paid out|payments?)\b/.test(h)) return 'debit'
  if (/\b(credit|credits|deposit|deposits|cr|paid in|receipts?)\b/.test(h)) return 'credit'
  if (/\b(amount|value)\b/.test(h)) return 'amount'
  if (/\b(cheque|chq|ref|reference|instrument|txn id|transaction id)\b/.test(h)) return 'reference'
  if (/\b(description|narration|particulars|details|remarks|transaction)\b/.test(h)) return 'description'
  return 'other'
}

/** Words of one page, grouped into lines (top to bottom), each line left to right. */
function linesOf(words: Word[]): Word[][] {
  const sorted = [...words].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Word[][] = []
  for (const w of sorted) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last[0]!.y - w.y) <= 3) last.push(w)
    else lines.push([w])
  }
  return lines.map((l) => l.sort((a, b) => a.x - b.x))
}

/** Adjacent words of a line joined into cells (a gap wider than ~1.5 characters starts a new cell). */
function cellsOf(line: Word[]): Word[] {
  const out: Word[] = []
  for (const w of line) {
    const prev = out[out.length - 1]
    if (prev && w.x - prev.right < 6) {
      prev.text = `${prev.text}${w.x - prev.right > 0.8 ? ' ' : ''}${w.text}`
      prev.right = Math.max(prev.right, w.right)
    } else out.push({ ...w })
  }
  return out
}

function headerColumns(line: Word[]): Column[] | null {
  const cells = cellsOf(line)
  const roles = cells.map((c) => roleOf(c.text))
  const has = (r: Role) => roles.includes(r)
  if (!has('date') || !(has('amount') || (has('debit') && has('credit')))) return null
  const cols = cells.map((c, i) => ({ role: roles[i]!, center: (c.x + c.right) / 2, left: 0, right: 0 }))
  // Two date columns (transaction + value date): the first is the date, the second only a boundary.
  let seenDate = false
  for (const c of cols) { if (c.role === 'date') { if (seenDate) c.role = 'other'; seenDate = true } }
  for (let i = 0; i < cols.length; i++) {
    cols[i]!.left = i === 0 ? -Infinity : (cols[i - 1]!.center + cols[i]!.center) / 2
    cols[i]!.right = i === cols.length - 1 ? Infinity : (cols[i]!.center + cols[i + 1]!.center) / 2
  }
  return cols
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const isMoney = (v: string) => /^\(?-?(PKR|Rs\.?)?\s*[\d,]+(\.\d+)?\)?\s*(CR|DR|Cr|Dr|cr|dr)?$/.test(v.trim())

/** A cell's date, or null: the whole cell, or the date at its start ("01-Nov-2026 10:42"). */
function dateIn(v: string): string | null {
  const t = v.trim()
  if (!t) return null
  for (const cand of [t, t.split(/\s+/)[0]!, t.split(/\s+/).slice(0, 3).join(' ')]) {
    if (!/\d/.test(cand)) continue
    if (/^\d{5}(\.\d+)?$/.test(cand)) continue // an Excel serial is not a printed date
    if (!isNaN(parseStatementDate(cand).getTime())) return cand
  }
  return null
}

/** Rows of [date, description, reference, debit, credit, amount] from the extracted pages. */
export function statementRowsFromPages(pages: Word[][]): string[][] {
  let cols: Column[] | null = null
  const rows: string[][] = []
  let current: string[] | null = null
  for (const words of pages) {
    for (const line of linesOf(words)) {
      const hdr = headerColumns(line)
      if (hdr) { cols = hdr; current = null; continue }
      if (!cols) continue
      const cell: Record<Role, string[]> = { date: [], description: [], reference: [], debit: [], credit: [], amount: [], balance: [], other: [] }
      for (const w of cellsOf(line)) {
        const mid = (w.x + w.right) / 2
        const col = cols.find((c) => mid >= c.left && mid < c.right) ?? cols[cols.length - 1]!
        cell[col.role].push(w.text)
      }
      const get = (r: Role) => cell[r].join(' ').trim()
      const date = dateIn(get('date'))
      const money = (r: Role) => { const v = get(r); return v && isMoney(v) ? v : '' }
      if (date) {
        current = [date, get('description'), get('reference'), money('debit'), money('credit'), money('amount')]
        rows.push(current)
      } else if (current && !money('debit') && !money('credit') && !money('amount') && !get('balance')) {
        const more = [get('description'), get('other')].filter(Boolean).join(' ')
        if (more) current[1] = `${current[1]} ${more}`.trim()
        if (get('reference') && !current[2]) current[2] = get('reference')
      } else {
        current = null
      }
    }
  }
  return rows
}

/** The statement CSV (header + rows) parseStatementCsv reads. */
export function statementCsvFromRows(rows: string[][]): string {
  const useSplit = rows.some((r) => r[3] || r[4])
  const signed = (v: string) => {
    // "1,000.00 DR" / "1,000.00 CR" in a single amount column.
    const m = /^(.*?)\s*(CR|DR)$/i.exec(v.trim())
    if (!m) return v
    return m[2]!.toUpperCase() === 'DR' ? `-${m[1]!.replace(/^-/, '')}` : m[1]!
  }
  const head = useSplit ? 'date,description,reference,debit,credit' : 'date,description,reference,amount'
  const body = rows
    .filter((r) => (useSplit ? r[3] || r[4] : r[5]))
    .map((r) => (useSplit
      ? [r[0]!, r[1]!, r[2]!, r[3]!.replace(/\s*(CR|DR)$/i, ''), r[4]!.replace(/\s*(CR|DR)$/i, '')]
      : [r[0]!, r[1]!, r[2]!, signed(r[5]!)]).map(csvCell).join(','))
  return [head, ...body].join('\n')
}

/** Reads a text PDF bank statement into statement CSV. */
export async function pdfStatementCsv(buf: Buffer): Promise<string> {
  if (buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw bad('That file is not a PDF.')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  let doc
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise
  } catch {
    throw bad('The PDF could not be opened — if it is password-protected, save a copy without the password, or export the statement as CSV / Excel.')
  }
  if (doc.numPages > 200) throw bad('The PDF has more than 200 pages — import it month by month.')
  const pages: Word[][] = []
  let anyText = false
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const words: Word[] = []
    for (const it of content.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
      const text = (it.str ?? '').trim()
      if (!text || !it.transform) continue
      anyText = true
      const x = it.transform[4]!, y = it.transform[5]!
      words.push({ x, right: x + (it.width ?? 0), y, text })
    }
    pages.push(words)
    page.cleanup()
  }
  await doc.destroy()
  if (!anyText) throw bad('This PDF is a scanned image with no text in it — download the statement from internet banking as PDF, CSV or Excel.')
  const rows = statementRowsFromPages(pages)
  if (rows.length === 0) {
    throw bad('No transaction table was found in the PDF — it needs a header row with a date column and an amount (or debit and credit) column. Export the statement as CSV or Excel instead.')
  }
  return statementCsvFromRows(rows)
}
