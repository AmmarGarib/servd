// Bluetooth ESC/POS thermal printer adapter.
//
// We support 58mm and 80mm printers via the standard ESC/POS protocol — every
// generic Goojprt / Xprinter / Rongta sold on Daraz speaks this. The actual
// transport (Bluetooth) is intentionally NOT wired into native code here for
// two reasons:
//
//   1. Bluetooth printer libs require a custom dev client build (Expo Go
//      doesn't ship Bluetooth modules). The user can install
//      `react-native-thermal-receipt-printer-image-qr` or
//      `react-native-bluetooth-escpos-printer` and wire the transport call
//      below — the receipt-building logic stays unchanged.
//
//   2. Different shops will pair different printers. The printer registry
//      and selection UI lives in admin settings, not in the tablet binary.
//
// What this file DOES give you: a deterministic `buildReceipt()` that returns
// raw bytes ready for `BluetoothEscposPrinter.printPic()` or equivalent, plus
// a `printReceipt(orderId)` that fetches order details and either prints
// (if a transport is registered) or surfaces the bytes for later spooling.

import { api, ApiError } from './api'

type PrinterTransport = (bytes: Uint8Array) => Promise<void>

let transport: PrinterTransport | null = null

export function registerPrinterTransport(fn: PrinterTransport) {
  transport = fn
}

export function isPrinterReady(): boolean {
  return transport !== null
}

// ─── ESC/POS bytes ──────────────────────────────────────────────────────────
const ESC = 0x1b, GS = 0x1d, LF = 0x0a

const init     = [ESC, 0x40]                       // initialise
const alignCtr = [ESC, 0x61, 0x01]
const alignLft = [ESC, 0x61, 0x00]
const boldOn   = [ESC, 0x45, 0x01]
const boldOff  = [ESC, 0x45, 0x00]
const sizeBig  = [GS,  0x21, 0x11]                 // 2x width / 2x height
const sizeNorm = [GS,  0x21, 0x00]
const sizeTall = [GS,  0x21, 0x01]                 // 2x height only — fits 32 columns
const cut      = [GS,  0x56, 0x42, 0x00]           // partial cut

// Thermal printers speak a single-byte code page: typographic characters
// would print as garbage, so they are folded to ASCII first.
const ASCII_FOLD: Record<string, string> = {
  '\u2014': '-', '\u2013': '-', '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"',
  '\u2022': '*', '\u2026': '...', '\u00d7': 'x', '\u00a0': ' ',
}
function toAscii(s: string): string {
  return s.replace(/[^\x00-\x7f]/g, (c) => ASCII_FOLD[c] ?? '?')
}

function txt(s: string): number[] {
  const a = toAscii(s)
  const out: number[] = []
  for (let i = 0; i < a.length; i++) out.push(a.charCodeAt(i) & 0x7f)
  return out
}
function line(s = '') { return [...txt(s), LF] }
function rule()       { return line('--------------------------------') }

/**
 * The sale's fiscal document as the receipt carries it (spec §11). `legacy`
 * is a sale filed directly with FBR / SRB before the POS connector.
 */
export interface ReceiptFiscal {
  status: 'filed' | 'pending' | 'failed' | 'not_required' | 'test' | 'legacy'
  authority: string | null
  fiscalNumber: string | null
  qrPayload: string | null
  verifyUrl?: string | null
  fiscalAt?: string | null
  /**
   * The document's own status (backend FiscalDocument.status) — 'held' while
   * the company is not live on the fiscal POS yet. null on a sale with no
   * document yet (see statusReason) and on a legacy number; absent on an
   * older API.
   */
  rawStatus?: string | null
  /**
   * Why it is where it is — e.g. 'awaiting_completion' (paid in full, the
   * document is created when the order completes) or 'not_queued'.
   */
  statusReason?: string | null
}

