// Prepaid releases — ONE engine for every prepayment (H25, decision P7).
//
// A rent advance paid through CapEx (CapexPayment, line treatment 'prepaid':
// Dr 1310 at payment) or through OpEx (OpexPayment.treatment 'prepaid': Dr
// 1310 at payment, posted by opex/posting.ts) is spread straight-line over
// the months it covers:
//
//   source         monthly entry                                          brand
//   capex_payment  Dr 6010 Rent                     / Cr 1310             the project's (null = shared)
//   opex_payment   Dr the category's expense account / Cr 1310            the line's (else the category's)
//
//   • coverage: `coversFrom` ('YYYY-MM') + `coversMonths` on the payment; the
//     total is the payment's LIVE 1310 debit (never more is released).
//   • amount: floor(total ÷ months) a month, the remainder in the last month.
//   • key: 'prepaid.release:<sourceType>:<sourceId>:<YYYY-MM>' through
//     syncSourcePosting (keepLiveDate) + a PrepaidRelease row
//     (tenantId, sourceType, sourceId, period) — run it twice, it posts once.
//   • date: the last day of the month (12:00 PKT); a closed month posts into
//     the open month with the owner-decision-6 note (journal.ts
//     lateDatingFor) and PrepaidRelease.postedPeriod records where it landed.
//   • company: the SOURCE's (project.tenantId / category.tenantId).
//   • a refused release (an inactive account, a category with no expense
//     account) → flagPostingFailed(sourceType 'prepaid.release', entity
//     CapexPayment | OpexPayment, sourceId = entityId = the payment id); the
//     backfill's 'prepaid.release' re-poster calls releaseSourceThrough.
//
// Only completed months are released (the worker runs for the previous PKT
// month). A payment that has started releasing is locked against edits
// (409 PREPAID_RELEASING — capexPosting.ts; OpEx: opex/routes.ts).
// prepaidCloseChecks blocks a period close while a covered month inside it is
// unreleased; the fix runs POST /finance/prepaid-releases.

import type { Prisma } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { ACCT, flagPostingFailed, lateDatingFor, withLateNote } from './journal.js'
import { syncSourcePosting, liveRevision } from './sourcePosting.js'
import { expenseCodeForCategoryName } from './expenseCategories.js'
import type { CloseCheck, CloseCheckDb } from './closeCheckTypes.js'
import {
  addMonths, isPeriod, lastCompletedPeriodPkt, lastDayPkt, periodIndex, periodOfPkt,
} from '../fixedAssets/schedule.js'

type Db = Prisma.TransactionClient | typeof serviceClient

export const PREPAID_RELEASE_SOURCE = 'prepaid.release'
export const PREPAID_SOURCE_TYPES = ['capex_payment', 'opex_payment'] as const
export type PrepaidSourceType = (typeof PREPAID_SOURCE_TYPES)[number]

const PREPAID = ACCT.PREPAID // 1310
const CAPEX_PAYMENT_SOURCE = 'capex.payment'
const OPEX_PAYMENT_SOURCE = 'opex.payment'
const TX_OPTS = { timeout: 60_000, maxWait: 15_000 } as const

const ENTITY_OF: Record<PrepaidSourceType, 'CapexPayment' | 'OpexPayment'> = {
  capex_payment: 'CapexPayment',
  opex_payment: 'OpexPayment',
}

interface PrepaidSource {
  sourceType: PrepaidSourceType
  sourceId: string
  tenantId: string
  coversFrom: string
  coversMonths: number
  /** The payment's live 1310 debit — the most that is ever released. */
  totalCents: number
  /** Where each month goes. Null = the category has no expense account (refused). */
  debitCode: string | null
  conceptId: string | null
  label: string
}

/** The release key's id part (sourceType for syncSourcePosting is 'prepaid.release'). */
export function releaseKey(sourceType: PrepaidSourceType, sourceId: string, period: string): string {
  return `${sourceType}:${sourceId}:${period}`
}

