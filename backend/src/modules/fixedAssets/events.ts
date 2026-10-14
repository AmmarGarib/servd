// Fixed-asset events — the register's own request queue and history (v2).
//
// Every change after capitalisation is a FixedAssetEvent. Owner (2026-10-13):
// disposals, scraps and write-downs — finance requests, the CEO (role
// 'admin') approves; the F&B manager does NOT. So:
//
//   kind              who raises                approval        posting (company = the asset's / pool's)
//   capitalise        finance (CapEx)           CEO             fixed_asset.acquire:<assetId> per asset
//   disposal          finance                   CEO             fixed_asset.dispose:<assetId>
//   undispose         finance                   CEO             reversal of the disposal, then catch-up charges
//   impairment        finance                   CEO             fixed_asset.impairment:<eventId>  Dr 6155 / Cr accum
//   change_estimate   finance                   CEO             none (prospective life / salvage)
//   void              finance                   CEO             reversals of acquire + depreciation + impairments
//   pool_write_off    finance                   CEO             fixed_asset.pool_write_off:<eventId> (FIFO layers)
//   transfer          finance                   none (at once)  fixed_asset.transfer:<eventId> when the brand changes
//   pool_transfer     finance                   none (at once)  fixed_asset.transfer:<eventId> when the brand changes
//   count             finance / F&B manager     none (at once)  none (counted vs on hand)
//
// The CEO's own request is applied at once. An approval runs in ONE
// transaction (the months before it are charged first, through the same
// chargeAssetTx the monthly run uses); a failure rolls it all back and keeps
// the reason on the event (errorMessage) — the event stays pending.
// Approvals / late postings follow owner decision 6 (journal.ts
// lateDatingFor): a closed month is never reopened, the entry lands in the
// open month with a note naming the original date.
//
// The approvals inbox reads this queue (provider 'fixed_asset_request') and
// its buttons call the module's approve / reject routes, which call
// applyEvent / rejectEvent — never a second approval engine.

import { z } from 'zod'
import type { FixedAsset, FixedAssetEvent, FixedAssetPool, Prisma } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { toCents, zMoneyCents, assertMoneyFits } from '../../lib/money.js'
import {
  moneyAccountCode, RECEIPT_METHODS, zReceiptMethod, zPaymentRef, assertPaymentReference, receiptText,
} from '../../lib/bankAccounts.js'
import {
  ACCT, postJournalEntry, reverseJournalEntry, lateDatingFor, withLateNote, type JournalLineInput,
} from '../accounting/journal.js'
import { syncSourcePosting } from '../accounting/sourcePosting.js'
import { inputTaxCodeFor, isAuthorityKey, INPUT_TAX_ACCOUNTS } from '../accounting/taxAuthorities.js'
import { classOf, type Db } from './classes.js'
import {
  addMonths, lastCompletedPeriodPkt, periodIndex, periodOfPkt,
} from './schedule.js'
import {
  chargeAssetTx, reverseChargesFrom, loadAssetState, accumulatedByCode, lockAsset, nextAssetTag, postAcquisition,
  payloadOf, ACQUIRE_SOURCE, DISPOSE_SOURCE, IMPAIRMENT_SOURCE, TRANSFER_SOURCE, POOL_WRITE_OFF_SOURCE,
} from './service.js'
import { findOrCreatePool, poolLayersFifo, poolUnitsOnHand, allocateFifo, sliceCents } from './pools.js'

type Tx = Prisma.TransactionClient

// Interactive transactions here can post many months; Prisma's 5 s default is too short.
const TX_OPTS = { timeout: 120_000, maxWait: 30_000 } as const

// ─── Who ────────────────────────────────────────────────────────────────────

/** Raise requests, prepare capitalisations, transfer (the routes' FA_WRITERS should import this). */
export const FA_WRITER_ROLES: readonly string[] = ['admin', 'owner', 'management', 'finance']
/** Smallwares counts carry no money: the F&B manager may record them too. */
export const FA_COUNT_ROLES: readonly string[] = [...FA_WRITER_ROLES, 'fnb_manager']
/** The CEO — the only approver (owner, 2026-10-13). */
export const FA_APPROVER_ROLE = 'admin'

// ─── What ───────────────────────────────────────────────────────────────────

export const REQUEST_KINDS = [
  'capitalise', 'disposal', 'pool_write_off', 'impairment', 'change_estimate', 'transfer', 'pool_transfer', 'void', 'undispose', 'count',
] as const
export type RequestKind = typeof REQUEST_KINDS[number]
/** Per-layer rows the engine writes under a pool write-off / transfer (never requested). */
export const ALLOC_KINDS = ['pool_write_off_alloc', 'pool_transfer_alloc'] as const

const APPROVAL_KINDS = new Set<string>(['capitalise', 'disposal', 'pool_write_off', 'impairment', 'change_estimate', 'void', 'undispose'])
const ASSET_KINDS = new Set<string>(['disposal', 'impairment', 'change_estimate', 'transfer', 'void', 'undispose'])
const POOL_KINDS = new Set<string>(['pool_write_off', 'pool_transfer', 'count'])
/** Kinds that take effect today whatever date is sent. */
const TODAY_KINDS = new Set<string>(['transfer', 'pool_transfer', 'void', 'undispose', 'count'])

/** True when the kind waits for the CEO (unless the CEO raised it). */
export function needsApproval(kind: string): boolean {
  return APPROVAL_KINDS.has(kind)
}

export const DISPOSAL_KINDS = ['sale', 'scrap', 'lost', 'stolen'] as const
/**
 * How the buyer paid for an asset sale: THE receipt list (lib/bankAccounts.ts
 * RECEIPT_METHODS) plus the old spellings 'bank' / 'online' that a request
 * raised before 2026-10-14 may still carry — a pending payload is parsed
 * again when the CEO approves it, so they must stay readable.
 */
export const DISPOSAL_METHODS = [...RECEIPT_METHODS, 'bank', 'online'] as const
export const WRITE_OFF_CAUSES = ['breakage', 'loss', 'theft', 'worn_out'] as const

const idSchema = z.string().min(1).max(64)
const dateInput = z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])

export const PAYLOAD_SCHEMAS = {
  disposal: z.object({
    kind: z.enum(DISPOSAL_KINDS),
    proceedsCents: zMoneyCents('The disposal proceeds').default(0),
    // Where the proceeds went (lib/bankAccounts.ts moneyAccountCode): cash → 1010, card → 1030,
    // bank-type → the named bank. Omitted = the old default 'bank'.
    method: zReceiptMethod(DISPOSAL_METHODS).optional(),
    // The payment reference # of the proceeds (owner, 2026-10-14: required for every method,
    // cash included). Checked when the request is RAISED, never at approve — a request raised
    // before the rule carries none. lib/paymentRefs.ts reads it (payload.reference).
    reference: zPaymentRef.nullable().optional(),
    bankAccountId: idSchema.nullable().optional(),
  }),
  impairment: z.object({ amountCents: zMoneyCents('The write-down', { sign: 'positive' }) }),
  change_estimate: z.object({
    remainingLifeMonths: z.number().int().min(1).max(600).optional(),
    salvageCents: zMoneyCents('The salvage value').optional(),
  }).refine((p) => p.remainingLifeMonths !== undefined || p.salvageCents !== undefined, { message: 'Give a new remaining life or a new salvage value' }),
  transfer: z.object({
    toLocationId: idSchema.nullable().optional(),
    toConceptId: idSchema.nullable().optional(),
  }),
  void: z.object({}),
  undispose: z.object({}),
  pool_write_off: z.object({
    units: z.number().int().min(1).max(1_000_000),
    cause: z.enum(WRITE_OFF_CAUSES).default('breakage'),
  }),
  pool_transfer: z.object({
    units: z.number().int().min(1).max(1_000_000),
    toLocationId: idSchema,
    // Omitted = the source pool's brand; null = shared across brands.
    toConceptId: idSchema.nullable().optional(),
  }),
  count: z.object({
    countedUnits: z.number().int().min(0).max(1_000_000),
    countedAt: dateInput.optional(),
    note: z.string().max(500).optional(),
  }),
  capitalise: z.object({
    classKey: z.string().min(1).max(40),
    inServiceAt: dateInput.optional(),
    usefulLifeMonths: z.number().int().min(1).max(600).optional(),
    salvageCents: zMoneyCents('The salvage value').optional(),
    name: z.string().min(1).max(120).optional(),
    // Where the asset physically is (omitted = the project's outlet). Shared equipment must
    // have one (owner, 2026-10-14: 422 LOCATION_REQUIRED_FOR_SHARED when raised).
    locationId: idSchema.nullable().optional(),
    // Individual (non-pooled) assets: the brand (omitted = the project's brand; null = shared
    // across brands). A pooled class takes its brand from `pool.conceptId` instead.
    conceptId: idSchema.nullable().optional(),
    // Pooled classes (smallwares): the pool's type and brand (omitted = the project's brand; null = shared).
    pool: z.object({ typeKey: z.string().min(1).max(40), conceptId: idSchema.nullable().optional() }).optional(),
    // Gross cost (incl. claimable input tax); omitted = negotiated, else unit cost × quantity.
    costCents: zMoneyCents('The asset\'s cost', { sign: 'positive' }).optional(),
    inputTaxCents: zMoneyCents('The input tax').optional(),
    leaseEndsAt: dateInput.optional(),
  }),
} as const