// Shape of GET /pos/orders/:id/receipt-data — the same builder as the HTML
// receipt (backend pos/receipt.ts), so both print the stored tax and total —
// and of a pre-bill (POST /pos/orders/:id/pre-bill → receipt, kind
// 'pre_bill'), which is printed through the same layout.
export interface ReceiptOrder {
  /** 'pre_bill' = the bill before payment: never a tax invoice, never sent to the POS. */
  kind?: 'pre_bill' | string
  /**
   * The headline number. A full & final bill: the fiscal number once filed,
   * else our tax-invoice number, else the order reference. A pre-bill: PB-<n>.
   */
  number: string
  /** Our tax-invoice number — printed as "Ref" when the fiscal number is the headline. */
  servdRef?: string | null
  /** Heading of a paid bill (e.g. FULL & FINAL BILL), when the API sends one. */
  heading?: string | null
  invoiceNumber?: string | null
  orderRef?: string
  conceptName: string
  customerName?: string | null
  table?: string | null
  source: string
  /** price is the unit price INCLUDING modifiers, so qty × price is the line. */
  items: Array<{ name: string; qty: number; price: number; modifiers?: string[] }>
  subtotalCents: number
  discountCents?: number
  /**
   * The delivery charge BEFORE GST (Order.deliveryFeeCents, H9) — present on a
   * delivery order only. The GST on it is already inside `taxCents`, so the
   * printed rows (Subtotal - Discount + Delivery + Tax + Service + Tip) add up
   * to TOTAL. Absent on an older API and on pickup / dine-in / the till.
   */
  deliveryFeeCents?: number
  taxCents:      number
  serviceChargeCents?: number
  tipCents?:     number
  totalCents:    number
  paidCents?:    number
  tenderType?:   string | null
  /**
   * The tenders (newer API, backend pos/receipt.ts paymentLabelOf): `label`
   * is how the tender prints ("Cash", "Card – Keenu", "Raast QR — Ref <ref>",
   * "Keenu QR (retired)"); `reference` is a Raast transfer's bank reference.
   * Absent on an older API — the single "Paid (tenderType)" line prints then.
   */
  payments?:     Array<{ method: string; amountCents: number; tenderedCents?: number | null; label?: string; reference?: string | null }>
  placedAt:      string
  // Ids returned by the tax authorities, printed as-is.
  fbrInvoiceNo?: string | null
  // SRB e-invoicing — when present, printed as a verification QR on the receipt
  // (mandatory for SRB-registered Sindh outlets per the SRB POS spec).
  srbInvoiceNo?: string | null
  srbQrLink?:    string | null
  // FOH-23: a receipt for a refunded / cancelled order is not a valid bill.
  // banner is REFUNDED (in full), PARTLY REFUNDED, CANCELLED, the pre-bill's
  // PRE-BILL — NOT A TAX INVOICE, or null; refunds are the money handed back
  // (positive amounts), newest last.
  status?:        string
  banner?:        'REFUNDED' | 'PARTLY REFUNDED' | 'CANCELLED' | string | null
  /**
   * Money handed back. `label` (newer API) is how the tender prints — a Raast
   * refund carries its outgoing transfer's reference in `reference`.
   */
  refunds?:       Array<{ method: string; amountCents: number; at: string; label?: string; reference?: string | null }>
  refundedCents?: number
  /**
   * The sale's fiscal document (POS connector). Absent on an older API — the
   * legacy fbrInvoiceNo / srbInvoiceNo / srbQrLink above are printed instead.
   * null = no fiscal document for this sale.
   */
  fiscal?:        ReceiptFiscal | null
  /**
   * The company does not report sales to a fiscal POS (spec §17.7 — a test
   * company, a home kitchen): the bill says it is not a tax invoice.
   */
  notTaxInvoice?: boolean
  /** The order belongs to a test company (owner, 2026-10-14): printed with a TEST COMPANY banner. */
  testCompany?:   boolean
  /** A payment taken on the card machine. */
  card?:          { brand: string | null; last4: string | null; authCode: string | null } | null
  // Pre-bill only: the card-tender total under a cash headline, what was
  // already paid when printed (a part-settled split) and what is still owed.
  cardTotalCents?: number | null
  dueCents?:       number
  /** Pre-bill: what the quote holds beyond the lines (a tip already on the order; negative = credits applied). */
  otherCents?:     number
  printedAt?:      string
}

