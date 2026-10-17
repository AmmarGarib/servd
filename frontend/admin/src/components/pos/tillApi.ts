'use client'
// The admin till's server calls — used only by /pos, /pos/waiter and the
// till's PaymentModal / PosCart.
//
// The till computes NO tax (FOH-02). GST is split by tender (cash 15% / card
// 8%, owner decision 9) on the pre-discount base, plus the company's service
// charge — all worked out by the server (lib/pricing.ts). The till rings the
// order up, then shows and charges exactly what the server says is due for
// the tender the customer pays with:
//
//   GET  /pos/orders/:id/quote?method=   the server's bill for that tender
//                                        (what POST /pos/payments will demand)
//   POST /pos/quote                      the server's price for a cart, before
//                                        it is rung up (preview only)
//
// Both are feature-detected: when the API predates them (a 404 with no error
// code — Fastify's "route not found"), the till falls back to the order's
// stored bill, and only for a tender the server will not re-price (the rate
// the order was priced at). It never guesses a re-priced figure.
//
// Tenders (owner, 2026-10-12): Cash, Card – Keenu and Raast QR. Keenu QR is
// retired — the server refuses it on every payment (422 KEENU_QR_RETIRED);
// old keenu_qr rows stay readable. Raast QR is in the digital tax group with
// card (the card rate), so its quote's `tender` reads 'card'.

import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { orderRef } from '../../lib/orderRef'

export type TillTender = 'cash' | 'card' | 'raast'
export const TILL_TENDERS: readonly TillTender[] = ['cash', 'card', 'raast']
export function isTillTender(m: string): m is TillTender {
  return (TILL_TENDERS as readonly string[]).includes(m)
}

/** How a tender reads to people (backend lib/tenders.ts TENDER_LABEL). */
export const TENDER_LABEL: Readonly<Record<string, string>> = {
  cash: 'Cash',
  card: 'Card – Keenu',
  raast: 'Raast QR',
  keenu_qr: 'Keenu QR (retired)',
  comp: 'Comp',
  split: 'Split',
  wallet: 'Wallet',
  gift_card: 'Gift card',
  // A named corporate client's bill, charged to its account (OnAccountPanel) — not money in the drawer.
  on_account: 'On account',
}
export function tenderLabel(m: string): string {
  return TENDER_LABEL[m] ?? m.replace(/_/g, ' ')
}

/** A brand as the till sees it (GET /concepts, narrow fields for till roles). */
export interface TillBrand {
  id: string
  name: string
  slug: string
  tenantId: string | null
  taxRateCash: number
  taxRateCard: number
}

export interface TillOrderItem {
  id: string
  name: string
  quantity: number
  unitPriceCents: number
  status?: string
  /** The vessel snapshotted on the line ('plate' | 'packaging'; null/absent = plate). */
  serviceVessel?: string | null
  /** Staff tapped "Box given" on this dine-in line (leftovers boxed). */
  boxGiven?: boolean
  modifiers?: Array<{ name: string; priceDeltaCents: number }>
}

/** The order as the server stored it — every money figure is the server's. */
export interface TillOrder {
  id: string
  conceptId: string
  source: string
  status: string
  totalCents: number
  taxCents: number
  taxRatePct: number | null
  serviceChargeCents: number
  discountCents: number
  tipCents?: number
  /** Promo / wallet credit on the bill (GET /orders/:id) — an on-account charge takes a bill with neither. */
  promoCodeId?: string | null
  promoDiscountCents?: number
  walletAmountCents?: number
  placedAt: string
  /** dine_in | takeout | delivery — "Box given" is for dine_in lines only. */
  fulfilmentType?: string | null
  tableId?: string | null
  table?: { label: string } | null
  items: TillOrderItem[]
  // Optional on purpose (R2-UI-01): the ring-up answer (POST /pos/orders) did
  // not carry `payments`, and reading `.filter` off it crashed the till right
  // after the order was fired. Every reader goes through paidCentsOf, which
  // treats a missing list as "nothing paid yet" — true of a fresh ring-up.
  payments?: Array<{ id: string; method: string; amountCents: number; status: string }> | null
}

/** The server's bill for one tender (GET /pos/orders/:id/quote). */
export interface TillQuote {
  orderId: string
  tender: 'cash' | 'card'
  taxRatePct: number | null
  taxCents: number
  serviceChargeCents: number
  discountCents: number
  totalCents: number
  paidCents: number
  dueCents: number
  /** Present only on an API whose payments take a tip (FOH-14). */
  tipCents?: number
  /** Delivery fee on the order and the GST on it (already inside taxCents) — the server's figures. */
  deliveryFeeCents?: number
  deliveryFeeTaxCents?: number
}

/** The server's price for a cart that is not rung up yet (POST /pos/quote). */
export interface TillCartQuote {
  tender: 'cash' | 'card'
  taxRatePct: number
  itemTotalCents: number
  discountCents: number
  taxCents: number
  serviceChargeCents: number
  totalCents: number
}

/** What the till needs to know to take a tender for an order. */
export type TillBill =
  | { kind: 'server'; quote: TillQuote }
  // The quote route is not on this API: the order's stored bill, which the
  // server will charge unchanged for this tender (no re-price).
  | { kind: 'stored'; quote: TillQuote }
  // The quote route is not on this API and this tender WOULD be re-priced —
  // the till has no server figure for it, so it must not take it.
  | { kind: 'unavailable'; message: string }

const ROUNDING_CENTS = 2 // the server's TENDER_ROUNDING_CENTS

/** Fastify's own "route not found" — a 404 that carries no error code. */
export function isMissingRoute(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404 && (e.code == null || e.code === 'FST_ERR_NOT_FOUND')
}

