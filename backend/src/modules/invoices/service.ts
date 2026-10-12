// Tax invoice generation.
//
// Every invoice belongs to ONE company (TaxInvoice.tenantId — the order's
// brand's company; a credit note carries its original's). Numbers are unique
// per company and numbered per series: (company, prefix, year, invoice or
// credit note). Two companies may use the same prefix — each starts at 1 —
// and two brands of one company sharing a prefix share one series.
//
// Numbering scheme: <prefix>-<YYYY>-<00000> for invoices and
// <prefix>-<YYYY>-CN-<00000> for credit notes, where prefix is
// Concept.invoicePrefix (else the slug, upper-cased) and YYYY is the Karachi
// calendar year of issue.
//
// Allocation is race-safe, gap-free and O(1): each series has one row in
// tax_invoice_series holding the last number issued, bumped by a single
// INSERT … ON CONFLICT DO UPDATE … RETURNING inside the issuing transaction.
// The row lock serialises two issues in one series; a rolled-back issue
// rolls its number back. (Review D-RV-3: the MAX() over every invoice the
// company ever issued, run under the lock on every completed order, slowed
// numbering down as history grew.) The issuing transaction also takes a
// transaction-scoped advisory lock on the series first, so the "one invoice
// per order" check runs under it and two concurrent issues for one order give
// one invoice. (The per-brand invoice_counters table this replaced shared one
// counter between a brand's invoices and credit notes, restarted a new year
// at 2, and let two brands with one prefix collide.)

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

const COUNTER_PAD = 5  // STX-2026-00001, plenty of room for years of activity

type Tx = Prisma.TransactionClient
type Series = { tenantId: string; prefix: string; year: number; type: 'invoice' | 'credit_note' }

/** The Karachi calendar year (PKT, UTC+5, no DST) of an instant. */
export function karachiYear(at: Date = new Date()): number {
  return new Date(at.getTime() + 5 * 3_600_000).getUTCFullYear()
}

/** A brand's invoice prefix. */
export function invoicePrefix(concept: { invoicePrefix: string | null; slug: string }): string {
  return concept.invoicePrefix?.trim() || concept.slug.toUpperCase()
}

/** The text every number of a series starts with, before its sequence. */
function seriesHead(s: Series): string {
  return s.type === 'credit_note' ? `${s.prefix}-${s.year}-CN-` : `${s.prefix}-${s.year}-`
}

/** Serialise everything that issues in one series, until the transaction ends. */
async function lockSeries(tx: Tx, s: Series): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`taxinvoice:${s.tenantId}:${s.type}:${seriesHead(s)}`}))`
}

/** Bump a series' counter and return the new last value (the series' row
 *  stays locked until the transaction ends). */
async function bumpSeries(tx: Tx, tenantId: string, head: string, atLeast = 0): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ lastValue: number }>>`
    INSERT INTO "tax_invoice_series" ("tenantId", "head", "lastValue", "updatedAt")
    VALUES (${tenantId}, ${head}, ${atLeast + 1}, NOW())
    ON CONFLICT ("tenantId", "head") DO UPDATE
       SET "lastValue" = GREATEST("tax_invoice_series"."lastValue", ${atLeast}::int) + 1,
           "updatedAt" = NOW()
    RETURNING "lastValue"
  `
  return rows[0]!.lastValue
}

/**
 * The highest sequence issued in a series, read from the invoices themselves
 * by the number's shape, whatever its type (the old per-brand counter gave
 * credit notes invoice-shaped numbers, and those numbers are taken all the
 * same; "<head>CN-…" is not digits, so the credit-note series never feeds the
 * invoice series). A scan of the company's invoices — only ever run when the
 * counter is found behind (a number issued outside it), never on the normal
 * path.
 */
async function highestIssued(tx: Tx, s: Series): Promise<number> {
  const head = seriesHead(s)
  const from = head.length + 1
  const rows = await tx.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING("invoiceNumber" FROM ${from}::int) AS INTEGER))::int AS max
      FROM "tax_invoices"
     WHERE "tenantId" = ${s.tenantId}
       AND LEFT("invoiceNumber", ${head.length}::int) = ${head}
       AND SUBSTRING("invoiceNumber" FROM ${from}::int) ~ '^[0-9]{1,9}$'
  `
  return rows[0]?.max ?? 0
}

