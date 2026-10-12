// Pre-bills (owner amendment 2026-10-10, spec §17.1–§17.3).
//
// A pre-bill is the guest check printed for an OPEN order before payment (the
// till, the waiter screen). It is NOT a tax invoice:
//   • it never creates or touches a FiscalDocument and is never sent to the
//     POS connector — only the full & final (FnF) bill files, and the FnF
//     event is completeOrder (exactly once per order);
//   • it never posts to the ledger and never feeds revenue or tax reports;
//   • every print, reprints included, is a permanent PreBill row with a
//     gap-free per-company number (PB-<n>). Nothing deletes, hides or edits
//     one — Finance → "Voided pre bills" reads them all, with flags.
//
// Totals come from THE server quote (quoteOrderForTender in pos/service.ts —
// the same pricing the payment will demand). Nothing here computes tax.
//
// Lifecycle (status), driven by the order:
//   open        the latest pre-bill of an order that is not final yet
//   superseded  a later pre-bill was printed for the same order
//   converted   the order reached its FnF bill  (markPreBillsConvertedTx,
//               called by completeOrder inside its claim transaction)
//   cancelled   the order was cancelled / voided / rejected before FnF
//               (markPreBillsCancelledTx, with the MANAGER who approved it)

import type { FastifyRequest } from 'fastify'
import type { Prisma, PreBill, PreBillStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, shiftOfCompany } from '../../lib/tenantScope.js'
import { getReceiptConfig } from '../../lib/setup-config.js'
import { formatBrandName } from '../../lib/brandName.js'
import { fmtPkr as fmtPkrShared } from '../accounting/csv.js'
import { tenderOfPayments } from '../../lib/pricing.js'
import { quoteOrderForTender, lockOrderTx } from '../pos/service.js'

type Tx = Prisma.TransactionClient

export type PreBillTender = 'cash' | 'card'

/** The banner every pre-bill prints. A pre-bill must never look like a bill. */
export const PRE_BILL_BANNER = 'PRE-BILL — NOT A TAX INVOICE' as const

/** One line as printed (voided lines excluded). Stored in PreBill.lines. */
export type PreBillLine = {
  orderItemId: string
  name: string
  qty: number
  unitPriceCents: number
  modifiers: Array<{ name: string; priceDeltaCents: number }>
  /** (unit + add-ons) × qty. */
  lineCents: number
}

/**
 * What the till / tablet prints for a pre-bill. The receipt-data shape
 * (pos/receipt.ts ReceiptData) with `kind: 'pre_bill'`, the pre-bill banner,
 * `number: 'PB-<n>'` and NO fiscal fields (no fiscal number, no QR, no
 * TaxInvoice number, no FBR / SRB ids).
 */
export interface PreBillReceipt {
  kind: 'pre_bill'
  banner: typeof PRE_BILL_BANNER
  /** "PB-<n>" — printed where a bill prints "Invoice #". */
  number: string
  preBillId: string
  orderId: string
  /** Short order reference (last 8 of the id). */
  orderRef: string
  conceptName: string
  legalName: string
  strn: string | null
  ntn: string | null
  customerName: string | null
  table: string | null
  source: string
  items: Array<{
    name: string
    qty: number
    /** Unit price INCLUDING add-ons, so qty × price is the line total. */
    price: number
    lineTotalCents: number
    modifiers: string[]
  }>
  subtotalCents: number
  discountCents: number
  taxCents: number
  serviceChargeCents: number
  /**
   * What the quote's total holds beyond subtotal − discount + GST + service
   * (a tip already on the order; negative = credits already applied). Shown
   * so the printed lines add up to the printed total. Not computed tax.
   */
  otherCents: number
  /** The headline total, at `tender`. */
  totalCents: number
  /** The quote basis of the headline total. */
  tender: PreBillTender
  /** The card-tender total printed under a cash headline (GST splits by tender); null on a card pre-bill. */
  cardTotalCents: number | null
  /**
   * Already paid on the order when the pre-bill was printed (a split bill
   * part-settled). The quote's paidCents — printed as "Paid so far" so the
   * guest is never shown the whole bill as what is still owed.
   */
  paidCents: number
  /** What is still owed at the headline tender: max(0, total − paid). The quote's dueCents. */
  dueCents: number
  printedAt: string
  printedBy: string | null
  placedAt: string
  /** The order's status when printed. */
  status: string
}

/** Short order reference, as the receipt prints it. */
export function orderRefOf(orderId: string): string {
  return orderId.slice(-8).toUpperCase()
}

export function preBillLabel(number: number): string {
  return `PB-${number}`
}

// ─── Create ──────────────────────────────────────────────────────────────────

/** An order in one of these is past the point of a pre-bill. */
const NOT_OPEN = new Set(['cancelled', 'rejected', 'refunded'])

/**
 * What the quote depended on. Read once before the quote and again under the
 * order lock: if anything moved in between (a line added or voided, a payment
 * taken, a re-price), the quote is stale and the print is retried.
 */
