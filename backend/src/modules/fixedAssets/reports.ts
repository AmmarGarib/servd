// Fixed-asset reports (v2, wave B) — read-only; nothing here posts.
//
//   GET  /accounting/fixed-assets/reports/schedule?from&to&groupBy   depreciation by month: posted + still to charge
//   GET  /accounting/fixed-assets/reports/roll-forward?from&to       cost and accumulated per class, tied to the GL
//   GET  /accounting/fixed-assets/reports/nbv?asOf&groupBy           net book value at a date (brand / outlet as of then)
//   GET  /accounting/fixed-assets/reports/tie-out?asOf               register vs GL per class code, 1590 residue,
//                                                                    2012 / 1310 / 1360 vs what CapEx and OpEx posted
//   GET  /accounting/fixed-assets/reports/advances?asOf              1340 supplier advances by CapEx line, with flags
//   GET  /accounting/fixed-assets/reports/tax?taxYear                ITO Third Schedule (H23), the ACTIVE company
//   POST /accounting/fixed-assets/reports/tax/:taxYear/freeze        the CEO freezes a finished tax year
//
// Every read is READERS (FINANCIALS_VIEWERS) over resolveTenantScope (the
// active company, or every company of the operator in the portfolio view);
// format=csv answers the SAME rows as the JSON `rows` (lib csv toCsv).
//
// Two clocks (critic): NBV and the schedule are ECONOMIC (a month's charge
// counts once the month has ended — schedule.ts nbvAt); the tie-out and the
// roll-forward compare with the ledger and so date every register movement
// the way it hit the books — a late month by its postedPeriod (the row's
// postedAt), an acquisition by its journal entry's date, an event by its
// entry's date. The worker's fixed_asset_gl_mismatch flag compares CURRENT
// balances only (no date at all).
//
// H24 (accountant, 2026-10-14): no deferred-tax figure is needed — there is
// deliberately no deferred-tax report or route here. Smallwares (pooled
// classes) are deducted in full for tax in the year bought (H35, 2026-10-15).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { FixedAsset, FixedAssetClass, FixedAssetDepreciation, FixedAssetEvent, Prisma, PrismaClient, UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError } from '../../lib/errors.js'
import { toCents, sumCents } from '../../lib/money.js'
import { resolveTenantScope, activeTenantId } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { ledgerBalancesByCode } from '../../lib/bankAccounts.js'
import { exportFormatOf, sendReportFor, type ExportFormat } from '../../lib/reportExport.js'
import { ACCT } from '../accounting/journal.js'
import { taxYearOf } from '../accounting/fiscalYear.js'
import { findOrphanAdvances } from '../financePlanning/capexPosting.js'
import { getAssetClasses, getFixedAssetPolicy, defaultClassOf } from './classes.js'
import {
  nbvAt, lastDayPkt, periodIndex, periodFromIndex, isPeriod, planCharges, lastCompletedPeriodPkt, currentPeriodPkt,
} from './schedule.js'
import { loadAssetStates, payloadOf, ACQUIRE_SOURCE, RECLASS_SOURCE } from './service.js'
import { taxSchedule, freezeTaxYear, type TaxAssetRow, type TaxTotals } from './tax.js'

export type Db = Prisma.TransactionClient | PrismaClient

const READERS = FINANCIALS_VIEWERS
const APPROVER = ADMIN_ONLY as UserRole[]
const ALLOC_KINDS = new Set(['pool_write_off_alloc', 'pool_transfer_alloc'])
const DELIVERED = ['delivered', 'installed', 'commissioned', 'done']
const PKT_MS = 5 * 3_600_000
const DAY_MS = 86_400_000

// ─── Dates (PKT) ─────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' (PKT) of an instant. */
export function pktDay(d: Date): string {
  return new Date(d.getTime() + PKT_MS).toISOString().slice(0, 10)
}

/** 00:00 PKT of a 'YYYY-MM-DD'. 400 BAD_DATE otherwise. */
export function startOfPktDay(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError('BAD_DATE', 'Dates look like 2026-06-30', 400)
  const d = new Date(`${day}T00:00:00+05:00`)
  if (Number.isNaN(d.getTime())) throw new AppError('BAD_DATE', 'Dates look like 2026-06-30', 400)
  return d
}

/** 23:59:59.999 PKT of a 'YYYY-MM-DD' — "as of the end of that day". */
export function endOfPktDay(day: string): Date {
  return new Date(startOfPktDay(day).getTime() + DAY_MS - 1)
}

// ─── The register, loaded once per request ──────────────────────────────────

export interface RegisterData {
  /** Company id → name (every company asked for). */
  companies: Map<string, string>
  assets: FixedAsset[]
  /** Company id → its classes (classes.ts getAssetClasses). */
  classes: Map<string, FixedAssetClass[]>
  /** Asset id → every depreciation row (reversed ones included), by period. */
  rows: Map<string, FixedAssetDepreciation[]>
  /** Asset id → its POSTED events, by effective date. */
  events: Map<string, FixedAssetEvent[]>
}

function groupBy<T>(items: readonly T[], key: (t: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    if (k === null) continue
    const list = out.get(k)
    if (list) list.push(it)
    else out.set(k, [it])
  }
  return out
}

/**
 * The register of `tenantIds` (optionally narrowed by `where`), with each
 * company's classes, every depreciation row and every posted event. The
 * company filter is applied last, so `where` can never widen it; an empty
 * list reads nothing.
 */
export async function loadRegister(db: Db, tenantIds: string[], where: Prisma.FixedAssetWhereInput = {}): Promise<RegisterData> {
  const companies = new Map<string, string>()
  if (tenantIds.length === 0) return { companies, assets: [], classes: new Map(), rows: new Map(), events: new Map() }
  const [tenants, assets, classLists] = await Promise.all([
    db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
    db.fixedAsset.findMany({
      where: { ...where, tenantId: { in: tenantIds } },
      orderBy: [{ tenantId: 'asc' }, { category: 'asc' }, { assetTag: 'asc' }, { id: 'asc' }],
    }),
    Promise.all(tenantIds.map(async (t) => [t, await getAssetClasses(t, db)] as const)),
  ])
  for (const t of tenants) companies.set(t.id, t.name)
  const ids = assets.map((a) => a.id)
  const [rows, events] = ids.length === 0 ? [[], []] : await Promise.all([
    db.fixedAssetDepreciation.findMany({ where: { assetId: { in: ids } }, orderBy: { period: 'asc' } }),
    db.fixedAssetEvent.findMany({ where: { assetId: { in: ids }, status: 'posted' }, orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }] }),
  ])
  return {
    companies,
    assets,
    classes: new Map(classLists),
    rows: groupBy(rows, (r) => r.assetId),
    events: groupBy(events, (e) => e.assetId),
  }
}

export function classOfAsset(data: RegisterData, a: Pick<FixedAsset, 'tenantId' | 'category'>): FixedAssetClass | undefined {
  return data.classes.get(a.tenantId)?.find((c) => c.key === a.category)
}