export type CapitalisePayload = z.infer<typeof PAYLOAD_SCHEMAS.capitalise>

export interface CreateEventInput {
  kind: RequestKind
  assetId?: string | null
  poolId?: string | null
  capexLineId?: string | null
  /** The company the caller resolved (route scope). A subject of another company → 404. */
  tenantId?: string
  /** Defaults to now. Transfers, voids, un-disposals and counts always take effect now. */
  effectiveDate?: Date
  reason: string
  payload?: Record<string, unknown>
}

const REASON_MIN = 10

function json(o: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(o)) as Prisma.InputJsonObject
}

/**
 * An event's payload, validated for its kind (400 ZodError on a bad one).
 * A history row the v2 migration wrote for a pre-v2 disposal carries
 * {"legacy": true} and is returned as stored — it is never applied.
 */
export function parseEventPayload(kind: string, raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { legacy?: unknown }).legacy === true) {
    return raw as Record<string, unknown>
  }
  return parsePayload(kind, raw)
}

// Strict: what a request carries and what an approval applies (never the legacy shape).
function parsePayload(kind: string, raw: unknown): Record<string, unknown> {
  const schema = (PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny>)[kind]
  if (!schema) throw new AppError('BAD_EVENT_KIND', `Unknown fixed-asset request kind "${kind}"`, 422)
  return schema.parse(raw ?? {}) as Record<string, unknown>
}

