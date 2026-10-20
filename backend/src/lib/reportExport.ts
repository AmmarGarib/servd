// THE report exporter (owner, 2026-10-20: "Add option to export BS, P&L, GL,
// and any other report/account statement in PDF and Excel also").
//
// Every report and account statement is built ONCE as a ReportTable — the
// same flat records its CSV always carried — and handed to sendReport with
// the format the caller asked for:
//
//   csv   the route's CSV, byte for byte what it sent before (toCsv of the
//         records, or the route's own `csv` body when it wrote one its way).
//   xlsx  one sheet (lib/xlsxWriter): title block, bold header (frozen),
//         sections stacked under their headings, money as NUMBERS in PKR
//         (2 dp), totals bold.
//   pdf   pdf-lib, A4 (landscape over 6 columns): company, title, period,
//         the table with its header repeated on every page, money right-
//         aligned, "Page x of y", "Generated <PKT time> by servd". Text the
//         standard font cannot draw (Urdu, emoji…) is replaced, never thrown.
//
// Convention (one, everywhere): the report's existing route takes
// `?format=csv|xlsx|pdf`. A path that already ends in .csv keeps working
// (csv by default) and takes the same `?format=`. Export never widens access:
// it is the same handler, the same auth, module gate and company scope.
// A new report uses this file and the admin's ExportMenu — never its own
// exporter.

import type { FastifyReply, FastifyRequest } from 'fastify'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { prisma } from './prisma.js'
import { buildXlsx, type XlsxCell } from './xlsxWriter.js'
import { toCsv, fmtPkr } from '../modules/accounting/csv.js'
import { resolveTenantScope } from './tenantScope.js'

export type ExportFormat = 'csv' | 'xlsx' | 'pdf'
export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'xlsx', 'pdf']

/** `?format=` → an export format, or null (the route answers JSON as before). */
export function exportFormatOf(v: unknown, fallback: ExportFormat | null = null): ExportFormat | null {
  return typeof v === 'string' && (EXPORT_FORMATS as readonly string[]).includes(v) ? (v as ExportFormat) : fallback
}

export type ReportCell = string | number | null | undefined
export type ReportRow = Record<string, ReportCell>

/**
 * How a column reads in Excel / PDF (CSV is never touched):
 *   text     as is
 *   pkr      rupees — a number, or fmtPkr text ("1,234.56"); Excel gets the number
 *   cents    paisa — a number; Excel gets rupees (÷100), PDF fmtPkr
 *   number   a plain count / quantity
 *   percent  a number that already is a percentage (34.5 = 34.5%)
 */
export type ReportColumnType = 'text' | 'pkr' | 'cents' | 'number' | 'percent'

export interface ReportColumn {
  key: string
  /** Heading in Excel / PDF (the CSV header stays the key). Default: the key in words. */
  label?: string
  type?: ReportColumnType
}

export interface ReportTable {
  title: string
  /** Company names in view. Default (via reportFor): the caller's scope. */
  companies?: string[]
  /** "As at 2026-10-20" / "2026-10-01 to 2026-10-20". */
  period?: string
  generatedAt?: Date
  /** Column order (also the CSV's). Default: the keys of the first row — what toCsv(rows) always wrote. */
  columns?: ReportColumn[]
  /** Types by key, on top of `columns` (or of the first row's keys). */
  types?: Record<string, ReportColumnType>
  /** Excel / PDF headings by key. */
  labels?: Record<string, string>
  /** Keys left out of Excel / PDF (ids and other plumbing; the CSV keeps them). */
  hide?: string[]
  /** The records — exactly the CSV rows. */
  rows: ReportRow[]
  /** Excel / PDF: a new section (heading row) whenever this key's value changes; the column is not repeated. */
  sectionKey?: string
  /** Excel / PDF: which rows are totals (bold). Default: a text cell in CAPITALS such as "TOTAL ASSETS". */
  isTotal?: (row: ReportRow) => boolean
  notes?: string[]
  /** The CSV body when the route wrote its CSV another way (kept byte-identical). */
  csv?: string
  /** CSV of no rows: 'bom' (toCsv's default) or 'header' (BOM + the header line). */
  csvEmpty?: 'bom' | 'header'
}

