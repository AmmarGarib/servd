import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned, resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { emitItem86d } from '../../lib/ws.js'
import { seedAvailability } from '../../lib/reservation.js'

const createItemSchema = z.object({
  conceptId: z.string().uuid(),
  categoryId: z.string().uuid(),
  name: z.string().min(1),
  nameUrdu: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  instructionsUrdu: z.string().optional(),
  priceCents: z.number().int().min(0),
  // The item code / SKU the till searches by (till flow, 2026-10-20). Unique per brand (409 ITEM_CODE_TAKEN).
  itemCode: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._\-]+$/, 'Letters, digits, dot, dash or underscore').nullable().optional(),
  imageUrl: z.string().url().optional(),
  // Looping video shown in place of the image on the storefront menu.
  // Both fields are independent — operator can set either, neither, or
  // both (storefront prefers video). Either MP4 or WebM is fine; .mov
  // / proprietary formats won't autoplay in mobile Safari.
  videoUrl: z.string().url().optional(),
  isAvailable: z.boolean().default(true),
  displayOrder: z.number().int().default(0),
  stationId: z.string().uuid().nullable().optional(),
  portionsAvailable: z.number().int().min(0).nullable().optional(),
  taxClassification: z.enum(['standard', 'zero_rated', 'exempt', 'custom']).optional(),
  overrideTaxRate: z.number().min(0).max(100).nullable().optional(),
  allergens:  z.array(z.string().max(40)).max(20).optional(),
  dietary:    z.array(z.string().max(40)).max(20).optional(),
  spiceLevel: z.number().int().min(0).max(5).nullable().optional(),
})

const updateItemSchema = createItemSchema.partial()

/**
 * The recipe gate (owner, 2026-10-24): a dish may be switched ON (or created
 * live) only when its plate recipe is approved — Recipe.status 'production'.
 * 422 RECIPE_NOT_APPROVED otherwise. Items already live without one stay live
 * (only the switch-on is checked); GET /menu/items/live-without-recipe lists them.
 */
async function assertRecipeApprovedForLive(menuItemId: string | null, liveAtRecipeGate = false): Promise<void> {
  // Grandfathered: live at go-live with no approved recipe (MenuItem.liveAtRecipeGate, set once by the migration).
  if (liveAtRecipeGate) return
  const ok = menuItemId
    ? await prisma.recipe.findFirst({ where: { menuItemId, kind: 'plate', status: 'production' }, select: { id: true } })
    : null
  if (!ok) {
    throw new AppError('RECIPE_NOT_APPROVED', 'A dish goes live only once its recipe is approved — submit the recipe for approval first', 422)
  }
}

const createCategorySchema = z.object({
  conceptId: z.string().uuid(),
  name: z.string().min(1),
  sortOrder: z.number().int().default(0),
  timeRestrictionStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  timeRestrictionEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  // Sub-category (2026-10-22): the top-level category of the same brand it sits under; null = top level.
  parentId: z.string().min(1).max(100).nullable().optional(), // resolved inside the brand (assertParentOk)
})

/**
 * A sub-category's parent: a live, TOP-LEVEL category of the same brand, never
 * itself, and only for a category with no sub-categories of its own (one
 * level). Another brand's or company's category reads as not found (422).
 */
async function assertParentOk(conceptId: string, parentId: string | null | undefined, selfId?: string): Promise<void> {
  if (!parentId) return
  if (parentId === selfId) throw new AppError('PARENT_IS_SELF', 'A category cannot sit under itself', 422)
  const parent = await prisma.category.findFirst({ where: { id: parentId, conceptId, deletedAt: null }, select: { parentId: true } })
  if (!parent) throw new AppError('PARENT_NOT_IN_BRAND', 'Pick a category of the same brand to put this under', 422)
  if (parent.parentId) throw new AppError('PARENT_IS_SUBCATEGORY', 'A sub-category cannot have sub-categories of its own — pick a main category', 422)
  if (selfId && await prisma.category.count({ where: { parentId: selfId, deletedAt: null } })) {
    throw new AppError('CATEGORY_HAS_SUBCATEGORIES', 'This category has sub-categories of its own, so it cannot go under another one', 422)
  }
}

