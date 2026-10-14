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
//      cancelled ticket's unwind and a till card failed after its close — and
//      (finance wave B) depreciation, prepayment releases, ad-hoc prep draws,
//      gift-card breakage, shared-fleet recharges and the cost-of-sales moves
//      of an order's stock events after its cost was booked. See REPOSTERS.
//   5. Stock steps that failed (finance wave B) — open 'stock_restore_failed'
//      flags: an order's depletion, a cancelled order's give-back / waste, a
//      KDS remake's waste. Each re-runs its own once-only step (see
//      rerunStockFailures); nothing here posts by itself.
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
import { sumCents, toCents } from '../../lib/money.js'
import { STOCK_SOURCE } from '../../lib/stockLedger.js'
import { FLEET_CHARGE_ENTITY, FLEET_NOTHING_TO_POST, fleetChargeRefusedDoc } from '../intercompany/fleet.js'
import {
  ORDER_COGS_FIX_ENTITY, ORDER_COGS_FIX_NOTHING, ORDER_COGS_FIX_SOURCES, STOCK_DEPLETE, STOCK_RESTORE,
  bookRemakeWaste, ensureOrderDepleted, flagOrderStockFailure, orderCogsFixDoc, restoreInventoryForOrder,
  type OrderCogsFixSource,
} from '../orders/stock.js'

/** Step 4's kinds: the flag's metadata.sourceType, which is also the entry's key prefix. */
export type RefusedPostingKind = 'deposit.drop' | 'inventory.waste' | 'inventory.count' | 'pos.void_waste' | 'order.cancel_unwind' | 'pos.card_failed' | 'reservation.deposit_capture'
  // Finance wave B.
  | 'fixed_asset.depreciation' | 'prepaid.release' | 'inventory.prep_draw' | 'giftcard.expire' | 'ic.fleet_charge'
  // An order's cost of sales moved after its cost was booked (orders/stock.ts ORDER_COGS_FIX).
  | OrderCogsFixSource
