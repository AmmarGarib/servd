// Backfill of order / refund / loyalty postings the ledger refused (BOOKS-R2-01).
//
// The till close was the only posting POST /reconciliation/backfill-unposted
// could re-post. An online order completed while its day was locked was filed
// with the fiscal POS but never reached the ledger, and its loyalty earn
// never reached 2060 — with nothing to re-post them once the period was
// reopened. This re-posts, per company (the caller's scope), idempotently:
//
//   1. order.complete — a completed (or since refunded) order whose completion
//      ran (the 'order.complete' claim, or an open posting_failed flag) and
//      has no 'order.complete:<id>' entry. Posted by postOrderCompletion, dated
//      the completion as always.
//   2. loyalty.earn / loyalty.redeem — a points transaction (not reversed)
//      with no entry in any company's books. Earns before redeems before
//      refunds, so a refund's reversal finds the original it mirrors. An
//      open loyalty flag whose transaction was reversed before it was ever
//      booked (or has since been booked) is resolved — nothing to post.
//   3. order.refund — an order whose refund / cancel restores were refused
//      (an open posting_failed flag from postRefundOrFlag): postOrderRefund
//      re-runs; every restore it makes is claimed, so a re-run moves nothing
//      twice.
//   4. Other refused postings (finance gap 8) — the open posting_failed flags
//      of a bank deposit, a manual waste, a stock count, a line voided after
//      firing (incl. the older void-waste flags with no sourceType), a
//      cancelled ticket's unwind and a till card failed after its close. See
//      REPOSTERS below.
//
// Steps 1-3: locks are respected — a posting dated inside a closed period is
// listed as 'locked' (reopen the period to post it into its own day) and
// never posted into the closed month or moved to another date. Step 4 (none
// of them is a sale or a tax posting) follows owner decision 6 like the shift
// backfill: its own date while that month is open, else the CURRENT open
// month with a note naming the original date. The dry run (the default)
// lists what would happen; nothing is written. A posting that lands resolves
// its open posting_failed flag.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { fmtPktDate, parsePktStartOfDay } from '../accounting/dates.js'
import { flagPostingFailed, resolvePostingFailed, type RepostOptions } from '../accounting/journal.js'
import { postOrderCompletion, postOrderRefund, isShiftReceipt, giftCardAppliedOf } from '../accounting/orderPosting.js'
import { postLoyaltyEarn, postLoyaltyRedeem } from '../accounting/loyaltyPosting.js'
import { calculatePointsValue } from '../../lib/loyaltySettings.js'

/** Step 4's kinds: the flag's metadata.sourceType, which is also the entry's key prefix. */
export type RefusedPostingKind = 'deposit.drop' | 'inventory.waste' | 'inventory.count' | 'pos.void_waste' | 'order.cancel_unwind' | 'pos.card_failed' | 'reservation.deposit_capture'
export type OrderBackfillKind = 'order.complete' | 'loyalty.earn' | 'loyalty.redeem' | 'order.refund' | RefusedPostingKind

export interface OrderBackfillRow {
  kind:      OrderBackfillKind
  id:        string            // the order id, the loyalty transaction id, or (step 4) the document's id
  orderId:   string | null
  tenantId:  string
  date:      string | null     // the date the entry is (or would be) posted on
  // would_post | would_post_into_current_month | posted | posted_into_current_month | locked
  // | already_posted | would_resolve | resolved | unflagged | flagged | no_company | <reason> | error
  outcome:   string
  detail:    string
}

const OPEN_FLAG = ['open', 'acknowledged'] as const

// ─── One real run per company at a time (RB-1) ──────────────────────────────
//
// Two tabs, a double-click or two CEOs used to run the backfill side by side
// and post every completion and earn twice. postJournalEntry now serialises
// every posting on (company, reference), so a race can no longer duplicate an
// entry — this guard is the operator-facing half: a second real run for a
// company already being backfilled is refused with 409 BACKFILL_RUNNING
// instead of waiting on the first run's locks. (One API process in prod; the
// posting lock is what keeps the books right across processes.)
const running = new Set<string>()

export class BackfillRunningError extends Error {
  constructor() { super('A backfill is already running for this company — wait for it to finish, then run it again.') }
}

/** Run `fn` holding the backfill slot of every company in `tenantIds`; throws BackfillRunningError if any is taken. */
export async function withBackfillSlot<T>(tenantIds: string[], fn: () => Promise<T>): Promise<T> {
  if (tenantIds.some((t) => running.has(t))) throw new BackfillRunningError()
  for (const t of tenantIds) running.add(t)
  try {
    return await fn()
  } finally {
    for (const t of tenantIds) running.delete(t)
  }
}

