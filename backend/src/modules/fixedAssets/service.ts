// Fixed assets — the engine (v2, wave B).
//
// ONE register (FixedAsset + FixedAssetDepreciation) and ONE depreciation
// path: `chargeThrough`. The worker (03:20 PKT), the "charge now / catch up"
// route, the period-close helper, the backfill re-poster and every event that
// needs the months before it charged first all go through `chargeAssetTx`.
//
// Ledger postings (company = the asset's own company, always):
//   fixed_asset.acquire:<assetId>         Dr class cost (+ Dr input tax 132x) / Cr 1340 advanced, Cr 2012 owed
//   fixed_asset.depreciation:<id>:<YYYY-MM>  Dr 6150 / Cr the class's accumulated code (1591–1599),
//                                          both lines on the brand that month (syncSourcePosting, revisions @n)
//   fixed_asset.acc_dep_reclass:<tenantId>  Dr 1590 / Cr 159x — the one-off move of legacy accumulated
//   (disposal, impairment, transfer, pool write-off, void: events.ts)
//
// Late months (owner decision 6): a month whose end is inside a closed period
// is posted into the open month TODAY with a note naming the original date
// (journal.ts lateDatingFor), under the SAME reference, and
// FixedAssetDepreciation.postedPeriod records where it landed. It is never
// refused and never lands in the closed month. Re-syncs keep the live date
// (keepLiveDate), so a late entry never churns.
//
// A refused asset (missing / inactive account …) never stops the others: it
// raises 'depreciation_failed' + 'posting_failed' (sourceId = entityId = the
// asset id) and the backfill re-poster calls chargeAssetThrough.

import type { FixedAsset, FixedAssetClass, FixedAssetDepreciation, FixedAssetEvent, Prisma, PrismaClient } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import {
  ACCT, postJournalEntry, lateDatingFor, withLateNote, flagPostingFailed, resolvePostingFailed,
  type JournalLineInput, type PostJournalEntryResult,
} from '../accounting/journal.js'
import { syncSourcePosting } from '../accounting/sourcePosting.js'
import { INPUT_TAX_ACCOUNTS } from '../accounting/taxAuthorities.js'
import { toCents, assertMoneyFits } from '../../lib/money.js'
import { flagException } from '../../lib/exceptions.js'
import { withSavepoint } from '../../lib/savepoint.js'
import {
  ASSET_CLASS_DEFAULTS, getAssetClasses, classOf, getFixedAssetPolicy, defaultClassOf, type AssetClassKey,
} from './classes.js'
import {
  isPeriod, periodIndex, periodOfPkt, lastDayPkt, lastCompletedPeriodPkt, planCharges,
  type ScheduleAsset, type ScheduleAdjustment,
} from './schedule.js'

export type Tx = Prisma.TransactionClient | PrismaClient
type Db = Tx

export const ACQUIRE_SOURCE = 'fixed_asset.acquire'
export const DEPRECIATION_SOURCE = 'fixed_asset.depreciation'
export const DISPOSE_SOURCE = 'fixed_asset.dispose'
export const IMPAIRMENT_SOURCE = 'fixed_asset.impairment'
export const TRANSFER_SOURCE = 'fixed_asset.transfer'
export const POOL_WRITE_OFF_SOURCE = 'fixed_asset.pool_write_off'
export const RECLASS_SOURCE = 'fixed_asset.acc_dep_reclass'

// Interactive transactions here can post many months; Prisma's 5 s default is too short.
const TX_OPTS = { timeout: 120_000, maxWait: 30_000 } as const

function isClient(db: Db): db is PrismaClient {
  return typeof (db as PrismaClient).$transaction === 'function'
}