async function orderFingerprint(db: Tx | typeof prisma, orderId: string): Promise<string | null> {
  const o = await db.order.findUnique({
    where: { id: orderId },
    select: {
      status: true, totalCents: true, taxCents: true, taxRatePct: true, discountCents: true, promoDiscountCents: true,
      serviceChargeCents: true, tipCents: true, walletAmountCents: true,
      items: { select: { id: true, status: true, quantity: true, unitPriceCents: true, voidedAt: true, modifiers: { select: { priceDeltaCents: true } } } },
      payments: { select: { id: true, status: true, amountCents: true } },
    },
  })
  if (!o) return null
  const items = o.items
    .map((i) => `${i.id}:${i.status}:${i.quantity}:${i.unitPriceCents}:${i.voidedAt ? 1 : 0}:${i.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)}`)
    .sort()
  const pays = o.payments.map((p) => `${p.id}:${p.status}:${p.amountCents}`).sort()
  return [
    o.status, o.totalCents, o.taxCents, o.taxRatePct ?? '-', o.discountCents, o.promoDiscountCents,
    o.serviceChargeCents, o.tipCents, o.walletAmountCents, items.join(','), pays.join(','),
  ].join('|')
}

class StaleQuote extends Error {}

export interface CreatePreBillInput {
  orderId: string
  actor: { id: string; role: string; email?: string | null }
  tender?: PreBillTender
  req: FastifyRequest
}

/**
 * Print a pre-bill for an open order. The order must be in one of the
 * operator's companies (foreign → 404), open (cancelled / rejected / refunded
 * → 409 ORDER_NOT_OPEN) and not final (completed, or fully paid → 409
 * ALREADY_FINAL). In ONE transaction: lock the order, take the company's next
 * number, mark the order's open pre-bills superseded, insert the pre-bill and
 * write the `prebill.print` audit row. Never touches fiscal documents.
 */
export async function createPreBill(input: CreatePreBillInput): Promise<{ preBill: PreBill; receipt: PreBillReceipt }> {
  const tender: PreBillTender = input.tender ?? 'cash'
  const scope = await scopeTenantWhere(input.req, 'write')
  const found = await prisma.order.findFirst({
    where: { id: input.orderId, deletedAt: null, concept: { deletedAt: null, ...scope } },
    select: { id: true, concept: { select: { tenantId: true } } },
  })
  const tenantId = found?.concept.tenantId
  if (!found || !tenantId) throw new NotFoundError('Order', input.orderId)

  for (let attempt = 0; ; attempt++) {
    // Cheap refusals before quoting (re-checked under the lock below).
    const pre = await prisma.order.findUniqueOrThrow({ where: { id: found.id }, select: { status: true } })
    assertPrintable(pre.status)

    const before = await orderFingerprint(prisma, found.id)
    const quote = await quoteOrderForTender(found.id, tender)
    const cardQuote = tender === 'cash' ? await quoteOrderForTender(found.id, 'card') : null
    try {
      return await prisma.$transaction(async (tx) => {
        await lockOrderTx(tx, found.id)
        if ((await orderFingerprint(tx, found.id)) !== before) throw new StaleQuote()
        const order = await tx.order.findUniqueOrThrow({
          where: { id: found.id },
          include: {
            concept: { select: { name: true, invoiceLegalName: true, ntn: true, strn: true } },
            items: { where: { status: { not: 'voided' } }, include: { modifiers: true }, orderBy: { createdAt: 'asc' } },
            table: { select: { label: true } },
            customer: { select: { name: true } },
          },
        })
        assertPrintable(order.status)
        if (quote.paidCents > 0 && quote.dueCents === 0) {
          throw new AppError('ALREADY_FINAL', 'This order is fully paid — print the full & final bill instead', 409)
        }

        const lines: PreBillLine[] = order.items.map((it) => {
          const unit = it.unitPriceCents + it.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)
          return {
            orderItemId: it.id,
            name: it.name,
            qty: it.quantity,
            unitPriceCents: it.unitPriceCents,
            modifiers: it.modifiers.map((m) => ({ name: m.name, priceDeltaCents: m.priceDeltaCents })),
            lineCents: unit * it.quantity,
          }
        })

        // The drawer the pre-bill sits on: the order's own, else the printer's
        // open drawer in the order's company (orphan detection reads it).
        const shiftId = order.shiftId ?? (await tx.shift.findFirst({
          where: { userId: input.actor.id, status: 'open', ...shiftOfCompany({ tenantId }) },
          orderBy: { openedAt: 'desc' },
          select: { id: true },
        }))?.id ?? null

        // Gap-free per-company number: the counter row is created or bumped
        // under its row lock, inside this transaction (a rollback gives the
        // number back).
        const [{ number }] = await tx.$queryRaw<Array<{ number: number }>>`
          INSERT INTO pre_bill_counters ("tenantId", "next") VALUES (${tenantId}, 2)
          ON CONFLICT ("tenantId") DO UPDATE SET "next" = pre_bill_counters."next" + 1
          RETURNING ("next" - 1)::int AS number`

        const now = new Date()
        const superseded = await tx.preBill.updateMany({
          where: { orderId: order.id, status: 'open' },
          data: { status: 'superseded', statusAt: now },
        })
        const preBill = await tx.preBill.create({
          data: {
            tenantId,
            conceptId: order.conceptId,
            locationId: order.locationId,
            orderId: order.id,
            shiftId,
            number,
            tableLabel: order.table?.label ?? null,
            printedById: input.actor.id,
            printedAt: now,
            tender,
            lines: lines satisfies Prisma.InputJsonValue,
            subtotalCents: lines.reduce((s, l) => s + l.lineCents, 0),
            discountCents: quote.discountCents + order.promoDiscountCents,
            serviceChargeCents: quote.serviceChargeCents,
            taxCents: quote.taxCents,
            totalCents: quote.totalCents,
            cardTotalCents: cardQuote ? cardQuote.totalCents : null,
          },
        })
        await tx.auditLog.create({
          data: {
            category: 'identity',
            tenantId,
            action: 'prebill.print',
            entity: 'PreBill',
            entityId: preBill.id,
            userId: input.actor.id,
            userEmail: input.actor.email ?? null,
            metadata: {
              orderId: order.id,
              number: preBillLabel(number),
              tender,
              totalCents: preBill.totalCents,
              cardTotalCents: preBill.cardTotalCents,
              // PreBill has no paid column: the print's audit row is where a
              // later re-render reads "Paid so far" back from.
              paidCents: quote.paidCents,
              dueCents: quote.dueCents,
              supersededCount: superseded.count,
            },
          },
        })
        const printer = await tx.user.findUnique({ where: { id: input.actor.id }, select: { name: true } })
        return {
          preBill,
          receipt: receiptOf(preBill, {
            concept: order.concept,
            customerName: order.customer?.name ?? order.customerName ?? null,
            source: order.source,
            placedAt: order.placedAt,
            orderStatus: order.status,
            printedBy: printer?.name ?? null,
            paidCents: quote.paidCents,
          }),
        }
      })
    } catch (err) {
      if (err instanceof StaleQuote) {
        if (attempt < 2) continue
        throw new AppError('ORDER_CHANGED', 'The bill changed while the pre-bill was printing — print it again', 409)
      }
      throw err
    }
  }
}

