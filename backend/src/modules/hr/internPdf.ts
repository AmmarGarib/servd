// Intern Management PDFs (owner, 2026-11-06), made by the server with pdf-lib — display only, nothing is stored.
//
//   stipendSlipsPdf   the STIPEND SLIP (one page per intern; a run makes one PDF) — the payslip's look (payslipPdf.ts:
//                     navy, light grey, A4 portrait, Helvetica = Arial metrics), labelled STIPEND SLIP. Figures come
//                     from the InternStipendSlip row only.
//   certificatePdf    the Certificate of Internship — A4 landscape, a navy double border, the company name in text
//                     (servd keeps no company logo: no picture is fetched), "Authorised HR signatory" with the issuing
//                     HR user's name.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { safeTextFor } from '../../lib/reportExport.js'
import { monthTitle, pkr, rupeesInWords } from './payslipPdf.js'

const NAVY = rgb(0x1b / 255, 0x25 / 255, 0x55 / 255)
const INK = rgb(0x1f / 255, 0x23 / 255, 0x2b / 255)
const MUTED = rgb(0x6b / 255, 0x72 / 255, 0x80 / 255)
const GREY = rgb(0xf2 / 255, 0xf3 / 255, 0xf5 / 255)
const LINE = rgb(0xe3 / 255, 0xe5 / 255, 0xe9 / 255)
const WHITE = rgb(1, 1, 1)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const longDate = (d: Date | null | undefined): string => (d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '—')

type Fonts = { font: PDFFont; bold: PDFFont; safe: (s: string) => string }

function writer(page: PDFPage, f: Fonts) {
  return (t: string, x: number, y: number, o: { size?: number; b?: boolean; color?: ReturnType<typeof rgb>; align?: 'left' | 'right' | 'center'; maxW?: number } = {}) => {
    const fnt = o.b ? f.bold : f.font, size = o.size ?? 9.5
    let str = f.safe(t)
    if (o.maxW) while (str.length > 1 && fnt.widthOfTextAtSize(str, size) > o.maxW) str = str.slice(0, -2) + '…'
    const w = fnt.widthOfTextAtSize(str, size)
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x
    page.drawText(str, { x: left, y, size, font: fnt, color: o.color ?? INK })
    return w
  }
}

async function fontsOf(doc: PDFDocument): Promise<Fonts> {
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  return { font, bold, safe: safeTextFor(font) }
}

// ─── Stipend slip ───────────────────────────────────────────────────────────

export interface StipendSlipPdfInput {
  companyName: string
  period: string
  intern: { internCode: string; fullName: string; department: string | null; designation: string | null; institution: string | null; startDate: Date; endDate: Date | null; cnic: string | null }
  slip: {
    monthlyStipendCents: number; daysInMonth: number; daysEngaged: number; absentDays: number; halfDays: number; unpaidLeaveDays: number
    paidDays: number; baseCents: number; additionsCents: number; deductionsCents: number; netCents: number
    adjustments: Array<{ kind: 'addition' | 'deduction'; label: string; amountCents: number; note?: string | null }>
  }
  status: string
  paid: boolean
}

const PORTRAIT: [number, number] = [595.28, 841.89]

