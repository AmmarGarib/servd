// Station board, Start, cook timers, expo backlog (owner B12, 2026-10-26).
//
// "Kitchen staff gets orders on the tablet. Their screen should probs show
// them 4-6 orders at a time … key in to order button to get quick popup of
// instructions or complete order from memory and press tick … start timer …
// multiple timers … Timer going off should just make the order card blink
// red.. no noise … station 1 ticking of their tablet makes it go to station
// 2 … expo need screen needs to show a counter with how many tickets are
// backed up … if an order card is sitting on screen for 1 minute without
// being started, expo needs an alert."
//
// This EXTENDS the one KDS (never a second one):
//   • loadStationQueue — THE station queue (GET /expo/station/:id/queue reads
//     it unchanged; the board below groups the same rows).
//   • A CARD is one order's live work at one station: its fired steps
//     (status preparing) and its legacy lines (no recipe steps: pending /
//     preparing / held / recalled). Cards are oldest first (earliest fire,
//     else placed); the first `Station.visibleCards` (4–6, default 5) are
//     VISIBLE, the rest QUEUED (not shown to the cook).
//   • kdsShownAt is stamped (once) on a card's rows the first time a read
//     finds it in the visible window; the expo's alert = a visible card not
//     started (no startedAt, no timer) for UNSTARTED_ALERT_MS (60 s) since it
//     showed. A card whose every row is held is paused work — never alerted.
//   • Start stamps startedAt on the card's rows; a cook timer starts it too.
//   • "Done" (the tick) bumps every row of the card at that station through
//     the existing writers — steps through completeStepBump (the cascade:
//     the next station's step fires), lines through updateItemStatus.
//   • KitchenTimer: started at + duration, server-side; several per card and
//     per station; ends → the screen blinks the card red. No sound anywhere.
//   • Backlog (expo): tickets = orders with a queued card at some station
//     and NO visible card at any station ("not on some kitchen guy's screen
//     yet"); queuedCards = every queued card, per station.
// Company separation: a station is resolved inside the caller's company
// scope (foreign → 404); a timer's company is the ORDER's.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ItemStatus, Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { emitItemUpdated } from '../../lib/ws.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { orderChannelOf } from '../../lib/orderChannel.js'
import { requireModule } from '../notifications/requireModule.js'
import { STATION_REQUESTERS } from '../stations/changeRequests.js'
import { SERVICE_PHASES } from './fire.js'

/** Orders that ended without food going out — nothing of theirs belongs on a station screen. */
const ENDED_NO_SALE: Array<'cancelled' | 'rejected' | 'refunded'> = ['cancelled', 'rejected', 'refunded']
export const DEFAULT_VISIBLE_CARDS = 5
export const MIN_VISIBLE_CARDS = 4
export const MAX_VISIBLE_CARDS = 6
/** A visible card not started for this long raises the expo's (silent) alert. */
export const UNSTARTED_ALERT_MS = 60_000
/** Cook timer bounds (also a DB CHECK). */
export const MAX_TIMER_SECONDS = 4 * 3600

type TenantFilter = Prisma.ConceptWhereInput['tenantId']

const orderSelect = {
  id: true, customerName: true, source: true, placedAt: true, rawPayload: true,
  fulfilmentType: true,
  concept: { select: { name: true, slug: true } },
  customer: { select: { name: true } },
  table:    { select: { label: true } },
} as const

// ─── THE station queue ────────────────────────────────────────────────────────

/**
 * The two lists a station screen works from (moved here unchanged from GET
 * /expo/station/:id/queue): fired / waiting recipe steps routed to the
 * station, and legacy lines (no recipe steps) on it. `statesAll` = the admin
 * KDS, which shows HELD lines (with Resume); other screens leave them out.
 */
