// The servd-wide ingredient master (owner, 2026-10-26 — kitchen flow, K1–K3, K6).
//
// "Ingredient master is SERVD-WIDE (not per company). Definition is servd's; each company keeps its own PRICE,
// supplier, par/minimum and stock (its InventoryItem links to the master row)."
//
//   • IngredientMaster has NO tenantId — deliberately: it is platform data (see schema.prisma). It carries only the
//     definition: name, stock unit, category, allergens, yield %, buying unit + factor, and the SPEC (what we buy, K6).
//   • A company's stock item for a master is ITS InventoryItem (masterIngredientId) — one live item per master per
//     company (partial unique index inventory_items_tenant_master_live_key). ensureCompanyItemForMasterTx is THE way
//     one is found or made: picking an ingredient in a recipe (K3), POST /inventory/from-master, and a sale of a
//     shared recipe in a company that has never stocked it (lib/recipeCost.ts localiseGraph — lot-less, so the sale
//     records a shortfall and is never blocked).
//   • A new name typed by a chef joins the master AT ONCE as 'needs_review' (K2); a reviewer fixes or merges it.
//   • Prep items (kind 'prep') are never master rows.
//
// Every writer of the master lives in modules/ingredientMaster/routes.ts (+ this file's create helper).

import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { AppError, NotFoundError } from './errors.js'

type Db = Prisma.TransactionClient | typeof prisma

// The whitespace rule and the unit families live in lib/units.ts (THE unit rule, owner 2026-11-14) — re-exported here.
import { WS_CLASS, normalizeUnit, unitFamily, sameUnitFamily } from './units.js'
export { WS_CLASS, normalizeUnit, unitFamily, sameUnitFamily }
export type { UnitFamily } from './units.js'
const WS_EDGE = new RegExp(`^[${WS_CLASS}]+|[${WS_CLASS}]+$`, 'g')
const WS_RUN = new RegExp(`[${WS_CLASS}]+`, 'g')

/** The name as written: edges trimmed, inner whitespace runs → one space (case kept). */
export function cleanIngredientName(name: string): string {
  return name.replace(WS_EDGE, '').replace(WS_RUN, ' ')
}

/** The name as the master compares it: cleanIngredientName, lower case. */
export function normalizeIngredientName(name: string): string {
  return cleanIngredientName(name).toLowerCase()
}

/*
 * Unit FAMILIES (owner review, 2026-10-26: "kg↔g, l↔ml are ONE master"; owner 2026-11-14: items = pcs, g ≠ ml). A
 * master is kept in its family's BASE unit (g / ml / pcs); a company's item keeps its own stock unit of the same
 * family. The table is lib/units.ts FAMILY_UNITS.
 */

/**
 * The definition fields a company's stock item takes FROM its master — locked on a linked item (PATCH /inventory/:id
 * answers 422 MASTER_FIELD_LOCKED). Its unit only needs the master's FAMILY.
 * perishable + shelfLifeDays (owner B6, 2026-10-26): use-by dates on deliveries — the definition is servd's.
 */
export const MASTER_FIELDS = ['category', 'allergens', 'yieldPct', 'purchaseUnit', 'purchaseUnitFactor', 'perishable', 'shelfLifeDays'] as const
export type MasterField = (typeof MASTER_FIELDS)[number]

/**
 * The MASTER_FIELDS every linked item mirrors at once, with no posting (clean-up step 1, A3, owner 2026-11-14: ONE
 * copy rule, so items never drift from the sheet). The other two travel by their own rule inside applyMasterToItemsTx:
 *   • category moves a company's lots between cost classes — a POSTING (moveItemLotsToCategoryTx), so it is never
 *     copied here: a new item is made in the master's category (itemFieldsFromMaster), a category change reclasses
 *     each company's item (ingredient master PATCH), a merge needs the two to agree first, and a linked twin filed
 *     differently is flagged for a reviewer;
 *   • purchaseUnit + factor reach only items that buy in the master's buying unit (`buyingFrom`) — a company buying
 *     in its own unit ("bag") keeps it.
 */
export const MIRRORED_FIELDS = ['allergens', 'yieldPct', 'perishable', 'shelfLifeDays'] as const satisfies readonly MasterField[]