/** Cost, accumulated and NBV of one asset at `asOf` (economic — schedule.ts nbvAt). */
export function assetNbvAt(data: RegisterData, a: FixedAsset, asOf: Date): { costCents: number; accumulatedCents: number; nbvCents: number } {
  return nbvAt(
    {
      originalCostCents: toCents(a.originalCostCents), costCents: toCents(a.costCents), carriedAccumulatedCents: toCents(a.carriedAccumulatedCents),
      inServiceAt: a.inServiceAt ?? a.acquiredAt, status: a.status, disposedAt: a.disposedAt, splitFromAssetId: a.splitFromAssetId, createdAt: a.createdAt,
    },
    (data.events.get(a.id) ?? []).map((e) => ({
      kind: e.kind, status: e.status, effectiveDate: e.effectiveDate,
      amountCents: toCents(e.amountCents), costOutCents: toCents(e.costOutCents), accumOutCents: toCents(e.accumOutCents),
    })),
    (data.rows.get(a.id) ?? []).map((r) => ({ period: r.period, amountCents: toCents(r.amountCents), reversedAt: r.reversedAt })),
    asOf,
  )
}

/** The brand and outlet an individual asset sat at on `asOf` (later posted transfers walked back). */
export function dimsAt(data: RegisterData, a: FixedAsset, asOf: Date): { conceptId: string | null; locationId: string | null } {
  let conceptId = a.conceptId
  let locationId = a.locationId
  const later = (data.events.get(a.id) ?? [])
    .filter((e) => e.kind === 'transfer' && e.effectiveDate.getTime() > asOf.getTime())
    .sort((x, y) => y.effectiveDate.getTime() - x.effectiveDate.getTime())
  for (const e of later) {
    const p = payloadOf(e)
    if ('fromConceptId' in p) conceptId = (p['fromConceptId'] as string | null) ?? null
    if ('fromLocationId' in p) locationId = (p['fromLocationId'] as string | null) ?? null
  }
  return { conceptId, locationId }
}

// ─── Register movements, dated as they hit the books ────────────────────────

export type MovementKind =
  | 'addition' | 'transfer_in' | 'transfer_out' | 'depreciation' | 'depreciation_reversed' | 'impairment'
  | 'write_off' | 'disposal' | 'undispose' | 'void' | 'reclass'

export interface Movement {
  tenantId: string
  /** The ledger code the register says moved (cost code, class accumulated code or legacy 1590). */
  code: string
  kind: MovementKind
  /** + debit for a cost code; + credit (more accumulated) for an accumulated code. */
  cents: number
  at: Date
}

const EPOCH = new Date(0)

/** Split `total` over `weights` (proportional, remainder on the largest), or put it all on `fallback`. */
function splitByWeights(total: number, weights: Map<string, number>, fallback: string | null): Map<string, number> {
  const positive = [...weights].filter(([, v]) => v > 0)
  const sum = positive.reduce((t, [, v]) => t + v, 0)
  if (sum === total) return new Map(positive)
  if (positive.length === 0 || sum <= 0) return fallback && total ? new Map([[fallback, total]]) : new Map()
  const out = new Map<string, number>()
  let given = 0
  positive.sort((x, y) => y[1] - x[1])
  for (const [code, v] of positive) {
    const share = Math.floor((total * v) / sum)
    out.set(code, share)
    given += share
  }
  const top = positive[0]![0]
  out.set(top, (out.get(top) ?? 0) + (total - given))
  return out
}

/**
 * Every movement of the register of `data`, on its ledger code, dated the way
 * the ledger has it. Summing them through a date gives what the register says
 * each fixed-asset code should hold then; fixedAssetTieOut compares that with
 * the ledger.
 */
