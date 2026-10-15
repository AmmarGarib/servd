// Smallwares pools (H21; owner: smallwares grouped and tracked).
//
//   GET  /accounting/fixed-assets/pools?locationId&conceptId&typeKey   pools with units, layers, NBV, last count (READERS)
//   POST /accounting/fixed-assets/pools/:poolId/requests              write_off (CEO approves) | transfer_units (at once)
//   POST /accounting/fixed-assets/pools/:poolId/counts                a count — no money (FA_WRITERS + F&B manager)
//
// The engine is events.ts (pool_write_off / pool_transfer / count); a pool of
// another company is 404, a destination outlet / brand / pool of another
// company is 422. Audits carry the pool's company.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { toCents } from '../../lib/money.js'
import { FA_WRITER_ROLES, FA_COUNT_ROLES, WRITE_OFF_CAUSES, isFuturePktDay } from './events.js'
import { SMALLWARE_TYPE_LABELS } from './classes.js'
import { loadAssetStates, accumulatedTotal, payloadOf } from './service.js'
import { parseEffectiveDate, dateInput, raiseRequest } from './requests.js'

const READERS = FINANCIALS_VIEWERS
const FA_WRITERS = [...FA_WRITER_ROLES] as UserRole[]
const COUNTERS = [...FA_COUNT_ROLES] as UserRole[]
const MIN_REASON = 10