/** Step 5's kinds: a stock step of an order that failed ('stock_restore_failed', by metadata.phase). */
export type StockRerunKind = 'stock.deplete' | 'stock.restore' | 'stock.remake'
export type OrderBackfillKind = 'order.complete' | 'loyalty.earn' | 'loyalty.redeem' | 'order.refund' | RefusedPostingKind | StockRerunKind

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

  // ── 5. Stock steps that failed (depletion, cancel give-back, remake) ──────
  rows.push(...await rerunStockFailures({
    tenantIds, dryRun: opts.dryRun, postedBy: opts.postedBy,
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
// A kind whose posting is several entries under other keys (one per month,
// '@n' revisions, a transfer's own key — `multiPost`) skips the lookup of
// '<kind>:<sourceId>' on the books: its load() alone says whether anything is
// still owed.
//
// The dry run also sweeps for misses nothing flagged — a crash between the
// commit and the post, or a refusal from before these flags existed: bank
// deposits, non-void waste, stock counts and ad-hoc prep draws since
// UNFLAGGED_SWEEP_FROM with a value and no entry in their company. They are listed ('unflagged'), never
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
  /** Other entityTypes the same kind's flags are raised on (prepaid.release: CapexPayment or OpexPayment). */
  entityTypes?:  readonly string[]
  /** The sweep's flag title. */
  title:         string
  /** Poster reasons meaning there is nothing to post — the flag is closed. */
  nothingToPost: ReadonlySet<string>
  /**
   * The posting is several entries under keys other than '<kind>:<sourceId>'
   * (one per month, '@n' revisions, a transfer's own key): the exact-reference
   * "Already on the books" check is skipped and load() decides nothingOwed.
   */
  multiPost?:    boolean
  load:          (sourceId: string, flag: FlagRow | null) => Promise<RefusedDoc | null>
}

const acceptsEntity = (r: Reposter, entityType: string | null): boolean =>
  !!entityType && (entityType === r.entityType || (r.entityTypes ?? []).includes(entityType))

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
        select: {
          id: true, tenantId: true, reason: true, quantity: true, unit: true, recordedAt: true, estimatedCostCents: true,
          inventoryItem: { select: { name: true, tenantId: true, unitCostCents: true } },
        },
      })
      if (!w) return null
      const { postWasteLog } = await import('../accounting/inventoryPosting.js')
      const { VOID_WASTE_REASONS } = await import('../inventory/voidWaste.js')
      // The STORED value postWasteLog books (the FIFO value taken; a pre-FIFO
      // log without it: the item's cost × quantity, the old rule).
      const cost = w.estimatedCostCents ?? Math.round((w.inventoryItem.unitCostCents ?? 0) * w.quantity)
      const soldLine = (VOID_WASTE_REASONS as readonly string[]).includes(w.reason)
      return {
        tenantId: w.tenantId ?? w.inventoryItem.tenantId, date: w.recordedAt, orderId: null, amountCents: cost,
        what: `Waste: ${w.quantity} ${w.unit} ${w.inventoryItem.name} (${w.reason}), ${pkr(cost)}`,
        nothingOwed: soldLine
          ? 'Booked with its sold line (pos.void_waste) — nothing to post here.'
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
      const { postStockCount, stockCountAdjustment } = await import('../accounting/inventoryPosting.js')
      // Valued from the STORED line values (PhysicalCountLine.valueCents — the
      // FIFO value of a loss, the lot of a gain or an opening), as postStockCount books it.
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
    title: 'Waste from a sold line did not reach the ledger',
    nothingToPost: new Set(['order_item_not_found', 'zero_cost']),
    load: async (orderItemId, flag) => {
      const line = await prisma.orderItem.findUnique({
        where: { id: orderItemId },
        select: { id: true, name: true, quantity: true, order: { select: { id: true, conceptId: true, concept: { select: { tenantId: true } } } } },
      })
      if (!line) return null
      const ids = metaOf(flag?.metadata ?? null)['wasteLogIds']
      const wasteLogIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
      const { postVoidWaste, VOID_WASTE_REASONS } = await import('../inventory/voidWaste.js')
      // The logs postVoidWaste books: this line's sold-line waste (void /
      // cancel after fire, returned food) — found by WasteLog.orderItemId, or
      // for a log written before wave B by the line id in its note — limited
      // to the flag's logs when it names any. Valued at their STORED cost.
      const logs = await prisma.wasteLog.findMany({
        where: {
          reason: { in: [...VOID_WASTE_REASONS] },
          OR: [{ orderItemId }, { orderItemId: null, notes: { contains: orderItemId } }],
          ...(wasteLogIds.length > 0 ? { id: { in: wasteLogIds } } : {}),
        },
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
          ? 'No sold-line waste is logged for this line — nothing to post; check the void by hand.'
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

  // ── Finance wave B ─────────────────────────────────────────────────────────

  // Monthly depreciation (fixedAssets/service.ts): one entry per asset-month
  // ('fixed_asset.depreciation:<assetId>:<YYYY-MM>'); the flag names the asset.
  // chargeAssetThrough charges every month still owed through the last
  // completed one and late-dates EACH month on its own (owner decision 6), so
  // the doc has no date and the backfill's dates are not used.
  'fixed_asset.depreciation': {
    entityType: 'FixedAsset',
    title: 'Depreciation did not reach the ledger',
    multiPost: true,
    nothingToPost: new Set(['nothing_to_charge']),
    load: async (assetId) => {
      const a = await prisma.fixedAsset.findUnique({ where: { id: assetId }, select: { id: true, tenantId: true, name: true, assetTag: true, status: true } })
      if (!a) return null
      const [{ chargeAssetThrough }, { lastCompletedPeriodPkt }] = await Promise.all([
        import('../fixedAssets/service.js'), import('../fixedAssets/schedule.js'),
      ])
      const through = lastCompletedPeriodPkt()
      return {
        tenantId: a.tenantId, date: null, orderId: null, amountCents: null,
        what: `Depreciation of ${a.name}${a.assetTag ? ` (${a.assetTag})` : ''} through ${through} — each month on its own date, a closed month into this month with a note`,
        nothingOwed: a.status !== 'active' ? `The asset is ${a.status.replace(/_/g, ' ')} — nothing to charge.` : undefined,
        post: async (o) => {
          const run = await chargeAssetThrough(assetId, through, { postedBy: o.postedBy })
          const res = run.results.find((x) => x.assetId === assetId)
          if (res?.status === 'charged') return { posted: true, entryId: null }
          if (res?.status === 'failed') return { posted: false, entryId: null, reason: res.error ?? 'refused' }
          return { posted: false, entryId: null, reason: 'nothing_to_charge' }
        },
      }
    },
  },

  // A prepayment's monthly release (accounting/prepaidReleases.ts): one entry
  // per month ('prepaid.release:<sourceType>:<paymentId>:<YYYY-MM>'); the flag
  // names the payment (CapexPayment or OpexPayment). Released through the last
  // completed month, each month late-dated on its own.
  'prepaid.release': {
    entityType: 'CapexPayment',
    entityTypes: ['OpexPayment'],
    title: 'A prepayment release did not post',
    multiPost: true,
    nothingToPost: new Set(['nothing_to_release']),
    load: async (paymentId, flag) => {
      const meta = metaOf(flag?.metadata ?? null)
      const opex = flag ? (flag.entityType === 'OpexPayment' || meta['prepaidSourceType'] === 'opex_payment') : false
      const capexRow = opex ? null : await prisma.capexPayment.findUnique({
        where: { id: paymentId }, select: { id: true, line: { select: { item: true, project: { select: { name: true, tenantId: true } } } } },
      })
      const opexRow = capexRow ? null : await prisma.opexPayment.findUnique({
        where: { id: paymentId }, select: { id: true, line: { select: { name: true, category: { select: { name: true, tenantId: true } } } } },
      })
      if (!capexRow && !opexRow) return null
      const sourceType = capexRow ? 'capex_payment' as const : 'opex_payment' as const
      const tenantId = capexRow ? capexRow.line.project.tenantId : opexRow!.line.category.tenantId
      const label = capexRow ? `${capexRow.line.project.name}: ${capexRow.line.item}` : `${opexRow!.line.category.name}: ${opexRow!.line.name}`
      const [{ releaseSourceThrough }, { lastCompletedPeriodPkt }] = await Promise.all([
        import('../accounting/prepaidReleases.js'), import('../fixedAssets/schedule.js'),
      ])
      const through = lastCompletedPeriodPkt()
      const released = () => prisma.prepaidRelease.count({ where: { sourceType, sourceId: paymentId, reversedAt: null } })
      return {
        tenantId, date: null, orderId: null, amountCents: null,
        what: `Prepayment release — ${label}, through ${through} (each month on its own date, a closed month into this month with a note)`,
        post: async (o) => {
          const before = await released()
          await releaseSourceThrough(sourceType, paymentId, through, { postedBy: o.postedBy })
          return (await released()) > before ? { posted: true, entryId: null } : { posted: false, entryId: null, reason: 'nothing_to_release' }
        },
      }
    },
  },

  // An ad-hoc prep batch's draw on the lots (accounting/inventoryPosting.ts
  // postPrepDraw): 'inventory.prep_draw:<batchId>', valued from its stored
  // 'prep_draw' movements.
  'inventory.prep_draw': {
    entityType: 'PrepBatch',
    title: 'Prep draw did not reach the ledger',
    nothingToPost: new Set(['batch_not_found', 'zero_value', 'not_ad_hoc']),
    load: async (batchId) => {
      const b = await prisma.prepBatch.findUnique({
        where: { id: batchId }, select: { id: true, tenantId: true, recipeId: true, itemName: true, drawValueCents: true, createdAt: true },
      })
      if (!b) return null
      const drawn = b.tenantId ? await prisma.stockMovement.aggregate({
        where: { tenantId: b.tenantId, sourceType: STOCK_SOURCE.prepBatch, sourceId: b.id, kind: 'prep_draw' },
        _sum: { valueCents: true }, _count: true,
      }) : null
      // The same value postPrepDraw books: its movements (negative = drawn), else the stored draw value.
      const value = drawn && drawn._count > 0 ? -sumCents(drawn._sum.valueCents) : (toCents(b.drawValueCents) ?? 0)
      const { postPrepDraw } = await import('../accounting/inventoryPosting.js')
      return {
        tenantId: b.tenantId, date: b.createdAt, orderId: null, amountCents: value,
        what: `Prep draw — ${b.itemName}, ${pkr(value)}`,
        nothingOwed: b.recipeId
          ? 'A sub-recipe batch is a yield record — the sale takes its inputs; nothing to post.'
          : value <= 0 ? 'Nothing was drawn at a value — nothing to post.' : undefined,
        post: (o) => postPrepDraw(batchId, o),
      }
    },
  },

  // Breakage at a gift card's expiry (giftCards/books.ts expireOneGiftCard,
  // H11): owed only while the card holds breakage back (breakagePendingAt).
  // The card's own state decides — never the exact reference (multiPost).
  // expireOneGiftCard books it dated today, under the card lock.
  'giftcard.expire': {
    entityType: 'GiftCard',
    title: 'Gift card breakage did not reach the ledger',
    multiPost: true,
    nothingToPost: new Set(['nothing_owed']),
    load: async (cardId) => {
      const c = await prisma.giftCard.findUnique({
        where: { id: cardId },
        select: { id: true, tenantId: true, code: true, status: true, balanceCents: true, breakageAt: true, breakagePendingAt: true, breakagePendingReason: true },
      })
      if (!c) return null
      const owed = c.status === 'expired' && c.breakageAt == null && c.breakagePendingAt != null
      const card = `Gift card ••••${c.code.slice(-4)}`
      return {
        tenantId: c.tenantId, date: null, orderId: null, amountCents: c.balanceCents,
        what: `${card} expired — breakage ${pkr(c.balanceCents)}`,
        nothingOwed: owed ? undefined
          : c.breakageAt ? 'Its breakage is already booked — nothing to post.'
          : c.status === 'voided' ? 'The card was voided — its value was settled there; nothing to post.'
          : 'No breakage is held on this card — nothing to post.',
        post: async () => {
          const { expireOneGiftCard, EXPIRE_SOURCE } = await import('../giftCards/books.js')
          const r = await expireOneGiftCard(cardId)
          if (r.breakageCents > 0) {
            const e = c.tenantId ? await prisma.journalEntry.findFirst({ where: { tenantId: c.tenantId, reference: `${EXPIRE_SOURCE}:${cardId}` }, select: { id: true } }) : null
            return { posted: true, entryId: e?.id ?? null }
          }
          if (r.held) {
            const now = await prisma.giftCard.findUnique({ where: { id: cardId }, select: { breakagePendingReason: true } })
            const why = now?.breakagePendingReason ?? 'held'
            return {
              posted: false, entryId: null,
              reason: why.startsWith('ISSUE_NOT_BOOKED')
                ? 'held: the card\'s sale is not on the books yet — book the sale first (Gift cards → Books check)'
                : `held: ${why}`,
            }
          }
          return { posted: false, entryId: null, reason: 'nothing_owed' }
        },
      }
    },
  },

  // A month's shared-fleet recharge (intercompany/fleet.ts): the flag sits in
  // the CLIENT company, entityId '<agreementId>:<YYYY-MM>'. Its entries are
  // the transfer's ('ic.transfer:<id>'), so the doc decides what is owed
  // (multiPost); post() charges only for an operator who belongs to BOTH
  // companies — anyone else gets FLEET_ASK_CEO and the flag stays open.
  'ic.fleet_charge': {
    entityType: FLEET_CHARGE_ENTITY,
    title: 'A shared-fleet recharge did not reach the ledger',
    multiPost: true,
    nothingToPost: FLEET_NOTHING_TO_POST,
    load: (sourceId) => fleetChargeRefusedDoc(sourceId),
  },

  ...cogsFixReposters(),
}

/**
 * The cost-of-sales moves of an order's stock events after its cost was
 * booked (orders/stock.ts ORDER_COGS_FIX — a give-back, "Box given" and its
 * undo, a legacy give-back, a late depletion, a never-booked cancel's
 * settles). Each re-derives what is owed from the movements, so a re-post
 * books exactly what the live path would; the key is '<sourceType>:<sourceId>'.
 */
function cogsFixReposters(): Record<OrderCogsFixSource, Reposter> {
  const out = {} as Record<OrderCogsFixSource, Reposter>
  for (const k of ORDER_COGS_FIX_SOURCES) {
    out[k] = {
      entityType: ORDER_COGS_FIX_ENTITY[k],
      title: 'Cost of sales not moved for an order stock event',
      nothingToPost: ORDER_COGS_FIX_NOTHING,
      load: (id) => orderCogsFixDoc(k, id),
    }
  }
  return out
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
    if (!kind || !sourceId || !acceptsEntity(REPOSTERS[kind], f.entityType) || f.entityId !== sourceId) continue
    const key = `${kind}:${sourceId}`
    if (!owed.has(key)) owed.set(key, { kind, sourceId, flag: f, legacy })
  }

  // Closed on the flag's own entityType (prepaid.release: CapexPayment or OpexPayment).
  const close = async (kind: RefusedPostingKind, sourceId: string, resolution: string, entityType: string | null) =>
    resolvePostingFailed(entityType ?? REPOSTERS[kind].entityType, sourceId, kind, resolution, { tenantIds })

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
    else if (!r.multiPost && doc.tenantId && await prisma.journalEntry.findFirst({ where: { tenantId: doc.tenantId, reference: `${kind}:${sourceId}` }, select: { id: true } })) {
      resolution = 'Already on the books.'
    } else if (doc.nothingOwed) resolution = doc.nothingOwed
    if (resolution) {
      const date = doc?.date?.toISOString() ?? null
      if (opts.dryRun) { rows.push({ ...base, date, outcome: 'would_resolve', detail: resolution }); continue }
      await close(kind, sourceId, `${resolution} (Reconciliation → Backfill unposted)`, flag.entityType)
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
      await close(kind, sourceId, 'Re-raised for review as an automatic re-post (Reconciliation → Backfill unposted).', flag.entityType)
      await flagPostingFailed({
        tenantId: doc!.tenantId,
        sourceType: kind, sourceId,
        entityType: r.entityType, entityId: sourceId,
        reason: 'Raised before automatic re-posting, when it asked for a hand entry (Dr 5040 / Cr 1210). If that was booked by hand, close this flag; otherwise the next backfill run posts it.',
        title: r.title,
        actorId: opts.postedBy ?? null,
        amountCents: doc!.amountCents,
        metadata: { orderId: m['orderId'] ?? doc!.orderId, wasteLogIds: m['wasteLogIds'] ?? [], ...documentDateOf(doc!) },
      })
      rows.push({ ...base, date, outcome: 'flagged', detail })
      continue
    }
    const row = await placeAndPost(doc!, doc!.tenantId, r, opts)
    if (row.resolve) await close(kind, sourceId, row.resolve, flag.entityType)
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
      metadata: documentDateOf(doc),
    })
    rows.push({ ...base, outcome: 'flagged', detail: `${doc.what} — flagged for review; the next run posts it unless the flag is closed.` })
  }
  return rows
}

