// Receipts. ONE builder: buildReceiptData() reads the order as it was stored
// and charged — its taxCents and totalCents, never a recomputation — plus the
// numbers that identify it.
//
// This is the FULL & FINAL bill (spec §11, §17.1): only an order that reached
// its FnF prints one — completed (or since refunded / cancelled, bannered so),
// or fully paid and waiting for its hand-off (an online order paid by card,
// still in the kitchen — W4-FISCAL-3; the same "paid and nothing due" rule
// the pre-bill refuses on, so the two never point at each other). An order
// with money still due answers 409 PRE_BILL_REQUIRED — the till prints a
// pre-bill (modules/prebills) instead, which is never a tax invoice and never
// goes to the fiscal POS. Printing the bill files nothing: the sale document
// is created at completion (orders/service completeOrder), exactly once.
//
// The fiscal block comes from the order's SALE document (connectors/fiscal):
//   filed     → "{AUTH} Fiscal Invoice: {number}" + a real QR; the fiscal
//               number is the headline "Invoice #" and our TaxInvoice number
//               prints as "Ref" (owner flag a)
//   pending / failed → "Fiscal invoice: pending" — never a servd number
//               presented as a fiscal number
//   held      → "Fiscal invoice: not yet issued" (the company is not live on
//               the fiscal POS yet — no promise of a QR on a reprint, W4-RG-3)
//   none yet  → paid, not completed: "issued when the order is completed";
//               completed with no document (its enqueue failed and the
//               recovery has not run yet — W4-FISCAL-2): "pending"
//   test      → TEST — NOT A FISCAL INVOICE
//   not required (§17.7) → "Not a tax invoice"
//   legacy    → a sale filed directly with FBR / SRB before the connector
// The old fbrInvoiceNo / srbInvoiceNo / srbQrLink keys stay for installed
// tablets (filled from a FILED, non-test document, else the order columns).
//
//   GET /pos/orders/:id/receipt-data  → the data itself (tablet thermal print)
//   GET /pos/receipt/:orderId         → buildReceiptHtml(), the same data as
//                                       printable HTML (admin / web POS)
//
// A delivery order prints its delivery charge (Order.deliveryFeeCents) as its
// own row, and the GST row is ALL the GST charged with the delivery's share
// named — "GST (incl. PKR x on delivery)" — so the printed rows add up to the
// total (H9). A bill charged to an on-account client names the client and
// carries the client's signature line.
//
// There used to be two builders that disagreed: the HTML one recomputed GST at
// the legacy concept.taxRate (17%) on the post-discount base, so its printed
// total did not match what the customer was charged, and the JSON one left
// modifiers out of the subtotal and used a different receipt number.

import { removalLabels } from '../../lib/lineRemovals.js'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { getReceiptConfig } from '../../lib/setup-config.js'
import { fmtPkr as fmtPkrShared } from '../accounting/csv.js'
import { formatBrandName } from '../../lib/brandName.js'
import { fiscalViewForOrder, type FiscalView } from '../../connectors/fiscal/view.js'
import { renderQrSvg } from '../../connectors/fiscal/qr.js'
import { fiscalReportingRequired } from '../../connectors/config.js'
import { tenderLabel, ON_ACCOUNT_TENDER } from '../../lib/tenders.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { isTestTenant } from '../../lib/testCompany.js'

/** A string field of a JSON object, trimmed; null when absent or blank. */
function metaStr(o: unknown, key: string): string | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const v = (o as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * How a tender prints (lib/tenders TENDER_LABEL): "Cash", "Card – Keenu",
 * "Keenu QR (retired)" — a Raast QR transfer with its bank reference,
 * "Raast QR — Ref <bankRef>", so the customer and the till can trace it — and
 * an on-account bill with the client it was charged to, "On account — Acme
 * Ltd (OA-0003) · PO 4471" (Payment.gatewayMeta.onAccount {name, number,
 * reference}; the account number is also the row's gatewayRef). `reference`
 * is the Raast bank reference or the on-account client's reference (their
 * PO / who signed); null for the other tenders.
 */