/** Straight line: floor(total ÷ months) a month, the remainder in the last. */
export function releaseSchedule(totalCents: number, coversFrom: string, coversMonths: number): Array<{ period: string; amountCents: number }> {
  if (!isPeriod(coversFrom) || coversMonths <= 0 || totalCents <= 0) return []
  const each = Math.floor(totalCents / coversMonths)
  return Array.from({ length: coversMonths }, (_, i) => ({
    period: addMonths(coversFrom, i),
    amountCents: i === coversMonths - 1 ? totalCents - each * (coversMonths - 1) : each,
  }))
}

function live1310(lines: Array<{ accountCode: string; type: string; amountCents: number }> | undefined): number {
  return (lines ?? []).filter((l) => l.type === 'debit' && l.accountCode === PREPAID).reduce((t, l) => t + l.amountCents, 0)
}

/** One source, read through `db`; null when it is not a scheduled, posted prepayment. */
async function loadSource(db: Db, sourceType: PrepaidSourceType, sourceId: string): Promise<PrepaidSource | null> {
  if (sourceType === 'capex_payment') {
    const p = await db.capexPayment.findUnique({
      where: { id: sourceId },
      include: { line: { select: { item: true, project: { select: { name: true, tenantId: true, conceptId: true } } } } },
    })
    if (!p || !p.paidAt || !p.coversFrom || !p.coversMonths || !p.line.project.tenantId) return null
    const tenantId = p.line.project.tenantId
    // A legacy deposit moved to 1360 is not released.
    if ((await liveRevision(tenantId, 'capex.deposit_reclass', p.id, db)).live) return null
    const total = live1310((await liveRevision(tenantId, CAPEX_PAYMENT_SOURCE, p.id, db)).live?.lines)
    if (total <= 0) return null
    return {
      sourceType, sourceId, tenantId, coversFrom: p.coversFrom, coversMonths: p.coversMonths, totalCents: total,
      debitCode: ACCT.RENT, conceptId: p.line.project.conceptId,
      label: `${p.line.project.name}: ${p.line.item}`,
    }
  }
  const p = await db.opexPayment.findUnique({
    where: { id: sourceId },
    include: { line: { select: { name: true, conceptId: true, category: { select: { name: true, tenantId: true, conceptId: true, expenseAccountCode: true } } } } },
  })
  if (!p || p.treatment !== 'prepaid' || !p.paidAt || !p.coversFrom || !p.coversMonths || !p.line.category.tenantId) return null
  const tenantId = p.line.category.tenantId
  const total = live1310((await liveRevision(tenantId, OPEX_PAYMENT_SOURCE, p.id, db)).live?.lines)
  if (total <= 0) return null
  const category = p.line.category
  return {
    sourceType, sourceId, tenantId, coversFrom: p.coversFrom, coversMonths: p.coversMonths, totalCents: total,
    debitCode: category.expenseAccountCode ?? expenseCodeForCategoryName(category.name),
    conceptId: p.line.conceptId ?? category.conceptId ?? null,
    label: `${category.name}: ${p.line.name}`,
  }
}

/** Every scheduled prepayment of a company (ids only). */
async function sourcesOf(db: Db, tenantId: string): Promise<Array<{ sourceType: PrepaidSourceType; sourceId: string }>> {
  const [capex, opex] = await Promise.all([
    db.capexPayment.findMany({
      where: { paidAt: { not: null }, coversFrom: { not: null }, coversMonths: { not: null }, line: { project: { tenantId } } },
      select: { id: true },
    }),
    db.opexPayment.findMany({
      where: { treatment: 'prepaid', paidAt: { not: null }, coversFrom: { not: null }, coversMonths: { not: null }, line: { category: { tenantId } } },
      select: { id: true },
    }),
  ])
  return [
    ...capex.map((p) => ({ sourceType: 'capex_payment' as const, sourceId: p.id })),
    ...opex.map((p) => ({ sourceType: 'opex_payment' as const, sourceId: p.id })),
  ]
}

/** The last month that may be released: `through`, never past the last completed PKT month. */
function capThrough(throughPeriod: string): string {
  if (!isPeriod(throughPeriod)) throw new AppError('BAD_PERIOD', 'The month must look like 2026-09', 400)
  const last = lastCompletedPeriodPkt()
  return periodIndex(throughPeriod) < periodIndex(last) ? throughPeriod : last
}

