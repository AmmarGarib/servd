// THE unit rule of servd (owner, 2026-11-14 — clean-up step 1, A1). ONE table, read by the ingredient master
// (lib/ingredientMaster.ts re-exports it), recipe costing (lib/recipeCost.ts), PO order units
// (modules/procurement/poUnits.ts), receiving, cash buys, transfers, prep batches — and mirrored byte-for-byte in the
// admin (frontend/admin/src/lib/units.ts; keep the two FAMILY_UNITS tables identical).
//
// Owner decisions:
//   (a) grams and millilitres are SEPARATE families — mass never converts to volume anywhere (no density guess). A
//       recipe line / PO line / receipt / transfer must be in a unit of the ingredient's own family; a NEW one that is
//       not is refused (422 UNIT_MISMATCH).
//   (b) "items", "item", "pcs", "pc", "piece(s)" are the SAME count unit (base pcs). Dozen = 12 pcs, as before.
//
// Legacy data: rows stored BEFORE this rule may hold a millilitre quantity against a gram item (or the reverse);
// those were read 1:1 (density 1) and still are, through convertUnitsLegacy — so posted stock and cost never change.
// Only stored rows read it; every NEW input goes through the strict convertUnits.

/**
 * THE whitespace rule (JS `\s` as the master uses it): every character here is "space". The migration's SQL
 * (20261026120000_ingredient_master, pg_temp.im_norm) uses EXACTLY this class — change both or neither.
 */
export const WS_CLASS = '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
const WS_EDGE = new RegExp(`^[${WS_CLASS}]+|[${WS_CLASS}]+$`, 'g')

/** A unit as compared: edges trimmed, lower case ("Kg " → "kg"). */
export function normalizeUnit(unit: string | null | undefined): string {
  return (unit ?? '').replace(WS_EDGE, '').toLowerCase()
}

export type UnitFamilyName = 'mass' | 'volume' | 'count'

/** Base units in ONE of each unit, per family. A unit outside the table is its own family (factor 1). */
export const FAMILY_UNITS: Record<UnitFamilyName, Record<string, number>> = {
  mass:   { mg: 0.001, g: 1, gm: 1, gms: 1, gr: 1, gram: 1, grams: 1, kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000 },
  volume: { ml: 1, millilitre: 1, millilitres: 1, milliliter: 1, milliliters: 1, l: 1000, lt: 1000, ltr: 1000, ltrs: 1000, litre: 1000, litres: 1000, liter: 1000, liters: 1000 },
  count:  { pcs: 1, pc: 1, piece: 1, pieces: 1, item: 1, items: 1, unit: 1, units: 1, each: 1, ea: 1, no: 1, nos: 1, dozen: 12, doz: 12, dz: 12 },
}
export const BASE_OF: Record<UnitFamilyName, string> = { mass: 'g', volume: 'ml', count: 'pcs' }

export interface UnitFamily { family: string; base: string; perUnit: number }

/** The family of a unit, its base unit and how many base units ONE of it is. */
export function unitFamily(unit: string | null | undefined): UnitFamily {
  const u = normalizeUnit(unit)
  for (const fam of ['mass', 'volume', 'count'] as const) {
    const f = FAMILY_UNITS[fam][u]
    if (f != null) return { family: fam, base: BASE_OF[fam], perUnit: f }
  }
  return { family: `u:${u}`, base: u, perUnit: 1 }
}

/** True when two units are of one family (kg and g; litres and ml; pcs, items and dozen). */
export function sameUnitFamily(a: string | null | undefined, b: string | null | undefined): boolean {
  return unitFamily(a).family === unitFamily(b).family
}

/** True when the unit is in the table (mass, volume or count) — an unknown label ("bag", "pack") is not. */
export function isKnownUnit(unit: string | null | undefined): boolean {
  return !unitFamily(unit).family.startsWith('u:')
}

/**
 * `qty` written in `from` expressed in `to` — same family only (g ↔ kg, ml ↔ l, pcs ↔ items ↔ dozen; the same
 * label always converts 1:1). Null when the two cannot be reconciled (grams of an item kept in litres, pieces of one
 * kept by the kilo, or an unknown unit): the caller refuses rather than guesses.
 */
export function convertUnits(qty: number, from: string | null | undefined, to: string | null | undefined): number | null {
  const f = normalizeUnit(from)
  const t = normalizeUnit(to)
  if (f === t) return qty
  const a = unitFamily(f)
  const b = unitFamily(t)
  if (a.family !== b.family || a.family.startsWith('u:')) return null
  return (qty * a.perUnit) / b.perUnit
}

/**
 * The same, for a row STORED before the one-unit rule: mass ↔ volume still converts 1:1 (1 ml = 1 g), exactly as it
 * was read when it was written, so its stock and cost never move. Never for new input.
 */
export function convertUnitsLegacy(qty: number, from: string | null | undefined, to: string | null | undefined): number | null {
  const strict = convertUnits(qty, from, to)
  if (strict != null) return strict
  const a = unitFamily(from)
  const b = unitFamily(to)
  const massVol = (x: string) => x === 'mass' || x === 'volume'
  if (massVol(a.family) && massVol(b.family)) return (qty * a.perUnit) / b.perUnit
  return null
}

/**
 * How many recipe measures (g / ml / pcs — the item's family base) make one stock unit of an item: 1000 for kg /
 * litre, 12 for a dozen, 1 otherwise. A unit SMALLER than its base (mg) stays 1 — the recipe quantity of such an item
 * has always been read in its own unit, and stored recipes must cost the same.
 */
export function measuresPerStockUnit(unit: string | null | undefined): number {
  const per = unitFamily(unit).perUnit
  return per >= 1 ? per : 1
}

/** The recipe measure (g / ml / pcs) a line is written in for an item kept in `unit`; an unknown unit is its own. */
export function measureOfUnit(unit: string | null | undefined): string {
  return unitFamily(unit).base
}

/** The bulk unit (kg / l) a base-gram / base-millilitre unit is bought in; null for any other unit. */
export function bulkUnitOf(unit: string | null | undefined): 'kg' | 'l' | null {
  const f = unitFamily(unit)
  if (f.perUnit !== 1) return null
  return f.family === 'mass' ? 'kg' : f.family === 'volume' ? 'l' : null
}
