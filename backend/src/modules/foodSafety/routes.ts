// /food-safety — temperature checks, cleaning schedules, corrective action.
//
// Base layer. Nothing of the kind existed: no model, no route, no page.
//
// The rule that matters: an out-of-range reading cannot be saved without a
// corrective action. "The chiller read 9°C" on its own is a liability; "the
// chiller read 9°C, stock moved to the walk-in, engineer called" is a record
// an inspector accepts. Out-of-range readings also raise an exception flag so
// a manager sees them without having to go looking.
//
// Logging is open to kitchen staff (they hold the probe); setting up units and
// schedules is for managers. Deliberately NOT behind the module-permission
// prefix gate: that gate is for sensitive reads, and a mis-set permission must
// never stop a cook recording a temperature mid-service.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, KITCHEN_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, activeTenantId } from '../../lib/tenantScope.js'

const KINDS = ['fridge', 'freezer', 'hot_hold', 'cooking', 'delivery', 'other'] as const

// Commonly used limits: chill at or below 5°C, freeze at or below -18°C, hot
// holding at or above 63°C, cooking to a core of at least 75°C. Starting
// points only — set whatever your food safety plan specifies.
export const PRESETS: Array<{ name: string; kind: (typeof KINDS)[number]; minC: number | null; maxC: number | null }> = [
  { name: 'Walk-in chiller',  kind: 'fridge',   minC: 0,    maxC: 5 },
  { name: 'Reach-in fridge',  kind: 'fridge',   minC: 0,    maxC: 5 },
  { name: 'Freezer',          kind: 'freezer',  minC: null, maxC: -18 },
  { name: 'Hot hold',         kind: 'hot_hold', minC: 63,   maxC: null },
  { name: 'Cooking — core',   kind: 'cooking',  minC: 75,   maxC: null },
  { name: 'Chilled delivery', kind: 'delivery', minC: null, maxC: 8 },
]

export const CLEANING_PRESETS: Array<{ name: string; area: string; frequency: 'daily' | 'weekly' | 'monthly' }> = [
  { name: 'Sanitise prep surfaces',      area: 'Kitchen',   frequency: 'daily' },
  { name: 'Clean and sanitise chillers', area: 'Kitchen',   frequency: 'weekly' },
  { name: 'Degrease extraction hood',    area: 'Kitchen',   frequency: 'weekly' },
  { name: 'Deep clean fryers',           area: 'Kitchen',   frequency: 'weekly' },
  { name: 'Clean drains and grease trap', area: 'Kitchen',  frequency: 'monthly' },
  { name: 'Wash-room check',             area: 'Front',     frequency: 'daily' },
]

export function withinRange(readingC: number, minC: number | null, maxC: number | null): boolean {
  if (minC !== null && readingC < minC) return false
  if (maxC !== null && readingC > maxC) return false
  return true
}

const WINDOW_MS = { daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 30 * 86_400_000 } as const


/**
 * A unit or cleaning task may only sit at a location of its OWN company. The
 * client's locationId used to be stored unchecked, so a unit could be filed
 * against another company's kitchen. 422, and never confirms the id exists.
 */
async function assertLocationOf(tenantId: string, locationId: string | null | undefined): Promise<void> {
  if (!locationId) return
  const loc = await prisma.location.findFirst({ where: { id: locationId, tenantId, deletedAt: null }, select: { id: true } })
  if (!loc) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That location is not part of this company', 422)
}