function parseDate(s: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00+05:00`) : new Date(s)
}

/** The last completed month, never later than the month before `effective`. */
function chargeThroughBefore(effective: Date): string {
  const before = addMonths(periodOfPkt(effective), -1)
  const last = lastCompletedPeriodPkt()
  return periodIndex(before) < periodIndex(last) ? before : last
}

function pktDay(d: Date): string {
  return new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 10)
}

async function lateDate(tx: Db, tenantId: string, natural: Date): Promise<{ entryDate: Date; memoNote?: string }> {
  const d = await lateDatingFor(tx, tenantId, natural)
  if ('lockedThroughToday' in d) {
    throw new AppError('BOOKS_CLOSED_TODAY', 'The books are closed through today — nothing can post until a month is open', 409)
  }
  return d
}

// ─── Subject resolution and request-time checks ─────────────────────────────

interface Subject {
  tenantId: string
  asset: FixedAsset | null
  pool: FixedAssetPool | null
  /** capitalise: the CapEx project's brand and outlet (the payload's defaults). */
  project?: { conceptId: string | null; locationId: string | null }
}

async function resolveSubject(db: Db, input: CreateEventInput): Promise<Subject> {
  if (ASSET_KINDS.has(input.kind)) {
    if (!input.assetId) throw new AppError('ASSET_REQUIRED', 'Name the asset', 422)
    const asset = await db.fixedAsset.findUnique({ where: { id: input.assetId } })
    if (!asset || (input.tenantId && asset.tenantId !== input.tenantId)) throw new NotFoundError('FixedAsset', input.assetId)
    return { tenantId: asset.tenantId, asset, pool: null }
  }
  if (POOL_KINDS.has(input.kind)) {
    if (!input.poolId) throw new AppError('POOL_REQUIRED', 'Name the smallwares pool', 422)
    const pool = await db.fixedAssetPool.findUnique({ where: { id: input.poolId } })
    if (!pool || (input.tenantId && pool.tenantId !== input.tenantId)) throw new NotFoundError('FixedAssetPool', input.poolId)
    return { tenantId: pool.tenantId, asset: null, pool }
  }
  // capitalise
  if (!input.capexLineId) throw new AppError('CAPEX_LINE_REQUIRED', 'Name the CapEx line', 422)
  const line = await db.capexLine.findUnique({
    where: { id: input.capexLineId },
    include: { project: { select: { tenantId: true, deletedAt: true, conceptId: true, locationId: true } } },
  })
  if (!line || line.project.deletedAt) throw new NotFoundError('CapexLine', input.capexLineId)
  const tenantId = line.project.tenantId
  if (!tenantId) throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company — assets belong to one company', 422)
  if (input.tenantId && tenantId !== input.tenantId) throw new NotFoundError('CapexLine', input.capexLineId)
  return { tenantId, asset: null, pool: null, project: { conceptId: line.project.conceptId, locationId: line.project.locationId } }
}

/**
 * Owner (2026-10-14): equipment shared across brands always says where it
 * physically is. An asset with NO brand and NO outlet is refused when the
 * request is raised (capitalise, transfer) — 422 LOCATION_REQUIRED_FOR_SHARED.
 * A request already pending approves as before.
 */
export function assertSharedHasLocation(conceptId: string | null | undefined, locationId: string | null | undefined): void {
  if (!conceptId && !locationId) {
    throw new AppError('LOCATION_REQUIRED_FOR_SHARED', 'Shared equipment needs its location — name the outlet it is at', 422)
  }
}

/**
 * The brand and outlet a capitalisation gives its asset(s): the payload's,
 * else the CapEx project's. Individual assets take `conceptId`, a pooled
 * class `pool.conceptId` (the same rule applyCapitalise uses).
 */
export function capitaliseTarget(
  p: Pick<CapitalisePayload, 'locationId' | 'conceptId' | 'pool'>,
  pooled: boolean,
  project: { conceptId: string | null; locationId: string | null },
): { conceptId: string | null; locationId: string | null } {
  const locationId = p.locationId !== undefined ? p.locationId : project.locationId
  const conceptId = pooled
    ? (p.pool && p.pool.conceptId !== undefined ? p.pool.conceptId : project.conceptId)
    : (p.conceptId !== undefined ? p.conceptId : project.conceptId)
  return { conceptId: conceptId ?? null, locationId: locationId ?? null }
}

function assertDisposalDate(asset: FixedAsset, effective: Date): void {
  const inService = asset.inServiceAt ?? asset.acquiredAt
  if (pktDay(effective) < pktDay(inService) || effective.getTime() > Date.now()) {
    throw new AppError(
      'DISPOSAL_DATE',
      `The disposal date must be on or after the day it went into service (${pktDay(inService)}) and not in the future`,
      422,
    )
  }
}

function assertEffectiveDate(effective: Date, inService: Date | null): void {
  if (effective.getTime() > Date.now() || (inService && pktDay(effective) < pktDay(inService))) {
    throw new AppError('EFFECTIVE_DATE', 'The date must not be in the future, nor before the asset went into service', 422)
  }
}

/** Posted history that a void must not erase (net of disposals already undone). */
async function blockingHistory(db: Db, assetId: string): Promise<string | null> {
  const ev = await db.fixedAssetEvent.findMany({
    where: { assetId, status: 'posted', kind: { in: ['disposal', 'undispose', 'pool_write_off_alloc', 'pool_transfer_alloc', 'transfer'] } },
    select: { kind: true },
  })
  const disposals = ev.filter((e) => e.kind === 'disposal').length - ev.filter((e) => e.kind === 'undispose').length
  if (disposals > 0) return 'a disposal'
  if (ev.some((e) => e.kind === 'pool_write_off_alloc')) return 'a pool write-off'
  if (ev.some((e) => e.kind === 'pool_transfer_alloc')) return 'a pool unit transfer'
  if (ev.some((e) => e.kind === 'transfer')) return 'a transfer'
  return null
}

async function assertLocationOf(db: Db, tenantId: string, locationId: string): Promise<void> {
  const l = await db.location.findUnique({ where: { id: locationId }, select: { tenantId: true } })
  if (!l || l.tenantId !== tenantId) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That outlet is not one of this company\'s locations', 422)
}

async function assertConceptOf(db: Db, tenantId: string, conceptId: string): Promise<void> {
  const c = await db.concept.findUnique({ where: { id: conceptId }, select: { tenantId: true } })
  if (!c || c.tenantId !== tenantId) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand is not one of this company\'s brands', 422)
}

/** Cheap checks at request time (all re-checked when applied). */
async function validateRequest(db: Db, kind: string, s: Subject, payload: Record<string, unknown>, effective: Date): Promise<void> {
  const asset = s.asset
  if (asset) {
    if (asset.status === 'voided') throw new AppError('ASSET_VOIDED', 'This asset was voided', 409)
    if (kind === 'undispose') {
      if (asset.status !== 'disposed') throw new AppError('NOT_DISPOSED', 'This asset is not disposed', 409)
    } else if (kind === 'void') {
      const blocking = await blockingHistory(db, asset.id)
      if (blocking || asset.status !== 'active') {
        throw new AppError('ASSET_HAS_EVENTS', `This asset has ${blocking ?? 'a disposal'} on the books — it cannot be voided`, 409)
      }
    } else if (asset.status !== 'active') {
      throw new AppError('ALREADY_DISPOSED', 'This asset has already been disposed of', 409)
    }
    if ((kind === 'disposal' || kind === 'transfer') && asset.kind === 'pool_layer') {
      throw new AppError(kind === 'disposal' ? 'USE_POOL_WRITE_OFF' : 'USE_POOL_TRANSFER',
        'A smallwares layer leaves through its pool — write units off or transfer units from the pool', 422)
    }
  }
  if (kind === 'disposal') {
    assertDisposalDate(asset!, effective)
    const p = payload as { kind: string; proceedsCents: number; method?: string; reference?: string | null; bankAccountId?: string | null }
    if ((p.kind === 'lost' || p.kind === 'stolen') && p.proceedsCents > 0) {
      throw new AppError('PROCEEDS_NOT_ALLOWED', 'A lost or stolen asset brings in no proceeds', 422)
    }
    if (p.proceedsCents > 0) {
      await moneyAccountCode(db, s.tenantId, { method: p.method ?? 'bank', bankAccountId: p.bankAccountId ?? null })
      // Raise time only: a request raised before 2026-10-14 has no reference and still approves.
      assertPaymentReference(p.method ?? 'bank', p.reference)
    }
  }
  if (kind === 'impairment' || kind === 'change_estimate') {
    assertEffectiveDate(effective, asset!.inServiceAt ?? asset!.acquiredAt)
    const cls = await classOf(s.tenantId, asset!.category, db)
    if (!cls.depreciable || !cls.accumAccountCode || asset!.method === 'none') {
      throw new AppError('NOT_DEPRECIABLE', `${cls.label} is not depreciated — it cannot be written down or re-estimated here`, 422)
    }
  }
  if (kind === 'impairment') {
    const state = await loadAssetState(db, asset!.id)
    let accum = 0
    for (const v of accumulatedByCode(state).values()) accum += v
    const room = toCents(asset!.costCents) - accum - toCents(asset!.salvageCents)
    const amount = (payload as { amountCents: number }).amountCents
    if (amount > room) {
      throw new AppError('IMPAIRMENT_TOO_LARGE', `The write-down can be at most the book value above salvage (PKR ${(Math.max(0, room) / 100).toFixed(2)})`, 422)
    }
  }
  if (kind === 'change_estimate') {
    const salvage = (payload as { salvageCents?: number }).salvageCents
    if (salvage !== undefined && salvage >= toCents(asset!.costCents)) {
      throw new AppError('SALVAGE_TOO_HIGH', 'Salvage value must be less than cost', 422)
    }
  }
  if (kind === 'transfer') {
    const p = payload as { toLocationId?: string | null; toConceptId?: string | null }
    if (p.toLocationId) await assertLocationOf(db, s.tenantId, p.toLocationId)
    if (p.toConceptId) await assertConceptOf(db, s.tenantId, p.toConceptId)
    const changes = (p.toLocationId !== undefined && p.toLocationId !== asset!.locationId)
      || (p.toConceptId !== undefined && p.toConceptId !== asset!.conceptId)
    if (!changes) throw new AppError('NOTHING_TO_TRANSFER', 'Name a different outlet or brand', 422)
    // Moving to "shared across brands" (or off its outlet) must leave it somewhere.
    assertSharedHasLocation(
      p.toConceptId !== undefined ? p.toConceptId : asset!.conceptId,
      p.toLocationId !== undefined ? p.toLocationId : asset!.locationId,
    )
  }
  if (kind === 'capitalise' && s.project) {
    const p = payload as CapitalisePayload
    if (p.conceptId) await assertConceptOf(db, s.tenantId, p.conceptId)
    if (p.locationId) await assertLocationOf(db, s.tenantId, p.locationId)
    const cls = await classOf(s.tenantId, p.classKey, db)
    const target = capitaliseTarget(p, cls.pooled, s.project)
    if (cls.pooled) {
      if (!target.locationId) throw new AppError('POOL_NEEDS_LOCATION', 'Smallwares are pooled per outlet — name the outlet', 422)
    } else {
      assertSharedHasLocation(target.conceptId, target.locationId)
    }
  }
  if (kind === 'pool_write_off' || kind === 'pool_transfer') {
    const units = (payload as { units: number }).units
    const onHand = await poolUnitsOnHand(db, s.pool!.id)
    if (units > onHand) {
      throw new AppError('UNITS_EXCEED_POOL', `The pool holds ${onHand} unit${onHand === 1 ? '' : 's'} — cannot take out ${units}`, 422, { onHand, units })
    }
    if (kind === 'pool_write_off') assertEffectiveDate(effective, null)
  }
  if (kind === 'pool_transfer') {
    const p = payload as { toLocationId: string; toConceptId?: string | null }
    await assertLocationOf(db, s.tenantId, p.toLocationId)
    if (p.toConceptId) await assertConceptOf(db, s.tenantId, p.toConceptId)
  }
}

function headlineCents(kind: string, payload: Record<string, unknown>): number | null {
  if (kind === 'disposal') return (payload['proceedsCents'] as number | undefined) ?? 0
  if (kind === 'impairment') return (payload['amountCents'] as number | undefined) ?? null
  if (kind === 'capitalise') return (payload['costCents'] as number | undefined) ?? null
  return null
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002'
}

// ─── Create / approve / reject / cancel ─────────────────────────────────────

/**
 * Raise a request. Approval kinds wait for the CEO (status 'pending') unless
 * the CEO raised them; transfers and counts apply at once. An immediate apply
 * is ONE transaction with the event row — a refusal saves nothing.
 *   403 FA_WRITE_FORBIDDEN — the role may not raise this kind
 *   404 — the asset / pool / CapEx line is not in `input.tenantId`
 *   409 REQUEST_PENDING — the asset already has a pending request of this kind
 */
export async function createRequest(
  input: CreateEventInput,
  actor: { id: string; role: string },
): Promise<{ event: FixedAssetEvent; applied: boolean }> {
  if (!(REQUEST_KINDS as readonly string[]).includes(input.kind)) {
    throw new AppError('BAD_EVENT_KIND', `Unknown fixed-asset request kind "${input.kind}"`, 422)
  }
  const allowed = input.kind === 'count' ? FA_COUNT_ROLES : FA_WRITER_ROLES
  if (!allowed.includes(actor.role)) {
    throw new AppError('FA_WRITE_FORBIDDEN', input.kind === 'count'
      ? 'Only finance, management, the owners or the F&B manager can record a smallwares count'
      : 'Only finance, management or the owners can raise fixed-asset requests', 403)
  }
  const reason = (input.reason ?? '').trim() || (input.kind === 'count' ? 'Smallwares count' : '')
  if (input.kind !== 'count' && reason.length < REASON_MIN) {
    throw new AppError('REASON_REQUIRED', `Give a reason (at least ${REASON_MIN} characters)`, 422)
  }
  const payload = parsePayload(input.kind, input.payload)
  const subject = await resolveSubject(serviceClient, input)
  let effective = TODAY_KINDS.has(input.kind) ? new Date() : (input.effectiveDate ?? new Date())
  if (input.kind === 'count' && typeof payload['countedAt'] === 'string') effective = parseDate(payload['countedAt'])
  if (input.kind === 'capitalise' && typeof payload['inServiceAt'] === 'string') effective = parseDate(payload['inServiceAt'])
  if (Number.isNaN(effective.getTime())) throw new AppError('EFFECTIVE_DATE', 'That date is not valid', 422)
  await validateRequest(serviceClient, input.kind, subject, payload, effective)

  const data: Prisma.FixedAssetEventUncheckedCreateInput = {
    tenantId: subject.tenantId,
    assetId: subject.asset?.id ?? null,
    poolId: subject.pool?.id ?? null,
    capexLineId: input.kind === 'capitalise' ? input.capexLineId! : (subject.asset?.capexLineId ?? null),
    kind: input.kind,
    status: 'pending',
    effectiveDate: effective,
    payload: json(payload),
    amountCents: headlineCents(input.kind, payload),
    reason: reason.slice(0, 1000),
    requestedById: actor.id,
  }
  const applyNow = !needsApproval(input.kind) || actor.role === FA_APPROVER_ROLE
  try {
    if (!applyNow) {
      const event = await serviceClient.fixedAssetEvent.create({ data })
      return { event, applied: false }
    }
    const event = await serviceClient.$transaction(async (tx) => {
      const created = await tx.fixedAssetEvent.create({ data })
      return applyInTx(tx, created, actor.id)
    }, TX_OPTS)
    return { event, applied: true }
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('REQUEST_PENDING', input.kind === 'capitalise'
        ? 'This CapEx line already has a capitalisation waiting for the CEO'
        : 'This asset already has a request of this kind waiting for the CEO', 409)
    }
    throw err
  }
}

/**
 * The CEO approves a pending request: it is applied in one transaction. A
 * refusal rolls everything back, keeps the reason on the event
 * (errorMessage) and rethrows; the event stays pending.
 *   403 APPROVER_ONLY · 404 · 409 NOT_PENDING · module errors pass through
 */
export async function applyEvent(eventId: string, approverId: string): Promise<FixedAssetEvent> {
  const event = await serviceClient.fixedAssetEvent.findUnique({ where: { id: eventId } })
  if (!event) throw new NotFoundError('FixedAssetEvent', eventId)
  if (event.status !== 'pending') throw new AppError('NOT_PENDING', `This request is already ${event.status}`, 409)
  const approver = await serviceClient.user.findUnique({ where: { id: approverId }, select: { role: true } })
  const role = approver?.role ?? ''
  if (needsApproval(event.kind) ? role !== FA_APPROVER_ROLE : !FA_WRITER_ROLES.includes(role)) {
    throw new AppError('APPROVER_ONLY', 'Only the CEO approves fixed-asset requests', 403)
  }
  try {
    return await serviceClient.$transaction((tx) => applyInTx(tx, event, approverId), TX_OPTS)
  } catch (err) {
    const message = (err as Error).message ?? String(err)
    await serviceClient.fixedAssetEvent.updateMany({
      where: { id: eventId, status: 'pending' },
      data: { errorMessage: message.slice(0, 1000) },
    }).catch(() => {})
    throw err
  }
}

/** The CEO rejects a pending request with a note. 403 APPROVER_ONLY · 409 NOT_PENDING · 422 NOTE_REQUIRED. */
export async function rejectEvent(eventId: string, approverId: string, note: string): Promise<FixedAssetEvent> {
  const event = await serviceClient.fixedAssetEvent.findUnique({ where: { id: eventId } })
  if (!event) throw new NotFoundError('FixedAssetEvent', eventId)
  const approver = await serviceClient.user.findUnique({ where: { id: approverId }, select: { role: true } })
  if (approver?.role !== FA_APPROVER_ROLE) throw new AppError('APPROVER_ONLY', 'Only the CEO rejects fixed-asset requests', 403)
  const text = (note ?? '').trim()
  if (!text) throw new AppError('NOTE_REQUIRED', 'Say why the request is rejected', 422)
  const r = await serviceClient.fixedAssetEvent.updateMany({
    where: { id: eventId, status: 'pending' },
    data: { status: 'rejected', decidedById: approverId, decidedAt: new Date(), decisionNote: text.slice(0, 1000) },
  })
  if (r.count === 0) throw new AppError('NOT_PENDING', 'This request is no longer pending', 409)
  return serviceClient.fixedAssetEvent.findUniqueOrThrow({ where: { id: eventId } })
}

/** The requester (or the CEO) withdraws a pending request. 403 · 409 NOT_PENDING. */
export async function cancelEvent(eventId: string, actorId: string): Promise<FixedAssetEvent> {
  const event = await serviceClient.fixedAssetEvent.findUnique({ where: { id: eventId } })
  if (!event) throw new NotFoundError('FixedAssetEvent', eventId)
  if (event.requestedById !== actorId) {
    const actor = await serviceClient.user.findUnique({ where: { id: actorId }, select: { role: true } })
    if (actor?.role !== FA_APPROVER_ROLE) throw new ForbiddenError('Only the person who raised the request, or the CEO, can cancel it')
  }
  const r = await serviceClient.fixedAssetEvent.updateMany({
    where: { id: eventId, status: 'pending' },
    data: { status: 'cancelled', decidedById: actorId, decidedAt: new Date() },
  })
  if (r.count === 0) throw new AppError('NOT_PENDING', 'This request is no longer pending', 409)
  return serviceClient.fixedAssetEvent.findUniqueOrThrow({ where: { id: eventId } })
}

// ─── Apply ──────────────────────────────────────────────────────────────────

interface Applied {
  journalEntryId?: string | null
  amountCents?: number | null
  costOutCents?: number | null
  accumOutCents?: number | null
  assetId?: string | null
  payload?: Record<string, unknown>
}

/**
 * Apply one pending event inside `tx`: serialised on the event, re-checked,
 * posted, then claimed pending → posted (updateMany; 0 rows → 409
 * NOT_PENDING, the transaction rolls back).
 */
async function applyInTx(tx: Tx, event: FixedAssetEvent, actorId: string): Promise<FixedAssetEvent> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'fixed_asset_event:' + event.id}))`
  const fresh = await tx.fixedAssetEvent.findUnique({ where: { id: event.id } })
  if (!fresh || fresh.status !== 'pending') throw new AppError('NOT_PENDING', 'This request is no longer pending', 409)
  const payload = parsePayload(fresh.kind, payloadOf(fresh))

  let out: Applied
  switch (fresh.kind) {
    case 'disposal': out = await applyDisposal(tx, fresh, payload, actorId); break
    case 'undispose': out = await applyUndispose(tx, fresh, actorId); break
    case 'impairment': out = await applyImpairment(tx, fresh, payload, actorId); break
    case 'change_estimate': out = await applyChangeEstimate(tx, fresh, payload, actorId); break
    case 'transfer': out = await applyTransfer(tx, fresh, payload, actorId); break
    case 'void': out = await applyVoid(tx, fresh, actorId); break
    case 'pool_write_off': out = await applyPoolWriteOff(tx, fresh, payload, actorId); break
    case 'pool_transfer': out = await applyPoolTransfer(tx, fresh, payload, actorId); break
    case 'count': out = await applyCount(tx, fresh, payload); break
    case 'capitalise': out = await applyCapitalise(tx, fresh, payload, actorId); break
    default: throw new AppError('BAD_EVENT_KIND', `Fixed-asset request kind "${fresh.kind}" cannot be applied`, 422)
  }

  const now = new Date()
  const claimed = await tx.fixedAssetEvent.updateMany({
    where: { id: fresh.id, status: 'pending' },
    data: {
      status: 'posted',
      decidedById: actorId,
      decidedAt: now,
      postedAt: now,
      errorMessage: null,
      ...(out.journalEntryId !== undefined ? { journalEntryId: out.journalEntryId } : {}),
      ...(out.amountCents !== undefined ? { amountCents: out.amountCents } : {}),
      ...(out.costOutCents !== undefined ? { costOutCents: out.costOutCents } : {}),
      ...(out.accumOutCents !== undefined ? { accumOutCents: out.accumOutCents } : {}),
      ...(out.assetId !== undefined ? { assetId: out.assetId } : {}),
      ...(out.payload ? { payload: json({ ...payload, ...out.payload }) } : {}),
    },
  })
  if (claimed.count === 0) throw new AppError('NOT_PENDING', 'This request is no longer pending', 409)
  return tx.fixedAssetEvent.findUniqueOrThrow({ where: { id: fresh.id } })
}

