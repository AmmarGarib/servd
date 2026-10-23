// Fixed-asset classes — THE one class list (fixed assets v2, wave B).
//
// Every class key, its ledger codes (cost and accumulated depreciation, from
// journal.ts ACCT), its default life (H22) and its tax rates (H23, ITO Third
// Schedule + 25% initial allowance on kitchen and power equipment only — H42, 2026-10-15) live here, and nowhere
// else. `ensureAssetClasses` seeds them per company into FixedAssetClass
// (only the keys a company is missing, so the CEO's edits to labels, lives and
// tax rates survive); the register, CapEx, the reports and the admin read the
// company's rows through `getAssetClasses`.
//
// Account codes are fixed per key: a class's cost and accumulated codes never
// change once an asset has posted to them (the routes refuse such an edit).
//
// The equipment guard (`looksLikeEquipment` / `assertNotEquipmentLine`) is the
// ONE place that decides whether a bill, OpEx, petty-cash, cash-request or
// stock-item line is equipment — equipment goes on the register only through
// CapEx (owner, 2026-10-13).

import type { FixedAssetClass, Prisma, PrismaClient } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { ACCT } from '../accounting/journal.js'
import { REGISTER_CONTROLLED_CODES } from '../../lib/chartOfAccounts.js'
import { getOperationsConfig } from '../../lib/setup-config.js'

export type Db = Prisma.TransactionClient | PrismaClient

export interface AssetClassDefault {
  key: string
  label: string
  costAccountCode: string
  accumAccountCode: string | null
  depreciable: boolean
  pooled: boolean
  defaultLifeMonths: number | null
  taxRateBp: number
  taxInitialAllowanceBp: number
}

/**
 * The class list (H22 lives, H23 tax rates, H27 accumulated per class). Land
 * is never depreciated (no accumulated account, no life). Smallwares are
 * pooled (H21: per outlet / brand / type, 24 months).
 */
export const ASSET_CLASS_DEFAULTS: ReadonlyArray<AssetClassDefault> = [
  { key: 'kitchen_equipment',  label: 'Kitchen equipment',          costAccountCode: ACCT.KITCHEN_EQUIPMENT,      accumAccountCode: ACCT.ACC_DEP_KITCHEN,    depreciable: true,  pooled: false, defaultLifeMonths: 60,   taxRateBp: 1500, taxInitialAllowanceBp: 2500 },
  { key: 'furniture_fixtures', label: 'Furniture & fixtures',       costAccountCode: ACCT.FURNITURE_FIXTURES,     accumAccountCode: ACCT.ACC_DEP_FURNITURE,  depreciable: true,  pooled: false, defaultLifeMonths: 84,   taxRateBp: 1500, taxInitialAllowanceBp: 0 },
  { key: 'it_equipment',       label: 'IT equipment',               costAccountCode: ACCT.IT_EQUIPMENT,           accumAccountCode: ACCT.ACC_DEP_IT,         depreciable: true,  pooled: false, defaultLifeMonths: 36,   taxRateBp: 3000, taxInitialAllowanceBp: 0 },
  { key: 'vehicles',           label: 'Vehicles',                   costAccountCode: ACCT.VEHICLES,               accumAccountCode: ACCT.ACC_DEP_VEHICLES,   depreciable: true,  pooled: false, defaultLifeMonths: 60,   taxRateBp: 1500, taxInitialAllowanceBp: 0 },
  // Life capped at the lease end when one is given at capitalisation.
  { key: 'leasehold',          label: 'Leasehold improvements',     costAccountCode: ACCT.LEASEHOLD_IMPROVEMENTS, accumAccountCode: ACCT.ACC_DEP_LEASEHOLD,  depreciable: true,  pooled: false, defaultLifeMonths: 120,  taxRateBp: 1000, taxInitialAllowanceBp: 0 },
  { key: 'buildings',          label: 'Buildings',                  costAccountCode: ACCT.BUILDINGS,              accumAccountCode: ACCT.ACC_DEP_BUILDINGS,  depreciable: true,  pooled: false, defaultLifeMonths: 240,  taxRateBp: 1000, taxInitialAllowanceBp: 0 },
  { key: 'power_equipment',    label: 'Generators & power',         costAccountCode: ACCT.POWER_EQUIPMENT,        accumAccountCode: ACCT.ACC_DEP_POWER,      depreciable: true,  pooled: false, defaultLifeMonths: 84,   taxRateBp: 1500, taxInitialAllowanceBp: 2500 },
  { key: 'office_equipment',   label: 'Office equipment',           costAccountCode: ACCT.OFFICE_EQUIPMENT,       accumAccountCode: ACCT.ACC_DEP_OFFICE,     depreciable: true,  pooled: false, defaultLifeMonths: 60,   taxRateBp: 1500, taxInitialAllowanceBp: 0 },
  { key: 'smallwares',         label: 'Smallwares (pooled)',        costAccountCode: ACCT.SMALLWARES,             accumAccountCode: ACCT.ACC_DEP_SMALLWARES, depreciable: true,  pooled: true,  defaultLifeMonths: 24,   taxRateBp: 1500, taxInitialAllowanceBp: 0 },
  { key: 'land',               label: 'Land',                       costAccountCode: ACCT.LAND,                   accumAccountCode: null,                    depreciable: false, pooled: false, defaultLifeMonths: null, taxRateBp: 0,    taxInitialAllowanceBp: 0 },
]

