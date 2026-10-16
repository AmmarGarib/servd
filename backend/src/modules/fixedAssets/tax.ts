// Tax depreciation (H23) and the deferred-tax report (H24) — reports only,
// never posted.
//
// ITO 2001 Third Schedule, written-down value per asset, per income-tax year
// (1 July – 30 June, named by the year it ends in — accounting/fiscalYear.ts
// taxYearOf is the ONE year definition):
//   • year of first use: initial allowance on the cost IF the asset is ticked
//     "eligible for initial allowance" (FixedAsset.initialAllowanceEligible —
//     Hasnain H42, 2026-10-16: decided per asset by finance; it starts ticked
//     for kitchen and power equipment, unticked for office, IT and the rest),
//     at the class's taxInitialAllowanceBp, or the statutory 25% when the class
//     carries 0; then the full year's depreciation at the class rate on what
//     is left;
//   • later years: rate × opening WDV;
//   • year of disposal: no depreciation; the proceeds come off the WDV;
//   • a year the CEO froze (FixedAssetTaxYear rows) is used exactly as frozen,
//     whatever the class rates say today;
//   • smallwares (pooled classes) are deducted IN FULL in the tax year they are
//     bought (Hasnain H35, 2026-10-15) — no initial allowance, closing WDV 0 —
//     while the books keep pooling them over 24 months (H21).
// Cost is the asset's cost when capitalised (net of claimable input tax).
// A pool layer split off by a unit transfer is not a new addition — its tax
// WDV stays on the layer it came from; partial pool write-offs do not move
// the tax WDV (accountant to confirm).
//
// Deferred tax (H24) compares the register's NBV with the tax WDV per class at
// the tax year end, at the company's policy rate (29%). Report only.

import type { FixedAsset, FixedAssetClass } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { taxYearOf } from '../accounting/fiscalYear.js'
import { getAssetClasses, getFixedAssetPolicy, type Db } from './classes.js'
import { nbvAt } from './schedule.js'

export interface TaxAssetRow {
  assetId: string
  assetTag: string | null
  name: string
  classKey: string
  rateBp: number
  initialAllowanceBp: number
  openingWdvCents: number
  additionsCents: number
  initialAllowanceCents: number
  depreciationCents: number
  disposalProceedsCents: number
  closingWdvCents: number
  /** True when the figures come from the CEO's freeze of this year. */
  frozen: boolean
}

export interface TaxTotals {
  openingWdvCents: number
  additionsCents: number
  initialAllowanceCents: number
  depreciationCents: number
  disposalProceedsCents: number
  closingWdvCents: number
}

export interface TaxScheduleResult {
  tenantId: string
  taxYear: number
  start: Date
  end: Date
  /** The CEO froze this year (its rows are final). */
  frozen: boolean
  rows: TaxAssetRow[]
  byClass: Array<{ classKey: string; label: string } & TaxTotals>
  totals: TaxTotals
}

/** Start / end (PKT) of income-tax year `taxYear` (1 Jul taxYear−1 – 30 Jun taxYear). */
export function taxYearBounds(taxYear: number): { start: Date; end: Date } {
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2200) throw new AppError('BAD_TAX_YEAR', 'Tax year must be a year like 2027', 400)
  const { start, end } = taxYearOf(new Date(Date.UTC(taxYear, 0, 15)))
  return { start, end }
}

function zeroTotals(): TaxTotals {
  return { openingWdvCents: 0, additionsCents: 0, initialAllowanceCents: 0, depreciationCents: 0, disposalProceedsCents: 0, closingWdvCents: 0 }
}

function addTo(t: TaxTotals, r: TaxTotals): void {
  t.openingWdvCents += r.openingWdvCents
  t.additionsCents += r.additionsCents
  t.initialAllowanceCents += r.initialAllowanceCents
  t.depreciationCents += r.depreciationCents
  t.disposalProceedsCents += r.disposalProceedsCents
  t.closingWdvCents += r.closingWdvCents
}

const bp = (cents: number, rateBp: number) => Math.round((cents * rateBp) / 10_000)

/** ITO 2001 Third Schedule Part II: the initial allowance on eligible plant and machinery. */
export const STATUTORY_INITIAL_ALLOWANCE_BP = 2500

