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
//
// Locks are respected: a posting dated inside a closed period is listed as
// 'locked' (reopen the period to post it into its own day) and never posted
// into the closed month or moved to another date. The dry run (the default)
// lists what would happen; nothing is written. A posting that lands resolves
// its open posting_failed flag.

import { prisma } from '../../lib/prisma.js'
import { fmtPktDate } from '../accounting/dates.js'
import { resolvePostingFailed } from '../accounting/journal.js'
import { postOrderCompletion, postOrderRefund, isShiftReceipt, giftCardAppliedOf } from '../accounting/orderPosting.js'
import { postLoyaltyEarn, postLoyaltyRedeem } from '../accounting/loyaltyPosting.js'
import { calculatePointsValue } from '../../lib/loyaltySettings.js'

export type OrderBackfillKind = 'order.complete' | 'loyalty.earn' | 'loyalty.redeem' | 'order.refund'

export interface OrderBackfillRow {
  kind:      OrderBackfillKind
  id:        string            // the order id, or the loyalty transaction id
  orderId:   string | null
  tenantId:  string
  date:      string | null     // the date the entry is (or would be) posted on
  outcome:   string            // would_post | posted | locked | already_posted | <reason> | error
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

export async function backfillUnpostedOrders(opts: { tenantIds: string[]; dryRun: boolean }): Promise<{ rows: OrderBackfillRow[]; summary: Record<string, number> }> {
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

  const summary: Record<string, number> = {}
  for (const r of rows) summary[`${r.kind}:${r.outcome}`] = (summary[`${r.kind}:${r.outcome}`] ?? 0) + 1
  return { rows, summary }
}
