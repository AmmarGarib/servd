// Cash voucher exports (2026-10-15): the printed-standard voucher as a PDF and
// as an Excel sheet. Registered under /trustops/cash-vouchers.
//
//   GET /:id/export.pdf
//   GET /:id/export.xlsx
//
// Only a voucher the CEO has approved (approved, disbursed, settled, posted,
// converted) can be exported — 409 NOT_APPROVED before. Visibility and company
// scope are loadVisible's: another company's voucher is 404. Every export is
// audited (cash_voucher.export). Files are generated in memory; nothing is
// stored.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { AppError } from '../../lib/errors.js'
import { amountInWords, formatPkr } from '../../lib/amountInWords.js'
import { buildXlsx, type XlsxCell } from '../../lib/xlsxWriter.js'
import { categoryRefOf } from '../accounting/pettyCashPosting.js'
import { payoutCategory } from '../accounting/expenseCategories.js'
import { auditVoucher, loadVisible, type VoucherRow } from './cashVouchers.js'

const EXPORTABLE = ['approved', 'disbursed', 'settled', 'posted', 'converted']

interface Sign { role: string; name: string; date: string }
interface VoucherDoc {
  company: string
  title: string
  number: string
  date: string
  status: string
  payee: string
  particulars: string
  account: string
  brand: string
  department: string
  grossCents: number
  discountCents: number
  totalCents: number
  words: string
  signs: Sign[]
  documents: string[]
  footer: string
}

const KARACHI = 'Asia/Karachi'
const fmtDate = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat('en-GB', { timeZone: KARACHI, day: '2-digit', month: 'short', year: 'numeric' }).format(d) : ''
const fmtStamp = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: KARACHI, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d) + ' PKT'

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
}