/** The classes whose assets START ticked for the initial allowance (H42). Every other class starts unticked. */
export const INITIAL_ALLOWANCE_DEFAULT_CLASSES: ReadonlySet<string> = new Set(['kitchen_equipment', 'power_equipment'])

/** The tick an asset of class `classKey` gets at capitalisation (and that a NULL row reads as). */
export function defaultInitialAllowanceEligible(classKey: string): boolean {
  return INITIAL_ALLOWANCE_DEFAULT_CLASSES.has(classKey)
}

/** Is `a` ticked for the initial allowance (NULL = the class rule). */
export function initialAllowanceEligibleOf(a: Pick<FixedAsset, 'category' | 'initialAllowanceEligible'>): boolean {
  return a.initialAllowanceEligible ?? defaultInitialAllowanceEligible(a.category)
}

/**
 * The initial-allowance rate (bp) the tax view uses for `a`: 0 when unticked or
 * pooled (smallwares are deducted in full, H35) or not depreciable; otherwise
 * the class's rate, or the statutory 25% when the class carries 0.
 */
export function initialAllowanceBpOf(
  a: Pick<FixedAsset, 'category' | 'initialAllowanceEligible'>,
  cls: Pick<FixedAssetClass, 'pooled' | 'depreciable' | 'taxInitialAllowanceBp'> | undefined,
): number {
  if (!initialAllowanceEligibleOf(a)) return 0
  if (cls?.pooled || cls?.depreciable === false) return 0
  const classBp = cls?.taxInitialAllowanceBp ?? 0
  return classBp > 0 ? classBp : STATUTORY_INITIAL_ALLOWANCE_BP
}

/** Is the asset in this company's tax WDV at all (voided / split-off layers are not). */
function inTaxBase(a: FixedAsset): boolean {
  return a.status !== 'voided' && !a.splitFromAssetId
}

/** Disposed for tax: a real disposal or a full write-off — not units moved to another pool. */
function taxDisposalYear(a: FixedAsset): number | null {
  if (a.status !== 'disposed' || !a.disposedAt || a.disposalKind === 'transferred') return null
  return taxYearOf(a.disposedAt).taxYear
}

/** One asset's tax rows for every year from first use to `taxYear` (frozen years as frozen). */
function walkAsset(
  a: FixedAsset,
  cls: FixedAssetClass | undefined,
  frozen: Map<number, TaxAssetRow>,
  taxYear: number,
): TaxAssetRow | null {
  const firstYear = taxYearOf(a.inServiceAt ?? a.acquiredAt).taxYear
  if (firstYear > taxYear) return null
  const disposedYear = taxDisposalYear(a)
  if (disposedYear !== null && disposedYear < taxYear) return null
  // H35: a pooled class (smallwares) is deducted 100% in the year bought.
  const pooled = !!cls?.pooled
  const rateBp = pooled ? 10_000 : cls?.taxRateBp ?? 0
  const iaBp = initialAllowanceBpOf(a, cls)
  const cost = toCents(a.originalCostCents) > 0 ? toCents(a.originalCostCents) : toCents(a.costCents)
  let wdv = 0
  let row: TaxAssetRow | null = null
  for (let y = firstYear; y <= taxYear; y++) {
    const f = frozen.get(y)
    if (f) {
      wdv = f.closingWdvCents
      row = f
      continue
    }
    const disposedNow = disposedYear === y
    const opening = wdv
    const additions = y === firstYear ? cost : 0
    const ia = y === firstYear && !disposedNow ? bp(additions, iaBp) : 0
    const dep = disposedNow ? 0 : bp(opening + additions - ia, rateBp)
    const proceeds = disposedNow ? toCents(a.disposalProceedsCents) ?? 0 : 0
    const closing = opening + additions - ia - dep - proceeds
    row = {
      assetId: a.id, assetTag: a.assetTag, name: a.name, classKey: a.category, rateBp, initialAllowanceBp: iaBp,
      openingWdvCents: opening, additionsCents: additions, initialAllowanceCents: ia, depreciationCents: dep,
      disposalProceedsCents: proceeds, closingWdvCents: closing, frozen: false,
    }
    wdv = closing
  }
  // A fully deducted smallwares item has nothing left to show after its year.
  if (pooled && row && !row.frozen && row.additionsCents === 0 && row.openingWdvCents === 0
    && row.disposalProceedsCents === 0 && row.closingWdvCents === 0) return null
  return row
}

