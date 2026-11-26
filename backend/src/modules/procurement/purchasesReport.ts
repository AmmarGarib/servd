// Purchases report — every purchase, supplier by supplier, with the items, amounts and totals (owner, 2026-11-26:
// "procurement report, which include all purchases made supplier wise and including items purchased with amounts
// and totals" → "Build both, give option to select: all, based on GRN, based on billed purchases and including all
// (with CEO, Finance or any approval)").
//
// READ ONLY over the existing documents — no new store, posts nothing. `basis` picks what counts as a purchase:
//   billed  supplier BILLS dated in the period (not draft / void) — what the books show. Credit notes dated in the
//           period come off as negative lines.
//   grn     goods RECEIVED in the period (every GRN / dock receipt that was not undone), at the cost its stock was
//           taken in at — whatever its approval stage (the Stage column says: finance, CEO, approved…).
//   all     everything, at ANY stage, counted once: every receipt as in `grn`; bill lines that are NOT for a receipt
//           (expense bills, bills booked ahead of delivery); and what is still to arrive on purchase orders that are
//           waiting for the CEO, approved, with the buyer, or bought and waiting to be confirmed.
// A supplier's sales tax is the tax on the documents counted (bill tax; a GRN's invoice tax).
//
// BRAND filter (owner, 2026-11-26: "Add brand filter also") — `conceptId` = a brand of the companies in view (else
// 404) or `none` (purchases with no brand = shared). A purchase's brand is the one on its DOCUMENT: a receipt's own
// (`GoodsReceipt.conceptId`), a PO's (`PurchaseOrder.conceptId`); a bill line takes its receipt's, else its PO's — a
// bill line for neither (an expense bill) has no brand. A bill's tax counts only when every line of it is counted.
//
//   GET /procurement/purchases-report?from&to&basis=billed|grn|all&supplierId?&conceptId?&format=csv|xlsx|pdf
// Procurement team + finance (GATED_PREFIXES: procurement | accounting); the companies in view — a supplier of
// another company never appears (a foreign supplierId → 404). Tests: tests/purchasesReport.test.ts.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { exportFormatOf, sendReportFor } from '../../lib/reportExport.js'
import { requireAuth, PROCUREMENT_TEAM } from '../auth/middleware.js'
import { parsePktEndOfDay, parsePktStartOfDay, fmtPktDate } from '../accounting/dates.js'
import { scopeTenantIds } from './scope.js'
import { lineDisplay, lineValueCents } from './poUnits.js'

export type PurchaseBasis = 'billed' | 'grn' | 'all'
export interface PurchaseLine {
  date: string; source: 'Bill' | 'Credit note' | 'GRN' | 'Purchase order'; document: string; stage: string
  item: string; quantity: number; unit: string; rateCents: number; amountCents: number
}
interface Group { supplierId: string; supplierName: string; companyName: string | null; lines: PurchaseLine[]; itemsCents: number; taxCents: number; totalCents: number }

const GRN_STAGE: Record<string, string> = {
  finance_review: 'Received — waiting for finance', ceo_review: 'Received — waiting for the CEO',
  buyer_fix: 'Received — returned to the buyer', approved: 'Received — approved',
}
const PO_STAGE: Record<string, string> = {
  pending_approval: 'Ordered — waiting for the CEO', approved: 'Approved — with the buyer', sent: 'Approved — with the buyer',
  partial: 'Part received — rest with the buyer', completed: 'Bought — receipt to be confirmed',
}
const BILL_STAGE: Record<string, string> = { open: 'Billed — unpaid', partially_paid: 'Billed — part paid', paid: 'Billed — paid' }
const round2 = (n: number) => Math.round(n * 1000) / 1000

