// Stock by site — the readers (owner, 2026-10-24, D4). Writers live in
// lib/stockLedger.ts; which site is lib/stockSite.ts.
//
//   GET /inventory/negative?locationId=   items whose SALES at a site ran past
//       what the site's lots held and no later delivery / batch / transfer has
//       settled yet (the open shortfall: Σ sale shortfallQty − what
//       'shortfall_settle' rows settled, with the settle's own rule for food never
//       eaten (deadShortfallSaleIdsTx), over the nightly flag's
//       SHORTFALL_SETTLE_DAYS window), per site. The daily list
//       the inventory page shows; the nightly flag stays.
//   GET /inventory/by-site?locationId=    on hand per item per site (the
//       stock_balances cache), for the stock screens' site filter.
//
// Both read the companies in view (resolveTenantScope); a locationId must be
// one of their outlets (422 LOCATION_NOT_IN_COMPANY) — never another
// company's figures.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { AppError } from '../../lib/errors.js'
import { deadShortfallSaleIdsTx, SHORTFALL_SETTLE_DAYS, STOCK_EPS } from '../../lib/stockLedger.js'
import { toCents } from '../../lib/money.js'

type Db = Prisma.TransactionClient | typeof prisma

const DAY_MS = 86_400_000

/** The companies in view, and the named outlet (422 unless it is one of theirs). */
export async function siteScope(req: FastifyRequest, locationId: string | undefined): Promise<{ tenantIds: string[]; locationId: string | null }> {
  const { tenantIds } = await resolveTenantScope(req)
  if (!locationId) return { tenantIds, locationId: null }
  const loc = tenantIds.length === 0 ? null : await prisma.location.findFirst({ where: { id: locationId, tenantId: { in: tenantIds } }, select: { id: true } })
  if (!loc) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That location is not one of the companies in view', 422)
  return { tenantIds, locationId }
}

export interface OpenShortfall {
  inventoryItemId: string
  locationId: string | null
  /** Sold but not on the books, still unsettled (stock units). */
  qty: number
  /** At the latest purchase price when it was sold (memo only — never posted). */
  memoValueCents: number
  saleLines: number
  oldestAt: string
}

/** Open sale shortfalls per (item, site) of the companies (see the header). */
export async function openShortfalls(db: Db, tenantIds: string[], locationId: string | null): Promise<OpenShortfall[]> {
  if (tenantIds.length === 0) return []
  const since = new Date(Date.now() - SHORTFALL_SETTLE_DAYS * DAY_MS)
  const sales = await db.stockMovement.findMany({
    where: {
      tenantId: { in: tenantIds }, kind: 'sale', shortfallQty: { gt: STOCK_EPS }, occurredAt: { gte: since },
      ...(locationId ? { locationId } : {}),
    },
    select: {
      id: true, tenantId: true, inventoryItemId: true, locationId: true, shortfallQty: true, shortfallValueCents: true, orderId: true, orderItemId: true,
      occurredAt: true, sourceType: true, sourceId: true,
    },
  })
  if (sales.length === 0) return []
  const [settled, dead] = await Promise.all([
    db.stockMovement.groupBy({
      by: ['settlesMovementId'], where: { kind: 'shortfall_settle', settlesMovementId: { in: sales.map((s) => s.id) } }, _sum: { qty: true },
    }),
    // THE settle's own rule (lib/stockLedger.ts deadShortfallSaleIdsTx), per company.
    (async () => {
      const ids = new Set<string>()
      for (const t of new Set(sales.map((x) => x.tenantId))) {
        for (const id of await deadShortfallSaleIdsTx(db, t, sales.filter((x) => x.tenantId === t))) ids.add(id)
      }
      return ids
    })(),
  ])
  const settledBy = new Map(settled.map((r) => [r.settlesMovementId, -(r._sum.qty ?? 0)]))
  const out = new Map<string, OpenShortfall>()
  for (const s of sales) {
    if (dead.has(s.id)) continue
    const total = s.shortfallQty ?? 0
    const open = total - (settledBy.get(s.id) ?? 0)
    if (open < STOCK_EPS) continue
    const key = `${s.inventoryItemId}|${s.locationId ?? ''}`
    const row = out.get(key) ?? { inventoryItemId: s.inventoryItemId, locationId: s.locationId, qty: 0, memoValueCents: 0, saleLines: 0, oldestAt: s.occurredAt.toISOString() }
    row.qty += open
    row.memoValueCents += total > 0 ? Math.round(((toCents(s.shortfallValueCents) ?? 0) * open) / total) : 0
    row.saleLines += 1
    if (s.occurredAt.toISOString() < row.oldestAt) row.oldestAt = s.occurredAt.toISOString()
    out.set(key, row)
  }
  return [...out.values()].sort((a, b) => b.memoValueCents - a.memoValueCents)
}

export async function siteStockRoutes(fastify: FastifyInstance, opts: { readers: readonly string[]; hideCosts: (req: FastifyRequest) => boolean }) {
  fastify.get<{ Querystring: { locationId?: string } }>('/negative', { preHandler: requireAuth(...(opts.readers as never[])) }, async (req) => {
    const { tenantIds, locationId } = await siteScope(req, req.query.locationId)
    const rows = await openShortfalls(prisma, tenantIds, locationId)
    const [items, locs] = await Promise.all([
      prisma.inventoryItem.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.inventoryItemId))] } }, select: { id: true, name: true, unit: true } }),
      prisma.location.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.locationId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
    ])
    const itemById = new Map(items.map((i) => [i.id, i]))
    const locById = new Map(locs.map((l) => [l.id, l.name]))
    const hide = opts.hideCosts(req)
    return {
      windowDays: SHORTFALL_SETTLE_DAYS,
      items: rows.map((r) => ({
        inventoryItemId: r.inventoryItemId, name: itemById.get(r.inventoryItemId)?.name ?? null, unit: itemById.get(r.inventoryItemId)?.unit ?? null,
        locationId: r.locationId, locationName: r.locationId ? locById.get(r.locationId) ?? null : null,
        shortQty: Math.round(r.qty * 1000) / 1000, saleLines: r.saleLines, oldestAt: r.oldestAt,
        ...(hide ? {} : { memoValueCents: r.memoValueCents }),
      })),
      ...(hide ? { costsHidden: true as const } : {}),
    }
  })

  fastify.get<{ Querystring: { locationId?: string } }>('/by-site', { preHandler: requireAuth(...(MANAGERS as never[]), ...(opts.readers as never[])) }, async (req) => {
    const { tenantIds, locationId } = await siteScope(req, req.query.locationId)
    if (tenantIds.length === 0) return { sites: [], rows: [] }
    const [rows, sites] = await Promise.all([
      prisma.stockBalance.findMany({
        where: { tenantId: { in: tenantIds }, ...(locationId ? { locationId } : {}) },
        select: { inventoryItemId: true, locationId: true, qty: true },
      }),
      prisma.location.findMany({ where: { tenantId: { in: tenantIds }, deletedAt: null, ...(locationId ? { id: locationId } : {}) }, select: { id: true, name: true, tenantId: true }, orderBy: { name: 'asc' } }),
    ])
    return { sites, rows: rows.map((r) => ({ ...r, qty: Math.round(r.qty * 1000) / 1000 })) }
  })
}