/**
 * `tenantId`'s tax depreciation schedule for income-tax year `taxYear`
 * (one row per asset in use that year). Frozen years are used as frozen.
 */
export async function taxSchedule(tenantId: string, taxYear: number, db: Db = serviceClient): Promise<TaxScheduleResult> {
  const { start, end } = taxYearBounds(taxYear)
  const [assets, classes, frozenRows] = await Promise.all([
    db.fixedAsset.findMany({ where: { tenantId, inServiceAt: { lte: end } }, orderBy: [{ category: 'asc' }, { assetTag: 'asc' }] }),
    getAssetClasses(tenantId, db),
    db.fixedAssetTaxYear.findMany({ where: { tenantId, taxYear: { lte: taxYear } } }),
  ])
  // Legacy rows with no inServiceAt (pre-backfill) are found by acquiredAt.
  const legacy = await db.fixedAsset.findMany({ where: { tenantId, inServiceAt: null, acquiredAt: { lte: end } } })
  const clsByKey = new Map(classes.map((c) => [c.key, c]))
  const frozenByAsset = new Map<string, Map<number, TaxAssetRow>>()
  for (const f of frozenRows) {
    const a = assets.find((x) => x.id === f.assetId) ?? legacy.find((x) => x.id === f.assetId)
    const m = frozenByAsset.get(f.assetId) ?? new Map<number, TaxAssetRow>()
    m.set(f.taxYear, {
      assetId: f.assetId, assetTag: a?.assetTag ?? null, name: a?.name ?? '', classKey: a?.category ?? '',
      rateBp: f.rateBp, initialAllowanceBp: a ? initialAllowanceBpOf(a, clsByKey.get(a.category)) : 0,
      openingWdvCents: toCents(f.openingWdvCents), additionsCents: toCents(f.additionsCents),
      initialAllowanceCents: toCents(f.initialAllowanceCents), depreciationCents: toCents(f.depreciationCents),
      disposalProceedsCents: toCents(f.disposalProceedsCents), closingWdvCents: toCents(f.closingWdvCents), frozen: true,
    })
    frozenByAsset.set(f.assetId, m)
  }

  const rows: TaxAssetRow[] = []
  for (const a of [...assets, ...legacy]) {
    if (!inTaxBase(a)) continue
    const r = walkAsset(a, clsByKey.get(a.category), frozenByAsset.get(a.id) ?? new Map(), taxYear)
    if (r) rows.push(r)
  }
  const totals = zeroTotals()
  const byClassMap = new Map<string, TaxTotals>()
  for (const r of rows) {
    addTo(totals, r)
    const t = byClassMap.get(r.classKey) ?? zeroTotals()
    addTo(t, r)
    byClassMap.set(r.classKey, t)
  }
  const byClass = classes
    .filter((c) => byClassMap.has(c.key))
    .map((c) => ({ classKey: c.key, label: c.label, ...byClassMap.get(c.key)! }))
  const frozen = frozenRows.some((f) => f.taxYear === taxYear)
  return { tenantId, taxYear, start, end, frozen, rows, byClass, totals }
}

/**
 * The CEO freezes a finished tax year: its rows are stored and never change
 * again (a later class-rate edit does not restate it). 422 TAX_YEAR_OPEN
 * before the year has ended; 409 TAX_YEAR_FROZEN when already frozen.
 */