export async function backfillUnpostedOrders(opts: {
  tenantIds: string[]
  dryRun: boolean
  /** The operator running it — stamped on a posting moved into the open month. */
  postedBy?: string
  /** Step 4's sweep for misses nothing flagged: from this instant (default UNFLAGGED_SWEEP_FROM). */
  sweepFrom?: Date
}): Promise<{ rows: OrderBackfillRow[]; summary: Record<string, number> }> {
  const rows: OrderBackfillRow[] = []
  if (opts.tenantIds.length === 0) return { rows, summary: {} }
  const tenantIds = opts.tenantIds

  const locks = new Map<string, Date | null>()
  const lockedThrough = async (tenantId: string) => {
    if (!locks.has(tenantId)) {
      const lock = await prisma.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
      locks.set(tenantId, lock?.lockedThrough ?? null)
    }
    return locks.get(tenantId) ?? null
  }
  const lockedRow = async (tenantId: string, at: Date): Promise<string | null> => {
    const lock = await lockedThrough(tenantId)
    return lock && at <= lock
      ? `dated ${fmtPktDate(at)}, but books are closed through ${fmtPktDate(lock)} — reopen the period to post it into its own day`
      : null
  }

  // ── 1. Order completions ───────────────────────────────────────────────────
  const completions = await prisma.$queryRaw<Array<{ id: string; tenantId: string }>>`
    SELECT o.id, c."tenantId"
      FROM orders o
      JOIN concepts c ON c.id = o."conceptId"
     WHERE c."tenantId" = ANY(${tenantIds}::text[])
       AND o.status::text IN ('completed', 'refunded')
       AND o."deletedAt" IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM journal_entries j
              WHERE j."tenantId" = c."tenantId" AND j.reference = 'order.complete:' || o.id)
       AND (EXISTS (
             SELECT 1 FROM audit_logs a
              WHERE a.entity = 'Order' AND a."entityId" = o.id AND a.action = 'order.complete')
         OR EXISTS (
             SELECT 1 FROM exception_flags f
              WHERE f.kind = 'posting_failed' AND f."entityType" = 'Order' AND f."entityId" = o.id
                AND f.status::text IN ('open', 'acknowledged')
                AND f.metadata->>'sourceType' = 'order.complete'))
     ORDER BY o."completedAt" ASC NULLS LAST`
  for (const c of completions) {
    const order = await prisma.order.findUnique({
      where: { id: c.id },
      select: {
        id: true, source: true, completedAt: true, totalCents: true, walletAmountCents: true,
        payments: { select: { shiftId: true, method: true, status: true, gatewayRef: true } },
        giftCardRedemptions: { select: { amountCents: true } },
      },
    })
    if (!order) continue
    // The same "nothing to post" cases as postOrderCompletion: a till sale is
    // booked by its drawer's close, a zero-value order books nothing.
    const card = giftCardAppliedOf(order.giftCardRedemptions)
    if (order.source === 'pos' && (order.payments.some((p) => !!p.shiftId && isShiftReceipt(p)) || card <= 0)) continue
    if (order.totalCents <= 0 && order.walletAmountCents <= 0 && card <= 0) continue
    const at = order.completedAt ?? new Date()
    const base = { kind: 'order.complete' as const, id: order.id, orderId: order.id, tenantId: c.tenantId, date: at.toISOString() }
    const locked = await lockedRow(c.tenantId, at)
    if (locked) { rows.push({ ...base, outcome: 'locked', detail: locked }); continue }
    if (opts.dryRun) { rows.push({ ...base, outcome: 'would_post', detail: `PKR ${(order.totalCents / 100).toFixed(2)}` }); continue }
    try {
      const r = await postOrderCompletion(order.id)
      if (r.posted || (!r.reason && r.entryId)) {
        await resolvePostingFailed('Order', order.id, 'order.complete', 'Posted by Reconciliation → Backfill unposted.')
      }
      rows.push({ ...base, outcome: r.posted ? 'posted' : (r.reason ?? 'already_posted'), detail: r.entryId ?? '' })
    } catch (err) {
      rows.push({ ...base, outcome: 'error', detail: (err as Error).message })
    }
  }

  // ── 2. Loyalty earns and redemptions ───────────────────────────────────────
  const loyalty = await prisma.$queryRaw<Array<{ id: string; type: 'earn' | 'redeem'; orderId: string | null; createdAt: Date; points: number; tenantId: string }>>`
    SELECT t.id, t.type::text AS type, t."orderId", t."createdAt", abs(t."pointsDelta")::int AS points, a."tenantId"
      FROM loyalty_transactions t
      JOIN loyalty_accounts a ON a.id = t."loyaltyAccountId"
     WHERE a."tenantId" = ANY(${tenantIds}::text[])
       AND t."reversedAt" IS NULL
       AND ((t.type::text = 'earn' AND t."pointsDelta" > 0) OR (t.type::text = 'redeem' AND t."pointsDelta" < 0))
       AND NOT EXISTS (
             SELECT 1 FROM journal_entries j
              WHERE j.reference = 'loyalty.' || t.type::text || ':' || t.id)
     ORDER BY CASE WHEN t.type::text = 'earn' THEN 0 ELSE 1 END, t."createdAt" ASC`
  for (const t of loyalty) {
    const kind = t.type === 'earn' ? 'loyalty.earn' as const : 'loyalty.redeem' as const
    const valueCents = await calculatePointsValue(t.points, t.tenantId)
    if (valueCents <= 0) continue   // points with no value book nothing
    const base = { kind, id: t.id, orderId: t.orderId, tenantId: t.tenantId, date: t.createdAt.toISOString() }
    const locked = await lockedRow(t.tenantId, t.createdAt)
    if (locked) { rows.push({ ...base, outcome: 'locked', detail: locked }); continue }
    if (opts.dryRun) { rows.push({ ...base, outcome: 'would_post', detail: `${t.points} pts = PKR ${(valueCents / 100).toFixed(2)}` }); continue }
    try {
      const r = kind === 'loyalty.earn' ? await postLoyaltyEarn(t.id) : await postLoyaltyRedeem(t.id)
      if (r.posted) {
        await resolvePostingFailed(t.orderId ? 'Order' : 'LoyaltyTransaction', t.orderId ?? t.id, kind, 'Posted by Reconciliation → Backfill unposted.')
      }
      rows.push({ ...base, outcome: r.posted ? 'posted' : (r.reason ?? 'already_posted'), detail: r.entryId ?? '' })
    } catch (err) {
      rows.push({ ...base, outcome: 'error', detail: (err as Error).message })
    }
  }

  // ── 2b. Loyalty flags with nothing left to post (RB-6) ─────────────────────
  // An earn (or redeem) refused under a lock, then reversed by a cancel or
  // refund before it was ever booked, nets to zero in the books — the
  // reversal answered original_not_booked, correctly — but its posting_failed
  // flag stayed open for good: the query above skips reversed transactions.
  // Close those flags (and any whose posting has since landed).
  const loyaltyFlags = await prisma.exceptionFlag.findMany({
    where: {
      kind: 'posting_failed', status: { in: [...OPEN_FLAG] }, tenantId: { in: tenantIds },
      OR: [
        { metadata: { path: ['sourceType'], equals: 'loyalty.earn' } },
        { metadata: { path: ['sourceType'], equals: 'loyalty.redeem' } },
      ],
    },
    select: { id: true, entityId: true, metadata: true },
  })
  for (const f of loyaltyFlags) {
    const m = (f.metadata ?? {}) as { sourceType?: string; sourceId?: string }
    if (!m.sourceId || (m.sourceType !== 'loyalty.earn' && m.sourceType !== 'loyalty.redeem')) continue
    const kind: OrderBackfillKind = m.sourceType
    const t = await prisma.loyaltyTransaction.findUnique({
      where:  { id: m.sourceId },
      select: { id: true, orderId: true, reversedAt: true, createdAt: true, loyaltyAccount: { select: { tenantId: true } } },
    })
    // Only this caller's companies' transactions (the flag's company is the
    // account's, or the brand's when the account had none).
    if (t && t.loyaltyAccount.tenantId && !tenantIds.includes(t.loyaltyAccount.tenantId)) continue
    const booked = t ? await prisma.journalEntry.findFirst({ where: { reference: `${kind}:${t.id}` }, select: { id: true } }) : null
    let resolution: string | null = null
    if (booked) resolution = 'Posted — the entry is on the books.'
    else if (!t) resolution = 'The points transaction no longer exists — nothing to post.'
    else if (t.reversedAt) resolution = 'Reversed before it was booked — nothing to post.'
    if (!resolution) continue    // still owed: listed (and posted) by step 2
    const base = { kind, id: m.sourceId, orderId: t?.orderId ?? null, tenantId: t?.loyaltyAccount.tenantId ?? tenantIds[0]!, date: t?.createdAt.toISOString() ?? null }
    if (opts.dryRun) { rows.push({ ...base, outcome: 'would_resolve', detail: resolution }); continue }
    await prisma.exceptionFlag.update({
      where: { id: f.id },
      data:  { status: 'resolved', resolvedAt: new Date(), resolution },
    }).catch(() => {})
    rows.push({ ...base, outcome: 'resolved', detail: resolution })
  }

  // ── 3. Refund / cancel restores that were refused ─────────────────────────
  const refundFlags = await prisma.exceptionFlag.findMany({
    where: {
      kind: 'posting_failed', entityType: 'Order', status: { in: [...OPEN_FLAG] },
      metadata: { path: ['sourceType'], equals: 'order.refund' },
    },
    select: { entityId: true },
  })
  const refundIds = Array.from(new Set(refundFlags.map((f) => f.entityId).filter((x): x is string => !!x)))
  const refundOrders = refundIds.length === 0 ? [] : await prisma.order.findMany({
    where: { id: { in: refundIds }, concept: { tenantId: { in: tenantIds } } },
    select: { id: true, status: true, concept: { select: { tenantId: true } } },
  })
  for (const o of refundOrders) {
    const tenantId = o.concept.tenantId!
    const terminal = o.status === 'refunded' || o.status === 'cancelled' || o.status === 'rejected'
    const base = { kind: 'order.refund' as const, id: o.id, orderId: o.id, tenantId, date: new Date().toISOString() }
    if (!terminal) { rows.push({ ...base, outcome: 'not_refunded', detail: `order is ${o.status}` }); continue }
    // Restores are dated now — the open period (today can never be locked).
    if (opts.dryRun) { rows.push({ ...base, outcome: 'would_post', detail: `order ${o.status}` }); continue }
    try {
      const results = await postOrderRefund(o.id, `Order ${o.status} (backfill)`, { bookWalletRestore: o.status === 'refunded' })
      const failed = results.filter((r) => !r.posted && r.reason && !['sale_booked_without_gift_card', 'original_not_booked', 'tx_not_found', 'not_reversible', 'order_not_found'].includes(r.reason))
      if (failed.length > 0) {
        rows.push({ ...base, outcome: 'error', detail: failed.map((f) => f.reason).join('; ') })
      } else {
        await resolvePostingFailed('Order', o.id, 'order.refund', 'Posted by Reconciliation → Backfill unposted.')
        rows.push({ ...base, outcome: 'posted', detail: `${results.filter((r) => r.posted).length} entr${results.filter((r) => r.posted).length === 1 ? 'y' : 'ies'}` })
      }
    } catch (err) {
      rows.push({ ...base, outcome: 'error', detail: (err as Error).message })
    }
  }

  // ── 4. Other refused postings (deposits, waste, counts, voids, …) ─────────
  rows.push(...await backfillRefusedPostings({
    tenantIds, dryRun: opts.dryRun, postedBy: opts.postedBy, lockedThrough,
    sweepFrom: opts.sweepFrom ?? parsePktStartOfDay(UNFLAGGED_SWEEP_FROM),
  }))

  const summary: Record<string, number> = {}
  for (const r of rows) summary[`${r.kind}:${r.outcome}`] = (summary[`${r.kind}:${r.outcome}`] ?? 0) + 1
  return { rows, summary }
}

