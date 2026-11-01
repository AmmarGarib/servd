// The payslip as a PDF (owner, 2026-11-01: "Page: A4 portrait. Font: Arial, Inter or Aptos. Primary colour: navy
// blue. Secondary colour: light grey. Net payable: prominent dark-blue section. Layout: minimalist, structured
// tables, generous spacing. Output: PDF, with automatic generation from the payroll system.")
//
// Made by the server from the payslip itself — the same figures as the screen (payslipBreakup.ts, the one
// reading) and the particulars (payslipDocument.ts). Display only; nothing is stored. Font: Helvetica, the PDF
// standard font with Arial's metrics (no font file to ship). The company's uploaded header picture (PNG / JPEG)
// replaces the company name at the top left.
//
//   Header (company · PAYSLIP <month>) → Employee information → 01 Earnings → 02 Deductions → NET PAYABLE
//   (navy band, amount in words) → payment period and status.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from 'pdf-lib'
import { safeTextFor } from '../../lib/reportExport.js'
import type { SalaryBreakup } from './payslipBreakup.js'
import type { PayslipParticulars } from './payslipDocument.js'

export interface PayslipPdfInput {
  companyName: string
  period: string // YYYY-MM
  header: string | null // data URL
  particulars: PayslipParticulars
  breakup: SalaryBreakup
  paid: boolean
}

const NAVY = rgb(0x1b / 255, 0x25 / 255, 0x55 / 255)
const INK = rgb(0x1f / 255, 0x23 / 255, 0x2b / 255)
const MUTED = rgb(0x6b / 255, 0x72 / 255, 0x80 / 255)
const GREY = rgb(0xf2 / 255, 0xf3 / 255, 0xf5 / 255)
const LINE = rgb(0xe3 / 255, 0xe5 / 255, 0xe9 / 255)
const WHITE = rgb(1, 1, 1)
const PAGE: [number, number] = [595.28, 841.89] // A4 portrait
const M = 48

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const monthTitle = (period: string) => {
  const [y, m] = period.split('-').map(Number)
  return y && m ? `${MONTHS[m - 1]} ${y}` : period
}
const fmtDate = (d: string | null) => {
  if (!d) return '—'
  const [y, m, dd] = d.split('-').map(Number)
  return y && m && dd ? `${dd} ${MONTHS[m - 1]} ${y}` : d
}
/** Whole rupees with thousands separators (paisa rounded). */
export const pkr = (cents: number) => {
  const r = Math.round(cents / 100)
  return (r < 0 ? '-' : '') + Math.abs(r).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
function under1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100
  const rest = r < 20 ? ONES[r]! : TENS[Math.floor(r / 10)]! + (r % 10 ? `-${ONES[r % 10]}` : '')
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ')
}
/** "One Hundred Fifteen Thousand Seventy-Four Rupees Only". */
export function rupeesInWords(cents: number): string {
  let n = Math.round(Math.abs(cents) / 100)
  if (n === 0) return 'Zero Rupees Only'
  const parts: string[] = []
  for (const [size, name] of [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand'], [1, '']] as Array<[number, string]>) {
    const q = Math.floor(n / size)
    if (q) { parts.push(`${under1000(q)}${name ? ` ${name}` : ''}`); n -= q * size }
  }
  return `${cents < 0 ? 'Minus ' : ''}${parts.join(' ')} Rupees Only`
}

async function embedHeader(doc: PDFDocument, dataUrl: string | null): Promise<PDFImage | null> {
  const m = dataUrl && /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) return null
  try {
    const bytes = Buffer.from(m[2]!, 'base64')
    return m[1] === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
  } catch { return null }
}