/** A master's buying-unit factor (base units per buying unit) in an item's own stock unit. */
export function factorForItemUnit(masterFactor: number, itemUnit: string): number {
  const per = unitFamily(itemUnit).perUnit
  return per > 0 ? masterFactor / per : masterFactor
}

export interface MasterRow {
  id: string
  name: string
  normalizedName: string
  stockUnit: string
  category: string | null
  allergens: string[]
  yieldPct: number
  purchaseUnit: string | null
  purchaseUnitFactor: number
  spec: string | null
  specFields: Prisma.JsonValue | null
  perishable: boolean
  shelfLifeDays: number | null
  groupId?: string | null
  status: string
  mergedIntoId: string | null
}

/** The live row a master id stands for today (follows merges; 404 when missing). */
export async function liveMaster(db: Db, masterId: string): Promise<MasterRow> {
  let id = masterId
  for (let hop = 0; hop < 10; hop++) {
    const m = await db.ingredientMaster.findUnique({ where: { id } })
    if (!m) throw new NotFoundError('IngredientMaster', masterId)
    if (!m.mergedIntoId) return m
    id = m.mergedIntoId
  }
  throw new AppError('MASTER_MERGE_LOOP', 'This ingredient was merged in a loop — a reviewer must fix it', 409)
}

export interface NewMasterInput {
  name: string
  unit: string
  category?: string | null
  allergens?: string[]
  yieldPct?: number
  purchaseUnit?: string | null
  purchaseUnitFactor?: number
  spec?: string | null
  specFields?: Record<string, string> | null
  perishable?: boolean
  shelfLifeDays?: number | null
}

/**
 * Find the live master of a name in the unit's FAMILY, or add it (K2: 'needs_review' unless `status` says otherwise),
 * kept in the family's base unit. Never returns a master of an incompatible unit: "Chicken" in pcs next to "Chicken"
 * in kg is a second master. Race-safe on the partial unique key (name, base unit). Returns { master, created }.
 */
export async function findOrCreateMasterTx(
  db: Db, input: NewMasterInput, actor: { userId: string | null; tenantId: string | null }, status: 'approved' | 'needs_review' = 'needs_review',
): Promise<{ master: MasterRow; created: boolean }> {
  const name = cleanIngredientName(input.name)
  if (!name) throw new AppError('NAME_REQUIRED', 'An ingredient needs a name', 422)
  const normalizedName = normalizeIngredientName(name)
  if (!normalizeUnit(input.unit)) throw new AppError('UNIT_REQUIRED', 'An ingredient needs a stock unit', 422)
  const fam = unitFamily(input.unit)
  const stockUnit = fam.base
  const same = await db.ingredientMaster.findMany({ where: { normalizedName, mergedIntoId: null }, orderBy: { createdAt: 'asc' } })
  const hit = same.find((m) => sameUnitFamily(m.stockUnit, stockUnit))
  if (hit) return { master: hit, created: false }
  const id = randomUUID()
  // A buying unit typed against the item's own unit (a case of 24 kg) is kept in base units on the master.
  const factor = (input.purchaseUnitFactor ?? 1) * fam.perUnit
  const inserted = await db.$executeRaw`
    INSERT INTO ingredient_masters (id, name, "normalizedName", "stockUnit", category, allergens, "yieldPct", "purchaseUnit", "purchaseUnitFactor", spec, "specFields", perishable, "shelfLifeDays", status, "createdByUserId", "createdInTenantId", "updatedAt")
    VALUES (${id}, ${name}, ${normalizedName}, ${stockUnit}, ${input.category ?? null}, ${input.allergens ?? []}::text[], ${input.yieldPct ?? 100},
            ${input.purchaseUnit?.trim() || null}, ${factor}, ${input.spec?.trim() || null},
            ${input.specFields ? JSON.stringify(input.specFields) : null}::jsonb, ${input.perishable ?? false}, ${input.shelfLifeDays ?? null}::int,
            ${status}, ${actor.userId}, ${actor.tenantId}, now())
    ON CONFLICT ("normalizedName", lower("stockUnit")) WHERE "mergedIntoId" IS NULL DO NOTHING`
  const row = inserted > 0
    ? await db.ingredientMaster.findUniqueOrThrow({ where: { id } })
    : await db.ingredientMaster.findFirstOrThrow({ where: { normalizedName, stockUnit, mergedIntoId: null }, orderBy: { createdAt: 'asc' } })
  return { master: row, created: inserted > 0 }
}