export function paymentLabelOf(p: { method: string; gatewayRef: string | null; gatewayMeta?: unknown }): { label: string; reference: string | null } {
  if (p.method === ON_ACCOUNT_TENDER) {
    const oa = p.gatewayMeta && typeof p.gatewayMeta === 'object' ? (p.gatewayMeta as Record<string, unknown>)['onAccount'] : null
    const name = metaStr(oa, 'name')
    const number = metaStr(oa, 'number') ?? (p.gatewayRef?.trim() || null)
    const reference = metaStr(oa, 'reference')
    const who = [name, number ? `(${number})` : null].filter((x): x is string => !!x).join(' ')
    const label = `${tenderLabel(p.method)}${who ? ` — ${who}` : ''}${reference ? ` · ${reference}` : ''}`
    return { label, reference }
  }
  const reference = p.method === 'raast' && p.gatewayRef ? p.gatewayRef : null
  return { label: reference ? `${tenderLabel(p.method)} — Ref ${reference}` : tenderLabel(p.method), reference }
}

/** The line a client signs on a bill charged to their account. */
export const CLIENT_SIGNATURE_LINE = 'Client signature ________________' as const

/** Statuses that have had their full & final bill (or ended, bannered CANCELLED). */
const FINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'refunded', 'cancelled', 'rejected'])

export const FULL_AND_FINAL_HEADING = 'FULL & FINAL BILL' as const
/** Printed at the top of every document of a test company (owner, 2026-10-14). */
export const TEST_COMPANY_BANNER = 'TEST COMPANY — NOT A REAL SALE'
export const TEST_FISCAL_BANNER = 'TEST — NOT A FISCAL INVOICE' as const
export const NOT_TAX_INVOICE = 'Not a tax invoice' as const

/** A sale filed directly with FBR / SRB before the POS connector (Order columns). */
export interface LegacyFiscal {
  status: 'legacy'
  authority: 'srb' | 'fbr'
  fiscalNumber: string
  qrPayload: string | null
  verifyUrl: string | null
  /** Both numbers when the sale was filed with both authorities. */
  fbrInvoiceNo: string | null
  srbInvoiceNo: string | null
}

/**
 * A sale that should have a fiscal document but has none yet: a fully paid
 * order before its completion ('awaiting_completion'), or a completed one
 * whose document is still being recovered ('not_queued'). Printed as
 * pending — never a servd number presented as a fiscal number.
 */
export interface AwaitingFiscal {
  status: 'pending'
  kind: 'sale'
  documentId: null
  rawStatus: null
  statusReason: 'awaiting_completion' | 'not_queued'
  fiscalNumber: null
  authority: null
  qrPayload: null
  verifyUrl: null
  fiscalAt: null
  isTest: false
}

export type ReceiptFiscal = FiscalView | LegacyFiscal | AwaitingFiscal

/**
 * Has this order reached its full & final bill? Completed / refunded /
 * cancelled / rejected, or paid with nothing left due — the pre-bill's own
 * ALREADY_FINAL rule (money taken, total covered).
 */
export function isFinalBill(status: string, paid?: { paidCents: number; totalCents: number }): boolean {
  if (FINAL_STATUSES.has(status)) return true
  return !!paid && paid.paidCents > 0 && paid.paidCents >= paid.totalCents
}

/** 409 PRE_BILL_REQUIRED — an order with money still due has no full & final bill yet (§17.1). */
export function assertFinalBill(status: string, paid?: { paidCents: number; totalCents: number }): void {
  if (!isFinalBill(status, paid)) {
    throw new AppError('PRE_BILL_REQUIRED', "This order isn't fully paid yet — print a pre-bill", 409)
  }
}

function awaitingFiscal(statusReason: AwaitingFiscal['statusReason']): AwaitingFiscal {
  return {
    status: 'pending', kind: 'sale', documentId: null, rawStatus: null, statusReason,
    fiscalNumber: null, authority: null, qrPayload: null, verifyUrl: null, fiscalAt: null, isTest: false,
  }
}