/** The partial unique index (one live name per brand) → 409, not a 500. */
async function createSessionOr409<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    if ((e as { code?: string }).code === 'P2002' || /menu_sessions_concept_name_active/.test(String((e as Error).message))) {
      throw new AppError('SESSION_NAME_TAKEN', 'This brand already has a session with that name', 409)
    }
    throw e
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const sessionSchema = z.object({
  conceptId: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  startTime: z.string().regex(HHMM, 'Use HH:MM, 24-hour'),
  endTime: z.string().regex(HHMM, 'Use HH:MM, 24-hour'),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
})
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
/** The minutes of the day a session covers, as [from, to) spans (one, or two when it runs past midnight). */
function spansOf(start: string, end: string): Array<[number, number]> {
  const a = minutesOf(start), b = minutesOf(end)
  return a < b ? [[a, b]] : [[a, 1440], [0, b]]
}
/** 409 SESSION_NAME_TAKEN when another live session of the brand has the name (any case); the partial unique index backs it. */
async function assertNameFree(conceptId: string, name: string, selfId?: string): Promise<void> {
  const clash = await prisma.menuSession.findFirst({ where: { conceptId, isActive: true, name: { equals: name.trim(), mode: 'insensitive' }, ...(selfId && { id: { not: selfId } }) }, select: { id: true } })
  if (clash) throw new AppError('SESSION_NAME_TAKEN', 'This brand already has a session with that name', 409)
}

/** 422 SESSION_OVERLAP when the times cross another live session of the brand. */
async function assertNoOverlap(conceptId: string, start: string, end: string, selfId?: string): Promise<void> {
  const others = await prisma.menuSession.findMany({ where: { conceptId, isActive: true, ...(selfId && { id: { not: selfId } }) } })
  const mine = spansOf(start, end)
  for (const o of others) {
    if (spansOf(o.startTime, o.endTime).some(([a, b]) => mine.some(([c, d]) => a < d && c < b))) {
      throw new AppError('SESSION_OVERLAP', `These times overlap "${o.name}" (${o.startTime}–${o.endTime}). Sessions of a brand cannot overlap.`, 422)
    }
  }
}

const createModifierGroupSchema = z.object({
  menuItemId: z.string().uuid(),
  name: z.string().min(1),
  minSelect: z.number().int().min(0).default(0),
  maxSelect: z.number().int().min(1).default(1),
  isRequired: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  modifiers: z.array(
    z.object({
      name: z.string().min(1),
      priceDeltaCents: z.number().int().default(0),
      isDefault: z.boolean().default(false),
      sortOrder: z.number().int().default(0),
    }),
  ),
})

// ── Brand integrity ──────────────────────────────────────────────────────────
// A menu item lives under ONE brand, and its category and station must be that
// brand's own. The item/category schemas used to be written straight through,
// so a PATCH could move an item (or a category) into another company's brand,
// or point it at a foreign category or station.

/** 422 unless `categoryId` is a live category of `conceptId`. */
async function assertCategoryOf(conceptId: string, categoryId: string): Promise<void> {
  const cat = await prisma.category.findFirst({
    where: { id: categoryId, conceptId, deletedAt: null },
    select: { id: true },
  })
  if (!cat) throw new AppError('CATEGORY_NOT_IN_BRAND', 'That category is not part of this brand', 422)
}

/**
 * 422 unless `stationId` is a live station of `conceptId`: the brand's own,
 * not deleted and not switched off. A retired station is on no kitchen
 * screen, so a dish routed there is cooked by nobody (2026-10-10 audit,
 * BOH-03) — STATION_NOT_LIVE says so instead of "not part of this brand".
 */
async function assertStationOf(conceptId: string, stationId: string): Promise<void> {
  const st = await prisma.station.findFirst({
    where: { id: stationId, conceptId },
    select: { id: true, name: true, isActive: true, deletedAt: true },
  })
  if (!st) throw new AppError('STATION_NOT_IN_BRAND', 'That station is not part of this brand', 422)
  if (st.deletedAt || !st.isActive) {
    throw new AppError(
      'STATION_NOT_LIVE',
      `${st.name} has been ${st.deletedAt ? 'deleted' : 'switched off'}, so no kitchen screen shows it. Pick a station the kitchen is using.`,
      422,
    )
  }
}

/** An item code is unique per brand (case-insensitive) — 409 ITEM_CODE_TAKEN (till flow, 2026-10-20). */
async function assertItemCodeFree(conceptId: string, itemCode: string, exceptId: string | null): Promise<void> {
  const clash = await prisma.menuItem.findFirst({
    where: { conceptId, itemCode: { equals: itemCode, mode: 'insensitive' }, ...(exceptId && { id: { not: exceptId } }) },
    select: { id: true, name: true },
  })
  if (clash) throw new AppError('ITEM_CODE_TAKEN', `The code ${itemCode} is already used by "${clash.name}" on this brand`, 409)
}