/** Serialise everything that touches one asset (charge, event apply) inside the caller's transaction. */
export async function lockAsset(tx: Db, assetId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'fixed_asset:' + assetId}))`
}

/** An event payload (Json) as a plain object — {} for anything else. */
export function payloadOf(e: { payload: Prisma.JsonValue | null }): Record<string, unknown> {
  const p = e.payload
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
}

// ─── An asset's schedule state ──────────────────────────────────────────────

export interface AssetState {
  asset: FixedAsset
  cls: FixedAssetClass
  schedule: ScheduleAsset
  /** Live (un-reversed) depreciation rows. */
  rows: FixedAssetDepreciation[]
  charged: Map<string, number>
  adjustments: ScheduleAdjustment[]
  /** Posted impairment / allocation events of the asset. */
  events: FixedAssetEvent[]
}

const ACCUM_EVENT_KINDS = ['impairment', 'pool_write_off_alloc', 'pool_transfer_alloc']

export function scheduleAssetOf(asset: FixedAsset, cls: FixedAssetClass | null | undefined): ScheduleAsset {
  return {
    inServiceAt: asset.inServiceAt ?? asset.acquiredAt,
    costCents: toCents(asset.costCents),
    salvageCents: toCents(asset.salvageCents),
    usefulLifeMonths: asset.usefulLifeMonths,
    method: asset.method,
    depreciable: cls ? cls.depreciable && !!cls.accumAccountCode : true,
    carriedAccumulatedCents: toCents(asset.carriedAccumulatedCents),
    disposedAt: asset.status === 'disposed' ? asset.disposedAt : null,
    leaseEndsAt: asset.leaseEndsAt,
  }
}

function adjustmentsOf(events: readonly FixedAssetEvent[]): ScheduleAdjustment[] {
  const out: ScheduleAdjustment[] = []
  for (const e of events) {
    if (e.status !== 'posted') continue
    if (e.kind === 'impairment') out.push({ period: periodOfPkt(e.effectiveDate), kind: 'impairment', cents: toCents(e.amountCents) ?? 0 })
    else if (e.kind === 'pool_write_off_alloc' || e.kind === 'pool_transfer_alloc') {
      out.push({ period: periodOfPkt(e.effectiveDate), kind: 'accum_out', cents: toCents(e.accumOutCents) ?? 0 })
    }
  }
  return out
}

/** Build the states of several assets of one company (one query per table). */
export async function loadAssetStates(db: Db, tenantId: string, assets: FixedAsset[]): Promise<AssetState[]> {
  if (assets.length === 0) return []
  const ids = assets.map((a) => a.id)
  const [classes, rows, events] = await Promise.all([
    getAssetClasses(tenantId, db),
    db.fixedAssetDepreciation.findMany({ where: { assetId: { in: ids }, reversedAt: null }, orderBy: { period: 'asc' } }),
    db.fixedAssetEvent.findMany({ where: { assetId: { in: ids }, status: 'posted', kind: { in: ACCUM_EVENT_KINDS } }, orderBy: { effectiveDate: 'asc' } }),
  ])
  const clsByKey = new Map(classes.map((c) => [c.key, c]))
  return assets.map((asset) => {
    const cls = clsByKey.get(asset.category)
    if (!cls) throw new AppError('ASSET_CLASS', `Asset ${asset.assetTag ?? asset.id} has an unknown class "${asset.category}"`, 422)
    const own = rows.filter((r) => r.assetId === asset.id)
    const ev = events.filter((e) => e.assetId === asset.id)
    return {
      asset,
      cls,
      schedule: scheduleAssetOf(asset, cls),
      rows: own,
      charged: new Map(own.map((r) => [r.period, toCents(r.amountCents)])),
      adjustments: adjustmentsOf(ev),
      events: ev,
    }
  })
}

export async function loadAssetState(db: Db, assetId: string): Promise<AssetState> {
  const asset = await db.fixedAsset.findUnique({ where: { id: assetId } })
  if (!asset) throw new NotFoundError('FixedAsset', assetId)
  return (await loadAssetStates(db, asset.tenantId, [asset]))[0]!
}

/**
 * What sits on the accumulated accounts for this asset, per account code:
 * each live charge on the code it credited (1590 for unreclassed legacy rows,
 * 159x otherwise), carried-in accumulated and impairments on the class code
 * (or the code the event recorded), less what partial outs took out.
 */
export function accumulatedByCode(state: AssetState): Map<string, number> {
  const out = new Map<string, number>()
  const add = (code: string, cents: number) => { if (cents) out.set(code, (out.get(code) ?? 0) + cents) }
  const classCode = state.cls.accumAccountCode
  for (const r of state.rows) add(r.accumCode, toCents(r.amountCents))
  const carried = toCents(state.asset.carriedAccumulatedCents)
  if (carried && classCode) add(classCode, carried)
  for (const e of state.events) {
    const p = payloadOf(e)
    if (e.kind === 'impairment') {
      add(typeof p['accumCode'] === 'string' ? p['accumCode'] : (classCode ?? ACCT.ACC_DEP_LEGACY), toCents(e.amountCents) ?? 0)
    } else {
      const byCode = p['accumOutByCode']
      if (byCode && typeof byCode === 'object' && !Array.isArray(byCode)) {
        for (const [code, cents] of Object.entries(byCode as Record<string, unknown>)) {
          if (typeof cents === 'number') add(code, -cents)
        }
      } else if (classCode) add(classCode, -(toCents(e.accumOutCents) ?? 0))
    }
  }
  for (const [k, v] of out) if (v === 0) out.delete(k)
  return out
}

export function accumulatedTotal(state: AssetState): number {
  let t = 0
  for (const v of accumulatedByCode(state).values()) t += v
  return t
}

// ─── Charging (THE depreciation path) ───────────────────────────────────────

export interface ChargedMonth {
  period: string
  amountCents: number
  late: boolean
  /** The month the entry landed in when it was posted late; null = its own month. */
  postedPeriod: string | null
}

export interface AssetChargeResult {
  assetId: string
  name: string
  status: 'charged' | 'already' | 'none' | 'failed'
  amountCents: number
  months: ChargedMonth[]
  error?: string
}

export interface ChargeRunResult {
  runId: string
  tenantId: string
  throughPeriod: string
  /** Asset-months charged. */
  chargedCount: number
  chargedCents: number
  /** Asset-months posted late into the open month. */
  lateCount: number
  /** Assets that could not be charged (flagged). */
  failedCount: number
  results: AssetChargeResult[]
}

/**
 * Charge one asset's uncharged months, in order, through `throughPeriod`,
 * inside the caller's transaction (takes the asset's advisory lock first and
 * reads its state after it). Throws when a posting is refused — the caller
 * decides whether that fails a run (chargeThrough flags and continues) or an
 * approval (events.ts rolls it back).
 */
export async function chargeAssetTx(
  tx: Db,
  assetId: string,
  throughPeriod: string,
  postedBy: string,
): Promise<Omit<AssetChargeResult, 'error'>> {
  await lockAsset(tx, assetId)
  const asset = await tx.fixedAsset.findUnique({ where: { id: assetId } })
  if (!asset) throw new NotFoundError('FixedAsset', assetId)
  const base = { assetId, name: asset.name, amountCents: 0, months: [] as ChargedMonth[] }
  if (asset.status !== 'active') return { ...base, status: 'none' }
  const state = (await loadAssetStates(tx, asset.tenantId, [asset]))[0]!
  const accumCode = state.cls.accumAccountCode
  if (!state.cls.depreciable || !accumCode || asset.method === 'none') return { ...base, status: 'none' }

  const plan = planCharges(state.schedule, state.charged, state.adjustments, throughPeriod)
  if (plan.length === 0) return { ...base, status: state.charged.has(throughPeriod) ? 'already' : 'none' }

  const months: ChargedMonth[] = []
  for (const m of plan) {
    const dating = await lateDatingFor(tx, asset.tenantId, lastDayPkt(m.period))
    if ('lockedThroughToday' in dating) {
      throw new AppError('BOOKS_CLOSED_TODAY', 'The books are closed through today — depreciation will post once a month is open', 409)
    }
    const memo = `${asset.name}${asset.assetTag ? ` (${asset.assetTag})` : ''}`.slice(0, 200)
    const lines: JournalLineInput[] = [
      { accountCode: ACCT.DEPRECIATION, type: 'debit', amountCents: m.amountCents, conceptId: asset.conceptId, memo },
      { accountCode: accumCode, type: 'credit', amountCents: m.amountCents, conceptId: asset.conceptId, memo },
    ]
    const w = withLateNote(`Depreciation ${m.period} — ${memo}`, lines, dating.memoNote)
    const r = await syncSourcePosting({
      tenantId: asset.tenantId,
      sourceType: DEPRECIATION_SOURCE,
      id: `${asset.id}:${m.period}`,
      desired: { description: w.description, entryDate: dating.entryDate, lines: w.lines },
      postedBy,
      reason: 'Depreciation re-charged',
      tx,
      keepLiveDate: true,
    })
    // Where the entry really sits (a re-sync keeps a late entry's own date).
    let entryDate = dating.entryDate
    if (r.outcome === 'unchanged' && r.entryId) {
      const e = await tx.journalEntry.findUnique({ where: { id: r.entryId }, select: { entryDate: true } })
      if (e) entryDate = e.entryDate
    }
    const landed = periodOfPkt(entryDate)
    const postedPeriod = landed !== m.period ? landed : null
    await tx.fixedAssetDepreciation.upsert({
      where: { assetId_period: { assetId: asset.id, period: m.period } },
      create: {
        tenantId: asset.tenantId, assetId: asset.id, period: m.period, amountCents: m.amountCents,
        accumCode, conceptId: asset.conceptId, locationId: asset.locationId, postedPeriod,
      },
      update: {
        amountCents: m.amountCents, accumCode, conceptId: asset.conceptId, locationId: asset.locationId, postedPeriod,
        revision: { increment: 1 }, reversedAt: null, postedAt: new Date(),
      },
    })
    months.push({ period: m.period, amountCents: m.amountCents, late: postedPeriod !== null, postedPeriod })
  }
  return { ...base, status: 'charged', amountCents: months.reduce((t, m) => t + m.amountCents, 0), months }
}

/**
 * Reverse the live charges of `fromPeriod` and later (a backdated disposal —
 * the disposal month and after are never charged — or a void: every month).
 * Each reversal is dated now ('fixed_asset.depreciation.reversal:<id>:<p>[@n]')
 * and the row is marked reversedAt in the same transaction.
 */
export async function reverseChargesFrom(tx: Db, assetId: string, fromPeriod: string | null, postedBy: string, reason: string): Promise<number> {
  const asset = await tx.fixedAsset.findUnique({ where: { id: assetId }, select: { tenantId: true } })
  if (!asset) throw new NotFoundError('FixedAsset', assetId)
  const rows = await tx.fixedAssetDepreciation.findMany({ where: { assetId, reversedAt: null }, orderBy: { period: 'asc' } })
  let reversed = 0
  for (const r of rows) {
    if (fromPeriod && periodIndex(r.period) < periodIndex(fromPeriod)) continue
    await syncSourcePosting({ tenantId: asset.tenantId, sourceType: DEPRECIATION_SOURCE, id: `${assetId}:${r.period}`, desired: null, postedBy, reason, tx })
    await tx.fixedAssetDepreciation.update({ where: { id: r.id }, data: { reversedAt: new Date() } })
    reversed += toCents(r.amountCents)
  }
  return reversed
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002'
}

async function flagDepreciationFailed(tenantId: string, asset: { id: string; name: string; conceptId: string | null; assetTag: string | null }, throughPeriod: string, reason: string, postedBy: string): Promise<void> {
  const title = `Depreciation could not post — ${asset.name}${asset.assetTag ? ` (${asset.assetTag})` : ''}`
  try {
    const open = await serviceClient.exceptionFlag.findFirst({
      where: { kind: 'depreciation_failed', entityType: 'FixedAsset', entityId: asset.id, status: { in: ['open', 'acknowledged'] } },
      select: { id: true },
    })
    if (!open) {
      await flagException({
        tenantId,
        kind: 'depreciation_failed',
        severity: 'high',
        title,
        description: `The monthly depreciation of ${asset.name} through ${throughPeriod} was refused: ${reason.slice(0, 300)}. `
          + 'The other assets were charged. Fix the cause, then post it from Reconciliation → Backfill unposted (or the register\'s "Charge now").',
        entityType: 'FixedAsset',
        entityId: asset.id,
        conceptId: asset.conceptId,
        metadata: { throughPeriod, reason: reason.slice(0, 500) },
      })
    }
  } catch (err) {
    console.error('[fixedAssets] could not raise depreciation_failed:', (err as Error).message)
  }
  await flagPostingFailed({
    tenantId,
    sourceType: DEPRECIATION_SOURCE,
    sourceId: asset.id,
    entityType: 'FixedAsset',
    entityId: asset.id,
    reason,
    title,
    conceptId: asset.conceptId,
    actorId: postedBy === 'system' || postedBy === 'worker' ? null : postedBy,
    metadata: { throughPeriod },
  })
}

async function resolveDepreciationFlags(tenantId: string, assetId: string): Promise<void> {
  await serviceClient.exceptionFlag.updateMany({
    where: { tenantId, kind: 'depreciation_failed', entityType: 'FixedAsset', entityId: assetId, status: { in: ['open', 'acknowledged'] } },
    data: { status: 'resolved', resolvedAt: new Date(), resolution: 'Charged by the depreciation run' },
  }).catch((err) => console.error('[fixedAssets] could not resolve depreciation_failed:', (err as Error).message))
  await resolvePostingFailed('FixedAsset', assetId, DEPRECIATION_SOURCE, 'Charged by the depreciation run', { tenantIds: [tenantId] })
}

/**
 * Charge every completed month still uncharged, through `throughPeriod`, for
 * each active asset of ONE company (or only `assetIds` of it). Each asset in
 * its own transaction under its advisory lock — a refused asset is flagged and
 * the run carries on. Idempotent: a second (or concurrent) run finds the
 * months charged. 422 MONTH_NOT_ENDED for a month that has not ended (PKT).
 * Writes a FixedAssetRun row.
 *
 * `db` defaults to serviceClient. A transaction client is accepted: each asset
 * then runs behind a SAVEPOINT of it (still never stopping the others).
 */
export async function chargeThrough(
  tenantId: string,
  throughPeriod: string,
  o: { postedBy: string; assetIds?: string[]; db?: Db },
): Promise<ChargeRunResult> {
  if (!isPeriod(throughPeriod)) throw new AppError('BAD_PERIOD', 'Period must be YYYY-MM', 400)
  const last = lastCompletedPeriodPkt()
  if (periodIndex(throughPeriod) > periodIndex(last)) {
    throw new AppError('MONTH_NOT_ENDED', `${throughPeriod} has not ended yet — depreciation is charged for completed months (the last is ${last})`, 422)
  }
  const db = o.db ?? serviceClient
  const postedBy = o.postedBy || 'system'
  const assets = await db.fixedAsset.findMany({
    where: { tenantId, status: 'active', ...(o.assetIds ? { id: { in: o.assetIds } } : {}) },
    select: { id: true, name: true, conceptId: true, assetTag: true },
    orderBy: [{ inServiceAt: 'asc' }, { acquiredAt: 'asc' }, { id: 'asc' }],
  })
  const run = await db.fixedAssetRun.create({
    data: { tenantId, kind: 'depreciation', throughPeriod, triggeredBy: postedBy === 'system' ? 'worker' : postedBy },
    select: { id: true },
  })

  const results: AssetChargeResult[] = []
  let n = 0
  for (const a of assets) {
    n++
    try {
      let outcome: Omit<AssetChargeResult, 'error'>
      if (isClient(db)) {
        outcome = await db.$transaction((tx) => chargeAssetTx(tx, a.id, throughPeriod, postedBy), TX_OPTS)
      } else {
        const sp = await withSavepoint(db, `fa_charge_${n}`, () => chargeAssetTx(db, a.id, throughPeriod, postedBy))
        if (!sp.ok) throw sp.error
        outcome = sp.value
      }
      results.push(outcome)
      if (outcome.status === 'charged') await resolveDepreciationFlags(tenantId, a.id)
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent run charged it between our read and write.
        results.push({ assetId: a.id, name: a.name, status: 'already', amountCents: 0, months: [] })
        continue
      }
      const reason = (err as Error).message ?? String(err)
      results.push({ assetId: a.id, name: a.name, status: 'failed', amountCents: 0, months: [], error: reason })
      if ((err as AppError).code !== 'BOOKS_CLOSED_TODAY') {
        await flagDepreciationFailed(tenantId, a, throughPeriod, reason, postedBy)
      }
    }
  }

  const charged = results.flatMap((r) => r.months)
  const summary = {
    chargedCount: charged.length,
    chargedCents: charged.reduce((t, m) => t + m.amountCents, 0),
    lateCount: charged.filter((m) => m.late).length,
    failedCount: results.filter((r) => r.status === 'failed').length,
  }
  const firstError = results.find((r) => r.error)?.error
  await db.fixedAssetRun.update({
    where: { id: run.id },
    data: { ...summary, finishedAt: new Date(), error: firstError ? firstError.slice(0, 1000) : null },
  })
  return { runId: run.id, tenantId, throughPeriod, ...summary, results }
}

/**
 * The backfill re-poster's entry point for one asset ('fixed_asset.depreciation',
 * flag sourceId = entityId = asset id): charges the asset through
 * `throughPeriod` (clamped to the last completed month), late-dating each
 * month on its own. RepostOptions' entryDate / memoNote are ignored on
 * purpose — every month carries its own date and note.
 */
export async function chargeAssetThrough(
  assetId: string,
  throughPeriod: string,
  o: { postedBy?: string; entryDate?: Date; memoNote?: string } = {},
): Promise<ChargeRunResult> {
  const a = await serviceClient.fixedAsset.findUnique({ where: { id: assetId }, select: { tenantId: true } })
  if (!a) throw new NotFoundError('FixedAsset', assetId)
  const last = lastCompletedPeriodPkt()
  const through = isPeriod(throughPeriod) && periodIndex(throughPeriod) <= periodIndex(last) ? throughPeriod : last
  return chargeThrough(a.tenantId, through, { postedBy: o.postedBy ?? 'system', assetIds: [assetId] })
}

/**
 * Per active asset of one company, the months still to charge through
 * `throughPeriod` (the close check and the register's "uncharged" filter).
 */
export async function unchargedThrough(
  db: Db,
  tenantId: string,
  throughPeriod: string,
): Promise<Array<{ assetId: string; name: string; months: Array<{ period: string; amountCents: number }> }>> {
  const assets = await db.fixedAsset.findMany({ where: { tenantId, status: 'active' } })
  const states = await loadAssetStates(db, tenantId, assets)
  const out: Array<{ assetId: string; name: string; months: Array<{ period: string; amountCents: number }> }> = []
  for (const s of states) {
    if (!s.cls.depreciable || !s.cls.accumAccountCode) continue
    const months = planCharges(s.schedule, s.charged, s.adjustments, throughPeriod)
    if (months.length > 0) out.push({ assetId: s.asset.id, name: s.asset.name, months })
  }
  return out
}

// ─── Acquisition ────────────────────────────────────────────────────────────

export interface AcquisitionAmounts {
  /** Live 1340 advances applied to this asset. */
  advancedCents: number
  /** Still owed to the supplier → 2012 Payables — Capital Suppliers. */
  owedCents: number
  /** Claimable input sales tax (H8) → its authority's 132x code. */
  inputTaxCents: number
  inputTaxCode: string | null
  /** The in-service date: the acquisition's natural date (late rule applies). */
  natural: Date
  postedBy?: string
}

/** @deprecated The pre-v2 call shape (register form / old CapEx capitalise). Removed by w3-fa-api. */
export interface LegacyAcquisitionOptions {
  tx?: Tx
  credits?: Array<{ accountCode: string; amountCents: number; memo?: string }>
  description?: string
}

/**
 * Capitalise an asset: Dr the class's cost code (the asset's costCents — net
 * of claimable input tax) and Dr the input-tax code / Cr 1340 for what was
 * advanced and Cr 2012 for what is still owed. advanced + owed must equal
 * cost + input tax. Dated on the in-service date while that month is open,
 * else today with the late note (owner decision 6). Idempotent on
 * 'fixed_asset.acquire:<assetId>'. Runs in the caller's transaction.
 */
export function postAcquisition(tx: Tx, asset: FixedAsset, a: AcquisitionAmounts): Promise<PostJournalEntryResult>
/** @deprecated Pre-v2 shape kept only so fixedAssets/routes.ts and financePlanning/capexPosting.ts compile until W2/W3 move them. */
export function postAcquisition(assetId: string, postedBy?: string, opts?: LegacyAcquisitionOptions): Promise<PostJournalEntryResult>
export async function postAcquisition(
  first: Tx | string,
  second?: FixedAsset | string,
  third?: AcquisitionAmounts | LegacyAcquisitionOptions,
): Promise<PostJournalEntryResult> {
  if (typeof first === 'string') {
    return postAcquisitionLegacy(first, typeof second === 'string' ? second : undefined, (third ?? {}) as LegacyAcquisitionOptions)
  }
  const tx = first
  const asset = second as FixedAsset
  const a = third as AcquisitionAmounts
  const cls = await classOf(asset.tenantId, asset.category, tx)
  const cost = toCents(asset.costCents)
  const amounts = [a.advancedCents, a.owedCents, a.inputTaxCents]
  if (amounts.some((v) => !Number.isInteger(v) || v < 0)) throw new AppError('ASSET_FUNDING_SPLIT', 'Advances, amount owed and input tax must be whole paisa, not negative', 422)
  for (const v of amounts) assertMoneyFits(v, 'An acquisition amount')
  if (a.inputTaxCents > 0 && (!a.inputTaxCode || !INPUT_TAX_ACCOUNTS.includes(a.inputTaxCode))) {
    throw new AppError('INPUT_TAX_CODE', 'Input tax needs its authority\'s input account (1320–1324)', 422)
  }
  if (a.advancedCents + a.owedCents !== cost + a.inputTaxCents) {
    throw new AppError('ASSET_FUNDING_SPLIT', 'What was advanced plus what is owed must equal the asset\'s cost plus its input tax', 422)
  }
  const dating = await lateDatingFor(tx, asset.tenantId, a.natural)
  if ('lockedThroughToday' in dating) throw new AppError('BOOKS_CLOSED_TODAY', 'The books are closed through today — nothing can be capitalised until a month is open', 409)
  const memo = `${asset.name}${asset.assetTag ? ` (${asset.assetTag})` : ''}`.slice(0, 200)
  const lines: JournalLineInput[] = [
    { accountCode: cls.costAccountCode, type: 'debit', amountCents: cost, conceptId: asset.conceptId, memo },
    ...(a.inputTaxCents > 0 ? [{ accountCode: a.inputTaxCode!, type: 'debit' as const, amountCents: a.inputTaxCents, memo: `Input tax — ${memo}` }] : []),
    ...(a.advancedCents > 0 ? [{ accountCode: ACCT.SUPPLIER_ADVANCES, type: 'credit' as const, amountCents: a.advancedCents, memo: `Advances applied — ${memo}` }] : []),
    ...(a.owedCents > 0 ? [{ accountCode: ACCT.CAPITAL_PAYABLES, type: 'credit' as const, amountCents: a.owedCents, memo: `Still owed — ${memo}` }] : []),
  ]
  const w = withLateNote(`Capitalised ${memo}`, lines, dating.memoNote)
  return postJournalEntry({
    tenantId: asset.tenantId,
    sourceType: ACQUIRE_SOURCE,
    sourceId: asset.id,
    description: w.description,
    entryDate: dating.entryDate,
    postedBy: a.postedBy ?? asset.createdById ?? 'system',
    lines: w.lines,
  }, { tx })
}

async function postAcquisitionLegacy(assetId: string, postedBy: string | undefined, opts: LegacyAcquisitionOptions): Promise<PostJournalEntryResult> {
  const db = opts.tx ?? serviceClient
  const a = await db.fixedAsset.findUniqueOrThrow({ where: { id: assetId } })
  if (!a.acquisitionCreditCode) throw new AppError('ASSET_FUNDING', 'Say how this asset was paid for', 422)
  const assetAccount = defaultClassOf(a.category)?.costAccountCode
  if (!assetAccount) throw new AppError('ASSET_CATEGORY', `Unknown asset category ${a.category}`, 422)
  const cost = toCents(a.costCents)
  const credits = opts.credits ?? [{ accountCode: a.acquisitionCreditCode, amountCents: cost }]
  if (credits.reduce((t, c) => t + c.amountCents, 0) !== cost) {
    throw new AppError('ASSET_FUNDING_SPLIT', 'How the asset was paid for must add up to its cost', 422)
  }
  return postJournalEntry({
    tenantId: a.tenantId,
    sourceType: ACQUIRE_SOURCE,
    sourceId: a.id,
    description: opts.description ?? `Acquired ${a.name}`,
    entryDate: a.inServiceAt ?? a.acquiredAt,
    postedBy: postedBy ?? 'system',
    lines: [
      { accountCode: assetAccount, type: 'debit', amountCents: cost, conceptId: a.conceptId, memo: a.name },
      ...credits.map((c) => ({ accountCode: c.accountCode, type: 'credit' as const, amountCents: c.amountCents, memo: c.memo ?? a.name })),
    ],
  }, { tx: opts.tx })
}

// ─── Legacy 1590 → 1591–1599 (H27, once per company) ────────────────────────

/**
 * Move the legacy accumulated depreciation (rows still on accumCode '1590'
 * of assets still active) to each class's own account: Dr 1590 / Cr 159x,
 * and the rows are re-coded in the same transaction, so a rerun finds
 * nothing. Dated now. The first reclass is 'fixed_asset.acc_dep_reclass:
 * <tenantId>'; a later one (only after an un-disposed legacy asset brings
 * 1590 rows back) is '<tenantId>#n'. Run at boot / by the worker.
 */
export async function reclassLegacyAccumulated(tenantId: string): Promise<{ posted: boolean; cents: number }> {
  return serviceClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'fixed_asset_reclass:' + tenantId}))`
    const rows = await tx.fixedAssetDepreciation.findMany({
      where: { tenantId, accumCode: ACCT.ACC_DEP_LEGACY, reversedAt: null, asset: { status: 'active' } },
      select: { id: true, amountCents: true, asset: { select: { category: true, conceptId: true } } },
    })
    if (rows.length === 0) return { posted: false, cents: 0 }
    const classes = await getAssetClasses(tenantId, tx)
    const codeOf = new Map(classes.map((c) => [c.key, c.accumAccountCode]))
    // Credit per (class code, brand): the v2 charges carry the brand on 159x.
    const credits = new Map<string, { code: string; conceptId: string | null; cents: number; rowIds: string[] }>()
    for (const r of rows) {
      const code = codeOf.get(r.asset.category) ?? defaultClassOf(r.asset.category)?.accumAccountCode
      if (!code) continue // land / unknown class never had a charge to move
      const k = `${code}|${r.asset.conceptId ?? ''}`
      const c = credits.get(k) ?? { code, conceptId: r.asset.conceptId, cents: 0, rowIds: [] }
      c.cents += toCents(r.amountCents)
      c.rowIds.push(r.id)
      credits.set(k, c)
    }
    const total = Array.from(credits.values()).reduce((t, c) => t + c.cents, 0)
    if (total === 0) return { posted: false, cents: 0 }
    const dating = await lateDatingFor(tx, tenantId, new Date())
    if ('lockedThroughToday' in dating) return { posted: false, cents: 0 }
    const prior = await tx.journalEntry.count({ where: { tenantId, reference: { startsWith: `${RECLASS_SOURCE}:${tenantId}` } } })
    await postJournalEntry({
      tenantId,
      sourceType: RECLASS_SOURCE,
      sourceId: prior === 0 ? tenantId : `${tenantId}#${prior + 1}`,
      description: 'Accumulated depreciation moved from the legacy account 1590 to each class\'s own account (H27)',
      entryDate: dating.entryDate,
      postedBy: 'system',
      lines: [
        { accountCode: ACCT.ACC_DEP_LEGACY, type: 'debit', amountCents: total, memo: 'Legacy accumulated depreciation' },
        ...Array.from(credits.values()).map((c) => ({
          accountCode: c.code, type: 'credit' as const, amountCents: c.cents, conceptId: c.conceptId, memo: 'From 1590 (legacy)',
        })),
      ],
    }, { tx })
    for (const c of credits.values()) {
      await tx.fixedAssetDepreciation.updateMany({ where: { id: { in: c.rowIds } }, data: { accumCode: c.code } })
    }
    return { posted: true, cents: total }
  }, TX_OPTS)
}