/** A fresh, random idempotency key for ONE ring-up (never the clock). */
export function newIdempotencyKey(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c?.randomUUID) return `pos-${c.randomUUID()}`
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16))
    b[6] = (b[6]! & 0x0f) | 0x40
    b[8] = (b[8]! & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `pos-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  throw new Error('This browser cannot generate a secure order key — use a current browser over https')
}

/** Money already received on the order (paid rows, positive amounts — the server's coverage rule). */
export function paidCentsOf(order: Pick<TillOrder, 'payments'>): number {
  return (order.payments ?? [])
    .filter((p) => p.status === 'paid' && p.amountCents > 0)
    .reduce((s, p) => s + p.amountCents, 0)
}

/** Open = rung, not completed/cancelled, and not yet covered by payments. */
export function isUnpaid(order: TillOrder): boolean {
  return paidCentsOf(order) < order.totalCents - ROUNDING_CENTS
}

/** The order's bill as stored by the server (what a comp covers; no re-price). */
export function storedQuote(order: TillOrder): TillQuote {
  const paid = paidCentsOf(order)
  return {
    orderId: order.id,
    tender: 'cash',
    taxRatePct: order.taxRatePct,
    taxCents: order.taxCents,
    serviceChargeCents: order.serviceChargeCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    paidCents: paid,
    dueCents: Math.max(0, order.totalCents - paid),
  }
}

// Remember, per page load, whether this API has the quote routes, so a till
// on an older API doesn't 404 on every tender tap.
let orderQuoteRoute: boolean | null = null
let cartQuoteRoute: boolean | null = null

/**
 * The bill for paying `order` with `method`. The server's quote when the API
 * has it; otherwise the stored bill, but only when the server will not
 * re-price it for this tender: something is already paid (a part-paid bill
 * is never re-priced), the order predates per-tender pricing (no rate
 * stored), or the tender's rate is the one the order was priced at. Any other
 * case is 'unavailable' — the till never works out a re-priced figure itself.
 */
export async function billFor(order: TillOrder, method: TillTender, brand: TillBrand | undefined): Promise<TillBill> {
  if (orderQuoteRoute !== false) {
    try {
      const quote = await api.get<TillQuote>(`/pos/orders/${order.id}/quote?method=${method}`)
      orderQuoteRoute = true
      return { kind: 'server', quote }
    } catch (e) {
      if (!isMissingRoute(e)) throw e
      orderQuoteRoute = false
    }
  }
  const stored = storedQuote(order)
  if (stored.paidCents > 0 || order.taxRatePct == null) return { kind: 'stored', quote: stored }
  // Card and Raast QR share the digital (card) rate.
  const rate = method === 'cash' ? brand?.taxRateCash : brand?.taxRateCard
  if (rate != null && rate === order.taxRatePct) {
    return { kind: 'stored', quote: { ...stored, tender: method === 'cash' ? 'cash' : 'card' } }
  }
  return {
    kind: 'unavailable',
    message: method === 'cash'
      ? 'This bill was priced for card / Raast. The server cannot quote the cash total yet, so take it by card or Raast QR, or ask a manager.'
      : 'This bill was priced for cash. The server cannot quote the card / Raast total yet, so take cash, or ring the sale with Card or Raast QR selected.',
  }
}

/** The server's price for the cart, or null when the API has no cart quote. */
export async function quoteCart(body: {
  conceptId: string
  items: unknown[]
  discountCents: number
  paymentMethod: TillTender
}): Promise<TillCartQuote | null> {
  if (cartQuoteRoute === false) return null
  try {
    const q = await api.post<TillCartQuote>('/pos/quote', body)
    cartQuoteRoute = true
    return q
  } catch (e) {
    if (isMissingRoute(e)) { cartQuoteRoute = false; return null }
    throw e
  }
}

/** Cart lines in the shape POST /pos/orders (and /pos/quote) take. */
export interface TillLine {
  menuItemId: string | null
  name: string
  quantity: number
  unitPriceCents: number
  notes?: string
  course?: number
  modifiers: Array<{ name: string; priceDeltaCents: number; modifierId?: string }>
}

/** Preview of the server's bill for a cart. `null` data = the API has no cart quote. */
export function useCartQuote(conceptId: string | null, lines: TillLine[], discountCents: number, tender: TillTender) {
  // Only what prices a line (a note doesn't — no request per keystroke).
  const priced = lines.map((l) => ({
    menuItemId: l.menuItemId, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents, modifiers: l.modifiers,
  }))
  return useQuery({
    queryKey: ['pos', 'cart-quote', conceptId, tender, discountCents, priced],
    queryFn: () => quoteCart({ conceptId: conceptId!, items: priced, discountCents, paymentMethod: tender }),
    enabled: !!conceptId && lines.length > 0,
    staleTime: 15_000,
    retry: false,
  })
}

/** The SW answers a ring-up made offline with a placeholder, not an order. */
export interface OfflinePlaceholder { id: string; status: 'queued_offline' }
export function isOfflinePlaceholder(r: unknown): r is OfflinePlaceholder {
  return !!r && typeof r === 'object' && (r as { status?: unknown }).status === 'queued_offline'
}

/** POST /pos/orders. `paymentMethod` asks the server to price it for that tender. */
export function ringUp(body: {
  conceptId: string
  idempotencyKey: string
  tableId?: string | null
  customerId?: string | null
  shiftId?: string | null
  discountCents?: number
  discountReason?: string
  paymentMethod?: TillTender
  items: TillLine[]
}): Promise<TillOrder | OfflinePlaceholder> {
  return api.post<TillOrder | OfflinePlaceholder>('/pos/orders', body).then(normaliseRungOrder)
}

/** The ring-up answer, made safe for step 2 (R2-UI-01): an API that answers
 *  without `payments` (or `items`) gets empty lists — a fresh ring-up has
 *  taken no money — so the payment step renders instead of crashing the till
 *  after the ticket has already gone to the kitchen. */
export function normaliseRungOrder(r: TillOrder | OfflinePlaceholder): TillOrder | OfflinePlaceholder {
  if (!r || typeof r !== 'object' || isOfflinePlaceholder(r)) return r
  return { ...r, payments: r.payments ?? [], items: r.items ?? [] }
}

/** A cashier-readable message for a till error (never a bare "Validation failed"). */
export function tillErrorMessage(e: unknown, fallback = 'Something went wrong — try again'): string {
  if (e instanceof ApiError) {
    if (e.code === 'VALIDATION_ERROR') return 'The till sent something the server could not accept. Reload the till and try again; if it keeps happening, call a manager.'
    const raast = raastErrorText(e)
    if (raast) return raast
    const onAccount = onAccountErrorText(e)
    if (onAccount) return onAccount
    if (e.status === 0 || e.code === 'PORTFOLIO_WRITE_CANCELLED') return e.message
    return e.message || fallback
  }
  if (e instanceof TypeError) return 'No connection to the server — check the network and try again'
  if (e instanceof Error) return e.message
  return fallback
}

/**
 * A printable HTML page from the API (a receipt, a pre-bill), with the
 * session (UI-04). The web session is an httpOnly cookie, so the request
 * carries credentials; the in-memory token is added when there is one. An
 * expired session is refreshed through the shared client (any authed read
 * refreshes it) and the fetch retried once. A refusal throws an ApiError with
 * the server's code (e.g. 409 PRE_BILL_REQUIRED) — never returns the API's
 * error JSON as a "receipt".
 */
export async function fetchPrintableHtml(path: string, token: string | null | undefined): Promise<string> {
  const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
  const get = () => fetch(`${API_URL}/api/v1${path}`, {
    credentials: 'include',
    headers: { ...(token && { Authorization: `Bearer ${token}` }) },
  })
  let res = await get()
  if (res.status === 401) {
    // The shared client refreshes the session cookie on a 401 (or sends the
    // user to sign in when it can't).
    await api.get('/pos/shifts/current')
    res = await get()
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw new ApiError(res.status, body?.error?.code ?? 'PRINT_FAILED', body?.error?.message ?? `Could not load the page to print (${res.status})`)
  }
  return res.text()
}

/**
 * The full & final bill as printable HTML (GET /pos/receipt/:orderId). Only a
 * paid / completed order has one: an open order answers 409
 * PRE_BILL_REQUIRED (spec §17.1) — offer the pre-bill instead
 * (isPreBillRequired). `duplicate` marks a reprint (DUPLICATE banner).
 */
export function fetchReceiptHtml(orderId: string, token: string | null | undefined, opts: { duplicate?: boolean } = {}): Promise<string> {
  return fetchPrintableHtml(`/pos/receipt/${encodeURIComponent(orderId)}${opts.duplicate ? '?duplicate=1' : ''}`, token)
}

/** The final-bill print was refused because the order is not paid yet (spec §17.1). */
export function isPreBillRequired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && e.code === 'PRE_BILL_REQUIRED'
}

/**
 * Open a print window NOW (inside the click, so the browser doesn't block
 * the pop-up), fill it with the HTML `load` returns, and print. Rejects with
 * the load's own error (the window is closed first), or with a readable
 * error when pop-ups are blocked.
 */
export async function printHtml(load: () => Promise<string>, size: { width: number; height: number } = { width: 400, height: 600 }): Promise<void> {
  const win = window.open('', '_blank', `width=${size.width},height=${size.height}`)
  if (!win) throw new Error('The browser blocked the print window — allow pop-ups for this site')
  win.document.write('<p style="font-family:monospace;padding:20px">Loading…</p>')
  try {
    const html = await load()
    win.document.open()
    win.document.write(html)
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 500)
  } catch (e) {
    win.close()
    throw e
  }
}

// ─── Pre-bills (spec §17.1) ──────────────────────────────────────────────────
//
// A pre-bill is the bill printed for an OPEN order before payment: "PRE-BILL —
// NOT A TAX INVOICE", a PB-<n> number, the server-quoted totals (cash, plus
// the card total line) and NO fiscal number. It never goes to the fiscal POS.
// Every print, reprints included, is a permanent record (Finance → Voided
// pre bills). Only the full & final bill (after payment) carries the fiscal
// block.

export interface PreBillResult {
  preBill: { id: string; number: number; status: string; totalCents: number; cardTotalCents: number | null }
  receipt: { kind: 'pre_bill'; number: string; totalCents: number; cardTotalCents: number | null; dueCents: number; paidCents: number }
}

/** POST /pos/orders/:id/pre-bill — records the pre-bill (a permanent row) and returns it. */
export function createPreBill(orderId: string, tender: 'cash' | 'card' = 'cash'): Promise<PreBillResult> {
  return api.post<PreBillResult>(`/pos/orders/${encodeURIComponent(orderId)}/pre-bill`, { tender })
}

/** Print a pre-bill for an open order: record it, then print GET /pos/pre-bills/:id/html. */
export function printPreBill(orderId: string, tender: 'cash' | 'card', token: string | null | undefined): Promise<void> {
  return printHtml(async () => {
    const r = await createPreBill(orderId, tender)
    return fetchPrintableHtml(`/pos/pre-bills/${encodeURIComponent(r.preBill.id)}/html`, token)
  })
}

/** A readable line for a pre-bill refusal. */
export function preBillErrorMessage(e: unknown): string {
  if (isMissingRoute(e)) return 'Pre-bills are not on this server yet — ask IT to update the API.'
  if (e instanceof ApiError) {
    if (e.code === 'ALREADY_FINAL') return 'This order is already paid — print the full & final bill instead.'
    if (e.code === 'ORDER_NOT_OPEN') return 'This order is closed (cancelled or refunded) — there is no bill to print.'
    if (e.code === 'ORDER_CHANGED') return 'The bill changed while printing — print the pre-bill again.'
  }
  return tillErrorMessage(e, 'Could not print the pre-bill')
}

// ─── Fiscal (spec §6.5) ──────────────────────────────────────────────────────

/** What people see of a fiscal document (backend connectors/fiscal/view.ts). */
export interface FiscalView {
  documentId: string
  kind: 'sale' | 'refund'
  status: 'filed' | 'pending' | 'failed' | 'not_required' | 'test'
  rawStatus: string
  statusReason: string | null
  fiscalNumber: string | null
  authority: string | null
  qrPayload: string | null
  verifyUrl: string | null
  fiscalAt: string | null
  isTest: boolean
  attempts: number
  /** Managers only; null for everyone else. */
  lastError: string | null
}

/**
 * The cashier-facing line for a sale's fiscal document. A failed document
 * still reads "pending" to the cashier (it is retried; the receipt prints
 * pending too). `test` is a TEST connector — never a real fiscal invoice.
 */
export function fiscalLine(f: FiscalView | null | undefined): { text: string; tone: 'ok' | 'pending' | 'test' | 'muted'; test: boolean } | null {
  if (!f) return null
  const auth = (f.authority ?? '').toUpperCase()
  switch (f.status) {
    case 'filed':
      return { text: `Fiscal: ${auth ? `${auth} ` : ''}${f.fiscalNumber ?? ''}`.trim(), tone: 'ok', test: false }
    case 'test':
      return {
        text: f.fiscalNumber
          ? `Fiscal: ${auth ? `${auth} ` : ''}${f.fiscalNumber} — TEST, not a fiscal invoice`
          : 'Fiscal: TEST — not a fiscal invoice',
        tone: 'test', test: true,
      }
    case 'not_required':
      return { text: 'Fiscal: not required for this sale', tone: 'muted', test: false }
    default:
      // Held (spec §17.0): the company is not live with the fiscal POS yet —
      // nothing is sent until the CEO takes it live, so never "will file".
      if (isFiscalHeld(f)) return { text: 'Fiscal invoice: held — the company is not live with the fiscal POS yet', tone: 'muted', test: false }
      return { text: 'Fiscal invoice: pending — will file automatically', tone: 'pending', test: false }
  }
}

/** A document held until the company goes live with the fiscal POS (spec §17.0) — it never files on its own. */
export function isFiscalHeld(f: Pick<FiscalView, 'rawStatus'> | null | undefined): boolean {
  return f?.rawStatus === 'held'
}

/** GET /pos/orders/:id/fiscal — the order's fiscal documents ([] on an API without the connector). */
export async function fetchOrderFiscal(orderId: string): Promise<FiscalView[]> {
  try {
    return await api.get<FiscalView[]>(`/pos/orders/${encodeURIComponent(orderId)}/fiscal`)
  } catch (e) {
    if (isMissingRoute(e)) return []
    throw e
  }
}

/** POST /pos/orders/:id/fiscal/retry — managers: retry the order's failed / rejected documents. */
export function retryOrderFiscal(orderId: string): Promise<{ retried: number; fiscal: FiscalView[] }> {
  return api.post<{ retried: number; fiscal: FiscalView[] }>(`/pos/orders/${encodeURIComponent(orderId)}/fiscal/retry`, {})
}

// ─── Card machine (spec §7, routes in backend modules/connectors/posRoutes.ts) ─

export interface TerminalConfig {
  /** false → the till is exactly today's manual flow (no connector, driver none, or no terminal here). */
  enabled: boolean
  driver: string
  isTest: boolean
  /** The manual "machine reference" path is allowed (always true when the connector is off). */
  allowManualRef: boolean
  chargeTimeoutSec: number
  pollMs: number
  terminals: Array<{ id: string; label: string }>
  /** Health of the first terminal (cached 15 s on the server); null = not checked. */
  online: boolean | null
}

export type TerminalChargeStatus =
  | 'pending' | 'sent' | 'approved' | 'recorded' | 'declined' | 'cancel_requested' | 'cancelled'
  | 'expired' | 'unknown' | 'unverified' | 'void_pending' | 'voided' | 'needs_attention' | 'manual_resolved'

export interface TerminalChargeView {
  id: string
  kind: 'charge' | 'refund'
  status: TerminalChargeStatus
  final: boolean
  orderId: string
  terminalId: string
  terminalLabel: string
  amountCents: number
  tipCents: number
  quoteDueCents: number
  approvalRef: string | null
  cardBrand: string | null
  cardLast4: string | null
  message: string | null
  refusalCode: string | null
  expiresAt: string
  createdAt: string
  payment: { id: string; method: string; amountCents: number } | null
  fiscal: FiscalView | null
  /** A refund: the card-machine payment it goes back on (present once the API sends it). */
  targetPaymentId?: string | null
}

/**
 * Statuses that hold the order: no other tender, comp, gift card or split
 * until the charge settles or the cashier resolves it (the server's
 * TERMINAL_CHARGE_ACTIVE guard uses the same list).
 */
export const CHARGE_BLOCKING: readonly TerminalChargeStatus[] = ['pending', 'sent', 'approved', 'cancel_requested', 'unknown']
export function chargeBlocks(c: TerminalChargeView | null | undefined): boolean {
  return !!c && (CHARGE_BLOCKING as readonly string[]).includes(c.status)
}
/** The money reached the order (the server wrote the Payment). */
export function chargeSucceeded(c: TerminalChargeView | null | undefined): boolean {
  return !!c && (c.status === 'recorded' || c.status === 'manual_resolved')
}

/** GET /pos/terminal/config?shiftId= — null on an API without the card-machine routes. */
export async function fetchTerminalConfig(shiftId: string): Promise<TerminalConfig | null> {
  try {
    return await api.get<TerminalConfig>(`/pos/terminal/config?shiftId=${encodeURIComponent(shiftId)}`)
  } catch (e) {
    if (isMissingRoute(e)) return null
    throw e
  }
}

/** The till's card-machine settings for this drawer. `data === null` → manual flow only. */
export function useTerminalConfig(shiftId: string | null) {
  return useQuery({
    queryKey: ['pos', 'terminal-config', shiftId],
    queryFn: () => fetchTerminalConfig(shiftId!),
    enabled: !!shiftId,
    staleTime: 15_000,
    retry: false,
  })
}

export function startTerminalCharge(body: {
  orderId: string
  shiftId: string
  terminalId: string
  tipCents: number
  expectedDueCents: number
  idempotencyKey: string
  paymentId?: string
}): Promise<TerminalChargeView> {
  return api.post<TerminalChargeView>('/pos/terminal/charges', body)
}

export function getTerminalCharge(id: string): Promise<TerminalChargeView> {
  return api.get<TerminalChargeView>(`/pos/terminal/charges/${encodeURIComponent(id)}`)
}

/** Charges still in play on an order (resume after a reload or a closed modal). [] on an older API. */
export async function activeTerminalCharges(orderId: string): Promise<TerminalChargeView[]> {
  try {
    return await api.get<TerminalChargeView[]>(`/pos/terminal/charges?orderId=${encodeURIComponent(orderId)}&active=1`)
  } catch (e) {
    if (isMissingRoute(e)) return []
    throw e
  }
}

/** Every card-machine charge and refund on an order, newest first. [] on an older API. */
export async function terminalChargesFor(orderId: string): Promise<TerminalChargeView[]> {
  try {
    return await api.get<TerminalChargeView[]>(`/pos/terminal/charges?orderId=${encodeURIComponent(orderId)}`)
  } catch (e) {
    if (isMissingRoute(e)) return []
    throw e
  }
}

export function cancelTerminalCharge(id: string): Promise<TerminalChargeView> {
  return api.post<TerminalChargeView>(`/pos/terminal/charges/${encodeURIComponent(id)}/cancel`, {})
}

/** The cashier reads the machine when servd could not (unknown outcome). Never re-key the charge. */
export function resolveTerminalCharge(
  id: string,
  body: { outcome: 'approved_manual'; gatewayRef: string } | { outcome: 'not_charged'; note?: string },
): Promise<TerminalChargeView> {
  return api.post<TerminalChargeView>(`/pos/terminal/charges/${encodeURIComponent(id)}/resolve`, body)
}

/** POST /pos/terminal/refunds — managers: refund a card-machine payment back to the card. */
export function startTerminalRefund(body: {
  paymentId: string
  amountCents: number
  terminalId: string
  idempotencyKey: string
  reason: string
  photoUrl?: string
}): Promise<TerminalChargeView> {
  return api.post<TerminalChargeView>('/pos/terminal/refunds', body)
}

function storageGet(store: 'local' | 'session', key: string): string | null {
  try { return (store === 'local' ? window.localStorage : window.sessionStorage).getItem(key) } catch { return null }
}
function storageSet(store: 'local' | 'session', key: string, value: string | null): void {
  try {
    const s = store === 'local' ? window.localStorage : window.sessionStorage
    if (value === null) s.removeItem(key)
    else s.setItem(key, value)
  } catch { /* private window / blocked storage: the server still dedupes per tap */ }
}

/**
 * The idempotency key for ONE charge attempt (spec §7.3): created once and
 * kept in sessionStorage under charge:<orderId>:<due>:<tip>, so a double tap,
 * a lost response or a reload replays the SAME charge instead of pushing a
 * second one to the machine. Dropped when the attempt ends without money
 * (declined, cancelled, not charged) so a retry is a new attempt.
 */
export function chargeKeyFor(orderId: string, dueCents: number, tipCents: number): string {
  const name = `charge:${orderId}:${dueCents}:${tipCents}`
  const held = storageGet('session', name)
  if (held) return held
  const key = newIdempotencyKey().replace(/^pos-/, 'term-')
  storageSet('session', name, key)
  return key
}
export function dropChargeKey(orderId: string, dueCents: number, tipCents: number): void {
  storageSet('session', `charge:${orderId}:${dueCents}:${tipCents}`, null)
}

/**
 * The idempotency key for ONE card-machine refund attempt (spec §7.3, as for
 * a charge): kept in sessionStorage under refund:<paymentId>:<amountCents>,
 * so a lost response, a second tap or a retry after "not answered yet"
 * replays the SAME refund instead of pushing a second one to the card.
 * Dropped once the attempt is over (booked, or ended with no money moved).
 */
export function refundKeyFor(paymentId: string, amountCents: number): string {
  const name = `refund:${paymentId}:${amountCents}`
  const held = storageGet('session', name)
  if (held) return held
  const key = newIdempotencyKey().replace(/^pos-/, 'refund-')
  storageSet('session', name, key)
  return key
}
export function dropRefundKey(paymentId: string, amountCents: number): void {
  storageSet('session', `refund:${paymentId}:${amountCents}`, null)
}

// ─── Refund to card on a cancelled ticket (LEDGER-R5 hand-back) ─────────────
//
// A ticket cancelled / rejected after the card machine took the card owes
// that money back. Managers can send it back to the card on the machine
// (POST /pos/terminal/refunds) — the server checks it against the ticket's
// refund due BEFORE the machine moves money and books it as the hand-back
// (never a sale refund, never a fiscal document). This is the server's rule
// (backend pos/service.ts refundDueOf + inFlightTerminalRefundCents, and
// connectors/terminal startTerminalRefund), used only to OFFER the button and
// its most; the server re-checks everything under the order lock.

/** A payment row as GET /orders/:id returns it. */
export interface HandBackPayment {
  id: string
  method: string
  amountCents: number
  status: string
  gateway?: string | null
  gatewayRef?: string | null
  shiftId?: string | null
}

type RefundChargeLike = Pick<TerminalChargeView, 'kind' | 'status' | 'amountCents' | 'payment'> & { targetPaymentId?: string | null }

/** Card-machine refunds not booked yet that already hold card money (the server's start-time count). */
const CARD_REFUND_IN_FLIGHT: ReadonlySet<string> = new Set(['pending', 'sent', 'approved', 'cancel_requested', 'unknown', 'needs_attention'])
/** Card-machine refunds that count against the payment they go back on. */
const CARD_REFUND_ON_PAYMENT: ReadonlySet<string> = new Set([...CARD_REFUND_IN_FLIGHT, 'recorded'])

export interface CardRefundOffer {
  /** The card-machine payment the refund goes back on. */
  paymentId: string
  /** The most that may go back to the card now, in paisa. */
  maxCents: number
}

/**
 * "Refund to card" on a cancelled / rejected ticket: offered when a card
 * machine is connected and a card-machine payment still has money owed back.
 * The most is the least of: what the ticket still owes back, what it owes
 * back by card, and what is left on that card payment — each less the card
 * refunds in flight on the machine. Null → no button (record the hand-back
 * instead).
 */
export function cancelledCardRefundOffer(input: {
  status: string
  payments: readonly HandBackPayment[]
  charges: readonly RefundChargeLike[]
  terminalEnabled: boolean
}): CardRefundOffer | null {
  if (!input.terminalEnabled) return null
  // A cancelled / rejected ticket's hand-back, or a credit-noted ('refunded') bill's owed-back pay-out (S-1).
  if (input.status !== 'cancelled' && input.status !== 'rejected' && input.status !== 'refunded') return null
  const receipts = input.payments.filter((p) => p.amountCents > 0 && !!p.shiftId && p.method !== 'comp'
    && (p.status === 'paid' || (p.status === 'pending' && (p.method === 'card' || p.method === 'keenu_qr') && !!p.gatewayRef)))
  const refunds = input.payments.filter((p) => p.status === 'refunded' && p.amountCents < 0)
  const machineRefunds = input.charges.filter((c) => c.kind === 'refund')
  const inFlight = machineRefunds
    .filter((c) => !c.payment && CARD_REFUND_IN_FLIGHT.has(c.status))
    .reduce((t, c) => t + c.amountCents, 0)
  const sum = (rows: readonly HandBackPayment[]) => rows.reduce((t, p) => t + Math.abs(p.amountCents), 0)
  const due = sum(receipts) - sum(refunds) - inFlight
  const cardLeft = sum(receipts.filter((p) => p.method === 'card')) - sum(refunds.filter((p) => p.method === 'card')) - inFlight

  let best: CardRefundOffer | null = null
  for (const p of receipts) {
    if (p.method !== 'card' || p.gateway !== 'card_terminal' || p.status !== 'paid') continue
    const onPayment = machineRefunds
      .filter((c) => c.targetPaymentId === p.id && CARD_REFUND_ON_PAYMENT.has(c.status))
      .reduce((t, c) => t + c.amountCents, 0)
    const left = p.amountCents - onPayment
    if (!best || left > best.maxCents) best = { paymentId: p.id, maxCents: left }
  }
  if (!best) return null
  const maxCents = Math.min(due, cardLeft, best.maxCents)
  return maxCents > 0 ? { paymentId: best.paymentId, maxCents } : null
}

/**
 * Everything the "Refund to card" button needs for one cancelled ticket: the
 * order (status, payments), its card-machine charges, and whether a card
 * machine is connected at `shiftId`'s outlet.
 */
export async function fetchCancelledCardRefundOffer(orderId: string, shiftId: string | null): Promise<CardRefundOffer | null> {
  const [order, charges, config] = await Promise.all([
    api.get<{ status: string; payments: HandBackPayment[] }>(`/orders/${encodeURIComponent(orderId)}`),
    terminalChargesFor(orderId),
    shiftId ? fetchTerminalConfig(shiftId).catch(() => null) : Promise.resolve(null),
  ])
  return cancelledCardRefundOffer({ status: order.status, payments: order.payments ?? [], charges, terminalEnabled: !!config?.enabled })
}

const TERMINAL_PICK_KEY = 'servd.till.terminal'
/** The card machine this browser last used (per browser, spec §7.1). */
export function rememberedTerminal(): string | null {
  return storageGet('local', TERMINAL_PICK_KEY)
}
export function rememberTerminal(id: string): void {
  storageSet('local', TERMINAL_PICK_KEY, id)
}

/** A readable line for a card-machine refusal. */
export function terminalErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'TERMINAL_NOT_CONFIGURED':
        return 'The card machine is not set up — take the card on the machine and enter its reference.'
      case 'TERMINAL_NOT_IN_COMPANY':
        return 'That card machine is not set up at this outlet — pick another one.'
      case 'NOT_YOUR_SHIFT':
        return 'This is another cashier’s drawer — only they or a manager can charge on it.'
      case 'SHIFT_NOT_OPEN':
      case 'SHIFT_NOT_IN_COMPANY':
        return 'Your drawer is closed — open a shift, then charge again.'
      case 'ORDER_NOT_OPEN':
        return 'This order is no longer open — it cannot take a card payment.'
      case 'NOT_RESOLVABLE':
        return 'The card machine has answered since — the screen will update.'
      case 'NOT_YOUR_CHARGE':
        return 'Only the cashier who started this charge, or a manager, can do that.'
      case 'TERMINAL_CHARGE_ACTIVE':
        return 'The card machine is still working on this bill — finish or resolve that charge first.'
    }
  }
  return tillErrorMessage(e, 'The card machine could not be reached')
}

/** GET /orders/:id — the order as the server has it now. */
export function fetchOrder(orderId: string): Promise<TillOrder> {
  return api.get<TillOrder>(`/orders/${orderId}`)
}

// ─── "Box given" (packaging rule, owner's FINAL rule 2026-10-13) ────────────
//
// A dine-in line at a PLATE brand counts its dish's packaging only when staff
// tap "Box given" (the leftovers were boxed). Takeaway / delivery lines and a
// packaging-vessel brand's lines (e.g. Stackd) already count it, so they never
// show the button. The rule lives on the server (lib/recipeCost.ts
// packagingApplies); this file only decides when to OFFER the tap and speaks
// the answer in words. The server re-checks everything.
//
//   POST /pos/orders/:orderId/items/:itemId/box-given        {}  → box it
//                                                       { undo: true } → take it back
//     → { boxGiven, depleted }   (till, floor and pass staff of the order's company)
//   409 BOX_NOT_NEEDED · ORDER_COMPLETED (undo after the sale completed) ·
//   LINE_VOIDED · ORDER_ENDED;  404 outside the company or a line of another order.

export interface BoxGivenResult { boxGiven: boolean; depleted: boolean }

/** Tap "Box given" on a line, or take the tap back (`undo`) while the order is open. */
export function boxGiven(orderId: string, itemId: string, undo = false): Promise<BoxGivenResult> {
  return api.post<BoxGivenResult>(`/pos/orders/${orderId}/items/${itemId}/box-given`, undo ? { undo: true } : {})
}

/**
 * What a line offers: nothing ('hidden'), the tap ('box'), or — once boxed —
 * a chip with an Undo ('boxed_undo') while the order is still open, or the
 * chip alone ('boxed') once the sale has completed.
 */
export type BoxGivenOffer = 'hidden' | 'box' | 'boxed_undo' | 'boxed'

export function boxGivenOffer(
  order: { fulfilmentType?: string | null; status: string },
  item: { status?: string; serviceVessel?: string | null; boxGiven?: boolean },
): BoxGivenOffer {
  if (order.fulfilmentType !== 'dine_in') return 'hidden'             // takeaway / delivery already count their packaging
  if ((item.serviceVessel ?? 'plate') !== 'plate') return 'hidden'     // a packaging-vessel brand's line already counts it
  if (item.status === 'voided') return 'hidden'
  if (['cancelled', 'rejected', 'refunded'].includes(order.status)) return 'hidden'
  if (!item.boxGiven) return 'box'
  return order.status === 'completed' ? 'boxed' : 'boxed_undo'
}

/** A "Box given" refusal in plain words. */
export function boxGivenErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'BOX_NOT_NEEDED':
        return 'This line already counts its packaging (takeaway, delivery, or a brand that serves in packaging) — no "Box given" needed.'
      case 'ORDER_COMPLETED':
        return 'This order is complete — "Box given" can no longer be taken back.'
      case 'LINE_VOIDED':
        return 'This line was voided, so there is nothing to box.'
      case 'ORDER_ENDED':
        return 'This order has ended (cancelled, rejected or refunded) — nothing to box.'
    }
    if (e.status === 403) return 'Only till, floor and kitchen staff can tap "Box given".'
    if (e.status === 404) return 'That line was not found on this order — reload the page.'
  }
  return tillErrorMessage(e, 'Could not save "Box given" — try again')
}

/**
 * POST /pos/payments — one tender for what is due. `amountCents` is what the
 * tender takes: the bill's due PLUS `tipCents` when there is a tip (FOH-14).
 * `idempotencyKey` is one per payment submission, reused by its retries
 * (FOH-04), so a double tap or a lost response never charges twice.
 */
export function payOrder(body: {
  orderId: string
  shiftId: string
  idempotencyKey: string
  method: TillTender
  amountCents: number
  tenderedCents?: number
  gatewayRef?: string
  tipCents?: number
  /** The card machine is offline / not answering: the reference was keyed from its slip (spec §7.13). */
  manualReason?: 'terminal_offline'
  /**
   * Raast QR: the cashier saw the money arrive on the COUNTER phone (bank SMS
   * / merchant app) — never the customer's screen. Required by the server
   * with a Raast reference (400 RAAST_NOT_VERIFIED without it).
   */
  raastVerified?: true
}) {
  const { orderId, shiftId, idempotencyKey, ...p } = body
  return api.post<TillPaymentResult>('/pos/payments', { orderId, shiftId, idempotencyKey, payments: [p] })
}

/** A Raast QR tender's receipt as the payment answers carry it (backend pos/raastTender.ts raastTenderView). */
export interface RaastTenderView {
  receiptId: string
  paymentId?: string | null
  /** 'provisional' until the bank statement matches it; then 'matched'. */
  status: RaastReceiptStatus
  bankRef: string | null
  confirmedVia: 'cashier' | 'sms' | 'bank_api' | null
  smsConfirmed: boolean
}

/** POST /pos/payments (and the comp) answer. `fiscal` is the sale's fiscal document once the API files through the POS connector. */
export interface TillPaymentResult {
  payments: Array<{ id: string; changeCents: number | null }>
  orderCompleted: boolean
  fiscal?: FiscalView | null
  /** Raast QR tenders of this submission (present on an API with Raast). */
  raast?: RaastTenderView[]
}

// Till sales that are rung but not yet paid. A till sale completes when it is
// paid (decision 8), so these statuses are exactly the open ones.
const OPEN_STATUSES = 'received,confirmed,preparing,ready'

/** Open, unpaid till tickets for a brand (GET /orders — company-scoped server side). */
export function useOpenTickets(conceptId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['pos', 'open-tickets', conceptId],
    queryFn: async () => {
      const page = await api.get<{ data: TillOrder[] }>(
        `/orders?conceptId=${encodeURIComponent(conceptId!)}&source=pos&status=${OPEN_STATUSES}&limit=100`,
      )
      return page.data
        .filter(isUnpaid)
        .sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime())
    },
    enabled: !!conceptId && enabled,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  })
}

// ─── Drawer close (FOH-21 / TILL-R1) ─────────────────────────────────────────
//
// POST /pos/shifts/:id/close answers 409 OPEN_TICKETS while unpaid tickets
// are still on the drawer (a table still eating at shift change, a walk-out).
// The till names them (GET /pos/shifts/:id/open-tickets — the drawer's own
// cashier or a manager) and the cashier either settles / cancels them or
// confirms "close anyway", which resends with confirmOpenTickets. A ticket
// with nothing left to collect (voided down to PKR 0) never holds the close.

/** One unpaid ticket on a drawer, as the close and the Z-report list it. */
export interface DrawerOpenTicket {
  id: string
  ref: string
  placedAt: string
  status: string
  table: string | null
  totalCents: number
  paidCents: number
  dueCents: number
}

export interface DrawerOpenTickets {
  count: number
  totalCents: number
  dueCents: number
  tickets: DrawerOpenTicket[]
}

/** The Z-report fields the shared ZReport type does not carry yet. */
export interface ZReportExtras {
  /** Raast QR takings on this drawer (absent on an API without Raast). */
  raastSales?: number
  raastCount?: number
  /** Of raastSales: not on a bank statement yet / matched to one. */
  raastProvisionalCents?: number
  raastMatchedCents?: number
  /** Raast takings on tickets the CEO voided ("never booked") — left out of the sales and the refund due. */
  raastVoidedCents?: number
  /**
   * Bills charged to on-account clients on this drawer — a sale, but no money
   * in the drawer (billed to each client's account). Absent while on account is off.
   */
  onAccountSales?: number
  onAccountCount?: number
  onAccountByClient?: Array<{ number: string; name: string; cents: number; count: number }>
  /** Card / cash tips inside the takings — staff money (2095), not sales. */
  tipsCents?: number
  /** Takings (cash + card) less tips. */
  salesExTipsCents?: number
  /** What gift cards paid of the bills this drawer books. */
  giftCardCents?: number
  /** Money taken on tickets later cancelled, not yet handed back. */
  refundDueCents?: number
  /**
   * `orderIds`: the cancelled tickets themselves (the shift screen offers
   * "Refund to card" on each); `cardOwedCents`: the card money on them still
   * owed back. Both absent on an older API.
   */
  cancelledPaid?: { count: number; cashCents: number; cardCents: number; raastCents?: number; orderIds?: string[]; cardOwedCents?: number }
  openTickets?: DrawerOpenTickets
  unassignedOpenTickets?: { count: number; totalCents: number }
  /** Takings less refunds (getZReport's netCents / netRevenue). */
  netCents?: number
  netRevenue?: number
}

/**
 * Whether the shift's Z report shows the "card money on cancelled tickets"
 * box: only while some card money is still owed back (`cardOwedCents`), not
 * merely because card was taken (an older API without it: card taken).
 */
export function cancelledCardStillOwed(cp: ZReportExtras['cancelledPaid'] | null | undefined): boolean {
  if (!cp) return false
  return (typeof cp.cardOwedCents === 'number' ? cp.cardOwedCents : cp.cardCents) > 0
}

/** The figures the Z-report screen reads (getZReport's answer). */
export interface ZReportFigures extends ZReportExtras {
  cashSales: number
  cardSales: number
  walletSales: number
  totalSales: number
  totalOrders: number
  totalDiscounts: number
  totalTax: number
  expectedCashInDrawer: number
  actualCashInDrawer: number | null
  cashVariance: number | null
  openingFloatCents?: number
  refundsCents?: number
  cashRefundsCents?: number
  varianceLimitCents?: number
  isBalanced?: boolean
}

export type ZTone = 'text' | 'subtext' | 'green' | 'amber' | 'red'
export interface ZLine { label: string; value: string; tone: ZTone }

/** The drawer variance in words (R2-UI-05): counted minus expected, so a
 *  negative variance is money missing from the drawer. */
export function varianceWords(varianceCents: number | null | undefined, fmt: (c: number) => string): string {
  const v = varianceCents ?? 0
  if (v === 0) return 'Balanced'
  return v < 0 ? `Short ${fmt(-v)}` : `Over ${fmt(v)}`
}

/**
 * The Z-report screen's rows (R2-UI-05). "Total takings" is what went through
 * the drawer and card machine — it includes money taken on tickets that were
 * later cancelled — so the screen also shows that money, the refunds paid
 * out (and how much of it left the drawer as cash), and the net sales, which
 * is what reconciles. Every figure is getZReport's own; nothing is re-derived
 * here except the fallback for an API without netCents.
 */
export function zReportLines(r: ZReportFigures, fmt: (c: number) => string): ZLine[] {
  const lines: ZLine[] = [
    { label: 'Cash takings', value: fmt(r.cashSales), tone: 'text' },
    // Card on the Keenu machine (and old Keenu QR sales, which settle the same way).
    { label: 'Card takings (Keenu)', value: fmt(r.cardSales), tone: 'text' },
  ]
  if (r.raastSales !== undefined) {
    lines.push({ label: `Raast takings${r.raastCount ? ` (${r.raastCount})` : ''}`, value: fmt(r.raastSales), tone: 'text' })
    const provisional = r.raastProvisionalCents ?? 0
    if (provisional > 0) {
      // A Raast receipt is the cashier's word (or the bank SMS) until the bank
      // statement shows the money — finance matches it.
      lines.push({ label: 'of which not on a bank statement yet', value: fmt(provisional), tone: 'amber' })
    }
  }
  if ((r.onAccountSales ?? 0) > 0 || (r.onAccountCount ?? 0) > 0) {
    // Billed to clients' accounts: in the takings, never in the drawer (the close debits each client).
    lines.push({ label: `On account${r.onAccountCount ? ` (${r.onAccountCount})` : ''}`, value: fmt(r.onAccountSales ?? 0), tone: 'text' })
    for (const c of r.onAccountByClient ?? []) {
      lines.push({ label: `${c.number} ${c.name}${c.count > 1 ? ` (${c.count})` : ''}`, value: fmt(c.cents), tone: 'subtext' })
    }
  }
  lines.push({ label: 'Wallet', value: fmt(r.walletSales), tone: 'text' })
  if ((r.giftCardCents ?? 0) > 0) lines.push({ label: 'Gift cards', value: fmt(r.giftCardCents!), tone: 'text' })
  lines.push(
    { label: 'Discounts', value: fmt(r.totalDiscounts), tone: 'amber' },
    { label: 'Tax (GST)', value: fmt(r.totalTax), tone: 'subtext' },
    { label: 'Total takings', value: fmt(r.totalSales), tone: 'text' },
  )
  const tips = r.tipsCents ?? 0
  if (tips > 0) {
    // TILL-R5: tips ride inside the takings but are staff money, not sales.
    lines.push({ label: 'of which tips', value: fmt(tips), tone: 'subtext' })
  }
  const cancelled = r.cancelledPaid
  const cancelledCents = (cancelled?.cashCents ?? 0) + (cancelled?.cardCents ?? 0) + (cancelled?.raastCents ?? 0)
  if (cancelled && cancelledCents > 0) {
    lines.push({
      label: `of which on cancelled tickets (${cancelled.count})`,
      value: fmt(cancelledCents),
      tone: 'amber',
    })
  }
  const refunds = r.refundsCents ?? 0
  if (refunds > 0) {
    lines.push({ label: 'Refunds', value: fmt(-refunds), tone: 'amber' })
    const cashRefunds = r.cashRefundsCents ?? 0
    if (cashRefunds > 0) lines.push({ label: 'of which cash from the drawer', value: fmt(cashRefunds), tone: 'subtext' })
  }
  const net = r.netCents ?? r.netRevenue ?? r.totalSales - refunds
  lines.push(
    { label: 'Net sales', value: fmt(net), tone: 'green' },
    { label: 'Orders', value: String(r.totalOrders), tone: 'text' },
  )
  if (r.openingFloatCents != null) lines.push({ label: 'Opening float', value: fmt(r.openingFloatCents), tone: 'subtext' })
  const variance = r.cashVariance ?? 0
  const balanced = r.isBalanced ?? variance === 0
  lines.push(
    { label: 'Expected cash', value: fmt(r.expectedCashInDrawer), tone: 'text' },
    { label: 'Counted cash', value: fmt(r.actualCashInDrawer ?? 0), tone: 'text' },
    {
      label: variance !== 0 && balanced ? 'Variance (within tolerance)' : 'Variance',
      value: varianceWords(variance, fmt),
      tone: variance === 0 ? 'green' : balanced ? 'amber' : 'red',
    },
  )
  return lines
}

/** True when a close was refused because tickets are still open on the drawer. */
export function isOpenTicketsError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && e.code === 'OPEN_TICKETS'
}

/** GET /pos/shifts/:id/open-tickets — the tickets that hold this drawer's close. */
export function fetchDrawerOpenTickets(shiftId: string): Promise<DrawerOpenTickets> {
  return api.get<DrawerOpenTickets>(`/pos/shifts/${shiftId}/open-tickets`)
}

/**
 * POST /pos/shifts/:id/close. `confirmOpenTickets` closes the drawer even
 * with unpaid tickets on it (they stay open and are named on the Z-report).
 */
export function closeDrawer<T>(
  shiftId: string,
  closingFloatCents: number,
  opts: { notes?: string; confirmOpenTickets?: boolean } = {},
): Promise<T> {
  return api.post<T>(`/pos/shifts/${shiftId}/close`, {
    closingFloatCents,
    ...(opts.notes && { notes: opts.notes }),
    ...(opts.confirmOpenTickets && { confirmOpenTickets: true }),
  })
}

// ─── Raast QR (spec §6.6 / §8 E; backend modules/connectors/raastPosRoutes.ts) ─
//
// Raast QR is an instant bank transfer to the company's receiving account.
// The cashier checks the money on the COUNTER phone (bank SMS / merchant
// app) — NEVER the customer's screen or a screenshot — and types the bank
// reference. The sale completes at the till like card; the receipt is
// 'provisional' until finance matches it to the bank statement.
//
//   SMS matching OFF (default): POST /pos/payments {method 'raast', gatewayRef,
//     raastVerified: true}.
//   SMS matching ON: POST /pos/raast/intents puts the bill up for Raast; the
//     bank SMS settles it by itself, or the cashier confirms by hand.

export type RaastReceiptStatus = 'awaiting' | 'provisional' | 'matched' | 'cancelled' | 'unreceived' | 'needs_attention'

/** The rule every Raast screen repeats (the server sends the same words). */
export const RAAST_COUNTER_WARNING =
  'Check the money on the counter phone (bank SMS / merchant app). Never accept the customer’s phone screen or a screenshot — fake payment screens are common.'
/** S5: the old Keenu QR standees may still be on the counter after the cutover. */
export const KEENU_QR_CUTOVER_NOTE = 'A payment made to the old Keenu QR is recorded as Card – Keenu.'

/** GET /pos/raast/config — the brand's receiving account at this drawer's company. */
export interface RaastConfig {
  available: boolean
  reason: null | 'NOT_SET_UP'
  account: { bankName: string | null; accountTitle: string | null; raastId: string | null; last4: string | null } | null
  /** Bank-SMS matching is on for the company (the CEO switches it on). */
  smsMatching: boolean
  intentTtlMin: number
  refRule: { min: number; max: number }
  warning: string
  keenuQrNote?: string
}

/** An unmatched bank credit from just BEFORE the intent (S1) — never auto-attached. */
export interface RaastEarlierPayment {
  alertId: string
  amountCents: number
  payer: string | null
  occurredAt: string | null
  bankRefLast4: string | null
}

/** A Raast intent / receipt (GET /pos/raast/intents/:id). */
export interface RaastIntentView {
  id: string
  status: RaastReceiptStatus
  orderId: string
  orderRef: string
  amountCents: number
  tipCents: number
  dueCents: number
  expiresAt: string | null
  bankRef: string | null
  confirmedVia: 'cashier' | 'sms' | 'bank_api' | null
  smsConfirmed: boolean
  /** A bank SMS is completing it right now. */
  settling?: boolean
  attentionReason: string | null
  cancelReason?: string | null
  targetPaymentId?: string | null
  createdAt?: string
  possibleEarlier?: RaastEarlierPayment[]
  fiscal: FiscalView | null
}

/** An open bank alert at the till (GET /pos/raast/alerts). */
export interface TillRaastAlert {
  id: string
  status: 'unmatched' | 'ambiguous' | 'needs_attention' | string
  amountCents: number
  bankRef: string | null
  occurredAt: string | null
  payer: string | null
  bankAccount: { name: string; last4: string | null } | null
  /**
   * Bills waiting by Raast for this amount (ambiguous). `paymentId` = the
   * split portion the request settles (absent on an API that does not send it;
   * then the request is for the whole bill).
   */
  candidates: Array<{ receiptId: string; orderId: string; orderRef: string; amountCents: number; createdAt: string; paymentId?: string | null }>
}

/** Raast intent states in which nothing else may settle the bill. */
export function raastIntentBlocks(i: Pick<RaastIntentView, 'status'> | null | undefined): boolean {
  return !!i && i.status === 'awaiting'
}

/** The server's normalised bank reference (backend connectors/raast/reference.ts normalizeBankRef). */
export function normalizeRaastRef(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s\-_./#:]+/g, '')
}

/**
 * Why a typed reference would be refused (the server's own rule, shown before
 * sending so the cashier fixes it at once), or null. The server re-checks it
 * and also refuses a reference already used on another bill.
 */
export function raastRefProblem(raw: string, rule: { min: number; max: number }, orderId?: string): string | null {
  const ref = normalizeRaastRef(raw)
  if (!ref) return null
  if (!new RegExp(`^[A-Z0-9]{${rule.min},${rule.max}}$`).test(ref)) return `A bank reference is ${rule.min}–${rule.max} letters or digits.`
  if ((ref.match(/[0-9]/g) ?? []).length < 3) return 'A bank reference has at least 3 digits.'
  if (/^(.)\1*$/.test(ref)) return 'That is one repeated character, not a bank reference.'
  if (orderId && ref === orderRef(orderId)) return 'That is the bill’s own number — type the transaction ID from the bank SMS or the merchant app.'
  return null
}

/** GET /pos/raast/config?shiftId&conceptId — null on an API without Raast. */
export async function fetchRaastConfig(shiftId: string, conceptId: string | null | undefined): Promise<RaastConfig | null> {
  try {
    const q = `shiftId=${encodeURIComponent(shiftId)}${conceptId ? `&conceptId=${encodeURIComponent(conceptId)}` : ''}`
    return await api.get<RaastConfig>(`/pos/raast/config?${q}`)
  } catch (e) {
    if (isMissingRoute(e)) return null
    throw e
  }
}

/** The till's Raast settings for this drawer and brand. `data === null` → an API without Raast. */
export function useRaastConfig(shiftId: string | null, conceptId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['pos', 'raast-config', shiftId, conceptId ?? null],
    queryFn: () => fetchRaastConfig(shiftId!, conceptId),
    enabled: !!shiftId && enabled,
    staleTime: 15_000,
    retry: false,
  })
}

/** POST /pos/raast/intents — put the bill (or a Raast split portion) up for Raast. */
export function createRaastIntent(body: {
  orderId: string
  shiftId: string
  paymentId?: string
  tipCents: number
  expectedDueCents: number
  idempotencyKey: string
}): Promise<RaastIntentView> {
  return api.post<RaastIntentView>('/pos/raast/intents', body)
}

export function getRaastIntent(id: string): Promise<RaastIntentView> {
  return api.get<RaastIntentView>(`/pos/raast/intents/${encodeURIComponent(id)}`)
}

/** The order's waiting / needs-attention Raast payments (resume). [] on an API without Raast. */
export async function activeRaastIntents(orderId: string): Promise<RaastIntentView[]> {
  try {
    return await api.get<RaastIntentView[]>(`/pos/raast/intents?orderId=${encodeURIComponent(orderId)}&active=1`)
  } catch (e) {
    if (isMissingRoute(e)) return []
    throw e
  }
}

/** POST /pos/raast/intents/:id/confirm — the cashier saw it on the counter phone and typed the reference. */
export function confirmRaastIntent(id: string, bankRef: string): Promise<{ intent: RaastIntentView; payment: unknown }> {
  return api.post<{ intent: RaastIntentView; payment: unknown }>(`/pos/raast/intents/${encodeURIComponent(id)}/confirm`, {
    bankRef, counterVerified: true,
  })
}

export function cancelRaastIntent(id: string, reason?: string): Promise<RaastIntentView> {
  return api.post<RaastIntentView>(`/pos/raast/intents/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {})
}