/** The receipt data of a pre-bill (POST /pos/orders/:id/pre-bill → `receipt`). */
export interface PreBillReceipt extends ReceiptOrder {
  kind: 'pre_bill'
  banner: string
  preBillId: string
  totalCents: number
  cardTotalCents: number | null
  paidCents: number
  dueCents: number
  printedAt: string
}

export interface ReceiptOptions {
  /** A reprint — bannered DUPLICATE so it is never taken for a second sale. */
  duplicate?: boolean
}

// ESC/POS native QR code (GS ( k). Thermal printers encode the QR in hardware,
// so no image/JS-QR dependency is needed. Model 2, module size 6, EC level M.
function qrCode(data: string): number[] {
  const store = txt(data)
  const len = store.length + 3
  const pL = len & 0xff
  const pH = (len >> 8) & 0xff
  return [
    GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00, // select model 2
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06,       // module size 6
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,       // error correction M
    GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, ...store, // store data
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,       // print
  ]
}

function rs(cents: number): string {
  return `Rs ${Math.round(cents / 100).toLocaleString('en-PK')}`
}

const PRE_BILL_BANNER = 'PRE-BILL - NOT A TAX INVOICE'
const TEST_BANNER = 'TEST - NOT A FISCAL INVOICE'
const TEST_COMPANY_BANNER = 'TEST COMPANY - NOT A REAL SALE'

export function isPreBill(order: ReceiptOrder): boolean {
  return order.kind === 'pre_bill'
}

/**
 * The banners a receipt carries: the pre-bill's PRE-BILL — NOT A TAX INVOICE,
 * REFUNDED / PARTLY REFUNDED / CANCELLED, TEST on a test fiscal connector, and
 * DUPLICATE on a reprint.
 */
export function receiptBanners(order: ReceiptOrder, opts: ReceiptOptions = {}): string[] {
  const banner = isPreBill(order) ? (order.banner ?? PRE_BILL_BANNER) : order.banner ?? null
  const test = !isPreBill(order) && order.fiscal?.status === 'test' ? TEST_BANNER : null
  const company = order.testCompany ? TEST_COMPANY_BANNER : null
  return [company, banner, test, opts.duplicate ? 'DUPLICATE' : null].filter((b): b is string => !!b)
}

/** The fiscal lines of a full & final bill (spec §11), as plain text — the QR is added by buildReceipt. */
export function fiscalLines(order: ReceiptOrder): { lines: string[]; qr: string | null; caption: string | null } {
  if (isPreBill(order)) return { lines: [], qr: null, caption: null }
  if (order.notTaxInvoice) return { lines: ['Not a tax invoice'], qr: null, caption: null }
  const f = order.fiscal
  if (f === undefined) {
    // An API from before the POS connector: its own FBR / SRB fields.
    const lines: string[] = []
    if (order.fbrInvoiceNo) lines.push(`FBR Invoice: ${order.fbrInvoiceNo}`)
    if (order.srbQrLink && order.srbInvoiceNo) lines.push(`SRB Invoice No: ${order.srbInvoiceNo}`)
    return { lines, qr: order.srbQrLink ?? null, caption: order.srbQrLink ? 'Scan to verify with SRB' : null }
  }
  if (f === null || f.status === 'not_required') return { lines: [], qr: null, caption: null }
  const auth = (f.authority ?? '').toUpperCase()
  const qr = f.qrPayload ?? f.verifyUrl ?? null
  switch (f.status) {
    case 'filed':
    case 'legacy':
      return {
        lines: f.fiscalNumber ? [`${auth ? `${auth} ` : ''}Fiscal Invoice ${f.fiscalNumber}`] : [],
        qr,
        caption: qr ? `Scan to verify with ${auth || 'the tax authority'}` : null,
      }
    case 'test':
      return {
        lines: [TEST_BANNER, ...(f.fiscalNumber ? [`${auth ? `${auth} ` : ''}${f.fiscalNumber} (test)`] : [])],
        qr: null,
        caption: null,
      }
    default:
      // pending / failed: never a servd number presented as a fiscal number.
      // The same three cases as the HTML bill (backend pos/receipt.ts).
      if (f.rawStatus === 'held') {
        // The company is not live on the fiscal POS yet: nothing is being
        // filed, so no promise of a QR on a reprint (W4-RG-3).
        return { lines: ['Fiscal invoice: not yet issued.'], qr: null, caption: null }
      }
      if (f.statusReason === 'awaiting_completion') {
        // Paid in full, still in the kitchen: the sale files on completion.
        return { lines: ['Fiscal invoice: issued when the', 'order is completed.'], qr: null, caption: null }
      }
      return {
        lines: ['Fiscal invoice: pending - filed', 'automatically. Ask for a reprint', 'for the verification QR.'],
        qr: null,
        caption: null,
      }
  }
}