async function activeAsset(tx: Tx, assetId: string | null): Promise<FixedAsset> {
  if (!assetId) throw new AppError('ASSET_REQUIRED', 'Name the asset', 422)
  await lockAsset(tx, assetId)
  const asset = await tx.fixedAsset.findUnique({ where: { id: assetId } })
  if (!asset) throw new NotFoundError('FixedAsset', assetId)
  if (asset.status === 'voided') throw new AppError('ASSET_VOIDED', 'This asset was voided', 409)
  if (asset.status !== 'active') throw new AppError('ALREADY_DISPOSED', 'This asset has already been disposed of', 409)
  return asset
}

function sum(m: Map<string, number>): number {
  let t = 0
  for (const v of m.values()) t += v
  return t
}

function tagOf(a: FixedAsset): string {
  return `${a.name}${a.assetTag ? ` (${a.assetTag})` : ''}`.slice(0, 200)
}

// Full disposal: charge through the month before, reverse any charge of the
// disposal month or later, then Dr accumulated (per code) + Dr proceeds /
// Cr cost, gain (Cr) or loss (Dr) to 8030 — every line on the asset's brand.
async function applyDisposal(tx: Tx, event: FixedAssetEvent, payload: Record<string, unknown>, actorId: string): Promise<Applied> {
  const p = payload as z.infer<typeof PAYLOAD_SCHEMAS.disposal>
  const asset = await activeAsset(tx, event.assetId)
  if (asset.kind === 'pool_layer') throw new AppError('USE_POOL_WRITE_OFF', 'A smallwares layer leaves through its pool — write units off from the pool', 422)
  assertDisposalDate(asset, event.effectiveDate)
  const disposalPeriod = periodOfPkt(event.effectiveDate)
  await chargeAssetTx(tx, asset.id, chargeThroughBefore(event.effectiveDate), actorId)
  await reverseChargesFrom(tx, asset.id, disposalPeriod, actorId, 'Disposed — the disposal month and later are not charged')

  const state = await loadAssetState(tx, asset.id)
  const byCode = accumulatedByCode(state)
  const accumulated = sum(byCode)
  const cost = toCents(asset.costCents)
  // TODO(asset-sale-tax): no output sales tax on asset sales until the CA says otherwise.
  const proceeds = p.kind === 'lost' || p.kind === 'stolen' ? 0 : p.proceedsCents
  const money = proceeds > 0
    ? await moneyAccountCode(tx, asset.tenantId, { method: p.method ?? 'bank', bankAccountId: p.bankAccountId ?? null })
    : null
  const nbv = cost - accumulated
  const gainLoss = proceeds - nbv
  const memo = tagOf(asset)
  // "bank deposit, ref 4471" — how the buyer paid and the payment reference # (owner, 2026-10-14).
  const paid = money ? receiptText(p.method ?? 'bank', p.reference) : null
  const c = asset.conceptId
  const lines: JournalLineInput[] = []
  for (const [code, cents] of byCode) {
    lines.push({ accountCode: code, type: cents > 0 ? 'debit' : 'credit', amountCents: Math.abs(cents), conceptId: c, memo })
  }
  if (money) lines.push({ accountCode: money.code, type: 'debit', amountCents: proceeds, conceptId: c, memo: `Disposal proceeds (${paid}) — ${memo}` })
  lines.push({ accountCode: state.cls.costAccountCode, type: 'credit', amountCents: cost, conceptId: c, memo })
  if (gainLoss > 0) lines.push({ accountCode: ACCT.ASSET_DISPOSAL, type: 'credit', amountCents: gainLoss, conceptId: c, memo: `Gain on disposal — ${memo}` })
  if (gainLoss < 0) lines.push({ accountCode: ACCT.ASSET_DISPOSAL, type: 'debit', amountCents: -gainLoss, conceptId: c, memo: `Loss on disposal — ${memo}` })

  const dating = await lateDate(tx, asset.tenantId, event.effectiveDate)
  const w = withLateNote(`Disposed (${p.kind}) ${memo}${paid ? ` — ${paid}` : ''}`, lines, dating.memoNote)
  const r = await syncSourcePosting({
    tenantId: asset.tenantId, sourceType: DISPOSE_SOURCE, id: asset.id,
    desired: { description: w.description, entryDate: dating.entryDate, lines: w.lines },
    postedBy: actorId, reason: 'Disposed', tx,
  })
  const claimed = await tx.fixedAsset.updateMany({
    where: { id: asset.id, status: 'active' },
    data: {
      status: 'disposed', disposedAt: event.effectiveDate, disposalProceedsCents: proceeds,
      disposalKind: p.kind, disposalReason: event.reason.slice(0, 500),
    },
  })
  if (claimed.count === 0) throw new AppError('ALREADY_DISPOSED', 'This asset has already been disposed of', 409)
  return {
    journalEntryId: r.entryId, amountCents: proceeds, costOutCents: cost, accumOutCents: accumulated,
    payload: { nbvCents: nbv, gainLossCents: gainLoss, moneyCode: money?.code ?? null, bankAccountId: money?.bankAccountId ?? null },
  }
}

