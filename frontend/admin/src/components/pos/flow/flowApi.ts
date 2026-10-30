'use client'
// The new till flow's server calls — contract: backend/src/modules/pos/TILL_FLOW.md.
// Money is the server's: nothing here computes tax (FOH-02).
//
//   GET  /floors/board                      the table board (§2)
//   GET  /pos/waiters, /pos/guests          Order information pickers (§3)
//   GET/PATCH /pos/orders/:id/info          waiter / pax / guest of an open ticket (§3)
//   GET  /pos/menu/search                   item name or code / SKU (§4)
//   POST /pos/quote                         cart totals (+ fulfilmentType, zoneId) (§4, §7)
//   POST /pos/orders                        Save: create the ticket and fire it (§3, §7)
//   PUT  /pos/orders/:id/settlement-channel close in servd (§6a)
//   POST /pos/orders/:id/keenu-push (+check) push to Keenu (§6b)
//   GET  /pos/delivery-zones                delivery zones (§7)
//
// Offline (owner, 2026-10-23): only Save of a NEW ticket is kept on the device and sent later
// (lib/offline-queue.ts). Every other write here — add items, settle / pay, Keenu push — is never
// queued: offline it throws "No internet — not sent" (NO_INTERNET_MESSAGE), never a fake success.

import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from '../../../lib/api'
import { usePosStore, type Fulfilment, type TillDelivery, type TillGuest, type TillWaiter } from '../../../store/pos'
import { newIdempotencyKey, tillErrorMessage, type FiscalView, type TillLine, type TillOrder, type OfflinePlaceholder, isOfflinePlaceholder, normaliseRungOrder } from '../tillApi'
import { postOrderOrQueue, requireOnline, summariseLines } from '../../../lib/offline-queue'

// ─── Table board ─────────────────────────────────────────────────────────────

export interface BoardOrder {
  id: string
  ref: string
  status: string
  totalCents: number
  placedAt: string
  partySize: number | null
  customerName: string | null
  waiter: { id: string; code: string; name: string } | null
}
export interface BoardTable {
  id: string
  label: string
  capacity: number
  floorId: string | null
  status: string
  occupied: boolean
  order: BoardOrder | null
  openOrders: number
  openOrderIds: string[]
}
export interface BoardFloor { id: string | null; name: string; displayOrder: number; totals: { tables: number; occupied: number; vacant: number } }
export interface Board {
  conceptId: string
  totals: { tables: number; occupied: number; vacant: number }
  floors: BoardFloor[]
  tables: BoardTable[]
}

export function useBoard(conceptId: string | null, floorId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['pos', 'board', conceptId, floorId],
    queryFn: () => api.get<Board>(`/floors/board?conceptId=${encodeURIComponent(conceptId!)}${floorId ? `&floorId=${encodeURIComponent(floorId)}` : ''}`),
    enabled: !!conceptId && enabled,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  })
}

// ─── Waiters, guests, item search, zones ────────────────────────────────────

export function fetchWaiters(conceptId: string, q: string): Promise<TillWaiter[]> {
  const qs = new URLSearchParams({ conceptId })
  if (q.trim()) qs.set('q', q.trim())
  return api.get<{ waiters: Array<{ id: string; code: string; name: string }> }>(`/pos/waiters?${qs}`).then((r) => r.waiters)
}
export function useWaiters(conceptId: string | null, q: string) {
  return useQuery({
    queryKey: ['pos', 'waiters', conceptId, q.trim()],
    queryFn: () => fetchWaiters(conceptId!, q),
    enabled: !!conceptId,
    staleTime: 60_000,
    retry: false,
    meta: { inlineErrors: true },
  })
}

export interface GuestHit { id: string; name: string; phone: string | null; altPhone: string | null; email: string | null }
export function fetchGuests(conceptId: string, q: string): Promise<GuestHit[]> {
  return api.get<{ guests: GuestHit[] }>(`/pos/guests?conceptId=${encodeURIComponent(conceptId)}&q=${encodeURIComponent(q.trim())}`).then((r) => r.guests)
}

export interface SearchItem { id: string; name: string; itemCode: string | null; priceCents: number; isAvailable: boolean; categoryId: string; categoryName: string }
export function searchMenu(conceptId: string, q: string, categoryId?: string | null): Promise<SearchItem[]> {
  const qs = new URLSearchParams({ conceptId, q: q.trim() })
  if (categoryId) qs.set('categoryId', categoryId)
  return api.get<{ items: SearchItem[] }>(`/pos/menu/search?${qs}`).then((r) => r.items)
}