/** File name: csv keeps the route's legacy name; xlsx / pdf add the company when one is in view. */
export interface ReportFileName { base: string; suffix?: string }

const KARACHI = 'Asia/Karachi'
export function fmtPktStamp(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: KARACHI, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d) + ' PKT'
}

/** Company names of the caller's view (the same scope the report read). */
export async function companiesInView(req: FastifyRequest): Promise<string[]> {
  const scope = await resolveTenantScope(req)
  return companyNamesOf(scope.tenantIds)
}
export async function companyNamesOf(tenantIds: string[]): Promise<string[]> {
  if (tenantIds.length === 0) return []
  const ts = await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { name: true }, orderBy: { name: 'asc' } })
  return ts.map((t) => t.name)
}

/** An array-of-arrays (header + rows) as records keyed c0, c1, … with the header as labels. */
export function fromMatrix(header: string[], matrix: unknown[][], types: Array<ReportColumnType | undefined> = []): { columns: ReportColumn[]; rows: ReportRow[] } {
  const columns = header.map((label, i) => ({ key: `c${i}`, label, type: types[i] ?? typeFromLabel(label) }))
  const rows = matrix.map((r) => Object.fromEntries(header.map((_, i) => [`c${i}`, cellOf(r[i])])) as ReportRow)
  return { columns, rows }
}
/** A heading's type when the route did not say: "(PKR)" → money, "%" / counts → number, else text. */
export function typeFromLabel(label: string): ReportColumnType {
  if (/\bPKR\b/.test(label)) return 'pkr'
  if (/%/.test(label)) return 'number'
  if (/\b(qty|orders|sold|quantity|rank|payments|lots|rating|count|days?)\b/i.test(label)) return 'number'
  return 'text'
}
function cellOf(v: unknown): ReportCell {
  if (v == null) return null
  if (typeof v === 'number' || typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (Array.isArray(v)) return v.join('; ')
  return String(v)
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function humanize(key: string): string {
  const words = key
    .replace(/Cents$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : key
}

function columnsOf(t: ReportTable): ReportColumn[] {
  const first = t.rows[0]
  const base: ReportColumn[] = t.columns && t.columns.length ? t.columns : first ? Object.keys(first).map((key) => ({ key })) : []
  return base.map((c) => ({
    key: c.key,
    label: t.labels?.[c.key] ?? c.label,
    // A *Cents column of numbers is paisa unless the route says otherwise.
    type: t.types?.[c.key] ?? c.type ?? (/Cents$/.test(c.key) && t.rows.some((r) => typeof r[c.key] === 'number') ? 'cents' : undefined),
  }))
}
/** The columns Excel and PDF show: not the section key, not hidden ones. */
function shownColumns(t: ReportTable): ReportColumn[] {
  const hide = new Set([...(t.hide ?? []), ...(t.sectionKey ? [t.sectionKey] : [])])
  return columnsOf(t).filter((c) => !hide.has(c.key))
}

const NUMERIC_TEXT = /^-?\d[\d,]*(\.\d+)?$/
/** A money / number cell as a number, or null when it is not one (text stays text). */
function numberOf(v: ReportCell, type: ReportColumnType): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? (type === 'cents' ? v / 100 : v) : null
  const s = v.trim()
  if (!NUMERIC_TEXT.test(s)) return null
  const n = Number(s.replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  return type === 'cents' ? n / 100 : n
}

const isMoney = (t: ReportColumnType | undefined) => t === 'pkr' || t === 'cents'
const isNumeric = (t: ReportColumnType | undefined) => isMoney(t) || t === 'number' || t === 'percent'

function defaultIsTotal(row: ReportRow, cols: ReportColumn[]): boolean {
  return cols.some((c) => {
    const v = row[c.key]
    return typeof v === 'string' && /[A-Z]{3}/.test(v) && v === v.toUpperCase() && /^(TOTAL|NET|GROSS|COMPANY TOTAL|OPERATING|EXCESS|CLOSING|OPENING)\b/.test(v)
  })
}

interface Section { heading: string | null; rows: ReportRow[] }
function sectionsOf(t: ReportTable): Section[] {
  if (!t.sectionKey) return [{ heading: null, rows: t.rows }]
  const out: Section[] = []
  for (const r of t.rows) {
    const h = r[t.sectionKey]
    const heading = h == null || h === '' ? '' : String(h)
    const last = out[out.length - 1]
    if (last && last.heading === heading) last.rows.push(r)
    else out.push({ heading, rows: [r] })
  }
  return out
}

/** The text a cell shows in the PDF. */
function displayOf(v: ReportCell, type: ReportColumnType | undefined): string {
  if (v == null) return ''
  if (type === 'cents' && typeof v === 'number') return fmtPkr(v)
  if (type === 'pkr' && typeof v === 'number') return fmtPkr(Math.round(v * 100))
  if (type === 'percent' && typeof v === 'number') return `${v}%`
  return String(v)
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

export function reportCsv(t: ReportTable): string {
  if (t.csv !== undefined) return t.csv
  const keys = columnsOf(t).map((c) => c.key)
  if (t.rows.length === 0) return t.csvEmpty === 'header' && keys.length ? `﻿${keys.join(',')}\r\n` : '﻿'
  return toCsv(t.rows as Array<Record<string, string | number | null | undefined>>, t.columns ? keys : undefined)
}

// ─── Excel ───────────────────────────────────────────────────────────────────

export function reportXlsx(t: ReportTable): Buffer {
  const cols = shownColumns(t)
  const isTotal = t.isTotal ?? ((r: ReportRow) => defaultIsTotal(r, cols))
  const at = t.generatedAt ?? new Date()
  const rows: XlsxCell[][] = []
  rows.push([{ v: t.title, s: 'title' }])
  if (t.companies?.length) rows.push([t.companies.join(', ')])
  if (t.period) rows.push([t.period])
  const anyMoney = cols.some((c) => isMoney(c.type))
  rows.push([`${anyMoney ? 'Amounts in PKR · ' : ''}Generated ${fmtPktStamp(at)} by servd`])
  rows.push([])
  rows.push(cols.map((c) => ({ v: c.label ?? humanize(c.key), s: 'header' as const })))
  const freezeRows = rows.length
  const widths = cols.map((c) => Math.max(8, (c.label ?? humanize(c.key)).length + 2))

  for (const sec of sectionsOf(t)) {
    if (sec.heading) rows.push([{ v: sec.heading, s: 'bold' }])
    for (const r of sec.rows) {
      const bold = isTotal(r)
      rows.push(cols.map((c, i) => {
        const v = r[c.key]
        const type = c.type ?? 'text'
        if (isNumeric(type)) {
          const n = numberOf(v, type)
          if (n !== null) {
            widths[i] = Math.max(widths[i]!, 14)
            if (isMoney(type)) return { v: n, s: bold ? 'boldAmount' : 'amount' }
            if (type === 'percent') return { v: n / 100, s: 'percent' }
            return bold ? { v: n, s: 'bold' } : n
          }
        }
        if (v == null || v === '') return null
        const s = String(v)
        widths[i] = Math.min(60, Math.max(widths[i]!, s.length + 2))
        return bold ? { v: s, s: 'bold' } : s
      }))
    }
  }
  if (t.notes?.length) {
    rows.push([])
    for (const n of t.notes) rows.push([n])
  }
  return buildXlsx({ name: t.title, widths, rows, freezeRows })
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 36
const INK = rgb(0.15, 0.06, 0.22)       // ERP ink #261038
const MUTED = rgb(0.42, 0.36, 0.49)     // #6b5b7c
const PRIMARY = rgb(0.416, 0.051, 0.678) // #6a0dad
const RULE = rgb(0.85, 0.82, 0.89)
const HEAD_FILL = rgb(0.953, 0.933, 0.98) // #f3eefa

/** Characters the standard font can draw; anything else becomes "?" (never a throw). */
function safeTextFor(font: PDFFont): (s: string) => string {
  const ok = new Set(font.getCharacterSet())
  return (s: string) => {
    let out = ''
    for (const ch of s.replace(/[\r\n\t]+/g, ' ')) {
      const cp = ch.codePointAt(0)!
      if (ok.has(cp)) out += ch
      else if (cp === 0x2011 || cp === 0x2010) out += '-'
      else if (cp === 0x00a0 || cp === 0x202f) out += ' '
      else out += '?'
    }
    return out
  }
}

function fit(font: PDFFont, size: number, text: string, width: number): string {
  if (width <= 0) return ''
  if (font.widthOfTextAtSize(text, size) <= width) return text
  const ell = '…'
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (font.widthOfTextAtSize(text.slice(0, mid) + ell, size) <= width) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + ell
}

export async function reportPdf(t: ReportTable): Promise<Buffer> {
  const cols = shownColumns(t)
  const isTotal = t.isTotal ?? ((r: ReportRow) => defaultIsTotal(r, cols))
  const at = t.generatedAt ?? new Date()
  const doc = await PDFDocument.create()
  doc.setTitle(t.title)
  doc.setProducer('servd')
  doc.setCreator('servd')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const safe = safeTextFor(font)
  const landscape = cols.length > 6
  const [pw, ph] = landscape ? [A4[1], A4[0]] : A4
  const size = cols.length > 10 ? 6.5 : cols.length > 6 ? 7.5 : 8.5
  const rowH = size + 5
  const usable = pw - MARGIN * 2

  // Column widths from the content (capped), scaled to the page.
  const sections = sectionsOf(t)
  const allRows = sections.flatMap((s) => s.rows)
  const sample = allRows.length > 400 ? allRows.slice(0, 400) : allRows
  const natural = cols.map((c) => {
    const head = bold.widthOfTextAtSize(safe(c.label ?? humanize(c.key)), size)
    let w = head
    for (const r of sample) w = Math.max(w, font.widthOfTextAtSize(safe(displayOf(r[c.key], c.type)), size))
    return Math.min(Math.max(w + 8, 28), isNumeric(c.type) ? 110 : 260)
  })
  const sum = natural.reduce((s, w) => s + w, 0) || 1
  let widths = natural.map((w) => (w / sum) * usable)
  // Too wide: dates, codes and amounts keep their full width (never cut to "2026-10…" or "2,204,00…"); only the
  // long text columns (account names, memos) give up room. Falls back to plain scaling if even that cannot fit.
  const keepsWidth = (c: ReportColumn, i: number) => isNumeric(c.type) || natural[i]! <= 80
  const fixedSum = natural.reduce((s, w, i) => s + (keepsWidth(cols[i]!, i) ? w : 0), 0)
  const flexSum = sum - fixedSum
  if (sum > usable && flexSum > 0 && usable - fixedSum >= 60 * cols.filter((c, i) => !keepsWidth(c, i)).length) {
    widths = natural.map((w, i) => (keepsWidth(cols[i]!, i) ? w : (w / flexSum) * (usable - fixedSum)))
  }
  if (sum < usable) {
    // Spare room goes to the text columns.
    const textIdx = cols.map((c, i) => (isNumeric(c.type) ? -1 : i)).filter((i) => i >= 0)
    const spare = usable - sum
    widths = natural.map((w, i) => w + (textIdx.length ? (textIdx.includes(i) ? spare / textIdx.length : 0) : spare / cols.length))
  }
  const alignRight = cols.map((c) => isNumeric(c.type))

  const pages: PDFPage[] = []
  let page!: PDFPage
  let y = 0

  const header = (first: boolean) => {
    page = doc.addPage([pw, ph])
    pages.push(page)
    y = ph - MARGIN
    page.drawRectangle({ x: MARGIN, y: y - 2, width: usable, height: 2, color: PRIMARY })
    y -= 16
    const co = safe(t.companies?.length ? t.companies.join(', ') : 'servd')
    page.drawText(fit(font, 9, co, usable), { x: MARGIN, y, size: 9, font, color: MUTED })
    y -= first ? 18 : 14
    page.drawText(fit(bold, first ? 15 : 11, safe(t.title), usable), { x: MARGIN, y, size: first ? 15 : 11, font: bold, color: INK })
    if (t.period) {
      y -= 13
      page.drawText(fit(font, 9, safe(t.period), usable), { x: MARGIN, y, size: 9, font, color: MUTED })
    }
    y -= 16
    // Column header (repeated on every page).
    page.drawRectangle({ x: MARGIN, y: y - 3, width: usable, height: rowH, color: HEAD_FILL })
    let x = MARGIN
    cols.forEach((c, i) => {
      const w = widths[i]!
      const txt = fit(bold, size, safe(c.label ?? humanize(c.key)), w - 6)
      const tw = bold.widthOfTextAtSize(txt, size)
      page.drawText(txt, { x: alignRight[i] ? x + w - 3 - tw : x + 3, y, size, font: bold, color: INK })
      x += w
    })
    y -= rowH
  }
  const ensure = (h: number) => { if (y - h < MARGIN + 20) header(false) }

  header(true)
  if (allRows.length === 0) {
    page.drawText('Nothing to show for this period.', { x: MARGIN + 3, y, size, font, color: MUTED })
    y -= rowH
  }
  for (const sec of sections) {
    if (sec.heading) {
      ensure(rowH * 2)
      y -= 3
      page.drawText(fit(bold, size + 0.5, safe(sec.heading), usable), { x: MARGIN, y, size: size + 0.5, font: bold, color: PRIMARY })
      y -= rowH
    }
    for (const r of sec.rows) {
      ensure(rowH)
      const isT = isTotal(r)
      const f = isT ? bold : font
      if (isT) page.drawLine({ start: { x: MARGIN, y: y + size + 1.5 }, end: { x: MARGIN + usable, y: y + size + 1.5 }, thickness: 0.6, color: MUTED })
      let x = MARGIN
      cols.forEach((c, i) => {
        const w = widths[i]!
        const raw = displayOf(r[c.key], c.type)
        const right = alignRight[i] || (typeof r[c.key] === 'string' && NUMERIC_TEXT.test(String(r[c.key]).trim()))
        const txt = fit(f, size, safe(raw), w - 6)
        if (txt) {
          const tw = f.widthOfTextAtSize(txt, size)
          page.drawText(txt, { x: right ? x + w - 3 - tw : x + 3, y, size, font: f, color: INK })
        }
        x += w
      })
      y -= rowH
      if (!isT) page.drawLine({ start: { x: MARGIN, y: y + size + 1 }, end: { x: MARGIN + usable, y: y + size + 1 }, thickness: 0.2, color: RULE })
    }
  }
  if (t.notes?.length) {
    y -= 4
    for (const n of t.notes) {
      ensure(rowH)
      page.drawText(fit(font, size, safe(n), usable), { x: MARGIN, y, size, font, color: MUTED })
      y -= rowH
    }
  }

  const footer = safe(`Generated ${fmtPktStamp(at)} by servd`)
  pages.forEach((p, i) => {
    p.drawText(footer, { x: MARGIN, y: MARGIN - 14, size: 7.5, font, color: MUTED })
    const label = `Page ${i + 1} of ${pages.length}`
    p.drawText(label, { x: pw - MARGIN - font.widthOfTextAtSize(label, 7.5), y: MARGIN - 14, size: 7.5, font, color: MUTED })
  })
  return Buffer.from(await doc.save())
}

// ─── Send ────────────────────────────────────────────────────────────────────

const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-')

export function reportFileName(format: ExportFormat, name: ReportFileName | string, companies?: string[]): string {
  // A plain string is the whole name; { base, suffix } gets the company (xlsx / pdf, one company in view).
  if (typeof name === 'string') return `${safeName(name)}.${format}`
  const n = name
  const co = format !== 'csv' && companies?.length === 1 ? slug(companies[0]!) : ''
  const parts = [n.base, co, n.suffix ?? ''].filter(Boolean)
  return `${safeName(parts.join('-'))}.${format}`
}

/** Renders the table in the asked format and sends it as an attachment. */
export async function sendReport(reply: FastifyReply, format: ExportFormat, name: ReportFileName | string, t: ReportTable) {
  const body = format === 'csv' ? reportCsv(t) : format === 'xlsx' ? reportXlsx(t) : await reportPdf(t)
  reply.header('Content-Type', CONTENT_TYPE[format])
  reply.header('Content-Disposition', `attachment; filename="${reportFileName(format, name, t.companies)}"`)
  return reply.send(body)
}

/**
 * The common case: fill in the companies of the caller's view (for xlsx / pdf
 * only — CSV never needed them) and send.
 */
export async function sendReportFor(req: FastifyRequest, reply: FastifyReply, format: ExportFormat, name: ReportFileName | string, t: ReportTable) {
  const companies = t.companies ?? (format === 'csv' ? undefined : await companiesInView(req))
  return sendReport(reply, format, name, { ...t, companies })
}