export async function registerMovements(db: Db, data: RegisterData): Promise<Movement[]> {
  const tenantIds = [...data.companies.keys()]
  const ids = data.assets.map((a) => a.id)
  const eventEntryIds = [...data.events.values()].flat().flatMap((e) => (e.journalEntryId ? [e.journalEntryId] : []))
  const [acquisitions, eventEntries, reclasses] = await Promise.all([
    ids.length === 0 ? [] : db.journalEntry.findMany({
      where: { tenantId: { in: tenantIds }, reference: { in: ids.map((id) => `${ACQUIRE_SOURCE}:${id}`) } },
      select: { reference: true, entryDate: true },
    }),
    eventEntryIds.length === 0 ? [] : db.journalEntry.findMany({ where: { id: { in: eventEntryIds } }, select: { id: true, entryDate: true } }),
    tenantIds.length === 0 ? [] : db.journalEntry.findMany({
      where: { tenantId: { in: tenantIds }, reference: { startsWith: `${RECLASS_SOURCE}:` } },
      select: { tenantId: true, entryDate: true, lines: { select: { type: true, amountCents: true, account: { select: { code: true } } } } },
    }),
  ])
  const acqDate = new Map(acquisitions.map((e) => [e.reference!.slice(ACQUIRE_SOURCE.length + 1), e.entryDate]))
  const entryDate = new Map(eventEntries.map((e) => [e.id, e.entryDate]))
  const out: Movement[] = []

  for (const a of data.assets) {
    const cls = classOfAsset(data, a)
    const cc = cls?.costAccountCode ?? defaultClassOf(a.category)?.costAccountCode ?? null
    const ac = cls?.accumAccountCode ?? defaultClassOf(a.category)?.accumAccountCode ?? null
    const push = (code: string | null, kind: MovementKind, cents: number, at: Date) => {
      if (code && cents) out.push({ tenantId: a.tenantId, code, kind, cents, at })
    }
    const rows = data.rows.get(a.id) ?? []
    const events = data.events.get(a.id) ?? []
    const allocs = events.filter((e) => ALLOC_KINDS.has(e.kind))
    const carried = toCents(a.carriedAccumulatedCents)
    const orig = toCents(a.originalCostCents) > 0
      ? toCents(a.originalCostCents)
      : toCents(a.costCents) + allocs.reduce((t, e) => t + (toCents(e.costOutCents) ?? 0), 0)

    // On the books: capitalised (acquisition entry) or split off a pool layer.
    if (a.splitFromAssetId) {
      push(cc, 'transfer_in', orig, a.createdAt)
      push(ac, 'transfer_in', carried, a.createdAt)
    } else {
      const at = acqDate.get(a.id) ?? a.inServiceAt ?? a.acquiredAt
      push(cc, 'addition', orig, at)
      push(ac, 'addition', carried, at)
    }

    // Monthly charges: on time = the month's last day; late = when posted.
    for (const r of rows) {
      const amt = toCents(r.amountCents)
      push(r.accumCode, 'depreciation', amt, r.postedPeriod ? r.postedAt : lastDayPkt(r.period))
      if (r.reversedAt) push(r.accumCode, 'depreciation_reversed', -amt, r.reversedAt)
    }

    // What sits on each accumulated code for this asset now — the split a
    // disposal took out (its event stores the total only).
    const weights = new Map<string, number>()
    const addW = (code: string | null, cents: number) => { if (code && cents) weights.set(code, (weights.get(code) ?? 0) + cents) }
    for (const r of rows) if (!r.reversedAt) addW(r.accumCode, toCents(r.amountCents))
    addW(ac, carried)

    let lastDisposal: { cost: number; byCode: Map<string, number> } | null = null
    for (const e of events) {
      const at = (e.journalEntryId ? entryDate.get(e.journalEntryId) : undefined) ?? e.postedAt ?? e.effectiveDate
      const p = payloadOf(e)
      if (e.kind === 'impairment') {
        const code = typeof p['accumCode'] === 'string' ? p['accumCode'] : ac
        push(code, 'impairment', toCents(e.amountCents) ?? 0, at)
        addW(code, toCents(e.amountCents) ?? 0)
      } else if (ALLOC_KINDS.has(e.kind)) {
        const kind: MovementKind = e.kind === 'pool_write_off_alloc' ? 'write_off' : 'transfer_out'
        push(cc, kind, -(toCents(e.costOutCents) ?? 0), at)
        const byCode = p['accumOutByCode']
        if (byCode && typeof byCode === 'object' && !Array.isArray(byCode)) {
          for (const [code, cents] of Object.entries(byCode as Record<string, unknown>)) {
            if (typeof cents === 'number') { push(code, kind, -cents, at); addW(code, -cents) }
          }
        } else {
          push(ac, kind, -(toCents(e.accumOutCents) ?? 0), at)
          addW(ac, -(toCents(e.accumOutCents) ?? 0))
        }
      }
    }
    for (const e of events) {
      const at = (e.journalEntryId ? entryDate.get(e.journalEntryId) : undefined) ?? e.postedAt ?? e.effectiveDate
      if (e.kind === 'disposal') {
        const cost = toCents(e.costOutCents) ?? toCents(a.costCents)
        const total = toCents(e.accumOutCents) ?? [...weights.values()].reduce((t, v) => t + Math.max(0, v), 0)
        const byCode = splitByWeights(total, weights, ac)
        push(cc, 'disposal', -cost, at)
        for (const [code, cents] of byCode) push(code, 'disposal', -cents, at)
        lastDisposal = { cost, byCode }
      } else if (e.kind === 'undispose' && lastDisposal) {
        const back = e.postedAt ?? e.effectiveDate
        push(cc, 'undispose', lastDisposal.cost, back)
        for (const [code, cents] of lastDisposal.byCode) push(code, 'undispose', cents, back)
        lastDisposal = null
      }
    }

    // A pre-v2 disposal with no event row: off the books on its date.
    if (a.status === 'disposed' && a.kind !== 'pool_layer' && a.disposedAt && !events.some((e) => e.kind === 'disposal')) {
      push(cc, 'disposal', -toCents(a.costCents), a.disposedAt)
      for (const [code, cents] of weights) if (cents > 0) push(code, 'disposal', -cents, a.disposedAt)
    }

    // Void: the acquisition and every impairment reversed (the monthly charges
    // carry their own reversedAt above).
    if (a.status === 'voided') {
      const at = a.voidedAt ?? a.updatedAt
      push(cc, 'void', -toCents(a.costCents), at)
      for (const e of events) {
        if (e.kind !== 'impairment') continue
        const p = payloadOf(e)
        push(typeof p['accumCode'] === 'string' ? p['accumCode'] : ac, 'void', -(toCents(e.amountCents) ?? 0), at)
      }
    }
  }

  // The one-off H27 move 1590 → 159x. The moved rows now say 159x from their
  // own dates, but until the reclass entry the ledger held them on 1590.
  for (const r of reclasses) {
    if (!r.tenantId) continue
    for (const l of r.lines) {
      if (l.type !== 'credit' || l.account.code === ACCT.ACC_DEP_LEGACY) continue
      const cents = toCents(l.amountCents)
      out.push({ tenantId: r.tenantId, code: l.account.code, kind: 'reclass', cents: -cents, at: EPOCH })
      out.push({ tenantId: r.tenantId, code: ACCT.ACC_DEP_LEGACY, kind: 'reclass', cents, at: EPOCH })
      out.push({ tenantId: r.tenantId, code: l.account.code, kind: 'reclass', cents, at: r.entryDate })
      out.push({ tenantId: r.tenantId, code: ACCT.ACC_DEP_LEGACY, kind: 'reclass', cents: -cents, at: r.entryDate })
    }
  }
  return out
}

/** Register balance per `<tenantId>|<code>` through `asOf` (every movement when undefined). */
function sumMovements(movements: readonly Movement[], asOf?: Date): Map<string, number> {
  const out = new Map<string, number>()
  const t = asOf?.getTime()
  for (const m of movements) {
    if (t !== undefined && m.at.getTime() > t) continue
    const k = `${m.tenantId}|${m.code}`
    out.set(k, (out.get(k) ?? 0) + m.cents)
  }
  return out
}

// ─── Tie-out (register vs GL) ───────────────────────────────────────────────

export interface TieOutClass {
  classKey: string
  label: string
  costAccountCode: string
  accumAccountCode: string | null
  registerCostCents: number
  glCostCents: number
  /** GL − register on the cost code. */
  costDiffCents: number
  registerAccumCents: number
  glAccumCents: number
  /** GL − register on the accumulated code (credit balances). */
  accumDiffCents: number
}

export interface TieOutResult {
  tenantId: string
  companyName: string
  byClass: TieOutClass[]
  /** What still sits on the legacy 1590 in the ledger (credit balance) — the residue. */
  legacy1590Cents: number
  /** What the register says should still be on 1590 (rows never reclassed). */
  legacy1590RegisterCents: number
  legacy1590DiffCents: number
  ok: boolean
}

/**
 * Register vs ledger per class (cost and accumulated) of each company, as of
 * `asOf` (posting dates), or on CURRENT balances when `asOf` is omitted (what
 * the worker's fixed_asset_gl_mismatch flag uses). `ok` = every difference 0.
 */
export async function fixedAssetTieOut(db: Db, tenantIds: string[], asOf?: Date): Promise<TieOutResult[]> {
  if (tenantIds.length === 0) return []
  const data = await loadRegister(db, tenantIds)
  const register = sumMovements(await registerMovements(db, data), asOf)
  const out: TieOutResult[] = []
  for (const t of tenantIds) {
    const classes = data.classes.get(t) ?? []
    const codes = [...classes.flatMap((c) => [c.costAccountCode, c.accumAccountCode ?? '']).filter(Boolean), ACCT.ACC_DEP_LEGACY]
    const gl = await ledgerBalancesByCode(t, codes, { asOf, db })
    const reg = (code: string) => register.get(`${t}|${code}`) ?? 0
    const byClass = classes.map((c): TieOutClass => {
      const registerCostCents = reg(c.costAccountCode)
      const glCostCents = gl.get(c.costAccountCode) ?? 0
      const registerAccumCents = c.accumAccountCode ? reg(c.accumAccountCode) : 0
      const glAccumCents = c.accumAccountCode ? 0 - (gl.get(c.accumAccountCode) ?? 0) : 0
      return {
        classKey: c.key, label: c.label, costAccountCode: c.costAccountCode, accumAccountCode: c.accumAccountCode,
        registerCostCents, glCostCents, costDiffCents: glCostCents - registerCostCents,
        registerAccumCents, glAccumCents, accumDiffCents: glAccumCents - registerAccumCents,
      }
    })
    const legacy1590Cents = 0 - (gl.get(ACCT.ACC_DEP_LEGACY) ?? 0)
    const legacy1590RegisterCents = reg(ACCT.ACC_DEP_LEGACY)
    const legacy1590DiffCents = legacy1590Cents - legacy1590RegisterCents
    out.push({
      tenantId: t,
      companyName: data.companies.get(t) ?? '',
      byClass,
      legacy1590Cents,
      legacy1590RegisterCents,
      legacy1590DiffCents,
      ok: legacy1590DiffCents === 0 && byClass.every((c) => c.costDiffCents === 0 && c.accumDiffCents === 0),
    })
  }
  return out
}