export interface ReceiptData {
  /** 'final_bill' for a completed (or since refunded) sale, or one fully paid awaiting hand-off; 'cancelled' for an order that ended without one. */
  kind: 'final_bill' | 'cancelled'
  /** FULL & FINAL BILL on a sale's bill; null on a cancelled order's slip. */
  heading: string | null
  /**
   * The number printed as "Invoice #": the fiscal number once the sale is
   * FILED (not a test), else our TaxInvoice number, else the order reference.
   */
  number: string
  /** Our TaxInvoice number, printed as "Ref" when the fiscal number is the headline. */
  servdRef: string | null
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
    /** "No onions" — ingredients the customer asked to leave out (lib/lineRemovals.ts). Price unchanged. */
    removals?: string[]
  }>
  /** Sum of the lines (modifiers included, voided lines excluded). */
  subtotalCents: number
  discountCents: number
  /** The delivery charge BEFORE GST (Order.deliveryFeeCents; 0 for pickup, dine-in, the till and legacy orders). */
  deliveryFeeCents: number
  /** The GST on the delivery charge — already inside taxCents (Order.deliveryFeeTaxCents). */
  deliveryFeeTaxCents: number
  /** All the GST charged: on the food AND on the delivery (Order.taxCents). */
  taxCents: number
  serviceChargeCents: number
  tipCents: number
  /** What the order was charged — Order.totalCents. */
  totalCents: number
  paidCents: number
  tenderType: string | null
  /**
   * The tenders. `label` is how the tender prints ("Cash", "Card – Keenu",
   * "Raast QR — Ref <bankRef>", "On account — <client> (<OA-number>)");
   * `reference` is a Raast transfer's bank reference or an on-account
   * client's reference (null for the others).
   */
  payments: Array<{ method: string; amountCents: number; tenderedCents: number | null; label: string; reference: string | null }>
  /** A paid on-account row exists: the bill carries the client's signature line. */
  clientSignature: boolean
  /** The order's status — a receipt for a refunded / cancelled order is not a valid bill. */
  status: string
  /**
   * FOH-23: what the receipt must say about the bill's standing, printed as a
   * banner: REFUNDED (in full), PARTLY REFUNDED, CANCELLED, or null for a
   * normal receipt.
   */
  banner: 'REFUNDED' | 'PARTLY REFUNDED' | 'CANCELLED' | null
  /** Money handed back (refund rows), oldest first; amounts positive. `label` as the payments' (a Raast refund with its outgoing transfer's reference). */
  refunds: Array<{ method: string; amountCents: number; at: string; label: string; reference: string | null }>
  refundedCents: number
  placedAt: string
  /**
   * The sale's fiscal document (spec §11): a FiscalView, a legacy direct
   * filing, or null when there is none (no FnF bill yet, a cancelled order,
   * a company that does not report sales).
   */
  fiscal: ReceiptFiscal | null
  /** The company does not report sales to a fiscal POS (§17.7): the bill says "Not a tax invoice". */
  notTaxInvoice: boolean
  /** The order belongs to a test company (owner, 2026-10-14): printed "TEST COMPANY — NOT A REAL SALE". */
  testCompany?: boolean
  /** A payment taken on the card machine: what the slip says. */
  card: { brand: string | null; last4: string | null; authCode: string | null } | null
  /** Legacy keys for installed tablets — a FILED (non-test) fiscal number, else the order's own columns. */
  fbrInvoiceNo: string | null
  srbInvoiceNo: string | null
  srbQrLink: string | null
}

/** A filed document's extra authority numbers (e.g. SRB alongside FBR). */
type ExtraNumber = { authority: string; number: string; qrPayload?: string; verifyUrl?: string }

function extraNumbersOf(v: unknown): ExtraNumber[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is ExtraNumber =>
    !!x && typeof x === 'object' && typeof (x as ExtraNumber).authority === 'string' && typeof (x as ExtraNumber).number === 'string')
}

/**
 * The full & final bill's data. Throws 409 PRE_BILL_REQUIRED for an order that
 * has not reached it (§17.1).
 */