/**
 * The next number of a series. Call with the series lock held (lockSeries).
 * O(1): one upsert on the series' counter row, plus one unique-index probe
 * that the number is free. If it is taken — an invoice numbered while the
 * counter was not kept (issued by an older release mid-deploy, or written by
 * hand) — the counter catches up with the highest number issued, once.
 */
async function nextNumber(tx: Tx, s: Series): Promise<string> {
  const head = seriesHead(s)
  const fmt = (seq: number) => `${head}${String(seq).padStart(COUNTER_PAD, '0')}`
  let seq = await bumpSeries(tx, s.tenantId, head)
  const taken = await tx.taxInvoice.findUnique({ where: { tenantId_invoiceNumber: { tenantId: s.tenantId, invoiceNumber: fmt(seq) } }, select: { id: true } })
  if (taken) seq = await bumpSeries(tx, s.tenantId, head, await highestIssued(tx, s))
  return fmt(seq)
}

/** The issuing transaction's limits: a series lock wait in a rush is
 *  expected, so wait longer than Prisma's 2 s / 5 s defaults — but bounded. */
const ISSUE_TX = { maxWait: 10_000, timeout: 20_000 } as const

export interface IssueInvoiceInput {
  orderId: string
  buyer?: {
    name?: string
    strn?: string
    ntn?: string
    address?: string
  }
}

export async function issueInvoiceForOrder(input: IssueInvoiceInput) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: {
        concept: true,
        items: { include: { modifiers: true } },
      },
    })
    if (!order)                            throw new NotFoundError('Order', input.orderId)
    if (order.deletedAt)                   throw new AppError('ORDER_DELETED', 'Cannot issue invoice for deleted order', 422)
    if (order.status !== 'completed')      throw new AppError('ORDER_NOT_COMPLETED', `Order is ${order.status}; only completed orders can be invoiced`, 422)

    // One invoice per order (fast path; re-checked under the series lock).
    const issued = await tx.taxInvoice.findFirst({ where: { orderId: order.id, type: 'invoice' }, include: { lines: true } })
    if (issued) return issued

    const concept = order.concept
    if (!concept.invoiceLegalName) {
      throw new AppError('CONCEPT_NOT_REGISTERED', `Concept ${concept.slug} is missing invoice legal name. Set strn/ntn/invoiceLegalName/invoicePrefix on the concept first.`, 422)
    }
    // The invoice is the brand's company's — the source document decides.
    if (!concept.tenantId) {
      throw new AppError('CONCEPT_NO_COMPANY', `Brand ${concept.slug} belongs to no company, so it cannot issue a tax invoice`, 422)
    }

    const series: Series = { tenantId: concept.tenantId, prefix: invoicePrefix(concept), year: karachiYear(), type: 'invoice' }
    await lockSeries(tx, series)

    // One invoice per order — checked under the series lock, so a second
    // concurrent issue for this order waits and then finds the first.
    const existing = await tx.taxInvoice.findFirst({ where: { orderId: order.id, type: 'invoice' }, include: { lines: true } })
    if (existing) return existing

    const invoiceNumber = await nextNumber(tx, series)

    // Money snapshot — the order's STORED figures, never a recomputation:
    // the GST is Order.taxCents, charged at Order.taxRatePct by
    // lib/pricing.ts priceOrder (tender rate, decision 9). We don't split
    // federal vs provincial here because that mapping is operator policy;
    // until the operator sets explicit per-province fields, all of it lands
    // in fbrTaxCents. The taxable value is the PRE-discount item value — GST
    // is charged on it before any discount (SRB POS rule), so taxable × rate
    // matches the tax on the invoice.
    const subtotal       = order.items
      .filter((i) => i.status !== 'voided')
      .reduce((s, i) => {
        const modSum = i.modifiers.reduce((ms, m) => ms + m.priceDeltaCents, 0)
        return s + (i.unitPriceCents + modSum) * i.quantity
      }, 0)
    const discount       = order.discountCents + order.promoDiscountCents
    const taxable        = subtotal
    const fbrTax         = order.taxCents
    const serviceCharge  = order.serviceChargeCents
    const tip            = order.tipCents
    const total          = Math.max(0, subtotal - discount) + fbrTax + serviceCharge + tip

    return tx.taxInvoice.create({
      data: {
        tenantId: concept.tenantId,
        invoiceNumber,
        type: 'invoice',
        orderId: order.id,
        conceptId: concept.id,
        sellerLegalName: concept.invoiceLegalName,
        sellerStrn: concept.strn,
        sellerNtn: concept.ntn,
        sellerAddress: concept.invoiceAddress,
        buyerName: input.buyer?.name ?? order.customerName,
        buyerStrn: input.buyer?.strn,
        buyerNtn: input.buyer?.ntn,
        buyerAddress: input.buyer?.address,
        subtotalCents: subtotal,
        discountCents: discount,
        taxableValueCents: taxable,
        fbrTaxCents: fbrTax,
        provincialTaxCents: 0,
        serviceChargeCents: serviceCharge,
        tipCents: tip,
        totalCents: total,
        lines: {
          create: order.items.filter((i) => i.status !== 'voided').map((i) => {
            const modSum = i.modifiers.reduce((ms, m) => ms + m.priceDeltaCents, 0)
            const unitPrice = i.unitPriceCents + modSum
            return {
              description: i.modifiers.length > 0
                ? `${i.name} (${i.modifiers.map((m) => m.name).join(', ')})`
                : i.name,
              quantity: i.quantity,
              unitPriceCents: unitPrice,
              lineTotalCents: unitPrice * i.quantity,
            }
          }),
        },
      },
      include: { lines: true },
    })
  }, ISSUE_TX)
}