export interface CompanyItem { id: string; name: string; unit: string; tenantId: string; created: boolean; linked: boolean }

/** A legacy backfill duplicate "<name> (duplicate N)": its base name, else null. */
export function duplicateBaseName(normalizedName: string): string | null {
  const m = /^(.*) \(duplicate \d+\)$/.exec(normalizedName)
  return m ? m[1]! : null
}

/**
 * A company's EXISTING stock item for a master, read only: the live item linked to it; else an unlinked live stock
 * item of the same normalised name in a unit of the master's family (its "twin" — e.g. Flipd's chicken in g for a
 * master GS Foods stocks in kg). For a legacy "(duplicate N)" master the BASE name is tried too — the company's item
 * linked to the base master (`viaBase`, used as it is, never re-linked) or an unlinked item of the base name.
 * Null when the company has none.
 */
export async function findCompanyItemForMaster(db: Db, tenantId: string, m: Pick<MasterRow, 'id' | 'normalizedName' | 'stockUnit'>): Promise<{ id: string; name: string; unit: string; linked: boolean; viaBase?: boolean; viaDuplicate?: boolean } | null> {
  const linked = await db.inventoryItem.findFirst({
    where: { tenantId, masterIngredientId: m.id, deletedAt: null }, select: { id: true, name: true, unit: true },
  })
  if (linked) return { ...linked, linked: true }
  const unlinked = await db.inventoryItem.findMany({
    where: { tenantId, deletedAt: null, kind: 'stock', masterIngredientId: null },
    select: { id: true, name: true, unit: true }, orderBy: { createdAt: 'asc' },
  })
  const twin = unlinked.find((t) => normalizeIngredientName(t.name) === m.normalizedName && sameUnitFamily(t.unit, m.stockUnit))
  if (twin) return { ...twin, linked: false }
  const base = duplicateBaseName(m.normalizedName)
  if (!base) {
    // The reverse (review): a base master also takes the company's item already on a live "<name> (duplicate N)"
    // master of its unit family — never a second "Flour" splitting the company's stock between two items.
    const dupMasters = (await db.ingredientMaster.findMany({
      where: { normalizedName: { startsWith: `${m.normalizedName} (duplicate ` }, mergedIntoId: null }, select: { id: true, normalizedName: true, stockUnit: true },
    })).filter((d) => duplicateBaseName(d.normalizedName) === m.normalizedName && sameUnitFamily(d.stockUnit, m.stockUnit))
    if (!dupMasters.length) return null
    const onDup = await db.inventoryItem.findFirst({
      where: { tenantId, deletedAt: null, masterIngredientId: { in: dupMasters.map((d) => d.id) } },
      select: { id: true, name: true, unit: true }, orderBy: { createdAt: 'asc' },
    })
    return onDup ? { ...onDup, linked: true, viaDuplicate: true } : null
  }
  const baseMasters = (await db.ingredientMaster.findMany({ where: { normalizedName: base, mergedIntoId: null }, select: { id: true, stockUnit: true } }))
    .filter((b) => sameUnitFamily(b.stockUnit, m.stockUnit))
  if (baseMasters.length) {
    const onBase = await db.inventoryItem.findFirst({
      where: { tenantId, deletedAt: null, masterIngredientId: { in: baseMasters.map((b) => b.id) } }, select: { id: true, name: true, unit: true },
    })
    if (onBase) return { ...onBase, linked: true, viaBase: true }
  }
  const baseTwin = unlinked.find((t) => normalizeIngredientName(t.name) === base && sameUnitFamily(t.unit, m.stockUnit))
  return baseTwin ? { ...baseTwin, linked: false } : null
}