export type AssetClassKey =
  | 'kitchen_equipment' | 'furniture_fixtures' | 'it_equipment' | 'vehicles' | 'leasehold'
  | 'buildings' | 'power_equipment' | 'office_equipment' | 'smallwares' | 'land'

/** Every class key, in list order — a tuple for `z.enum(ASSET_CLASS_KEYS)`. */
export const ASSET_CLASS_KEYS = ASSET_CLASS_DEFAULTS.map((c) => c.key) as [AssetClassKey, ...AssetClassKey[]]

const DEFAULT_BY_KEY = new Map(ASSET_CLASS_DEFAULTS.map((c) => [c.key, c]))

/** The default (template) row of a class key, or undefined. */
export function defaultClassOf(key: string): AssetClassDefault | undefined {
  return DEFAULT_BY_KEY.get(key)
}

/** Smallwares pool types (H21) — fixed in code for now. */
export const SMALLWARE_TYPES: readonly string[] = [
  'knives', 'ladles_utensils', 'bowls', 'plates', 'trays', 'cutlery', 'glassware', 'pots_pans', 'bar_tools', 'storage', 'other',
]

export const SMALLWARE_TYPE_LABELS: Readonly<Record<string, string>> = {
  knives: 'Knives',
  ladles_utensils: 'Ladles & utensils',
  bowls: 'Bowls',
  plates: 'Plates',
  trays: 'Trays',
  cutlery: 'Cutlery',
  glassware: 'Glassware',
  pots_pans: 'Pots & pans',
  bar_tools: 'Bar tools',
  storage: 'Storage',
  other: 'Other smallwares',
}

/**
 * Seed `tenantId`'s classes from ASSET_CLASS_DEFAULTS. Adds only the keys the
 * company is missing — an existing row (the CEO's edited label, life or tax
 * rate) is never overwritten. Returns how many classes were added.
 */
export async function ensureAssetClasses(tenantId: string): Promise<number> {
  const have = new Set((await serviceClient.fixedAssetClass.findMany({
    where: { tenantId }, select: { key: true },
  })).map((c) => c.key))
  const missing = ASSET_CLASS_DEFAULTS
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !have.has(c.key))
  if (missing.length === 0) return 0
  const r = await serviceClient.fixedAssetClass.createMany({
    data: missing.map(({ c, i }) => ({
      tenantId,
      key: c.key,
      label: c.label,
      costAccountCode: c.costAccountCode,
      accumAccountCode: c.accumAccountCode,
      depreciable: c.depreciable,
      pooled: c.pooled,
      defaultLifeMonths: c.defaultLifeMonths,
      taxRateBp: c.taxRateBp,
      taxInitialAllowanceBp: c.taxInitialAllowanceBp,
      isActive: true,
      sortOrder: i,
    })),
    skipDuplicates: true,
  })
  return r.count
}

/**
 * `tenantId`'s classes (in list order). Seeds the company first when any
 * default key is missing (lazily, the same as at boot), so a caller never
 * sees a half list. `db` reads through the caller's transaction.
 */
export async function getAssetClasses(tenantId: string, db: Db = serviceClient): Promise<FixedAssetClass[]> {
  let rows = await db.fixedAssetClass.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] })
  const have = new Set(rows.map((r) => r.key))
  if (ASSET_CLASS_DEFAULTS.some((c) => !have.has(c.key))) {
    await ensureAssetClasses(tenantId)
    rows = await db.fixedAssetClass.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] })
  }
  return rows
}

/** One class of `tenantId` by key; 422 ASSET_CLASS when the company has no such class. */
export async function classOf(tenantId: string, key: string, db: Db = serviceClient): Promise<FixedAssetClass> {
  const found = (await getAssetClasses(tenantId, db)).find((c) => c.key === key)
  if (!found) throw new AppError('ASSET_CLASS', `Unknown asset class "${key}"`, 422)
  return found
}