// Credit note for a refunded order — references the original invoice and
// belongs to the original's company, in that company's credit-note series.
export async function issueCreditNoteForOrder(orderId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const original = await tx.taxInvoice.findFirst({
      where: { orderId, type: 'invoice' },
      include: { lines: true },
    })
    if (!original) throw new NotFoundError('TaxInvoice', orderId)

    const concept = await tx.concept.findUnique({ where: { id: original.conceptId } })
    if (!concept) throw new NotFoundError('Concept', original.conceptId)

    const series: Series = { tenantId: original.tenantId, prefix: invoicePrefix(concept), year: karachiYear(), type: 'credit_note' }
    await lockSeries(tx, series)

    const existing = await tx.taxInvoice.findFirst({
      where: { originalInvoiceId: original.id, type: 'credit_note' },
      include: { lines: true },
    })
    if (existing) return existing

    const invoiceNumber = await nextNumber(tx, series)

    return tx.taxInvoice.create({
      data: {
        tenantId: original.tenantId,
        invoiceNumber,
        type: 'credit_note',
        orderId: original.orderId,
        conceptId: original.conceptId,
        originalInvoiceId: original.id,
        sellerLegalName: original.sellerLegalName,
        sellerStrn: original.sellerStrn,
        sellerNtn: original.sellerNtn,
        sellerAddress: original.sellerAddress,
        buyerName: original.buyerName,
        buyerStrn: original.buyerStrn,
        buyerNtn: original.buyerNtn,
        buyerAddress: original.buyerAddress,
        subtotalCents:      -original.subtotalCents,
        discountCents:      -original.discountCents,
        taxableValueCents:  -original.taxableValueCents,
        fbrTaxCents:        -original.fbrTaxCents,
        provincialTaxCents: -original.provincialTaxCents,
        serviceChargeCents: -original.serviceChargeCents,
        tipCents:           -original.tipCents,
        totalCents:         -original.totalCents,
        lines: {
          create: original.lines.map((l) => ({
            description: `Credit note: ${l.description} — ${reason}`,
            quantity: l.quantity,
            unitPriceCents: -l.unitPriceCents,
            lineTotalCents: -l.lineTotalCents,
          })),
        },
      },
      include: { lines: true },
    })
  }, ISSUE_TX)
}