export interface DeliveryZone { id: string; name: string; feeCents: number; freeAboveCents: number | null; minOrderCents: number | null; estimatedMinutes: number | null; conceptId: string }
export function useDeliveryZones(conceptId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['pos', 'delivery-zones', conceptId],
    queryFn: () => api.get<{ zones: DeliveryZone[] }>(`/pos/delivery-zones?conceptId=${encodeURIComponent(conceptId!)}`).then((r) => r.zones),
    enabled: !!conceptId && enabled,
    staleTime: 60_000,
    retry: false,
  })
}

// ─── Order information of a saved ticket ────────────────────────────────────

export interface OrderInfoView {
  orderId: string
  orderRef: string
  status: string
  fulfilmentType: string
  settlementChannel: string | null
  table: { id: string; label: string; floorId: string | null } | null
  partySize: number | null
  waiter: { id: string; code: string; name: string } | null
  guest: { id: string | null; name: string; mobile: string | null; phone: string | null; email: string | null; registrationNo: string | null } | null
  totalCents: number
  delivery: { cod: boolean; name: string; phone: string; address: string; notes: string | null; zoneId: string | null; zoneName: string | null; feeCents: number } | null
}
export function getOrderInfo(orderId: string): Promise<OrderInfoView> {
  return api.get<OrderInfoView>(`/pos/orders/${orderId}/info`)
}
export function patchOrderInfo(orderId: string, body: {
  waiterEmployeeId?: string | null
  waiterCode?: string
  partySize?: number | null
  customerId?: string | null
  guest?: GuestBody
  tableId?: string
  /** A till delivery: cash on delivery ⇄ pay now, while nothing is paid and it is not picked up. */
  delivery?: { cod: boolean }
}): Promise<OrderInfoView> {
  return api.patch<OrderInfoView>(`/pos/orders/${orderId}/info`, body)
}

export interface GuestBody { name: string; email?: string; mobile?: string; phone?: string; registrationNo?: string }

/** The typed guest as the server's `guest` object (empty fields left out). */
export function guestBody(g: TillGuest): GuestBody {
  return {
    name: g.name.trim(),
    ...(g.email.trim() && { email: g.email.trim() }),
    ...(g.mobile.trim() && { mobile: g.mobile.trim() }),
    ...(g.phone.trim() && { phone: g.phone.trim() }),
    ...(g.registrationNo.trim() && { registrationNo: g.registrationNo.trim() }),
  }
}

// ─── Cart quote (server figures only) ───────────────────────────────────────

export interface FlowCartQuote {
  itemTotalCents: number
  discountCents: number
  itemTaxCents?: number
  deliveryFeeCents?: number
  deliveryFeeTaxCents?: number
  taxCents: number
  serviceChargeCents: number
  totalCents: number
  taxRatePct: number
}
export function useFlowQuote(args: {
  conceptId: string | null
  lines: TillLine[]
  discountCents: number
  tender: 'cash' | 'card'
  fulfilment: Fulfilment
  zoneId: string | null
}) {
  const priced = args.lines.map((l) => ({
    menuItemId: l.menuItemId, name: l.name, quantity: l.quantity, unitPriceCents: l.unitPriceCents, modifiers: l.modifiers,
  }))
  const delivery = args.fulfilment === 'delivery'
  return useQuery({
    queryKey: ['pos', 'flow-quote', args.conceptId, args.tender, args.discountCents, args.fulfilment, delivery ? args.zoneId : null, priced],
    queryFn: () => api.post<FlowCartQuote>('/pos/quote', {
      conceptId: args.conceptId,
      items: priced,
      discountCents: args.discountCents,
      paymentMethod: args.tender,
      fulfilmentType: args.fulfilment,
      ...(delivery && args.zoneId && { zoneId: args.zoneId }),
    }),
    enabled: !!args.conceptId && args.lines.length > 0,
    staleTime: 15_000,
    retry: false,
    meta: { inlineErrors: true },
  })
}

