// Stock by site (owner, 2026-10-24, D4: "per-site stock now"). Every stock lot
// belongs to ONE outlet (Location) of its company, and a draw takes only that
// site's lots. This file is THE rule for WHICH site:
//
//   • stockHomeOf(db, tenantId) — the company's STOCK HOME: where stock with no
//     other site goes (lots from before this build, a receipt that named no
//     outlet, a write that could not name one). Chosen ONCE and kept in
//     Setting 'stock.homeLocationId:<tenantId>': the company's single active
//     trading location, else the active one with the most sales in the last 30
//     days (ties: the oldest), else the oldest live location. Never a head
//     office's (a head office has no stock — it never trades) and never the
//     "General — to be assigned" holding place (lib/generalLocation.ts). A
//     company with no location at all has NO home (null): its stock is one
//     company pool (lots with locationId NULL) until it gets an outlet — the
//     first write after that moves the pool to the home (adoptOrphanLotsTx in
//     lib/stockLedger.ts, and the site cut-over below).
//   • stockSiteOf(db, {orderLocationId, conceptId, tenantId}) — the site that
//     COOKS an order: the order's location when it is a live location of the
//     order's company, else the brand's primary ConceptLocation (in the
//     company), else the stock home. Sale depletion, returns, void waste and
//     remakes use it.
//   • stockSiteForDocument(db, tenantId, locationId?) — a stock document typed
//     by a person (waste, count, prep batch): the named location (422
//     LOCATION_NOT_IN_COMPANY when it is not the company's); none named → the
//     company's only active outlet / its stock home, but 422 LOCATION_REQUIRED
//     when the company has two or more active outlets (the stock must not
//     silently land on the wrong site).
//
// The site cut-over (ensureSiteCutover) runs once per company after its FIFO
// cut-over (lib/stockLedger.ts ensureFifoReady calls it): every lot with no
// site goes to the stock home, the lot-carrying movements with no site take
// their lot's site, the per-site balances (stock_balances) are rebuilt, and
// the marker Setting 'stock.siteCutoverAt:<tenantId>' records the instant and
// the home (JSON {at, homeLocationId}). A company with no location gets no
// marker yet (it is re-checked on the next write, one cheap read).

import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'
import { AppError } from './errors.js'
import { generalLocationSlug } from './generalLocation.js'

type Db = Prisma.TransactionClient | PrismaClient

export const STOCK_HOME_SETTING = 'stock.homeLocationId'
export const SITE_CUTOVER_SETTING = 'stock.siteCutoverAt'

export function stockHomeKey(tenantId: string): string {
  return `${STOCK_HOME_SETTING}:${tenantId}`
}
export function siteCutoverKey(tenantId: string): string {
  return `${SITE_CUTOVER_SETTING}:${tenantId}`
}

const DAY_MS = 86_400_000

/** Live, non-holding locations of a company (the places stock can sit). */
async function stockSitesOf(db: Db, tenantId: string): Promise<Array<{ id: string; isActive: boolean; createdAt: Date }>> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { kind: true } })
  if (!tenant || tenant.kind === 'head_office') return []
  return db.location.findMany({
    where: { tenantId, deletedAt: null, slug: { not: generalLocationSlug(tenantId) } },
    select: { id: true, isActive: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

/** The home as the rule picks it now (not stored). */
async function pickStockHome(db: Db, tenantId: string): Promise<string | null> {
  const sites = await stockSitesOf(db, tenantId)
  if (sites.length === 0) return null
  const active = sites.filter((s) => s.isActive)
  if (active.length === 1) return active[0]!.id
  const pool = active.length > 0 ? active : sites
  const sales = await db.order.groupBy({
    by: ['locationId'],
    where: {
      locationId: { in: pool.map((s) => s.id) }, concept: { tenantId },
      placedAt: { gte: new Date(Date.now() - 30 * DAY_MS) }, status: { notIn: ['cancelled', 'rejected'] },
    },
    _count: { _all: true },
  })
  const count = new Map(sales.map((s) => [s.locationId, s._count._all]))
  // pool is oldest first: a stable sort keeps the oldest on a tie.
  const ranked = [...pool].sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0))
  return ranked[0]!.id
}

/**
 * The company's stock home (see the header): the stored one while it is still
 * a live location of the company, else picked now and stored (first writer
 * wins). Null = the company has no location (one company pool).
 */
export async function stockHomeOf(db: Db, tenantId: string): Promise<string | null> {
  const key = stockHomeKey(tenantId)
  const row = await db.setting.findUnique({ where: { key }, select: { value: true } })
  if (row?.value) {
    const ok = await db.location.findFirst({ where: { id: row.value, tenantId, deletedAt: null }, select: { id: true } })
    if (ok) return row.value
  }
  const picked = await pickStockHome(db, tenantId)
  if (!picked) return null
  if (row) {
    await db.setting.update({ where: { key }, data: { value: picked } })
    return picked
  }
  // First writer wins: a racing pick keeps the stored one.
  await db.$executeRaw`INSERT INTO settings (key, value, "updatedAt") VALUES (${key}, ${picked}, now()) ON CONFLICT (key) DO NOTHING`
  const stored = await db.setting.findUnique({ where: { key }, select: { value: true } })
  return stored?.value ?? picked
}

/** 422 LOCATION_NOT_IN_COMPANY unless `locationId` is a location of `tenantId` (a deleted one counts — its lots are history). */
export async function assertSiteOfCompany(db: Db, tenantId: string, locationId: string): Promise<void> {
  const ok = await db.location.findFirst({ where: { id: locationId, tenantId }, select: { id: true } })
  if (!ok) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That location does not belong to this item\'s company — stock never moves across companies', 422)
}