export async function loadStationQueue(stationId: string, tenantId: TenantFilter, statesAll: boolean) {
  // A held pre-order's lines are not on the station yet (O-RV-3).
  const { PRE_ORDER_PREP_MS } = await import('../orders/service.js')
  const kitchenDue = [{ scheduledFor: null }, { scheduledFor: { lte: new Date(Date.now() + PRE_ORDER_PREP_MS) } }]
  const legacyStates: ItemStatus[] = statesAll
    ? ['pending', 'preparing', 'held', 'recalled']
    : ['pending', 'preparing', 'recalled']

  const steps = await prisma.orderItemStep.findMany({
    where: {
      stationId,
      status: { in: ['preparing', 'waiting'] },        // surface waiting too so the cook can see what's coming
      orderItem: {
        order: { concept: { tenantId }, status: { notIn: ENDED_NO_SALE } },
        // A held dish's steps are paused work too — off a screen that
        // didn't ask for held lines (see legacyStates).
        ...(!statesAll && { status: { not: 'held' as const } }),
      },
    },
    include: {
      recipeStep: { select: { instruction: true, instructionUrdu: true, phase: true, estimatedSeconds: true } },
      orderItem:  {
        include: {
          order: { select: orderSelect },
          modifiers: { select: { name: true } },
        },
      },
    },
    orderBy: { firedAt: 'asc' },
  })

  const legacy = await prisma.orderItem.findMany({
    where: {
      stationId,
      // Held and recalled lines stay on the cook's screen, with their
      // state (BOH-04): a hold is paused work, a recall is a remake. They
      // used to drop off the screen the moment they changed state.
      status: { in: legacyStates },
      // Not on an order that ended without a sale (R8): its leftover
      // lines used to sit on the station until someone bumped them.
      order: { concept: { tenantId }, status: { notIn: ENDED_NO_SALE } },
      AND: [
        {
          OR: [
            // Skip items that already have OrderItemStep rows — those are
            // routed through the step engine, no double-counting...
            { steps: { none: {} } },
            // ...except a recalled one: its steps are done, the remake is
            // the whole dish, back on the station it is routed to.
            { status: 'recalled' },
          ],
        },
        {
          // A step-routed dish not fired yet has no steps — it is not a
          // legacy line: firing lays its steps out on their stations
          // (R5). Shown here it could be bumped pending → bumped, the
          // fire then skipped it and no station ever cooked it.
          OR: [
            { status: { not: 'pending' } },
            { menuItemId: null },
            { menuItem: { is: { recipe: { is: null } } } },
            { menuItem: { is: { recipe: { is: { recipeSteps: { none: { phase: { in: [...SERVICE_PHASES] } } } } } } } },
          ],
        },
        // A pending line of a pre-order before its prep window is not
        // this station's work yet; once fired it shows like any other.
        { OR: [{ status: { not: 'pending' } }, { order: { OR: kitchenDue } }] },
      ],
    },
    include: {
      order: { select: orderSelect },
      modifiers: { select: { name: true } },
    },
    orderBy: { firedAt: 'asc' },
  })
  return { steps, legacy }
}

// ─── Cards (pure) ─────────────────────────────────────────────────────────────

export interface BoardEntry {
  kind: 'step' | 'line'
  /** OrderItemStep id (step) or OrderItem id (line). */
  id: string
  itemId: string
  menuItemId: string | null
  itemName: string
  qty: number
  notes: string | null
  modifiers: string[]
  /** step: preparing; line: pending / preparing / held / recalled. */
  status: string
  firedAt: Date | null
  startedAt: Date | null
  shownAt: Date | null
  instruction: string | null
  instructionUrdu: string | null
  estimatedSeconds: number | null
  phase: string | null
}

export interface BoardOrder {
  id: string
  ref: string
  brand: string
  channel: string
  fulfilmentType: string
  tableLabel: string | null
  customerName: string | null
  placedAt: Date
}

export interface BoardCard {
  order: BoardOrder
  entries: BoardEntry[]
  /** Earliest fire of its rows (else the order's placed time) — the queue order. */
  firedAt: Date
  /** When it first showed in the visible window (null = never shown / queued). */
  shownAt: Date | null
  started: boolean
  /** Every row is on hold — paused work, never alerted. */
  held: boolean
}

/** Group a station's active rows into order cards, oldest first. */
export function groupCards(rows: Array<{ order: BoardOrder; entry: BoardEntry }>): BoardCard[] {
  const byOrder = new Map<string, BoardCard>()
  for (const { order, entry } of rows) {
    let c = byOrder.get(order.id)
    if (!c) {
      c = { order, entries: [], firedAt: entry.firedAt ?? order.placedAt, shownAt: null, started: false, held: true }
      byOrder.set(order.id, c)
    }
    c.entries.push(entry)
    const at = entry.firedAt ?? order.placedAt
    if (at.getTime() < c.firedAt.getTime()) c.firedAt = at
  }
  const cards = [...byOrder.values()]
  for (const c of cards) refreshCard(c)
  return cards.sort((a, b) => a.firedAt.getTime() - b.firedAt.getTime() || a.order.id.localeCompare(b.order.id))
}

/** Recompute a card's derived flags from its rows. */
export function refreshCard(c: BoardCard, startedByTimer = false): void {
  const shown = c.entries.map((e) => e.shownAt).filter((d): d is Date => !!d)
  c.shownAt = shown.length ? new Date(Math.min(...shown.map((d) => d.getTime()))) : null
  c.started = startedByTimer || c.entries.some((e) => e.startedAt != null)
  c.held = c.entries.every((e) => e.status === 'held')
}