// Un-dispose: reverse the live disposal entry (dated now), make the asset
// active again and catch up the months since — reversed months re-post as @n.
async function applyUndispose(tx: Tx, event: FixedAssetEvent, actorId: string): Promise<Applied> {
  if (!event.assetId) throw new AppError('ASSET_REQUIRED', 'Name the asset', 422)
  await lockAsset(tx, event.assetId)
  const asset = await tx.fixedAsset.findUnique({ where: { id: event.assetId } })
  if (!asset) throw new NotFoundError('FixedAsset', event.assetId)
  if (asset.status !== 'disposed') throw new AppError('NOT_DISPOSED', 'This asset is not disposed', 409)
  if (asset.kind === 'pool_layer') throw new AppError('POOL_LAYER_UNDISPOSE', 'A written-off smallwares layer cannot be brought back — capitalise the units again', 422)
  const r = await syncSourcePosting({
    tenantId: asset.tenantId, sourceType: DISPOSE_SOURCE, id: asset.id, desired: null,
    postedBy: actorId, reason: `Disposal undone: ${event.reason}`.slice(0, 200), tx,
  })
  if (r.outcome === 'nothing') throw new AppError('NOTHING_TO_UNDISPOSE', 'No disposal entry is on the books for this asset', 409)
  await tx.fixedAsset.update({
    where: { id: asset.id },
    data: { status: 'active', disposedAt: null, disposalProceedsCents: null, disposalKind: null, disposalReason: null },
  })
  const caught = await chargeAssetTx(tx, asset.id, lastCompletedPeriodPkt(), actorId)
  return { journalEntryId: null, payload: { caughtUpMonths: caught.months.map((m) => m.period), caughtUpCents: caught.amountCents } }
}

// Impairment / write-down: Dr 6155 / Cr the class's accumulated code, capped
// at NBV − salvage after charging the months before.
async function applyImpairment(tx: Tx, event: FixedAssetEvent, payload: Record<string, unknown>, actorId: string): Promise<Applied> {
  const p = payload as z.infer<typeof PAYLOAD_SCHEMAS.impairment>
  const asset = await activeAsset(tx, event.assetId)
  await chargeAssetTx(tx, asset.id, chargeThroughBefore(event.effectiveDate), actorId)
  const state = await loadAssetState(tx, asset.id)
  const accumCode = state.cls.accumAccountCode
  if (!state.cls.depreciable || !accumCode || asset.method === 'none') {
    throw new AppError('NOT_DEPRECIABLE', `${state.cls.label} is not depreciated — it cannot be written down here`, 422)
  }
  const nbv = toCents(asset.costCents) - sum(accumulatedByCode(state))
  const room = nbv - toCents(asset.salvageCents)
  const amount = Math.min(p.amountCents, room)
  if (amount <= 0) throw new AppError('NOTHING_TO_IMPAIR', 'The book value is already at salvage — there is nothing to write down', 422)
  const memo = tagOf(asset)
  const dating = await lateDate(tx, asset.tenantId, event.effectiveDate)
  const w = withLateNote(`Impairment of ${memo}`, [
    { accountCode: ACCT.IMPAIRMENT, type: 'debit', amountCents: amount, conceptId: asset.conceptId, memo },
    { accountCode: accumCode, type: 'credit', amountCents: amount, conceptId: asset.conceptId, memo },
  ], dating.memoNote)
  const r = await postJournalEntry({
    tenantId: asset.tenantId, sourceType: IMPAIRMENT_SOURCE, sourceId: event.id,
    description: w.description, entryDate: dating.entryDate, postedBy: actorId, lines: w.lines,
  }, { tx })
  return { journalEntryId: r.entryId, amountCents: amount, payload: { requestedCents: p.amountCents, accumCode, nbvBeforeCents: nbv } }
}

// Change of estimate (IAS 8, prospective): the new remaining life counts from
// the event month; the schedule re-spreads what remains. No journal entry.
async function applyChangeEstimate(tx: Tx, event: FixedAssetEvent, payload: Record<string, unknown>, actorId: string): Promise<Applied> {
  const p = payload as z.infer<typeof PAYLOAD_SCHEMAS.change_estimate>
  const asset = await activeAsset(tx, event.assetId)
  await chargeAssetTx(tx, asset.id, chargeThroughBefore(event.effectiveDate), actorId)
  const state = await loadAssetState(tx, asset.id)
  if (!state.cls.depreciable || !state.cls.accumAccountCode || asset.method === 'none') {
    throw new AppError('NOT_DEPRECIABLE', `${state.cls.label} is not depreciated`, 422)
  }
  const start = periodIndex(periodOfPkt(asset.inServiceAt ?? asset.acquiredAt))
  const eff = Math.max(periodIndex(periodOfPkt(event.effectiveDate)), start)
  const life = p.remainingLifeMonths !== undefined ? (eff - start) + p.remainingLifeMonths : asset.usefulLifeMonths
  const cost = toCents(asset.costCents)
  const salvage = p.salvageCents ?? toCents(asset.salvageCents)
  if (salvage >= cost) throw new AppError('SALVAGE_TOO_HIGH', 'Salvage value must be less than cost', 422)
  if (sum(accumulatedByCode(state)) > cost - salvage) {
    throw new AppError('SALVAGE_TOO_HIGH', 'The asset is already depreciated below that salvage value', 422)
  }
  const before = { usefulLifeMonths: asset.usefulLifeMonths, salvageCents: toCents(asset.salvageCents) }
  await tx.fixedAsset.update({ where: { id: asset.id }, data: { usefulLifeMonths: life, salvageCents: salvage } })
  return { journalEntryId: null, payload: { before, after: { usefulLifeMonths: life, salvageCents: salvage } } }
}