export async function foodSafetyRoutes(fastify: FastifyInstance) {
  // GET /food-safety/summary — today at a glance.
  fastify.get('/summary', { preHandler: requireAuth(...KITCHEN_STAFF) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const since = new Date(Date.now() - 86_400_000)
    const [units, readings, tasks] = await Promise.all([
      prisma.foodSafetyUnit.findMany({
        where: { ...scope, isActive: true },
        include: { logs: { orderBy: { takenAt: 'desc' }, take: 1 } },
        orderBy: { name: 'asc' },
      }),
      prisma.temperatureLog.findMany({
        where: { ...scope, takenAt: { gte: since } },
        include: { unit: { select: { name: true, minC: true, maxC: true } } },
        orderBy: { takenAt: 'desc' },
        take: 200,
      }),
      prisma.cleaningTask.findMany({
        where: { ...scope, isActive: true },
        include: { logs: { orderBy: { doneAt: 'desc' }, take: 1 } },
        orderBy: { name: 'asc' },
      }),
    ])
    const now = Date.now()
    const cleaning = tasks.map((t) => {
      const last = t.logs[0]?.doneAt ?? null
      const window = WINDOW_MS[t.frequency as keyof typeof WINDOW_MS] ?? WINDOW_MS.daily
      return { ...t, lastDoneAt: last, due: !last || now - last.getTime() >= window }
    })
    return {
      units: units.map((u) => ({
        ...u,
        lastReading: u.logs[0] ?? null,
        // A unit nobody has checked today is its own warning.
        checkedToday: !!u.logs[0] && u.logs[0].takenAt >= since,
      })),
      readings,
      outOfRangeToday: readings.filter((r) => !r.withinRange).length,
      cleaning,
      cleaningDue: cleaning.filter((c) => c.due).length,
      presets: { units: PRESETS, cleaning: CLEANING_PRESETS },
    }
  })

  // ── Units ──────────────────────────────────────────────────────────────
  const unitSchema = z.object({
    name: z.string().min(1).max(80),
    kind: z.enum(KINDS),
    minC: z.number().min(-50).max(300).nullable(),
    maxC: z.number().min(-50).max(300).nullable(),
    locationId: z.string().uuid().nullable().optional(),
  }).refine((u) => u.minC === null || u.maxC === null || u.minC <= u.maxC, { message: 'Minimum must not exceed maximum' })

  fastify.post('/units', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = unitSchema.parse(req.body)
    const tenantId = activeTenantId(req)
    await assertLocationOf(tenantId, body.locationId)
    const unit = await prisma.foodSafetyUnit.create({ data: { ...body, locationId: body.locationId ?? null, tenantId } })
    return reply.status(201).send(unit)
  })

  fastify.post('/units/presets', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const tenantId = activeTenantId(req)
    const existing = new Set((await prisma.foodSafetyUnit.findMany({ where: { tenantId }, select: { name: true } })).map((u) => u.name))
    const toAdd = PRESETS.filter((p) => !existing.has(p.name))
    if (toAdd.length) await prisma.foodSafetyUnit.createMany({ data: toAdd.map((p) => ({ ...p, tenantId })) })
    return reply.status(201).send({ added: toAdd.length })
  })

  fastify.patch<{ Params: { id: string } }>('/units/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      name: z.string().min(1).max(80).optional(),
      minC: z.number().min(-50).max(300).nullable().optional(),
      maxC: z.number().min(-50).max(300).nullable().optional(),
      isActive: z.boolean().optional(),
      locationId: z.string().uuid().nullable().optional(),
    }).parse(req.body)
    const unit = await prisma.foodSafetyUnit.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!unit) throw new NotFoundError('FoodSafetyUnit', req.params.id)
    await assertLocationOf(unit.tenantId, body.locationId)
    return prisma.foodSafetyUnit.update({ where: { id: unit.id }, data: body })
  })

  // ── Temperature readings ──────────────────────────────────────────────
  fastify.post('/temperatures', { preHandler: requireAuth(...KITCHEN_STAFF) }, async (req, reply) => {
    const body = z.object({
      unitId: z.string().uuid(),
      readingC: z.number().min(-60).max(350),
      correctiveAction: z.string().max(500).optional(),
      note: z.string().max(500).optional(),
    }).parse(req.body)
    const unit = await prisma.foodSafetyUnit.findFirst({ where: { id: body.unitId, isActive: true, ...(await scopeTenantWhere(req, 'write')) } })
    if (!unit) throw new NotFoundError('FoodSafetyUnit', body.unitId)

    const ok = withinRange(body.readingC, unit.minC, unit.maxC)
    if (!ok && !body.correctiveAction?.trim()) {
      throw new AppError(
        'CORRECTIVE_ACTION_REQUIRED',
        `${body.readingC}°C is outside the limit for ${unit.name}. Record what you did about it before saving.`,
        400,
      )
    }
    const log = await prisma.temperatureLog.create({
      data: {
        tenantId: unit.tenantId, unitId: unit.id, readingC: body.readingC, withinRange: ok,
        correctiveAction: body.correctiveAction?.trim() || null, note: body.note?.trim() || null,
        takenById: req.staffUser!.id,
      },
    })
    if (!ok) {
      const { flagException } = await import('../../lib/exceptions.js')
      await flagException({
        kind: 'food_safety_temperature',
        severity: 'high',
        title: `${unit.name} read ${body.readingC}°C`,
        description: `Outside the limit (${unit.minC ?? '—'} to ${unit.maxC ?? '—'}°C). Action taken: ${log.correctiveAction}`,
        actorId: req.staffUser!.id,
        metadata: { unitId: unit.id, logId: log.id, readingC: body.readingC },
      }).catch(() => { /* a flag failing must not lose the reading */ })
    }
    return reply.status(201).send(log)
  })

  fastify.get<{ Querystring: { days?: string; unitId?: string } }>('/temperatures', { preHandler: requireAuth(...KITCHEN_STAFF) }, async (req) => {
    const days = Math.min(Math.max(parseInt(req.query.days ?? '7', 10) || 7, 1), 90)
    return prisma.temperatureLog.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'read')),
        takenAt: { gte: new Date(Date.now() - days * 86_400_000) },
        ...(req.query.unitId && { unitId: req.query.unitId }),
      },
      include: { unit: { select: { name: true, minC: true, maxC: true } } },
      orderBy: { takenAt: 'desc' },
      take: 1000,
    })
  })

  // ── Cleaning ───────────────────────────────────────────────────────────
  fastify.post('/cleaning/tasks', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(120),
      area: z.string().max(80).optional(),
      frequency: z.enum(['daily', 'weekly', 'monthly']),
      locationId: z.string().uuid().nullable().optional(),
    }).parse(req.body)
    const tenantId = activeTenantId(req)
    await assertLocationOf(tenantId, body.locationId)
    const task = await prisma.cleaningTask.create({
      data: { ...body, area: body.area || null, locationId: body.locationId ?? null, tenantId },
    })
    return reply.status(201).send(task)
  })

  fastify.post('/cleaning/presets', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const tenantId = activeTenantId(req)
    const existing = new Set((await prisma.cleaningTask.findMany({ where: { tenantId }, select: { name: true } })).map((t) => t.name))
    const toAdd = CLEANING_PRESETS.filter((p) => !existing.has(p.name))
    if (toAdd.length) await prisma.cleaningTask.createMany({ data: toAdd.map((p) => ({ ...p, tenantId })) })
    return reply.status(201).send({ added: toAdd.length })
  })

  fastify.patch<{ Params: { id: string } }>('/cleaning/tasks/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      name: z.string().min(1).max(120).optional(),
      area: z.string().max(80).nullable().optional(),
      frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
      isActive: z.boolean().optional(),
      locationId: z.string().uuid().nullable().optional(),
    }).parse(req.body)
    const task = await prisma.cleaningTask.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!task) throw new NotFoundError('CleaningTask', req.params.id)
    await assertLocationOf(task.tenantId, body.locationId)
    return prisma.cleaningTask.update({ where: { id: task.id }, data: body })
  })

  fastify.post<{ Params: { id: string } }>('/cleaning/tasks/:id/done', { preHandler: requireAuth(...KITCHEN_STAFF) }, async (req, reply) => {
    const body = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {})
    const task = await prisma.cleaningTask.findFirst({ where: { id: req.params.id, isActive: true, ...(await scopeTenantWhere(req, 'write')) } })
    if (!task) throw new NotFoundError('CleaningTask', req.params.id)
    const log = await prisma.cleaningLog.create({
      data: { tenantId: task.tenantId, taskId: task.id, doneById: req.staffUser!.id, note: body.note?.trim() || null },
    })
    return reply.status(201).send(log)
  })
}