/** Split cards into the visible window and the queue behind it. */
export function splitWindow<T>(cards: T[], visibleCards: number): { visible: T[]; queued: T[] } {
  const n = Math.min(MAX_VISIBLE_CARDS, Math.max(MIN_VISIBLE_CARDS, visibleCards || DEFAULT_VISIBLE_CARDS))
  return { visible: cards.slice(0, n), queued: cards.slice(n) }
}

/** Visible cards not started for UNSTARTED_ALERT_MS since they showed (never a held card). */
export function unstartedCards(visible: BoardCard[], now: Date = new Date()): BoardCard[] {
  return visible.filter((c) => !c.started && !c.held && c.shownAt != null && now.getTime() - c.shownAt.getTime() >= UNSTARTED_ALERT_MS)
}

/**
 * The expo's backlog across stations: `tickets` = orders with a queued card
 * somewhere and no visible card anywhere; `queuedCards` = all queued cards.
 */
export function backlogOf(boards: Array<{ visible: Array<{ order: { id: string } }>; queued: Array<{ order: { id: string } }> }>): { tickets: number; queuedCards: number; orderIds: string[] } {
  const visibleIds = new Set(boards.flatMap((b) => b.visible.map((c) => c.order.id)))
  const queuedIds = new Set(boards.flatMap((b) => b.queued.map((c) => c.order.id)))
  const orderIds = [...queuedIds].filter((id) => !visibleIds.has(id))
  return { tickets: orderIds.length, queuedCards: boards.reduce((n, b) => n + b.queued.length, 0), orderIds }
}

// ─── Board (DB) ───────────────────────────────────────────────────────────────

type QueueRows = Awaited<ReturnType<typeof loadStationQueue>>

function boardOrder(o: QueueRows['legacy'][number]['order']): BoardOrder {
  return {
    id: o.id,
    ref: orderRefOf(o.id),
    brand: o.concept.name,
    channel: orderChannelOf(o),
    fulfilmentType: o.fulfilmentType,
    tableLabel: o.table?.label ?? null,
    customerName: o.customer?.name ?? o.customerName,
    placedAt: o.placedAt,
  }
}

/** The active rows of a station as card rows (fired steps + legacy lines). Waiting steps are "on deck". */
export function cardRows(q: QueueRows) {
  const rows: Array<{ order: BoardOrder; entry: BoardEntry }> = []
  for (const s of q.steps) {
    if (s.status !== 'preparing' || s.orderItem.status === 'voided') continue
    rows.push({
      order: boardOrder(s.orderItem.order),
      entry: {
        kind: 'step', id: s.id, itemId: s.orderItemId, menuItemId: s.orderItem.menuItemId,
        itemName: s.orderItem.name, qty: s.orderItem.quantity, notes: s.orderItem.notes,
        modifiers: s.orderItem.modifiers.map((m) => m.name),
        status: s.orderItem.status === 'held' ? 'held' : 'preparing',
        firedAt: s.firedAt, startedAt: s.startedAt, shownAt: s.kdsShownAt,
        instruction: s.recipeStep.instruction, instructionUrdu: s.recipeStep.instructionUrdu,
        estimatedSeconds: s.recipeStep.estimatedSeconds, phase: s.recipeStep.phase,
      },
    })
  }
  for (const it of q.legacy) {
    rows.push({
      order: boardOrder(it.order),
      entry: {
        kind: 'line', id: it.id, itemId: it.id, menuItemId: it.menuItemId,
        itemName: it.name, qty: it.quantity, notes: it.notes,
        modifiers: it.modifiers.map((m) => m.name),
        status: it.status,
        firedAt: it.firedAt, startedAt: it.startedAt, shownAt: it.kdsShownAt,
        instruction: null, instructionUrdu: null, estimatedSeconds: null, phase: null,
      },
    })
  }
  const onDeck = q.steps.filter((s) => s.status === 'waiting' && s.orderItem.status !== 'voided').map((s) => ({
    stepId: s.id, itemId: s.orderItemId, itemName: s.orderItem.name, qty: s.orderItem.quantity,
    instruction: s.recipeStep.instruction, instructionUrdu: s.recipeStep.instructionUrdu,
    order: boardOrder(s.orderItem.order),
  }))
  return { rows, onDeck }
}

interface StationRef { id: string; name: string; visibleCards: number; conceptId: string; concept: { name: string; tenantId: string | null } }