/** Net lines on `code` of the journal entries whose reference starts with one of `prefixes`, per company. */
async function postedBySources(db: Db, tenantIds: string[], code: string, prefixes: string[], asOf?: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (tenantIds.length === 0) return out
  const accounts = await db.account.findMany({ where: { tenantId: { in: tenantIds }, code }, select: { id: true, tenantId: true } })
  if (accounts.length === 0) return out
  const lines = await db.journalLine.groupBy({
    by: ['accountId', 'type'],
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      journalEntry: { OR: prefixes.map((p) => ({ reference: { startsWith: p } })), ...(asOf ? { entryDate: { lte: asOf } } : {}) },
    },
    _sum: { amountCents: true },
  })
  const tenantOf = new Map(accounts.map((a) => [a.id, a.tenantId]))
  for (const l of lines) {
    const t = tenantOf.get(l.accountId)
    if (!t) continue
    const amt = sumCents(l._sum.amountCents)
    out.set(t, (out.get(t) ?? 0) + (l.type === 'debit' ? amt : -amt))
  }
  return out
}

/** The tie-out report: the register by class plus the CapEx-side control accounts. */
export async function tieOutReport(db: Db, tenantIds: string[], asOf?: Date) {
  const register = await fixedAssetTieOut(db, tenantIds, asOf)
  // 2012 capital payables: what capitalisations credited and CapEx payments settled.
  const [capexOwed, prepaidHeld, depositsHeld] = await Promise.all([
    postedBySources(db, tenantIds, ACCT.CAPITAL_PAYABLES, ['fixed_asset.acquire', 'capex.payment'], asOf),
    postedBySources(db, tenantIds, ACCT.PREPAID, ['capex.payment', 'opex.payment', 'prepaid.release', 'capex.deposit_reclass'], asOf),
    postedBySources(db, tenantIds, ACCT.SECURITY_DEPOSITS, ['capex.payment', 'capex.deposit_return', 'capex.deposit_reclass'], asOf),
  ])
  const companies = []
  for (const r of register) {
    const gl = await ledgerBalancesByCode(r.tenantId, [ACCT.CAPITAL_PAYABLES, ACCT.PREPAID, ACCT.SECURITY_DEPOSITS], { asOf, db })
    const owedSources = 0 - (capexOwed.get(r.tenantId) ?? 0)
    const owedGl = 0 - (gl.get(ACCT.CAPITAL_PAYABLES) ?? 0)
    const prepaidSources = prepaidHeld.get(r.tenantId) ?? 0
    const prepaidGl = gl.get(ACCT.PREPAID) ?? 0
    const depSources = depositsHeld.get(r.tenantId) ?? 0
    const depGl = gl.get(ACCT.SECURITY_DEPOSITS) ?? 0
    companies.push({
      ...r,
      capitalPayables: { code: ACCT.CAPITAL_PAYABLES, capexOwedCents: owedSources, glCents: owedGl, diffCents: owedGl - owedSources },
      prepaid: { code: ACCT.PREPAID, unreleasedCents: prepaidSources, glCents: prepaidGl, diffCents: prepaidGl - prepaidSources },
      deposits: { code: ACCT.SECURITY_DEPOSITS, heldCents: depSources, glCents: depGl, diffCents: depGl - depSources },
    })
  }
  // Flat rows (the CSV): one per company × check.
  const rows: Array<Record<string, string | number | null>> = []
  for (const c of companies) {
    for (const k of c.byClass) {
      rows.push({ tenantId: c.tenantId, companyName: c.companyName, check: `${k.label} — cost`, code: k.costAccountCode, registerCents: k.registerCostCents, glCents: k.glCostCents, diffCents: k.costDiffCents })
      if (k.accumAccountCode) {
        rows.push({ tenantId: c.tenantId, companyName: c.companyName, check: `${k.label} — accumulated depreciation`, code: k.accumAccountCode, registerCents: k.registerAccumCents, glCents: k.glAccumCents, diffCents: k.accumDiffCents })
      }
    }
    rows.push({ tenantId: c.tenantId, companyName: c.companyName, check: 'Legacy accumulated depreciation (residue)', code: ACCT.ACC_DEP_LEGACY, registerCents: c.legacy1590RegisterCents, glCents: c.legacy1590Cents, diffCents: c.legacy1590DiffCents })
    rows.push({ tenantId: c.tenantId, companyName: c.companyName, check: 'Capital suppliers owed (CapEx)', code: ACCT.CAPITAL_PAYABLES, registerCents: c.capitalPayables.capexOwedCents, glCents: c.capitalPayables.glCents, diffCents: c.capitalPayables.diffCents })
    rows.push({ tenantId: c.tenantId, companyName: c.companyName, check: 'Prepaid not yet released', code: ACCT.PREPAID, registerCents: c.prepaid.unreleasedCents, glCents: c.prepaid.glCents, diffCents: c.prepaid.diffCents })
    rows.push({ tenantId: c.tenantId, companyName: c.companyName, check: 'Security deposits held', code: ACCT.SECURITY_DEPOSITS, registerCents: c.deposits.heldCents, glCents: c.deposits.glCents, diffCents: c.deposits.diffCents })
  }
  return { asOf: asOf ? pktDay(asOf) : null, companies, rows }
}

// ─── Roll-forward ───────────────────────────────────────────────────────────

const COST_COLUMNS: Record<string, MovementKind[]> = {
  additionsCents: ['addition'],
  transfersInCents: ['transfer_in'],
  transfersOutCents: ['transfer_out'],
  writeOffsCents: ['write_off'],
  disposalsCents: ['disposal', 'undispose'],
  voidsCents: ['void'],
}
const ACCUM_COLUMNS: Record<string, MovementKind[]> = {
  accumAddedCents: ['addition', 'transfer_in'],
  depreciationCents: ['depreciation', 'depreciation_reversed'],
  impairmentCents: ['impairment'],
  accumWrittenOffCents: ['write_off'],
  accumTransferredOutCents: ['transfer_out'],
  accumDisposedCents: ['disposal', 'undispose'],
  accumVoidedCents: ['void'],
  reclassCents: ['reclass'],
}

/**
 * Cost and accumulated depreciation per company × class from `from` to `to`
 * (instants, PKT days), every movement dated as it hit the books, with the
 * ledger's closing balance per code beside it (it ties when the diffs are 0).
 * The legacy 1590 is its own row.
 */