export async function purchasesReport(tenantIds: string[], opts: { from: Date; to: Date; basis: PurchaseBasis; supplierId?: string; conceptId?: string }) {
  // undefined = every brand; null = purchases with no brand; an id = that brand.
  const brand = opts.conceptId === undefined ? undefined : opts.conceptId === 'none' ? null : opts.conceptId
  const brandWhere = brand === undefined ? {} : { conceptId: brand }
  const supplierWhere = { tenantId: { in: tenantIds }, systemKind: null, ...(opts.supplierId ? { id: opts.supplierId } : {}) }
  const between = { gte: opts.from, lte: opts.to }
  const groups = new Map<string, Group>()
  const groupOf = (s: { id: string; name: string; tenant: { name: string } | null }) => {
    let g = groups.get(s.id)
    if (!g) { g = { supplierId: s.id, supplierName: s.name, companyName: s.tenant?.name ?? null, lines: [], itemsCents: 0, taxCents: 0, totalCents: 0 }; groups.set(s.id, g) }
    return g
  }
  const supplierSel = { select: { id: true, name: true, tenant: { select: { name: true } } } } as const
  const add = (g: Group, l: PurchaseLine) => { g.lines.push(l); g.itemsCents += l.amountCents }

  // ── Receipts (grn, all) ────────────────────────────────────────────────────
  if (opts.basis !== 'billed') {
    const receipts = await prisma.goodsReceipt.findMany({
      where: { tenantId: { in: tenantIds }, receivedAt: between, NOT: { grnStatus: 'undone' }, ...brandWhere, ...(opts.supplierId ? { supplierId: opts.supplierId } : {}) },
      select: { id: true, supplierId: true, receivedAt: true, grnNumber: true, grnStatus: true, invoiceNumber: true, invoiceTaxCents: true, lines: { select: { description: true, receivedQty: true, unit: true, lotUnitCostCents: true, poUnitCostCents: true } } },
      orderBy: { receivedAt: 'asc' },
    })
    const sup = new Map((await prisma.supplier.findMany({ where: { id: { in: [...new Set(receipts.map((r) => r.supplierId))] }, ...supplierWhere }, ...supplierSel })).map((s) => [s.id, s]))
    for (const r of receipts) {
      const s = sup.get(r.supplierId)
      if (!s) continue
      const g = groupOf(s)
      const doc = `${r.grnNumber ?? 'Receipt'}${r.invoiceNumber ? ` · inv ${r.invoiceNumber}` : ''}`
      for (const l of r.lines) {
        if (!(l.receivedQty > 0)) continue
        const rate = l.lotUnitCostCents ?? l.poUnitCostCents ?? 0
        add(g, { date: fmtPktDate(r.receivedAt), source: 'GRN', document: doc, stage: GRN_STAGE[r.grnStatus ?? ''] ?? 'Received', item: l.description, quantity: round2(l.receivedQty), unit: l.unit, rateCents: rate, amountCents: Math.round(l.receivedQty * rate) })
      }
      g.taxCents += toCents(r.invoiceTaxCents ?? 0)
    }
  }

  // ── Bills (billed: every line; all: only lines that are not for a receipt) ─
  if (opts.basis !== 'grn') {
    const bills = await prisma.supplierBill.findMany({
      where: { billDate: between, status: { notIn: ['draft', 'void'] }, supplier: supplierWhere },
      select: {
        billNumber: true, billDate: true, status: true, kind: true, taxCents: true, supplier: supplierSel,
        lines: { select: { description: true, quantity: true, unitCostCents: true, lineTotalCents: true, receiptLineId: true, inventoryItem: { select: { unit: true } }, receiptLine: { select: { receipt: { select: { conceptId: true } } } }, poLine: { select: { purchaseOrder: { select: { conceptId: true } }, _count: { select: { receiptLines: true } } } } } },
        po: { select: { conceptId: true } },
      },
      orderBy: { billDate: 'asc' },
    })
    for (const b of bills) {
      const credit = b.kind === 'credit_note'
      if (credit && opts.basis === 'all') continue // `all` counts receipts as received; a credit note is a billing correction
      const sign = credit ? -1 : 1
      const brandOf = (l: (typeof b.lines)[number]) => (l.receiptLine ? l.receiptLine.receipt.conceptId : l.poLine ? l.poLine.purchaseOrder.conceptId : b.po?.conceptId) ?? null
      const lines = (opts.basis === 'billed' ? b.lines : b.lines.filter((l) => !l.receiptLineId && !(l.poLine && l.poLine._count.receiptLines > 0)))
        .filter((l) => brand === undefined || brandOf(l) === brand)
      if (lines.length === 0) continue
      const g = groupOf(b.supplier)
      for (const l of lines) {
        add(g, { date: fmtPktDate(b.billDate), source: credit ? 'Credit note' : 'Bill', document: b.billNumber, stage: credit ? 'Credit note' : (BILL_STAGE[b.status] ?? 'Billed'), item: l.description, quantity: round2(l.quantity), unit: l.inventoryItem?.unit ?? '', rateCents: toCents(l.unitCostCents), amountCents: sign * Math.abs(toCents(l.lineTotalCents)) })
      }
      // Tax: the whole bill's in `billed`; in `all` only when no line of it was left to a receipt (which carries its own).
      if (opts.basis === 'billed' || lines.length === b.lines.length) g.taxCents += sign * Math.abs(toCents(b.taxCents))
    }
  }

  // ── Purchase orders still to arrive (all) ──────────────────────────────────
  if (opts.basis === 'all') {
    const pos = await prisma.purchaseOrder.findMany({
      where: { orderDate: between, status: { in: Object.keys(PO_STAGE) }, ...brandWhere, supplier: supplierWhere },
      select: { id: true, status: true, orderDate: true, reference: true, supplier: supplierSel, lines: { select: { quantityOrdered: true, quantityReceived: true, unitCostCents: true, orderUnit: true, orderUnitFactor: true, orderUnitCostCents: true, inventoryItem: { select: { name: true, unit: true } } } } },
      orderBy: { orderDate: 'asc' },
    })
    for (const po of pos) {
      for (const l of po.lines) {
        const left = l.quantityOrdered - l.quantityReceived
        if (!(left > 1e-9)) continue
        const rest = { ...l, quantityOrdered: left }
        const d = lineDisplay(rest, l.inventoryItem.unit)
        add(groupOf(po.supplier), { date: fmtPktDate(po.orderDate), source: 'Purchase order', document: po.reference ?? `PO ${po.id.slice(-6).toUpperCase()}`, stage: PO_STAGE[po.status]!, item: l.inventoryItem.name, quantity: round2(d.quantity), unit: d.unit, rateCents: d.rateCents, amountCents: lineValueCents(rest) })
      }
    }
  }

  const suppliers = [...groups.values()].filter((g) => g.lines.length > 0)
    .map((g) => ({ ...g, lines: g.lines.sort((a, b) => a.date.localeCompare(b.date)), totalCents: g.itemsCents + g.taxCents }))
    .sort((a, b) => b.totalCents - a.totalCents)
  const totals = suppliers.reduce((t, g) => ({ itemsCents: t.itemsCents + g.itemsCents, taxCents: t.taxCents + g.taxCents, totalCents: t.totalCents + g.totalCents, lines: t.lines + g.lines.length }), { itemsCents: 0, taxCents: 0, totalCents: 0, lines: 0 })
  return { basis: opts.basis, suppliers, totals }
}