export async function buildReceiptData(orderId: string): Promise<ReceiptData> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: { select: { name: true, invoiceLegalName: true, ntn: true, strn: true, tenantId: true } },
      items: {
        include: { modifiers: true },
        orderBy: { createdAt: 'asc' },
      },
      payments: { where: { status: { in: ['paid', 'refunded'] } }, orderBy: { createdAt: 'asc' } },
      customer: { select: { name: true } },
      table: { select: { label: true } },
      taxInvoices: { where: { type: 'invoice' }, select: { invoiceNumber: true }, take: 1 },
    },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  const paidRows = order.payments.filter((p) => p.status === 'paid' && p.amountCents > 0)
  assertFinalBill(order.status, { paidCents: paidRows.reduce((s, p) => s + p.amountCents, 0), totalCents: order.totalCents })
  const cancelled = order.status === 'cancelled' || order.status === 'rejected'

  // A line voided on a PAID, still-open order was not taken off the bill — its
  // value went back as a refund (pos/service voidOrderItem, TILL-R3). It stays
  // on the bill marked "(refunded)", so the lines add up to the TOTAL and the
  // refund row below takes it off — exactly as the fiscal sale lists it.
  const refundedVoidIds = new Set(order.payments
    .filter((p) => p.status === 'refunded')
    .map((p) => (p.gatewayMeta as { refund?: { voidedItemId?: unknown } } | null)?.refund?.voidedItemId)
    .filter((v): v is string => typeof v === 'string'))
  const items = order.items.filter((it) => it.status !== 'voided' || refundedVoidIds.has(it.id)).map((it) => {
    const unit = it.unitPriceCents + it.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)
    return {
      name: it.status === 'voided' ? `${it.name} (refunded)` : it.name,
      qty: it.quantity,
      price: unit,
      lineTotalCents: unit * it.quantity,
      modifiers: it.modifiers.map((m) => m.name).filter(Boolean),
      removals: removalLabels(it.removedIngredients),
    }
  })
  const orderRef = orderRefOf(order.id)
  const invoiceNumber = order.taxInvoices[0]?.invoiceNumber ?? null
  const paid = order.payments.filter((p) => p.status === 'paid')
  const refunds = order.payments
    .filter((p) => p.status === 'refunded')
    .map((p) => ({ method: p.method, amountCents: Math.abs(p.amountCents), at: (p.processedAt ?? p.createdAt).toISOString(), ...paymentLabelOf(p) }))
  const refundedCents = refunds.reduce((s, r) => s + r.amountCents, 0)
  const banner: ReceiptData['banner'] =
    order.status === 'refunded' ? 'REFUNDED'
    : order.status === 'cancelled' || order.status === 'rejected' ? 'CANCELLED'
    : refundedCents > 0 ? 'PARTLY REFUNDED'
    : null

  // The sale's fiscal document. A cancelled order never had a sale.
  const view = cancelled ? null : await fiscalViewForOrder(order.id, 'sale')
  let fiscal: ReceiptFiscal | null = view
  // Filed directly with SRB / FBR before the connector (no document, or the
  // sale document auto-skipped as prefiled_direct): the old numbers and QR.
  const prefiled = !view || (view.rawStatus === 'skipped' && view.statusReason === 'prefiled_direct')
  if (prefiled && !cancelled && (order.srbInvoiceNumber || order.fbrInvoiceNumber)) {
    fiscal = {
      status: 'legacy',
      authority: order.srbInvoiceNumber ? 'srb' : 'fbr',
      fiscalNumber: (order.srbInvoiceNumber ?? order.fbrInvoiceNumber)!,
      qrPayload: order.srbInvoiceNumber ? order.srbQrCodeLink ?? null : null,
      verifyUrl: order.srbInvoiceNumber ? order.srbQrCodeLink ?? null : null,
      fbrInvoiceNo: order.fbrInvoiceNumber ?? null,
      srbInvoiceNo: order.srbInvoiceNumber ?? null,
    }
  }
  // No document and no legacy filing: either the company does not report
  // sales (§17.7 → "Not a tax invoice"), or the sale's document is still to
  // come — printed as pending, never with a servd number as the fiscal one.
  let notTaxInvoice = false
  if (!cancelled && !view && !fiscal && order.concept.tenantId) {
    if (!(await fiscalReportingRequired(order.concept.tenantId))) notTaxInvoice = true
    else fiscal = awaitingFiscal(FINAL_STATUSES.has(order.status) ? 'not_queued' : 'awaiting_completion')
  }

  // The fiscal number is the headline only once FILED and not a test.
  const filed = view?.status === 'filed' && !view.isTest && !!view.fiscalNumber ? view : null
  const extras = filed
    ? extraNumbersOf((await prisma.fiscalDocument.findUnique({ where: { id: filed.documentId }, select: { extraNumbers: true } }))?.extraNumbers)
    : []
  const filedNumberOf = (auth: 'fbr' | 'srb'): { number: string; link: string | null } | null => {
    if (!filed) return null
    if (filed.authority === auth) return { number: filed.fiscalNumber!, link: filed.verifyUrl ?? filed.qrPayload }
    const x = extras.find((e) => e.authority === auth)
    return x ? { number: x.number, link: x.verifyUrl ?? x.qrPayload ?? null } : null
  }
  const fbr = filedNumberOf('fbr')
  const srb = filedNumberOf('srb')

  // A payment taken on the card machine: brand, last 4 and auth code from its slip.
  const terminal = paid.find((p) => p.gateway === 'card_terminal')
  const tmeta = (terminal?.gatewayMeta ?? {}) as { cardBrand?: unknown; cardLast4?: unknown; authCode?: unknown }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const card = terminal
    ? { brand: str(tmeta.cardBrand), last4: str(tmeta.cardLast4), authCode: str(tmeta.authCode) }
    : null

  return {
    kind: cancelled ? 'cancelled' : 'final_bill',
    heading: cancelled ? null : FULL_AND_FINAL_HEADING,
    number: filed?.fiscalNumber ?? invoiceNumber ?? orderRef,
    servdRef: invoiceNumber,
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
    deliveryFeeCents: order.deliveryFeeCents,
    deliveryFeeTaxCents: order.deliveryFeeTaxCents,
    taxCents: order.taxCents,
    serviceChargeCents: order.serviceChargeCents,
    tipCents: order.tipCents,
    totalCents: order.totalCents,
    paidCents: paid.reduce((s, p) => s + p.amountCents, 0),
    tenderType: paid[0]?.method ?? null,
    payments: paid.map((p) => ({ method: p.method, amountCents: p.amountCents, tenderedCents: p.tenderedCents ?? null, ...paymentLabelOf(p) })),
    clientSignature: paid.some((p) => p.method === ON_ACCOUNT_TENDER && p.amountCents > 0),
    status: order.status,
    banner,
    refunds,
    refundedCents,
    placedAt: order.placedAt.toISOString(),
    fiscal,
    notTaxInvoice,
    testCompany: await isTestTenant(order.concept.tenantId),
    card,
    fbrInvoiceNo: fbr?.number ?? order.fbrInvoiceNumber ?? null,
    srbInvoiceNo: srb?.number ?? order.srbInvoiceNumber ?? null,
    srbQrLink: srb ? srb.link : order.srbQrCodeLink ?? null,
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

/**
 * The receipt as printable HTML. `duplicate` marks a reprint (DUPLICATE —
 * not a new sale); a refunded or cancelled order is always bannered.
 */
export async function buildReceiptHtml(orderId: string, opts: { duplicate?: boolean } = {}): Promise<string> {
  const r = await buildReceiptData(orderId)
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { concept: { select: { tenantId: true } } } })
  const cfg = await getReceiptConfig(order?.concept.tenantId ?? null)

  const itemRows = r.items.map((item) => {
    const modLines = item.modifiers.length
      ? `<div style="font-size:11px;color:#555;padding-left:8px">${item.modifiers.map((m) => `+ ${esc(m)}`).join(', ')}</div>`
      : ''
    const removalLines = item.removals?.length
      ? `<div style="font-size:11px;color:#555;padding-left:8px">${item.removals.map(esc).join(', ')}</div>`
      : ''
    return `
      <tr>
        <td style="padding:2px 0;vertical-align:top">${item.qty}×</td>
        <td style="padding:2px 4px;vertical-align:top">${esc(item.name)}${modLines}${removalLines}</td>
        <td style="padding:2px 0;text-align:right;white-space:nowrap;vertical-align:top">${fmtPkr(item.lineTotalCents)}</td>
      </tr>`
  }).join('')

  const widthMm = cfg.paperWidthMm === 58 ? 58 : 80
  const screenWidth = cfg.paperWidthMm === 58 ? 240 : 320

  // Tax breakdown — only render if showTaxBreakdown is enabled (some operators
  // prefer a single VAT-inclusive total to avoid customer confusion). The
  // amount is ALL the GST the order was charged — on the food and on the
  // delivery (H9) — with the delivery's share named, so the rows (subtotal −
  // discount + delivery charge + GST + service + tip) add up to the total.
  const feeTaxNote = r.deliveryFeeTaxCents > 0 ? ` (incl. ${fmtPkr(r.deliveryFeeTaxCents)} on delivery)` : ''
  const taxRow = cfg.showTaxBreakdown && r.taxCents > 0
    ? `<tr><td>GST${feeTaxNote}</td><td style="text-align:right">${fmtPkr(r.taxCents)}</td></tr>`
    : ''
  const deliveryRow = r.deliveryFeeCents > 0
    ? `<tr><td>Delivery charge</td><td style="text-align:right">${fmtPkr(r.deliveryFeeCents)}</td></tr>`
    : ''
  const serviceRow = r.serviceChargeCents > 0
    ? `<tr><td>Service charge</td><td style="text-align:right">${fmtPkr(r.serviceChargeCents)}</td></tr>`
    : ''
  const tipRow = r.tipCents > 0
    ? `<tr><td>Tip</td><td style="text-align:right">${fmtPkr(r.tipCents)}</td></tr>`
    : ''
  // Owner, 2026-10-20: the bill shows Total (items) · Discount · Sub-total · GST · Paid · Due — no payment lines.
  const paidCents = r.payments.reduce((t, p) => t + p.amountCents, 0)
  // An on-account bill still names the client it is charged to (the client signs under it).
  const onAccount = r.payments.filter((p) => p.method === ON_ACCOUNT_TENDER)
  // FOH-23: a refunded / cancelled order never prints like a valid paid bill.
  const banners = [r.testCompany ? TEST_COMPANY_BANNER : null, r.banner, opts.duplicate ? 'DUPLICATE' : null].filter((b): b is string => !!b)
  const bannerHtml = banners.length > 0
    ? `<div class="center bold" style="font-size:16px;border:2px solid #000;padding:4px;margin:6px 0">${banners.map(esc).join(' · ')}</div>`
    : ''
  // A Raast refund prints with its outgoing transfer's reference, an
  // on-account refund with the client it went back to; the other tenders keep
  // their established refund line.
  const refundRows = r.refunds.length > 0
    ? `<div class="divider"></div>${r.refunds.map((x) => `<div>REFUND ${esc(x.method === 'raast' || x.method === ON_ACCOUNT_TENDER ? x.label : x.method.replace(/_/g, ' '))} -${fmtPkr(x.amountCents)} (${fmtDate(x.at)})</div>`).join('')}<div class="bold">Refunded: -${fmtPkr(r.refundedCents)}</div>`
    : ''
  const authorityRows = await fiscalBlockHtml(r, cfg.showFbrInvoice)
  const cardRow = r.card && (r.card.last4 || r.card.authCode)
    ? `<div>Card${r.card.brand ? ` ${esc(r.card.brand)}` : ''}${r.card.last4 ? ` •${esc(r.card.last4)}` : ''}${r.card.authCode ? `&nbsp; Auth ${esc(r.card.authCode)}` : ''}</div>`
    : ''
  // Owner flag (a): once the fiscal number is the headline, our own
  // TaxInvoice number prints as the reference.
  const refRow = r.servdRef && r.servdRef !== r.number ? `<div>Ref: ${esc(r.servdRef)}</div>` : ''

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
  ${bannerHtml}
  ${r.heading ? `<div class="center bold" style="font-size:14px;margin-top:6px">${esc(r.heading)}</div>` : ''}
  <div class="divider"></div>
  <div>Invoice #: <strong>${esc(r.number)}</strong></div>
  ${refRow}
  ${r.number !== r.orderRef ? `<div>Order: ${esc(r.orderRef)}</div>` : ''}
  <div>Date: ${fmtDate(r.placedAt)}</div>
  ${r.customerName ? `<div>Customer: ${esc(r.customerName)}</div>` : ''}
  ${r.table ? `<div>Table: ${esc(r.table)}</div>` : ''}
  <div class="divider"></div>
  <table>${itemRows}</table>
  <div class="divider"></div>
  <table>
    <tr class="bold"><td>Total</td><td style="text-align:right">${fmtPkr(r.subtotalCents)}</td></tr>
    <tr><td>Discount</td><td style="text-align:right">${r.discountCents > 0 ? '-' : ''}${fmtPkr(r.discountCents)}</td></tr>
    <tr><td>Sub-total</td><td style="text-align:right">${fmtPkr(r.subtotalCents - r.discountCents)}</td></tr>
    ${deliveryRow}
    ${taxRow}
    ${serviceRow}
    ${tipRow}
    <tr class="bold"><td style="border-top:1px solid #000;padding-top:4px">Paid</td><td style="border-top:1px solid #000;padding-top:4px;text-align:right">${fmtPkr(paidCents)}</td></tr>
    <tr class="bold"><td>Due</td><td style="text-align:right">${fmtPkr(Math.max(0, r.totalCents - paidCents))}</td></tr>
  </table>
  ${onAccount.length > 0 ? `<div class="divider"></div>${onAccount.map((p) => `<div>${esc(p.label)} ${fmtPkr(p.amountCents)}</div>`).join('')}` : ''}
  ${r.clientSignature ? `<div style="margin-top:18px">${esc(CLIENT_SIGNATURE_LINE)}</div>` : ''}
  ${cardRow}
  ${refundRows}
  ${authorityRows ? `<div class="divider"></div>${authorityRows}` : ''}
  ${cfg.legalDisclaimer ? `<div class="divider"></div><div class="center" style="font-size:10px;color:#555">${esc(cfg.legalDisclaimer)}</div>` : ''}
  <div class="divider"></div>
  <div class="center" style="font-size:11px">${esc(cfg.footerText ?? 'Thank you for dining with us!')}</div>
  <div class="center" style="font-size:10px;color:#555">Powered by servd</div>
  <script>window.onload = function(){ window.print() }</script>
