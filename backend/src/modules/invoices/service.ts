// Tax invoice generation.
//
// Sequential, gap-free numbering per concept per year. Allocation uses an
// advisory lock on the InvoiceCounter row so concurrent issues serialise
// without losing numbers.
//
// Numbering scheme: <prefix>-<YYYY>-<00000> where prefix comes from
// Concept.invoicePrefix and the counter resets each year.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

const COUNTER_PAD = 5  // STX-2026-00001, plenty of room for years of activity

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
  // Serializable isolation prevents two concurrent issuances from grabbing the
  // same counter value — FBR sequence numbers must be unique and gap-free, and
  // ON CONFLICT alone doesn't give us that guarantee at default Read Committed.
  // Retry up to 3x on serialization failures (Postgres 40001 / Prisma P2034).
  const MAX_RETRIES = 3
  let attempt = 0
  while (true) {
    try {
      return await prisma.$transaction(async (tx) => {
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

    // Prevent duplicates — one invoice per order
    const existing = await tx.taxInvoice.findFirst({ where: { orderId: order.id, type: 'invoice' } })
    if (existing) return existing

    const concept = order.concept
    if (!concept.invoiceLegalName) {
      throw new AppError('CONCEPT_NOT_REGISTERED', `Concept ${concept.slug} is missing invoice legal name. Set strn/ntn/invoiceLegalName/invoicePrefix on the concept first.`, 422)
    }

    // Allocate next number under a row-level lock
    const year = new Date().getUTCFullYear()
    const counter = await tx.$queryRaw<Array<{ nextValue: number }>>`
      INSERT INTO "invoice_counters" ("conceptId", "year", "nextValue")
      VALUES (${concept.id}, ${year}, 1)
      ON CONFLICT ("conceptId") DO UPDATE
        SET "year" = CASE WHEN "invoice_counters"."year" = ${year} THEN "invoice_counters"."year" ELSE ${year} END,
            "nextValue" = CASE WHEN "invoice_counters"."year" = ${year}
                               THEN "invoice_counters"."nextValue" + 1
                               ELSE 2 END
      RETURNING "nextValue"
    `
    const seq = counter[0]!.nextValue
    const padded = String(seq).padStart(COUNTER_PAD, '0')
    const prefix = concept.invoicePrefix ?? concept.slug.toUpperCase()
    const invoiceNumber = `${prefix}-${year}-${padded}`

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

    const invoice = await tx.taxInvoice.create({
      data: {
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

        return invoice
      }, { isolationLevel: 'Serializable' })
    } catch (err: unknown) {
      const code = (err as { code?: string }).code
      // P2034 = Prisma's serialization-failure retry signal.
      // 40001 = Postgres' raw serialization-failure SQLSTATE.
      if ((code === 'P2034' || code === '40001') && ++attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 25 * attempt))
        continue
      }
      throw err
    }
  }
}

// Credit note for a refunded order — references the original invoice.
export async function issueCreditNoteForOrder(orderId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const original = await tx.taxInvoice.findFirst({
      where: { orderId, type: 'invoice' },
      include: { lines: true },
    })
    if (!original) throw new NotFoundError('TaxInvoice', orderId)

    const existing = await tx.taxInvoice.findFirst({
      where: { originalInvoiceId: original.id, type: 'credit_note' },
    })
    if (existing) return existing

    const concept = await tx.concept.findUnique({ where: { id: original.conceptId } })
    if (!concept) throw new NotFoundError('Concept', original.conceptId)

    const year = new Date().getUTCFullYear()
    const counter = await tx.$queryRaw<Array<{ nextValue: number }>>`
      INSERT INTO "invoice_counters" ("conceptId", "year", "nextValue")
      VALUES (${concept.id}, ${year}, 1)
      ON CONFLICT ("conceptId") DO UPDATE
        SET "year" = CASE WHEN "invoice_counters"."year" = ${year} THEN "invoice_counters"."year" ELSE ${year} END,
            "nextValue" = CASE WHEN "invoice_counters"."year" = ${year}
                               THEN "invoice_counters"."nextValue" + 1
                               ELSE 2 END
      RETURNING "nextValue"
    `
    const seq = counter[0]!.nextValue
    const padded = String(seq).padStart(COUNTER_PAD, '0')
    const prefix = concept.invoicePrefix ?? concept.slug.toUpperCase()
    const invoiceNumber = `${prefix}-${year}-CN-${padded}`

    return tx.taxInvoice.create({
      data: {
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
  }, { isolationLevel: 'Serializable' })
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