// ─── 4. Other refused postings (finance gap 8) ──────────────────────────────
//
// A bank deposit, a manual waste and a stock count posted after their commit
// and only logged a refusal; a line voided after firing raised a flag whose
// text asked for a hand-made journal (which would not carry the posting's
// key, so any later re-post would book it twice); a cancelled ticket's unwind
// and a till card failed after its close were console-only. Each now raises
// ONE posting_failed flag (flagPostingFailed) in the document's company, and
// this step re-posts it through the posting's OWN poster — the same entry and
// key as the live path, so nothing books twice:
//
//   • open flags of the caller's companies only, and only when the document
//     itself is of one of them (another company's document is never touched);
//   • already on that company's books → the flag is closed;
//   • nothing owed any more (no amount, no variance, the card is no longer
//     failed, …) → the flag is closed with why;
//   • otherwise posted on the document's own date while that month is open,
//     else into the current open month with a memo naming the original date
//     (owner decision 6 — none of these is a sale or a tax posting). The
//     unwind and the card failure have no date of their own: they post today,
//     as their live path does (like step 3's restores). Books closed even
//     through today → listed 'locked', nothing posted.
//
// The dry run also sweeps for misses nothing flagged — a crash between the
// commit and the post, or a refusal from before these flags existed: bank
// deposits, non-void waste and stock counts since UNFLAGGED_SWEEP_FROM with a
// value and no entry in their company. They are listed ('unflagged'), never
// posted straight away: one may have been booked by hand meanwhile. A real
// run raises their flag ('flagged'), so they show in the company's inbox — a
// flag closed there (booked by hand) is never posted; one left open posts on
// the next run.

