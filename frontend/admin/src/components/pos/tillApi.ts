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

import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'

export type TillTender = 'cash' | 'card' | 'keenu_qr'
export const TILL_TENDERS: readonly TillTender[] = ['cash', 'card', 'keenu_qr']
export function isTillTender(m: string): m is TillTender {
  return (TILL_TENDERS as readonly string[]).includes(m)
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
  placedAt: string
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
  const rate = method === 'cash' ? brand?.taxRateCash : brand?.taxRateCard
  if (rate != null && rate === order.taxRatePct) {
    return { kind: 'stored', quote: { ...stored, tender: method === 'cash' ? 'cash' : 'card' } }
  }
  return {
    kind: 'unavailable',
    message: method === 'cash'
      ? 'This bill was priced for card. The server cannot quote the cash total yet, so take it by card or ask a manager.'
      : 'This bill was priced for cash. The server cannot quote the card total yet, so take cash, or ring the sale with Card selected.',
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
}) {
  const { orderId, shiftId, idempotencyKey, ...p } = body
  return api.post<TillPaymentResult>('/pos/payments', { orderId, shiftId, idempotencyKey, payments: [p] })
}

/** POST /pos/payments (and the comp) answer. `fiscal` is the sale's fiscal document once the API files through the POS connector. */
export interface TillPaymentResult {
  payments: Array<{ id: string; changeCents: number | null }>
  orderCompleted: boolean
  fiscal?: FiscalView | null
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
  /** Card / cash tips inside the takings — staff money (2095), not sales. */
  tipsCents?: number
  /** Takings (cash + card) less tips. */
  salesExTipsCents?: number
  /** What gift cards paid of the bills this drawer books. */
  giftCardCents?: number
  /** Money taken on tickets later cancelled, not yet handed back. */
  refundDueCents?: number
  cancelledPaid?: { count: number; cashCents: number; cardCents: number }
  openTickets?: DrawerOpenTickets
  unassignedOpenTickets?: { count: number; totalCents: number }
  /** Takings less refunds (getZReport's netCents / netRevenue). */
  netCents?: number
  netRevenue?: number
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
    { label: 'Card takings', value: fmt(r.cardSales), tone: 'text' },
    { label: 'Wallet', value: fmt(r.walletSales), tone: 'text' },
  ]
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
  const cancelledCents = (cancelled?.cashCents ?? 0) + (cancelled?.cardCents ?? 0)
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
