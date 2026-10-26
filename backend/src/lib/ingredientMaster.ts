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

/**
 * THE whitespace rule (JS `\s` as the master uses it): every character here is "space". The migration's SQL
 * (20261026120000_ingredient_master, pg_temp.im_norm) uses EXACTLY this class — change both or neither.
 * ASCII tab / LF / VT / FF / CR / space, NBSP, Ogham space, U+2000–U+200A, line / paragraph separators, NNBSP,
 * medium math space, ideographic space and the BOM.
 */
export const WS_CLASS = '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
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

/** A stock unit as compared: edges trimmed, lower case ("Kg " → "kg"). */
export function normalizeUnit(unit: string): string {
  return unit.replace(WS_EDGE, '').toLowerCase()
}

/**
 * Unit FAMILIES (owner review, 2026-10-26: "kg↔g, l↔ml are ONE master"). A master is kept in its family's BASE unit
 * (g / ml / pcs); a company's item keeps its own stock unit of the same family (recipe quantities convert through
 * lib/recipeCost.ts measureToPurchaseUnits). Volume and weight are separate families here (no density guess). A unit
 * outside the table is its own family. The SQL backfill mirrors these lists exactly.
 */
const FAMILY_UNITS: Record<'mass' | 'volume' | 'count', Record<string, number>> = {
  mass:   { mg: 0.001, g: 1, gm: 1, gms: 1, gr: 1, gram: 1, grams: 1, kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000 },
  volume: { ml: 1, millilitre: 1, millilitres: 1, milliliter: 1, milliliters: 1, l: 1000, lt: 1000, ltr: 1000, ltrs: 1000, litre: 1000, litres: 1000, liter: 1000, liters: 1000 },
  count:  { pcs: 1, pc: 1, piece: 1, pieces: 1, unit: 1, units: 1, each: 1, ea: 1, no: 1, nos: 1, dozen: 12, doz: 12, dz: 12 },
}
const BASE_OF = { mass: 'g', volume: 'ml', count: 'pcs' } as const

export interface UnitFamily { family: string; base: string; perUnit: number }

/** The family of a unit, its base unit and how many base units ONE of it is. */
export function unitFamily(unit: string): UnitFamily {
  const u = normalizeUnit(unit)
  for (const fam of ['mass', 'volume', 'count'] as const) {
    const f = FAMILY_UNITS[fam][u]
    if (f != null) return { family: fam, base: BASE_OF[fam], perUnit: f }
  }
  return { family: `u:${u}`, base: u, perUnit: 1 }
}

/** True when two units are of one family (kg and g; litres and ml; pcs and dozen). */
export function sameUnitFamily(a: string, b: string): boolean {
  return unitFamily(a).family === unitFamily(b).family
}

/** The definition fields a company's stock item takes FROM its master (its unit only needs the master's FAMILY). */
// perishable + shelfLifeDays (owner B6, 2026-10-26): use-by dates on deliveries — the definition is servd's.
export const MASTER_FIELDS = ['category', 'allergens', 'yieldPct', 'purchaseUnit', 'purchaseUnitFactor', 'perishable', 'shelfLifeDays'] as const
export type MasterField = (typeof MASTER_FIELDS)[number]

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
    // The twin takes the master's use-by definition with the link (MASTER_FIELDS; owner B6).
    const n = await db.inventoryItem.updateMany({ where: { id: existing.id, masterIngredientId: null }, data: { masterIngredientId: m.id, perishable: m.perishable, shelfLifeDays: m.shelfLifeDays } })
    if (n.count > 0) {
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
  const inserted = await db.$executeRaw`
    INSERT INTO inventory_items (id, "tenantId", name, unit, category, allergens, "yieldPct", "purchaseUnit", "purchaseUnitFactor", "masterIngredientId", perishable, "shelfLifeDays", kind, "updatedAt")
    VALUES (${id}, ${tenantId}, ${name}, ${m.stockUnit}, ${m.category}, ${m.allergens}::text[], ${m.yieldPct}, ${m.purchaseUnit}, ${m.purchaseUnitFactor}, ${m.id}, ${m.perishable}, ${m.shelfLifeDays}::int, 'stock', now())
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

/** The definition an item takes from its master, for an item kept in `itemUnit` (same family as the master). */
export function itemFieldsFromMaster(m: MasterRow, itemUnit: string = m.stockUnit) {
  return {
    category: m.category, allergens: m.allergens, yieldPct: m.yieldPct,
    purchaseUnit: m.purchaseUnit, purchaseUnitFactor: factorForItemUnit(m.purchaseUnitFactor, itemUnit),
    perishable: m.perishable, shelfLifeDays: m.shelfLifeDays,
  }
}