/** GET /pos/raast/alerts?shiftId — open bank alerts for this drawer's company. [] on an API without Raast. */
export async function fetchRaastAlerts(shiftId: string): Promise<TillRaastAlert[]> {
  try {
    return await api.get<TillRaastAlert[]>(`/pos/raast/alerts?shiftId=${encodeURIComponent(shiftId)}`)
  } catch (e) {
    if (isMissingRoute(e)) return []
    throw e
  }
}

/** POST /pos/raast/alerts/:id/attach — pay a bill (or a Raast split portion) with that bank credit. */
export function attachRaastAlert(alertId: string, body: { orderId: string; shiftId: string; paymentId?: string }): Promise<{ outcome: string; intent: RaastIntentView }> {
  return api.post<{ outcome: string; intent: RaastIntentView }>(`/pos/raast/alerts/${encodeURIComponent(alertId)}/attach`, body)
}

/** Managers: a cashier's provisional receipt (no SMS yet) takes this alert's reference — a mistyped reference fixed. */
export function fixRaastReference(alertId: string, body: { receiptId: string; managerOverridePin?: string }): Promise<{ outcome: string; intent: RaastIntentView }> {
  return api.post<{ outcome: string; intent: RaastIntentView }>(`/pos/raast/alerts/${encodeURIComponent(alertId)}/attach`, body)
}

