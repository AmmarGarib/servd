// Operations → Ingredients: servd's ONE ingredient master (owner, 2026-10-26 — kitchen flow K1, K2, K3, K6).
//
// SERVD-WIDE by the owner's decision: a master row has NO company (lib/ingredientMaster.ts). It is a definition only —
// name, stock unit, category, allergens, yield %, buying unit + factor and the SPEC (what we buy: "burger meat = 80/20,
// coarse ground"). Price, supplier, par and stock stay on each company's own InventoryItem (masterIngredientId), and
// nothing here reads or returns another company's item: the list says only whether the CALLER's active company stocks
// it (`companyItemId`).
//
//   GET    /ingredient-master?q&status&limit   search (server-side; the recipe picker and the Ingredients page).
//                                              Any staff with recipes / inventory / procurement / par_sheet.
//   GET    /ingredient-master/:id
//   POST   /ingredient-master                  add a new one → 'needs_review' (K2). Dedupe by normalised name: an
//                                              existing live row is returned (200, existing: true). Recipe editors
//                                              (MANAGERS) and the buyer.
//   PATCH  /ingredient-master/:id              fix the definition: name, spec, allergens, yield, buying unit =
//                                              MASTER_EDITORS (the recipe editors); category, unit and marking it
//                                              reviewed = MASTER_REVIEWERS (CEO / fnb_manager) only, and a category
//                                              change needs the editor in every company that stocks it (409
//                                              MASTER_CATEGORY_NEEDS_MEMBERSHIP).
//                                              Changes reach every linked company item: allergens, yield, buying unit
//                                              at once; a category change moves each company's lots to the new cost
//                                              class through the inventory reclass (its own posting per company); a
//                                              unit change only while no linked item has stock history or a recipe
//                                              line (409 MASTER_UNIT_IN_USE).
//   POST   /ingredient-master/:id/merge {intoId}  reviewers only: the duplicate's company items move to the kept
//                                              row, which it now points at (mergedIntoId — never deleted). A company
//                                              that already stocks BOTH is never merged automatically: 409
//                                              MERGE_NEEDS_STOCK_MERGE lists those items (a person merges the stock).
//                                              The merge NEVER posts: units of different families are 409
//                                              MERGE_UNIT_MISMATCH, different categories 409 MERGE_CATEGORY_MISMATCH.
// Every write is audited (entity IngredientMaster, no company — platform data).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { Prisma, type UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS, PROCUREMENT_TEAM } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { INVENTORY_CATEGORIES } from '../../lib/inventoryClass.js'
import { audit } from '../../lib/audit.js'
import { ensureFifoReady, lockItemsTx } from '../../lib/stockLedger.js'
import { cleanIngredientName, factorForItemUnit, findOrCreateMasterTx, normalizeIngredientName, sameUnitFamily, unitFamily } from '../../lib/ingredientMaster.js'
import { moveItemLotsToCategoryTx } from '../inventory/routes.js'

/** Who fixes a master definition: the recipe editors (POST/PUT /recipes are MANAGERS). */
export const MASTER_EDITORS = MANAGERS
/** Who marks a new ingredient reviewed and merges duplicates (K2): the CEO and the F&B manager. */
export const MASTER_REVIEWERS = ['admin', 'fnb_manager'] as UserRole[]
/** Who adds a new ingredient: the recipe editors and the buyer. */
const MASTER_CREATORS = PROCUREMENT_TEAM
const READ_MODULES = ['recipes', 'inventory', 'procurement', 'par_sheet'] as const

const specFields = z.record(z.string().trim().min(1).max(60), z.string().trim().max(300)).refine((o) => Object.keys(o).length <= 30, 'At most 30 spec fields')

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(20),
  category: z.enum(INVENTORY_CATEGORIES).nullable().optional(),
  allergens: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  yieldPct: z.number().gt(0).max(100).optional(),
  purchaseUnit: z.string().trim().max(30).nullable().optional(),
  purchaseUnitFactor: z.number().positive().max(1_000_000).optional(),
  spec: z.string().trim().max(2000).nullable().optional(),
  specFields: specFields.nullable().optional(),
})
const patchSchema = createSchema.partial().extend({ status: z.enum(['approved', 'needs_review']).optional() })

