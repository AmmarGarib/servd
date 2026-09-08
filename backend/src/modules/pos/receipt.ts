// Receipt formatter — returns styled HTML for browser print
// Works with any printer connected to the device (thermal, laser, inkjet).

import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { getReceiptConfig } from '../../lib/setup-config.js'

function fmtPkr(cents: number): string {
  return `PKR ${(cents / 100).toFixed(2)}`
}

function fmtDate(d: Date): string {
  return d.toLocaleString('en-PK', { timeZone: 'Asia/Karachi', hour12: true,
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit' })
}

export async function buildReceiptHtml(orderId: string): Promise<string> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: { select: { name: true, taxRate: true, invoiceLegalName: true, ntn: true, strn: true, tenantId: true } },
      items: {
        where: { status: { not: 'voided' } },
        include: { modifiers: true },
        orderBy: { createdAt: 'asc' },
      },
      payments: { where: { status: 'paid' } },
      customer: { select: { name: true, phone: true } },
    },
  })

  if (!order) throw new NotFoundError('Order', orderId)

  const cfg = await getReceiptConfig(order.concept.tenantId)

  const taxRate = order.concept.taxRate ?? 17
  const subtotalCents = order.items.reduce((s, i) => {
    const mods = i.modifiers.reduce((ms, m) => ms + m.priceDeltaCents * i.quantity, 0)
    return s + i.unitPriceCents * i.quantity + mods
  }, 0)
  const discountCents = order.discountCents ?? 0
  const taxCents = Math.round((subtotalCents - discountCents) * taxRate / 100)
  const serviceChargeCents = order.serviceChargeCents ?? 0
  const totalCents = subtotalCents - discountCents + taxCents + serviceChargeCents

  const itemRows = order.items.map((item) => {
    const modTotal = item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)
    const lineTotal = (item.unitPriceCents + modTotal) * item.quantity
    const modLines = item.modifiers.length
      ? `<div style="font-size:11px;color:#555;padding-left:8px">${item.modifiers.map((m) => `+ ${m.name}`).join(', ')}</div>`
      : ''
    return `
      <tr>
        <td style="padding:2px 0;vertical-align:top">${item.quantity}×</td>
        <td style="padding:2px 4px;vertical-align:top">${item.name}${modLines}</td>
        <td style="padding:2px 0;text-align:right;white-space:nowrap;vertical-align:top">${fmtPkr(lineTotal)}</td>
      </tr>`
  }).join('')

  const legalName = order.concept.invoiceLegalName ?? order.concept.name
  const invoiceNum = cfg.showFbrInvoice && order.fbrInvoiceNumber ? order.fbrInvoiceNumber : order.id.slice(-8).toUpperCase()
  const widthMm = cfg.paperWidthMm === 58 ? 58 : 80
  const screenWidth = cfg.paperWidthMm === 58 ? 240 : 320

  // Tax breakdown — only render if showTaxBreakdown is enabled (some operators
  // prefer a single VAT-inclusive total to avoid customer confusion).
  const taxRow = cfg.showTaxBreakdown
    ? `<tr><td>GST ${taxRate}%</td><td style="text-align:right">${fmtPkr(taxCents)}</td></tr>`
    : ''
  const serviceRow = serviceChargeCents > 0
    ? `<tr><td>Service charge</td><td style="text-align:right">${fmtPkr(serviceChargeCents)}</td></tr>`
    : ''

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Receipt – ${invoiceNum}</title>
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
  ${cfg.showLogo && cfg.logoUrl ? `<img class="logo" src="${cfg.logoUrl}" alt="">` : ''}
  <div class="center bold" style="font-size:16px">${order.concept.name}</div>
  ${legalName !== order.concept.name ? `<div class="center" style="font-size:11px">${legalName}</div>` : ''}
  ${cfg.headerText ? `<div class="center" style="font-size:11px">${cfg.headerText}</div>` : ''}
  ${order.concept.strn ? `<div class="center" style="font-size:10px">STRN: ${order.concept.strn}</div>` : ''}
  ${order.concept.ntn ? `<div class="center" style="font-size:10px">NTN: ${order.concept.ntn}</div>` : ''}
  <div class="divider"></div>
  <div>Invoice #: <strong>${invoiceNum}</strong></div>
  <div>Date: ${fmtDate(order.placedAt)}</div>
  ${order.customer ? `<div>Customer: ${order.customer.name}</div>` : ''}
  ${order.tableId ? `<div>Table: ${order.tableId}</div>` : ''}
  <div class="divider"></div>
  <table>${itemRows}</table>
  <div class="divider"></div>
  <table>
    <tr><td>Subtotal</td><td style="text-align:right">${fmtPkr(subtotalCents)}</td></tr>
    ${discountCents > 0 ? `<tr><td>Discount</td><td style="text-align:right">-${fmtPkr(discountCents)}</td></tr>` : ''}
    ${taxRow}
    ${serviceRow}
    <tr class="bold"><td style="border-top:1px solid #000;padding-top:4px">TOTAL</td><td style="border-top:1px solid #000;padding-top:4px;text-align:right">${fmtPkr(totalCents)}</td></tr>
  </table>
  ${order.payments.length > 0 ? `
  <div class="divider"></div>
  ${order.payments.map((p) => `<div>${p.method.replace(/_/g,' ')} ${fmtPkr(p.amountCents)}${p.tenderedCents && p.tenderedCents > p.amountCents ? ` / Change: ${fmtPkr(p.tenderedCents - p.amountCents)}` : ''}</div>`).join('')}
  ` : ''}
  ${cfg.legalDisclaimer ? `<div class="divider"></div><div class="center" style="font-size:10px;color:#555">${cfg.legalDisclaimer}</div>` : ''}
  <div class="divider"></div>
  <div class="center" style="font-size:11px">${cfg.footerText ?? 'Thank you for dining with us!'}</div>
  <div class="center" style="font-size:10px;color:#555">Powered by servd</div>
  <script>window.onload = function(){ window.print() }</script>
</body>
</html>`
}