export async function stipendSlipsPdf(slips: StipendSlipPdfInput[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setTitle(slips.length === 1 ? `Stipend slip ${slips[0]!.intern.internCode} ${slips[0]!.period}` : `Stipend slips ${slips[0]?.period ?? ''}`)
  doc.setProducer('servd'); doc.setCreator('servd')
  const f = await fontsOf(doc)
  if (slips.length === 0) {
    const page = doc.addPage(PORTRAIT)
    writer(page, f)('No stipend slips in this run.', 48, PORTRAIT[1] - 72, { size: 11 })
  }
  for (const s of slips) drawSlip(doc.addPage(PORTRAIT), s, f)
  return Buffer.from(await doc.save())
}

function drawSlip(page: PDFPage, s: StipendSlipPdfInput, f: Fonts) {
  const M = 48, W = PORTRAIT[0], R = W - M
  const text = writer(page, f)
  const hr = (y: number, color = LINE) => page.drawLine({ start: { x: M, y }, end: { x: R, y }, thickness: 0.7, color })

  let y = PORTRAIT[1] - M
  const boxW = 120, boxH = 40
  page.drawRectangle({ x: R - boxW, y: y - boxH, width: boxW, height: boxH, color: NAVY })
  text('STIPEND SLIP', R - boxW + 10, y - 17, { size: 11, b: true, color: WHITE })
  text(monthTitle(s.period).toUpperCase(), R - boxW + 10, y - 31, { size: 7, b: true, color: WHITE })
  text(s.companyName.toUpperCase(), M, y - 16, { size: 13, b: true, color: NAVY, maxW: W - 2 * M - boxW - 24 })
  text('INTERN MANAGEMENT · HUMAN RESOURCES', M, y - 29, { size: 6.5, color: MUTED })
  y -= boxH + 18
  hr(y)

  y -= 28
  text('Intern Information', M, y, { size: 11, b: true, color: NAVY })
  y -= 24
  const i = s.intern
  const grid: Array<[string, string, string, string]> = [
    ['Intern Name', i.fullName, 'Intern ID', i.internCode],
    ['Position', i.designation ?? '—', 'Department', i.department ?? '—'],
    ['Internship', `${longDate(i.startDate)} – ${i.endDate ? longDate(i.endDate) : 'open'}`, 'Paid Days', `${s.slip.paidDays} / ${s.slip.daysInMonth}`],
    ['Institution', i.institution ?? '—', 'CNIC / B-form', i.cnic ?? '—'],
  ]
  const col2 = M + (W - 2 * M) / 2 + 10, colW = (W - 2 * M) / 2 - 20
  for (const [k1, v1, k2, v2] of grid) {
    text(k1, M, y, { size: 8, color: MUTED }); text(k2, col2, y, { size: 8, color: MUTED })
    text(v1, M, y - 13, { size: 10, b: true, maxW: colW }); text(v2, col2, y - 13, { size: 10, b: true, maxW: colW })
    y -= 36
  }
  y -= 4
  hr(y)

  const table = (title: string, rows: Array<{ label: string; cents: number }>, totalLabel: string, totalCents: number) => {
    y -= 28
    text(title, M, y, { size: 11, b: true, color: NAVY })
    y -= 12
    page.drawRectangle({ x: M, y: y - 20, width: R - M, height: 20, color: GREY })
    text('Description', M + 10, y - 13.5, { size: 8.5, b: true, color: NAVY })
    text('Amount (PKR)', R - 10, y - 13.5, { size: 8.5, b: true, color: NAVY, align: 'right' })
    y -= 20
    for (const r of rows) {
      y -= 19
      text(r.label, M + 10, y + 6, { maxW: R - M - 140 })
      text(pkr(r.cents), R - 10, y + 6, { align: 'right' })
      hr(y)
    }
    y -= 21
    text(totalLabel, M + 10, y + 7, { size: 10, b: true, color: NAVY })
    text(pkr(totalCents), R - 10, y + 7, { size: 10, b: true, color: NAVY, align: 'right' })
    hr(y, NAVY)
  }
  const sl = s.slip
  const additions = sl.adjustments.filter((a) => a.kind === 'addition')
  const deductions = sl.adjustments.filter((a) => a.kind === 'deduction')
  const notPaid = sl.monthlyStipendCents - sl.baseCents
  table('01 — Stipend', [
    { label: 'Monthly stipend', cents: sl.monthlyStipendCents },
    ...additions.map((a) => ({ label: a.label, cents: a.amountCents })),
  ], 'Total', sl.monthlyStipendCents + sl.additionsCents)
  const daysOff = sl.daysInMonth - sl.paidDays
  table('02 — Deductions', [
    ...(notPaid ? [{ label: `Days not paid (${daysOff} of ${sl.daysInMonth}: ${[sl.absentDays ? `${sl.absentDays} absent` : '', sl.halfDays ? `${sl.halfDays} half day` : '', sl.unpaidLeaveDays ? `${sl.unpaidLeaveDays} leave` : '', sl.daysInMonth - sl.daysEngaged ? `${sl.daysInMonth - sl.daysEngaged} outside the internship` : ''].filter(Boolean).join(', ') || 'prorated'})`, cents: notPaid }] : []),
    ...deductions.map((a) => ({ label: a.label, cents: a.amountCents })),
  ], 'Total Deductions', notPaid + sl.deductionsCents)

  y -= 26
  const netH = 62
  page.drawRectangle({ x: M, y: y - netH, width: R - M, height: netH, color: NAVY })
  text('NET STIPEND PAYABLE', M + 16, y - 18, { size: 8.5, b: true, color: WHITE })
  text(`PKR ${pkr(sl.netCents)}`, M + 16, y - 40, { size: 20, b: true, color: WHITE })
  text(rupeesInWords(sl.netCents), M + 16, y - 54, { size: 8, color: WHITE, maxW: R - M - 32 })
  y -= netH + 26
  text('Stipend Period', M, y, { size: 8, color: MUTED })
  text('Payment Status', R, y, { size: 8, color: MUTED, align: 'right' })
  text(monthTitle(s.period), M, y - 14, { size: 10, b: true })
  text(s.paid ? 'PAID' : 'PAYABLE', R, y - 14, { size: 10, b: true, color: NAVY, align: 'right' })
  y -= 34
  hr(y)
  text('A stipend is not a salary: an intern is not an employee. This is a computer-generated slip and does not need a signature.', M, y - 16, { size: 7.5, color: MUTED, maxW: R - M })
}

// ─── Certificate of Internship ──────────────────────────────────────────────

export interface CertificatePdfInput {
  companyName: string
  number: string
  issueDate: Date
  intern: { fullName: string; internCode: string; department: string | null; designation: string | null; startDate: Date; endDate: Date }
  duration: string
  remarks: string | null
  signatoryName: string | null
  reissued: boolean
}

const LANDSCAPE: [number, number] = [841.89, 595.28]

export async function certificatePdf(c: CertificatePdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Certificate of Internship ${c.number}`)
  doc.setProducer('servd'); doc.setCreator('servd')
  const f = await fontsOf(doc)
  const page = doc.addPage(LANDSCAPE)
  const [W, H] = LANDSCAPE
  const text = writer(page, f)
  page.drawRectangle({ x: 24, y: 24, width: W - 48, height: H - 48, borderColor: NAVY, borderWidth: 3 })
  page.drawRectangle({ x: 34, y: 34, width: W - 68, height: H - 68, borderColor: NAVY, borderWidth: 0.8 })
  const cx = W / 2
  let y = H - 92
  text(c.companyName.toUpperCase(), cx, y, { size: 20, b: true, color: NAVY, align: 'center', maxW: W - 140 })
  y -= 20
  text('HUMAN RESOURCES', cx, y, { size: 8, color: MUTED, align: 'center' })
  y -= 50
  text('Certificate of Internship', cx, y, { size: 30, b: true, color: NAVY, align: 'center' })
  y -= 40
  text('This is to certify that', cx, y, { size: 12, color: MUTED, align: 'center' })
  y -= 36
  text(c.intern.fullName, cx, y, { size: 24, b: true, align: 'center', maxW: W - 160 })
  page.drawLine({ start: { x: cx - 180, y: y - 8 }, end: { x: cx + 180, y: y - 8 }, thickness: 0.7, color: LINE })
  y -= 30
  text(`Intern ID ${c.intern.internCode}`, cx, y, { size: 10, color: MUTED, align: 'center' })
  y -= 28
  const role = [c.intern.designation, c.intern.department ? `${c.intern.department} department` : null].filter(Boolean).join(', ')
  text(`has completed an internship${role ? ` as ${role}` : ''} at ${c.companyName}`, cx, y, { size: 12, align: 'center', maxW: W - 160 })
  y -= 18
  text(`from ${longDate(c.intern.startDate)} to ${longDate(c.intern.endDate)} (${c.duration}).`, cx, y, { size: 12, align: 'center', maxW: W - 160 })
  if (c.remarks) {
    y -= 30
    // Wrap the remarks over up to three lines.
    const words = f.safe(c.remarks).split(/\s+/)
    const lines: string[] = []
    let cur = ''
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w
      if (f.font.widthOfTextAtSize(next, 11) > W - 220 && cur) { lines.push(cur); cur = w } else cur = next
    }
    if (cur) lines.push(cur)
    for (const l of lines.slice(0, 3)) { text(l, cx, y, { size: 11, color: INK, align: 'center' }); y -= 15 }
  }
  // Footer: issue date + number (left), signatory (right).
  const fy = 96
  text('Date of issue', 80, fy + 16, { size: 8, color: MUTED })
  text(longDate(c.issueDate), 80, fy, { size: 11, b: true })
  text(`Certificate No. ${c.number}${c.reissued ? ' (re-issued)' : ''}`, 80, fy - 18, { size: 8, color: MUTED })
  page.drawLine({ start: { x: W - 300, y: fy + 4 }, end: { x: W - 80, y: fy + 4 }, thickness: 0.7, color: INK })
  text(c.signatoryName ?? ' ', W - 190, fy - 12, { size: 11, b: true, align: 'center', maxW: 210 })
  text('Authorised HR signatory', W - 190, fy - 26, { size: 8, color: MUTED, align: 'center' })
  return Buffer.from(await doc.save())
}

/** "3 months 12 days" between two days, both inclusive. */
export function durationText(from: Date, to: Date): string {
  const end = new Date(to.getTime() + 86_400_000) // exclusive
  let months = (end.getUTCFullYear() - from.getUTCFullYear()) * 12 + (end.getUTCMonth() - from.getUTCMonth())
  const at = (m: number) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + m, from.getUTCDate()))
  while (months > 0 && at(months) > end) months -= 1
  const days = Math.round((end.getTime() - at(months).getTime()) / 86_400_000)
  const parts = [months > 0 ? `${months} month${months === 1 ? '' : 's'}` : '', days > 0 ? `${days} day${days === 1 ? '' : 's'}` : ''].filter(Boolean)
  return parts.join(' ') || '1 day'
}