async function ownedStation(req: FastifyRequest, stationId: string, mode: ScopeMode): Promise<StationRef> {
  const station = await prisma.station.findFirst({
    where: { id: stationId, deletedAt: null, concept: { deletedAt: null, ...(await scopeTenantWhere(req, mode)) } },
    select: { id: true, name: true, visibleCards: true, conceptId: true, concept: { select: { name: true, tenantId: true } } },
  })
  if (!station) throw new NotFoundError('Station', stationId)
  return station
}

/**
 * One station's board: visible cards (stamped kdsShownAt on first show),
 * the queued ones, the on-deck steps and the live timers. The station's own
 * company is the scope of everything on it.
 */
export async function buildStationBoard(station: StationRef, now: Date = new Date()) {
  const tenantId = station.concept.tenantId
  if (!tenantId) return { station, visible: [] as BoardCard[], queued: [] as BoardCard[], onDeck: [], timers: [] as TimerRow[] }
  const q = await loadStationQueue(station.id, tenantId, true)
  const { rows, onDeck } = cardRows(q)
  const cards = groupCards(rows)
  const { visible, queued } = splitWindow(cards, station.visibleCards)

  // First show: stamp kdsShownAt once (conditional — two readers never move it).
  const stepIds = visible.flatMap((c) => c.entries.filter((e) => e.kind === 'step' && !e.shownAt).map((e) => e.id))
  const lineIds = visible.flatMap((c) => c.entries.filter((e) => e.kind === 'line' && !e.shownAt).map((e) => e.id))
  if (stepIds.length) await prisma.orderItemStep.updateMany({ where: { id: { in: stepIds }, kdsShownAt: null }, data: { kdsShownAt: now } })
  if (lineIds.length) await prisma.orderItem.updateMany({ where: { id: { in: lineIds }, kdsShownAt: null }, data: { kdsShownAt: now } })
  for (const c of visible) for (const e of c.entries) if (!e.shownAt) e.shownAt = now

  const timers = await liveTimersOf(station.id, tenantId, cards)
  const timedOrders = new Set(timers.map((t) => t.orderId))
  for (const c of cards) refreshCard(c, timedOrders.has(c.order.id))
  return { station, visible, queued, onDeck, timers }
}

type TimerRow = Awaited<ReturnType<typeof liveTimersOf>>[number]

/** Running (not stopped) timers on the station's live cards. */
async function liveTimersOf(stationId: string, tenantId: string, cards: BoardCard[]) {
  const itemIds = cards.flatMap((c) => c.entries.map((e) => e.itemId))
  if (itemIds.length === 0) return []
  return prisma.kitchenTimer.findMany({
    where: { tenantId, stationId, stoppedAt: null, orderItemId: { in: itemIds } },
    select: { id: true, orderId: true, orderItemId: true, orderItemStepId: true, label: true, durationSeconds: true, startedAt: true, endsAt: true },
    orderBy: { startedAt: 'asc' },
  })
}

function cardJson(c: BoardCard, now: Date) {
  return {
    order: c.order,
    firedAt: c.firedAt,
    shownAt: c.shownAt,
    started: c.started,
    held: c.held,
    /** Visible and not started for 60 s+ (the expo's alert). */
    unstarted: !c.started && !c.held && c.shownAt != null && now.getTime() - c.shownAt.getTime() >= UNSTARTED_ALERT_MS,
    entries: c.entries,
  }
}

// ─── Card actions ─────────────────────────────────────────────────────────────

/** A card's active rows at one station, inside the station's company. */
async function cardRowsOf(station: StationRef, orderId: string) {
  if (!station.concept.tenantId) throw new NotFoundError('Order', orderId)
  const q = await loadStationQueue(station.id, station.concept.tenantId, true)
  const { rows } = cardRows(q)
  const mine = rows.filter((r) => r.order.id === orderId).map((r) => r.entry)
  if (mine.length === 0) throw new NotFoundError('Order', orderId)
  return mine
}

const timerCreateSchema = z.object({
  stationId: z.string().uuid(),
  /** The OrderItemStep (a step row) or the OrderItem (a line with no steps). */
  entryId: z.string().uuid(),
  durationSeconds: z.number().int().min(1).max(MAX_TIMER_SECONDS),
  label: z.string().trim().max(80).optional(),
})
const timerAdjustSchema = z.object({ addSeconds: z.number().int().min(-3600).max(3600).refine((n) => n !== 0) })
const displaySchema = z.object({ visibleCards: z.number().int().min(MIN_VISIBLE_CARDS).max(MAX_VISIBLE_CARDS) })