/** Managers: mark a bank credit "not a sale" (the money stays for finance; its reference can never pay a bill). */
export function dismissRaastAlert(alertId: string, body: { reason: string; managerOverridePin?: string }): Promise<{ id: string; status: string }> {
  return api.post<{ id: string; status: string }>(`/pos/raast/alerts/${encodeURIComponent(alertId)}/dismiss`, body)
}

/**
 * POST /pos/payments/:id/settle (or /check-split/payments/:id/settle) — take
 * one pending split portion. A Raast portion carries the bank reference and
 * the counter-device tick.
 */
export function settlePortion(
  paymentId: string,
  body: { shiftId: string; gatewayRef?: string; tenderedCents?: number; raastVerified?: true },
  route: 'pos' | 'check-split' = 'check-split',
): Promise<unknown> {
  const base = route === 'pos' ? '/pos/payments' : '/check-split/payments'
  return api.post(`${base}/${encodeURIComponent(paymentId)}/settle`, body)
}

/** Cashier copy for a Raast refusal, or null when the code is not a Raast one. */
export function raastErrorText(e: ApiError): string | null {
  const d = (e.details ?? {}) as { orderRef?: string; smsAmountCents?: number; dueCents?: number; min?: number; max?: number }
  switch (e.code) {
    case 'KEENU_QR_RETIRED':
      return 'Keenu QR is retired — take Raast QR or Card – Keenu. A payment made to the old Keenu QR is recorded as Card – Keenu.'
    case 'RAAST_REF_REQUIRED':
      return 'Type the bank reference (transaction ID) from the bank SMS or the merchant app on the counter phone.'
    case 'RAAST_REF_INVALID':
      return e.message || 'That bank reference doesn’t look right — type the transaction ID from the bank SMS or the merchant app.'
    case 'RAAST_REF_USED':
      return d.orderRef
        ? `That bank reference already paid bill #${d.orderRef}. One transfer can only pay one bill — check the counter phone for this customer’s transfer.`
        : (e.message || 'That bank reference already paid another bill. Check the counter phone for this customer’s transfer.')
    case 'RAAST_REF_DISMISSED':
      return e.message || 'That bank transfer was marked “not a sale” — it cannot pay a bill.'
    case 'RAAST_NOT_VERIFIED':
      return 'Tick that you saw the money arrive on the counter phone — never the customer’s screen.'
    case 'RAAST_AMOUNT_MISMATCH':
      return d.smsAmountCents != null
        ? `The bank SMS for that reference is ${fmtPkr(d.smsAmountCents)}, not this bill’s amount. Check the counter phone — the customer may have sent the wrong amount.`
        : (e.message || 'The bank transfer is not the amount of this bill. Check the counter phone.')
    case 'RAAST_NOT_SET_UP':
      return 'Raast is not set up for this brand — finance sets the receiving account in Finance → Bank accounts. Take cash or Card – Keenu.'
    case 'RAAST_AWAITING':
      return 'This bill is waiting for a Raast QR transfer — finish or cancel that first.'
    case 'RAAST_INTENT_GONE':
      return 'That Raast payment is no longer waiting (it was paid, cancelled or expired) — check the bill.'
    case 'RAAST_SMS_OFF':
      return 'Bank-SMS matching is off — check the counter phone and enter the bank reference.'
    case 'RAAST_SETTLING':
      return 'A bank SMS is completing this bill right now — wait a moment.'
    case 'RAAST_AFTER_COMPLETION':
      return e.message || 'This order is already completed — it cannot take a Raast payment now.'
    case 'RAAST_ACCOUNT_MISMATCH':
      return 'That transfer went to a different bank account than this brand’s Raast account — it cannot pay this bill.'
    case 'RAAST_SMS_ALREADY_USED':
    case 'RAAST_ALERT_NOT_OPEN':
    case 'RAAST_ALERT_TOO_OLD':
    case 'RAAST_NOT_FIXABLE':
    case 'NOT_A_RAAST_PORTION':
    case 'RAAST_ONE_PER_PAYMENT':
      return e.message || null
  }
  return null
}

