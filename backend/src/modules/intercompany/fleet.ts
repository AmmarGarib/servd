// Shared-fleet recharge (H30; owner Q2/Q3 defaults: a CEO-set rate per trip,
// booked as a cost recovery with no tax — confirm with the CA).
//
// GS Foods runs one rider fleet for every company (lib/fleet.ts, docs/rider-app.md):
// the PROVIDER company employs the riders, a CLIENT company's orders ride
// with them under a FleetAgreement. Each month the client pays the provider
// for the trips its orders took:
//
//   trips  = distinct orders whose FIRST 'picked_up' RiderJobEvent with
//            tenantId = client and riderTenantId = provider falls in the PKT
//            month (an order re-picked after a reassignment counts once)
//   rate   = the FleetRate of the agreement in force for that month (history:
//            a new row from a month on, never edited; 0 = not charged)
//   charge = an IntercompanyTransfer, source 'fleet', posted at once in both
//            books under 'ic.transfer:<id>' (service.ts postSystemTransferTx):
//              client:   Dr 6035 Wages — Riders, per client brand (conceptId)
//                        / Cr Due to <provider>
//              provider: Dr Due from <client>
//                        / Cr 6990 Costs Recharged to Group Companies
//            (6035 stays the provider's gross rider wages; 6990 is the ONE
//            recovery account, shared with D1's head-office recharges.)
//
// Dated the month's last day (midday PKT); if that day is closed in EITHER
// company, the first day open in BOTH with a note naming the month (owner
// decision 6). Idempotent: sourceRef 'fleet:<agreementId>:<YYYY-MM>' is unique
// per pair and checked under the pair lock. A refusal raises posting_failed
// 'ic.fleet_charge' (entity 'FleetCharge', id '<agreementId>:<YYYY-MM>') in the
// client company; the nightly worker retries, the CEO's "Charge now" posts it,
// and w4's re-poster wraps fleetChargeRefusedDoc below.

import { serviceClient } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { assertMoneyFits } from '../../lib/money.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { isMemberOfBoth, memberTenantIdsOf } from '../../lib/companyPairs.js'
import { ACCT, flagPostingFailed, resolvePostingFailed } from '../accounting/journal.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import type { RefusedDoc, RepostResult } from '../reconciliation/backfillOrders.js'
import { lockPair, type Db } from './accounts.js'
import { commonOpenPlacement, postSystemTransferTx, type TransferActor } from './service.js'

/** posting_failed metadata.sourceType of a refused fleet charge (and w4's RefusedPostingKind). */
export const FLEET_CHARGE_KIND = 'ic.fleet_charge'
/** posting_failed entityType of a refused fleet charge; entityId = '<agreementId>:<YYYY-MM>'. */
export const FLEET_CHARGE_ENTITY = 'FleetCharge'
/** The client's debit — gross rider cost. */
export const FLEET_DEBIT_CODE = ACCT.WAGES_RIDERS
/** The provider's credit — the one group-recharge recovery account. */
export const FLEET_CREDIT_CODE = ACCT.GROUP_RECHARGES
/** How many ended months back the nightly worker charges. */
export const FLEET_AUTO_MONTHS_BACK = 3
/** Reasons a fleet charge has nothing to post (w4's Reposter.nothingToPost). */
export const FLEET_NOTHING_TO_POST: ReadonlySet<string> = new Set(['agreement_not_found', 'no_rate', 'no_trips', 'already_charged'])
/** What the re-poster tells an operator who does not belong to both companies. */
export const FLEET_ASK_CEO = 'Only someone who belongs to both companies can post a shared-fleet charge — ask the CEO to Charge now (Accounting → Inter-company → Shared fleet)'

const TX_OPTS = { timeout: 30_000, maxWait: 10_000 } as const

export const fleetSourceRef = (agreementId: string, month: string) => `fleet:${agreementId}:${month}`
export const fleetChargeId = (agreementId: string, month: string) => `${agreementId}:${month}`