/** The document's own date on a flag this backfill raises (the period close's check reads metadata.documentDate). */
function documentDateOf(doc: RefusedDoc): { documentDate?: string } {
  return doc.date ? { documentDate: doc.date.toISOString() } : {}
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
 * Deposits, waste (not of a sold line), stock counts and ad-hoc prep draws of
 * `tenantIds` since `from` with a value, no entry in their company and no
 * posting_failed flag at all (an open one is step 4's; a closed one was
 * decided by a person).
 */
async function unflaggedMisses(tenantIds: string[], from: Date): Promise<Array<{ kind: 'deposit.drop' | 'inventory.waste' | 'inventory.count' | 'inventory.prep_draw'; id: string }>> {
  const latest = (a: Date, b: Date) => (a > b ? a : b)
  const dropsFrom = latest(from, parsePktStartOfDay(DEPOSIT_POSTING_FROM))
  const countsFrom = latest(from, parsePktStartOfDay(COUNT_POSTING_FROM))
  const { VOID_WASTE_REASONS } = await import('../inventory/voidWaste.js')
  const soldLineReasons = [...VOID_WASTE_REASONS] as string[]
  const [drops, waste, counts, preps] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT d.id FROM deposit_drops d
       WHERE d."tenantId" = ANY(${tenantIds}::text[]) AND d."amountCents" > 0 AND d."droppedAt" >= ${dropsFrom}
         AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j."tenantId" = d."tenantId" AND j.reference = 'deposit.drop:' || d.id)
         AND NOT EXISTS (SELECT 1 FROM exception_flags f WHERE f.kind = 'posting_failed' AND f."entityType" = 'DepositDrop' AND f."entityId" = d.id)
       ORDER BY d."droppedAt" ASC`,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT w.id FROM waste_logs w JOIN inventory_items i ON i.id = w."inventoryItemId"
       WHERE COALESCE(w."tenantId", i."tenantId") = ANY(${tenantIds}::text[])
         AND w.reason <> ALL(${soldLineReasons}::text[]) AND w."recordedAt" >= ${from}
         AND COALESCE(w."estimatedCostCents", round(COALESCE(i."unitCostCents", 0) * w.quantity)) > 0
         AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j."tenantId" = COALESCE(w."tenantId", i."tenantId") AND j.reference = 'inventory.waste:' || w.id)
         AND NOT EXISTS (SELECT 1 FROM exception_flags f WHERE f.kind = 'posting_failed' AND f."entityType" = 'WasteLog' AND f."entityId" = w.id)
       ORDER BY w."recordedAt" ASC`,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM physical_counts c
       WHERE c."tenantId" = ANY(${tenantIds}::text[]) AND c."countedAt" >= ${countsFrom}
         AND EXISTS (SELECT 1 FROM physical_count_lines l WHERE l."countId" = c.id
                       AND (CASE WHEN l."valueCents" IS NULL THEN l."physicalQty" <> l."systemQty" ELSE l."valueCents" <> 0 END))
         AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j."tenantId" = c."tenantId" AND j.reference = 'inventory.count:' || c.id)
         AND NOT EXISTS (SELECT 1 FROM exception_flags f WHERE f.kind = 'posting_failed' AND f."entityType" = 'PhysicalCount' AND f."entityId" = c.id)
       ORDER BY c."countedAt" ASC`,
    // Ad-hoc prep batches that drew from the lots (their 'prep_draw'
    // movements exist only once the company is on FIFO lots, i.e. since the
    // prep draw posts) with no entry.
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT b.id FROM prep_batches b
       WHERE b."tenantId" = ANY(${tenantIds}::text[]) AND b."recipeId" IS NULL AND b."createdAt" >= ${from}
         AND EXISTS (SELECT 1 FROM stock_movements m
                      WHERE m."tenantId" = b."tenantId" AND m."sourceType" = ${STOCK_SOURCE.prepBatch} AND m."sourceId" = b.id
                        AND m.kind = 'prep_draw' AND m."valueCents" <> 0)
         AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j."tenantId" = b."tenantId" AND j.reference = 'inventory.prep_draw:' || b.id)
         AND NOT EXISTS (SELECT 1 FROM exception_flags f WHERE f.kind = 'posting_failed' AND f."entityType" = 'PrepBatch' AND f."entityId" = b.id)
       ORDER BY b."createdAt" ASC`,
  ])
  return [
    ...drops.map((d) => ({ kind: 'deposit.drop' as const, id: d.id })),
    ...waste.map((w) => ({ kind: 'inventory.waste' as const, id: w.id })),
    ...counts.map((c) => ({ kind: 'inventory.count' as const, id: c.id })),
    ...preps.map((b) => ({ kind: 'inventory.prep_draw' as const, id: b.id })),
  ]
}