// Bills this browser took a Raast payment on by hand in the last few minutes:
// the "a bank SMS completed a bill" toast skips them (the cashier is looking
// at that bill's own done screen).
const localRaast = new Map<string, number>()
const LOCAL_RAAST_MS = 5 * 60_000
export function noteLocalRaastPayment(orderId: string): void {
  localRaast.set(orderId, Date.now())
}
export function isLocalRaastPayment(orderId: string): boolean {
  const at = localRaast.get(orderId)
  if (at == null) return false
  if (Date.now() - at > LOCAL_RAAST_MS) { localRaast.delete(orderId); return false }
  return true
}

// ─── On account (corporate clients; backend pos/onAccountRoutes.ts) ─────────
//
// A named corporate client's bill, charged to its account with the client's
// card (a QR / code the cashier scans). The till offers it only when the
// order's company has an active client AND its till clearing is cut over
// (GET /pos/on-account/enabled) — off everywhere until finance switches it on.
//
//   GET  /pos/on-account/enabled?orderId          → { enabled }
//   POST /pos/on-account/lookup { orderId, code }  → the client, its credit, the bill, what would refuse it
//   GET  /pos/orders/:id/on-account/quote          → the bill at the CASH rate (an on-account bill's rate)
//   POST /pos/orders/:id/on-account { shiftId, code, reference?, idempotencyKey }
//                                                  → { payment, charge, orderCompleted, fiscal, srb, replayed }
//
// The card code is a bearer secret: it travels only in request BODIES, is
// never put in a URL, a query key, a log or an error, and the panel forgets it
// as soon as the charge is sent or the panel closes. No manager PIN: the card,
// the client's credit limit and the client's signature on the bill are the control.