// ─── Months (PKT) ────────────────────────────────────────────────────────────

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export function assertMonth(month: string, field = 'month'): void {
  if (!MONTH.test(month)) throw new AppError('INVALID_MONTH', `Give the ${field} as YYYY-MM`, 422)
}

/** The PKT month of an instant, 'YYYY-MM'. */
export function monthOf(d: Date): string {
  return fmtPktDate(d).slice(0, 7)
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Every month from `from` to `to` inclusive (empty when from > to; at most 120). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = from; m <= to && out.length < 120; m = addMonths(m, 1)) out.push(m)
  return out
}

/** The month's first instant, last instant (both PKT) and its last day. */
export function monthBounds(month: string): { from: Date; to: Date; lastDay: string } {
  assertMonth(month)
  const [y, m] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const lastDay = `${month}-${String(last).padStart(2, '0')}`
  return { from: parsePktStartOfDay(`${month}-01`), to: parsePktEndOfDay(lastDay), lastDay }
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function isMonthEnded(month: string, now: Date = new Date()): boolean {
  return monthBounds(month).to.getTime() < now.getTime()
}

const pkr = (c: number) => `Rs ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`

// ─── Rates ───────────────────────────────────────────────────────────────────

export interface FleetRateView { id: string; fromPeriod: string; ratePerTripCents: number; note: string | null; setById: string; createdAt: Date }

/** The agreement's rate history, newest first. */
export async function ratesOf(db: Db, agreementId: string): Promise<FleetRateView[]> {
  return db.fleetRate.findMany({
    where: { agreementId },
    orderBy: { fromPeriod: 'desc' },
    select: { id: true, fromPeriod: true, ratePerTripCents: true, note: true, setById: true, createdAt: true },
  })
}

/** The rate in force for `month` (the latest fromPeriod ≤ month), or null when none was set yet. */
export function rateIn(rates: FleetRateView[], month: string): FleetRateView | null {
  return rates.find((r) => r.fromPeriod <= month) ?? null
}

export async function rateFor(db: Db, agreementId: string, month: string): Promise<FleetRateView | null> {
  return db.fleetRate.findFirst({
    where: { agreementId, fromPeriod: { lte: month } },
    orderBy: { fromPeriod: 'desc' },
    select: { id: true, fromPeriod: true, ratePerTripCents: true, note: true, setById: true, createdAt: true },
  })
}

/**
 * The CEO sets a provider's per-trip rate from a month on (a new history row).
 * The caller has checked the pair (assertBothSidesOwned). 409 RATE_EXISTS for
 * the same month; 409 RATE_PERIOD_CHARGED when a month at or after it is
 * already charged (reverse that charge first).
 */
export async function setFleetRate(
  actor: TransferActor, agreementId: string, input: { ratePerTripCents: number; fromPeriod: string; note?: string | null },
): Promise<FleetRateView & { providerTenantId: string; clientTenantId: string }> {
  assertMonth(input.fromPeriod, 'month the rate starts')
  const ag = await serviceClient.fleetAgreement.findUnique({ where: { id: agreementId } })
  if (!ag) throw new AppError('NOT_FOUND', 'Fleet agreement not found', 404)
  return serviceClient.$transaction(async (tx) => {
    await lockPair(tx, ag.providerTenantId, ag.clientTenantId)
    const same = await tx.fleetRate.findFirst({ where: { agreementId, fromPeriod: input.fromPeriod }, select: { id: true } })
    if (same) throw new AppError('RATE_EXISTS', `A rate from ${monthLabel(input.fromPeriod)} is already set — rates are history; set the next month instead`, 409)
    const charged = await tx.intercompanyTransfer.findFirst({
      where: {
        source: 'fleet', status: 'posted', tenantId: ag.clientTenantId, counterpartyTenantId: ag.providerTenantId,
        sourceRef: { startsWith: `fleet:${agreementId}:` }, period: { gte: input.fromPeriod },
      },
      orderBy: { period: 'desc' },
      select: { period: true },
    })
    if (charged) {
      throw new AppError(
        'RATE_PERIOD_CHARGED',
        `${monthLabel(charged.period ?? input.fromPeriod)} is already charged at the old rate — reverse that charge first, or start the new rate after it`,
        409,
      )
    }
    const row = await tx.fleetRate.create({
      data: {
        tenantId: ag.providerTenantId, clientTenantId: ag.clientTenantId, agreementId,
        fromPeriod: input.fromPeriod, ratePerTripCents: input.ratePerTripCents, setById: actor.id, note: input.note?.trim() || null,
      },
      select: { id: true, fromPeriod: true, ratePerTripCents: true, note: true, setById: true, createdAt: true },
    })
    return { ...row, providerTenantId: ag.providerTenantId, clientTenantId: ag.clientTenantId }
  }, TX_OPTS)
}

// ─── Trips ───────────────────────────────────────────────────────────────────

/**
 * Trips per PKT month and client brand from `fromMonth` to `toMonth`: distinct
 * orders of `client` whose first pick-up by a `provider` rider falls in the
 * month.
 */
export async function tripsByMonth(
  db: Db, provider: string, client: string, fromMonth: string, toMonth: string,
): Promise<Map<string, Array<{ conceptId: string; trips: number }>>> {
  const from = monthBounds(fromMonth).from
  const to = monthBounds(toMonth).to
  const rows = await db.$queryRaw<Array<{ month: string; conceptId: string; trips: number }>>`
    SELECT to_char(f.first_at + interval '5 hours', 'YYYY-MM') AS month, f."conceptId" AS "conceptId", COUNT(*)::int AS trips
      FROM (
        SELECT e."orderId", o."conceptId", MIN(e."createdAt") AS first_at
          FROM rider_job_events e
          JOIN orders o ON o.id = e."orderId"
         WHERE e.type = 'picked_up'
           AND e."tenantId" = ${client}
           AND e."riderTenantId" = ${provider}
           AND e."createdAt" <= ${to}
         GROUP BY e."orderId", o."conceptId"
      ) f
     WHERE f.first_at >= ${from}
     GROUP BY 1, 2
     ORDER BY 1, 2`
  const out = new Map<string, Array<{ conceptId: string; trips: number }>>()
  for (const r of rows) out.set(r.month, [...(out.get(r.month) ?? []), { conceptId: r.conceptId, trips: Number(r.trips) }])
  return out
}

/** One month's trips per client brand. */
export async function tripsFor(db: Db, provider: string, client: string, month: string): Promise<Array<{ conceptId: string; trips: number }>> {
  return (await tripsByMonth(db, provider, client, month, month)).get(month) ?? []
}

// ─── Months of an agreement ──────────────────────────────────────────────────

export type FleetMonthStatus = 'not_ended' | 'no_rate' | 'zero_rate' | 'no_trips' | 'charged' | 'due'

export interface FleetMonth {
  month: string
  trips: number
  byBrand: Array<{ conceptId: string; trips: number }>
  ratePerTripCents: number | null
  amountCents: number
  status: FleetMonthStatus
  transferId: string | null
}

/** Each month's trips, rate and charge state for one agreement. */
export async function fleetMonths(
  db: Db, ag: { id: string; providerTenantId: string; clientTenantId: string }, months: string[], now: Date = new Date(),
): Promise<FleetMonth[]> {
  if (months.length === 0) return []
  const sorted = [...months].sort()
  const [rates, trips, transfers] = await Promise.all([
    ratesOf(db, ag.id),
    tripsByMonth(db, ag.providerTenantId, ag.clientTenantId, sorted[0]!, sorted[sorted.length - 1]!),
    db.intercompanyTransfer.findMany({
      where: {
        tenantId: ag.clientTenantId, counterpartyTenantId: ag.providerTenantId, source: 'fleet', status: 'posted',
        sourceRef: { in: sorted.map((m) => fleetSourceRef(ag.id, m)) },
      },
      select: { id: true, sourceRef: true },
    }),
  ])
  const chargedBy = new Map(transfers.map((t) => [t.sourceRef!, t.id]))
  return sorted.map((month) => {
    const byBrand = trips.get(month) ?? []
    const total = byBrand.reduce((s, b) => s + b.trips, 0)
    const rate = rateIn(rates, month)
    const transferId = chargedBy.get(fleetSourceRef(ag.id, month)) ?? null
    const amountCents = rate ? total * rate.ratePerTripCents : 0
    let status: FleetMonthStatus
    if (transferId) status = 'charged'
    else if (!isMonthEnded(month, now)) status = 'not_ended'
    else if (!rate) status = total > 0 ? 'no_rate' : 'no_trips'
    else if (rate.ratePerTripCents === 0) status = 'zero_rate'
    else if (total === 0) status = 'no_trips'
    else status = 'due'
    return { month, trips: total, byBrand, ratePerTripCents: rate?.ratePerTripCents ?? null, amountCents, status, transferId }
  })
}

// ─── Charging ────────────────────────────────────────────────────────────────

export interface FleetChargeResult {
  charged: boolean
  transferId?: string
  debtorEntryId?: string
  amountCents?: number
  trips?: number
  /** Why nothing was posted: one of FLEET_NOTHING_TO_POST. */
  reason?: string
}

/**
 * Charge one ended month of one agreement. Idempotent. `entryDate` forces the
 * date (it must be open in both companies); otherwise month end, or the first
 * day open in both with a note. A refusal raises posting_failed
 * 'ic.fleet_charge' in the client company and rethrows.
 */
export async function chargeFleetMonth(
  agreementId: string, month: string, o: { entryDate?: Date; memoNote?: string; postedBy?: string } = {},
): Promise<FleetChargeResult> {
  assertMonth(month)
  if (!isMonthEnded(month)) throw new AppError('MONTH_NOT_ENDED', `${monthLabel(month)} has not ended yet — it is charged after its last day`, 422)
  const ag = await serviceClient.fleetAgreement.findUnique({ where: { id: agreementId } })
  if (!ag) return { charged: false, reason: 'agreement_not_found' }
  const provider = ag.providerTenantId
  const client = ag.clientTenantId
  const sourceRef = fleetSourceRef(ag.id, month)
  const id = fleetChargeId(ag.id, month)

  const existing = await serviceClient.intercompanyTransfer.findUnique({
    where: { tenantId_counterpartyTenantId_sourceRef: { tenantId: client, counterpartyTenantId: provider, sourceRef } },
    select: { id: true, status: true, debtorEntryId: true },
  })
  if (existing?.status === 'posted') {
    return { charged: false, transferId: existing.id, debtorEntryId: existing.debtorEntryId ?? undefined, reason: 'already_charged' }
  }
  const rate = await rateFor(serviceClient, ag.id, month)
  if (!rate || rate.ratePerTripCents <= 0) return { charged: false, reason: 'no_rate' }
  const byBrand = await tripsFor(serviceClient, provider, client, month)
  const trips = byBrand.reduce((s, b) => s + b.trips, 0)
  if (trips === 0) return { charged: false, reason: 'no_trips' }
  const split = byBrand.map((b) => ({ conceptId: b.conceptId, cents: b.trips * rate.ratePerTripCents }))
  const amountCents = split.reduce((s, x) => s + x.cents, 0)

  const tenants = await serviceClient.tenant.findMany({ where: { id: { in: [provider, client] } }, select: { id: true, name: true } })
  const nameOf = (t: string) => tenants.find((x) => x.id === t)?.name ?? 'company'
  const label = `the ${monthLabel(month)} shared-fleet charge`
  const memo = `${trips} trip${trips === 1 ? '' : 's'} x ${pkr(rate.ratePerTripCents)}, ${monthLabel(month)} — ${nameOf(provider)} fleet for ${nameOf(client)}`

  try {
    assertMoneyFits(amountCents, `The ${monthLabel(month)} fleet charge`)
    let entryDate: Date
    let memoNote: string | undefined
    if (o.entryDate) {
      entryDate = o.entryDate
      memoNote = o.memoNote
    } else {
      const natural = new Date(`${monthBounds(month).lastDay}T12:00:00+05:00`)
      const place = await commonOpenPlacement(serviceClient, [client, provider], natural, label)
      if ('lockedThroughToday' in place) {
        throw new AppError('PERIOD_LOCKED', `${nameOf(place.tenantId)}'s books are closed through ${fmtPktDate(place.lockedThrough)}, today included — ${label} waits until today is open`, 422)
      }
      entryDate = place.entryDate
      memoNote = place.memoNote ?? o.memoNote
    }
    const postedBy = o.postedBy ?? 'system'
    const res = await serviceClient.$transaction(async (tx) => {
      // A clear 422 when an operator owns 6035 / 6990 for something else.
      await assertTemplateAccounts(tx, client, [FLEET_DEBIT_CODE])
      await assertTemplateAccounts(tx, provider, [FLEET_CREDIT_CODE])
      return postSystemTransferTx(tx, {
        kind: 'charge', source: 'fleet', sourceRef,
        debtorTenantId: client, creditorTenantId: provider, amountCents, entryDate,
        debtorAccountCode: FLEET_DEBIT_CODE, creditorAccountCode: FLEET_CREDIT_CODE,
        conceptSplit: split, memo, preparedById: postedBy, period: month, memoNote,
      })
    }, TX_OPTS)
    await resolvePostingFailed(FLEET_CHARGE_ENTITY, id, FLEET_CHARGE_KIND, `Charged (transfer ${res.transferId.slice(0, 8)}).`)
    return {
      charged: !res.alreadyPosted, transferId: res.transferId, debtorEntryId: res.debtorEntryId, amountCents, trips,
      ...(res.alreadyPosted && { reason: 'already_charged' }),
    }
  } catch (err) {
    await flagPostingFailed({
      tenantId: client,
      sourceType: FLEET_CHARGE_KIND, sourceId: id,
      entityType: FLEET_CHARGE_ENTITY, entityId: id,
      reason: (err as Error).message,
      title: `Shared-fleet charge for ${monthLabel(month)} not posted`,
      amountCents,
      actorId: o.postedBy && o.postedBy !== 'system' ? o.postedBy : null,
      metadata: { agreementId: ag.id, month, providerTenantId: provider, clientTenantId: client, trips },
    })
    throw err
  }
}

/**
 * The nightly sweep: for every agreement with a rate above zero, each of the
 * last FLEET_AUTO_MONTHS_BACK ended months from its first rate on that is not
 * charged yet. A month that fails is flagged (inside chargeFleetMonth) and
 * the sweep moves on.
 */
export async function chargeAllEnded(now: Date = new Date()): Promise<{ charged: number; failed: number }> {
  const current = monthOf(now)
  const months: string[] = []
  for (let i = FLEET_AUTO_MONTHS_BACK; i >= 1; i--) months.push(addMonths(current, -i))
  const agreements = await serviceClient.fleetAgreement.findMany({
    where: { rates: { some: { ratePerTripCents: { gt: 0 } } } },
    select: { id: true, rates: { select: { fromPeriod: true }, orderBy: { fromPeriod: 'asc' }, take: 1 } },
  })
  let charged = 0
  let failed = 0
  for (const ag of agreements) {
    const first = ag.rates[0]?.fromPeriod
    if (!first) continue
    for (const m of months) {
      if (m < first || !isMonthEnded(m, now)) continue
      try {
        const r = await chargeFleetMonth(ag.id, m)
        if (r.charged) charged += 1
      } catch (err) {
        failed += 1
        console.error(`[intercompanyFleet] ${ag.id} ${m}:`, (err as Error).message)
      }
    }
  }
  return { charged, failed }
}

let running = false

/** One pass of the nightly fleet charge (running guard; tests call it directly). */
export async function runFleetChargesOnce(now: Date = new Date()): Promise<void> {
  if (running) return
  running = true
  try {
    const r = await chargeAllEnded(now)
    if (r.charged > 0 || r.failed > 0) console.info(`[intercompanyFleet] ${r.charged} month(s) charged, ${r.failed} refused (flagged)`)
  } finally {
    running = false
  }
}

// ─── The re-poster's document (w4-integration wires it into REPOSTERS) ───────

/**
 * A refused fleet charge as Reconciliation → Backfill unposted sees it
 * (backfillOrders.ts RefusedDoc). `sourceId` is '<agreementId>:<YYYY-MM>'.
 *   • nothingOwed when the month is already charged (the transfer with
 *     sourceRef 'fleet:<…>' is posted — its journal key is 'ic.transfer:<id>',
 *     so the backfill's own "already on the books" lookup never finds it), or
 *     there is no rate / no trip any more;
 *   • date null, so placeAndPost hands post() the operator (postedBy); post()
 *     ignores dates and re-derives the first day open in BOTH companies
 *     (chargeFleetMonth), and refuses unless that operator belongs to both
 *     companies (FLEET_ASK_CEO — not in nothingToPost, so the flag stays open).
 */
export async function fleetChargeRefusedDoc(sourceId: string): Promise<RefusedDoc | null> {
  const cut = sourceId.lastIndexOf(':')
  if (cut <= 0) return null
  const agreementId = sourceId.slice(0, cut)
  const month = sourceId.slice(cut + 1)
  if (!MONTH.test(month)) return null
  const ag = await serviceClient.fleetAgreement.findUnique({ where: { id: agreementId } })
  if (!ag) return null
  const [row] = await fleetMonths(serviceClient, ag, [month])
  const tenants = await serviceClient.tenant.findMany({ where: { id: { in: [ag.providerTenantId, ag.clientTenantId] } }, select: { id: true, name: true } })
  const nameOf = (t: string) => tenants.find((x) => x.id === t)?.name ?? 'company'
  let nothingOwed: string | undefined
  if (row!.status === 'charged') nothingOwed = `Already charged (transfer ${row!.transferId!.slice(0, 8)}).`
  else if (row!.status === 'no_rate' || row!.status === 'zero_rate') nothingOwed = 'No rate above zero is set for that month — nothing to charge.'
  else if (row!.status === 'no_trips') nothingOwed = 'No trips that month — nothing to charge.'
  return {
    tenantId: ag.clientTenantId,
    date: null,
    orderId: null,
    what: `Shared-fleet charge ${monthLabel(month)}: ${nameOf(ag.providerTenantId)} fleet for ${nameOf(ag.clientTenantId)} (${row!.trips} trips)`,
    amountCents: row!.amountCents || null,
    nothingOwed,
    post: async (opts): Promise<RepostResult> => {
      if (!opts.postedBy) return { posted: false, entryId: null, reason: FLEET_ASK_CEO }
      const members = await memberTenantIdsOf(opts.postedBy)
      if (!isMemberOfBoth({ id: opts.postedBy, memberTenantIds: members }, ag.providerTenantId, ag.clientTenantId)) {
        return { posted: false, entryId: null, reason: FLEET_ASK_CEO }
      }
      const r = await chargeFleetMonth(ag.id, month, { postedBy: opts.postedBy })
      return { posted: r.charged, entryId: r.debtorEntryId ?? null, ...(r.reason && { reason: r.reason }) }
    },
  }
}