/** Release one source's due months inside `tx` (advisory-locked). Throws on a refusal. */
async function releaseSourceTx(
  tx: Prisma.TransactionClient,
  sourceType: PrepaidSourceType,
  sourceId: string,
  through: string,
  postedBy: string,
): Promise<{ released: number; cents: number }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`prepaid_release:${sourceType}:${sourceId}`}))`
  const src = await loadSource(tx, sourceType, sourceId)
  if (!src) return { released: 0, cents: 0 }
  const done = await tx.prepaidRelease.findMany({
    where: { tenantId: src.tenantId, sourceType, sourceId, reversedAt: null },
    select: { period: true, amountCents: true },
  })
  const donePeriods = new Set(done.map((r) => r.period))
  let releasedSoFar = done.reduce((t, r) => t + toCents(r.amountCents), 0)
  let released = 0
  let cents = 0
  for (const m of releaseSchedule(src.totalCents, src.coversFrom, src.coversMonths)) {
    if (periodIndex(m.period) > periodIndex(through)) break
    if (donePeriods.has(m.period)) continue
    const amount = Math.min(m.amountCents, src.totalCents - releasedSoFar)
    if (amount <= 0) continue
    if (!src.debitCode) {
      throw new AppError('CATEGORY_NOT_MAPPED', `Say which expense account "${src.label}" is booked to before its prepayment can be released`, 422)
    }
    const d = await lateDatingFor(tx, src.tenantId, lastDayPkt(m.period))
    if ('lockedThroughToday' in d) {
      throw new AppError('BOOKS_CLOSED_TODAY', 'The books are closed through today — nothing can post until a month is open', 409)
    }
    const memo = `${src.label} — ${m.period} share of the prepayment`.slice(0, 250)
    const body = withLateNote(`Prepayment released: ${src.label} (${m.period})`, [
      { accountCode: src.debitCode, type: 'debit', amountCents: amount, memo, conceptId: src.conceptId },
      { accountCode: PREPAID, type: 'credit', amountCents: amount, memo, conceptId: src.conceptId },
    ], d.memoNote)
    await syncSourcePosting({
      tenantId: src.tenantId,
      sourceType: PREPAID_RELEASE_SOURCE,
      id: releaseKey(sourceType, sourceId, m.period),
      desired: { description: body.description, entryDate: d.entryDate, lines: body.lines },
      postedBy,
      reason: 'Prepaid release changed',
      tx,
      keepLiveDate: true,
    })
    await tx.prepaidRelease.create({
      data: {
        tenantId: src.tenantId, sourceType, sourceId, period: m.period, amountCents: amount,
        postedPeriod: d.memoNote ? periodOfPkt(d.entryDate) : null,
      },
    })
    releasedSoFar += amount
    released += 1
    cents += amount
  }
  return { released, cents }
}

/**
 * Release one source through `throughPeriod` (the backfill's re-poster and
 * the per-source fix). Throws when the posting is refused.
 */
export async function releaseSourceThrough(
  sourceType: PrepaidSourceType,
  sourceId: string,
  throughPeriod: string,
  o: { postedBy?: string } = {},
): Promise<void> {
  if (!(PREPAID_SOURCE_TYPES as readonly string[]).includes(sourceType)) throw new AppError('BAD_SOURCE', `Unknown prepaid source "${sourceType}"`, 422)
  const through = capThrough(throughPeriod)
  await serviceClient.$transaction((tx) => releaseSourceTx(tx, sourceType, sourceId, through, o.postedBy ?? 'system'), TX_OPTS)
}

/**
 * Release every scheduled prepayment of `tenantId` through `throughPeriod`
 * (capped at the last completed month). Each source in its own transaction;
 * a refusal flags 'prepaid.release' for that payment and the run carries on.
 */
export async function releasePrepaidThrough(
  tenantId: string,
  throughPeriod: string,
  o: { postedBy?: string } = {},
): Promise<{ released: number; cents: number }> {
  const through = capThrough(throughPeriod)
  let released = 0
  let cents = 0
  for (const s of await sourcesOf(serviceClient, tenantId)) {
    try {
      const r = await serviceClient.$transaction((tx) => releaseSourceTx(tx, s.sourceType, s.sourceId, through, o.postedBy ?? 'system'), TX_OPTS)
      released += r.released
      cents += r.cents
    } catch (err) {
      await flagPostingFailed({
        tenantId,
        sourceType: PREPAID_RELEASE_SOURCE,
        sourceId: s.sourceId,
        entityType: ENTITY_OF[s.sourceType],
        entityId: s.sourceId,
        reason: (err as Error).message ?? String(err),
        title: 'A prepayment release did not post',
        metadata: { prepaidSourceType: s.sourceType, throughPeriod: through },
      })
    }
  }
  return { released, cents }
}

/** Covered months up to `throughPeriod` that have no release yet, per company. */
export async function unreleasedPrepaid(
  db: CloseCheckDb,
  tenantId: string,
  throughPeriod: string,
): Promise<Array<{ sourceType: PrepaidSourceType; sourceId: string; label: string; periods: string[]; cents: number }>> {
  const out: Array<{ sourceType: PrepaidSourceType; sourceId: string; label: string; periods: string[]; cents: number }> = []
  for (const s of await sourcesOf(db, tenantId)) {
    const src = await loadSource(db, s.sourceType, s.sourceId)
    if (!src) continue
    const done = new Set((await db.prepaidRelease.findMany({
      where: { tenantId, sourceType: s.sourceType, sourceId: s.sourceId, reversedAt: null },
      select: { period: true },
    })).map((r) => r.period))
    const missing = releaseSchedule(src.totalCents, src.coversFrom, src.coversMonths)
      .filter((m) => periodIndex(m.period) <= periodIndex(throughPeriod) && !done.has(m.period))
    if (missing.length > 0) {
      out.push({ ...s, label: src.label, periods: missing.map((m) => m.period), cents: missing.reduce((t, m) => t + m.amountCents, 0) })
    }
  }
  return out
}

/** Period close: a covered month inside the close with no release blocks it (fix: run the release). */
export const prepaidCloseChecks: CloseCheck[] = [
  {
    key: 'prepaid_release',
    severity: 'block',
    overridable: true,
    async run(ctx) {
      const through = periodOfPkt(ctx.newLock)
      const rows = await unreleasedPrepaid(ctx.db, ctx.tenantId, through)
      if (rows.length === 0) return null
      const months = [...new Set(rows.flatMap((r) => r.periods))].sort()
      const cents = rows.reduce((t, r) => t + r.cents, 0)
      return {
        key: 'prepaid_release',
        severity: 'block',
        title: 'Prepaid rent not released',
        detail: `${rows.length} prepayment${rows.length === 1 ? '' : 's'} still hold${rows.length === 1 ? 's' : ''} PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })} `
          + `for months up to ${through} (${months.join(', ')}). Release them so each month carries its own rent.`,
        count: rows.length,
        cents,
        months,
        link: '/finance/capex',
        fix: { method: 'POST', path: '/finance/prepaid-releases', label: 'Release prepaid rent' },
        overridable: true,
      }
    },
  },
]

/**
 * Legacy CapEx prepayments the engine cannot release: paid, on the books as
 * Dr 1310, with no months given (before PREPAID_TERM_REQUIRED) and not moved
 * to deposits. The nightly worker raises 'capex_prepaid_unscheduled' for
 * each (de-duplicated); finance adds the months on the payment (PATCH
 * coversFrom / coversMonths) and the next run releases it.
 */
export async function unscheduledCapexPrepaids(
  tenantId: string,
  db: Db = serviceClient,
): Promise<Array<{ paymentId: string; label: string; heldCents: number }>> {
  const rows = await db.capexPayment.findMany({
    where: { paidAt: { not: null }, OR: [{ coversFrom: null }, { coversMonths: null }], line: { project: { tenantId } } },
    select: { id: true, line: { select: { item: true, project: { select: { name: true } } } } },
  })
  const out: Array<{ paymentId: string; label: string; heldCents: number }> = []
  for (const r of rows) {
    if ((await liveRevision(tenantId, 'capex.deposit_reclass', r.id, db)).live) continue
    const held = live1310((await liveRevision(tenantId, CAPEX_PAYMENT_SOURCE, r.id, db)).live?.lines)
    if (held > 0) out.push({ paymentId: r.id, label: `${r.line.project.name}: ${r.line.item}`, heldCents: held })
  }
  return out
}