export async function rollForward(db: Db, tenantIds: string[], from: Date, to: Date) {
  const data = await loadRegister(db, tenantIds)
  const movements = await registerMovements(db, data)
  const f = from.getTime()
  const t = to.getTime()
  const rows: Array<Record<string, string | number | null>> = []
  for (const tenantId of tenantIds) {
    const classes = data.classes.get(tenantId) ?? []
    const mine = movements.filter((m) => m.tenantId === tenantId)
    const gl = await ledgerBalancesByCode(tenantId, [...classes.flatMap((c) => [c.costAccountCode, c.accumAccountCode ?? '']).filter(Boolean), ACCT.ACC_DEP_LEGACY], { asOf: to, db })
    const sumOf = (code: string | null, pred: (m: Movement) => boolean) => code
      ? mine.filter((m) => m.code === code && pred(m)).reduce((s, m) => s + m.cents, 0)
      : 0
    const inPeriod = (kinds: MovementKind[]) => (m: Movement) => kinds.includes(m.kind) && m.at.getTime() >= f && m.at.getTime() <= t
    const lines: Array<{ classKey: string; label: string; cost: string | null; accum: string | null }> = [
      ...classes.map((c) => ({ classKey: c.key, label: c.label, cost: c.costAccountCode, accum: c.accumAccountCode })),
      { classKey: 'legacy_1590', label: 'Legacy accumulated depreciation (1590)', cost: null, accum: ACCT.ACC_DEP_LEGACY },
    ]
    for (const l of lines) {
      const openingCostCents = sumOf(l.cost, (m) => m.at.getTime() < f)
      const closingCostCents = sumOf(l.cost, (m) => m.at.getTime() <= t)
      const openingAccumCents = sumOf(l.accum, (m) => m.at.getTime() < f)
      const closingAccumCents = sumOf(l.accum, (m) => m.at.getTime() <= t)
      const glCostCents = l.cost ? gl.get(l.cost) ?? 0 : 0
      const glAccumCents = l.accum ? 0 - (gl.get(l.accum) ?? 0) : 0
      const moved = [...Object.values(COST_COLUMNS), ...Object.values(ACCUM_COLUMNS)].some((kinds) => sumOf(l.cost, inPeriod(kinds)) || sumOf(l.accum, inPeriod(kinds)))
      if (!moved && !openingCostCents && !closingCostCents && !openingAccumCents && !closingAccumCents && !glCostCents && !glAccumCents) continue
      const row: Record<string, string | number | null> = {
        tenantId, companyName: data.companies.get(tenantId) ?? '', classKey: l.classKey, label: l.label,
        costAccountCode: l.cost, accumAccountCode: l.accum, openingCostCents,
      }
      for (const [col, kinds] of Object.entries(COST_COLUMNS)) row[col] = sumOf(l.cost, inPeriod(kinds))
      row['closingCostCents'] = closingCostCents
      row['openingAccumCents'] = openingAccumCents
      for (const [col, kinds] of Object.entries(ACCUM_COLUMNS)) row[col] = sumOf(l.accum, inPeriod(kinds))
      row['closingAccumCents'] = closingAccumCents
      row['openingNbvCents'] = openingCostCents - openingAccumCents
      row['closingNbvCents'] = closingCostCents - closingAccumCents
      row['glCostCents'] = glCostCents
      row['glAccumCents'] = glAccumCents
      row['costDiffCents'] = glCostCents - closingCostCents
      row['accumDiffCents'] = glAccumCents - closingAccumCents
      rows.push(row)
    }
  }
  return { from: pktDay(from), to: pktDay(to), rows, ties: rows.every((r) => r['costDiffCents'] === 0 && r['accumDiffCents'] === 0) }
}

// ─── Group labels (brand / outlet / pool names of the companies in scope) ───

async function namesFor(db: Db, data: RegisterData) {
  const conceptIds = new Set<string>()
  const locationIds = new Set<string>()
  const poolIds = new Set<string>()
  for (const a of data.assets) {
    if (a.conceptId) conceptIds.add(a.conceptId)
    if (a.locationId) locationIds.add(a.locationId)
    if (a.poolId) poolIds.add(a.poolId)
    for (const e of data.events.get(a.id) ?? []) {
      const p = payloadOf(e)
      if (typeof p['fromConceptId'] === 'string') conceptIds.add(p['fromConceptId'])
      if (typeof p['fromLocationId'] === 'string') locationIds.add(p['fromLocationId'])
    }
    for (const r of data.rows.get(a.id) ?? []) {
      if (r.conceptId) conceptIds.add(r.conceptId)
      if (r.locationId) locationIds.add(r.locationId)
    }
  }
  const [concepts, locations, pools] = await Promise.all([
    conceptIds.size ? db.concept.findMany({ where: { id: { in: [...conceptIds] } }, select: { id: true, name: true } }) : [],
    locationIds.size ? db.location.findMany({ where: { id: { in: [...locationIds] } }, select: { id: true, name: true } }) : [],
    poolIds.size ? db.fixedAssetPool.findMany({ where: { id: { in: [...poolIds] } }, select: { id: true, label: true } }) : [],
  ])
  return {
    concept: new Map(concepts.map((c) => [c.id, c.name])),
    location: new Map(locations.map((l) => [l.id, l.name])),
    pool: new Map(pools.map((p) => [p.id, p.label])),
  }
}

export const NBV_GROUPS = ['class', 'brand', 'location', 'pool', 'company', 'asset'] as const
export type NbvGroup = (typeof NBV_GROUPS)[number]
export const SCHEDULE_GROUPS = ['class', 'brand', 'location', 'pool', 'asset'] as const
export type ScheduleGroup = (typeof SCHEDULE_GROUPS)[number]

type Names = Awaited<ReturnType<typeof namesFor>>

function groupKey(
  by: NbvGroup,
  data: RegisterData,
  names: Names,
  a: FixedAsset,
  dims: { conceptId: string | null; locationId: string | null },
): { key: string; label: string } {
  switch (by) {
    case 'class': return { key: a.category, label: classOfAsset(data, a)?.label ?? a.category }
    case 'brand': return { key: dims.conceptId ?? 'shared', label: dims.conceptId ? names.concept.get(dims.conceptId) ?? 'Unknown brand' : 'Shared across brands' }
    case 'location': return { key: dims.locationId ?? 'none', label: dims.locationId ? names.location.get(dims.locationId) ?? 'Unknown outlet' : 'No outlet' }
    case 'pool': return { key: a.poolId ?? 'individual', label: a.poolId ? names.pool.get(a.poolId) ?? 'Pool' : 'Individual items (not pooled)' }
    case 'company': return { key: a.tenantId, label: data.companies.get(a.tenantId) ?? '' }
    case 'asset': return { key: a.id, label: `${a.assetTag ? `${a.assetTag} ` : ''}${a.name}` }
  }
}

// ─── NBV at a date ──────────────────────────────────────────────────────────