export async function freezeTaxYear(tenantId: string, taxYear: number, frozenById: string): Promise<{ taxYear: number; assets: number; totals: TaxTotals }> {
  const { end } = taxYearBounds(taxYear)
  if (Date.now() <= end.getTime()) {
    throw new AppError('TAX_YEAR_OPEN', `Tax year ${taxYear} runs to 30 June ${taxYear} — it can be frozen once it has ended`, 422)
  }
  return serviceClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fixed_asset_tax_year:${tenantId}:${taxYear}`}))`
    const already = await tx.fixedAssetTaxYear.count({ where: { tenantId, taxYear } })
    if (already > 0) throw new AppError('TAX_YEAR_FROZEN', `Tax year ${taxYear} is already frozen`, 409)
    const s = await taxSchedule(tenantId, taxYear, tx)
    // Smallwares are frozen too: deducted in full in the year bought (H35).
    const rows = s.rows.filter((r) => !r.frozen)
    const totals = zeroTotals()
    for (const r of s.rows) addTo(totals, r)
    if (rows.length > 0) {
      await tx.fixedAssetTaxYear.createMany({
        data: rows.map((r) => ({
          tenantId, assetId: r.assetId, taxYear, rateBp: r.rateBp,
          openingWdvCents: r.openingWdvCents, additionsCents: r.additionsCents, initialAllowanceCents: r.initialAllowanceCents,
          depreciationCents: r.depreciationCents, disposalProceedsCents: r.disposalProceedsCents, closingWdvCents: r.closingWdvCents,
          frozenById,
        })),
      })
    }
    return { taxYear, assets: rows.length, totals }
  }, { timeout: 120_000, maxWait: 30_000 })
}

export interface DeferredTaxResult {
  tenantId: string
  taxYear: number
  asOf: Date
  rateBp: number
  byClass: Array<{ classKey: string; label: string; nbvCents: number; taxWdvCents: number; differenceCents: number; deferredTaxCents: number }>
  totals: { nbvCents: number; taxWdvCents: number; differenceCents: number; deferredTaxCents: number }
}

/**
 * Deferred tax at the tax year end (H24, report only): register NBV − tax WDV
 * per class × the policy rate. Positive = a deferred tax liability.
 */
export async function deferredTax(tenantId: string, taxYear: number, db: Db = serviceClient): Promise<DeferredTaxResult> {
  const { end } = taxYearBounds(taxYear)
  const policy = await getFixedAssetPolicy(tenantId)
  const schedule = await taxSchedule(tenantId, taxYear, db)
  const assets = await db.fixedAsset.findMany({ where: { tenantId, status: { not: 'voided' } } })
  const ids = assets.map((a) => a.id)
  const [charges, events] = await Promise.all([
    db.fixedAssetDepreciation.findMany({ where: { assetId: { in: ids } }, select: { assetId: true, period: true, amountCents: true, reversedAt: true } }),
    db.fixedAssetEvent.findMany({ where: { assetId: { in: ids }, status: 'posted' }, select: { assetId: true, kind: true, status: true, effectiveDate: true, amountCents: true, costOutCents: true, accumOutCents: true } }),
  ])
  const nbvByClass = new Map<string, number>()
  for (const a of assets) {
    const r = nbvAt(
      {
        originalCostCents: toCents(a.originalCostCents), costCents: toCents(a.costCents), carriedAccumulatedCents: toCents(a.carriedAccumulatedCents),
        inServiceAt: a.inServiceAt ?? a.acquiredAt, status: a.status, disposedAt: a.disposedAt, splitFromAssetId: a.splitFromAssetId, createdAt: a.createdAt,
      },
      events.filter((e) => e.assetId === a.id).map((e) => ({
        kind: e.kind, status: e.status, effectiveDate: e.effectiveDate,
        amountCents: toCents(e.amountCents), costOutCents: toCents(e.costOutCents), accumOutCents: toCents(e.accumOutCents),
      })),
      charges.filter((c) => c.assetId === a.id).map((c) => ({ period: c.period, amountCents: toCents(c.amountCents), reversedAt: c.reversedAt })),
      end,
    )
    nbvByClass.set(a.category, (nbvByClass.get(a.category) ?? 0) + r.nbvCents)
  }
  const wdvByClass = new Map(schedule.byClass.map((c) => [c.classKey, c.closingWdvCents]))
  const classes = await getAssetClasses(tenantId, db)
  const byClass = classes
    .filter((c) => nbvByClass.has(c.key) || wdvByClass.has(c.key))
    .map((c) => {
      const nbv = nbvByClass.get(c.key) ?? 0
      const wdv = wdvByClass.get(c.key) ?? 0
      const diff = nbv - wdv
      return { classKey: c.key, label: c.label, nbvCents: nbv, taxWdvCents: wdv, differenceCents: diff, deferredTaxCents: bp(diff, policy.deferredTaxRateBp) }
    })
  const totals = byClass.reduce(
    (t, c) => ({
      nbvCents: t.nbvCents + c.nbvCents, taxWdvCents: t.taxWdvCents + c.taxWdvCents,
      differenceCents: t.differenceCents + c.differenceCents, deferredTaxCents: t.deferredTaxCents + c.deferredTaxCents,
    }),
    { nbvCents: 0, taxWdvCents: 0, differenceCents: 0, deferredTaxCents: 0 },
  )
  return { tenantId, taxYear, asOf: end, rateBp: policy.deferredTaxRateBp, byClass, totals }
}