// ─── 5. Stock steps that failed (finance wave B) ────────────────────────────
//
// An order's depletion, a cancelled order's give-back / waste, or a KDS
// remake's waste that failed after (or outside) its transaction raised ONE
// open 'stock_restore_failed' flag in the order's company (orders/stock.ts
// flagOrderStockFailure, keyed by metadata.phase). Each step is once-only, so
// this re-runs it — the caller's companies' orders only:
//
//   deplete (Order)      ensureOrderDepleted; closed once the depletion claim
//                        exists (or the order never sold)
//   restore (Order)      restoreInventoryForOrder (fired lines wasted
//                        'cancelled_after_fire'); closed once the give-back
//                        claim exists (or the stock never came out)
//   remake (OrderItem)   bookRemakeWaste, once per failed recall still owed
//                        (metadata.failures − the remakes of the line booked
//                        since the flag), then closed
//
// A 'box_given' flag is left for a person: the tap rolled back whole, so staff
// tap again. What these steps post goes through their own posters (a refusal
// is flagged posting_failed and re-posted by step 4). The dry run lists what
// would re-run; nothing is written.
//
// The sweep: a cancelled order whose stock is still out (a depletion claim
// since `sweepFrom`, no give-back claim) and no 'restore' flag at all is
// listed 'unflagged'; a real run raises its flag ('flagged') and the next run
// re-runs it — unless a person closes the flag first.