export async function fixedAssetPoolRoutes(fastify: FastifyInstance) {
  fastify.get('/pools', { preHandler: requireAuth(...READERS) }, async (req) => {
    const q = z.object({
      locationId: z.string().max(64).optional(),
      conceptId: z.string().max(64).optional(),
      typeKey: z.string().max(40).optional(),
      includeEmpty: z.enum(['0', '1']).optional(),
    }).parse(req.query)
    const pools = await prisma.fixedAssetPool.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'read')),
        ...(q.locationId ? { locationId: q.locationId } : {}),
        ...(q.conceptId ? { conceptId: q.conceptId } : {}),
        ...(q.typeKey ? { typeKey: q.typeKey } : {}),
      },
      include: { location: { select: { name: true } }, concept: { select: { name: true } } },
      orderBy: [{ tenantId: 'asc' }, { label: 'asc' }],
    })
    const poolIds = pools.map((p) => p.id)
    const [layers, counts, pending, tenants] = await Promise.all([
      poolIds.length ? prisma.fixedAsset.findMany({
        where: { poolId: { in: poolIds }, kind: 'pool_layer', status: 'active', quantity: { gt: 0 } },
        orderBy: [{ inServiceAt: 'asc' }, { acquiredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }) : [],
      poolIds.length ? prisma.fixedAssetEvent.findMany({
        where: { poolId: { in: poolIds }, kind: 'count', status: 'posted' },
        orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
      }) : [],
      poolIds.length ? prisma.fixedAssetEvent.groupBy({ by: ['poolId'], where: { poolId: { in: poolIds }, status: 'pending' }, _count: { _all: true } }) : [],
      prisma.tenant.findMany({ where: { id: { in: [...new Set(pools.map((p) => p.tenantId))] } }, select: { id: true, name: true } }),
    ])
    const company = new Map(tenants.map((t) => [t.id, t.name]))
    // Accumulated per layer, through the engine's own state (one source).
    const accum = new Map<string, number>()
    for (const t of new Set(layers.map((l) => l.tenantId))) {
      for (const s of await loadAssetStates(prisma, t, layers.filter((l) => l.tenantId === t))) accum.set(s.asset.id, accumulatedTotal(s))
    }
    const pendingOf = new Map(pending.map((p) => [p.poolId, p._count._all]))
    const out = pools.map((p) => {
      const mine = layers.filter((l) => l.poolId === p.id).map((l) => {
        const cost = toCents(l.costCents)
        const a = accum.get(l.id) ?? 0
        return {
          id: l.id, assetTag: l.assetTag, name: l.name, quantity: l.quantity, originalQuantity: l.originalQuantity,
          inServiceAt: l.inServiceAt ?? l.acquiredAt, usefulLifeMonths: l.usefulLifeMonths,
          costCents: cost, accumulatedCents: a, nbvCents: cost - a,
        }
      })
      const last = counts.find((c) => c.poolId === p.id)
      const lp = last ? payloadOf(last) : null
      return {
        id: p.id, tenantId: p.tenantId, companyName: company.get(p.tenantId) ?? '', label: p.label,
        locationId: p.locationId, locationName: p.location.name, conceptId: p.conceptId, conceptName: p.concept?.name ?? null,
        classKey: p.classKey, typeKey: p.typeKey, typeLabel: SMALLWARE_TYPE_LABELS[p.typeKey] ?? p.typeKey, isActive: p.isActive,
        unitsOnHand: mine.reduce((t, l) => t + l.quantity, 0),
        costCents: mine.reduce((t, l) => t + l.costCents, 0),
        accumulatedCents: mine.reduce((t, l) => t + l.accumulatedCents, 0),
        nbvCents: mine.reduce((t, l) => t + l.nbvCents, 0),
        layers: mine,
        lastCount: last ? {
          eventId: last.id, countedAt: last.effectiveDate,
          countedUnits: typeof lp?.['countedUnits'] === 'number' ? lp['countedUnits'] : null,
          onHandUnits: typeof lp?.['onHandUnits'] === 'number' ? lp['onHandUnits'] : null,
          shortfallUnits: typeof lp?.['shortfallUnits'] === 'number' ? lp['shortfallUnits'] : null,
          note: typeof lp?.['note'] === 'string' ? lp['note'] : null,
        } : null,
        pendingRequestCount: pendingOf.get(p.id) ?? 0,
      }
    })
    return { pools: q.includeEmpty === '0' ? out.filter((p) => p.unitsOnHand > 0) : out }
  })

  // POST /pools/:poolId/requests — write units off (breakage / loss / theft /
  // worn out: the CEO approves; the CEO's own applies at once) or move units
  // to another outlet / brand (at once).
  fastify.post<{ Params: { poolId: string } }>('/pools/:poolId/requests', { preHandler: requireAuth(...FA_WRITERS) }, async (req, reply) => {
    const body = z.object({
      kind: z.enum(['write_off', 'transfer_units']),
      units: z.number().int().min(1).max(1_000_000),
      effectiveDate: dateInput.optional(),
      reason: z.string().max(1000).default(''),
      payload: z.object({
        cause: z.enum(WRITE_OFF_CAUSES).optional(),
        toPoolId: z.string().min(1).max(64).optional(),
        toLocationId: z.string().min(1).max(64).optional(),
        toConceptId: z.string().min(1).max(64).nullable().optional(),
      }).default({}),
    }).parse(req.body)
    const pool = await prisma.fixedAssetPool.findFirst({ where: { id: req.params.poolId, ...(await scopeTenantWhere(req, 'write')) } })
    if (!pool) throw new NotFoundError('FixedAssetPool', req.params.poolId)
    if (body.reason.trim().length < MIN_REASON) throw new AppError('REASON_REQUIRED', `Give a reason (at least ${MIN_REASON} characters)`, 422)

    let payload: Record<string, unknown>
    if (body.kind === 'write_off') {
      payload = { units: body.units, cause: body.payload.cause ?? 'breakage' }
    } else {
      let toLocationId = body.payload.toLocationId
      let toConceptId = body.payload.toConceptId
      if (body.payload.toPoolId) {
        // Name the destination pool: it must be this company's, of the same kind of smallwares.
        const dest = await prisma.fixedAssetPool.findFirst({ where: { id: body.payload.toPoolId, tenantId: pool.tenantId } })
        if (!dest) throw new AppError('POOL_NOT_IN_COMPANY', 'That pool is not one of this company\'s smallwares pools', 422)
        if (dest.classKey !== pool.classKey || dest.typeKey !== pool.typeKey) {
          throw new AppError('POOL_TYPE_MISMATCH', 'Units move only to a pool of the same smallwares type', 422)
        }
        if (dest.id === pool.id) throw new AppError('SAME_POOL', 'The units are already in that pool', 422)
        toLocationId = dest.locationId
        toConceptId = dest.conceptId
      }
      if (!toLocationId) throw new AppError('DESTINATION_REQUIRED', 'Name the outlet (or the pool) the units move to', 422)
      payload = { units: body.units, toLocationId, ...(toConceptId !== undefined ? { toConceptId } : {}) }
    }
    const r = await raiseRequest(req, {
      kind: body.kind === 'write_off' ? 'pool_write_off' : 'pool_transfer',
      poolId: pool.id,
      tenantId: pool.tenantId,
      effectiveDate: parseEffectiveDate(body.effectiveDate),
      reason: body.reason.trim(),
      payload,
    })
    return reply.status(r.statusCode).send(r.body)
  })

  // POST /pools/:poolId/counts — what is physically there. No money; the
  // shortfall is what finance may then ask the CEO to write off.
  fastify.post<{ Params: { poolId: string } }>('/pools/:poolId/counts', { preHandler: requireAuth(...COUNTERS) }, async (req, reply) => {
    const body = z.object({
      countedUnits: z.number().int().min(0).max(1_000_000),
      countedAt: dateInput.optional(),
      note: z.string().max(500).optional(),
    }).parse(req.body)
    const pool = await prisma.fixedAssetPool.findFirst({ where: { id: req.params.poolId, ...(await scopeTenantWhere(req, 'write')) } })
    if (!pool) throw new NotFoundError('FixedAssetPool', req.params.poolId)
    const countedAt = parseEffectiveDate(body.countedAt)
    if (countedAt && isFuturePktDay(countedAt)) throw new AppError('EFFECTIVE_DATE', 'A count cannot be dated in the future', 422)
    const r = await raiseRequest(req, {
      kind: 'count',
      poolId: pool.id,
      tenantId: pool.tenantId,
      reason: body.note?.trim() || 'Smallwares count',
      payload: { countedUnits: body.countedUnits, ...(body.countedAt ? { countedAt: body.countedAt } : {}), ...(body.note ? { note: body.note } : {}) },
    })
    const ev = r.body['event'] as { payload: unknown } | undefined
    const p = (ev?.payload && typeof ev.payload === 'object' ? ev.payload : {}) as Record<string, unknown>
    return reply.status(201).send({
      ...r.body,
      countedUnits: body.countedUnits,
      onHandUnits: typeof p['onHandUnits'] === 'number' ? p['onHandUnits'] : null,
      shortfallUnits: typeof p['shortfallUnits'] === 'number' ? p['shortfallUnits'] : null,
    })
  })
}