</body>
</html>`
}

/**
 * The fiscal block of the printed bill (spec §11). Gated by
 * ReceiptConfig.showFbrInvoice, except "Not a tax invoice" (§17.7), which a
 * company that does not report sales always prints.
 */
async function fiscalBlockHtml(r: ReceiptData, show: boolean): Promise<string> {
  if (r.notTaxInvoice) return `<div class="center bold">${esc(NOT_TAX_INVOICE)}</div>`
  const f = r.fiscal
  if (!show || !f) return ''
  const qr = (text: string | null | undefined, auth: string): string => {
    const svg = renderQrSvg(text, { label: `Scan to verify with ${auth}` })
    return svg ? `<div class="center" style="margin:6px 0">${svg}</div><div class="center" style="font-size:10px">Scan to verify with ${esc(auth)}</div>` : ''
  }
  if (f.status === 'legacy') {
    const lines = [
      f.fbrInvoiceNo ? `<div>FBR Invoice: ${esc(f.fbrInvoiceNo)}</div>` : '',
      f.srbInvoiceNo ? `<div>SRB Invoice No: ${esc(f.srbInvoiceNo)}</div>` : '',
    ].join('')
    return lines + (f.authority === 'srb' ? qr(f.qrPayload ?? f.verifyUrl, 'SRB') : '')
  }
  const auth = (f.authority ?? '').toUpperCase() || 'the tax authority'
  switch (f.status) {
    case 'not_required':
      return ''
    case 'filed':
    case 'test': {
      const test = f.status === 'test'
      const head = test ? `<div class="center bold">${esc(TEST_FISCAL_BANNER)}</div>` : ''
      if (!f.fiscalNumber) return head
      const extras = test ? [] : extraNumbersOf((await prisma.fiscalDocument.findUnique({ where: { id: f.documentId }, select: { extraNumbers: true } }))?.extraNumbers)
      return head
        + `<div class="bold">${esc(auth)} Fiscal Invoice: ${esc(f.fiscalNumber)}</div>`
        + qr(f.qrPayload ?? f.verifyUrl, auth)
        + (f.fiscalAt ? `<div style="font-size:10px">${fmtDate(f.fiscalAt)}</div>` : '')
        + extras.map((x) => `<div>${esc(x.authority.toUpperCase())} Fiscal Invoice: ${esc(x.number)}</div>`).join('')
    }
    default:
      // Not filed yet (pending, held, awaiting completion): nothing printed (owner, 2026-10-20) — never a servd
      // number presented as a fiscal number. A reprint once filed carries the fiscal number and its QR.
      return ''
  }
}