const NO_SALE_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'rejected'])
const STOCK_PHASES = ['deplete', 'restore', 'remake'] as const
type StockPhase = (typeof STOCK_PHASES)[number]

async function rerunStockFailures(opts: {
  tenantIds: string[]
  dryRun: boolean
  postedBy?: string
  sweepFrom: Date
}): Promise<OrderBackfillRow[]> {
  const { tenantIds } = opts
  const rows: OrderBackfillRow[] = []
  const flags = await prisma.exceptionFlag.findMany({
    where: {
      kind: 'stock_restore_failed', status: { in: [...OPEN_FLAG] }, tenantId: { in: tenantIds },
      OR: STOCK_PHASES.map((phase) => ({ metadata: { path: ['phase'], equals: phase } })),
    },
    select: { id: true, tenantId: true, entityType: true, entityId: true, metadata: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const claimed = async (orderId: string, action: string) =>
    !!(await prisma.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action }, select: { id: true } }))
  const resolve = (flagId: string, resolution: string) => prisma.exceptionFlag.update({
    where: { id: flagId },
    data: { status: 'resolved', resolvedAt: new Date(), resolution: `${resolution} (Reconciliation → Backfill unposted)` },
  }).catch(() => {})

  for (const f of flags) {
    const m = metaOf(f.metadata)
    const phase = m['phase'] as StockPhase
    const onLine = phase === 'remake'
    if (!f.entityId || f.entityType !== (onLine ? 'OrderItem' : 'Order')) continue
    const orderId = onLine ? (typeof m['orderId'] === 'string' ? m['orderId'] : null) : f.entityId
    const line = onLine
      ? await prisma.orderItem.findUnique({ where: { id: f.entityId }, select: { id: true, orderId: true, name: true, quantity: true } })
      : null
    const order = await prisma.order.findUnique({
      where: { id: line?.orderId ?? orderId ?? '' },
      select: { id: true, status: true, concept: { select: { tenantId: true } } },
    })
    const tenantId = order?.concept.tenantId ?? f.tenantId
    // Only this caller's companies' orders (the flag's company is the order's).
    if (!tenantId || !tenantIds.includes(tenantId)) continue
    const kind: StockRerunKind = `stock.${phase}`
    const base = { kind, id: f.entityId, orderId: order?.id ?? orderId, tenantId, date: f.createdAt.toISOString() }

    // What is owed, and the re-run that pays it.
    let nothing: string | null = null
    let todo = ''
    let run: (() => Promise<string | null>) | null = null   // → null on success, else why not
    if (!order || (onLine && !line)) {
      nothing = 'The order no longer exists — nothing to re-run.'
    } else if (phase === 'deplete') {
      if (NO_SALE_STATUSES.has(order.status)) nothing = 'The order never sold — nothing to take out.'
      else if (await claimed(order.id, STOCK_DEPLETE)) nothing = 'Its stock is already out.'
      else {
        todo = 'Take the order\'s stock out of the lots (re-run of the depletion that failed)'
        run = async () => {
          await ensureOrderDepleted(order.id)   // never throws: a failure stays flagged
          return (await claimed(order.id, STOCK_DEPLETE)) ? null
            : 'still not taken out — fix the cause (the item\'s company, the FIFO cut-over, a pre-order not released yet) and run it again'
        }
      }
    } else if (phase === 'restore') {
      if (await claimed(order.id, STOCK_RESTORE)) nothing = 'Its stock was already given back.'
      else if (!(await claimed(order.id, STOCK_DEPLETE))) nothing = 'Its stock never came out — nothing to give back.'
      else if (!NO_SALE_STATUSES.has(order.status)) {
        rows.push({ ...base, outcome: 'not_cancelled', detail: `The order is ${order.status}, not cancelled — check it by hand.` })
        continue
      } else {
        todo = 'Give the unfired lines back to their lots and waste the fired ones (re-run of the cancel that failed)'
        run = async () => {
          await restoreInventoryForOrder(order.id, { cookedFood: { wasteReason: 'cancelled_after_fire' }, actorId: opts.postedBy ?? null })
          return (await claimed(order.id, STOCK_RESTORE)) ? null : 'still not given back'
        }
      }
    } else {
      const failures = typeof m['failures'] === 'number' && m['failures'] > 0 ? Math.floor(m['failures']) : 1
      // Remakes of this line booked since the flag: a remake logs at most one
      // waste row per item, so the busiest item counts them.
      const logs = await prisma.wasteLog.groupBy({
        by: ['inventoryItemId'],
        where: { orderItemId: line!.id, reason: 'remake', recordedAt: { gte: f.createdAt } },
        _count: { _all: true },
      })
      const booked = logs.reduce((n, g) => Math.max(n, g._count._all), 0)
      const owed = failures - booked
      if (owed <= 0) nothing = 'The remake is already booked as waste.'
      else {
        todo = `Book ${owed} remake${owed === 1 ? '' : 's'} of ${line!.quantity} × ${line!.name} as waste (re-run of the remake that failed)`
        run = async () => {
          for (let i = 0; i < owed; i++) await bookRemakeWaste(line!.id, opts.postedBy ?? null)
          return null
        }
      }
    }

    if (nothing) {
      if (opts.dryRun) { rows.push({ ...base, outcome: 'would_resolve', detail: nothing }); continue }
      await resolve(f.id, nothing)
      rows.push({ ...base, outcome: 'resolved', detail: nothing })
      continue
    }
    if (opts.dryRun) { rows.push({ ...base, outcome: 'would_post', detail: todo }); continue }
    try {
      const why = await run!()
      if (why) { rows.push({ ...base, outcome: 'error', detail: `${todo}: ${why}` }); continue }
      await resolve(f.id, 'Re-run')
      rows.push({ ...base, outcome: 'posted', detail: todo })
    } catch (err) {
      rows.push({ ...base, outcome: 'error', detail: (err as Error).message })
    }
  }

  // ── The sweep: a cancelled order whose stock is still out, never flagged ──
  const missing = await prisma.$queryRaw<Array<{ id: string; tenantId: string }>>`
    SELECT o.id, c."tenantId"
      FROM orders o
      JOIN concepts c ON c.id = o."conceptId"
     WHERE c."tenantId" = ANY(${tenantIds}::text[])
       AND o.status::text IN ('cancelled', 'rejected')
       AND EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.entity = 'Order' AND a."entityId" = o.id AND a.action = ${STOCK_DEPLETE} AND a."createdAt" >= ${opts.sweepFrom})
       AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity = 'Order' AND a."entityId" = o.id AND a.action = ${STOCK_RESTORE})
       AND NOT EXISTS (SELECT 1 FROM exception_flags f
                        WHERE f.kind = 'stock_restore_failed' AND f."entityType" = 'Order' AND f."entityId" = o.id
                          AND f.metadata->>'phase' = 'restore')
     ORDER BY o."updatedAt" ASC`
  for (const o of missing) {
    const base = { kind: 'stock.restore' as const, id: o.id, orderId: o.id, tenantId: o.tenantId, date: null }
    const what = 'Cancelled, but its stock was never given back or wasted'
    if (opts.dryRun) {
      rows.push({ ...base, outcome: 'unflagged', detail: `${what} — nothing flagged it. Post flags it for review; the next run gives it back unless the flag is closed.` })
      continue
    }
    await flagOrderStockFailure(o.id, 'restore', new Error(`${what} (found by Reconciliation → Backfill unposted)`), opts.postedBy ?? null)
    rows.push({ ...base, outcome: 'flagged', detail: `${what} — flagged for review; the next run gives it back unless the flag is closed.` })
  }
  return rows
}
