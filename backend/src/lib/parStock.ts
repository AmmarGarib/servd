// Par stock today (owner, 2026-11-13: "Expo station should be able to
// manipulate par stock generally.. so build it in there").
//
// Expo sets how many portions of a dish were prepped today
// (`MenuItem.portionsAvailable`, null = unlimited; PUT /expo/par-stock) and
// the running "left" lives in the ONE counter lib/reservation.ts already
// keeps (`avail:{menuItemId}`). Every sale counts it down; at 0 the dish is
// switched off (audit 'menu.par_stock_out'); cancelling / voiding a line before
// the bill is final gives the portions back and switches a dish this counter
// sold out back on. NEVER stock, FIFO lots or the ledger — a service counter.
//
// WHICH ORDERS TAKE PORTIONS: every order created through ingestOrder (till,
// manual, storefront, group orders, WhatsApp) and every line added to an open
// till ticket — taken once, before the order is written, refused with 409
// PAR_STOCK_SHORT when short. Not taken: a shift-correction re-issue (the food
// was already sold once) and a pre-order held for later than the prep window
// (heldAtCreation — today's par is not tomorrow's); those never give back
// either. The storefront's /cart/reserve holds have no caller today, so a
// storefront order is NOT double counted; if a cart hold is ever wired up, the
// checkout must hand the hold to the order and skip this take.
//
// GIVE BACK: a line voided on an open ticket, and a whole ticket cancelled /
// rejected while not completed (lines already voided are not given twice; a
// completed-then-refunded or credit-noted bill gives nothing — the food was
// served). Both run once: on the call that made the status change.

import { prisma } from './prisma.js'
import { AppError } from './errors.js'
import { takePortions, givePortions } from './reservation.js'
import { emitItem86d } from './ws.js'

export const PAR_STOCK_OUT = 'menu.par_stock_out'
export const PAR_STOCK_SET = 'menu.par_stock_set'
/** Other availability rows: a later one means someone else decided the dish's state. */
const AUTO_86 = 'menu.auto_86'
const MANUAL_AVAILABILITY = 'menu.availability'

export interface PortionTake { menuItemId: string; qty: number; portionsAvailable: number | null }

/**
 * Take the portions of these lines (one brand's), all or nothing. Throws 409
 * PAR_STOCK_SHORT with `details.short` when a dish has fewer left. Returns
 * what was taken (for giveBackPortions when the order write then fails) and
 * the dishes now at 0 — the caller sells them out with sellOut AFTER its order
 * is written (switching them off first would refuse its own order as 86'd).
 */
export interface PortionTakeResult { taken: PortionTake[]; soldOut: string[] }
export const NO_TAKE: PortionTakeResult = { taken: [], soldOut: [] }

export async function takeLinePortions(
  conceptId: string,
  lines: Array<{ menuItemId?: string | null; quantity: number }>,
): Promise<PortionTakeResult> {
  const ids = [...new Set(lines.map((l) => l.menuItemId).filter((x): x is string => !!x))]
  if (ids.length === 0) return NO_TAKE
  // Only the brand's own dishes: a foreign id is refused by prepareOrderLines,
  // and must never move another brand's counter on the way.
  const dishes = await prisma.menuItem.findMany({
    where: { id: { in: ids }, conceptId, portionsAvailable: { not: null } },
    select: { id: true, name: true, portionsAvailable: true },
  })
  if (dishes.length === 0) return NO_TAKE
  const byId = new Map(dishes.map((d) => [d.id, d]))
  const take: PortionTake[] = lines
    .filter((l) => l.menuItemId && byId.has(l.menuItemId))
    .map((l) => ({ menuItemId: l.menuItemId!, qty: Math.max(0, Math.floor(l.quantity)), portionsAvailable: byId.get(l.menuItemId!)!.portionsAvailable }))
  const res = await takePortions(take)
  if (!res.ok) {
    const short = res.short.map((s) => ({ ...s, name: byId.get(s.menuItemId)?.name ?? 'This dish' }))
    const first = short[0]!
    throw new AppError(
      'PAR_STOCK_SHORT',
      first.available > 0 ? `Only ${first.available} ${first.name} left` : `${first.name} is sold out`,
      409,
      { short },
    )
  }
  return { taken: take, soldOut: res.left.filter((l) => l.left <= 0).map((l) => l.menuItemId) }
}