/** The cart's server totals: cash and card / Raast (one digital tax group). Never computed here. */
export function useCartTotals(conceptId: string | null) {
  const cart = usePosStore((s) => s.cart)
  const lines = usePosStore((s) => s.lines)
  const discountCents = usePosStore((s) => s.discountCents)
  const fulfilment = usePosStore((s) => s.fulfilment)
  const zoneId = usePosStore((s) => s.delivery?.zoneId ?? null)
  const cartLines = cart.length > 0 ? lines() : []
  const cash = useFlowQuote({ conceptId, lines: cartLines, discountCents, tender: 'cash', fulfilment, zoneId })
  const card = useFlowQuote({ conceptId, lines: cartLines, discountCents, tender: 'card', fulfilment, zoneId })
  return { cash, card }
}

// ─── Save (create the ticket and fire it) ───────────────────────────────────

export interface SaveBody {
  conceptId: string
  idempotencyKey: string
  shiftId: string | null
  tableId: string | null
  fulfilment: Fulfilment
  waiter: TillWaiter | null
  partySize: number | null
  guest: TillGuest | null
  customerId: string | null
  delivery: TillDelivery | null
  discountCents: number
  discountReason: string
  discountPin: string
  items: TillLine[]
  /** For the offline queue's list only (brand, the server's last total). Never sent. */
  brandName?: string | null
  totalCents?: number | null
}

/** A TillOrder from POST /pos/orders with the new columns. */
export type SavedOrder = TillOrder & { settlementChannel?: string | null; waiterEmployeeId?: string | null; partySize?: number | null }

/**
 * Save. Offline, a NEW ticket is kept on this device and sent later with the same idempotency key
 * (lib/offline-queue.ts) — the answer is then a placeholder, never an order. Not one with a manager PIN.
 */
export function saveTicket(b: SaveBody): Promise<SavedOrder | OfflinePlaceholder> {
  const delivery = b.fulfilment === 'delivery' && b.delivery
  const body = {
    conceptId: b.conceptId,
    idempotencyKey: b.idempotencyKey,
    ...(b.shiftId && { shiftId: b.shiftId }),
    ...(b.tableId && b.fulfilment === 'dine_in' && { tableId: b.tableId }),
    fulfilmentType: b.fulfilment,
    // waiterCode OR waiterEmployeeId, never both (400 WAITER_ONE_OF).
    ...(b.waiter && (b.waiter.id ? { waiterEmployeeId: b.waiter.id } : { waiterCode: b.waiter.code })),
    ...(b.partySize != null && { partySize: b.partySize }),
    // A picked customer, OR the typed guest (400 GUEST_ONE_OF).
    ...(b.customerId ? { customerId: b.customerId } : b.guest && b.guest.name.trim() ? { guest: guestBody(b.guest) } : {}),
    ...(delivery && {
      delivery: {
        name: delivery.name.trim(),
        phone: delivery.phone.trim(),
        address: delivery.address.trim(),
        ...(delivery.notes.trim() && { notes: delivery.notes.trim() }),
        ...(delivery.zoneId && { zoneId: delivery.zoneId }),
        cod: delivery.cod,
      },
    }),
    discountCents: b.discountCents,
    ...(b.discountReason && { discountReason: b.discountReason }),
    ...(b.discountPin && { managerOverridePin: b.discountPin }),
    items: b.items,
  }
  const label = b.fulfilment === 'dine_in' ? 'Dine in' : b.fulfilment === 'delivery' ? `Delivery${delivery ? ` — ${delivery.name.trim()}` : ''}` : 'Takeaway'
  const summary = summariseLines(b.items, { brandName: b.brandName ?? null, label, discountCents: b.discountCents, totalCents: b.totalCents ?? null })
  return postOrderOrQueue<SavedOrder>(body, summary).then((r) => normaliseRungOrder(r) as SavedOrder | OfflinePlaceholder)
}
export { isOfflinePlaceholder, newIdempotencyKey }

/**
 * More items on a ticket already sent (owner, 2026-10-22): POST /pos/orders/:id/items — the SAME ticket, the new
 * lines fire to the kitchen. 409 BILL_IN_PAYMENT once money is on the bill (ring them up on a new ticket instead).
 */
export function addItemsToTicket(orderId: string, b: { items: TillLine[]; idempotencyKey: string; managerOverridePin?: string }): Promise<SavedOrder> {
  requireOnline()
  return api.post<SavedOrder>(`/pos/orders/${orderId}/items`, {
    items: b.items, idempotencyKey: b.idempotencyKey, ...(b.managerOverridePin && { managerOverridePin: b.managerOverridePin }),
  }).then((r) => normaliseRungOrder(r) as SavedOrder)
}

// ─── Settle ─────────────────────────────────────────────────────────────────