/** The earliest day the waste posting is in this code's history (2026-09-18). */
export const UNFLAGGED_SWEEP_FROM = '2026-09-18'
/** Deposit drops were first posted on 2026-09-25 (6a2d423) and stock counts on
 *  2026-10-10 (3f4a720): anything older was never meant to have an entry (it
 *  reached the books by hand, if at all), so the sweep never offers it. */
const DEPOSIT_POSTING_FROM = '2026-09-25'
const COUNT_POSTING_FROM = '2026-10-10'

// Exported (wave B) for the other backfills that place a refused or missing
// posting the same way — the petty-cash history backfill reuses placeAndPost
// and withBackfillSlot rather than a second copy of owner decision 6.
export type RepostResult = { posted: boolean; entryId: string | null; reason?: string }

export interface RefusedDoc {
  /** The document's company — the books it posts to. Null → it cannot post. */
  tenantId:    string | null
  /** Its own date; null → the poster dates it today (the unwind, the card failure). */
  date:        Date | null
  orderId:     string | null
  /** Plain words for the row's detail. */
  what:        string
  amountCents: number | null
  /** Set when nothing is owed any more: the flag is closed with this. */
  nothingOwed?: string
  post:        (opts: RepostOptions) => Promise<RepostResult>
}

export interface FlagRow { id: string; tenantId: string | null; entityType: string | null; entityId: string | null; metadata: Prisma.JsonValue; createdAt: Date }

export interface Reposter {
  /** The flag's entityType (its entityId is the sourceId). */
  entityType:    string
  /** The sweep's flag title. */
  title:         string
  /** Poster reasons meaning there is nothing to post — the flag is closed. */
  nothingToPost: ReadonlySet<string>
  load:          (sourceId: string, flag: FlagRow | null) => Promise<RefusedDoc | null>
}