function assertPrintable(status: string): void {
  if (status === 'completed') {
    throw new AppError('ALREADY_FINAL', 'This order is already paid and closed — print the full & final bill instead', 409)
  }
  if (NOT_OPEN.has(status)) {
    throw new AppError('ORDER_NOT_OPEN', `This order is ${status} — a pre-bill can only be printed for an open order`, 409)
  }
}

interface ReceiptContext {
  concept: { name: string; invoiceLegalName: string | null; ntn: string | null; strn: string | null }
  customerName: string | null
  source: string
  placedAt: Date
  orderStatus: string
  printedBy: string | null
  /** Paid on the order when this pre-bill was printed. */
  paidCents: number
}

function readLines(json: Prisma.JsonValue): PreBillLine[] {
  return Array.isArray(json) ? (json as unknown[]).filter((l): l is PreBillLine => !!l && typeof l === 'object' && 'lineCents' in l) : []
}

/** The receipt shape of a stored pre-bill. Built from the ROW (the permanent record), never re-priced. */
function receiptOf(pb: PreBill, ctx: ReceiptContext): PreBillReceipt {
  const lines = readLines(pb.lines)
  const conceptName = formatBrandName(ctx.concept.name)
  return {
    kind: 'pre_bill',
    banner: PRE_BILL_BANNER,
    number: preBillLabel(pb.number),
    preBillId: pb.id,
    orderId: pb.orderId,
    orderRef: orderRefOf(pb.orderId),
    conceptName,
    legalName: ctx.concept.invoiceLegalName ?? conceptName,
    strn: ctx.concept.strn ?? null,
    ntn: ctx.concept.ntn ?? null,
    customerName: ctx.customerName,
    table: pb.tableLabel,
    source: ctx.source,
    items: lines.map((l) => ({
      name: l.name,
      qty: l.qty,
      price: l.qty > 0 ? Math.round(l.lineCents / l.qty) : l.lineCents,
      lineTotalCents: l.lineCents,
      modifiers: l.modifiers.map((m) => m.name).filter(Boolean),
    })),
    subtotalCents: pb.subtotalCents,
    discountCents: pb.discountCents,
    taxCents: pb.taxCents,
    serviceChargeCents: pb.serviceChargeCents,
    otherCents: pb.totalCents - (pb.subtotalCents - pb.discountCents + pb.taxCents + pb.serviceChargeCents),
    totalCents: pb.totalCents,
    tender: pb.tender === 'card' ? 'card' : 'cash',
    cardTotalCents: pb.cardTotalCents,
    paidCents: ctx.paidCents,
    dueCents: Math.max(0, pb.totalCents - ctx.paidCents),
    printedAt: pb.printedAt.toISOString(),
    printedBy: ctx.printedBy,
    placedAt: ctx.placedAt.toISOString(),
    status: ctx.orderStatus,
  }
}

// ─── Lifecycle hooks (called by W4 inside the order's own transactions) ──────

/**
 * The order reached its full & final bill. Call inside completeOrder's claim
 * transaction. The open pre-bill becomes `converted`; superseded ones keep
 * their status but carry the final total too, so every print of the order can
 * be compared with what was finally charged.
 */