/** A row's brand never changes from an edit; resending the same id is fine. */
function assertSameConcept(current: string, requested: string | undefined): void {
  if (requested !== undefined && requested !== current) {
    throw new AppError('CONCEPT_IMMUTABLE', 'An item or category cannot be moved to another brand — create it there instead', 422)
  }
}

export async function menuRoutes(fastify: FastifyInstance) {
  // GET /menu/:conceptId — full menu tree (staff/internal only)
  fastify.get<{ Params: { conceptId: string } }>(
    '/:conceptId',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      // Tenant scope: requested concept must belong to the active tenant.
      const concept = await prisma.concept.findFirst({
        where: { id: req.params.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!concept) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Concept not found in your active company' } })
      const categories = await prisma.category.findMany({
        where: { conceptId: req.params.conceptId, deletedAt: null, isActive: true },
        orderBy: { sortOrder: 'asc' },
        include: {
          items: {
            where: { deletedAt: null },
            orderBy: { displayOrder: 'asc' },
            include: {
              modifierGroups: {
                where: { deletedAt: null },
                orderBy: { sortOrder: 'asc' },
                include: {
                  modifiers: {
                    where: { deletedAt: null },
                    orderBy: { sortOrder: 'asc' },
                  },
                },
              },
            },
          },
        },
      })
      return categories
    },
  )

  // GET /menu/items — flat list for internal tools (recipe builder etc.)
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/items',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      return prisma.menuItem.findMany({
        where: {
          deletedAt: null,
          // Tenant scope via concept relation
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
          ...(req.query.conceptId && { conceptId: req.query.conceptId }),
        },
        select: {
          id: true,
          name: true,
          priceCents: true,
          conceptId: true,
          concept: { select: { name: true } },
        },
        orderBy: [{ conceptId: 'asc' }, { name: 'asc' }],
      })
    },
  )

  // POST /menu/items — the brand must be one of the ACTIVE company's, and the
  // category and station must be that brand's.
  fastify.post('/items', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    // Recipe gate (owner, 2026-10-24): a dish goes live only once its recipe is approved (production). A new item has
    // no recipe yet, so it is created switched off; asking for it live is 422 RECIPE_NOT_APPROVED.
    const live = (req.body as { isAvailable?: unknown } | null)?.isAvailable === true
    if (live) await assertRecipeApprovedForLive(null)
    const body = { ...createItemSchema.parse(req.body), isAvailable: false }
    await assertConceptOwned(req, body.conceptId, 'create')
    await assertCategoryOf(body.conceptId, body.categoryId)
    if (body.stationId) await assertStationOf(body.conceptId, body.stationId)
    if (body.itemCode) await assertItemCodeFree(body.conceptId, body.itemCode, null)
    const item = await prisma.menuItem.create({ data: body })
    return reply.status(201).send(item)
  })

  // PATCH /menu/items/:id
  fastify.patch<{ Params: { id: string } }>(
    '/items/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = updateItemSchema.parse(req.body)
      const item = await prisma.menuItem.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!item) throw new NotFoundError('MenuItem', req.params.id)
      // The item stays under its brand; a new category or station must be
      // that brand's own.
      const { conceptId, ...data } = body
      assertSameConcept(item.conceptId, conceptId)
      if (data.categoryId) await assertCategoryOf(item.conceptId, data.categoryId)
      if (data.stationId) await assertStationOf(item.conceptId, data.stationId)
      if (data.itemCode) await assertItemCodeFree(item.conceptId, data.itemCode, item.id)
      if (data.isAvailable === true && !item.isAvailable) await assertRecipeApprovedForLive(item.id, item.liveAtRecipeGate)
      const updated = await prisma.menuItem.update({ where: { id: req.params.id }, data })
      // Seed Redis availability whenever portionsAvailable is set
      if (typeof body.portionsAvailable === 'number') {
        await seedAvailability(req.params.id, body.portionsAvailable)
      }
      return updated
    },
  )

  // GET /menu/items/live-without-recipe — dishes on sale with no approved
  // (production) recipe: live before the recipe gate (2026-10-24), never
  // switched off by it. The recipes page lists them. Companies in view only.
  fastify.get<{ Querystring: { conceptId?: string } }>('/items/live-without-recipe', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    if (req.query.conceptId) await assertConceptOwned(req, req.query.conceptId, 'read')
    const { tenantIds } = await resolveTenantScope(req)
    return prisma.menuItem.findMany({
      where: {
        deletedAt: null, isAvailable: true,
        concept: { tenantId: { in: tenantIds }, deletedAt: null },
        ...(req.query.conceptId ? { conceptId: req.query.conceptId } : {}),
        NOT: { recipe: { is: { status: 'production' } } },
      },
      select: { id: true, name: true, conceptId: true, concept: { select: { name: true } }, recipe: { select: { id: true, status: true } } },
      orderBy: [{ conceptId: 'asc' }, { name: 'asc' }],
    })
  })

  // PATCH /menu/items/:id/availability — 86 an item
  fastify.patch<{ Params: { id: string }; Body: { isAvailable: boolean } }>(
    '/items/:id/availability',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { isAvailable } = z.object({ isAvailable: z.boolean() }).parse(req.body)
      const item = await prisma.menuItem.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!item) throw new NotFoundError('MenuItem', req.params.id)
      if (isAvailable && !item.isAvailable) await assertRecipeApprovedForLive(item.id, item.liveAtRecipeGate)

      const updated = await prisma.menuItem.update({
        where: { id: req.params.id },
        data: {
          isAvailable,
          // Clear sync timestamp so the inventorySync worker picks up the
          // change on its next tick (both directions — 86 and un-86).
          lastSyncedAt: null,
        },
      })

      // Broadcast 86 event to all KDS clients
      emitItem86d(item.id, item.conceptId, isAvailable)

      return updated
    },
  )

  // DELETE /menu/items/:id — soft delete + a Trash entry (one transaction).
  // Restore / "delete forever" live in the Trash (modules/trash).
  fastify.delete<{ Params: { id: string } }>(
    '/items/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.menuItem.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
        include: { concept: { select: { tenantId: true } } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Item not found in your active company' } })
      await prisma.$transaction(async (tx) => {
        await moveToTrash(tx, req, {
          type: 'menu_item', entityId: owned.id, tenantId: owned.concept.tenantId, conceptId: owned.conceptId,
          title: owned.name, parent: { type: 'category', id: owned.categoryId }, reason: trashReasonOf(req),
        })
        await tx.menuItem.update({ where: { id: owned.id }, data: { deletedAt: new Date() } })
      })
      return reply.status(204).send()
    },
  )

  // ─── Categories ────────────────────────────────────────────────────────────

  fastify.post('/categories', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createCategorySchema.parse(req.body)
    // CREATE pins to the operator's ACTIVE company; PATCH/DELETE on existing
    // rows below use memberTenantIds because the operator might be editing a
    // row in a company that isn't their primary (head-office staff servicing
    // multiple restaurants — common pattern for procurement + finance).
    await assertConceptOwned(req, body.conceptId, 'create')
    await assertParentOk(body.conceptId, body.parentId)
    const category = await prisma.category.create({ data: body })
    return reply.status(201).send(category)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/categories/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = createCategorySchema.partial().parse(req.body)
      const owned = await prisma.category.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          concept: { tenantId: { in: req.staffUser!.memberTenantIds }, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in a company you have access to' } })
      const { conceptId, ...data } = body
      assertSameConcept(owned.conceptId, conceptId)
      if (data.parentId !== undefined) await assertParentOk(owned.conceptId, data.parentId, owned.id)
      return prisma.category.update({ where: { id: req.params.id }, data })
    },
  )

  // DELETE /menu/categories/:id — soft-delete a category. Refuses if the
  // category still has live menu items so the operator clears them first
  // (otherwise the storefront would show orphans). Soft-deletes any items
  // ALREADY soft-deleted are ignored — we only count active items.
  fastify.delete<{ Params: { id: string } }>(
    '/categories/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.category.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          concept: { tenantId: { in: req.staffUser!.memberTenantIds }, deletedAt: null },
        },
        include: { _count: { select: { items: { where: { deletedAt: null } }, children: { where: { deletedAt: null } } } }, concept: { select: { tenantId: true } } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in a company you have access to' } })
      if (owned._count.items > 0) {
        return reply.status(409).send({ error: {
          code: 'CATEGORY_NOT_EMPTY',
          message: `Delete or move the ${owned._count.items} item(s) in this category first.`,
        }})
      }
      if (owned._count.children > 0) {
        return reply.status(409).send({ error: {
          code: 'CATEGORY_HAS_SUBCATEGORIES',
          message: `Delete or move the ${owned._count.children} sub-categor${owned._count.children === 1 ? 'y' : 'ies'} under this category first.`,
        }})
      }
      await prisma.$transaction(async (tx) => {
        await moveToTrash(tx, req, {
          type: 'category', entityId: owned.id, tenantId: owned.concept.tenantId, conceptId: owned.conceptId,
          title: owned.name, reason: trashReasonOf(req),
        })
        await tx.category.update({ where: { id: owned.id }, data: { deletedAt: new Date() } })
      })
      return reply.status(204).send()
    },
  )

  // ─── Sales sessions (2026-10-22) ───────────────────────────────────────────
  // Per brand. Read by anyone who reads the brand's menu (the till's reports
  // read them too); written by managers. No delete: switch a session off.

  fastify.get<{ Querystring: { conceptId?: string } }>('/sessions', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { conceptId } = z.object({ conceptId: z.string().uuid() }).parse(req.query)
    await assertConceptOwned(req, conceptId, 'read')
    return prisma.menuSession.findMany({ where: { conceptId }, orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { startTime: 'asc' }] })
  })

  fastify.post('/sessions', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = sessionSchema.parse(req.body)
    const concept = await assertConceptOwned(req, body.conceptId, 'create')
    if (body.startTime === body.endTime) throw new AppError('SESSION_EMPTY', 'Start and end cannot be the same time', 422)
    if (body.isActive) { await assertNameFree(body.conceptId, body.name); await assertNoOverlap(body.conceptId, body.startTime, body.endTime) }
    if (!concept.tenantId) throw new AppError('BRAND_HAS_NO_COMPANY', 'This brand has no company yet', 422)
    const tenantId = concept.tenantId
    const row = await createSessionOr409(() => prisma.menuSession.create({ data: { ...body, tenantId } }))
    return reply.status(201).send(row)
  })

  fastify.patch<{ Params: { id: string } }>('/sessions/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = sessionSchema.partial().parse(req.body)
    const owned = await prisma.menuSession.findFirst({ where: { id: req.params.id, tenantId: { in: req.staffUser!.memberTenantIds } } })
    if (!owned) throw new NotFoundError('Session', req.params.id)
    const { conceptId, ...data } = body
    assertSameConcept(owned.conceptId, conceptId)
    const next = { ...owned, ...data }
    if (next.startTime === next.endTime) throw new AppError('SESSION_EMPTY', 'Start and end cannot be the same time', 422)
    if (next.isActive) { await assertNameFree(owned.conceptId, next.name, owned.id); await assertNoOverlap(owned.conceptId, next.startTime, next.endTime, owned.id) }
    return createSessionOr409(() => prisma.menuSession.update({ where: { id: owned.id }, data }))
  })

  // ─── Modifier groups ───────────────────────────────────────────────────────

  fastify.post('/modifier-groups', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createModifierGroupSchema.parse(req.body)
    const ownedItem = await prisma.menuItem.findFirst({
      where: {
        id: body.menuItemId,
        deletedAt: null,
        concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      },
    })
    if (!ownedItem) throw new NotFoundError('MenuItem', body.menuItemId)
    const { modifiers, ...groupData } = body
    const group = await prisma.modifierGroup.create({
      data: { ...groupData, modifiers: { create: modifiers } },
      include: { modifiers: true },
    })
    return reply.status(201).send(group)
  })

  fastify.delete<{ Params: { id: string } }>(
    '/modifier-groups/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.modifierGroup.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          menuItem: { concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        },
        include: { menuItem: { select: { name: true, conceptId: true, concept: { select: { tenantId: true } } } } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Modifier group not found in your active company' } })
      await prisma.$transaction(async (tx) => {
        await moveToTrash(tx, req, {
          type: 'modifier_group', entityId: owned.id, tenantId: owned.menuItem.concept.tenantId, conceptId: owned.menuItem.conceptId,
          title: owned.name, subtitle: owned.menuItem.name, parent: { type: 'menu_item', id: owned.menuItemId }, reason: trashReasonOf(req),
        })
        await tx.modifierGroup.update({ where: { id: owned.id }, data: { deletedAt: new Date() } })
      })
      return reply.status(204).send()
    },
  )

}