const pkr = (cents: number | null | undefined) => `PKR ${((cents ?? 0) / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function metaOf(v: Prisma.JsonValue): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

const REPOSTERS: Record<RefusedPostingKind, Reposter> = {
  'deposit.drop': {
    entityType: 'DepositDrop',
    title: 'Bank deposit did not reach the ledger',
    nothingToPost: new Set(['deposit_not_found', 'no_amount']),
    load: async (id) => {
      const d = await prisma.depositDrop.findUnique({ where: { id }, select: { id: true, tenantId: true, droppedAt: true, amountCents: true, bagSerial: true } })
      if (!d) return null
      const { postDepositDrop } = await import('../accounting/depositPosting.js')
      return {
        tenantId: d.tenantId, date: d.droppedAt, orderId: null, amountCents: d.amountCents,
        what: `Bank deposit ${pkr(d.amountCents)}${d.bagSerial ? ` (bag ${d.bagSerial})` : ''}`,
        nothingOwed: d.amountCents <= 0 ? 'The deposit has no amount — nothing to post.' : undefined,
        post: (o) => postDepositDrop(id, o),
      }
    },
  },
  'inventory.waste': {
    entityType: 'WasteLog',
    title: 'Waste did not reach the ledger',
    nothingToPost: new Set(['waste_log_not_found', 'zero_cost', 'booked_by_void']),
    load: async (id) => {
      const w = await prisma.wasteLog.findUnique({
        where: { id },
        select: { id: true, reason: true, quantity: true, unit: true, recordedAt: true, estimatedCostCents: true, inventoryItem: { select: { name: true, tenantId: true, unitCostCents: true } } },
      })
      if (!w) return null
      const { postWasteLog } = await import('../accounting/supplierPosting.js')
      // The same value postWasteLog books.
      const cost = w.estimatedCostCents ?? Math.round((w.inventoryItem.unitCostCents ?? 0) * w.quantity)
      return {
        tenantId: w.inventoryItem.tenantId, date: w.recordedAt, orderId: null, amountCents: cost,
        what: `Waste: ${w.quantity} ${w.unit} ${w.inventoryItem.name} (${w.reason}), ${pkr(cost)}`,
        nothingOwed: w.reason === 'void_after_fire'
          ? 'Booked with its voided line (pos.void_waste) — nothing to post here.'
          : cost <= 0 ? 'The waste has no cost on file — nothing to post.' : undefined,
        post: (o) => postWasteLog(id, o),
      }
    },
  },
  'inventory.count': {
    entityType: 'PhysicalCount',
    title: 'Stock count adjustment did not reach the ledger',
    nothingToPost: new Set(['count_not_found', 'no_variance']),
    load: async (id) => {
      const c = await prisma.physicalCount.findUnique({ where: { id }, select: { id: true, tenantId: true, countedAt: true } })
      if (!c) return null
      const { postStockCount, stockCountAdjustment } = await import('../crosschecks/countPosting.js')
      // Valued at today's moving-average cost, as postStockCount values it.
      const adj = await stockCountAdjustment(id)
      const valued = adj.ok ? adj.shortCents + adj.overCents : 0
      return {
        tenantId: c.tenantId, date: c.countedAt, orderId: null, amountCents: adj.ok ? adj.shortCents - adj.overCents : null,
        what: adj.ok ? `Stock count: short ${pkr(adj.shortCents)}, over ${pkr(adj.overCents)}` : 'Stock count',
        nothingOwed: adj.ok && valued === 0 ? 'The count found no difference with a cost on file — nothing to post.' : undefined,
        post: (o) => postStockCount(id, o),
      }
    },
  },
  'pos.void_waste': {
    entityType: 'OrderItem',
    title: 'Waste from a voided line did not reach the ledger',
    nothingToPost: new Set(['order_item_not_found', 'zero_cost']),
    load: async (orderItemId, flag) => {
      const line = await prisma.orderItem.findUnique({
        where: { id: orderItemId },
        select: { id: true, name: true, quantity: true, order: { select: { id: true, conceptId: true, concept: { select: { tenantId: true } } } } },
      })
      if (!line) return null
      const ids = metaOf(flag?.metadata ?? null)['wasteLogIds']
      const wasteLogIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
      const { postVoidWaste, VOID_WASTE_REASON } = await import('../inventory/voidWaste.js')
      const logs = wasteLogIds.length === 0 ? [] : await prisma.wasteLog.findMany({
        // The logs postVoidWaste books: this line's void-after-fire waste.
        where: { id: { in: wasteLogIds }, reason: VOID_WASTE_REASON, notes: { contains: orderItemId } },
        select: { recordedAt: true, estimatedCostCents: true },
      })
      const tenantId = line.order.concept.tenantId
      const cost = logs.reduce((t, l) => t + Math.max(0, l.estimatedCostCents ?? 0), 0)
      // The void's own time: when its waste was logged (the same transaction).
      const date = logs.length > 0 ? new Date(Math.min(...logs.map((l) => +l.recordedAt))) : (flag?.createdAt ?? new Date())
      return {
        tenantId, date, orderId: line.order.id, amountCents: cost,
        what: `Voided after firing: ${line.quantity} × ${line.name}, ${pkr(cost)}`,
        nothingOwed: logs.length === 0
          ? 'The flag names no waste logs of this line — nothing to post; check the void by hand.'
          : cost <= 0 ? 'The waste has no cost on file — nothing to post.' : undefined,
        post: (o) => tenantId
          ? postVoidWaste(tenantId, orderItemId, wasteLogIds, line.order.conceptId, o)
          : Promise.resolve({ posted: false, entryId: null, reason: 'no_company' }),
      }
    },
  },
  'order.cancel_unwind': {
    entityType: 'Order',
    title: 'A cancelled order\'s earlier sale booking was not undone in the ledger',
    nothingToPost: new Set(['nothing_to_undo']),
    load: async (orderId) => {
      const o = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, totalCents: true, concept: { select: { tenantId: true } } },
      })
      if (!o) return null
      const { postCancelledTicketUnwind } = await import('../pos/service.js')
      const cancelled = o.status === 'cancelled' || o.status === 'rejected'
      return {
        tenantId: o.concept.tenantId, date: null, orderId: o.id, amountCents: o.totalCents,
        what: `Cancelled order: what was booked as a sale before the cancel, undone`,
        nothingOwed: cancelled ? undefined : `The order is ${o.status}, not cancelled — nothing to undo.`,
        // Idempotent on the order and takes its lock; dated today, as live.
        post: async (opts) => {
          const entryId = await postCancelledTicketUnwind(orderId, opts.postedBy ?? 'system')
          return entryId ? { posted: true, entryId } : { posted: false, entryId: null, reason: 'nothing_to_undo' }
        },
      }
    },
  },
  'pos.card_failed': {
    entityType: 'Payment',
    title: 'A till card failed after its drawer closed did not reach the ledger',
    nothingToPost: new Set(['payment_not_found', 'not_a_failed_till_card', 'not_a_till_payment', 'shift_not_posted']),
    load: async (paymentId, flag) => {
      const { shiftTenantId, SHIFT_COMPANY_INCLUDE } = await import('../../lib/tenantScope.js')
      const p = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: {
          id: true, status: true, amountCents: true, orderId: true,
          shift: { select: { id: true, tenantId: true, locationId: true, ...SHIFT_COMPANY_INCLUDE } },
        },
      })
      if (!p) return null
      const tenantId = p.shift ? shiftTenantId(p.shift) : null
      const close = tenantId && p.shift
        ? await prisma.journalEntry.findFirst({ where: { tenantId, reference: `shift.close:${p.shift.id}` }, select: { createdAt: true } })
        : null
      // The close booked the card as received (1030) only if it was posted
      // BEFORE the card failed (the flag is raised as it fails). A close
      // booked later left the failed card out — it is already owed (1110).
      let nothingOwed: string | undefined
      if (p.status !== 'failed') nothingOwed = `The payment is ${p.status}, no longer failed — nothing to move.`
      else if (!close) nothingOwed = 'Its drawer is not on the books yet — the close books the failed card as owed by the customer.'
      else if (flag && close.createdAt >= flag.createdAt) nothingOwed = 'Its drawer was booked after the card failed, so the close already holds it as owed by the customer.'
      const { postPosCardFailure } = await import('../accounting/shiftPosting.js')
      return {
        tenantId, date: null, orderId: p.orderId, amountCents: p.amountCents,
        what: `Card ${pkr(p.amountCents)} failed after the drawer closed: moved to the customer's account (Dr 1110 / Cr 1030)`,
        nothingOwed,
        post: () => postPosCardFailure(paymentId),
      }
    },
  },
  'reservation.deposit_capture': {
    entityType: 'Reservation',
    title: 'A no-show deposit was not captured in the ledger',
    nothingToPost: new Set(['no-deposit', 'already-no-show']),
    load: async (reservationId, flag) => {
      const r = await prisma.reservation.findUnique({
        where: { id: reservationId },
        select: { id: true, depositCents: true, guestName: true, concept: { select: { tenantId: true } } },
      })
      if (!r) return null
      const { captureReservationDeposit } = await import('../reservations/depositCapture.js')
      // The capture failed as the no-show was recorded (the flag's time); the
      // deposit is still held then, and capturing is idempotent on the hold.
      const at = flag?.createdAt ?? null
      return {
        tenantId: r.concept.tenantId, date: at, orderId: null, amountCents: r.depositCents,
        what: `No-show deposit ${pkr(r.depositCents)} (${r.guestName})`,
        nothingOwed: r.depositCents <= 0 ? 'No deposit is held any more (released or already captured) — nothing to post.' : undefined,
        post: async (o) => {
          const res = await captureReservationDeposit({ reservationId, postedBy: o.postedBy ?? 'system', noShowAt: o.entryDate ?? at ?? new Date(), memoNote: o.memoNote })
          return res.captured ? { posted: true, entryId: null } : { posted: false, entryId: null, reason: res.reason }
        },
      }
    },
  },
}