// ─── Company policy (OperationsConfig) ──────────────────────────────────────

export interface FixedAssetPolicy {
  /** Flag a delivered CapEx line not capitalised after this many days (worker). */
  capexUncapitalisedAlertDays: number
  /** Flag an undelivered CapEx advance this many days past its expected delivery (worker). */
  capexAdvanceOverdueDays: number
  /** Asset tag prefix ('FA-' → FA-00001). */
  assetTagPrefix: string
}

/**
 * The company's fixed-asset policy. Depreciation is ALWAYS automatic (owner,
 * 2026-10-13) — there is deliberately no on/off switch here.
 */
export async function getFixedAssetPolicy(tenantId: string): Promise<FixedAssetPolicy> {
  const cfg = await getOperationsConfig(tenantId)
  return {
    capexUncapitalisedAlertDays: cfg?.capexUncapitalisedAlertDays ?? 30,
    capexAdvanceOverdueDays: cfg?.capexAdvanceOverdueDays ?? 45,
    assetTagPrefix: (cfg?.assetTagPrefix ?? 'FA-').trim() || 'FA-',
  }
}

// ─── The equipment guard (owner: equipment only via CapEx) ──────────────────
//
// A conservative word list: equipment and smallwares nouns, negated by
// service words (a fryer REPAIR is an expense) and disposable / packaging
// words (a KRAFT bowl is packaging stock). False positives are overridden by
// finance or the CEO with a reason (audited and flagged by the caller); false
// negatives are caught by the register-to-GL tie-out.

const EQUIPMENT_PHRASES: readonly string[] = [
  // multi-word first, so the reported match is the most specific one
  'air conditioner', 'air conditioning', 'coffee machine', 'espresso machine', 'ice machine', 'ice maker',
  'display chiller', 'water dispenser', 'cutting board', 'chopping board', 'sheet pan', 'hotel pan',
  'cash register', 'cash drawer', 'deep fryer', 'pizza oven', 'combi oven', 'range hood', 'exhaust hood',
  'walk-in', 'cold room', 'bain marie', 'sous vide', 'food processor', 'meat slicer', 'meat grinder',
]

const EQUIPMENT_WORDS: readonly string[] = [
  // kitchen equipment
  'fryer', 'oven', 'chiller', 'freezer', 'grill', 'griddle', 'range', 'hood', 'mixer', 'blender', 'fridge',
  'refrigerator', 'microwave', 'dishwasher', 'salamander', 'tandoor', 'stove', 'burner', 'toaster', 'kettle',
  'grinder', 'slicer', 'juicer', 'dehydrator', 'smoker', 'steamer', 'proofer', 'warmer', 'hotplate',
  // power, IT, office (UPS / AC / POS are matched in capitals only — see CAPS_RE)
  'generator', 'inverter', 'laptop', 'computer', 'desktop', 'monitor', 'printer', 'router',
  'cctv', 'tablet', 'scanner',
  // furniture
  'table', 'chair', 'stool', 'sofa', 'bench', 'desk', 'shelving', 'cabinet', 'counter',
  // smallwares
  'knife', 'knives', 'ladle', 'bowl', 'plate', 'tray', 'pot', 'pan', 'cutlery', 'glassware', 'spatula',
  'whisk', 'tongs', 'skillet', 'wok', 'saucepan', 'stockpot', 'colander', 'strainer', 'mandoline', 'crockery',
]

// Service work on equipment — an expense, not equipment.
const SERVICE_MARKERS = /\b(repair|repairs|repaired|repairing|service|services|servicing|serviced|maintenance|maintain|cleaning|clean|installation|install|installing|rental|rent|rented|hire|hired|refill|refills|refilling|recharge|fixing|labour|labor)\b/i
// Disposables / packaging — stock, not equipment.
const DISPOSABLE_MARKERS = /\b(disposable|disposables|paper|kraft|foil|plastic|takeaway|take-away|take away|packaging|biodegradable|compostable|styrofoam|thermocol|napkin|napkins|tissue|tissues)\b|\b\d+(\.\d+)?\s?ml\b|\bml\b/i
// Consumables used WITH equipment — fryer oil, generator diesel, dishwasher
// tablets / salt, table linen — stock or expense, not equipment.
const CONSUMABLE_MARKERS = /\b(oil|fuel|diesel|petrol|lpg|charcoal|coal|detergent|soap|sanitiser|sanitizer|chemical|chemicals|descaler|degreaser|polish|salt|liner|liners|bag|bags|cling|film|wrap|wraps|cloth|cloths|linen|linens|cover|covers)\b/i

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
const PHRASE_RE = new RegExp(`\\b(${EQUIPMENT_PHRASES.map(escapeRe).join('|')})\\b`, 'i')
// A word, optionally plural (s / es).
const WORD_RE = new RegExp(`\\b(${EQUIPMENT_WORDS.map(escapeRe).join('|')})(s|es)?\\b`, 'i')
// Abbreviations matched only in capitals ("UPS", "AC", "POS") or as "a/c" —
// lower-case "ups" is "top ups", "ac" / "pos" appear inside other words' use.
const CAPS_RE = /\b(UPS|AC|POS)\b|\ba\/c\b/