/** Net book value at `asOf` (economic), grouped. Brand and outlet are where the asset was then. */
export async function nbvReport(db: Db, tenantIds: string[], asOf: Date, by: NbvGroup) {
  const data = await loadRegister(db, tenantIds)
  const names = await namesFor(db, data)
  const groups = new Map<string, Record<string, string | number | null>>()
  for (const a of data.assets) {
    const v = assetNbvAt(data, a, asOf)
    if (v.costCents === 0 && v.accumulatedCents === 0) continue
    const g = groupKey(by, data, names, a, dimsAt(data, a, asOf))
    const k = `${a.tenantId}|${g.key}`
    const row = groups.get(k) ?? { tenantId: a.tenantId, companyName: data.companies.get(a.tenantId) ?? '', key: g.key, label: g.label, assets: 0, costCents: 0, accumulatedCents: 0, nbvCents: 0 }
    row['assets'] = (row['assets'] as number) + 1
    row['costCents'] = (row['costCents'] as number) + v.costCents
    row['accumulatedCents'] = (row['accumulatedCents'] as number) + v.accumulatedCents
    row['nbvCents'] = (row['nbvCents'] as number) + v.nbvCents
    groups.set(k, row)
  }
  const rows = [...groups.values()].sort((x, y) => String(x['companyName']).localeCompare(String(y['companyName'])) || String(x['label']).localeCompare(String(y['label'])))
  const totals = rows.reduce<{ costCents: number; accumulatedCents: number; nbvCents: number }>((t, r) => ({
    costCents: t.costCents + (r['costCents'] as number),
    accumulatedCents: t.accumulatedCents + (r['accumulatedCents'] as number),
    nbvCents: t.nbvCents + (r['nbvCents'] as number),
  }), { costCents: 0, accumulatedCents: 0, nbvCents: 0 })
  return { asOf: pktDay(asOf), groupBy: by, rows, totals }
}

// ─── Depreciation schedule (posted + still to charge) ───────────────────────

/**
 * Depreciation by economic month from `from` to `to` ('YYYY-MM'), grouped:
 * what is posted (live rows, on the brand / outlet charged then) and what the
 * schedule still has to charge (active assets — past months not yet charged
 * included). 400 BAD_PERIOD; at most 120 months.
 */
export async function scheduleReport(db: Db, tenantIds: string[], from: string, to: string, by: ScheduleGroup) {
  if (!isPeriod(from) || !isPeriod(to) || periodIndex(to) < periodIndex(from)) {
    throw new AppError('BAD_PERIOD', 'Months look like 2026-07, and "to" must not be before "from"', 400)
  }
  if (periodIndex(to) - periodIndex(from) >= 120) throw new AppError('BAD_PERIOD', 'Ask for at most 120 months at a time', 400)
  const data = await loadRegister(db, tenantIds)
  const names = await namesFor(db, data)
  const cells = new Map<string, Record<string, string | number | null>>()
  const add = (a: FixedAsset, dims: { conceptId: string | null; locationId: string | null }, period: string, field: 'postedCents' | 'forecastCents', cents: number) => {
    if (!cents || periodIndex(period) < periodIndex(from) || periodIndex(period) > periodIndex(to)) return
    const g = groupKey(by, data, names, a, dims)
    const k = `${a.tenantId}|${g.key}|${period}`
    const row = cells.get(k) ?? { tenantId: a.tenantId, companyName: data.companies.get(a.tenantId) ?? '', key: g.key, label: g.label, period, postedCents: 0, forecastCents: 0 }
    row[field] = (row[field] as number) + cents
    cells.set(k, row)
  }
  for (const a of data.assets) {
    for (const r of data.rows.get(a.id) ?? []) {
      if (r.reversedAt) continue
      add(a, { conceptId: r.conceptId, locationId: r.locationId }, r.period, 'postedCents', toCents(r.amountCents))
    }
  }
  for (const t of tenantIds) {
    const active = data.assets.filter((a) => a.tenantId === t && a.status === 'active')
    for (const s of await loadAssetStates(db, t, active)) {
      if (!s.cls.depreciable || !s.cls.accumAccountCode) continue
      for (const m of planCharges(s.schedule, s.charged, s.adjustments, to)) {
        add(s.asset, { conceptId: s.asset.conceptId, locationId: s.asset.locationId }, m.period, 'forecastCents', m.amountCents)
      }
    }
  }
  const rows = [...cells.values()].sort((x, y) =>
    String(x['companyName']).localeCompare(String(y['companyName'])) || String(x['label']).localeCompare(String(y['label'])) || String(x['period']).localeCompare(String(y['period'])))
  const months: string[] = []
  for (let i = periodIndex(from); i <= periodIndex(to); i++) months.push(periodFromIndex(i))
  const totals = {
    postedCents: rows.reduce((s, r) => s + (r['postedCents'] as number), 0),
    forecastCents: rows.reduce((s, r) => s + (r['forecastCents'] as number), 0),
  }
  return { from, to, groupBy: by, months, lastCompletedPeriod: lastCompletedPeriodPkt(), rows, totals }
}

// ─── 1340 supplier advances by CapEx line ───────────────────────────────────