async function buildDoc(v: VoucherRow): Promise<VoucherDoc> {
  const tenantId = v.tenantId
  const ids = [v.preparedById, v.financeApprovedById, v.directorSignedById, v.disbursedById, v.payeeUserId].filter((x): x is string => !!x)
  const [tenant, users, concept, atts] = await Promise.all([
    prisma.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    v.conceptId ? prisma.concept.findFirst({ where: { id: v.conceptId, tenantId }, select: { name: true } }) : Promise.resolve(null),
    prisma.cashVoucherAttachment.findMany({
      where: { voucherId: v.id, tenantId, kind: { in: ['supporting', 'receipt'] } },
      select: { id: true, kind: true, mime: true, fileName: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  const name = (id: string | null | undefined) => (id ? users.find((u) => u.id === id)?.name ?? '' : '')

  // Expense account: the category's key → its account code, or the code itself.
  const ref = categoryRefOf(v.category)
  const code = ref.accountCode ?? (ref.categoryKey ? payoutCategory(ref.categoryKey)?.code ?? null : null)
  let account = '—'
  if (code) {
    const acct = await prisma.account.findFirst({ where: { tenantId, code }, select: { name: true } })
    account = `${code} ${acct?.name ?? payoutCategory(ref.categoryKey)?.label ?? ''}`.trim()
  } else if (ref.categoryKey) {
    account = ref.categoryKey
  }

  const discountCents = v.discountCents ?? 0
  const totalCents = v.amountCents
  const grossCents = v.grossCents ?? totalCents + discountCents

  const paidBy = v.cashierName || name(v.disbursedById)
  const signs: Sign[] = [
    { role: 'Requested by', name: name(v.preparedById), date: fmtDate(v.submittedAt ?? v.createdAt) },
    { role: 'Finance approved', name: name(v.financeApprovedById), date: fmtDate(v.financeApprovedAt) },
    { role: 'CEO approved', name: name(v.directorSignedById), date: fmtDate(v.directorSignedAt) },
    { role: 'Paid by cashier', name: paidBy, date: fmtDate(v.disbursedAt) },
    { role: 'Received by', name: '', date: '' },
  ]
  const used = new Map<string, number>()
  const documents = atts.map((a) => {
    if (a.fileName) return a.fileName
    const n = (used.get(a.kind) ?? 0) + 1
    used.set(a.kind, n)
    return `${a.kind}-${n}.${EXT_BY_MIME[a.mime] ?? 'bin'}`
  })

  return {
    company: tenant?.name ?? '',
    title: v.kind === 'expense' ? 'CASH PAYMENT VOUCHER' : 'PETTY CASH VOUCHER',
    number: v.number,
    date: fmtDate(v.voucherDate),
    status: v.status.replace(/_/g, ' '),
    payee: v.payeeName,
    particulars: v.purpose,
    account,
    brand: concept?.name ?? '—',
    department: v.department || '—',
    grossCents, discountCents, totalCents,
    words: amountInWords(totalCents),
    signs,
    documents,
    footer: `Generated by servd ${fmtStamp(new Date())} — ${v.number}`,
  }
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

/** Standard Helvetica is WinAnsi only: anything else would throw, so it becomes '?'. */
const winAnsi = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of winAnsi(text).split(' ')) {
    let w = word
    // A single over-long token is cut so it can never run off the page.
    while (font.widthOfTextAtSize(w, size) > width) {
      let cut = w.length
      while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--
      if (line) { out.push(line); line = '' }
      out.push(w.slice(0, cut))
      w = w.slice(cut)
    }
    const next = line ? `${line} ${w}` : w
    if (line && font.widthOfTextAtSize(next, size) > width) { out.push(line); line = w } else line = next
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}

async function renderPdf(d: VoucherDoc): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`${d.title} ${d.number}`)
  pdf.setCreator('servd')
  pdf.setProducer('servd')
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page: PDFPage = pdf.addPage([595.28, 841.89])
  const M = 40
  const W = 595.28 - M * 2
  const ink = rgb(0.1, 0.1, 0.12)
  const mute = rgb(0.4, 0.4, 0.45)
  const rule = rgb(0.55, 0.55, 0.6)
  const shade = rgb(0.93, 0.93, 0.95)
  let y = 841.89 - M

  const text = (s: string, x: number, yy: number, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}) =>
    page.drawText(winAnsi(s), { x, y: yy, size: o.size ?? 10, font: o.bold ? bold : font, color: o.color ?? ink })
  const line = (x1: number, y1: number, x2: number, y2: number, t = 0.7) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: rule })
  const centered = (s: string, yy: number, size: number, b = false) => {
    const f = b ? bold : font
    const w = f.widthOfTextAtSize(winAnsi(s), size)
    text(s, M + (W - w) / 2, yy, { size, bold: b })
  }

  // Heading
  centered(d.company || 'servd', y - 14, 16, true)
  centered(d.title, y - 34, 12, true)
  y -= 44
  page.drawRectangle({ x: M, y: y - 3, width: W, height: 1.5, color: ink })
  y -= 22

  // Number / date / status
  const meta: Array<[string, string]> = [['Voucher No.', d.number], ['Date', d.date], ['Status', d.status.toUpperCase()]]
  const colW = W / 3
  meta.forEach(([k, val], i) => {
    text(k, M + colW * i, y, { size: 8, color: mute })
    text(val, M + colW * i, y - 13, { size: 11, bold: true })
  })
  y -= 30
  line(M, y, M + W, y)

  // Detail rows
  const LABEL_W = 110
  const row = (label: string, value: string) => {
    const lines = wrap(value || '—', font, 10, W - LABEL_W - 12)
    const h = Math.max(24, lines.length * 13 + 11)
    text(label, M + 6, y - 16, { size: 9, color: mute })
    lines.forEach((l, i) => text(l, M + LABEL_W, y - 16 - i * 13))
    y -= h
    line(M, y, M + W, y, 0.4)
  }
  row('Payee', d.payee)
  row('Particulars', d.particulars)
  row('Expense account', d.account)
  row('Brand', d.brand)
  row('Department', d.department)
  y -= 16

  // Amount table: Amount | Discount | Total
  const heads = ['Amount (PKR)', 'Discount (PKR)', 'Total (PKR)']
  const vals = [formatPkr(d.grossCents, { decimals: true }), formatPkr(d.discountCents, { decimals: true }), formatPkr(d.totalCents, { decimals: true })]
  page.drawRectangle({ x: M, y: y - 22, width: W, height: 22, color: shade, borderColor: rule, borderWidth: 0.7 })
  page.drawRectangle({ x: M, y: y - 52, width: W, height: 30, borderColor: rule, borderWidth: 0.7 })
  for (let i = 0; i < 3; i++) {
    const cx = M + colW * (i + 1) - 10
    const hw = bold.widthOfTextAtSize(heads[i]!, 9)
    text(heads[i]!, cx - hw, y - 15, { size: 9, bold: true })
    const f = i === 2 ? bold : font
    const vw = f.widthOfTextAtSize(vals[i]!, 12)
    text(vals[i]!, cx - vw, y - 43, { size: 12, bold: i === 2 })
    if (i > 0) line(M + colW * i, y, M + colW * i, y - 52, 0.7)
  }
  y -= 52 + 18

  // Amount in words
  text('Amount in words', M, y, { size: 8, color: mute })
  y -= 14
  for (const l of wrap(d.words, bold, 11, W)) { text(l, M, y, { size: 11, bold: true }); y -= 14 }
  y -= 22

  // Signature blocks
  const n = d.signs.length
  const gap = 8
  const bw = (W - gap * (n - 1)) / n
  const bh = 86
  d.signs.forEach((s, i) => {
    const x = M + i * (bw + gap)
    page.drawRectangle({ x, y: y - bh, width: bw, height: bh, borderColor: rule, borderWidth: 0.7 })
    text(s.role, x + 5, y - 13, { size: 8, bold: true })
    line(x + 5, y - 48, x + bw - 5, y - 48, 0.5)
    const nm = wrap(s.name || (s.role === 'Received by' ? '' : '—'), font, 8, bw - 10)
    nm.slice(0, 2).forEach((l, k) => text(l, x + 5, y - 60 - k * 10, { size: 8 }))
    text(s.date ? s.date : s.role === 'Received by' ? 'Signature / date' : '—', x + 5, y - 80, { size: 7.5, color: mute })
  })
  y -= bh + 22

  // Attached supporting documents
  text('Attached supporting documents', M, y, { size: 9, bold: true })
  y -= 14
  if (!d.documents.length) {
    text('None attached', M + 6, y, { size: 9, color: mute })
    y -= 13
  } else {
    const shown = d.documents.slice(0, 14)
    shown.forEach((f, i) => {
      const l = wrap(`${i + 1}. ${f}`, font, 9, W - 12)[0]!
      text(l, M + 6, y, { size: 9 })
      y -= 13
    })
    if (d.documents.length > shown.length) {
      text(`+ ${d.documents.length - shown.length} more attached`, M + 6, y, { size: 9, color: mute })
      y -= 13
    }
  }

  // Footer
  line(M, M + 14, M + W, M + 14, 0.4)
  text(d.footer, M, M, { size: 8, color: mute })

  return Buffer.from(await pdf.save())
}