export function setServdChannel(orderId: string): Promise<{ orderId: string; settlementChannel: string }> {
  requireOnline()
  return api.put<{ orderId: string; settlementChannel: string }>(`/pos/orders/${orderId}/settlement-channel`, { channel: 'servd' })
}

/** POST /pos/payments, closed in servd (TILL_FLOW §6a). Cash may keep the excess as a tip. */
export function payServd(body: {
  orderId: string
  shiftId: string
  idempotencyKey: string
  method: 'cash' | 'card' | 'raast'
  amountCents: number
  tenderedCents?: number
  excessAsTip?: boolean
  tipCents?: number
  gatewayRef?: string
  manualReason?: 'terminal_offline'
}): Promise<{ payments: Array<{ id: string; changeCents: number | null }>; orderCompleted: boolean; fiscal?: FiscalView | null }> {
  requireOnline()
  const { orderId, shiftId, idempotencyKey, ...p } = body
  return api.post('/pos/payments', { orderId, shiftId, idempotencyKey, settlementChannel: 'servd', payments: [p] })
}

/** One tender of a split (TILL_FLOW §6a: several tenders in ONE call). */
export interface SplitTender {
  method: 'cash' | 'card' | 'raast'
  amountCents: number
  tenderedCents?: number
  gatewayRef?: string
  raastVerified?: true
}
export function paySplitServd(body: { orderId: string; shiftId: string; idempotencyKey: string; payments: SplitTender[] }): Promise<{ payments: Array<{ id: string; changeCents: number | null }>; orderCompleted: boolean; fiscal?: FiscalView | null }> {
  requireOnline()
  return api.post('/pos/payments', { ...body, settlementChannel: 'servd' })
}

/** GET /pos/shifts/current/summary — the caller's own drawer, cashier-safe (no expected cash). */
export interface ShiftSummary {
  shiftId: string; openedAt: string; ordersCount: number; grossCents: number; salesExTipsCents: number; taxCents: number; tipsCents: number
  serviceChargeCents: number; discountCents: number; compCents: number; refundsCents: number
  byTender: { cashCents: number; cardCents: number; raastCents: number; onAccountCents: number; walletCents: number; giftCardCents: number }
  bySettlement: Record<'keenu' | 'servd' | 'none', { orders: number; amountCents: number }>
  openTickets?: { count: number; totalCents: number; dueCents: number }
}
export function fetchShiftSummary(): Promise<{ shift: ShiftSummary | null }> {
  return api.get('/pos/shifts/current/summary')
}

export type KeenuState = 'pending' | 'settled' | 'declined' | 'failed' | 'needs_attention'
export interface KeenuPushView {
  pushId: string
  state: KeenuState
  method: string
  amountCents: number
  tipCents: number
  at: string
  approvalRef: string | null
  reason: string | null
}
export interface KeenuSettled {
  state: 'settled'
  pushId: string
  providerRef?: string | null
  approvalRef?: string | null
  orderCompleted: boolean
  fiscal?: FiscalView | null
  replayed?: boolean
}
export interface KeenuPending { state: 'pending'; pushId: string }
export type KeenuAnswer = KeenuSettled | KeenuPending

/** 201 settled, 202 pending — both come back as the parsed body. */
export function pushToKeenu(orderId: string, body: { shiftId: string; method: 'cash' | 'card'; tipCents?: number }): Promise<KeenuAnswer> {
  requireOnline()
  return api.post<KeenuAnswer>(`/pos/orders/${orderId}/keenu-push`, body)
}
export function checkKeenuPush(orderId: string): Promise<KeenuAnswer> {
  requireOnline()
  return api.post<KeenuAnswer>(`/pos/orders/${orderId}/keenu-push/check`, {})
}
/** pushAvailable: the company's fiscal connector can take a pushed bill (false under SRB direct — servd files itself). */
export type KeenuPushState = { settlementChannel: string | null; pushAvailable?: boolean; push: KeenuPushView | null }
export function getKeenuPush(orderId: string): Promise<KeenuPushState> {
  return api.get<KeenuPushState>(`/pos/orders/${orderId}/keenu-push`)
}

/** One-line explanation for the Keenu / channel codes the contract lists (the server's own message stays the fallback). */
export function flowErrorMessage(e: unknown, fallback?: string): string {
  if (e instanceof ApiError) {
    // The server writes these for staff — shown verbatim.
    if (e.message) return e.message
  }
  return tillErrorMessage(e, fallback)
}