/** Label (sticker) size for the expo's sticker printer, per company. */
export const LABEL_PRESETS = [
  { key: '58x40', widthMm: 58, heightMm: 40, name: '58 × 40 mm' },
  { key: '50x30', widthMm: 50, heightMm: 30, name: '50 × 30 mm' },
  { key: '4x3in', widthMm: 102, heightMm: 76, name: '4 × 3 in' },
  { key: '80mm', widthMm: 80, heightMm: 60, name: '80 × 60 mm' },
] as const
const labelSchema = z.object({ widthMm: z.number().int().min(25).max(110), heightMm: z.number().int().min(15).max(150) })
const labelKey = (tenantId: string) => `kds.labelSize:${tenantId}`
export async function labelSizeOf(tenantId: string | null): Promise<{ widthMm: number; heightMm: number }> {
  if (tenantId) {
    const row = await prisma.setting.findUnique({ where: { key: labelKey(tenantId) } })
    if (row) {
      try {
        const v = labelSchema.safeParse(JSON.parse(row.value))
        if (v.success) return v.data
      } catch { /* fall through to the default */ }
    }
  }
  return { widthMm: 58, heightMm: 40 }
}
/** Who sets the sticker size: the manager tiers and the expediter. */
const LABEL_EDITORS: UserRole[] = [...MANAGERS, 'expediter']

// ─── Printing (sticker / ticket) ──────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
const CHANNEL_LABEL: Record<string, string> = { pos: 'Till', servd: 'Online', whatsapp: 'WhatsApp', manual: 'Phone', reservation: 'Booking' }
const FULFIL_LABEL: Record<string, string> = { dine_in: 'Dine-in', takeout: 'Takeaway', delivery: 'Delivery' }
const karachiTime = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
const karachiDate = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', day: '2-digit', month: 'short' }).format(d)

export interface PrintOrder {
  id: string
  brand: string
  channel: string
  fulfilmentType: string
  customerName: string | null
  tableLabel: string | null
  placedAt: Date
  items: Array<{ name: string; quantity: number; notes: string | null; modifiers: string[] }>
}

/**
 * The sticker labels (one page per bag, "Bag i of N") at the company's label
 * size, and the kitchen ticket (an 80 mm slip — NOT a bill: no money).
 * Black on white: it is paper, not a screen.
 */