// ─── Excel ───────────────────────────────────────────────────────────────────

function renderXlsx(d: VoucherDoc): Buffer {
  const rupees = (c: number) => c / 100
  const rows: XlsxCell[][] = [
    [{ v: d.company, s: 'title' }],
    [{ v: d.title, s: 'bold' }],
    [],
    [{ v: 'Voucher No.', s: 'bold' }, d.number, { v: 'Date', s: 'bold' }, d.date],
    [{ v: 'Status', s: 'bold' }, d.status],
    [{ v: 'Payee', s: 'bold' }, d.payee],
    [{ v: 'Particulars', s: 'bold' }, { v: d.particulars, s: 'wrap' }],
    [{ v: 'Expense account', s: 'bold' }, d.account],
    [{ v: 'Brand', s: 'bold' }, d.brand],
    [{ v: 'Department', s: 'bold' }, d.department],
    [],
    [{ v: 'Amount', s: 'header' }, { v: 'Discount', s: 'header' }, { v: 'Total', s: 'header' }],
    [{ v: rupees(d.grossCents), s: 'currency' }, { v: rupees(d.discountCents), s: 'currency' }, { v: rupees(d.totalCents), s: 'boldCurrency' }],
    [{ v: 'Amount in words', s: 'bold' }, d.words],
    [],
    [{ v: 'Signatures', s: 'header' }, { v: 'Name', s: 'header' }, { v: 'Date', s: 'header' }],
    ...d.signs.map((s): XlsxCell[] => [{ v: s.role, s: 'bold' }, s.name, s.date]),
    [],
    [{ v: 'Attached supporting documents', s: 'bold' }],
    ...(d.documents.length ? d.documents.map((f, i): XlsxCell[] => [`${i + 1}`, f]) : [['None attached']]),
    [],
    [d.footer],
  ]
  return buildXlsx({ name: d.number, widths: [26, 34, 22, 22], rows, merges: ['A1:D1', 'B7:D7'] })
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function send(reply: FastifyReply, body: Buffer, type: string, filename: string) {
  return reply
    .header('Content-Type', type)
    .header('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(body)
}

export async function cashVoucherExportRoutes(fastify: FastifyInstance) {
  for (const format of ['pdf', 'xlsx'] as const) {
    fastify.get<{ Params: { id: string } }>(`/:id/export.${format}`, { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
      const { v } = await loadVisible(req, req.params.id)
      if (!EXPORTABLE.includes(v.status)) {
        throw new AppError('NOT_APPROVED', `Cash voucher ${v.number} is ${v.status.replace(/_/g, ' ')} — it can be printed or exported once the CEO has approved it`, 409)
      }
      const doc = await buildDoc(v)
      const body = format === 'pdf' ? await renderPdf(doc) : renderXlsx(doc)
      await auditVoucher(req, 'export', v, { format, status: v.status })
      return send(
        reply, body,
        format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        `${v.number}.${format}`,
      )
    })
  }
}