export async function markPreBillsConvertedTx(
  tx: Tx,
  orderId: string,
  finalTotalCents: number,
  at: Date = new Date(),
): Promise<{ converted: number; superseded: number }> {
  // Same lock createPreBill holds while it supersedes + inserts, so a print
  // racing the FnF bill is either fully before this (and converts) or sees
  // the final order and refuses. A re-lock inside the caller's transaction is
  // a no-op.
  await lockOrderTx(tx, orderId)
  const converted = await tx.preBill.updateMany({
    where: { orderId, status: 'open' },
    data: { status: 'converted', statusAt: at, finalTotalCents, finalAt: at },
  })
  const superseded = await tx.preBill.updateMany({
    where: { orderId, status: 'superseded' },
    data: { finalTotalCents, finalAt: at },
  })
  return { converted: converted.count, superseded: superseded.count }
}

/**
 * The order was cancelled / voided / rejected before its FnF bill. Call in
 * every cancel / void-whole-order path, inside its transaction, with the
 * MANAGER who approved it (null only for a system cancel, e.g. the
 * auto-cancel worker). Every open or superseded pre-bill of the order becomes
 * `cancelled` — and shows up flagged ORPHANED in Finance → Voided pre bills.
 */
export async function markPreBillsCancelledTx(
  tx: Tx,
  orderId: string,
  approverId: string | null,
  reason: string | null,
  at: Date = new Date(),
): Promise<{ cancelled: number }> {
  // Serialise with createPreBill (which holds this lock while it supersedes
  // and inserts): without it a print racing the cancel could commit an 'open'
  // pre-bill this update never sees — left open on a cancelled order with no
  // manager recorded. Under the lock the update below runs on a fresh
  // snapshot and catches it. A re-lock in the caller's transaction is a no-op.
  await lockOrderTx(tx, orderId)
  const r = await tx.preBill.updateMany({
    where: { orderId, status: { in: ['open', 'superseded'] satisfies PreBillStatus[] } },
    data: { status: 'cancelled', statusAt: at, cancelledById: approverId, cancelReason: reason },
  })
  return { cancelled: r.count }
}

// ─── Printable HTML ──────────────────────────────────────────────────────────

const fmtPkr = (cents: number): string => fmtPkrShared(cents, { symbol: true, group: false })

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-PK', {
    timeZone: 'Asia/Karachi', hour12: true,
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/** Item names, customer names and operator text are user input. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The stored pre-bill as receipt data, or 404 when it is not in the operator's companies. */
export async function preBillReceiptFor(preBillId: string, req: FastifyRequest): Promise<{ preBill: PreBill; receipt: PreBillReceipt }> {
  const preBill = await prisma.preBill.findFirst({ where: { id: preBillId, ...(await scopeTenantWhere(req, 'write')) } })
  if (!preBill) throw new NotFoundError('Pre-bill', preBillId)
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: preBill.orderId },
    select: {
      source: true, placedAt: true, status: true, customerName: true,
      customer: { select: { name: true } },
      concept: { select: { name: true, invoiceLegalName: true, ntn: true, strn: true } },
    },
  })
  const printer = await prisma.user.findUnique({ where: { id: preBill.printedById }, select: { name: true } })
  return {
    preBill,
    receipt: receiptOf(preBill, {
      concept: order.concept,
      customerName: order.customer?.name ?? order.customerName ?? null,
      source: order.source,
      placedAt: order.placedAt,
      orderStatus: order.status,
      printedBy: printer?.name ?? null,
      paidCents: await paidAtPrint(preBill),
    }),
  }
}

/**
 * What was already paid on the order when the pre-bill was printed: the
 * figure the print transaction recorded on its `prebill.print` audit row;
 * for a row without one, the order's payments taken by then (paid, or paid
 * and later refunded).
 */
async function paidAtPrint(pb: PreBill): Promise<number> {
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'prebill.print', entity: 'PreBill', entityId: pb.id },
    select: { metadata: true },
  })
  const recorded = (audit?.metadata as { paidCents?: unknown } | null)?.paidCents
  if (typeof recorded === 'number' && Number.isInteger(recorded) && recorded >= 0) return recorded
  const paid = await prisma.payment.aggregate({
    where: { orderId: pb.orderId, status: { in: ['paid', 'refunded'] }, amountCents: { gt: 0 }, createdAt: { lte: pb.printedAt } },
    _sum: { amountCents: true },
  })
  return paid._sum.amountCents ?? 0
}

/**
 * The pre-bill as printable HTML (same look as the receipt). Rendered from
 * the stored row — a later re-render prints the same figures, marked COPY
 * (every render is audited `prebill.render`). Foreign → 404.
 */