/** Net lines on `code` per base source id of entries whose reference starts with `prefix` (reversals included). */
async function netBySourceId(db: Db, tenantIds: string[], code: string, prefix: string, asOf?: Date): Promise<Map<string, { cents: number; firstAt: Date | null }>> {
  const out = new Map<string, { cents: number; firstAt: Date | null }>()
  if (tenantIds.length === 0) return out
  const entries = await db.journalEntry.findMany({
    where: { tenantId: { in: tenantIds }, reference: { startsWith: prefix }, ...(asOf ? { entryDate: { lte: asOf } } : {}) },
    select: { reference: true, entryDate: true, lines: { where: { account: { code } }, select: { type: true, amountCents: true } } },
  })
  for (const e of entries) {
    const ref = e.reference!
    const id = ref.slice(ref.indexOf(':') + 1).split('@')[0]!
    const cents = e.lines.reduce((s, l) => s + (l.type === 'debit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)
    if (!cents) continue
    const cur = out.get(id) ?? { cents: 0, firstAt: null }
    cur.cents += cents
    if (cents > 0 && (!cur.firstAt || e.entryDate < cur.firstAt)) cur.firstAt = e.entryDate
    out.set(id, cur)
  }
  return out
}

export const ADVANCE_FLAGS = ['delivered_uncapitalised', 'capitalisation_pending', 'overdue_delivery', 'orphan'] as const

/**
 * What sits on 1340 at `asOf`, by CapEx line: advanced (live capex.payment
 * debits) − applied (capitalisation credits), its age and flags. Advances of a
 * deleted payment / project are listed as 'orphan'. Per company, the ledger's
 * 1340 beside the sum.
 */
export async function advancesReport(db: Db, tenantIds: string[], asOf: Date) {
  const [paid, applied, lines, orphans, tenants] = await Promise.all([
    netBySourceId(db, tenantIds, ACCT.SUPPLIER_ADVANCES, 'capex.payment', asOf),
    netBySourceId(db, tenantIds, ACCT.SUPPLIER_ADVANCES, ACQUIRE_SOURCE, asOf),
    tenantIds.length === 0 ? [] : db.capexLine.findMany({
      where: { project: { tenantId: { in: tenantIds }, deletedAt: null } },
      select: {
        id: true, item: true, status: true, expectedDeliveryDate: true, actualDeliveryDate: true,
        project: { select: { id: true, name: true, tenantId: true } },
        payments: { select: { id: true } },
        fixedAssets: { where: { status: { not: 'voided' } }, select: { id: true } },
      },
    }),
    findOrphanAdvances(tenantIds, db),
    tenantIds.length === 0 ? [] : db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
  ])
  const companyName = new Map(tenants.map((t) => [t.id, t.name]))
  const lineAssets = tenantIds.length === 0 ? [] : await db.fixedAsset.findMany({
    where: { tenantId: { in: tenantIds }, capexLineId: { in: lines.map((l) => l.id) } },
    select: { id: true, capexLineId: true },
  })
  const assetsOfLine = groupBy(lineAssets, (a) => a.capexLineId)
  const pending = tenantIds.length === 0 ? [] : await db.fixedAssetEvent.findMany({
    where: { tenantId: { in: tenantIds }, kind: 'capitalise', status: 'pending', capexLineId: { in: lines.map((l) => l.id) } },
    select: { capexLineId: true },
  })
  const pendingLines = new Set(pending.map((p) => p.capexLineId))
  const policies = new Map<string, number>()
  for (const t of tenantIds) policies.set(t, (await getFixedAssetPolicy(t)).capexAdvanceOverdueDays)

  const rows: Array<Record<string, string | number | null>> = []
  const heldByCompany = new Map<string, number>()
  for (const l of lines) {
    const tenantId = l.project.tenantId!
    let advanced = 0
    let firstAt: Date | null = null
    for (const p of l.payments) {
      const v = paid.get(p.id)
      if (!v) continue
      advanced += v.cents
      if (v.firstAt && (!firstAt || v.firstAt < firstAt)) firstAt = v.firstAt
    }
    // Every asset the line was ever capitalised as (a voided one's credit is reversed — net 0).
    const appliedCents = (assetsOfLine.get(l.id) ?? []).reduce((s, a) => s - (applied.get(a.id)?.cents ?? 0), 0)
    const held = advanced - appliedCents
    if (advanced === 0 && held === 0) continue
    const delivered = DELIVERED.includes(l.status) || (!!l.actualDeliveryDate && l.actualDeliveryDate.getTime() <= asOf.getTime())
    const flags: string[] = []
    if (pendingLines.has(l.id)) flags.push('capitalisation_pending')
    else if (delivered && held > 0 && l.fixedAssets.length === 0) flags.push('delivered_uncapitalised')
    const overdueDays = policies.get(tenantId) ?? 45
    if (!delivered && held > 0 && l.expectedDeliveryDate && l.expectedDeliveryDate.getTime() + overdueDays * DAY_MS < asOf.getTime()) {
      flags.push('overdue_delivery')
    }
    heldByCompany.set(tenantId, (heldByCompany.get(tenantId) ?? 0) + held)
    rows.push({
      tenantId, companyName: companyName.get(tenantId) ?? '', lineId: l.id, paymentId: null, projectId: l.project.id, projectName: l.project.name, item: l.item,
      status: l.status,
      expectedDeliveryDate: l.expectedDeliveryDate ? pktDay(l.expectedDeliveryDate) : null,
      actualDeliveryDate: l.actualDeliveryDate ? pktDay(l.actualDeliveryDate) : null,
      deliveredDays: l.actualDeliveryDate ? Math.floor((asOf.getTime() - l.actualDeliveryDate.getTime()) / DAY_MS) : null,
      advancedCents: advanced, appliedCents, heldCents: held,
      firstPaidAt: firstAt ? pktDay(firstAt) : null,
      ageDays: firstAt ? Math.floor((asOf.getTime() - firstAt.getTime()) / DAY_MS) : null,
      flags: flags.join('; '),
    })
  }
  for (const o of orphans) {
    if (o.debitCode !== ACCT.SUPPLIER_ADVANCES) continue
    heldByCompany.set(o.tenantId, (heldByCompany.get(o.tenantId) ?? 0) + o.amountCents)
    rows.push({
      tenantId: o.tenantId, companyName: companyName.get(o.tenantId) ?? '', lineId: null, paymentId: o.paymentId, projectId: null,
      projectName: o.reason === 'project_deleted' ? 'Deleted project' : 'Deleted payment', item: null, status: null,
      expectedDeliveryDate: null, actualDeliveryDate: null, deliveredDays: null,
      advancedCents: o.amountCents, appliedCents: 0, heldCents: o.amountCents, firstPaidAt: null, ageDays: null, flags: 'orphan',
    })
  }
  const byCompany = []
  for (const t of tenantIds) {
    const gl = (await ledgerBalancesByCode(t, [ACCT.SUPPLIER_ADVANCES], { asOf, db })).get(ACCT.SUPPLIER_ADVANCES) ?? 0
    const held = heldByCompany.get(t) ?? 0
    byCompany.push({ tenantId: t, companyName: companyName.get(t) ?? '', heldCents: held, glCents: gl, diffCents: gl - held })
  }
  return { asOf: pktDay(asOf), rows, byCompany }
}

// ─── Tax (H23) — the ACTIVE company ─────────────────────────────────────────

/** Shown with smallwares in the tax view: their tax treatment (H35). */
export const SMALLWARES_TAX_NOTE =
  'Smallwares are deducted in full for tax in the year they are bought (accountant, H35); in the books they are pooled over 24 months.'

function totalsOf(rows: readonly TaxAssetRow[]): TaxTotals {
  const t: TaxTotals = { openingWdvCents: 0, additionsCents: 0, initialAllowanceCents: 0, depreciationCents: 0, disposalProceedsCents: 0, closingWdvCents: 0 }
  for (const r of rows) {
    t.openingWdvCents += r.openingWdvCents
    t.additionsCents += r.additionsCents
    t.initialAllowanceCents += r.initialAllowanceCents
    t.depreciationCents += r.depreciationCents
    t.disposalProceedsCents += r.disposalProceedsCents
    t.closingWdvCents += r.closingWdvCents
  }
  return t
}

/**
 * The company's tax depreciation for `taxYear` (tax.ts taxSchedule). Smallwares
 * are in it, deducted in full in the year bought (H35). `toConfirm` stays in
 * the shape, always empty, for older admin builds.
 */
export async function taxReport(db: Db, tenantId: string, taxYear: number) {
  const [s, classes, tenant] = await Promise.all([
    taxSchedule(tenantId, taxYear, db),
    getAssetClasses(tenantId, db),
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  ])
  const label = new Map(classes.map((c) => [c.key, c.label]))
  const kept = s.rows
  const hasSmallwares = classes.some((c) => c.pooled && kept.some((r) => r.classKey === c.key))
  const byClass = classes
    .filter((c) => kept.some((r) => r.classKey === c.key))
    .map((c) => ({ classKey: c.key, label: c.label, ...totalsOf(kept.filter((r) => r.classKey === c.key)) }))
  const rows = kept.map((r) => ({
    assetId: r.assetId, assetTag: r.assetTag, name: r.name, classKey: r.classKey, classLabel: label.get(r.classKey) ?? r.classKey,
    rateBp: r.rateBp, initialAllowanceBp: r.initialAllowanceBp, openingWdvCents: r.openingWdvCents, additionsCents: r.additionsCents,
    initialAllowanceCents: r.initialAllowanceCents, depreciationCents: r.depreciationCents, disposalProceedsCents: r.disposalProceedsCents,
    closingWdvCents: r.closingWdvCents, frozen: r.frozen ? 'yes' : 'no',
  }))
  const toConfirm: Array<{ assetId: string; assetTag: string | null; name: string; classKey: string; classLabel: string; costCents: number }> = []
  return {
    tenantId, companyName: tenant?.name ?? '', taxYear, start: pktDay(s.start), end: pktDay(s.end), frozen: s.frozen,
    rows, byClass, totals: totalsOf(kept), toConfirm, toConfirmNote: null, smallwaresNote: hasSmallwares ? SMALLWARES_TAX_NOTE : null,
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/** Every fixed-asset report exports through lib/reportExport.ts (csv unchanged; xlsx / pdf leave the ids out). */
function sendFa(req: FastifyRequest, reply: FastifyReply, format: ExportFormat, name: string, title: string, period: string, rows: Array<Record<string, string | number | null>>, columns: string[]) {
  return sendReportFor(req, reply, format, name, {
    title, period, rows, columns: columns.map((key) => ({ key })), csvEmpty: 'header',
    hide: columns.filter((k) => k === 'tenantId' || /Id$/.test(k) || k === 'key'),
  })
}
const EXPORT = z.enum(['json', 'csv', 'xlsx', 'pdf']).optional()

const columnsOf = (rows: Array<Record<string, unknown>>, fallback: string[]) => (rows[0] ? Object.keys(rows[0]) : fallback)

const asOfQuery = z.object({ asOf: z.string().optional(), format: EXPORT })

export async function fixedAssetReportRoutes(fastify: FastifyInstance) {
  fastify.get('/schedule', { preHandler: requireAuth(...READERS) }, async (req, reply) => {
    const q = z.object({
      from: z.string().optional(), to: z.string().optional(),
      groupBy: z.enum(SCHEDULE_GROUPS).default('class'), format: EXPORT,
    }).parse(req.query)
    const cur = currentPeriodPkt()
    const from = q.from ?? periodFromIndex(periodIndex(cur) - 11)
    const to = q.to ?? periodFromIndex(periodIndex(cur) + 12)
    const { tenantIds } = await resolveTenantScope(req)
    const r = await scheduleReport(prisma, tenantIds, from, to, q.groupBy)
    const f = exportFormatOf(q.format)
    if (f) return sendFa(req, reply, f, `depreciation-schedule-${from}-${to}`, 'Depreciation schedule', `${from} to ${to}`, r.rows, columnsOf(r.rows, ['tenantId', 'companyName', 'key', 'label', 'period', 'postedCents', 'forecastCents']))
    return r
  })

  fastify.get('/roll-forward', { preHandler: requireAuth(...READERS) }, async (req, reply) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional(), format: EXPORT }).parse(req.query)
    const now = new Date()
    const from = q.from ? startOfPktDay(q.from) : taxYearOf(now).start
    const to = q.to ? endOfPktDay(q.to) : endOfPktDay(pktDay(now))
    if (to.getTime() < from.getTime()) throw new AppError('BAD_DATE', '"to" must not be before "from"', 400)
    const { tenantIds } = await resolveTenantScope(req)
    const r = await rollForward(prisma, tenantIds, from, to)
    const f = exportFormatOf(q.format)
    if (f) return sendFa(req, reply, f, `fixed-asset-roll-forward-${r.from}-${r.to}`, 'Fixed asset roll-forward', `${r.from} to ${r.to}`, r.rows, columnsOf(r.rows, ['tenantId', 'companyName', 'classKey', 'label']))
    return r
  })

  fastify.get('/nbv', { preHandler: requireAuth(...READERS) }, async (req, reply) => {
    const q = asOfQuery.extend({ groupBy: z.enum(NBV_GROUPS).default('class') }).parse(req.query)
    const asOf = q.asOf ? endOfPktDay(q.asOf) : new Date()
    const { tenantIds } = await resolveTenantScope(req)
    const r = await nbvReport(prisma, tenantIds, asOf, q.groupBy)
    const f = exportFormatOf(q.format)
    if (f) return sendFa(req, reply, f, `fixed-asset-nbv-${r.asOf}-${q.groupBy}`, 'Fixed assets — net book value', `As at ${r.asOf}`, r.rows, columnsOf(r.rows, ['tenantId', 'companyName', 'key', 'label', 'assets', 'costCents', 'accumulatedCents', 'nbvCents']))
    return r
  })

  fastify.get('/tie-out', { preHandler: requireAuth(...READERS) }, async (req, reply) => {
    const q = asOfQuery.parse(req.query)
    const asOf = q.asOf ? endOfPktDay(q.asOf) : undefined
    const { tenantIds } = await resolveTenantScope(req)
    const r = await tieOutReport(prisma, tenantIds, asOf)
    const f = exportFormatOf(q.format)
    if (f) return sendFa(req, reply, f, `fixed-asset-tie-out-${r.asOf ?? 'now'}`, 'Fixed asset register vs ledger', `As at ${r.asOf ?? 'now'}`, r.rows, columnsOf(r.rows, ['tenantId', 'companyName', 'check', 'code', 'registerCents', 'glCents', 'diffCents']))
    return r
  })

  fastify.get('/advances', { preHandler: requireAuth(...READERS) }, async (req, reply) => {
    const q = asOfQuery.parse(req.query)
    const asOf = q.asOf ? endOfPktDay(q.asOf) : new Date()
    const { tenantIds } = await resolveTenantScope(req)
    const r = await advancesReport(prisma, tenantIds, asOf)
    const f = exportFormatOf(q.format)
    if (f) return sendFa(req, reply, f, `supplier-advances-${r.asOf}`, 'Supplier advances (CapEx)', `As at ${r.asOf}`, r.rows, columnsOf(r.rows, ['tenantId', 'companyName', 'lineId', 'heldCents', 'flags']))
    return r
  })

  // Tax is filed per company: the ACTIVE company only (never the portfolio).
  fastify.get('/tax', { preHandler: requireAuth(...READERS) }, async (req, reply) => {
    const q = z.object({ taxYear: z.coerce.number().int().optional(), format: EXPORT }).parse(req.query)
    const tenantId = activeTenantId(req, 'tax depreciation is per company')
    const taxYear = q.taxYear ?? taxYearOf(new Date()).taxYear
    const r = await taxReport(prisma, tenantId, taxYear)
    const f = exportFormatOf(q.format)
    if (f) return sendFa(req, reply, f, `tax-depreciation-${taxYear}`, `Tax depreciation ${taxYear}`, `${r.companyName} · ${r.start} to ${r.end}`, r.rows, columnsOf(r.rows, ['assetId', 'assetTag', 'name', 'classKey', 'closingWdvCents']))
    return r
  })

  // The CEO freezes a finished tax year of the ACTIVE company (tax.ts freezeTaxYear).
  fastify.post<{ Params: { taxYear: string } }>('/tax/:taxYear/freeze', { preHandler: requireAuth(...APPROVER) }, async (req, reply) => {
    const taxYear = Number(req.params.taxYear)
    if (!Number.isInteger(taxYear)) throw new AppError('BAD_TAX_YEAR', 'Tax year must be a year like 2027', 400)
    const tenantId = activeTenantId(req, 'tax depreciation is per company')
    const r = await freezeTaxYear(tenantId, taxYear, req.staffUser!.id)
    await audit({
      category: 'accounting', action: 'fixed_asset.tax_year_freeze', entity: 'FixedAssetTaxYear', entityId: `${tenantId}:${taxYear}`,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: r,
    })
    return reply.status(201).send({ tenantId, ...r })
  })
}