/** The site that cooks an order (see the header). Null only when the company has no location. */
export async function stockSiteOf(db: Db, a: { orderLocationId: string | null | undefined; conceptId: string | null | undefined; tenantId: string }): Promise<string | null> {
  if (a.orderLocationId) {
    const ok = await db.location.findFirst({
      where: { id: a.orderLocationId, tenantId: a.tenantId, deletedAt: null, slug: { not: generalLocationSlug(a.tenantId) } },
      select: { id: true },
    })
    if (ok) return ok.id
  }
  if (a.conceptId) {
    const links = await db.conceptLocation.findMany({
      where: { conceptId: a.conceptId, location: { tenantId: a.tenantId, deletedAt: null } },
      select: { locationId: true, isPrimary: true, createdAt: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { locationId: 'asc' }],
    })
    const primary = links.find((l) => l.isPrimary) ?? (links.length === 1 ? links[0] : undefined)
    if (primary && primary.locationId !== (await generalId(db, a.tenantId))) return primary.locationId
  }
  return stockHomeOf(db, a.tenantId)
}

async function generalId(db: Db, tenantId: string): Promise<string | null> {
  const g = await db.location.findUnique({ where: { slug: generalLocationSlug(tenantId) }, select: { id: true } })
  return g?.id ?? null
}

/**
 * The site of a stock document a person records (waste, count, prep batch):
 * see the header. Returns null only when the company has no location.
 */
export async function stockSiteForDocument(db: Db, tenantId: string, locationId: string | null | undefined): Promise<string | null> {
  if (locationId) {
    const ok = await db.location.findFirst({ where: { id: locationId, tenantId, deletedAt: null }, select: { id: true } })
    if (!ok) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That location does not belong to this company', 422)
    return locationId
  }
  const sites = await stockSitesOf(db, tenantId)
  if (sites.filter((s) => s.isActive).length > 1) {
    throw new AppError('LOCATION_REQUIRED', 'This company has more than one outlet — say which outlet\'s stock this is (locationId)', 422)
  }
  return stockHomeOf(db, tenantId)
}

/** When the company's site cut-over ran (null = not yet). */
export async function readSiteCutover(db: Db, tenantId: string): Promise<{ at: Date; homeLocationId: string } | null> {
  const row = await db.setting.findUnique({ where: { key: siteCutoverKey(tenantId) }, select: { value: true } })
  if (!row) return null
  try {
    const v = JSON.parse(row.value) as { at?: string; homeLocationId?: string }
    if (!v.at || !v.homeLocationId) return null
    return { at: new Date(v.at), homeLocationId: v.homeLocationId }
  } catch { return null }
}

/**
 * Rebuild the per-site on-hand cache of the given items (all of the company's
 * when `itemIds` is omitted) from their lots. Lots with no site are the
 * company pool and have no balance row.
 */
export async function rebuildStockBalancesTx(tx: Prisma.TransactionClient, tenantId: string, itemIds?: string[]): Promise<void> {
  const rows = await tx.stockLot.groupBy({
    by: ['inventoryItemId', 'locationId'],
    where: { tenantId, locationId: { not: null }, ...(itemIds ? { inventoryItemId: { in: itemIds } } : {}) },
    _sum: { remainingQty: true },
  })
  for (const r of rows) {
    let qty = r._sum.remainingQty ?? 0
    if (Math.abs(qty) < 0.000001) qty = 0
    await tx.stockBalance.upsert({
      where: { inventoryItemId_locationId: { inventoryItemId: r.inventoryItemId, locationId: r.locationId! } },
      create: { tenantId, inventoryItemId: r.inventoryItemId, locationId: r.locationId!, qty },
      update: { qty },
    })
  }
}