function bannerBlock(banners: string[]): number[] {
  if (banners.length === 0) return []
  return [
    ...alignCtr, ...boldOn, ...sizeTall,
    // 32 columns: a long banner (the pre-bill's) drops the stars rather than wrap.
    ...banners.flatMap((b) => line(toAscii(b).length + 6 <= 32 ? `** ${b} **` : b)),
    ...sizeNorm, ...boldOff,
  ]
}

export function buildReceipt(order: ReceiptOrder, opts: ReceiptOptions = {}): Uint8Array {
  const bytes: number[] = []
  const banners = receiptBanners(order, opts)
  bytes.push(...init)

  // A refunded / cancelled / reprinted receipt says so at the very top.
  bytes.push(...bannerBlock(banners))

  const preBill = isPreBill(order)
  // A paid bill says so; a pre-bill never does.
  const heading = preBill ? null : (order.heading ?? (order.fiscal !== undefined ? 'FULL & FINAL BILL' : null))

  // Header
  bytes.push(...alignCtr, ...boldOn, ...sizeBig, ...line(order.conceptName))
  bytes.push(...sizeNorm, ...boldOff)
  if (heading) bytes.push(...boldOn, ...line(heading), ...boldOff)
  if (preBill) {
    bytes.push(...line(`Pre-bill ${order.number}`))
    if (order.orderRef) bytes.push(...line(`Order ${order.orderRef}`))
  } else if (order.fiscal !== undefined) {
    // The API's headline number (the fiscal number once filed), our tax-invoice number as Ref.
    bytes.push(...line(`Invoice #${order.number}`))
    if (order.servdRef && order.servdRef !== order.number) bytes.push(...line(`Ref ${order.servdRef}`))
    if (order.orderRef && order.orderRef !== order.number) bytes.push(...line(`Order ${order.orderRef}`))
  } else {
    bytes.push(...line(order.invoiceNumber ? `Invoice #${order.invoiceNumber}` : `Order #${order.number}`))
    if (order.invoiceNumber && order.orderRef) bytes.push(...line(`Order ${order.orderRef}`))
  }
  bytes.push(...line(new Date(preBill && order.printedAt ? order.printedAt : order.placedAt).toLocaleString('en-PK')))
  bytes.push(LF)

  // Meta
  bytes.push(...alignLft)
  if (order.customerName) bytes.push(...line(`Guest:  ${order.customerName}`))
  if (order.table)        bytes.push(...line(`Table:  ${order.table}`))
  bytes.push(...line(`Source: ${order.source}`))
  bytes.push(...rule())

  // Items
  for (const item of order.items) {
    const left  = `${item.qty}x ${item.name}`
    const right = rs(item.price * item.qty)
    const pad   = Math.max(1, 32 - left.length - right.length)
    bytes.push(...line(`${left}${' '.repeat(pad)}${right}`))
    for (const mod of item.modifiers ?? []) {
      bytes.push(...line(`   + ${mod}`))
    }
  }

  bytes.push(...rule())

  // Totals (right aligned via padding)
  const totalLine = (label: string, cents: number) => {
    const right = rs(cents)
    const pad = Math.max(1, 32 - label.length - right.length)
    return line(`${label}${' '.repeat(pad)}${right}`)
  }
  bytes.push(...totalLine('Subtotal', order.subtotalCents))
  if (order.discountCents)      bytes.push(...totalLine('Discount', -order.discountCents))
  if (order.deliveryFeeCents && order.deliveryFeeCents > 0) bytes.push(...totalLine('Delivery', order.deliveryFeeCents))
  bytes.push(...totalLine('Tax',      order.taxCents))
  if (order.serviceChargeCents) bytes.push(...totalLine('Service', order.serviceChargeCents))
  if (order.tipCents)           bytes.push(...totalLine('Tip', order.tipCents))
  if (preBill && order.otherCents) bytes.push(...totalLine(order.otherCents > 0 ? 'Tip' : 'Credits', order.otherCents))
  bytes.push(...boldOn, ...sizeBig)
  bytes.push(...totalLine('TOTAL', order.totalCents))
  bytes.push(...sizeNorm, ...boldOff)

  if (preBill) {
    // The card total under a cash headline (GST is 15% cash / 8% card), and
    // on a part-paid bill what is already paid and what is still owed.
    // Card and Raast QR are the one digital tax group (card rate). The label
    // is kept short enough for a 32-column 58 mm roll.
    if (order.cardTotalCents != null && order.cardTotalCents !== order.totalCents) {
      bytes.push(...totalLine('If paid by card/Raast', order.cardTotalCents))
    }
    if ((order.paidCents ?? 0) > 0) {
      bytes.push(...totalLine('Paid so far', -(order.paidCents ?? 0)))
      bytes.push(...boldOn, ...totalLine('BALANCE DUE', order.dueCents ?? Math.max(0, order.totalCents - (order.paidCents ?? 0))), ...boldOff)
    }
  } else if (order.payments && order.payments.length > 0 && order.payments.every((p) => !!p.label)) {
    // One line per tender, labelled by the server; a Raast transfer's bank
    // reference goes on its own line so a long reference never wraps the amount.
    bytes.push(LF)
    for (const p of order.payments) {
      const label = p.label!
      const base = p.reference ? label.replace(` \u2014 Ref ${p.reference}`, '').replace(` - Ref ${p.reference}`, '') : label
      bytes.push(...totalLine(base, p.amountCents))
      if (p.reference) bytes.push(...line(`  Ref ${p.reference}`))
      if (p.tenderedCents != null && p.tenderedCents > p.amountCents) {
        bytes.push(...totalLine('  Change', p.tenderedCents - p.amountCents))
      }
    }
  } else if (order.paidCents !== undefined) {
    bytes.push(LF)
    bytes.push(...line(`Paid:   ${rs(order.paidCents)}   (${order.tenderType ?? 'CASH'})`))
    if (order.paidCents > order.totalCents) {
      bytes.push(...line(`Change: ${rs(order.paidCents - order.totalCents)}`))
    }
  }
  if (!preBill && order.card && (order.card.last4 || order.card.authCode)) {
    const card = [`Card${order.card.brand ? ` ${order.card.brand}` : ''}${order.card.last4 ? ` *${order.card.last4}` : ''}`,
      order.card.authCode ? `Auth ${order.card.authCode}` : null].filter(Boolean).join('  ')
    bytes.push(...line(card))
  }

  // Money handed back on this order, then the total refunded.
  const refunds = order.refunds ?? []
  if (refunds.length > 0) {
    bytes.push(...alignLft, ...rule())
    for (const r of refunds) {
      const when = new Date(r.at).toLocaleString('en-PK')
      const what = r.reference && r.label ? r.label.replace(` \u2014 Ref ${r.reference}`, '') : r.label ?? r.method.replace(/_/g, ' ')
      bytes.push(...totalLine(`Refund ${what}`, -r.amountCents))
      if (r.reference) bytes.push(...line(`   Ref ${r.reference}`))
      bytes.push(...line(`   ${when}`))
    }
    const refunded = order.refundedCents ?? refunds.reduce((s, r) => s + r.amountCents, 0)
    bytes.push(...boldOn, ...totalLine('Refunded', -refunded), ...boldOff)
  }

  // The fiscal block (a paid bill only): the POS's fiscal number and its
  // verification QR, or "pending", or TEST. A pre-bill has none — it is
  // never sent to the POS.
  const fiscal = fiscalLines(order)
  if (fiscal.lines.length > 0 || fiscal.qr) {
    bytes.push(LF, ...alignCtr)
    if (fiscal.lines.length > 0) bytes.push(...boldOn, ...fiscal.lines.flatMap((l) => line(l)), ...boldOff)
    if (fiscal.qr) {
      bytes.push(...qrCode(fiscal.qr))
      if (fiscal.caption) bytes.push(...line(fiscal.caption))
    }
    bytes.push(...alignLft)
  }

  // Footer — the banner repeats at the foot, so a torn-off bottom still shows it.
  if (banners.length > 0) bytes.push(LF, ...bannerBlock(banners))
  if (preBill) bytes.push(LF, ...alignCtr, ...line('Please pay at the counter.'), ...line('The tax invoice prints after payment.'))
  bytes.push(LF, ...alignCtr, ...line('Thank you!'))
  bytes.push(...line('powered by servd'))
  bytes.push(LF, LF, LF)
  bytes.push(...cut)

  return new Uint8Array(bytes)
}