type MasterDb = Prisma.IngredientMasterGetPayload<object>

/** The caller's ACTIVE company's linked stock item per master (never another company's). */
async function companyItems(req: FastifyRequest, masterIds: string[]): Promise<Map<string, string>> {
  const tenantId = req.staffUser!.tenantId
  if (!tenantId || masterIds.length === 0) return new Map()
  const rows = await prisma.inventoryItem.findMany({
    where: { tenantId, masterIngredientId: { in: masterIds }, deletedAt: null }, select: { id: true, masterIngredientId: true },
  })
  return new Map(rows.map((r) => [r.masterIngredientId!, r.id]))
}

function shape(m: MasterDb, companyItemId: string | null) {
  return {
    id: m.id, name: m.name, stockUnit: m.stockUnit, category: m.category, allergens: m.allergens, yieldPct: m.yieldPct,
    purchaseUnit: m.purchaseUnit, purchaseUnitFactor: m.purchaseUnitFactor, spec: m.spec, specFields: m.specFields,
    status: m.status, mergedIntoId: m.mergedIntoId, createdAt: m.createdAt, updatedAt: m.updatedAt,
    companyItemId,
  }
}

async function loadLive(id: string): Promise<MasterDb> {
  const m = await prisma.ingredientMaster.findUnique({ where: { id } })
  if (!m) throw new NotFoundError('IngredientMaster', id)
  return m
}

