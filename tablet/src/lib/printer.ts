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

import { api } from './api'

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
const cut      = [GS,  0x56, 0x42, 0x00]           // partial cut

function txt(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff)
  return out
}
function line(s = '') { return [...txt(s), LF] }
function rule()       { return line('--------------------------------') }

export interface ReceiptOrder {
  number: string
  conceptName: string
  customerName?: string | null
  table?: string | null
  source: string
  items: Array<{ name: string; qty: number; price: number; modifiers?: string[] }>
  subtotalCents: number
  taxCents:      number
  totalCents:    number
  paidCents?:    number
  tenderType?:   string
  placedAt:      string
  // SRB e-invoicing — when present, printed as a verification QR on the receipt
  // (mandatory for SRB-registered Sindh outlets per the SRB POS spec).
  srbInvoiceNo?: string | null
  srbQrLink?:    string | null
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

export function buildReceipt(order: ReceiptOrder): Uint8Array {
  const bytes: number[] = []
  bytes.push(...init)

  // Header
  bytes.push(...alignCtr, ...boldOn, ...sizeBig, ...line(order.conceptName))
  bytes.push(...sizeNorm, ...boldOff)
  bytes.push(...line(`Order #${order.number}`))
  bytes.push(...line(new Date(order.placedAt).toLocaleString('en-PK')))
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
  bytes.push(...totalLine('Tax',      order.taxCents))
  bytes.push(...boldOn, ...sizeBig)
  bytes.push(...totalLine('TOTAL', order.totalCents))
  bytes.push(...sizeNorm, ...boldOff)

  if (order.paidCents !== undefined) {
    bytes.push(LF)
    bytes.push(...line(`Paid:   ${rs(order.paidCents)}   (${order.tenderType ?? 'CASH'})`))
    if (order.paidCents > order.totalCents) {
      bytes.push(...line(`Change: ${rs(order.paidCents - order.totalCents)}`))
    }
  }

  // SRB verification QR — mandatory on the receipt for SRB-registered outlets.
  if (order.srbQrLink) {
    bytes.push(LF, ...alignCtr)
    if (order.srbInvoiceNo) {
      bytes.push(...boldOn, ...line(`SRB Invoice No: ${order.srbInvoiceNo}`), ...boldOff)
    }
    bytes.push(...qrCode(order.srbQrLink))
    bytes.push(...line('Scan to verify with SRB'))
    bytes.push(...alignLft)
  }

  // Footer
  bytes.push(LF, ...alignCtr, ...line('Thank you!'))
  bytes.push(...line('powered by servd'))
  bytes.push(LF, LF, LF)
  bytes.push(...cut)

  return new Uint8Array(bytes)
}

/**
 * Fetch a freshly-paid order and print. Returns the receipt bytes either way,
 * so the caller can spool them or hand off to a different printer later.
 */
export async function printReceipt(orderId: string): Promise<Uint8Array> {
  const order = await api.get<ReceiptOrder>(`/pos/orders/${orderId}/receipt-data`)
  const bytes = buildReceipt(order)
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