const isRefusedKind = (k: unknown): k is RefusedPostingKind => typeof k === 'string' && Object.prototype.hasOwnProperty.call(REPOSTERS, k)

async function backfillRefusedPostings(opts: {
  tenantIds: string[]
  dryRun: boolean
  postedBy?: string
  lockedThrough: (tenantId: string) => Promise<Date | null>
  sweepFrom: Date
}): Promise<OrderBackfillRow[]> {
  const { tenantIds } = opts
  const rows: OrderBackfillRow[] = []
  const { VOID_WASTE_SOURCE } = await import('../inventory/voidWaste.js')
  const legacyVoidPrefix = `${VOID_WASTE_SOURCE}:`

  const flags: FlagRow[] = await prisma.exceptionFlag.findMany({
    where: {
      kind: 'posting_failed', status: { in: [...OPEN_FLAG] }, tenantId: { in: tenantIds },
      OR: [
        ...Object.keys(REPOSTERS).map((k) => ({ metadata: { path: ['sourceType'], equals: k } })),
        // Void-waste flags raised before they carried a sourceType.
        { entityType: 'OrderItem', metadata: { path: ['source'], string_starts_with: legacyVoidPrefix } },
      ],
    },
    select: { id: true, tenantId: true, entityType: true, entityId: true, metadata: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  // One posting per (kind, document); the oldest flag carries it.
  const owed = new Map<string, { kind: RefusedPostingKind; sourceId: string; flag: FlagRow; legacy: boolean }>()
  for (const f of flags) {
    const m = metaOf(f.metadata)
    let kind: RefusedPostingKind | null = isRefusedKind(m['sourceType']) ? m['sourceType'] : null
    let sourceId = typeof m['sourceId'] === 'string' ? m['sourceId'] : null
    let legacy = false
    if (!kind && typeof m['source'] === 'string' && m['source'].startsWith(legacyVoidPrefix)) {
      kind = VOID_WASTE_SOURCE
      sourceId = m['source'].slice(legacyVoidPrefix.length) || f.entityId
      legacy = true
    }
    // The flag must name the document its poster loads.
    if (!kind || !sourceId || f.entityType !== REPOSTERS[kind].entityType || f.entityId !== sourceId) continue
    const key = `${kind}:${sourceId}`
    if (!owed.has(key)) owed.set(key, { kind, sourceId, flag: f, legacy })
  }

  const close = async (kind: RefusedPostingKind, sourceId: string, resolution: string) =>
    resolvePostingFailed(REPOSTERS[kind].entityType, sourceId, kind, resolution, { tenantIds })

  for (const { kind, sourceId, flag, legacy } of owed.values()) {
    const r = REPOSTERS[kind]
    let doc: RefusedDoc | null
    try {
      doc = await r.load(sourceId, flag)
    } catch (err) {
      rows.push({ kind, id: sourceId, orderId: null, tenantId: flag.tenantId!, date: null, outcome: 'error', detail: (err as Error).message })
      continue
    }
    if (doc?.tenantId && !tenantIds.includes(doc.tenantId)) continue   // another company's document: never touched
    const tenantId = doc?.tenantId ?? flag.tenantId!
    const base = { kind, id: sourceId, orderId: doc?.orderId ?? null, tenantId }

    // Nothing left to post → close the flag.
    let resolution: string | null = null
    if (!doc) resolution = 'The document no longer exists — nothing to post.'
    else if (doc.tenantId && await prisma.journalEntry.findFirst({ where: { tenantId: doc.tenantId, reference: `${kind}:${sourceId}` }, select: { id: true } })) {
      resolution = 'Already on the books.'
    } else if (doc.nothingOwed) resolution = doc.nothingOwed
    if (resolution) {
      const date = doc?.date?.toISOString() ?? null
      if (opts.dryRun) { rows.push({ ...base, date, outcome: 'would_resolve', detail: resolution }); continue }
      await close(kind, sourceId, `${resolution} (Reconciliation → Backfill unposted)`)
      rows.push({ ...base, date, outcome: 'resolved', detail: resolution })
      continue
    }
    if (!doc!.tenantId) {
      rows.push({ ...base, date: doc!.date?.toISOString() ?? null, outcome: 'no_company', detail: `${doc!.what} — it belongs to no company, so there are no books to post it to.` })
      continue
    }
    // A void-waste flag raised before automatic re-posting told finance to
    // book Dr 5040 / Cr 1210 by hand — it may already have been. Never post
    // it straight away: re-raise it as a review flag (like the sweep), so a
    // person closes it if it was booked by hand; the next run posts it.
    if (legacy) {
      const date = doc!.date?.toISOString() ?? null
      const detail = `${doc!.what} — raised before automatic re-posting; its flag asked for a hand entry. Post re-raises it for review: close it if it was booked by hand, otherwise the next run posts it.`
      if (opts.dryRun) { rows.push({ ...base, date, outcome: 'unflagged', detail }); continue }
      const m = metaOf(flag.metadata)
      await close(kind, sourceId, 'Re-raised for review as an automatic re-post (Reconciliation → Backfill unposted).')
      await flagPostingFailed({
        tenantId: doc!.tenantId,
        sourceType: kind, sourceId,
        entityType: r.entityType, entityId: sourceId,
        reason: 'Raised before automatic re-posting, when it asked for a hand entry (Dr 5040 / Cr 1210). If that was booked by hand, close this flag; otherwise the next backfill run posts it.',
        title: r.title,
        actorId: opts.postedBy ?? null,
        amountCents: doc!.amountCents,
        metadata: { orderId: m['orderId'] ?? doc!.orderId, wasteLogIds: m['wasteLogIds'] ?? [] },
      })
      rows.push({ ...base, date, outcome: 'flagged', detail })
      continue
    }
    const row = await placeAndPost(doc!, doc!.tenantId, r, opts)
    if (row.resolve) await close(kind, sourceId, row.resolve)
    rows.push({ ...base, date: row.date, outcome: row.outcome, detail: row.detail })
  }

  // ── The sweep: misses nothing flagged ──────────────────────────────────────
  for (const miss of await unflaggedMisses(tenantIds, opts.sweepFrom)) {
    const r = REPOSTERS[miss.kind]
    const doc = await r.load(miss.id, null)
    if (!doc || !doc.tenantId || !tenantIds.includes(doc.tenantId) || doc.nothingOwed) continue
    const base = { kind: miss.kind, id: miss.id, orderId: null, tenantId: doc.tenantId, date: doc.date?.toISOString() ?? null }
    if (opts.dryRun) {
      rows.push({ ...base, outcome: 'unflagged', detail: `${doc.what} — no ledger entry and nothing flagged it. Post flags it for review; the next run posts it unless the flag is closed (e.g. it was booked by hand).` })
      continue
    }
    await flagPostingFailed({
      tenantId: doc.tenantId,
      sourceType: miss.kind, sourceId: miss.id,
      entityType: r.entityType, entityId: miss.id,
      reason: `No ledger entry found by Reconciliation → Backfill unposted (nothing flagged it at the time). If it was booked by hand, close this flag; otherwise the next backfill run posts it.`,
      title: r.title,
      actorId: opts.postedBy ?? null,
      amountCents: doc.amountCents,
    })
    rows.push({ ...base, outcome: 'flagged', detail: `${doc.what} — flagged for review; the next run posts it unless the flag is closed.` })
  }
  return rows
}

/**
 * Where a refused posting goes (owner decision 6) and, on a real run, posts it:
 * its own date while that month is open, else today with a note naming the
 * original date; nothing when the books are closed even through today.
 */
export async function placeAndPost(
  doc: RefusedDoc,
  tenantId: string,
  r: Reposter,
  opts: { dryRun: boolean; postedBy?: string; lockedThrough: (tenantId: string) => Promise<Date | null> },
): Promise<{ date: string; outcome: string; detail: string; resolve?: string }> {
  const now = new Date()
  const lock = await opts.lockedThrough(tenantId)
  if (lock && now <= lock) {
    return { date: (doc.date ?? now).toISOString(), outcome: 'locked', detail: `${doc.what} — the books are closed through ${fmtPktDate(lock)}, today included; nothing can post until today is open.` }
  }
  const late = !!doc.date && !!lock && doc.date <= lock
  const note = late ? `dated ${fmtPktDate(doc.date!)}, posted late into the open month (books closed through ${fmtPktDate(lock!)})` : undefined
  const date = (late || !doc.date ? now : doc.date).toISOString()
  if (opts.dryRun) {
    return { date, outcome: late ? 'would_post_into_current_month' : 'would_post', detail: late ? `${doc.what} — ${note}` : doc.what }
  }
  try {
    // On its own date it keeps the document's own actor; moved into the open
    // month, or a posting with no date of its own, the operator posts it.
    const res = await doc.post(
      late ? { entryDate: now, memoNote: note, postedBy: opts.postedBy }
        : doc.date ? { entryDate: doc.date }
        : { postedBy: opts.postedBy },
    )
    if (res.posted) {
      return { date, outcome: late ? 'posted_into_current_month' : 'posted', detail: res.entryId ?? '', resolve: 'Posted by Reconciliation → Backfill unposted.' }
    }
    if (res.entryId) return { date, outcome: 'already_posted', detail: res.entryId, resolve: 'Already on the books.' }
    if (res.reason && r.nothingToPost.has(res.reason)) {
      return { date, outcome: 'resolved', detail: `Nothing to post (${res.reason.replace(/_/g, ' ')}).`, resolve: `Nothing to post (${res.reason}) — Reconciliation → Backfill unposted.` }
    }
    return { date, outcome: 'error', detail: res.reason ?? 'not posted' }
  } catch (err) {
    return { date, outcome: 'error', detail: (err as Error).message }
  }
}

/**
 * Deposits, non-void waste and stock counts of `tenantIds` since `from` with
 * a value, no entry in their company and no posting_failed flag at all (an
 * open one is step 4's; a closed one was decided by a person).
 */
async function unflaggedMisses(tenantIds: string[], from: Date): Promise<Array<{ kind: 'deposit.drop' | 'inventory.waste' | 'inventory.count'; id: string }>> {
  const latest = (a: Date, b: Date) => (a > b ? a : b)
  const dropsFrom = latest(from, parsePktStartOfDay(DEPOSIT_POSTING_FROM))
  const countsFrom = latest(from, parsePktStartOfDay(COUNT_POSTING_FROM))
  const [drops, waste, counts] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT d.id FROM deposit_drops d
       WHERE d."tenantId" = ANY(${tenantIds}::text[]) AND d."amountCents" > 0 AND d."droppedAt" >= ${dropsFrom}
         AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j."tenantId" = d."tenantId" AND j.reference = 'deposit.drop:' || d.id)
         AND NOT EXISTS (SELECT 1 FROM exception_flags f WHERE f.kind = 'posting_failed' AND f."entityType" = 'DepositDrop' AND f."entityId" = d.id)
       ORDER BY d."droppedAt" ASC`,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT w.id FROM waste_logs w JOIN inventory_items i ON i.id = w."inventoryItemId"
       WHERE i."tenantId" = ANY(${tenantIds}::text[]) AND w.reason <> 'void_after_fire' AND w."recordedAt" >= ${from}
         AND COALESCE(w."estimatedCostCents", round(COALESCE(i."unitCostCents", 0) * w.quantity)) > 0
         AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j."tenantId" = i."tenantId" AND j.reference = 'inventory.waste:' || w.id)
         AND NOT EXISTS (SELECT 1 FROM exception_flags f WHERE f.kind = 'posting_failed' AND f."entityType" = 'WasteLog' AND f."entityId" = w.id)
       ORDER BY w."recordedAt" ASC`,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM physical_counts c
       WHERE c."tenantId" = ANY(${tenantIds}::text[]) AND c."countedAt" >= ${countsFrom}
         AND EXISTS (SELECT 1 FROM physical_count_lines l WHERE l."countId" = c.id AND l."physicalQty" <> l."systemQty")
         AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j."tenantId" = c."tenantId" AND j.reference = 'inventory.count:' || c.id)
         AND NOT EXISTS (SELECT 1 FROM exception_flags f WHERE f.kind = 'posting_failed' AND f."entityType" = 'PhysicalCount' AND f."entityId" = c.id)
       ORDER BY c."countedAt" ASC`,
  ])
  return [
    ...drops.map((d) => ({ kind: 'deposit.drop' as const, id: d.id })),
    ...waste.map((w) => ({ kind: 'inventory.waste' as const, id: w.id })),
    ...counts.map((c) => ({ kind: 'inventory.count' as const, id: c.id })),
  ]
}