/** Locations of a company where stock must not sit: deleted ones and the "General — to be assigned" holding place. */
export async function strandedSiteIdsTx(db: Db, tenantId: string): Promise<string[]> {
  const rows = await db.location.findMany({
    where: { tenantId, OR: [{ deletedAt: { not: null } }, { slug: generalLocationSlug(tenantId) }] },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/** Lots of the company (or of `itemIds`) with no site or at a stranded site (strandedSiteIdsTx). */
function strandedLotWhere(tenantId: string, stranded: string[], itemIds?: string[]): Prisma.StockLotWhereInput {
  return {
    tenantId, ...(itemIds ? { inventoryItemId: { in: itemIds } } : {}),
    OR: [{ locationId: null }, ...(stranded.length > 0 ? [{ locationId: { in: stranded } }] : [])],
  }
}

/**
 * Move lots with no site / at a stranded site to `home`, retag EVERY
 * lot-carrying movement of the moved items to its lot's site (IS DISTINCT
 * FROM — so Σ movements per site equals that site's lots), and rebuild the
 * items' per-site balances (stale rows to zero first). Idempotent. The caller
 * holds the items' locks. Returns the lots moved.
 */
export async function relocateStrandedLotsTx(tx: Prisma.TransactionClient, tenantId: string, home: string, itemIds?: string[]): Promise<number> {
  const stranded = await strandedSiteIdsTx(tx, tenantId)
  const lots = await tx.stockLot.updateMany({ where: strandedLotWhere(tenantId, stranded, itemIds), data: { locationId: home } })
  if (itemIds) {
    await tx.$executeRaw`
      UPDATE stock_movements m SET "locationId" = l."locationId"
        FROM stock_lots l
       WHERE m."lotId" = l.id AND m."tenantId" = ${tenantId} AND m."inventoryItemId" IN (${Prisma.join(itemIds)})
         AND m."locationId" IS DISTINCT FROM l."locationId"`
    await tx.stockBalance.updateMany({ where: { tenantId, inventoryItemId: { in: itemIds } }, data: { qty: 0 } })
  } else {
    await tx.$executeRaw`
      UPDATE stock_movements m SET "locationId" = l."locationId"
        FROM stock_lots l
       WHERE m."lotId" = l.id AND m."tenantId" = ${tenantId} AND m."locationId" IS DISTINCT FROM l."locationId"`
    await tx.stockBalance.updateMany({ where: { tenantId }, data: { qty: 0 } })
  }
  await rebuildStockBalancesTx(tx, tenantId, itemIds)
  return lots.count
}

/**
 * The site cut-over of a company (see the header), and its upkeep: runs the
 * first time (marker + audit 'stock.site_cutover'), and again whenever the
 * stock home changed or lots sit with no site / at a deleted or holding
 * location (audit 'stock.site_relocate'). Idempotent; call OUTSIDE a
 * transaction (it locks every item of the company). Returns the home, or null
 * when the company has no location yet (nothing written).
 */
export async function ensureSiteCutover(tenantId: string): Promise<string | null> {
  const done = await readSiteCutover(prisma, tenantId)
  // No location yet: nothing to cut over (one company pool) — no transaction, no lock.
  const home = await stockHomeOf(prisma, tenantId)
  if (!home) return done?.homeLocationId ?? null
  const strandedNow = async (db: Db) => db.stockLot.count({ where: strandedLotWhere(tenantId, await strandedSiteIdsTx(db, tenantId)) })
  if (done && done.homeLocationId === home && (await strandedNow(prisma)) === 0) return home
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site_cutover:${tenantId}`}))`
    const again = await readSiteCutover(tx, tenantId)
    const h = await stockHomeOf(tx, tenantId)
    if (!h) return null
    if (again && again.homeLocationId === h && (await strandedNow(tx)) === 0) return h
    await tx.$queryRaw`SELECT id FROM inventory_items WHERE "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`
    const moved = await relocateStrandedLotsTx(tx, tenantId, h)
    const at = new Date()
    await tx.setting.upsert({
      where: { key: siteCutoverKey(tenantId) },
      create: { key: siteCutoverKey(tenantId), value: JSON.stringify({ at: at.toISOString(), homeLocationId: h }) },
      update: { value: JSON.stringify({ at: (again?.at ?? at).toISOString(), homeLocationId: h }) },
    })
    await tx.auditLog.create({
      data: {
        category: 'stock', tenantId, action: again ? 'stock.site_relocate' : 'stock.site_cutover', entity: 'Location', entityId: h,
        metadata: { homeLocationId: h, previousHomeLocationId: again?.homeLocationId ?? null, lotsMoved: moved, at: at.toISOString() } as Prisma.InputJsonValue,
      },
    })
    return h
  }, { maxWait: 10_000, timeout: 120_000 })
}