export async function ingredientMasterRoutes(fastify: FastifyInstance) {
  const readers = { preHandler: [requireAuth(...ALL_STAFF), requireModule(...READ_MODULES)] }

  fastify.get<{ Querystring: { q?: string; status?: string; limit?: string } }>('/', readers, async (req) => {
    const q = normalizeIngredientName(req.query.q ?? '')
    const status = req.query.status === 'needs_review' || req.query.status === 'approved' ? req.query.status : undefined
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '30', 10) || 30, 1), 500)
    const rows = await prisma.ingredientMaster.findMany({
      where: { mergedIntoId: null, ...(status ? { status } : {}), ...(q ? { normalizedName: { contains: q } } : {}) },
      orderBy: [{ name: 'asc' }],
      take: limit,
    })
    // Names that start with the query first (what a cook typing "chick" wants), then the rest.
    if (q) rows.sort((a, b) => Number(!a.normalizedName.startsWith(q)) - Number(!b.normalizedName.startsWith(q)))
    const mine = await companyItems(req, rows.map((r) => r.id))
    return rows.map((r) => shape(r, mine.get(r.id) ?? null))
  })

  fastify.get<{ Params: { id: string } }>('/:id', readers, async (req) => {
    const m = await loadLive(req.params.id)
    const mine = await companyItems(req, [m.id])
    return shape(m, mine.get(m.id) ?? null)
  })

  fastify.post('/', { preHandler: requireAuth(...MASTER_CREATORS) }, async (req, reply) => {
    const body = createSchema.parse(req.body)
    const { master, created } = await prisma.$transaction((tx) => findOrCreateMasterTx(tx, {
      ...body, specFields: body.specFields ?? null,
    }, { userId: req.staffUser!.id, tenantId: req.staffUser!.tenantId ?? null }, 'needs_review'))
    if (created) {
      await audit({
        category: 'identity', action: 'ingredient_master.create', entity: 'IngredientMaster', entityId: master.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: null,
        after: { name: master.name, stockUnit: master.stockUnit, status: master.status, createdInTenantId: req.staffUser!.tenantId ?? null },
      })
    }
    const mine = await companyItems(req, [master.id])
    return reply.status(created ? 201 : 200).send({ ...shape(master as MasterDb, mine.get(master.id) ?? null), existing: !created })
  })

  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MASTER_EDITORS) }, async (req) => {
    const body = patchSchema.parse(req.body)
    const before = await loadLive(req.params.id)
    if (before.mergedIntoId) throw new AppError('MASTER_MERGED', 'This ingredient was merged into another — edit that one', 409, { mergedIntoId: before.mergedIntoId })
    const isReviewer = (MASTER_REVIEWERS as string[]).includes(req.staffUser!.role)
    if (body.status !== undefined && body.status !== before.status && !isReviewer) {
      throw new ForbiddenError('Only the CEO or the F&B manager marks an ingredient reviewed')
    }
    // The master is kept in its family's base unit (g / ml / pcs): a unit of the same family is no change.
    const stockUnit = body.unit !== undefined ? unitFamily(body.unit).base : before.stockUnit
    const categoryChanges = body.category !== undefined && body.category !== before.category
    // Category and unit reach every company's books / stock: the CEO's and the F&B manager's only (owner review).
    if ((categoryChanges || stockUnit !== before.stockUnit) && !isReviewer) {
      throw new ForbiddenError('Only the CEO or the F&B manager changes an ingredient\'s category or unit')
    }
    // Buying unit + factor (owner review N3): reviewers only; a new buying unit must come with its factor. They reach
    // only the companies that buy in the master's buying unit — a company buying in its own unit ("bag") keeps it.
    const newPurchaseUnit = body.purchaseUnit !== undefined ? (body.purchaseUnit?.trim() || null) : before.purchaseUnit
    const buyingChanges = newPurchaseUnit !== before.purchaseUnit || (body.purchaseUnitFactor !== undefined && body.purchaseUnitFactor !== before.purchaseUnitFactor)
    if (buyingChanges && !isReviewer) throw new ForbiddenError('Only the CEO or the F&B manager changes how an ingredient is bought')
    if (newPurchaseUnit !== before.purchaseUnit && body.purchaseUnitFactor === undefined) {
      throw new AppError('FACTOR_REQUIRED', 'Give how many stock units one new buying unit holds (purchaseUnitFactor) with the new buying unit', 400)
    }
    const name = body.name !== undefined ? cleanIngredientName(body.name) : before.name
    const normalizedName = normalizeIngredientName(name)
    if (normalizedName !== before.normalizedName || stockUnit !== before.stockUnit) {
      const clash = await prisma.ingredientMaster.findFirst({ where: { id: { not: before.id }, mergedIntoId: null, normalizedName, stockUnit }, select: { id: true } })
      if (clash) throw new AppError('MASTER_NAME_TAKEN', `"${name}" in ${stockUnit} is already in servd's ingredients — merge the two instead`, 409, { existingId: clash.id })
    }
    const linked = await prisma.inventoryItem.findMany({
      where: { masterIngredientId: before.id, deletedAt: null }, select: { id: true, name: true, tenantId: true, category: true, unit: true, purchaseUnit: true },
    })
    if (categoryChanges) {
      // A category change posts a class move in EVERY company that stocks it — only an editor of all of them.
      const members = new Set(req.staffUser!.memberTenantIds ?? [])
      const outside = [...new Set(linked.map((i) => i.tenantId).filter((t): t is string => !!t && !members.has(t)))]
      if (outside.length > 0) {
        throw new AppError('MASTER_CATEGORY_NEEDS_MEMBERSHIP', `${outside.length} other compan${outside.length === 1 ? 'y stocks' : 'ies stock'} this ingredient — a category change books in each, so it needs someone who belongs to all of them`, 409, { companies: outside.length })
      }
    }
    const linkedIds = linked.map((i) => i.id)
    if (stockUnit !== before.stockUnit && linkedIds.length > 0) {
      // A unit change rescales every recipe quantity and every lot — only before anything was stocked or cooked.
      const [lots, lines, poLines] = await Promise.all([
        prisma.stockLot.count({ where: { inventoryItemId: { in: linkedIds } } }),
        prisma.recipeIngredient.count({ where: { inventoryItemId: { in: linkedIds } } }),
        prisma.purchaseOrderLine.count({ where: { inventoryItemId: { in: linkedIds } } }),
      ])
      const stocked = await prisma.inventoryItem.count({ where: { id: { in: linkedIds }, currentStock: { not: 0 } } })
      if (lots + lines + poLines + stocked > 0) {
        throw new AppError('MASTER_UNIT_IN_USE', 'Companies already stock, buy or cook this ingredient in its current unit — add a new ingredient in the new unit instead', 409)
      }
    }
    if (categoryChanges) {
      for (const t of new Set(linked.map((i) => i.tenantId).filter((x): x is string => !!x))) await ensureFifoReady(t)
    }
    const after = await prisma.$transaction(async (tx) => {
      const row = await tx.ingredientMaster.update({
        where: { id: before.id },
        data: {
          name, normalizedName, stockUnit,
          ...(body.category !== undefined && { category: body.category }),
          ...(body.allergens !== undefined && { allergens: body.allergens }),
          ...(body.yieldPct !== undefined && { yieldPct: body.yieldPct }),
          ...(body.purchaseUnit !== undefined && { purchaseUnit: body.purchaseUnit?.trim() || null }),
          ...(body.purchaseUnitFactor !== undefined && { purchaseUnitFactor: body.purchaseUnitFactor }),
          ...(body.spec !== undefined && { spec: body.spec?.trim() || null }),
          ...(body.specFields !== undefined && { specFields: body.specFields === null ? Prisma.DbNull : (body.specFields as Prisma.InputJsonValue) }),
          ...(body.status !== undefined && { status: body.status }),
        },
      })
      if (linkedIds.length > 0) {
        await tx.inventoryItem.updateMany({
          where: { id: { in: linkedIds } },
          data: {
            ...(body.allergens !== undefined && { allergens: body.allergens }),
            ...(body.yieldPct !== undefined && { yieldPct: body.yieldPct }),
            ...(stockUnit !== before.stockUnit && { unit: stockUnit }),
          },
        })
        // The buying unit + factor reach ONLY items that buy in the master's (old) buying unit; the factor is in base
        // units on the master and in each item's OWN unit on the item (kg vs g).
        if (buyingChanges) {
          for (const it of linked) {
            if ((it.purchaseUnit ?? null) !== (before.purchaseUnit ?? null)) continue
            await tx.inventoryItem.update({
              where: { id: it.id },
              data: {
                purchaseUnit: newPurchaseUnit,
                purchaseUnitFactor: factorForItemUnit(body.purchaseUnitFactor ?? before.purchaseUnitFactor, stockUnit !== before.stockUnit ? stockUnit : it.unit),
              },
            })
          }
        }
        if (categoryChanges) {
          // Each company's lots move to the new cost class with their own posting (the inventory reclass).
          await lockItemsTx(tx, linkedIds)
          for (const it of linked) {
            const fresh = await tx.inventoryItem.findUniqueOrThrow({ where: { id: it.id }, select: { tenantId: true, category: true } })
            if (fresh.tenantId) {
              await moveItemLotsToCategoryTx(tx, { itemId: it.id, itemName: it.name, tenantId: fresh.tenantId, fromCategory: fresh.category, toCategory: body.category ?? null, actor: req.staffUser! })
            }
            await tx.inventoryItem.update({ where: { id: it.id }, data: { category: body.category ?? null } })
          }
        }
      }
      return row
    }, { maxWait: 10_000, timeout: 60_000 })
    await audit({
      category: 'identity', action: 'ingredient_master.update', entity: 'IngredientMaster', entityId: before.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: null,
      before: { name: before.name, stockUnit: before.stockUnit, category: before.category, allergens: before.allergens, yieldPct: before.yieldPct, purchaseUnit: before.purchaseUnit, purchaseUnitFactor: before.purchaseUnitFactor, spec: before.spec, status: before.status },
      after: { name: after.name, stockUnit: after.stockUnit, category: after.category, allergens: after.allergens, yieldPct: after.yieldPct, purchaseUnit: after.purchaseUnit, purchaseUnitFactor: after.purchaseUnitFactor, spec: after.spec, status: after.status, linkedItems: linkedIds.length },
    })
    const mine = await companyItems(req, [after.id])
    return shape(after, mine.get(after.id) ?? null)
  })

  fastify.post<{ Params: { id: string } }>('/:id/merge', { preHandler: requireAuth(...MASTER_REVIEWERS) }, async (req) => {
    const { intoId } = z.object({ intoId: z.string().uuid() }).parse(req.body)
    if (intoId === req.params.id) throw new AppError('MERGE_SAME', 'Pick another ingredient to merge into', 422)
    const src = await loadLive(req.params.id)
    const dst = await loadLive(intoId)
    if (src.mergedIntoId) throw new AppError('MASTER_MERGED', 'This ingredient was already merged', 409, { mergedIntoId: src.mergedIntoId })
    if (dst.mergedIntoId) throw new AppError('MASTER_MERGED', 'The ingredient to keep was itself merged — pick the one it was merged into', 409, { mergedIntoId: dst.mergedIntoId })
    // A merge only re-points links — it never posts. So the two must already agree on what moves the books:
    // a unit of one family (kg ↔ g) and the same category (fix it first through the reviewer PATCH, which reclasses).
    if (!sameUnitFamily(src.stockUnit, dst.stockUnit)) {
      throw new AppError('MERGE_UNIT_MISMATCH', `${src.name} is kept in ${src.stockUnit} and ${dst.name} in ${dst.stockUnit} — not the same kind of unit`, 409)
    }
    if ((src.category ?? null) !== (dst.category ?? null)) {
      throw new AppError('MERGE_CATEGORY_MISMATCH', `Set ${src.name} to the same category as ${dst.name} first (that moves its stock to the right account), then merge`, 409)
    }
    const result = await prisma.$transaction(async (tx) => {
      const [srcItems, dstItems] = await Promise.all([
        tx.inventoryItem.findMany({ where: { masterIngredientId: src.id, deletedAt: null }, select: { id: true, name: true, tenantId: true } }),
        tx.inventoryItem.findMany({ where: { masterIngredientId: dst.id, deletedAt: null }, select: { id: true, name: true, tenantId: true } }),
      ])
      const dstByCompany = new Map(dstItems.map((i) => [i.tenantId, i]))
      const both = srcItems.filter((i) => dstByCompany.has(i.tenantId))
      if (both.length > 0) {
        // Two stock items of one ingredient in one company: never merged automatically — a person merges the stock.
        const members = new Set(req.staffUser!.memberTenantIds ?? [])
        throw new AppError(
          'MERGE_NEEDS_STOCK_MERGE',
          `${both.length} compan${both.length === 1 ? 'y stocks' : 'ies stock'} both ingredients — merge those stock items first, then merge here`,
          409,
          {
            companies: both.map((i) => members.has(i.tenantId ?? '')
              ? { tenantId: i.tenantId, items: [{ id: i.id, name: i.name }, { id: dstByCompany.get(i.tenantId)!.id, name: dstByCompany.get(i.tenantId)!.name }] }
              : { tenantId: null, items: [] }),
          },
        )
      }
      const moved = await tx.inventoryItem.updateMany({ where: { masterIngredientId: src.id }, data: { masterIngredientId: dst.id } })
      const lines = await repointRecipeLinesTx(tx, src.id, dst.id)
      // A stricter definition never gets lost: the kept row takes the duplicate's spec when it has none.
      await tx.ingredientMaster.update({
        where: { id: dst.id },
        data: { ...(dst.spec ? {} : src.spec ? { spec: src.spec } : {}), ...(dst.specFields == null && src.specFields != null ? { specFields: src.specFields as Prisma.InputJsonValue } : {}) },
      })
      await tx.ingredientMaster.update({ where: { id: src.id }, data: { mergedIntoId: dst.id } })
      return { itemsMoved: moved.count, recipeLinesMoved: lines }
    })
    await audit({
      category: 'identity', action: 'ingredient_master.merge', entity: 'IngredientMaster', entityId: src.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: null,
      before: { name: src.name, stockUnit: src.stockUnit }, after: { mergedIntoId: dst.id, into: dst.name, ...result },
    })
    return { mergedId: src.id, intoId: dst.id, ...result }
  })
}

/** Recipe lines that name the duplicate master by id follow it to the kept one (part B adds the column). */
async function repointRecipeLinesTx(tx: Prisma.TransactionClient, fromId: string, toId: string): Promise<number> {
  const r = await tx.$executeRaw`UPDATE recipe_ingredients SET "masterIngredientId" = ${toId} WHERE "masterIngredientId" = ${fromId}`
  return r
}