/**
 * Whether `text` describes equipment or smallwares. `matched` is the word or
 * phrase found (as written), null when the text is not equipment — including
 * when a service or disposable marker negates it ("fryer repair", "kraft
 * bowl 500ml").
 */
export function looksLikeEquipment(text: string): { matched: string | null } {
  const t = (text ?? '').trim()
  if (!t) return { matched: null }
  if (SERVICE_MARKERS.test(t) || DISPOSABLE_MARKERS.test(t) || CONSUMABLE_MARKERS.test(t)) return { matched: null }
  const phrase = PHRASE_RE.exec(t)
  if (phrase) return { matched: phrase[0] }
  const word = WORD_RE.exec(t)
  if (word) return { matched: word[0] }
  const caps = CAPS_RE.exec(t)
  if (caps) return { matched: caps[0] }
  return { matched: null }
}

/** Who may book an equipment-looking line as an expense anyway (critic: finance and the CEO only). */
export const EQUIPMENT_OVERRIDE_ROLES: readonly string[] = ['admin', 'finance']
const OVERRIDE_MIN_REASON = 10
// 1340 (advances to suppliers) is CapEx's own account too.
const CAPEX_ONLY_CODES = new Set<string>([...REGISTER_CONTROLLED_CODES, ACCT.SUPPLIER_ADVANCES])

const USE_CAPEX_TAIL = 'Equipment goes on the register only through CapEx — Finance → Project tracker → Quick buy.'

/**
 * Refuse a spend line that is really equipment. Used by supplier bills, OpEx,
 * petty cash, cash requests and inventory items.
 *
 *   • an expense code kept by the register (1500–1599, 2012) or 1340 → always
 *     422 USE_CAPEX (no override);
 *   • a description that looks like equipment → 422 USE_CAPEX, unless the line
 *     says `notEquipment` with a reason (≥ 10 characters) AND the actor is
 *     finance or the CEO (else 403 OVERRIDE_NOT_ALLOWED).
 *
 * Returns `{ overridden: true }` when the override was used — the CALLER then
 * audits it and raises 'bill_equipment_override' (bills, high) or
 * 'equipment_override' (everywhere else) in the document's company.
 */
export function assertNotEquipmentLine(
  input: { description: string; expenseAccountCode?: string | null; notEquipment?: boolean; notEquipmentReason?: string | null },
  actor: { role: string },
): { overridden: boolean } {
  const code = input.expenseAccountCode?.trim()
  if (code && CAPEX_ONLY_CODES.has(code)) {
    throw new AppError(
      'USE_CAPEX',
      `Account ${code} is kept by the fixed-asset register and CapEx — this line cannot be booked to it. ${USE_CAPEX_TAIL}`,
      422,
      { accountCode: code },
    )
  }
  const { matched } = looksLikeEquipment(input.description)
  if (!matched) return { overridden: false }
  if (!input.notEquipment) {
    throw new AppError('USE_CAPEX', `This line is equipment (matched "${matched}"). ${USE_CAPEX_TAIL}`, 422, { matched })
  }
  if (!EQUIPMENT_OVERRIDE_ROLES.includes(actor.role)) {
    throw new AppError(
      'OVERRIDE_NOT_ALLOWED',
      `Only finance or the CEO can book a line that looks like equipment (matched "${matched}") as an expense`,
      403,
      { matched },
    )
  }
  if ((input.notEquipmentReason?.trim().length ?? 0) < OVERRIDE_MIN_REASON) {
    throw new AppError(
      'OVERRIDE_REASON_REQUIRED',
      `Say why this line is not equipment (matched "${matched}") — at least ${OVERRIDE_MIN_REASON} characters`,
      422,
      { matched },
    )
  }
  return { overridden: true }
}