async function send(bytes: Uint8Array): Promise<Uint8Array> {
  if (transport) {
    try {
      await transport(bytes)
    } catch (err) {
      // Don't swallow — POS screen needs to show "printer offline" so the
      // cashier can write a paper receipt instead of silently dropping it.
      throw new Error(`Printer error: ${(err as Error).message}`)
    }
  }
  return bytes
}

/**
 * The full & final bill was refused because the order is not paid yet
 * (409 PRE_BILL_REQUIRED, spec §17.1) — print a pre-bill instead.
 */
export class PreBillRequiredError extends Error {
  readonly code = 'PRE_BILL_REQUIRED'
  constructor(message = "This order isn't paid yet - print a pre-bill") {
    super(message)
  }
}

function errorCodeOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null
  const body = err.body as { error?: { code?: unknown } } | null
  return typeof body?.error?.code === 'string' ? body.error.code : null
}

/**
 * Fetch a paid order's full & final bill and print it. Returns the receipt
 * bytes either way, so the caller can spool them or hand off to a different
 * printer later. An order that is not paid yet throws PreBillRequiredError —
 * unless `preBillFallback` names the tender to print a pre-bill at instead.
 */
export async function printReceipt(
  orderId: string,
  opts: ReceiptOptions & { preBillFallback?: 'cash' | 'card' } = {},
): Promise<Uint8Array> {
  let order: ReceiptOrder
  try {
    order = await api.get<ReceiptOrder>(`/pos/orders/${orderId}/receipt-data`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && errorCodeOf(err) === 'PRE_BILL_REQUIRED') {
      if (opts.preBillFallback) return printPreBill(orderId, opts.preBillFallback)
      throw new PreBillRequiredError(err.message)
    }
    throw err
  }
  return send(buildReceipt(order, opts))
}

/**
 * Print a pre-bill for an open order (POST /pos/orders/:id/pre-bill). Every
 * print, reprints included, is recorded (Finance → Voided pre bills); it is
 * never a tax invoice and never reaches the fiscal POS.
 */
export async function printPreBill(orderId: string, tender: 'cash' | 'card' = 'cash'): Promise<Uint8Array> {
  const { receipt } = await api.post<{ receipt: PreBillReceipt }>(`/pos/orders/${orderId}/pre-bill`, { tender })
  return send(buildReceipt(receipt))
}
