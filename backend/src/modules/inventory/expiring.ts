// Use-by — the expiring-soon list (owner B6, 2026-10-26: "Use-by date on deliveries of perishable items, plus an
// expiring-soon list and bell notice").
//
//   GET /inventory/expiring?locationId&days=3   open lots (remaining > 0) with a use-by on or before today + days
//       (Karachi), the expired ones included, per site, soonest first. The companies in view (siteScope — a
//       locationId must be one of their outlets, 422 LOCATION_NOT_IN_COMPANY). Stock readers; a kitchen floor role
//       gets no value. Read only — the lots and their use-by are written by lib/stockLedger.ts.
//
// expiringLots() is the ONE reader the bell (workers/stockExpiry.ts) uses too.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth } from '../auth/middleware.js'
import { STOCK_EPS } from '../../lib/stockLedger.js'
import { toCents } from '../../lib/money.js'
import { addDays, dateToDay, dayToDate, karachiDay } from '../../lib/useBy.js'
import { siteScope } from './siteStock.js'

type Db = Prisma.TransactionClient | typeof prisma

export const EXPIRING_DEFAULT_DAYS = 3
export const EXPIRING_MAX_DAYS = 60

export interface ExpiringLot {
  lotId: string
  tenantId: string
  inventoryItemId: string
  name: string
  unit: string
  locationId: string | null
  locationName: string | null
  useBy: string
  /** Days from today (Karachi) to the use-by: negative = expired, 0 = today. */
  daysLeft: number
  status: 'expired' | 'today' | 'soon'
  remainingQty: number
  remainingValueCents: number
  useByWarnedAt: Date | null
  expiredWarnedAt: Date | null
}

/** Open lots of the companies whose use-by is on or before `untilDay` (expired included), soonest first. */
export async function expiringLots(db: Db, tenantIds: string[], o: { locationId?: string | null; untilDay: string; today?: string }): Promise<ExpiringLot[]> {
  if (tenantIds.length === 0) return []
  const today = o.today ?? karachiDay()
  const lots = await db.stockLot.findMany({
    where: {
      tenantId: { in: tenantIds }, remainingQty: { gt: STOCK_EPS }, useBy: { not: null, lte: dayToDate(o.untilDay) },
      ...(o.locationId ? { locationId: o.locationId } : {}),
      inventoryItem: { deletedAt: null },
    },
    orderBy: [{ useBy: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, tenantId: true, inventoryItemId: true, locationId: true, useBy: true, remainingQty: true, remainingValueCents: true,
      useByWarnedAt: true, expiredWarnedAt: true, inventoryItem: { select: { name: true, unit: true } },
    },
    take: 2000,
  })
  const locIds = [...new Set(lots.map((l) => l.locationId).filter((x): x is string => !!x))]
  const locs = locIds.length ? await db.location.findMany({ where: { id: { in: locIds } }, select: { id: true, name: true } }) : []
  const locName = new Map(locs.map((l) => [l.id, l.name]))
  const todayMs = dayToDate(today).getTime()
  return lots.map((l) => {
    const useBy = dateToDay(l.useBy!)
    const daysLeft = Math.round((l.useBy!.getTime() - todayMs) / 86_400_000)
    return {
      lotId: l.id, tenantId: l.tenantId, inventoryItemId: l.inventoryItemId, name: l.inventoryItem.name, unit: l.inventoryItem.unit,
      locationId: l.locationId, locationName: l.locationId ? locName.get(l.locationId) ?? null : null,
      useBy, daysLeft, status: daysLeft < 0 ? 'expired' as const : daysLeft === 0 ? 'today' as const : 'soon' as const,
      remainingQty: Math.round(l.remainingQty * 1000) / 1000, remainingValueCents: toCents(l.remainingValueCents),
      useByWarnedAt: l.useByWarnedAt, expiredWarnedAt: l.expiredWarnedAt,
    }
  })
}

export async function expiringRoutes(fastify: FastifyInstance, opts: { readers: readonly string[]; hideCosts: (req: FastifyRequest) => boolean }) {
  fastify.get<{ Querystring: { locationId?: string; days?: string } }>('/expiring', { preHandler: requireAuth(...(opts.readers as never[])) }, async (req) => {
    const { tenantIds, locationId } = await siteScope(req, req.query.locationId || undefined)
    const n = Number.parseInt(req.query.days ?? '', 10)
    const days = Number.isFinite(n) ? Math.min(Math.max(n, 0), EXPIRING_MAX_DAYS) : EXPIRING_DEFAULT_DAYS
    const today = karachiDay()
    const rows = await expiringLots(prisma, tenantIds, { locationId, untilDay: addDays(today, days), today })
    const hide = opts.hideCosts(req)
    return {
      today, days,
      expiredCount: rows.filter((r) => r.status === 'expired').length,
      items: rows.map(({ useByWarnedAt: _w, expiredWarnedAt: _e, remainingValueCents, ...r }) => ({ ...r, ...(hide ? {} : { remainingValueCents }) })),
      ...(hide ? { costsHidden: true as const } : {}),
    }
  })
}