export async function renderPreBillHtml(preBillId: string, req: FastifyRequest): Promise<string> {
  const { preBill, receipt: r } = await preBillReceiptFor(preBillId, req)
  const cfg = await getReceiptConfig(preBill.tenantId)

  const priorRenders = await prisma.auditLog.count({ where: { action: 'prebill.render', entity: 'PreBill', entityId: preBill.id } })
  await prisma.auditLog.create({
    data: {
      category: 'identity',
      tenantId: preBill.tenantId,
      action: 'prebill.render',
      entity: 'PreBill',
      entityId: preBill.id,
      userId: req.staffUser?.id ?? null,
      userEmail: req.staffUser?.email ?? null,
      metadata: { orderId: preBill.orderId, number: r.number, copy: priorRenders > 0 },
    },
  })

  const itemRows = r.items.map((item) => {
    const mods = item.modifiers.length
      ? `<div style="font-size:11px;color:#555;padding-left:8px">${item.modifiers.map((m) => `+ ${esc(m)}`).join(', ')}</div>`
      : ''
    return `
      <tr>
        <td style="padding:2px 0;vertical-align:top">${item.qty}×</td>
        <td style="padding:2px 4px;vertical-align:top">${esc(item.name)}${mods}</td>
        <td style="padding:2px 0;text-align:right;white-space:nowrap;vertical-align:top">${fmtPkr(item.lineTotalCents)}</td>
      </tr>`
  }).join('')

  const widthMm = cfg.paperWidthMm === 58 ? 58 : 80
  const screenWidth = cfg.paperWidthMm === 58 ? 240 : 320
  const row = (label: string, value: string) => `<tr><td>${label}</td><td style="text-align:right">${value}</td></tr>`
  const banners = [r.banner, priorRenders > 0 ? 'COPY' : null].filter((b): b is string => !!b)
  const tenderLabel = r.tender === 'card' ? 'card' : 'cash'

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Pre-bill – ${esc(r.number)}</title>
<style>
  @page { margin: 0; size: ${widthMm}mm auto }
  * { box-sizing: border-box }
  body { font-family: 'Courier New', monospace; font-size: 12px; margin: 0; padding: 8px; width: ${widthMm}mm; color: #000 }
  .center { text-align: center }
  .bold { font-weight: bold }
  .divider { border-top: 1px dashed #999; margin: 6px 0 }
  table { width: 100%; border-collapse: collapse }
  img.logo { max-width: 60%; max-height: 60px; display: block; margin: 0 auto 6px }
  @media screen { body { max-width: ${screenWidth}px; margin: 20px auto; background: #fff; padding: 16px; box-shadow: 0 0 8px rgba(0,0,0,.15) } }
</style>
</head>
<body>
  ${cfg.showLogo && cfg.logoUrl ? `<img class="logo" src="${esc(cfg.logoUrl)}" alt="">` : ''}
  <div class="center bold" style="font-size:16px">${esc(r.conceptName)}</div>
  ${cfg.headerText ? `<div class="center" style="font-size:11px">${esc(cfg.headerText)}</div>` : ''}
  <div class="center bold" style="font-size:15px;border:2px solid #000;padding:4px;margin:6px 0">${banners.map(esc).join(' · ')}</div>
  <div class="divider"></div>
  <div>Pre-bill #: <strong>${esc(r.number)}</strong></div>
  <div>Order: ${esc(r.orderRef)}</div>
  <div>Printed: ${fmtDate(r.printedAt)}</div>
  ${r.printedBy ? `<div>By: ${esc(r.printedBy)}</div>` : ''}
  ${r.customerName ? `<div>Customer: ${esc(r.customerName)}</div>` : ''}
  ${r.table ? `<div>Table: ${esc(r.table)}</div>` : ''}
  <div class="divider"></div>
  <table>${itemRows}</table>
  <div class="divider"></div>
  <table>
    ${row('Subtotal', fmtPkr(r.subtotalCents))}
    ${r.discountCents > 0 ? row('Discount', `-${fmtPkr(r.discountCents)}`) : ''}
    ${r.taxCents > 0 ? row(`GST (${tenderLabel})`, fmtPkr(r.taxCents)) : ''}
    ${r.serviceChargeCents > 0 ? row('Service charge', fmtPkr(r.serviceChargeCents)) : ''}
    ${r.otherCents > 0 ? row('Tip', fmtPkr(r.otherCents)) : ''}
    ${r.otherCents < 0 ? row('Credits applied', `-${fmtPkr(-r.otherCents)}`) : ''}
    <tr class="bold"><td style="border-top:1px solid #000;padding-top:4px">TOTAL (${tenderLabel.toUpperCase()})</td><td style="border-top:1px solid #000;padding-top:4px;text-align:right">${fmtPkr(r.totalCents)}</td></tr>
    ${r.paidCents > 0 ? row('Paid so far', `-${fmtPkr(r.paidCents)}`) : ''}
    ${r.paidCents > 0 ? `<tr class="bold"><td>BALANCE DUE</td><td style="text-align:right">${fmtPkr(r.dueCents)}</td></tr>` : ''}
    ${r.cardTotalCents != null && r.cardTotalCents !== r.totalCents ? row('If paid by card', fmtPkr(r.cardTotalCents)) : ''}
  </table>
  <div class="divider"></div>
  <div class="center bold" style="font-size:11px">${esc(r.banner)}</div>
  <div class="center" style="font-size:10px">Your full &amp; final bill is printed after payment.</div>
  <div class="divider"></div>
  <div class="center" style="font-size:10px;color:#555">Powered by servd</div>
  <script>window.onload = function(){ window.print() }</script>
</body>
</html>`
}

// ─── Finance → Voided pre bills ──────────────────────────────────────────────
//
// Every pre-bill of the companies in view, with flags computed at read:
//   ORPHANED          the order was cancelled / rejected, or it is still not
//                     final and its drawer has closed or the pre-bill is more
//                     than 12 h old — a guest was shown a bill that never
//                     became a sale;
//   FINAL_LOWER       the converted pre-bill's order was finally charged LESS
//                     than the pre-bill's total FOR THE TENDER IT WAS SETTLED
//                     WITH (tenderOfPayments, the rule processPayment prices
//                     by: all card-class → the card total printed under a
//                     cash headline; any cash, a mix, or no payments → the
//                     headline). Paid by card at the card total is not
//                     "lower"; paid in cash at the card total is;
//   LINE_VOIDS_AFTER  lines of the order were voided after this pre-bill was
//                     printed (with the manager who approved each void).
// Read-only. There is no delete, hide, edit or exclude.
//
// The summary counts PRINTS (every reprint is its own permanent row) and
// ORDERS, and counts MONEY once per order: a bill reprinted three times and
// then cancelled is one PKR X walk-out, not 3X.

export type PreBillFlag = 'ORPHANED' | 'FINAL_LOWER' | 'LINE_VOIDS_AFTER'

/** A pre-bill still not final after this long is orphaned even while its drawer is open. */
export const ORPHAN_AFTER_MS = 12 * 3600_000

export interface PreBillListFilter {
  /** Companies in view (resolveTenantScope). Empty → nothing. */
  tenantIds: string[]
  from: Date
  to: Date
  conceptId?: string
  printedById?: string
  status?: PreBillStatus
  flaggedOnly?: boolean
  now?: Date
}

export interface LineVoidAfter {
  orderItemId: string
  name: string
  qty: number
  cents: number
  voidedAt: string
  reason: string | null
  approverId: string | null
  approver: string | null
}

export interface PreBillRow {
  id: string
  number: number
  label: string
  tenantId: string
  printedAt: string
  conceptId: string
  brand: string
  table: string | null
  orderId: string
  orderRef: string
  orderStatus: string
  printedById: string
  printedBy: string | null
  tender: string
  /** The headline total at `tender`. */
  totalCents: number
  cardTotalCents: number | null
  subtotalCents: number
  discountCents: number
  serviceChargeCents: number
  taxCents: number
  lines: PreBillLine[]
  status: PreBillStatus
  statusAt: string | null
  finalTotalCents: number | null
  finalAt: string | null
  /** final − pre-bill headline; null until the order is final. */
  differenceCents: number | null
  cancelledById: string | null
  cancelledBy: string | null
  cancelReason: string | null
  lineVoidsAfter: { count: number; cents: number; items: LineVoidAfter[] }
  flags: PreBillFlag[]
}

export interface PreBillSummary {
  /** Pre-bills printed (reprints included). */
  count: number
  /** Distinct orders those pre-bills were printed for. */
  orders: number
  /** Each order's latest pre-bill total in the selection, summed (money once per order). */
  valueCents: number
  /** count = flagged prints; cents = each orphaned order's latest flagged pre-bill, once per order. */
  orphaned: { count: number; orders: number; cents: number }
  /** diffCents: how far below the settled-tender pre-bill total the final bills came, summed (positive). One converted row per order. */
  finalLower: { count: number; orders: number; diffCents: number }
  /** count = flagged prints; cents = the distinct voided lines (each counted once per order). */
  lineVoidsAfter: { count: number; orders: number; cents: number }
}

export interface PreBillList {
  from: string
  to: string
  rows: PreBillRow[]
  summary: PreBillSummary
  /** Rows were capped at LIST_CAP; narrow the range. */
  truncated: boolean
  facets: {
    concepts: Array<{ id: string; name: string }>
    printers: Array<{ id: string; name: string | null }>
  }
}

const LIST_CAP = 5000
const FINAL_STATUSES = new Set(['completed', 'refunded'])
const DEAD_STATUSES = new Set(['cancelled', 'rejected'])

export async function listPreBills(f: PreBillListFilter): Promise<PreBillList> {
  const now = f.now ?? new Date()
  // An empty scope DENIES — never "no filter".
  const tenantWhere = { tenantId: { in: f.tenantIds } }
  const where: Prisma.PreBillWhereInput = {
    ...tenantWhere,
    printedAt: { gte: f.from, lte: f.to },
    ...(f.conceptId && { conceptId: f.conceptId }),
    ...(f.printedById && { printedById: f.printedById }),
    ...(f.status && { status: f.status }),
  }
  const found = await prisma.preBill.findMany({
    where,
    orderBy: [{ printedAt: 'desc' }, { number: 'desc' }],
    take: LIST_CAP + 1,
  })
  const truncated = found.length > LIST_CAP
  const preBills = truncated ? found.slice(0, LIST_CAP) : found

  const orderIds = [...new Set(preBills.map((p) => p.orderId))]
  const orders = orderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: {
          id: true, status: true, shiftId: true,
          // The tender the order was settled with decides which pre-bill
          // total FINAL_LOWER compares against. Refunded rows were paid.
          payments: {
            where: { status: { in: ['paid', 'refunded'] }, amountCents: { gt: 0 } },
            select: { method: true },
          },
          items: {
            where: { voidedAt: { not: null } },
            select: { id: true, name: true, quantity: true, unitPriceCents: true, voidedAt: true, voidReason: true, modifiers: { select: { priceDeltaCents: true } } },
          },
        },
      })
    : []
  const orderById = new Map(orders.map((o) => [o.id, o]))

  const shiftIds = [...new Set(preBills.map((p) => p.shiftId ?? orderById.get(p.orderId)?.shiftId).filter((x): x is string => !!x))]
  const shifts = shiftIds.length
    ? await prisma.shift.findMany({ where: { id: { in: shiftIds } }, select: { id: true, status: true } })
    : []
  const shiftClosed = new Map(shifts.map((s) => [s.id, s.status === 'closed']))

  // Who approved each void: the order_item_void audit row (pos/service.ts
  // voidOrderItem) carries the approver; the voider is the fallback.
  const voidedItemIds = orders.flatMap((o) => o.items.map((i) => i.id))
  const voidAudits = voidedItemIds.length
    ? await prisma.auditLog.findMany({
        where: { action: 'order_item_void', entity: 'OrderItem', entityId: { in: voidedItemIds } },
        select: { entityId: true, userId: true, metadata: true },
        orderBy: { createdAt: 'asc' },
      })
    : []
  const approverOfItem = new Map<string, string | null>()
  for (const a of voidAudits) {
    const meta = a.metadata as { approverId?: unknown } | null
    approverOfItem.set(a.entityId!, typeof meta?.approverId === 'string' ? meta.approverId : a.userId)
  }

  const conceptIds = [...new Set(preBills.map((p) => p.conceptId))]
  const userIds = [...new Set([
    ...preBills.map((p) => p.printedById),
    ...preBills.map((p) => p.cancelledById).filter((x): x is string => !!x),
    ...[...approverOfItem.values()].filter((x): x is string => !!x),
  ])]
  const [concepts, users] = await Promise.all([
    conceptIds.length ? prisma.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
  ])
  const brandOf = new Map(concepts.map((c) => [c.id, formatBrandName(c.name)]))
  const nameOf = new Map(users.map((u) => [u.id, u.name]))

  const all: PreBillRow[] = preBills.map((p) => {
    const order = orderById.get(p.orderId)
    const orderStatus = order?.status ?? 'unknown'
    const voids: LineVoidAfter[] = (order?.items ?? [])
      .filter((i) => i.voidedAt && i.voidedAt.getTime() > p.printedAt.getTime())
      .map((i) => {
        const approverId = approverOfItem.get(i.id) ?? null
        return {
          orderItemId: i.id,
          name: i.name,
          qty: i.quantity,
          cents: (i.unitPriceCents + i.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)) * i.quantity,
          voidedAt: i.voidedAt!.toISOString(),
          reason: i.voidReason,
          approverId,
          approver: approverId ? nameOf.get(approverId) ?? null : null,
        }
      })
    const voidCents = voids.reduce((s, v) => s + v.cents, 0)

    const shiftId = p.shiftId ?? order?.shiftId ?? null
    const notFinal = !FINAL_STATUSES.has(orderStatus) && !DEAD_STATUSES.has(orderStatus) && p.status !== 'converted'
    const orphaned = DEAD_STATUSES.has(orderStatus) || p.status === 'cancelled'
      || (notFinal && ((shiftId != null && shiftClosed.get(shiftId) === true) || now.getTime() - p.printedAt.getTime() > ORPHAN_AFTER_MS))
    const finalLower = p.status === 'converted' && p.finalTotalCents != null
      && p.finalTotalCents < settledBaseCents(p, order?.payments ?? [])

    const flags: PreBillFlag[] = []
    if (orphaned) flags.push('ORPHANED')
    if (finalLower) flags.push('FINAL_LOWER')
    if (voids.length > 0) flags.push('LINE_VOIDS_AFTER')

    return {
      id: p.id,
      number: p.number,
      label: preBillLabel(p.number),
      tenantId: p.tenantId,
      printedAt: p.printedAt.toISOString(),
      conceptId: p.conceptId,
      brand: brandOf.get(p.conceptId) ?? '',
      table: p.tableLabel,
      orderId: p.orderId,
      orderRef: orderRefOf(p.orderId),
      orderStatus,
      printedById: p.printedById,
      printedBy: nameOf.get(p.printedById) ?? null,
      tender: p.tender,
      totalCents: p.totalCents,
      cardTotalCents: p.cardTotalCents,
      subtotalCents: p.subtotalCents,
      discountCents: p.discountCents,
      serviceChargeCents: p.serviceChargeCents,
      taxCents: p.taxCents,
      lines: readLines(p.lines),
      status: p.status,
      statusAt: p.statusAt?.toISOString() ?? null,
      finalTotalCents: p.finalTotalCents,
      finalAt: p.finalAt?.toISOString() ?? null,
      differenceCents: p.finalTotalCents != null ? p.finalTotalCents - p.totalCents : null,
      cancelledById: p.cancelledById,
      cancelledBy: p.cancelledById ? nameOf.get(p.cancelledById) ?? null : null,
      cancelReason: p.cancelReason,
      lineVoidsAfter: { count: voids.length, cents: voidCents, items: voids },
      flags,
    }
  })

  // The summary covers every row the filters select; "Flagged only" narrows
  // the table, not the totals.
  const baseOf = new Map(preBills.map((p) => [p.id, settledBaseCents(p, orderById.get(p.orderId)?.payments ?? [])]))
  const summary = summarise(all, baseOf)
  const rows = f.flaggedOnly ? all.filter((r) => r.flags.length > 0) : all

  // Filter choices: every brand of the companies in view (deleted brands too
  // when they hold pre-bills — a pre-bill is never hidden), and everyone who
  // printed one in the range.
  const [scopeConcepts, printerGroups] = await Promise.all([
    prisma.concept.findMany({
      where: { ...tenantWhere, OR: [{ deletedAt: null }, { id: { in: conceptIds } }] },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.preBill.groupBy({ by: ['printedById'], where: { ...tenantWhere, printedAt: { gte: f.from, lte: f.to } } }),
  ])
  const printerIds = printerGroups.map((g) => g.printedById)
  const printerUsers = printerIds.length
    ? await prisma.user.findMany({ where: { id: { in: printerIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
    : []

  return {
    from: f.from.toISOString(),
    to: f.to.toISOString(),
    rows,
    summary,
    truncated,
    facets: {
      concepts: scopeConcepts.map((c) => ({ id: c.id, name: formatBrandName(c.name) })),
      printers: printerUsers.map((u) => ({ id: u.id, name: u.name })),
    },
  }
}

/**
 * The pre-bill total the final bill should be compared with: the total for
 * the tender the order was settled with (tenderOfPayments — all card-class →
 * card; any cash, a mix, or nothing paid → cash, the rate processPayment
 * charges). A cash pre-bill printed the card total under its headline; a
 * card pre-bill printed only the card total, so it is the base either way.
 */
function settledBaseCents(p: Pick<PreBill, 'tender' | 'totalCents' | 'cardTotalCents'>, payments: Array<{ method: string }>): number {
  const settled = tenderOfPayments(payments.map((x) => x.method))
  if (settled === 'card' && p.tender === 'cash') return p.cardTotalCents ?? p.totalCents
  return p.totalCents
}

/** Prints and orders counted; money counted once per order (see the header above). */
function summarise(all: PreBillRow[], baseOf: Map<string, number>): PreBillSummary {
  const summary: PreBillSummary = {
    count: all.length,
    orders: 0,
    valueCents: 0,
    orphaned: { count: 0, orders: 0, cents: 0 },
    finalLower: { count: 0, orders: 0, diffCents: 0 },
    lineVoidsAfter: { count: 0, orders: 0, cents: 0 },
  }
  const latest = new Map<string, PreBillRow>()
  const latestOrphan = new Map<string, PreBillRow>()
  const lowerOrders = new Set<string>()
  const voidsByOrder = new Map<string, Map<string, number>>()
  for (const r of all) {
    const l = latest.get(r.orderId)
    if (!l || r.number > l.number) latest.set(r.orderId, r)
    if (r.flags.includes('ORPHANED')) {
      summary.orphaned.count++
      const o = latestOrphan.get(r.orderId)
      if (!o || r.number > o.number) latestOrphan.set(r.orderId, r)
    }
    if (r.flags.includes('FINAL_LOWER')) {
      summary.finalLower.count++
      lowerOrders.add(r.orderId)
      summary.finalLower.diffCents += (baseOf.get(r.id) ?? r.totalCents) - (r.finalTotalCents ?? 0)
    }
    if (r.flags.includes('LINE_VOIDS_AFTER')) {
      summary.lineVoidsAfter.count++
      const items = voidsByOrder.get(r.orderId) ?? new Map<string, number>()
      for (const v of r.lineVoidsAfter.items) items.set(v.orderItemId, v.cents)
      voidsByOrder.set(r.orderId, items)
    }
  }
  summary.orders = latest.size
  for (const r of latest.values()) summary.valueCents += r.totalCents
  summary.orphaned.orders = latestOrphan.size
  for (const r of latestOrphan.values()) summary.orphaned.cents += r.totalCents
  summary.finalLower.orders = lowerOrders.size
  summary.lineVoidsAfter.orders = voidsByOrder.size
  for (const items of voidsByOrder.values()) for (const c of items.values()) summary.lineVoidsAfter.cents += c
  return summary
}

/** The list as CSV — the same columns as the table. */
export function preBillsCsvRows(rows: PreBillRow[]): Array<Record<string, string | number | null>> {
  const pkr = (c: number | null) => (c == null ? null : fmtPkrShared(c))
  return rows.map((r) => ({
    'Pre-bill': r.label,
    'Printed at (PKT)': fmtDate(r.printedAt),
    Brand: r.brand,
    Table: r.table,
    Order: r.orderRef,
    'Order status': r.orderStatus,
    'Printed by': r.printedBy,
    Tender: r.tender,
    'Pre-bill total': pkr(r.totalCents),
    'Card total': pkr(r.cardTotalCents),
    Status: r.status,
    'Final total': pkr(r.finalTotalCents),
    Difference: pkr(r.differenceCents),
    'Cancelled by': r.cancelledBy,
    'Cancel reason': r.cancelReason,
    'Line voids after': r.lineVoidsAfter.count,
    'Line voids after (PKR)': pkr(r.lineVoidsAfter.cents),
    Flags: r.flags.join(' '),
  }))
}