/** The bill an on-account charge takes (quoteOrderForTender(…, 'on_account')). */
export interface OnAccountQuote {
  orderId: string
  status: string
  tender: 'cash' | 'card'
  repriced: boolean
  taxRatePct: number | null
  taxCents: number
  serviceChargeCents: number
  deliveryFeeCents?: number
  deliveryFeeTaxCents?: number
  discountCents: number
  tipCents: number
  totalCents: number
  paidCents: number
  dueCents: number
}

/** What would refuse the charge right now (the server's code, words and figures). */
export interface OnAccountBlock { code: string; message: string; details?: unknown }

/** POST /pos/on-account/lookup — the client the card names in the ORDER's company. */
export interface OnAccountLookup {
  account: {
    id: string
    number: string
    legalName: string
    limitCents: number
    exposureCents: number
    availableCents: number
    /** The client asks for a reference (PO number / who signed) on every bill. */
    requiresReference: boolean
  }
  card: { id: string; label: string; hint: string }
  quote: OnAccountQuote
  blocked: OnAccountBlock | null
}

export interface OnAccountChargeResult {
  payment: { id: string; amountCents: number; method: string; status: string; gatewayRef?: string | null }
  charge: { id: string } | null
  orderCompleted: boolean
  fiscal?: FiscalView | null
  replayed?: boolean
}