// ─── Asset tags ─────────────────────────────────────────────────────────────

/**
 * The company's next asset tag (policy prefix + 5 digits: FA-00001), under
 * an advisory lock held to the end of the caller's transaction — call it in
 * the transaction that creates the asset.
 */
export async function nextAssetTag(tx: Tx, tenantId: string): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'fixed_asset_tag:' + tenantId}))`
  const prefix = (await getFixedAssetPolicy(tenantId)).assetTagPrefix
  const rows = await tx.fixedAsset.findMany({ where: { tenantId, assetTag: { startsWith: prefix } }, select: { assetTag: true } })
  let max = 0
  for (const r of rows) {
    const rest = r.assetTag!.slice(prefix.length)
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest))
  }
  return `${prefix}${String(max + 1).padStart(5, '0')}`
}

// ─── Deprecated aliases (removed by w3-fa-api once no importer remains) ─────

/** @deprecated Use classes.ts ASSET_CLASS_DEFAULTS / getAssetClasses. Key → { label, account (cost code) }. */
export const ASSET_CATEGORIES = Object.fromEntries(
  ASSET_CLASS_DEFAULTS.map((c) => [c.key, { label: c.label, account: c.costAccountCode }]),
) as Record<AssetClassKey, { label: string; account: string }>
/** @deprecated Use AssetClassKey. */
export type AssetCategory = AssetClassKey

/**
 * How a pre-v2 asset was paid for (the old register form). Read-only: kept
 * so old rows still label; new assets come only through CapEx (Cr 1340 /
 * 2012) — owner: no opening / pre-servd assets.
 */
export const FUNDING = {
  bank:     { label: 'Paid from bank',                    account: '1020' },
  cash:     { label: 'Paid in cash',                      account: '1010' },
  payable:  { label: 'On credit from the supplier',       account: '2010' },
  existing: { label: 'Already owned (opening balance)',   account: '3010' },
  advance:  { label: 'Paid as supplier advances (capex)', account: '1340' },
} as const
export type Funding = keyof typeof FUNDING

/** @deprecated Use schedule.ts periodOfPkt (PKT months). */
export function periodOf(d: Date): string {
  return periodOfPkt(d)
}

/**
 * @deprecated Use chargeThrough (the one path). Charges every completed month
 * through `period` (not only that month) and answers in the old shape.
 */
export async function runDepreciation(tenantId: string, period: string, postedBy?: string) {
  const r = await chargeThrough(tenantId, period, { postedBy: postedBy ?? 'system' })
  return {
    period,
    chargedCents: r.chargedCents,
    results: r.results.map((x) => ({
      assetId: x.assetId, name: x.name, amountCents: x.amountCents,
      status: (x.status === 'failed' ? 'none' : x.status) as 'charged' | 'already' | 'none',
    })),
  }
}

/**
 * @deprecated The register's old direct disposal. It now applies a 'disposal'
 * event at once (events.ts — the same posting a CEO-approved request makes),
 * with the proceeds banked. Removed by w3-fa-api (POST /:id/dispose becomes a
 * request).
 */
export async function disposeAsset(
  assetId: string,
  opts: { disposedAt: Date; proceedsCents: number; postedBy?: string },
): Promise<{ bookValueCents: number; proceedsCents: number; gainLossCents: number }> {
  const { applyDisposalNow } = await import('./events.js')
  return applyDisposalNow(assetId, opts)
}
