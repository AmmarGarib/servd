// Receipts. ONE builder: buildReceiptData() reads the order as it was stored
// and charged — its taxCents and totalCents, never a recomputation — plus the
// numbers that identify it: our TaxInvoice number when one has been issued
// (the brand's order reference otherwise), and the FBR / SRB invoice ids and
// SRB verification link the tax authorities returned.
//
//   GET /pos/orders/:id/receipt-data  → the data itself (tablet thermal print)
//   GET /pos/receipt/:orderId         → buildReceiptHtml(), the same data as
//                                       printable HTML (admin / web POS)
//
// There used to be two builders that disagreed: the HTML one recomputed GST at
// the legacy concept.taxRate (17%) on the post-discount base, so its printed
// total did not match what the customer was charged, and the JSON one left
// modifiers out of the subtotal and used a different receipt number.

import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { getReceiptConfig } from '../../lib/setup-config.js'
import { fmtPkr as fmtPkrShared } from '../accounting/csv.js'
import { formatBrandName } from '../../lib/brandName.js'

export interface ReceiptData {
  /** The number printed as "Invoice #": our TaxInvoice number, else the order reference. */
  number: string
  /** Our TaxInvoice number — null until one is issued (or the brand is not registered). */
  invoiceNumber: string | null
  /** Short order reference (last 8 of the id) — always present. */
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
    /** Unit price INCLUDING modifiers, so qty × price is the line total. */
    price: number
    lineTotalCents: number
    modifiers: string[]
  }>
  /** Sum of the lines (modifiers included, voided lines excluded). */
  subtotalCents: number
  discountCents: number
  taxCents: number
  serviceChargeCents: number
  tipCents: number
  /** What the order was charged — Order.totalCents. */
  totalCents: number
  paidCents: number
  tenderType: string | null
  payments: Array<{ method: string; amountCents: number; tenderedCents: number | null }>
  placedAt: string
  /** Ids returned by the tax authorities — printed as-is when present. */
  fbrInvoiceNo: string | null
  srbInvoiceNo: string | null
  srbQrLink: string | null
}

export async function buildReceiptData(orderId: string): Promise<ReceiptData> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: { select: { name: true, invoiceLegalName: true, ntn: true, strn: true } },
      items: {
        where: { status: { not: 'voided' } },
        include: { modifiers: true },
        orderBy: { createdAt: 'asc' },
      },
      payments: { where: { status: 'paid' }, orderBy: { createdAt: 'asc' } },
      customer: { select: { name: true } },
      table: { select: { label: true } },
      taxInvoices: { where: { type: 'invoice' }, select: { invoiceNumber: true }, take: 1 },
    },
  })
  if (!order) throw new NotFoundError('Order', orderId)

  const items = order.items.map((it) => {
    const unit = it.unitPriceCents + it.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)
    return {
      name: it.name,
      qty: it.quantity,
      price: unit,
      lineTotalCents: unit * it.quantity,
      modifiers: it.modifiers.map((m) => m.name).filter(Boolean),
    }
  })
  const orderRef = order.id.slice(-8).toUpperCase()
  const invoiceNumber = order.taxInvoices[0]?.invoiceNumber ?? null

  return {
    number: invoiceNumber ?? orderRef,
    invoiceNumber,
    orderRef,
    conceptName: formatBrandName(order.concept.name),
    legalName: order.concept.invoiceLegalName ?? formatBrandName(order.concept.name),
    strn: order.concept.strn ?? null,
    ntn: order.concept.ntn ?? null,
    customerName: order.customer?.name ?? order.customerName ?? null,
    table: order.table?.label ?? null,
    source: order.source,
    items,
    subtotalCents: items.reduce((s, i) => s + i.lineTotalCents, 0),
    discountCents: order.discountCents + order.promoDiscountCents,
    taxCents: order.taxCents,
    serviceChargeCents: order.serviceChargeCents,
    tipCents: order.tipCents,
    totalCents: order.totalCents,
    paidCents: order.payments.reduce((s, p) => s + p.amountCents, 0),
    tenderType: order.payments[0]?.method ?? null,
    payments: order.payments.map((p) => ({ method: p.method, amountCents: p.amountCents, tenderedCents: p.tenderedCents ?? null })),
    placedAt: order.placedAt.toISOString(),
    fbrInvoiceNo: order.fbrInvoiceNumber ?? null,
    srbInvoiceNo: order.srbInvoiceNumber ?? null,
    srbQrLink: order.srbQrCodeLink ?? null,
  }
}

// The one PKR formatter (accounting/csv.ts), in the receipt's "PKR 1234.56" form.
const fmtPkr = (cents: number): string => fmtPkrShared(cents, { symbol: true, group: false })

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-PK', { timeZone: 'Asia/Karachi', hour12: true,
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit' })
}