/** GET /pos/on-account/enabled — false on an API without on account (the tender stays hidden). */
export async function onAccountEnabled(orderId: string): Promise<boolean> {
  try {
    const r = await api.get<{ enabled: boolean }>(`/pos/on-account/enabled?orderId=${encodeURIComponent(orderId)}`)
    return r?.enabled === true
  } catch (e) {
    if (isMissingRoute(e)) return false
    throw e
  }
}

/** Whether to offer "On account" on this order. Any failure reads as "no" — the tender is never offered on a guess. */
export function useOnAccountEnabled(orderId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['pos', 'on-account-enabled', orderId],
    queryFn: () => onAccountEnabled(orderId!),
    enabled: !!orderId && enabled,
    staleTime: 30_000,
    retry: false,
    meta: { inlineErrors: true },
  })
}

/** POST /pos/on-account/lookup. The code goes in the body only. */
export function lookupOnAccount(orderId: string, code: string): Promise<OnAccountLookup> {
  return api.post<OnAccountLookup>('/pos/on-account/lookup', { orderId, code })
}

/** GET /pos/orders/:id/on-account/quote — the bill at the cash rate. */
export function onAccountQuote(orderId: string): Promise<OnAccountQuote> {
  return api.get<OnAccountQuote>(`/pos/orders/${encodeURIComponent(orderId)}/on-account/quote`)
}