/**
 * THE company stock item of a master: the linked item; else the company's twin (same normalised name, a unit of the
 * master's family — linked now, keeping ITS unit: never a second row for one ingredient); else a new item made from
 * the master's definition in the master's base unit (no price, no supplier, par 0, no stock — the company sets
 * those). Race-safe on the partial unique key. A merged master resolves to the row it was merged into.
 * Trail (owner review N4): a twin linked here writes audit `inventory.link_master` (item, master, company) in the
 * same transaction, and a twin whose category differs from the master's raises `ingredient_master_category_mismatch`
 * for a reviewer. A legacy "(duplicate N)" master never names an item "(duplicate N)": one made for it takes the base
 * name and is flagged `ingredient_master_unlinked` for review (N5).
 */
export async function ensureCompanyItemForMasterTx(db: Db, tenantId: string, masterId: string): Promise<CompanyItem> {
  const m = await liveMaster(db, masterId)
  const find = () => db.inventoryItem.findFirst({
    where: { tenantId, masterIngredientId: m.id, deletedAt: null }, select: { id: true, name: true, unit: true },
  })
  const existing = await findCompanyItemForMaster(db, tenantId, m)
  if (existing?.linked) return { id: existing.id, name: existing.name, unit: existing.unit, tenantId, created: false, linked: false }
  if (existing) {
    const n = await db.inventoryItem.updateMany({ where: { id: existing.id, masterIngredientId: null }, data: { masterIngredientId: m.id } })
    if (n.count > 0) {
      // The twin takes the master's definition with the link — THE copy rule (applyMasterToItemsTx). It keeps its own
      // name, unit and buying unit; a category that differs is flagged below (a reclass is a posting).
      await applyMasterToItemsTx(db, m, [existing.id])
      const twin = await db.inventoryItem.findUniqueOrThrow({ where: { id: existing.id }, select: { category: true } })
      await db.auditLog.create({
        data: {
          category: 'identity', tenantId, action: 'inventory.link_master', entity: 'InventoryItem', entityId: existing.id,
          after: { masterIngredientId: m.id, master: m.name, item: existing.name, tenantId, how: 'twin_auto_link' },
        },
      })
      if ((twin.category ?? null) !== (m.category ?? null)) {
        await db.exceptionFlag.create({
          data: {
            tenantId, kind: 'ingredient_master_category_mismatch', severity: 'low',
            title: `Ingredient category differs from servd's: ${existing.name}`,
            description: `"${existing.name}" was linked to servd's ingredient "${m.name}" by a sale or a prep, but is filed as ${twin.category ?? 'no category'} while servd's ingredient is ${m.category ?? 'no category'}. A reviewer aligns them (the item's category can be changed on the Sourcing sheet).`,
            entityType: 'InventoryItem', entityId: existing.id, metadata: { masterIngredientId: m.id, itemCategory: twin.category, masterCategory: m.category },
          },
        })
      }
      return { id: existing.id, name: existing.name, unit: existing.unit, tenantId, created: false, linked: true }
    }
    const again = await find()
    if (again) return { ...again, tenantId, created: false, linked: false }
  }
  const base = duplicateBaseName(m.normalizedName)
  const name = base ? cleanIngredientName(m.name).replace(/ \(duplicate \d+\)$/i, '') : m.name
  const id = randomUUID()
  const def = itemFieldsFromMaster(m) // THE copy rule for a new item (in the master's base unit)
  const inserted = await db.$executeRaw`
    INSERT INTO inventory_items (id, "tenantId", name, unit, category, allergens, "yieldPct", "purchaseUnit", "purchaseUnitFactor", "masterIngredientId", perishable, "shelfLifeDays", kind, "updatedAt")
    VALUES (${id}, ${tenantId}, ${name}, ${m.stockUnit}, ${def.category}, ${def.allergens}::text[], ${def.yieldPct}, ${def.purchaseUnit}, ${def.purchaseUnitFactor}, ${m.id}, ${def.perishable}, ${def.shelfLifeDays}::int, 'stock', now())
    ON CONFLICT ("tenantId", "masterIngredientId") WHERE "deletedAt" IS NULL AND "masterIngredientId" IS NOT NULL DO NOTHING`
  if (inserted > 0) {
    if (base) {
      await db.exceptionFlag.create({
        data: {
          tenantId, kind: 'ingredient_master_unlinked', severity: 'low',
          title: `New stock item on a duplicate ingredient: ${name}`,
          description: `"${name}" was made on servd's legacy duplicate "${m.name}" (this company had no "${name}"). A reviewer merges the duplicate into the right ingredient.`,
          entityType: 'InventoryItem', entityId: id, metadata: { masterIngredientId: m.id },
        },
      })
    }
    return { id, name, unit: m.stockUnit, tenantId, created: true, linked: false }
  }
  const won = await find()
  if (!won) throw new AppError('MASTER_ITEM_MISSING', 'The stock item could not be made for this ingredient', 500)
  return { ...won, tenantId, created: false, linked: false }
}