// Transfer of an individual asset to another outlet and / or brand (finance,
// at once). Months up to the last completed one stay on the old brand; when
// the brand changes the cost and the accumulated move with a zero-net entry.
async function applyTransfer(tx: Tx, event: FixedAssetEvent, payload: Record<string, unknown>, actorId: string): Promise<Applied> {
  const p = payload as z.infer<typeof PAYLOAD_SCHEMAS.transfer>
  const asset = await activeAsset(tx, event.assetId)
  if (asset.kind === 'pool_layer') throw new AppError('USE_POOL_TRANSFER', 'A smallwares layer moves through its pool — transfer units from the pool', 422)
  if (p.toLocationId) await assertLocationOf(tx, asset.tenantId, p.toLocationId)
  if (p.toConceptId) await assertConceptOf(tx, asset.tenantId, p.toConceptId)
  const toConcept = p.toConceptId === undefined ? asset.conceptId : p.toConceptId
  const toLocation = p.toLocationId === undefined ? asset.locationId : p.toLocationId
  if (toConcept === asset.conceptId && toLocation === asset.locationId) {
    throw new AppError('NOTHING_TO_TRANSFER', 'Name a different outlet or brand', 422)
  }
  await chargeAssetTx(tx, asset.id, lastCompletedPeriodPkt(), actorId)
  let entryId: string | null = null
  if (toConcept !== asset.conceptId) {
    const state = await loadAssetState(tx, asset.id)
    const memo = tagOf(asset)
    const cost = toCents(asset.costCents)
    const lines: JournalLineInput[] = [
      { accountCode: state.cls.costAccountCode, type: 'debit', amountCents: cost, conceptId: toConcept, memo },
      { accountCode: state.cls.costAccountCode, type: 'credit', amountCents: cost, conceptId: asset.conceptId, memo },
    ]
    for (const [code, cents] of accumulatedByCode(state)) {
      if (cents <= 0) continue
      lines.push({ accountCode: code, type: 'debit', amountCents: cents, conceptId: asset.conceptId, memo })
      lines.push({ accountCode: code, type: 'credit', amountCents: cents, conceptId: toConcept, memo })
    }
    const dating = await lateDate(tx, asset.tenantId, new Date())
    if (lines.some((l) => l.amountCents > 0)) {
      const r = await postJournalEntry({
        tenantId: asset.tenantId, sourceType: TRANSFER_SOURCE, sourceId: event.id,
        description: `Brand transfer of ${memo}`, entryDate: dating.entryDate, postedBy: actorId, lines,
      }, { tx })
      entryId = r.entryId
    }
  }
  await tx.fixedAsset.update({ where: { id: asset.id }, data: { conceptId: toConcept, locationId: toLocation } })
  return {
    journalEntryId: entryId,
    payload: { fromConceptId: asset.conceptId, toConceptId: toConcept, fromLocationId: asset.locationId, toLocationId: toLocation },
  }
}

// Void (capitalised in error): every asset of the same CapEx line goes
// together. Reverses the acquisition (advances back to 1340, the owed amount
// out of 2012), every live depreciation month and every impairment — all
// dated now. 409 ASSET_HAS_EVENTS when a disposal / write-off / transfer is
// on the books. The CapEx line is then free to be capitalised again.
async function applyVoid(tx: Tx, event: FixedAssetEvent, actorId: string): Promise<Applied> {
  if (!event.assetId) throw new AppError('ASSET_REQUIRED', 'Name the asset', 422)
  const target = await tx.fixedAsset.findUnique({ where: { id: event.assetId } })
  if (!target) throw new NotFoundError('FixedAsset', event.assetId)
  const group = target.capexLineId
    ? await tx.fixedAsset.findMany({ where: { tenantId: target.tenantId, capexLineId: target.capexLineId, status: { not: 'voided' } }, orderBy: { id: 'asc' } })
    : [target]
  if (!group.some((a) => a.id === target.id)) throw new AppError('ASSET_VOIDED', 'This asset was voided', 409)
  for (const a of group) await lockAsset(tx, a.id)
  const reason = `Voided — capitalised in error: ${event.reason}`.slice(0, 200)
  for (const a of group) {
    const fresh = await tx.fixedAsset.findUniqueOrThrow({ where: { id: a.id } })
    const blocking = await blockingHistory(tx, a.id)
    if (blocking || fresh.status !== 'active') {
      throw new AppError('ASSET_HAS_EVENTS', `${tagOf(fresh)} has ${blocking ?? 'a disposal'} on the books — it cannot be voided`, 409)
    }
    await reverseChargesFrom(tx, a.id, null, actorId, reason)
    const impairments = await tx.fixedAssetEvent.findMany({ where: { assetId: a.id, kind: 'impairment', status: 'posted' }, select: { id: true } })
    for (const imp of impairments) {
      const live = await tx.journalEntry.findFirst({ where: { tenantId: a.tenantId, reference: `${IMPAIRMENT_SOURCE}:${imp.id}` }, select: { id: true } })
      if (live) await reverseJournalEntry(a.tenantId, IMPAIRMENT_SOURCE, imp.id, reason, { tx, postedBy: actorId })
    }
    await syncSourcePosting({ tenantId: a.tenantId, sourceType: ACQUIRE_SOURCE, id: a.id, desired: null, postedBy: actorId, reason, tx })
    await tx.fixedAsset.update({ where: { id: a.id }, data: { status: 'voided', voidedAt: new Date(), voidReason: event.reason.slice(0, 500) } })
  }
  return { journalEntryId: null, payload: { voidedAssetIds: group.map((a) => a.id) } }
}

/** Per-code slices of a layer's accumulated for `units` of `quantity` (remainder on the last unit out). */
function sliceByCode(byCode: Map<string, number>, units: number, quantity: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const [code, cents] of byCode) {
    const s = sliceCents(cents, units, quantity)
    if (s) out.set(code, s)
  }
  return out
}