/** Item names, customer names and operator text are user input. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function buildReceiptHtml(orderId: string): Promise<string> {
  const r = await buildReceiptData(orderId)
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { concept: { select: { tenantId: true } } } })
  const cfg = await getReceiptConfig(order?.concept.tenantId ?? null)

  const itemRows = r.items.map((item) => {
    const modLines = item.modifiers.length
      ? `<div style="font-size:11px;color:#555;padding-left:8px">${item.modifiers.map((m) => `+ ${esc(m)}`).join(', ')}</div>`
      : ''
    return `
      <tr>
        <td style="padding:2px 0;vertical-align:top">${item.qty}×</td>
        <td style="padding:2px 4px;vertical-align:top">${esc(item.name)}${modLines}</td>
        <td style="padding:2px 0;text-align:right;white-space:nowrap;vertical-align:top">${fmtPkr(item.lineTotalCents)}</td>
      </tr>`
  }).join('')

  const widthMm = cfg.paperWidthMm === 58 ? 58 : 80
  const screenWidth = cfg.paperWidthMm === 58 ? 240 : 320

  // Tax breakdown — only render if showTaxBreakdown is enabled (some operators
  // prefer a single VAT-inclusive total to avoid customer confusion). The
  // amount is the GST the order was charged; no rate is printed, because the
  // order does not store which rate (cash or card) was applied.
  const taxRow = cfg.showTaxBreakdown && r.taxCents > 0
    ? `<tr><td>GST</td><td style="text-align:right">${fmtPkr(r.taxCents)}</td></tr>`
    : ''
  const serviceRow = r.serviceChargeCents > 0
    ? `<tr><td>Service charge</td><td style="text-align:right">${fmtPkr(r.serviceChargeCents)}</td></tr>`
    : ''
  const tipRow = r.tipCents > 0
    ? `<tr><td>Tip</td><td style="text-align:right">${fmtPkr(r.tipCents)}</td></tr>`
    : ''
  const authorityRows = [
    cfg.showFbrInvoice && r.fbrInvoiceNo ? `<div>FBR Invoice: ${esc(r.fbrInvoiceNo)}</div>` : '',
    r.srbInvoiceNo ? `<div>SRB Invoice No: ${esc(r.srbInvoiceNo)}</div>` : '',
    r.srbQrLink ? `<div style="font-size:10px;word-break:break-all">Verify with SRB: ${esc(r.srbQrLink)}</div>` : '',
  ].filter(Boolean).join('')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Receipt – ${esc(r.number)}</title>
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
  ${r.legalName !== r.conceptName ? `<div class="center" style="font-size:11px">${esc(r.legalName)}</div>` : ''}
  ${cfg.headerText ? `<div class="center" style="font-size:11px">${esc(cfg.headerText)}</div>` : ''}
  ${r.strn ? `<div class="center" style="font-size:10px">STRN: ${esc(r.strn)}</div>` : ''}
  ${r.ntn ? `<div class="center" style="font-size:10px">NTN: ${esc(r.ntn)}</div>` : ''}
  <div class="divider"></div>
  <div>Invoice #: <strong>${esc(r.number)}</strong></div>
  ${r.invoiceNumber ? `<div>Order: ${esc(r.orderRef)}</div>` : ''}
  <div>Date: ${fmtDate(r.placedAt)}</div>
  ${r.customerName ? `<div>Customer: ${esc(r.customerName)}</div>` : ''}
  ${r.table ? `<div>Table: ${esc(r.table)}</div>` : ''}
  <div class="divider"></div>
  <table>${itemRows}</table>
  <div class="divider"></div>
  <table>
    <tr><td>Subtotal</td><td style="text-align:right">${fmtPkr(r.subtotalCents)}</td></tr>
    ${r.discountCents > 0 ? `<tr><td>Discount</td><td style="text-align:right">-${fmtPkr(r.discountCents)}</td></tr>` : ''}
    ${taxRow}
    ${serviceRow}
    ${tipRow}
    <tr class="bold"><td style="border-top:1px solid #000;padding-top:4px">TOTAL</td><td style="border-top:1px solid #000;padding-top:4px;text-align:right">${fmtPkr(r.totalCents)}</td></tr>
  </table>
  ${r.payments.length > 0 ? `
  <div class="divider"></div>
  ${r.payments.map((p) => `<div>${esc(p.method.replace(/_/g, ' '))} ${fmtPkr(p.amountCents)}${p.tenderedCents && p.tenderedCents > p.amountCents ? ` / Change: ${fmtPkr(p.tenderedCents - p.amountCents)}` : ''}</div>`).join('')}
  ` : ''}
  ${authorityRows ? `<div class="divider"></div>${authorityRows}` : ''}
  ${cfg.legalDisclaimer ? `<div class="divider"></div><div class="center" style="font-size:10px;color:#555">${esc(cfg.legalDisclaimer)}</div>` : ''}
  <div class="divider"></div>
  <div class="center" style="font-size:11px">${esc(cfg.footerText ?? 'Thank you for dining with us!')}</div>
  <div class="center" style="font-size:10px;color:#555">Powered by servd</div>
  <script>window.onload = function(){ window.print() }</script>
</body>
</html>`
}