/** The definition a NEW item takes from its master, for an item kept in `itemUnit` (same family as the master). */
export function itemFieldsFromMaster(m: MasterRow, itemUnit: string = m.stockUnit) {
  return {
    category: m.category, ...mirroredFieldsOf(m),
    purchaseUnit: m.purchaseUnit, purchaseUnitFactor: factorForItemUnit(m.purchaseUnitFactor, itemUnit),
  }
}

/** The MIRRORED_FIELDS of a master as item columns. */
export function mirroredFieldsOf(m: Pick<MasterRow, MirroredField>): Pick<MasterRow, MirroredField> {
  return { allergens: m.allergens, yieldPct: m.yieldPct, perishable: m.perishable, shelfLifeDays: m.shelfLifeDays }
}
type MirroredField = (typeof MIRRORED_FIELDS)[number]

export interface ApplyMasterOptions {
  /** The items take the master's name — each unless its company already has ANOTHER live item of that name. */
  rename?: boolean
  /** The items take the master's stock unit (a unit change made before anything was stocked). */
  unit?: boolean
  /** The master's buying unit + factor reach the items that bought in this (the master's previous) buying unit. */
  buyingFrom?: { purchaseUnit: string | null }
}

/**
 * THE one way a master's definition reaches its company stock items (A3): every writer of a master — its PATCH /
 * rename, a merge, the twin link in ensureCompanyItemForMasterTx — calls this; a NEW item is made from
 * itemFieldsFromMaster. Always mirrors MIRRORED_FIELDS; name, unit and buying unit as `opts` says. Never touches
 * category (a posting — see MIRRORED_FIELDS), price, supplier, par or stock. Returns the items renamed.
 */
export async function applyMasterToItemsTx(db: Db, m: MasterRow, itemIds: string[], opts: ApplyMasterOptions = {}): Promise<{ renamed: string[] }> {
  const renamed: string[] = []
  if (itemIds.length === 0) return { renamed }
  await db.inventoryItem.updateMany({
    where: { id: { in: itemIds } },
    data: { ...mirroredFieldsOf(m), ...(opts.unit ? { unit: m.stockUnit } : {}) },
  })
  if (!opts.rename && !opts.buyingFrom) return { renamed }
  const items = await db.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, tenantId: true, unit: true, purchaseUnit: true } })
  for (const it of items) {
    const data: Prisma.InventoryItemUpdateInput = {}
    if (opts.rename && it.name !== m.name) {
      // A rename reaches every company's linked stock item (owner, 2026-11-12: "I pick birds eye chili from the list
      // and it inputs red Onion") — unless that company already has ANOTHER live item of the new name (left as it is).
      const clash = await db.inventoryItem.findFirst({
        where: { id: { not: it.id }, tenantId: it.tenantId, deletedAt: null, name: { equals: m.name, mode: 'insensitive' } }, select: { id: true },
      })
      if (!clash) { data.name = m.name; renamed.push(it.id) }
    }
    // The buying unit + factor: base units on the master, the item's OWN unit on the item (kg vs g).
    if (opts.buyingFrom && (it.purchaseUnit ?? null) === (opts.buyingFrom.purchaseUnit ?? null)) {
      data.purchaseUnit = m.purchaseUnit
      data.purchaseUnitFactor = factorForItemUnit(m.purchaseUnitFactor, it.unit)
    }
    if (Object.keys(data).length > 0) await db.inventoryItem.update({ where: { id: it.id }, data })
  }
  return { renamed }
}