async function lockPool(tx: Tx, poolId: string): Promise<FixedAssetPool> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'fixed_asset_pool:' + poolId}))`
  const pool = await tx.fixedAssetPool.findUnique({ where: { id: poolId } })
  if (!pool) throw new NotFoundError('FixedAssetPool', poolId)
  return pool
}

// Pool write-off (breakage / loss / theft / worn out): units come out of the
// layers FIFO, re-checked against what is on hand NOW (409 UNITS_EXCEED_POOL).
// Each layer is charged through the month before first; its slice is
// Dr accumulated + Dr 8030 (the NBV lost) / Cr 1560. One entry per request.
async function applyPoolWriteOff(tx: Tx, event: FixedAssetEvent, payload: Record<string, unknown>, actorId: string): Promise<Applied> {
  const p = payload as z.infer<typeof PAYLOAD_SCHEMAS.pool_write_off>
  if (!event.poolId) throw new AppError('POOL_REQUIRED', 'Name the smallwares pool', 422)
  const pool = await lockPool(tx, event.poolId)
  const allocs = allocateFifo(await poolLayersFifo(tx, pool.id), p.units)
  const through = chargeThroughBefore(event.effectiveDate)
  const lines: JournalLineInput[] = []
  const allocations: Array<Record<string, unknown>> = []
  const childIds: string[] = []
  let costOutTotal = 0, accumOutTotal = 0
  for (const al of allocs) {
    await chargeAssetTx(tx, al.layerId, through, actorId)
    const state = await loadAssetState(tx, al.layerId)
    const layer = state.asset
    const q = layer.quantity
    const cost = toCents(layer.costCents)
    const salvage = toCents(layer.salvageCents)
    const costOut = sliceCents(cost, al.units, q)
    const salvageOut = sliceCents(salvage, al.units, q)
    const accumOutByCode = sliceByCode(accumulatedByCode(state), al.units, q)
    const accumOut = sum(accumOutByCode)
    const nbvOut = costOut - accumOut
    const memo = tagOf(layer)
    for (const [code, cents] of accumOutByCode) {
      lines.push({ accountCode: code, type: cents > 0 ? 'debit' : 'credit', amountCents: Math.abs(cents), conceptId: layer.conceptId, memo })
    }
    if (nbvOut > 0) lines.push({ accountCode: ACCT.ASSET_DISPOSAL, type: 'debit', amountCents: nbvOut, conceptId: layer.conceptId, memo: `Written off (${p.cause}) — ${memo}` })
    if (nbvOut < 0) lines.push({ accountCode: ACCT.ASSET_DISPOSAL, type: 'credit', amountCents: -nbvOut, conceptId: layer.conceptId, memo: `Written off (${p.cause}) — ${memo}` })
    lines.push({ accountCode: state.cls.costAccountCode, type: 'credit', amountCents: costOut, conceptId: layer.conceptId, memo })
    const child = await tx.fixedAssetEvent.create({
      data: {
        tenantId: layer.tenantId, assetId: layer.id, poolId: pool.id, parentEventId: event.id, kind: 'pool_write_off_alloc',
        status: 'posted', effectiveDate: event.effectiveDate,
        payload: json({ units: al.units, cause: p.cause, accumOutByCode: Object.fromEntries(accumOutByCode) }),
        amountCents: nbvOut, costOutCents: costOut, accumOutCents: accumOut,
        reason: event.reason, requestedById: event.requestedById, decidedById: actorId, decidedAt: new Date(), postedAt: new Date(),
      },
      select: { id: true },
    })
    childIds.push(child.id)
    const left = q - al.units
    await tx.fixedAsset.update({
      where: { id: layer.id },
      data: {
        quantity: left, costCents: cost - costOut, salvageCents: salvage - salvageOut,
        ...(left === 0 ? { status: 'disposed', disposedAt: event.effectiveDate, disposalKind: 'written_off', disposalReason: event.reason.slice(0, 500) } : {}),
      },
    })
    costOutTotal += costOut
    accumOutTotal += accumOut
    allocations.push({ assetId: layer.id, units: al.units, costOutCents: costOut, accumOutCents: accumOut, nbvOutCents: nbvOut })
  }
  const dating = await lateDate(tx, pool.tenantId, event.effectiveDate)
  const w = withLateNote(`Smallwares written off (${p.cause}): ${p.units} × ${pool.label}`, lines, dating.memoNote)
  const r = await postJournalEntry({
    tenantId: pool.tenantId, sourceType: POOL_WRITE_OFF_SOURCE, sourceId: event.id,
    description: w.description, entryDate: dating.entryDate, postedBy: actorId, lines: w.lines,
  }, { tx })
  await tx.fixedAssetEvent.updateMany({ where: { id: { in: childIds } }, data: { journalEntryId: r.entryId } })
  return {
    journalEntryId: r.entryId, amountCents: costOutTotal - accumOutTotal, costOutCents: costOutTotal, accumOutCents: accumOutTotal,
    payload: { allocations },
  }
}

// Pool unit transfer (finance, at once): FIFO slices of the source pool's
// layers become new layers of the destination pool (same company), carrying
// their accumulated (carriedAccumulatedCents) and charged from this month.
// A journal only when the brand changes: zero net on 1560 / 1599.
async function applyPoolTransfer(tx: Tx, event: FixedAssetEvent, payload: Record<string, unknown>, actorId: string): Promise<Applied> {
  const p = payload as z.infer<typeof PAYLOAD_SCHEMAS.pool_transfer>
  if (!event.poolId) throw new AppError('POOL_REQUIRED', 'Name the smallwares pool', 422)
  const source = await tx.fixedAssetPool.findUnique({ where: { id: event.poolId } })
  if (!source) throw new NotFoundError('FixedAssetPool', event.poolId)
  const toConcept = p.toConceptId === undefined ? source.conceptId : p.toConceptId
  const dest = await findOrCreatePool(tx, {
    tenantId: source.tenantId, locationId: p.toLocationId, conceptId: toConcept,
    classKey: source.classKey, typeKey: source.typeKey, createdById: actorId,
  })
  if (dest.id === source.id) throw new AppError('SAME_POOL', 'The units are already in that pool', 422)
  for (const id of [source.id, dest.id].sort()) await lockPool(tx, id)
  const allocs = allocateFifo(await poolLayersFifo(tx, source.id), p.units)
  const cls = await classOf(source.tenantId, source.classKey, tx)
  const through = lastCompletedPeriodPkt()
  const lines: JournalLineInput[] = []
  const allocations: Array<Record<string, unknown>> = []
  let costOutTotal = 0, accumOutTotal = 0
  for (const al of allocs) {
    await chargeAssetTx(tx, al.layerId, through, actorId)
    const state = await loadAssetState(tx, al.layerId)
    const src = state.asset
    const q = src.quantity
    const cost = toCents(src.costCents)
    const salvage = toCents(src.salvageCents)
    const costOut = sliceCents(cost, al.units, q)
    const salvageOut = sliceCents(salvage, al.units, q)
    const accumOutByCode = sliceByCode(accumulatedByCode(state), al.units, q)
    const accumOut = sum(accumOutByCode)
    assertMoneyFits(costOut, 'The transferred cost')
    const created = await tx.fixedAsset.create({
      data: {
        tenantId: src.tenantId, conceptId: dest.conceptId, locationId: dest.locationId, name: src.name, category: src.category,
        assetTag: await nextAssetTag(tx, src.tenantId), supplier: src.supplier, supplierId: src.supplierId,
        acquiredAt: src.acquiredAt, inServiceAt: src.inServiceAt ?? src.acquiredAt,
        costCents: costOut, originalCostCents: costOut, salvageCents: salvageOut, usefulLifeMonths: src.usefulLifeMonths,
        acquisitionCreditCode: src.acquisitionCreditCode, kind: 'pool_layer', poolId: dest.id,
        quantity: al.units, originalQuantity: al.units, method: src.method,
        carriedAccumulatedCents: accumOut, splitFromAssetId: src.id, leaseEndsAt: src.leaseEndsAt,
        inputTaxCode: src.inputTaxCode, notes: `Transferred from ${source.label}`.slice(0, 1000), createdById: actorId,
      },
      select: { id: true },
    })
    await tx.fixedAssetEvent.create({
      data: {
        tenantId: src.tenantId, assetId: src.id, poolId: source.id, parentEventId: event.id, kind: 'pool_transfer_alloc',
        status: 'posted', effectiveDate: event.effectiveDate,
        payload: json({ units: al.units, toAssetId: created.id, toPoolId: dest.id, accumOutByCode: Object.fromEntries(accumOutByCode) }),
        amountCents: costOut - accumOut, costOutCents: costOut, accumOutCents: accumOut,
        reason: event.reason, requestedById: event.requestedById, decidedById: actorId, decidedAt: new Date(), postedAt: new Date(),
      },
    })
    const left = q - al.units
    await tx.fixedAsset.update({
      where: { id: src.id },
      data: {
        quantity: left, costCents: cost - costOut, salvageCents: salvage - salvageOut,
        ...(left === 0 ? { status: 'disposed', disposedAt: event.effectiveDate, disposalKind: 'transferred', disposalReason: `Moved to ${dest.label}`.slice(0, 500) } : {}),
      },
    })
    const memo = tagOf(src)
    if (src.conceptId !== dest.conceptId) {
      lines.push({ accountCode: cls.costAccountCode, type: 'debit', amountCents: costOut, conceptId: dest.conceptId, memo })
      lines.push({ accountCode: cls.costAccountCode, type: 'credit', amountCents: costOut, conceptId: src.conceptId, memo })
    }
    // The new layer carries its accumulated on the class code; any other code (legacy) is moved onto it.
    for (const [code, cents] of accumOutByCode) {
      if (cents <= 0) continue
      if (code === cls.accumAccountCode && src.conceptId === dest.conceptId) continue
      lines.push({ accountCode: code, type: 'debit', amountCents: cents, conceptId: src.conceptId, memo })
      lines.push({ accountCode: cls.accumAccountCode ?? code, type: 'credit', amountCents: cents, conceptId: dest.conceptId, memo })
    }
    costOutTotal += costOut
    accumOutTotal += accumOut
    allocations.push({ fromAssetId: src.id, toAssetId: created.id, units: al.units, costOutCents: costOut, accumOutCents: accumOut })
  }
  let entryId: string | null = null
  if (lines.length > 0) {
    const dating = await lateDate(tx, source.tenantId, new Date())
    const r = await postJournalEntry({
      tenantId: source.tenantId, sourceType: TRANSFER_SOURCE, sourceId: event.id,
      description: `Smallwares moved: ${p.units} × ${source.label} → ${dest.label}`, entryDate: dating.entryDate, postedBy: actorId, lines,
    }, { tx })
    entryId = r.entryId
  }
  return {
    journalEntryId: entryId, amountCents: costOutTotal - accumOutTotal, costOutCents: costOutTotal, accumOutCents: accumOutTotal,
    payload: { toPoolId: dest.id, allocations },
  }
}

// Count: counted vs on hand — no money. Finance raises a write-off for a shortfall.
async function applyCount(tx: Tx, event: FixedAssetEvent, payload: Record<string, unknown>): Promise<Applied> {
  const p = payload as z.infer<typeof PAYLOAD_SCHEMAS.count>
  if (!event.poolId) throw new AppError('POOL_REQUIRED', 'Name the smallwares pool', 422)
  const onHand = await poolUnitsOnHand(tx, event.poolId)
  return { journalEntryId: null, amountCents: null, payload: { onHandUnits: onHand, shortfallUnits: onHand - p.countedUnits } }
}

// ─── Capitalise (CapEx → register; tests arrive with w2-fa-capex) ───────────

interface CapexSeam {
  capexAdvancesForLine(tenantId: string, lineId: string, db: Db): Promise<Array<{ paymentId: string; advancedCents: number }>>
}

// Dynamic import: capexPosting imports this module (prepareCapitalisation →
// createRequest), so a static import back would be a load-time cycle.
async function capexSeam(): Promise<CapexSeam> {
  // Read by name: w2-fa-capex adds capexAdvancesForLine; until then this answers 501.
  const mod: Record<string, unknown> = await import('../financePlanning/capexPosting.js')
  const fn = mod['capexAdvancesForLine']
  if (typeof fn !== 'function') {
    throw new AppError('CAPEX_SEAM_MISSING', 'Capitalising from CapEx is not available in this build yet', 501)
  }
  return { capexAdvancesForLine: fn as CapexSeam['capexAdvancesForLine'] }
}

/**
 * Split `total` into parts proportional to `caps`, never above a cap, adding
 * up exactly (Σcaps ≥ total). Used so each unit's advance never exceeds its
 * share of the cost.
 */
export function allocateWithin(total: number, caps: readonly number[]): number[] {
  const capSum = caps.reduce((t, c) => t + c, 0)
  if (total > capSum) throw new AppError('ALLOCATION', 'Cannot split more than the total', 500)
  if (capSum === 0) return caps.map(() => 0)
  const base = caps.map((c) => Math.floor((total * c) / capSum))
  let rest = total - base.reduce((t, b) => t + b, 0)
  for (let i = caps.length - 1; i >= 0 && rest > 0; i--) {
    const room = caps[i]! - base[i]!
    const add = Math.min(room, rest)
    base[i] = base[i]! + add
    rest -= add
  }
  return base
}

/** `total` split evenly over `n`, the remainder on the last. */
function evenSplit(total: number, n: number): number[] {
  const each = Math.floor(total / n)
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - each * (n - 1) : each))
}

const MAX_UNITS_PER_LINE = 200

async function applyCapitalise(tx: Tx, event: FixedAssetEvent, payload: Record<string, unknown>, actorId: string): Promise<Applied> {
  const p = payload as CapitalisePayload
  const lineId = event.capexLineId
  if (!lineId) throw new AppError('CAPEX_LINE_REQUIRED', 'Name the CapEx line', 422)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'capex_capitalise:' + lineId}))`
  const line = await tx.capexLine.findUnique({ where: { id: lineId }, include: { project: true } })
  if (!line || line.project.deletedAt) throw new NotFoundError('CapexLine', lineId)
  const tenantId = line.project.tenantId
  if (!tenantId) throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company — assets belong to one company', 422)
  if (tenantId !== event.tenantId) throw new NotFoundError('CapexLine', lineId)
  const live = await tx.fixedAsset.count({ where: { tenantId, capexLineId: lineId, status: { not: 'voided' } } })
  if (live > 0) throw new AppError('ALREADY_CAPITALISED', 'This item is already on the fixed-asset register', 409)

  const cls = await classOf(tenantId, p.classKey, tx)
  if (!cls.isActive) throw new AppError('CLASS_INACTIVE', `${cls.label} is switched off for this company`, 422)
  const advances = await (await capexSeam()).capexAdvancesForLine(tenantId, lineId, tx)
  const advanced = advances.reduce((t, a) => t + a.advancedCents, 0)
  const committed = line.negotiatedCents != null ? toCents(line.negotiatedCents) : toCents(line.unitCostCents) * line.quantity
  const gross = p.costCents ?? Math.max(committed, advanced)
  if (gross <= 0) throw new AppError('NO_COST', 'This line has no cost to capitalise', 422)
  assertMoneyFits(gross, 'The asset\'s cost')
  if (gross < advanced) {
    throw new AppError('COST_BELOW_ADVANCES', `PKR ${(advanced / 100).toFixed(0)} has been advanced for this item — the asset cannot cost less`, 422)
  }
  const inputTax = p.inputTaxCents ?? toCents(line.inputTaxCents)
  let inputTaxCode: string | null = null
  if (inputTax > 0) {
    if (!isAuthorityKey(line.inputTaxAuthority)) throw new AppError('INPUT_TAX_AUTHORITY', 'Say which authority the input tax was charged by', 422)
    inputTaxCode = inputTaxCodeFor(line.inputTaxAuthority)
    if (!INPUT_TAX_ACCOUNTS.includes(inputTaxCode)) throw new AppError('INPUT_TAX_CODE', 'Unknown input tax account', 422)
  }
  if (inputTax >= gross) throw new AppError('INPUT_TAX_TOO_LARGE', 'Input tax must be less than the cost', 422)

  const inServiceAt = p.inServiceAt ? parseDate(p.inServiceAt) : (line.installedDate ?? line.actualDeliveryDate ?? event.effectiveDate)
  if (inServiceAt.getTime() > Date.now()) throw new AppError('IN_SERVICE_DATE', 'The in-service date cannot be in the future', 422)
  const leaseEndsAt = p.leaseEndsAt ? parseDate(p.leaseEndsAt) : null
  let life = cls.depreciable ? (p.usefulLifeMonths ?? cls.defaultLifeMonths ?? 12) : 0
  if (life > 0 && leaseEndsAt) {
    const toLeaseEnd = periodIndex(periodOfPkt(leaseEndsAt)) - periodIndex(periodOfPkt(inServiceAt)) + 1
    life = Math.max(1, Math.min(life, toLeaseEnd))
  }
  // Brand and outlet: the payload's, else the project's (an individual asset may be given its
  // own brand or shared — owner, 2026-10-14). The shared-needs-a-location rule is checked when
  // the request is raised; a request already pending approves as before.
  const { conceptId, locationId } = capitaliseTarget(p, cls.pooled, line.project)
  if (locationId) await assertLocationOf(tx, tenantId, locationId)
  if (conceptId) await assertConceptOf(tx, tenantId, conceptId)
  const name = (p.name ?? line.item).trim().slice(0, 120)
  const salvage = p.salvageCents ?? 0

  // Pooled class → ONE layer of the line's quantity; big items → one asset per unit (N ≥ 2: units 1..N).
  const pool = cls.pooled
    ? await (async () => {
        if (!p.pool) throw new AppError('POOL_TYPE_REQUIRED', 'Say which smallwares type this is (plates, knives, …)', 422)
        if (!locationId) throw new AppError('POOL_NEEDS_LOCATION', 'Smallwares are pooled per outlet — name the outlet', 422)
        return findOrCreatePool(tx, { tenantId, locationId, conceptId, classKey: cls.key, typeKey: p.pool.typeKey, createdById: actorId })
      })()
    : null
  const units = pool || line.quantity <= 1 ? 1 : line.quantity
  if (units > MAX_UNITS_PER_LINE) throw new AppError('TOO_MANY_UNITS', `A line can be split into at most ${MAX_UNITS_PER_LINE} assets — capitalise it as a pool or split the line`, 422)
  const grossParts = evenSplit(gross, units)
  const taxParts = allocateWithin(inputTax, grossParts)
  const advParts = allocateWithin(advanced, grossParts)
  const salvageParts = evenSplit(salvage, units)

  const assetIds: string[] = []
  let firstEntry: string | null = null
  for (let i = 0; i < units; i++) {
    const net = grossParts[i]! - taxParts[i]!
    if (salvageParts[i]! >= net && cls.depreciable) throw new AppError('SALVAGE_TOO_HIGH', 'Salvage value must be less than cost', 422)
    const asset = await tx.fixedAsset.create({
      data: {
        tenantId, conceptId, locationId: locationId ?? null,
        name: units > 1 ? `${name} (${i + 1}/${units})`.slice(0, 120) : name,
        category: cls.key, assetTag: await nextAssetTag(tx, tenantId),
        supplier: line.vendor, supplierId: line.supplierId,
        acquiredAt: line.actualDeliveryDate ?? inServiceAt, inServiceAt,
        costCents: net, originalCostCents: net, salvageCents: salvageParts[i]!, usefulLifeMonths: life,
        acquisitionCreditCode: advParts[i]! > 0 ? ACCT.SUPPLIER_ADVANCES : ACCT.CAPITAL_PAYABLES,
        kind: pool ? 'pool_layer' : 'individual', poolId: pool?.id ?? null,
        quantity: pool ? line.quantity : 1, originalQuantity: pool ? line.quantity : 1,
        method: cls.depreciable ? 'straight_line' : 'none',
        capexLineId: lineId, capexLineUnit: units > 1 ? i + 1 : 0,
        inputTaxCents: taxParts[i]!, inputTaxCode, leaseEndsAt,
        documentUrls: line.documentUrls ?? undefined, photoUrls: line.photoUrls ?? undefined,
        warrantyUntil: line.warrantyMonths && line.actualDeliveryDate
          ? new Date(line.actualDeliveryDate.getTime() + line.warrantyMonths * 30.44 * 86_400_000) : null,
        createdById: actorId,
      },
    })
    const r = await postAcquisition(tx, asset, {
      advancedCents: advParts[i]!, owedCents: grossParts[i]! - advParts[i]!, inputTaxCents: taxParts[i]!, inputTaxCode,
      natural: inServiceAt, postedBy: actorId,
    })
    firstEntry ??= r.entryId
    assetIds.push(asset.id)
  }
  return {
    journalEntryId: firstEntry, amountCents: gross, assetId: assetIds[0] ?? null,
    payload: { assetIds, advancedCents: advanced, owedCents: gross - advanced, inputTaxCents: inputTax, poolId: pool?.id ?? null },
  }
}