/**
 * POST /pos/orders/:id/on-account — charge the whole bill to the client.
 * `idempotencyKey`: one per submission (newOnAccountKey), reused only by a
 * retry of that same submission. When the answer is lost (no response, or a
 * 5xx), OnAccountPanel keeps the key through the card rescan and re-sends it:
 * the server replays the charge it already made ({ replayed: true }) or makes
 * it once — a double tap or a lost answer never bills the client twice.
 */
export function chargeOnAccount(orderId: string, body: {
  shiftId: string
  code: string
  reference?: string | null
  idempotencyKey: string
}): Promise<OnAccountChargeResult> {
  const reference = body.reference?.trim()
  return api.post<OnAccountChargeResult>(`/pos/orders/${encodeURIComponent(orderId)}/on-account`, {
    shiftId: body.shiftId,
    code: body.code,
    ...(reference && { reference: reference.slice(0, 80) }),
    idempotencyKey: body.idempotencyKey,
  })
}

/** A fresh idempotency key for ONE on-account submission. */
export function newOnAccountKey(): string {
  return `oa-${newIdempotencyKey().replace(/^pos-/, '')}`
}

function centsOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Cashier copy for an on-account refusal (with the server's figures), or null when the code is not one. */
export function onAccountErrorText(e: { code?: string | null; message?: string; details?: unknown }): string | null {
  const d = (e.details ?? {}) as Record<string, unknown>
  switch (e.code) {
    case 'ON_ACCOUNT_CARD_UNKNOWN':
      return 'That card is not a client card of this company. Check the card, or take payment another way.'
    case 'ON_ACCOUNT_CARD_REVOKED':
      return 'That client card has been cancelled. Ask the client for their current card, or take payment another way.'
    case 'ON_ACCOUNT_NOT_HERE':
      return 'On account is for bills settled at the till (counter sales and dine-in). Delivery and pickup orders are paid another way.'
    case 'ON_ACCOUNT_WHOLE_BILL':
      return 'On account takes the whole bill in one go. It cannot take a part-paid, split or tipped bill, or one with a promo, wallet, gift card or loyalty credit on it.'
    case 'ON_ACCOUNT_RATE': {
      const rate = centsOf(d['taxRatePct']); const cash = centsOf(d['cashRatePct'])
      return rate != null && cash != null
        ? `This bill is priced at ${rate}% GST, not the ${cash}% cash rate an on-account bill takes. Take payment another way, or ask a manager.`
        : 'This bill could not be priced at the cash rate for an on-account charge. Take payment another way.'
    }
    case 'TILL_CLEARING_NOT_SPLIT':
      return 'On account is not switched on for this company yet (finance has to finish its set-up). Take payment another way.'
    case 'ON_ACCOUNT_NOT_ACTIVE':
      return 'This client account is not active. Take payment another way.'
    case 'ON_ACCOUNT_BRAND_NOT_ALLOWED':
      return 'This client may not be billed on account at this brand. Take payment another way.'
    case 'ON_ACCOUNT_OVERDUE': {
      const bal = centsOf(d['balanceCents'])
      const num = typeof d['statementNumber'] === 'string' ? d['statementNumber'] : null
      const due = typeof d['dueDate'] === 'string' ? new Date(d['dueDate']).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : null
      const parts = [num && `statement ${num}`, bal != null && `${fmtPkr(bal)} owed`, due && `due ${due}`].filter(Boolean)
      return `This client has an overdue bill${parts.length ? ` (${parts.join(', ')})` : ''}. Take payment another way until it is settled.`
    }
    case 'ON_ACCOUNT_OVER_LIMIT': {
      const bill = centsOf(d['billCents']); const avail = centsOf(d['availableCents']); const limit = centsOf(d['limitCents'])
      return bill != null && avail != null && limit != null
        ? `This bill of ${fmtPkr(bill)} would take the client over its credit limit: ${fmtPkr(avail)} is left of ${fmtPkr(limit)}. Take payment another way.`
        : 'This bill would take the client over its credit limit. Take payment another way.'
    }
    case 'ON_ACCOUNT_REFERENCE_REQUIRED':
      return 'This client needs a reference on every bill (a PO number or who signed). Type it, then charge again.'
    case 'ON_ACCOUNT_REFUND_INSTEAD':
      return 'This bill was charged to a client account. Refund it back to the client’s account instead of voiding a line.'
    case 'ON_ACCOUNT_NOT_PARKABLE':
      return 'An on-account bill is not money taken at the till. Refund it back to the client’s account.'
  }
  return null
}