export function renderPrint(o: PrintOrder, kind: 'sticker' | 'ticket', bags: number, size: { widthMm: number; heightMm: number }): string {
  const who = [o.tableLabel ? `Table ${o.tableLabel}` : null, o.customerName].filter(Boolean).join(' · ')
  const head = `${esc(CHANNEL_LABEL[o.channel] ?? o.channel)} · ${esc(FULFIL_LABEL[o.fulfilmentType] ?? o.fulfilmentType)}`
  const time = `${karachiDate(o.placedAt)} ${karachiTime(o.placedAt)}`
  const itemsHtml = o.items.map((i) => `<li><b>${i.quantity}×</b> ${esc(i.name)}${i.modifiers.length ? `<div class="m">${i.modifiers.map(esc).join(', ')}</div>` : ''}${i.notes ? `<div class="m">Note: ${esc(i.notes)}</div>` : ''}</li>`).join('')
  const ref = esc(orderRefOf(o.id))
  if (kind === 'ticket') {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Ticket ${ref}</title><style>
@page{size:80mm auto;margin:3mm}body{font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff;margin:0;font-size:12px}
h1{font-size:15px;margin:0}.ref{font-size:22px;font-weight:900;letter-spacing:1px;margin:4px 0}.s{font-size:11px}
ul{list-style:none;padding:0;margin:6px 0;border-top:1px dashed #000;border-bottom:1px dashed #000}li{padding:3px 0}.m{font-size:10px;margin-left:14px}
.foot{font-size:10px;text-align:center;margin-top:6px}</style></head><body>
<h1>${esc(o.brand)}</h1><div class="ref">#${ref}</div><div class="s">${head}</div>${who ? `<div class="s">${esc(who)}</div>` : ''}<div class="s">${esc(time)}</div>
<ul>${itemsHtml}</ul><div class="foot">Kitchen ticket — not a bill</div></body></html>`
  }
  const n = Math.max(1, Math.min(20, bags))
  const pages: string[] = []
  for (let i = 1; i <= n; i += 1) {
    pages.push(`<section class="l"><div class="top"><span class="b">${esc(o.brand)}</span><span class="bag">Bag ${i} of ${n}</span></div>
<div class="ref">#${ref}</div><div class="s">${head} · ${esc(time)}</div>${who ? `<div class="s w">${esc(who)}</div>` : ''}<ul>${itemsHtml}</ul></section>`)
  }
  const w = size.widthMm, h = size.heightMm
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sticker ${ref}</title><style>
@page{size:${w}mm ${h}mm;margin:0}html,body{margin:0;padding:0;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif}
.l{width:${w}mm;height:${h}mm;box-sizing:border-box;padding:1.5mm 2mm;overflow:hidden;page-break-after:always;break-after:page}
.l:last-child{page-break-after:auto;break-after:auto}.top{display:flex;justify-content:space-between;font-size:9px;font-weight:700}
.bag{border:1px solid #000;padding:0 3px}.ref{font-size:${Math.max(14, Math.min(26, Math.round(h / 2.2)))}px;font-weight:900;letter-spacing:1px;line-height:1.1}
.s{font-size:8px}.w{font-weight:700}ul{list-style:none;padding:0;margin:1mm 0 0;font-size:8px;line-height:1.15}.m{font-size:7px;margin-left:8px}
</style></head><body>${pages.join('')}</body></html>`
}

// ─── Routes (registered under /expo by expoRoutes) ────────────────────────────

export async function kitchenBoardRoutes(fastify: FastifyInstance) {
  // GET /expo/station/:stationId/board — the station screen: at most
  // `visibleCards` order cards (oldest first), how many wait behind them, the
  // on-deck steps and the running timers. Foreign station → 404.
  fastify.get<{ Params: { stationId: string } }>(
    '/station/:stationId/board',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const station = await ownedStation(req, req.params.stationId, 'read')
      const now = new Date()
      const b = await buildStationBoard(station, now)
      return {
        station: { id: station.id, name: station.name, brand: station.concept.name, visibleCards: station.visibleCards },
        visible: b.visible.map((c) => cardJson(c, now)),
        queuedCount: b.queued.length,
        /** The queued cards' order refs only — the cook does not see them. */
        queued: b.queued.map((c) => ({ orderId: c.order.id, ref: c.order.ref, firedAt: c.firedAt })),
        onDeck: b.onDeck,
        timers: b.timers,
        serverNow: now,
      }
    },
  )

  // POST /expo/station/:stationId/cards/:orderId/start — the cook starts the
  // card: startedAt on every row of it at this station that has none.
  fastify.post<{ Params: { stationId: string; orderId: string } }>(
    '/station/:stationId/cards/:orderId/start',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const station = await ownedStation(req, req.params.stationId, 'write')
      const rows = await cardRowsOf(station, req.params.orderId)
      const now = new Date()
      await markStarted(rows, now)
      emitItemUpdated(rows[0]!.itemId, 'preparing', station.id)
      return { ok: true, startedAt: now }
    },
  )

  // POST /expo/station/:stationId/cards/:orderId/done — the tick ("done from
  // memory"): every row of the card at this station is bumped through the
  // existing writers — a step through the cascade (its next station's step
  // fires), a line through the item state machine. A card holding a held line
  // is refused (409 CARD_ON_HOLD — resume it first). The card's timers stop.
  fastify.post<{ Params: { stationId: string; orderId: string } }>(
    '/station/:stationId/cards/:orderId/done',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const station = await ownedStation(req, req.params.stationId, 'write')
      const rows = await cardRowsOf(station, req.params.orderId)
      if (rows.some((r) => r.status === 'held')) {
        throw new AppError('CARD_ON_HOLD', 'A dish on this order is on hold — resume it before ticking the order done.', 409)
      }
      const staffId = req.staffUser!.id
      const { completeStepBump } = await import('./stepCascade.js')
      const { updateItemStatus } = await import('../orders/service.js')
      let bumped = 0
      const unlocked: Array<{ id: string; stationId: string | null }> = []
      for (const r of rows) {
        if (r.kind === 'step') {
          const res = await completeStepBump(r.id, r.itemId, staffId)
          unlocked.push(...res.unlocked.map((u) => ({ id: u.id, stationId: u.stationId })))
        } else {
          await updateItemStatus(r.itemId, 'bumped', staffId)
        }
        bumped += 1
      }
      await prisma.kitchenTimer.updateMany({
        where: { stationId: station.id, orderId: req.params.orderId, stoppedAt: null },
        data: { stoppedAt: new Date() },
      })
      emitItemUpdated(rows[0]!.itemId, 'bumped', station.id)
      return { ok: true, bumped, unlocked }
    },
  )

  // POST /expo/kitchen-timers — start a countdown on a dish / step of a card
  // at a station (defaults to the step's estimatedSeconds on the screen).
  // The row must be live on that station; its company is the order's. Starting
  // a timer starts the card.
  fastify.post('/kitchen-timers', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = timerCreateSchema.parse(req.body)
    const station = await ownedStation(req, body.stationId, 'write')
    if (!station.concept.tenantId) throw new NotFoundError('OrderItem', body.entryId)
    const { rows } = cardRows(await loadStationQueue(station.id, station.concept.tenantId, true))
    const row = rows.find((r) => r.entry.id === body.entryId)
    if (!row) throw new NotFoundError('OrderItem', body.entryId)
    const now = new Date()
    const timer = await prisma.kitchenTimer.create({
      data: {
        tenantId: station.concept.tenantId,
        orderId: row.order.id,
        orderItemId: row.entry.itemId,
        orderItemStepId: row.entry.kind === 'step' ? row.entry.id : null,
        stationId: station.id,
        label: body.label || row.entry.itemName,
        durationSeconds: body.durationSeconds,
        startedAt: now,
        endsAt: new Date(now.getTime() + body.durationSeconds * 1000),
        startedById: req.staffUser!.id,
      },
    })
    await markStarted([row.entry], now)
    emitItemUpdated(row.entry.itemId, 'preparing', station.id)
    return reply.status(201).send(timer)
  })

  // PATCH /expo/kitchen-timers/:id { addSeconds } — + / − time on a running timer.
  fastify.patch<{ Params: { id: string } }>('/kitchen-timers/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = timerAdjustSchema.parse(req.body)
    const timer = await ownedTimer(req, req.params.id)
    if (timer.stoppedAt) throw new AppError('TIMER_STOPPED', 'This timer was already stopped.', 409)
    const duration = timer.durationSeconds + body.addSeconds
    const elapsed = Math.floor((Date.now() - timer.startedAt.getTime()) / 1000)
    if (duration < 1 || duration > MAX_TIMER_SECONDS) {
      throw new AppError('TIMER_OUT_OF_RANGE', 'A timer runs between 1 second and 4 hours.', 422)
    }
    const updated = await prisma.kitchenTimer.updateMany({
      where: { id: timer.id, stoppedAt: null, durationSeconds: timer.durationSeconds },
      data: { durationSeconds: duration, endsAt: new Date(timer.startedAt.getTime() + duration * 1000) },
    })
    if (updated.count === 0) throw new AppError('TIMER_CHANGED', 'The timer changed — try again.', 409)
    emitItemUpdated(timer.orderItemId, 'preparing', timer.stationId)
    return { ...(await prisma.kitchenTimer.findUniqueOrThrow({ where: { id: timer.id } })), remainingSeconds: Math.max(0, duration - elapsed) }
  })

  // POST /expo/kitchen-timers/:id/stop — dismiss a timer (idempotent).
  fastify.post<{ Params: { id: string } }>('/kitchen-timers/:id/stop', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const timer = await ownedTimer(req, req.params.id)
    if (!timer.stoppedAt) {
      await prisma.kitchenTimer.updateMany({ where: { id: timer.id, stoppedAt: null }, data: { stoppedAt: new Date() } })
      emitItemUpdated(timer.orderItemId, 'preparing', timer.stationId)
    }
    return { ok: true }
  })

  // GET /expo/kitchen-status — the expo's backlog counter and the 60-second
  // "not started" alert, across every active station of the companies in view.
  fastify.get('/kitchen-status', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const stations = await prisma.station.findMany({
      where: { deletedAt: null, isActive: true, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) } },
      select: { id: true, name: true, visibleCards: true, conceptId: true, concept: { select: { name: true, tenantId: true } } },
      orderBy: [{ conceptId: 'asc' }, { displayOrder: 'asc' }],
    })
    const now = new Date()
    const boards = []
    for (const s of stations) boards.push(await buildStationBoard(s, now))
    const backlog = backlogOf(boards)
    return {
      backlog: { tickets: backlog.tickets, queuedCards: backlog.queuedCards },
      stations: boards.map((b) => ({
        id: b.station.id, name: b.station.name, brand: b.station.concept.name,
        visibleCards: b.station.visibleCards, visible: b.visible.length, queued: b.queued.length,
      })),
      unstarted: boards.flatMap((b) => unstartedCards(b.visible, now).map((c) => ({
        stationId: b.station.id, stationName: b.station.name, brand: b.station.concept.name,
        orderId: c.order.id, ref: c.order.ref, shownAt: c.shownAt,
        waitingSeconds: Math.floor((now.getTime() - c.shownAt!.getTime()) / 1000),
      }))),
      alertAfterSeconds: UNSTARTED_ALERT_MS / 1000,
      serverNow: now,
    }
  })

  // PUT /expo/stations/:id/display { visibleCards } — how many cards the
  // station screen shows (4–6). A screen setting, not a station change: it
  // applies at once (the CEO approval of owner C3 covers adding / renaming /
  // switching / moving stations). Managers, the F&B manager and the chef with
  // kds_config; another company's station → 404.
  fastify.put<{ Params: { id: string } }>(
    '/stations/:id/display',
    { preHandler: [requireAuth(...MANAGERS, ...STATION_REQUESTERS), requireModule('kds_config')] },
    async (req) => {
      const body = displaySchema.parse(req.body)
      const station = await ownedStation(req, req.params.id, 'write')
      const updated = await prisma.station.update({ where: { id: station.id }, data: { visibleCards: body.visibleCards }, select: { id: true, visibleCards: true } })
      const { audit } = await import('../../lib/audit.js')
      await audit({
        category: 'identity', action: 'station.display', entity: 'Station', entityId: station.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: station.concept.tenantId,
        before: { visibleCards: station.visibleCards }, after: { visibleCards: body.visibleCards },
      })
      return updated
    },
  )

  // GET / PUT /expo/label-settings — the sticker size for the ACTIVE company.
  fastify.get('/label-settings', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return { ...(await labelSizeOf(req.staffUser!.tenantId ?? null)), presets: LABEL_PRESETS }
  })
  fastify.put('/label-settings', { preHandler: requireAuth(...LABEL_EDITORS) }, async (req) => {
    const body = labelSchema.parse(req.body)
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before setting the sticker size.', 422)
    await prisma.setting.upsert({
      where: { key: labelKey(tenantId) },
      create: { key: labelKey(tenantId), value: JSON.stringify(body) },
      update: { value: JSON.stringify(body) },
    })
    const { audit } = await import('../../lib/audit.js')
    await audit({ category: 'identity', action: 'expo.label_size', entity: 'Setting', entityId: labelKey(tenantId), userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: body })
    return body
  })

  // GET /expo/orders/:id/print?kind=sticker|ticket&bags=N — printable HTML:
  // N bag stickers at the order's company's label size, or the kitchen ticket
  // (not a bill). Company scope: another company's order → 404.
  fastify.get<{ Params: { id: string }; Querystring: { kind?: string; bags?: string } }>(
    '/orders/:id/print',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const q = z.object({ kind: z.enum(['sticker', 'ticket']).default('sticker'), bags: z.coerce.number().int().min(1).max(20).default(1) }).parse(req.query ?? {})
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, deletedAt: null, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) } },
        select: {
          id: true, source: true, rawPayload: true, fulfilmentType: true, customerName: true, placedAt: true,
          concept: { select: { name: true, tenantId: true } },
          customer: { select: { name: true } },
          table: { select: { label: true } },
          items: {
            where: { status: { not: 'voided' }, voidedAt: null },
            select: { name: true, quantity: true, notes: true, modifiers: { select: { name: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      const html = renderPrint({
        id: order.id, brand: order.concept.name, channel: orderChannelOf(order), fulfilmentType: order.fulfilmentType,
        customerName: order.customer?.name ?? order.customerName, tableLabel: order.table?.label ?? null, placedAt: order.placedAt,
        items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, notes: i.notes, modifiers: i.modifiers.map((m) => m.name) })),
      }, q.kind, q.bags, await labelSizeOf(order.concept.tenantId))
      return reply.type('text/html; charset=utf-8').send(html)
    },
  )
}

async function markStarted(rows: BoardEntry[], now: Date): Promise<void> {
  const stepIds = rows.filter((r) => r.kind === 'step' && !r.startedAt).map((r) => r.id)
  const lineIds = rows.filter((r) => r.kind === 'line' && !r.startedAt).map((r) => r.id)
  if (stepIds.length) await prisma.orderItemStep.updateMany({ where: { id: { in: stepIds }, startedAt: null }, data: { startedAt: now } })
  if (lineIds.length) await prisma.orderItem.updateMany({ where: { id: { in: lineIds }, startedAt: null }, data: { startedAt: now } })
}

/** A timer inside the caller's companies ('write' scope) — another company's is 404. */
async function ownedTimer(req: FastifyRequest, id: string) {
  const scope = await scopeTenantWhere(req, 'write')
  const timer = await prisma.kitchenTimer.findFirst({ where: { id, tenantId: scope.tenantId as Prisma.StringFilter | string } })
  if (!timer) throw new NotFoundError('KitchenTimer', id)
  return timer
}