// HTML render — kept minimal and printable. Operators can pdf-it via the
// browser's print dialog, or wire wkhtmltopdf / Playwright later if they need
// programmatic PDF generation.
export function renderInvoiceHtml(invoice: {
  invoiceNumber: string; type: string; issuedAt: Date
  sellerLegalName: string; sellerStrn?: string | null; sellerNtn?: string | null; sellerAddress?: string | null
  buyerName?: string | null; buyerStrn?: string | null; buyerNtn?: string | null; buyerAddress?: string | null
  subtotalCents: number; discountCents: number; taxableValueCents: number
  fbrTaxCents: number; provincialTaxCents: number; serviceChargeCents: number; tipCents: number; totalCents: number
  lines: Array<{ description: string; quantity: number; unitPriceCents: number; lineTotalCents: number }>
}): string {
  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2 })}`
  const date = invoice.issuedAt.toISOString().slice(0, 10)
  const title = invoice.type === 'credit_note' ? 'Credit Note' : 'Tax Invoice'

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>${title} ${invoice.invoiceNumber}</title>
<style>
  body { font: 14px/1.4 system-ui, -apple-system, sans-serif; color: #111; padding: 32px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color: #666; font-size: 12px; }
  .row { display: flex; gap: 24px; margin: 16px 0; }
  .row > div { flex: 1; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
  th { background: #f7f7f7; font-weight: 600; }
  .right { text-align: right; }
  .totals { margin-left: auto; width: 280px; }
  .totals tr td:first-child { color: #666; }
  .totals tr.grand td { font-weight: 700; font-size: 16px; padding-top: 12px; border-top: 2px solid #111; }
  .footer { margin-top: 32px; font-size: 11px; color: #888; }
  .stamp { display: inline-block; padding: 4px 10px; border: 2px solid #111; border-radius: 4px; font-weight: 700; letter-spacing: 1px; font-size: 11px; }
  @media print { body { padding: 0; } .no-print { display: none; } }
</style>
</head><body>

<h1>${title}</h1>
<div class="muted">${invoice.invoiceNumber} · Issued ${date}</div>

<div class="row">
  <div>
    <strong>From</strong><br/>
    ${escape(invoice.sellerLegalName)}<br/>
    ${invoice.sellerAddress ? escape(invoice.sellerAddress).split('\n').join('<br/>') + '<br/>' : ''}
    ${invoice.sellerStrn ? `STRN: <strong>${escape(invoice.sellerStrn)}</strong><br/>` : ''}
    ${invoice.sellerNtn  ? `NTN: <strong>${escape(invoice.sellerNtn)}</strong>` : ''}
  </div>
  <div>
    <strong>To</strong><br/>
    ${invoice.buyerName ? escape(invoice.buyerName) + '<br/>' : '(walk-in customer)<br/>'}
    ${invoice.buyerAddress ? escape(invoice.buyerAddress).split('\n').join('<br/>') + '<br/>' : ''}
    ${invoice.buyerStrn ? `STRN: ${escape(invoice.buyerStrn)}<br/>` : ''}
    ${invoice.buyerNtn  ? `NTN: ${escape(invoice.buyerNtn)}` : ''}
  </div>
</div>

<table>
  <thead>
    <tr><th>Description</th><th class="right">Qty</th><th class="right">Unit Price</th><th class="right">Line Total</th></tr>
  </thead>
  <tbody>
    ${invoice.lines.map((l) => `
      <tr>
        <td>${escape(l.description)}</td>
        <td class="right">${l.quantity}</td>
        <td class="right">${fmt(l.unitPriceCents)}</td>
        <td class="right">${fmt(l.lineTotalCents)}</td>
      </tr>
    `).join('')}
  </tbody>
</table>

<table class="totals">
  <tr><td>Subtotal</td>          <td class="right">${fmt(invoice.subtotalCents)}</td></tr>
  ${invoice.discountCents !== 0 ?      `<tr><td>Discount</td>          <td class="right">${fmt(-invoice.discountCents)}</td></tr>` : ''}
  <tr><td>Taxable value</td>     <td class="right">${fmt(invoice.taxableValueCents)}</td></tr>
  ${invoice.fbrTaxCents !== 0 ?        `<tr><td>FBR sales tax</td>     <td class="right">${fmt(invoice.fbrTaxCents)}</td></tr>` : ''}
  ${invoice.provincialTaxCents !== 0 ? `<tr><td>Provincial sales tax</td><td class="right">${fmt(invoice.provincialTaxCents)}</td></tr>` : ''}
  ${invoice.serviceChargeCents !== 0 ? `<tr><td>Service charge</td>    <td class="right">${fmt(invoice.serviceChargeCents)}</td></tr>` : ''}
  ${invoice.tipCents !== 0 ?           `<tr><td>Tip</td>               <td class="right">${fmt(invoice.tipCents)}</td></tr>` : ''}
  <tr class="grand"><td>Total</td><td class="right">${fmt(invoice.totalCents)}</td></tr>
</table>

${invoice.type === 'credit_note' ? '<p><span class="stamp">CREDIT NOTE</span></p>' : ''}

<div class="footer">
  This is a computer-generated ${title.toLowerCase()}.
  ${invoice.sellerStrn ? `Registered under FBR sales tax registration ${escape(invoice.sellerStrn)}.` : ''}
</div>

</body></html>`
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!))
}