/** Give back what takeLinePortions took (a refused order write / a replay). */
export async function giveBackPortions(taken: PortionTake[]): Promise<void> {
  if (taken.length === 0) return
  const left = await givePortions(taken)
  const back = left.filter((l) => l.left > 0).map((l) => l.menuItemId)
  if (back.length > 0) await backOnIfSoldOutByPar(back)
}

/** Give back the portions of order lines (cancel / void). Reads each dish's current setting. */
export async function giveBackLinePortions(lines: Array<{ menuItemId: string | null; quantity: number }>): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.menuItemId).filter((x): x is string => !!x))]
  if (ids.length === 0) return
  const dishes = await prisma.menuItem.findMany({
    where: { id: { in: ids }, portionsAvailable: { not: null } },
    select: { id: true, portionsAvailable: true },
  })
  const pa = new Map(dishes.map((d) => [d.id, d.portionsAvailable]))
  await giveBackPortions(lines
    .filter((l) => l.menuItemId && pa.has(l.menuItemId))
    .map((l) => ({ menuItemId: l.menuItemId!, qty: l.quantity, portionsAvailable: pa.get(l.menuItemId!) ?? null })))
}

/** Switch these dishes off because their par count reached 0 (once — conditional on isAvailable). */
export async function sellOut(menuItemIds: string[]): Promise<void> {
  const on = await prisma.menuItem.findMany({
    where: { id: { in: menuItemIds }, isAvailable: true, deletedAt: null },
    select: { id: true, conceptId: true, concept: { select: { tenantId: true } } },
  })
  for (const m of on) {
    const flipped = await prisma.menuItem.updateMany({ where: { id: m.id, isAvailable: true }, data: { isAvailable: false, lastSyncedAt: null } })
    if (flipped.count === 0) continue
    const stamped = await prisma.menuItem.findUnique({ where: { id: m.id }, select: { updatedAt: true } })
    await prisma.auditLog.create({
      data: {
        category: 'stock', tenantId: m.concept.tenantId, action: PAR_STOCK_OUT, entity: 'MenuItem', entityId: m.id,
        metadata: { itemUpdatedAt: stamped?.updatedAt.toISOString() ?? null },
      },
    }).catch((err: Error) => console.error('[par-stock] audit write failed:', err.message))
    emitItem86d(m.id, m.conceptId, false)
  }
}

/**
 * Of these switched-off dishes, the ones whose LATEST availability change is
 * still this counter's sell-out and that nobody touched since (the pattern of
 * orders/service.ts standingAutoEightySix): a chef's own 86 on top stands.
 */
export async function standingParStockOut(items: Array<{ id: string; updatedAt: Date }>): Promise<Set<string>> {
  const out = new Set<string>()
  if (items.length === 0) return out
  const rows = await prisma.auditLog.findMany({
    where: { action: { in: [PAR_STOCK_OUT, AUTO_86, MANUAL_AVAILABILITY] }, entity: 'MenuItem', entityId: { in: items.map((m) => m.id) } },
    select: { entityId: true, action: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'desc' },
  })
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (r.entityId && !latest.has(r.entityId)) latest.set(r.entityId, r)
  for (const m of items) {
    const last = latest.get(m.id)
    if (!last || last.action !== PAR_STOCK_OUT) continue
    const left = (last.metadata as { itemUpdatedAt?: string | null } | null)?.itemUpdatedAt
    const untouchedSince = left ? Date.parse(left) : last.createdAt.getTime()
    if (m.updatedAt.getTime() > untouchedSince) continue
    out.add(m.id)
  }
  return out
}

/** Switch back on the dishes this counter sold out (and nothing else since). */
export async function backOnIfSoldOutByPar(menuItemIds: string[], standing?: Set<string>): Promise<string[]> {
  const off = await prisma.menuItem.findMany({
    where: { id: { in: menuItemIds }, isAvailable: false, deletedAt: null },
    select: { id: true, conceptId: true, updatedAt: true },
  })
  if (off.length === 0) return []
  const ok = standing ?? await standingParStockOut(off)
  const turned: string[] = []
  for (const m of off) {
    if (!ok.has(m.id)) continue
    const flipped = await prisma.menuItem.updateMany({ where: { id: m.id, isAvailable: false }, data: { isAvailable: true, lastSyncedAt: null } })
    if (flipped.count === 0) continue
    turned.push(m.id)
    emitItem86d(m.id, m.conceptId, true)
  }
  return turned
}