/** One payslip per page; many payslips (a whole run) make one PDF. */
export async function payslipsPdf(slips: PayslipPdfInput[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setTitle(slips.length === 1 ? `Payslip ${slips[0]!.particulars.employeeCode} ${slips[0]!.period}` : `Payslips ${slips[0]?.period ?? ''}`)
  doc.setProducer('servd'); doc.setCreator('servd')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const safe = safeTextFor(font)
  const images = new Map<string, PDFImage | null>()
  for (const s of slips) {
    if (s.header && !images.has(s.header)) images.set(s.header, await embedHeader(doc, s.header))
    drawPayslip(doc.addPage(PAGE), s, { font, bold, safe, logo: s.header ? images.get(s.header) ?? null : null })
  }
  return Buffer.from(await doc.save())
}

function drawPayslip(page: PDFPage, s: PayslipPdfInput, f: { font: PDFFont; bold: PDFFont; safe: (x: string) => string; logo: PDFImage | null }) {
  const { font, bold, safe } = f
  const W = PAGE[0], R = W - M
  const text = (t: string, x: number, y: number, o: { size?: number; b?: boolean; color?: ReturnType<typeof rgb>; right?: boolean; maxW?: number } = {}) => {
    const fnt = o.b ? bold : font, size = o.size ?? 9.5
    let str = safe(t)
    if (o.maxW) while (str.length > 1 && fnt.widthOfTextAtSize(str, size) > o.maxW) str = str.slice(0, -2) + '…'
    const w = fnt.widthOfTextAtSize(str, size)
    page.drawText(str, { x: o.right ? x - w : x, y, size, font: fnt, color: o.color ?? INK })
    return w
  }
  const hr = (y: number, color = LINE, x1 = M, x2 = R) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.7, color })
  const pill = (label: string, x: number, y: number, right = false) => {
    const size = 7.5, w = bold.widthOfTextAtSize(safe(label), size) + 14
    const left = right ? x - w : x
    page.drawRectangle({ x: left, y: y - 4, width: w, height: 14, color: GREY, borderColor: LINE, borderWidth: 0.5 })
    page.drawText(safe(label), { x: left + 7, y: y + 0.5, size, font: bold, color: NAVY })
  }

  // ── Header ──
  let y = PAGE[1] - M
  const boxW = 120, boxH = 50
  page.drawRectangle({ x: R - boxW, y: y - boxH, width: boxW, height: boxH, color: NAVY })
  text('PAYSLIP', R - boxW + 12, y - 20, { size: 14, b: true, color: WHITE })
  text(monthTitle(s.period).toUpperCase(), R - boxW + 12, y - 37, { size: 8.5, b: true, color: WHITE })
  if (f.logo) {
    const h = 46, w = Math.min((f.logo.width / f.logo.height) * h, W - 2 * M - boxW - 24)
    page.drawImage(f.logo, { x: M, y: y - h, width: w, height: (w / f.logo.width) * f.logo.height })
  } else {
    text(s.companyName.toUpperCase(), M, y - 20, { size: 17, b: true, color: NAVY, maxW: W - 2 * M - boxW - 24 })
    text('PAYROLL & HUMAN RESOURCES', M, y - 36, { size: 7.5, color: MUTED })
  }
  y -= boxH + 22
  hr(y)

  // ── Employee information ──
  y -= 28
  text('Employee Information', M, y, { size: 11, b: true, color: NAVY })
  if (s.particulars.employmentType) pill(s.particulars.employmentType.toUpperCase(), R, y, true)
  y -= 24
  const p = s.particulars
  const grid: Array<[string, string, string, string]> = [
    ['Employee Name', p.employeeName, 'Employee ID', p.employeeCode],
    ['Designation', p.designation ?? '—', 'Department', p.department ?? '—'],
    ['Date of Joining', fmtDate(p.joiningDate), 'Paid Days', p.paidDays == null ? '—' : `${p.paidDays} / ${p.monthDays ?? '—'}`],
    ['CNIC Number', p.cnic ?? '—', 'Employment Type', p.employmentType ?? '—'],
  ]
  const col2 = M + (W - 2 * M) / 2 + 10, colW = (W - 2 * M) / 2 - 20
  for (const [k1, v1, k2, v2] of grid) {
    text(k1, M, y, { size: 8, color: MUTED }); text(k2, col2, y, { size: 8, color: MUTED })
    text(v1, M, y - 13, { size: 10, b: true, maxW: colW }); text(v2, col2, y - 13, { size: 10, b: true, maxW: colW })
    y -= 36
  }
  y -= 4
  hr(y)

  // ── Tables ──
  const table = (title: string, rows: Array<{ label: string; cents: number; sub?: boolean }>, totalLabel: string, totalCents: number) => {
    y -= 28
    text(title, M, y, { size: 11, b: true, color: NAVY })
    y -= 12
    page.drawRectangle({ x: M, y: y - 20, width: R - M, height: 20, color: GREY })
    text('Description', M + 10, y - 13.5, { size: 8.5, b: true, color: NAVY })
    text('Amount (PKR)', R - 10, y - 13.5, { size: 8.5, b: true, color: NAVY, right: true })
    y -= 20
    for (const r of rows) {
      y -= 19
      text(r.label, M + (r.sub ? 22 : 10), y + 6, { size: r.sub ? 8.5 : 9.5, color: r.sub ? MUTED : INK, maxW: R - M - 140 })
      text(pkr(r.cents), R - 10, y + 6, { size: r.sub ? 8.5 : 9.5, color: r.sub ? MUTED : INK, right: true })
      hr(y)
    }
    y -= 21
    text(totalLabel, M + 10, y + 7, { size: 10, b: true, color: NAVY })
    text(pkr(totalCents), R - 10, y + 7, { size: 10, b: true, color: NAVY, right: true })
    hr(y, NAVY)
  }
  const k = s.breakup
  const allowances = k.allowances.length === 1 && k.allowances[0]!.name === 'Allowances' && k.allowancesCents === k.allowances[0]!.cents
    ? [{ label: 'Allowances', cents: k.allowancesCents }]
    : k.allowances.map((a) => ({ label: a.name, cents: a.cents }))
  const earnings = [
    ...(k.basicCents ? [{ label: 'Basic Salary', cents: k.basicCents }] : []),
    ...allowances,
    ...k.otherEarnings.map((e) => ({ label: e.label, cents: e.cents })),
  ]
  const earningsTotal = k.totalSalaryCents + k.otherEarnings.reduce((a, e) => a + e.cents, 0)
  table('01 — Earnings', earnings, 'Total Earnings', earningsTotal)

  const listed = k.otherDeductions.reduce((a, d) => a + d.cents, 0)
  const others = k.otherDeductionsCents === 0 ? [] : listed === k.otherDeductionsCents
    ? k.otherDeductions.map((d) => ({ label: d.label, cents: d.cents }))
    : [{ label: 'Other Deductions', cents: k.otherDeductionsCents }]
  const b = k.basis
  const deductions = [
    ...(k.daysNotPaidCents ? [{ label: b ? `Attendance / Prorated Deduction (${b.daysInMonth - b.paidDays} day${b.daysInMonth - b.paidDays === 1 ? '' : 's'} not paid)` : 'Attendance / Prorated Deduction', cents: k.daysNotPaidCents }] : []),
    ...(k.lateCents ? [{ label: 'Late Coming', cents: k.lateCents }] : []),
    { label: 'Income Tax', cents: k.taxCents },
    ...(k.eobiCents ? [{ label: 'EOBI (Employee)', cents: k.eobiCents }] : []),
    ...others,
  ]
  table('02 — Deductions', deductions, 'Total Deductions', earningsTotal - k.netCents)

  // ── Net payable ──
  y -= 26
  const netH = 62
  page.drawRectangle({ x: M, y: y - netH, width: R - M, height: netH, color: NAVY })
  text('NET PAYABLE', M + 16, y - 18, { size: 8.5, b: true, color: WHITE })
  text(`PKR ${pkr(k.netCents)}`, M + 16, y - 40, { size: 20, b: true, color: WHITE })
  text(rupeesInWords(k.netCents), M + 16, y - 54, { size: 8, color: WHITE, maxW: R - M - 32 })
  y -= netH + 26

  // ── Payment period and status ──
  const [py, pm] = s.period.split('-').map(Number)
  const last = py && pm ? new Date(Date.UTC(py, pm, 0)).getUTCDate() : 0
  text('Payment Period', M, y, { size: 8, color: MUTED })
  text('Payment Status', R, y, { size: 8, color: MUTED, right: true })
  text(last ? `01–${last} ${monthTitle(s.period)}`.replace('–', '-') : s.period, M, y - 14, { size: 10, b: true })
  pill(s.paid ? 'PAID' : 'PAYABLE', R, y - 14, true)
  y -= 34
  hr(y)
  text('This is a computer-generated payslip and does not need a signature.', M, y - 16, { size: 7.5, color: MUTED })
}