const BASIS_LABEL: Record<PurchaseBasis, string> = { billed: 'Billed purchases', grn: 'Goods received (GRN)', all: 'All purchases, any approval stage' }

export function registerPurchasesReportRoute(fastify: FastifyInstance) {
  const READERS = Array.from(new Set([...PROCUREMENT_TEAM, 'finance'])) as UserRole[]
  fastify.get('/purchases-report', { preHandler: requireAuth(...READERS) }, async (req, reply) => {
    const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date as YYYY-MM-DD')
    const q = z.object({ from: day, to: day, basis: z.enum(['billed', 'grn', 'all']).default('all'), supplierId: z.string().min(1).optional(), conceptId: z.string().min(1).optional(), format: z.enum(['json', 'csv', 'xlsx', 'pdf']).optional() }).parse(req.query ?? {})
    const from = parsePktStartOfDay(q.from)
    const to = parsePktEndOfDay(q.to)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new AppError('INVALID_DATE', 'Pick a start date on or before the end date', 422)
    const tenantIds = await scopeTenantIds(req, 'read')
    if (q.supplierId && !(await prisma.supplier.findFirst({ where: { id: q.supplierId, tenantId: { in: tenantIds } }, select: { id: true } }))) throw new NotFoundError('Supplier', q.supplierId)
    // Never trust a client brand id: it must be a brand of the companies in view.
    const brandRow = q.conceptId && q.conceptId !== 'none' ? await prisma.concept.findFirst({ where: { id: q.conceptId, tenantId: { in: tenantIds } }, select: { name: true } }) : null
    if (q.conceptId && q.conceptId !== 'none' && !brandRow) throw new NotFoundError('Brand', q.conceptId)
    const brandLabel = q.conceptId === 'none' ? 'No brand (shared)' : brandRow?.name ?? null
    const report = { from: q.from, to: q.to, basisLabel: BASIS_LABEL[q.basis], ...(await purchasesReport(tenantIds, { from, to, basis: q.basis, supplierId: q.supplierId, conceptId: q.conceptId })), brandLabel }
    const format = exportFormatOf(q.format)
    if (!format) return report
    const many = tenantIds.length > 1
    const blank = { date: '', source: '', document: '', stage: '', quantity: '', unit: '', rateCents: '' }
    const rows = [
      ...report.suppliers.flatMap((g) => {
        const supplier = many && g.companyName ? `${g.supplierName} (${g.companyName})` : g.supplierName
        return [
          ...g.lines.map((l) => ({ supplier, date: l.date, source: l.source, document: l.document, stage: l.stage, item: l.item, quantity: l.quantity, unit: l.unit, rateCents: l.rateCents, amountCents: l.amountCents })),
          ...(g.taxCents !== 0 ? [{ supplier, ...blank, item: 'Sales tax', amountCents: g.taxCents }] : []),
          { supplier, ...blank, item: 'TOTAL', amountCents: g.totalCents },
        ]
      }),
      { supplier: 'All suppliers', ...blank, item: 'Items', amountCents: report.totals.itemsCents },
      { supplier: 'All suppliers', ...blank, item: 'Sales tax', amountCents: report.totals.taxCents },
      { supplier: 'All suppliers', ...blank, item: 'TOTAL', amountCents: report.totals.totalCents },
    ]
    return sendReportFor(req, reply, format, { base: `purchases-${q.basis}`, suffix: `${q.from}-to-${q.to}` }, {
      title: `Purchases by supplier — ${BASIS_LABEL[q.basis]}${brandLabel ? ` — ${brandLabel}` : ''}`, period: `${q.from} to ${q.to}`,
      rows, sectionKey: 'supplier', csvEmpty: 'header', wrapKeys: ['item', 'stage', 'document'],
      labels: { rateCents: 'Rate', amountCents: 'Amount', source: 'From', document: 'Document' },
      types: { quantity: 'number' },
      isTotal: (r) => r.item === 'TOTAL',
    })
  })
}