/**
 * Finance or the CEO ticks / unticks "eligible for initial allowance" on one
 * asset (H42). Tax view only — book depreciation never reads it. The initial
 * allowance only ever falls in the asset's tax year of first use and carries
 * through the WDV of every later year, so once the CEO has frozen THAT year or
 * any later one (for the asset's company) the tick is final: 409
 * TAX_YEAR_FROZEN (applying it "from next year" would change nothing, and
 * silently restating a frozen year is never allowed). Smallwares (deducted in full, H35), non-depreciable
 * classes (land), voided assets and split-off pool layers: 422
 * INITIAL_ALLOWANCE_NOT_APPLICABLE. Takes the freeze's advisory lock for every
 * year from the first to now, so a freeze running at the same moment sees one
 * state or the other. Setting the same effective tick is a no-op (no write).
 * Returns the before / after tick (the caller audits).
 */
export async function setInitialAllowanceEligible(
  tenantId: string,
  assetId: string,
  eligible: boolean,
): Promise<{ before: boolean; after: boolean; taxYear: number; changed: boolean }> {
  return serviceClient.$transaction(async (tx) => {
    const a = await tx.fixedAsset.findFirst({ where: { id: assetId, tenantId } })
    if (!a) throw new AppError('NOT_FOUND', 'Fixed asset not found', 404)
    const classes = await getAssetClasses(tenantId, tx)
    const cls = classes.find((c) => c.key === a.category)
    if (cls?.pooled || cls?.depreciable === false || a.status === 'voided' || a.splitFromAssetId) {
      throw new AppError('INITIAL_ALLOWANCE_NOT_APPLICABLE', cls?.pooled
        ? 'Smallwares are deducted in full in the year bought — no initial allowance'
        : 'This asset gets no initial allowance (not depreciated, voided or a split-off pool layer)', 422)
    }
    const taxYear = taxYearOf(a.inServiceAt ?? a.acquiredAt).taxYear
    const before = initialAllowanceEligibleOf(a)
    // Same effective tick: nothing to change (and no 409 for a no-op).
    if (before === eligible) return { before, after: eligible, taxYear, changed: false }
    // The allowance falls in the first year but flows through the WDV of every
    // later year, so a freeze of the first year OR any later year makes the
    // tick final. Take the freeze's lock for every year from the first to now
    // (ascending; a freeze holds one year's lock only, so no deadlock).
    const lastYear = Math.min(Math.max(taxYearOf(new Date()).taxYear, taxYear), taxYear + 50)
    for (let y = taxYear; y <= lastYear; y++) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fixed_asset_tax_year:${tenantId}:${y}`}))`
    }
    const frozen = await tx.fixedAssetTaxYear.findFirst({ where: { tenantId, taxYear: { gte: taxYear } }, orderBy: { taxYear: 'asc' }, select: { taxYear: true } })
    if (frozen) {
      throw new AppError('TAX_YEAR_FROZEN', `Tax year ${frozen.taxYear} is frozen and already carries this asset's initial allowance (first year ${taxYear}) — the tick can no longer change`, 409, { taxYear, frozenTaxYear: frozen.taxYear })
    }
    await tx.fixedAsset.update({ where: { id: a.id }, data: { initialAllowanceEligible: eligible } })
    return { before, after: eligible, taxYear, changed: true }
  }, { timeout: 30_000, maxWait: 30_000 })
}
