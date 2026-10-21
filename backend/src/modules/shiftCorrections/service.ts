// Shift corrections (owner, 2026-10-21) — the service.
//
// "A shift closed by staff/cashier, Finance should have access to reopen the
// shift and cancel any KOT, with CEO's approval. It should not be like refund
// and all, put some provisions for human error. If a bill is closed and shift
// is closed, Finance & CEO should be able to reopen Shift and reopen and void
// payment/Full & final bills/KOTs, all this void & cancellation should require
// CEO's approval to move the entry to trash."
//
// Finance (with `accounting`) or the CEO raises ONE set of fixes on a CLOSED
// drawer, each with a reason; the CEO approves or rejects the set once.
// NOTHING touches the books, stock, fiscal documents or orders until the CEO
// approves. On approval the set is applied in this order, reusing the
// existing engines (no second void / cancel / posting engine):
//
//   a. a sales day the night audit locked is reopened (nightAudit reopenDay,
//      reason "Shift correction <ref>: …");
//   b. the drawer's LIVE close is reversed ('shift.close.reversal:<id>[@n]',
//      reverseJournalEntry), dated as the close it reverses — the sale's own
//      business day;
//   c. per item, through orders/service cancelOrder (the one way an order
//      ends without a sale; approver = the CEO, the set's reason is the
//      back-dated reason):
//        void_bill   a FULL & FINAL till bill → cancelled (the one
//                    completed → cancelled move, `shiftCorrection.voidFinalBill`);
//        cancel_kot  an open ticket → cancelled;
//      inside the cancel's transaction: the tenders are voided (Payment
//      'failed' + gatewayMeta.voided — not refunded) unless `moneyReturned`;
//      a final bill's fiscal VOID document is queued through the outbox
//      ('void:<orderId>', enqueueFiscalRefundTx — a servd-channel bill's is
//      manual_required like its sale); the order is parked in the Trash
//      (transaction type 'order': never erasable, "Recover as copy" only).
//      After it: stock back to its lots (`foodMade` false) or wasted
//      (`foodMade` true, Dr 1290); points / wallet / gift cards given back
//      (postRefundOrFlag — the earn's own reversal); the tax invoice
//      credit-noted (no ledger: the order is no longer completed);
//   d. the drawer's close is re-posted from the same function as a normal
//      close (buildShiftCloseEntry) as revision 'shift.close:<id>@n'
//      (sourcePosting.ts): the voided bills are gone from revenue, tax and
//      cost of sales; the counted cash stays, so the drawer variance
//      recomputes; money really handed back (`moneyReturned`) is held as a
//      REFUND DUE on till clearing until the till records the hand-back
//      through the existing refund route;
//   e. status `applied`, audit `shift_correction.applied`, finance and the
//      requester are told.
// A step that is refused leaves the set `failed` with `error`; every step is
// idempotent (keyed entries, the cancel's own claim, the item's applied
// marker written in the cancel's transaction), so the CEO's Retry finishes
// it. A close reversed but not yet re-posted is flagged posting_failed on the
// shift (it blocks the month close) until the retry posts it.
//
// NOT built (stopped, owner to decide): `void_reissue` — see VOID_REISSUE_BLOCKER.

import type { OrderStatus, Prisma, ShiftCorrection, ShiftCorrectionItem } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { TILL_TENDERS } from '../../lib/tenders.js'
import { shiftBusinessDay, shiftBusinessDate } from '../../lib/businessDay.js'
import { SHIFT_COMPANY_INCLUDE, shiftTenantId } from '../../lib/tenantScope.js'
import { drawerExpectation } from '../../lib/drawer.js'
import { moveToTrash } from '../../lib/trash.js'
import { queueStaffNotify, notifyStaffMany } from '../../lib/staffNotify.js'
import { financeOf } from '../../lib/staffNotifyRecipients.js'
import { fmtPktDate } from '../accounting/dates.js'
import { flagPostingFailed, resolvePostingFailed, reverseJournalEntry } from '../accounting/journal.js'
import { liveRevision, syncSourcePosting } from '../accounting/sourcePosting.js'
import { buildShiftCloseEntry, liveShiftCloses } from '../accounting/shiftPosting.js'
import { homeShiftOf, isShiftReceipt } from '../accounting/orderPosting.js'
import { dayLockOf } from '../nightAudit/lock.js'
import { TRASH_ORDERS } from '../trash/providers/transactions/orders.js'

type Db = Prisma.TransactionClient | typeof prisma

export const MIN_REASON = 10
export const MAX_ITEMS = 50
export const ITEM_KINDS = ['void_bill', 'cancel_kot', 'void_reissue'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

const OPEN_STATUSES = ['received', 'confirmed', 'preparing', 'ready'] as const
/** Tenders a correction never voids: their money is matched elsewhere (bank statement, client statement). */
const NOT_VOIDABLE_TENDERS: ReadonlySet<string> = new Set(['raast', 'on_account'])

/**
 * Why a corrected bill is NOT re-issued by servd yet (owner's answer 3 — "void
 * and re-issue inside the same set"). Back-dating a new bill through the till
 * engines is not clean today:
 *  1. processPayment / completeTillSaleTx stamp Payment.createdAt / processedAt
 *     and Order.completedAt with NOW, and the ONE sale fiscal document takes
 *     its issue date from completedAt (connectors/fiscal/payload.ts) — a new
 *     bill would be dated today, not on the original business day;
 *  2. createPosOrder → ingestOrder fires a new kitchen ticket and depletes
 *     stock for the new order (the food was already served and relieved by
 *     the voided bill);
 *  3. a card / Raast tender needs the real card-machine charge or bank
 *     reference (keyed card references are refused while the company's card
 *     machine is connected; a Raast reference is unique per company).
 * Until the owner decides how the engines take an "as of" date, a wrong tender
 * is corrected by voiding the bill here and ringing the right bill on an open
 * till.
 */
export const VOID_REISSUE_BLOCKER =
  'Void and re-issue is not available yet: servd cannot back-date a new bill to the original business day through the till '
  + '(the payment and the fiscal sale document are stamped with today, the kitchen would get a new ticket and the stock would '
  + 'come out twice). Void the bill in this correction and ring the right bill on an open till.'

export interface ItemInput {
  orderId: string
  kind: ItemKind
  reason: string
  moneyReturned?: boolean
  foodMade?: boolean
  newTender?: string | null
}

export interface Actor { id: string; role: string; email?: string | null }

const SHIFT_SELECT = {
  id: true, status: true, openedAt: true, closedAt: true, userId: true, tenantId: true, locationId: true,
  openingFloatCents: true, closingFloatCents: true,
  user: { select: { name: true, tenantId: true } },
  location: { select: { tenantId: true, name: true } },
} satisfies Prisma.ShiftSelect
type ShiftRow = Prisma.ShiftGetPayload<{ select: typeof SHIFT_SELECT }>

const ORDER_SELECT = {
  id: true, status: true, source: true, conceptId: true, shiftId: true, posStaffId: true, placedAt: true, completedAt: true,
  settlementChannel: true, totalCents: true, taxCents: true, discountCents: true, serviceChargeCents: true, tipCents: true,
  walletAmountCents: true, deletedAt: true,
  concept: { select: { tenantId: true, name: true, slug: true } },
  payments: {
    select: { id: true, shiftId: true, method: true, status: true, amountCents: true, gatewayRef: true, createdAt: true, gatewayMeta: true },
  },
  items: { where: { status: { not: 'voided' as const } }, select: { name: true, quantity: true, status: true } },
} satisfies Prisma.OrderSelect
type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>

/** The company a shift belongs to, and its business day (422 when it has none). */
function shiftFacts(shift: ShiftRow): { tenantId: string; businessDay: string; businessDate: Date } {
  const tenantId = shiftTenantId(shift)
  if (!tenantId) throw new AppError('NO_COMPANY', 'This drawer is not bound to a company', 422)
  const businessDay = shiftBusinessDay(shift)
  const businessDate = shiftBusinessDate(shift)
  if (!businessDay || !businessDate) throw new AppError('SHIFT_NOT_CLOSED', 'Only a closed drawer is corrected — close it on the till first', 409)
  return { tenantId, businessDay, businessDate }
}

/** 409 BOOKS_CLOSED when the business day (or the date the close was booked on) is in a closed month. */
async function assertBooksOpen(db: Db, tenantId: string, shiftId: string, businessDate: Date): Promise<void> {
  const lock = await db.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
  if (!lock) return
  const live = (await liveShiftCloses(db, tenantId, [shiftId])).get(shiftId)
  for (const d of [businessDate, live?.entryDate].filter((x): x is Date => !!x)) {
    if (d <= lock.lockedThrough) {
      throw new AppError(
        'BOOKS_CLOSED',
        `The books are closed through ${fmtPktDate(lock.lockedThrough)} — this drawer's day ${fmtPktDate(d)} is in a closed month. The CEO reopens the month first.`,
        409,
        { lockedThrough: lock.lockedThrough.toISOString(), day: fmtPktDate(d) },
      )
    }
  }
}

/** Receipts of the order (money or a comp taken on a drawer). */
const receiptsOf = (o: OrderRow) => o.payments.filter((p) => p.amountCents > 0 && isShiftReceipt(p))

/** Is the open ticket on this drawer (the till's own open-ticket rule, pos/service openTicketsOf)? */
function ticketOnShift(o: OrderRow, shift: ShiftRow): boolean {
  if (o.shiftId === shift.id) return true
  if (o.payments.some((p) => p.shiftId === shift.id)) return true
  return o.shiftId === null && o.source === 'pos' && o.posStaffId === shift.userId
    && o.placedAt >= shift.openedAt && (!shift.closedAt || o.placedAt <= shift.closedAt)
}

const err = (code: string, message: string, status: number, orderId: string) => new AppError(code, message, status, { orderId })

/**
 * The rules for one fix (submit and apply alike). Throws with `details.orderId`.
 * `alreadyApplied` (a retry): the order was cancelled by this set — skipped.
 */
async function checkItem(db: Db, shift: ShiftRow, tenantId: string, item: ItemInput): Promise<OrderRow> {
  const ref = orderRefOf(item.orderId)
  if (item.kind === 'void_reissue') {
    if (!item.newTender || !(TILL_TENDERS as readonly string[]).includes(item.newTender)) {
      throw err('TENDER_REQUIRED', `Order ${ref}: name the right tender (${TILL_TENDERS.join(', ')}) for a void and re-issue`, 422, item.orderId)
    }
    throw err('VOID_REISSUE_NOT_AVAILABLE', VOID_REISSUE_BLOCKER, 422, item.orderId)
  }
  const o = await db.order.findFirst({ where: { id: item.orderId, deletedAt: null }, select: ORDER_SELECT })
  // Another company's order is the same answer as one on another drawer.
  if (!o || o.concept.tenantId !== tenantId) throw err('ORDER_NOT_ON_SHIFT', `Order ${ref} is not on this drawer`, 422, item.orderId)
  const receipts = receiptsOf(o)
  if (receipts.some((p) => p.shiftId !== shift.id)) {
    throw err('ORDER_SPANS_DRAWERS', `Order ${ref} was paid on more than one drawer — correct it with a refund on the till instead`, 422, o.id)
  }
  const blocked = receipts.find((p) => NOT_VOIDABLE_TENDERS.has(p.method))
  if (blocked) {
    throw err('TENDER_NOT_VOIDABLE', `Order ${ref} was paid by ${blocked.method === 'raast' ? 'Raast QR' : 'an on-account client'} — that money is matched elsewhere; refund it through its own route`, 422, o.id)
  }
  if (item.kind === 'void_bill') {
    if (o.source !== 'pos' || homeShiftOf(o) !== shift.id) throw err('ORDER_NOT_ON_SHIFT', `Order ${ref} is not a till bill of this drawer`, 422, o.id)
    if (o.status !== 'completed') throw err('BILL_NOT_VOIDABLE', `Order ${ref} is ${o.status}, not a full & final bill that still stands`, 409, o.id)
    if (o.payments.some((p) => p.status === 'refunded')) throw err('BILL_NOT_VOIDABLE', `Order ${ref} already has refunds or voided lines — it cannot be voided whole`, 409, o.id)
    const cn = await db.taxInvoice.findFirst({ where: { orderId: o.id, type: 'credit_note' }, select: { id: true } })
    if (cn) throw err('BILL_NOT_VOIDABLE', `Order ${ref} already has a credit note`, 409, o.id)
    return o
  }
  // cancel_kot
  if (!ticketOnShift(o, shift)) throw err('ORDER_NOT_ON_SHIFT', `Order ${ref} is not a ticket of this drawer`, 422, o.id)
  if (!(OPEN_STATUSES as readonly string[]).includes(o.status)) throw err('KOT_NOT_OPEN', `Order ${ref} is ${o.status} — only an open ticket (KOT) is cancelled`, 409, o.id)
  if (o.payments.some((p) => p.status === 'refunded')) throw err('BILL_NOT_VOIDABLE', `Order ${ref} has refunds or voided lines already`, 409, o.id)
  return o
}

function assertItemsShape(items: ItemInput[], reason: string): void {
  if ((reason ?? '').trim().length < MIN_REASON) throw new AppError('REASON_REQUIRED', `Give the reason for the correction (at least ${MIN_REASON} characters)`, 422)
  if (items.length === 0) throw new AppError('NO_ITEMS', 'List at least one bill or KOT to correct', 422)
  if (items.length > MAX_ITEMS) throw new AppError('TOO_MANY_ITEMS', `At most ${MAX_ITEMS} fixes in one correction`, 422)
  const seen = new Set<string>()
  for (const i of items) {
    if (seen.has(i.orderId)) throw err('ORDER_LISTED_TWICE', `Order ${orderRefOf(i.orderId)} is listed twice — one fix per order`, 422, i.orderId)
    seen.add(i.orderId)
    if ((i.reason ?? '').trim().length < MIN_REASON) throw err('REASON_REQUIRED', `Give the reason for order ${orderRefOf(i.orderId)} (at least ${MIN_REASON} characters)`, 422, i.orderId)
  }
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function createCorrection(input: {
  shift: ShiftRow
  reason: string
  items: ItemInput[]
  actor: Actor
}): Promise<ShiftCorrection> {
  const { shift, actor } = input
  if (shift.status !== 'closed') throw new AppError('SHIFT_NOT_CLOSED', 'Only a closed drawer is corrected — close it on the till first', 409)
  const { tenantId, businessDay, businessDate } = shiftFacts(shift)
  const reason = input.reason.trim()
  assertItemsShape(input.items, reason)
  await assertBooksOpen(prisma, tenantId, shift.id, businessDate)
  for (const i of input.items) await checkItem(prisma, shift, tenantId, i)

  const created = await prisma.$transaction(async (tx) => {
    // One open set per shift (also the partial unique shift_corrections_one_open).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shift-correction:${shift.id}`}))`
    const open = await tx.shiftCorrection.findFirst({ where: { shiftId: shift.id, status: 'submitted' }, select: { id: true } })
    if (open) throw new AppError('CORRECTION_PENDING', 'This drawer already has a correction waiting for the CEO — add to it after it is decided', 409, { correctionId: open.id })
    return tx.shiftCorrection.create({
      data: {
        tenantId, shiftId: shift.id, businessDay, reason, requestedById: actor.id,
        items: {
          create: input.items.map((i) => ({
            tenantId, kind: i.kind, orderId: i.orderId, reason: i.reason.trim(),
            moneyReturned: !!i.moneyReturned, foodMade: !!i.foodMade, newTender: i.newTender ?? null,
          })),
        },
      },
    })
  }, { maxWait: 10_000, timeout: 15_000 })

  await audit({
    category: 'accounting', action: 'shift_correction.submit', entity: 'ShiftCorrection', entityId: created.id,
    userId: actor.id, userEmail: actor.email ?? null, tenantId,
    after: { status: created.status, shiftId: shift.id, businessDay, items: input.items.length },
    metadata: { actorRole: actor.role, reason, items: input.items.map((i) => ({ orderId: i.orderId, kind: i.kind, moneyReturned: !!i.moneyReturned, foodMade: !!i.foodMade })) },
  })
  return created
}

// ─── Read ────────────────────────────────────────────────────────────────────

export interface ItemPreview {
  orderRef: string
  brand: string | null
  status: string | null
  totalCents: number
  taxCents: number
  serviceChargeCents: number
  tipCents: number
  discountCents: number
  tenders: Array<{ method: string; amountCents: number; status: string }>
  /** What the CEO's approval does to it. */
  effect: {
    order: 'void_final_bill' | 'cancel_ticket' | 'not_available'
    /** Taken off the drawer's sales (re-posted close). */
    reversesRevenue: boolean
    money: 'voided' | 'owed_back' | 'none'
    stock: 'back_to_stock' | 'waste'
    fiscal: 'void_document' | 'void_document_manual' | 'none'
  }
  /** Why the CEO's approval would be refused for this fix now (null = fine). */
  blockedBy: { code: string; message: string } | null
}

async function previewItem(shift: ShiftRow, tenantId: string, item: ShiftCorrectionItem): Promise<ItemPreview> {
  const o = await prisma.order.findFirst({ where: { id: item.orderId, concept: { tenantId } }, select: ORDER_SELECT })
  let blockedBy: ItemPreview['blockedBy'] = null
  const done = (item.result as { applied?: boolean } | null)?.applied
  if (!done) {
    try { await checkItem(prisma, shift, tenantId, item) } catch (e) {
      blockedBy = e instanceof AppError ? { code: e.code, message: e.message } : { code: 'ERROR', message: String((e as Error).message) }
    }
  }
  const sale = o ? await prisma.fiscalDocument.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: `sale:${o.id}` } },
    select: { status: true, statusReason: true },
  }) : null
  const receipts = o ? receiptsOf(o) : []
  const finalBill = item.kind !== 'cancel_kot'
  return {
    orderRef: orderRefOf(item.orderId),
    brand: o?.concept.name ?? null,
    status: o?.status ?? null,
    totalCents: o?.totalCents ?? 0,
    taxCents: o?.taxCents ?? 0,
    serviceChargeCents: o?.serviceChargeCents ?? 0,
    tipCents: o?.tipCents ?? 0,
    discountCents: o?.discountCents ?? 0,
    tenders: o?.payments.map((p) => ({ method: p.method, amountCents: p.amountCents, status: p.status })) ?? [],
    effect: {
      order: item.kind === 'void_reissue' ? 'not_available' : finalBill ? 'void_final_bill' : 'cancel_ticket',
      reversesRevenue: receipts.length > 0,
      money: receipts.filter((p) => p.method !== 'comp').length === 0 ? 'none' : item.moneyReturned ? 'owed_back' : 'voided',
      stock: item.foodMade ? 'waste' : 'back_to_stock',
      fiscal: !finalBill || !sale || sale.status === 'skipped' ? 'none'
        : (sale.statusReason === 'servd_channel' || o?.settlementChannel === 'servd') ? 'void_document_manual' : 'void_document',
    },
    blockedBy,
  }
}

export type CorrectionWithItems = ShiftCorrection & { items: ShiftCorrectionItem[] }

export async function correctionView(c: CorrectionWithItems, opts: { preview: boolean }) {
  const shift = await prisma.shift.findUnique({ where: { id: c.shiftId }, select: SHIFT_SELECT })
  const people = await prisma.user.findMany({
    where: { id: { in: [c.requestedById, c.decidedById].filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  })
  const nameOf = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? null : null)
  const items = await Promise.all(c.items.map(async (i) => ({
    id: i.id,
    kind: i.kind,
    orderId: i.orderId,
    orderRef: orderRefOf(i.orderId),
    reason: i.reason,
    moneyReturned: i.moneyReturned,
    foodMade: i.foodMade,
    newTender: i.newTender,
    result: i.result,
    ...(opts.preview && shift ? { preview: await previewItem(shift, c.tenantId, i) } : {}),
  })))
  let drawer: { expectedCents: number; countedCents: number | null; varianceCents: number | null } | null = null
  if (opts.preview && shift) {
    const d = await drawerExpectation(shift.id)
    drawer = { expectedCents: d.expectedCents, countedCents: shift.closingFloatCents, varianceCents: shift.closingFloatCents == null ? null : shift.closingFloatCents - d.expectedCents }
  }
  return {
    id: c.id,
    tenantId: c.tenantId,
    shiftId: c.shiftId,
    businessDay: c.businessDay,
    status: c.status,
    reason: c.reason,
    requestedBy: { id: c.requestedById, name: nameOf(c.requestedById) },
    decidedBy: c.decidedById ? { id: c.decidedById, name: nameOf(c.decidedById) } : null,
    decidedAt: c.decidedAt,
    decisionNote: c.decisionNote,
    appliedAt: c.appliedAt,
    error: c.error,
    result: c.result,
    createdAt: c.createdAt,
    shift: shift ? {
      id: shift.id, cashierName: shift.user.name, locationName: shift.location?.name ?? null,
      openedAt: shift.openedAt, closedAt: shift.closedAt, openingFloatCents: shift.openingFloatCents, closingFloatCents: shift.closingFloatCents,
    } : null,
    ...(drawer ? { drawer } : {}),
    items,
  }
}

/** The bills and open tickets of a closed drawer, each with what a correction may do to it. */
export async function shiftCandidates(shift: ShiftRow) {
  const { tenantId, businessDay } = shiftFacts(shift)
  const window = { gte: shift.openedAt, ...(shift.closedAt ? { lte: shift.closedAt } : {}) }
  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null, concept: { tenantId },
      OR: [
        { shiftId: shift.id },
        { payments: { some: { shiftId: shift.id } } },
        { shiftId: null, source: 'pos', posStaffId: shift.userId, placedAt: window },
      ],
    },
    select: ORDER_SELECT,
    orderBy: { placedAt: 'asc' },
    take: 500,
  })
  const pending = await prisma.shiftCorrection.findFirst({ where: { shiftId: shift.id, status: 'submitted' }, select: { id: true } })
  let booksClosed: { code: string; message: string } | null = null
  try { await assertBooksOpen(prisma, tenantId, shift.id, shiftBusinessDate(shift)!) } catch (e) {
    if (e instanceof AppError) booksClosed = { code: e.code, message: e.message }
    else throw e
  }
  const rows = []
  for (const o of orders) {
    const final = o.status === 'completed'
    const kind: ItemKind | null = final ? 'void_bill' : (OPEN_STATUSES as readonly string[]).includes(o.status) ? 'cancel_kot' : null
    let blockedBy: { code: string; message: string } | null = null
    if (!kind) blockedBy = { code: 'NOTHING_TO_CORRECT', message: `Order ${orderRefOf(o.id)} is ${o.status}` }
    else {
      try { await checkItem(prisma, shift, tenantId, { orderId: o.id, kind, reason: 'x'.repeat(MIN_REASON) }) } catch (e) {
        blockedBy = e instanceof AppError ? { code: e.code, message: e.message } : { code: 'ERROR', message: String((e as Error).message) }
      }
    }
    rows.push({
      orderId: o.id, orderRef: orderRefOf(o.id), brand: o.concept.name, status: o.status, source: o.source,
      placedAt: o.placedAt, completedAt: o.completedAt, totalCents: o.totalCents, taxCents: o.taxCents,
      settlementChannel: o.settlementChannel,
      tenders: o.payments.map((p) => ({ method: p.method, amountCents: p.amountCents, status: p.status, onThisDrawer: p.shiftId === shift.id })),
      lines: o.items.map((i) => ({ name: i.name, quantity: i.quantity, status: i.status })),
      kind, blockedBy,
    })
  }
  const d = await drawerExpectation(shift.id)
  return {
    shift: {
      id: shift.id, tenantId, businessDay, status: shift.status, cashierName: shift.user.name, locationName: shift.location?.name ?? null,
      openedAt: shift.openedAt, closedAt: shift.closedAt, openingFloatCents: shift.openingFloatCents, closingFloatCents: shift.closingFloatCents,
      expectedCents: d.expectedCents,
    },
    pendingCorrectionId: pending?.id ?? null,
    booksClosed,
    orders: rows,
  }
}

// ─── Decide ──────────────────────────────────────────────────────────────────

/** Claim the set for the CEO's decision (submitted → approved | rejected), conditionally. */
export async function claimDecision(id: string, to: 'approved' | 'rejected', actor: Actor, note: string | null): Promise<ShiftCorrection> {
  const now = new Date()
  const claimed = await prisma.shiftCorrection.updateMany({
    where: { id, status: 'submitted' },
    data: { status: to, decidedById: actor.id, decidedAt: now, decisionNote: note },
  })
  if (claimed.count === 0) throw new AppError('NOT_WAITING', 'This correction is no longer waiting for a decision — reload it', 409)
  return prisma.shiftCorrection.findUniqueOrThrow({ where: { id } })
}

/** Claim a failed set for another attempt (failed → approved), conditionally. */
export async function claimRetry(id: string): Promise<void> {
  const claimed = await prisma.shiftCorrection.updateMany({ where: { id, status: 'failed' }, data: { status: 'approved', error: null } })
  if (claimed.count === 0) throw new AppError('NOT_FAILED', 'Only a correction that failed to apply is retried — reload it', 409)
}

// ─── Apply ───────────────────────────────────────────────────────────────────

interface ApplyProgress {
  /** Does the set change what the drawer's close booked (money or a comp on it)? Fixed on the first attempt. */
  touchesBooks?: boolean
  reopenedDays: string[]
  /** The close revision reversed by this set (its sourceId), and its reversal entry. */
  reversed: { sourceId: string; entryId: string } | null
  /** The re-posted close (null until posted; 'nothing' when no activity remained). */
  reposted: { entryId: string | null; outcome: string } | null
  drawer?: { expectedCents: number; countedCents: number | null; varianceCents: number | null; varianceBeforeCents: number | null }
}

const asProgress = (v: unknown): ApplyProgress => {
  const p = (v && typeof v === 'object' ? v : {}) as Partial<ApplyProgress>
  return {
    ...(p.touchesBooks !== undefined ? { touchesBooks: p.touchesBooks } : {}),
    reopenedDays: p.reopenedDays ?? [], reversed: p.reversed ?? null, reposted: p.reposted ?? null,
    ...(p.drawer ? { drawer: p.drawer } : {}),
  }
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue

/**
 * Apply an approved set (status 'approved'). Never throws for a refused step:
 * the set ends `applied` or `failed` (with `error`); returns the final row.
 */
export async function applyCorrection(id: string, ceo: Actor): Promise<ShiftCorrection> {
  const c = await prisma.shiftCorrection.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { createdAt: 'asc' } } } })
  if (c.status !== 'approved') throw new AppError('NOT_APPROVED', 'Only an approved correction is applied', 409)
  const tenantId = c.tenantId
  const ref = c.id.slice(-8).toUpperCase()
  const why = `Shift correction ${ref}: ${c.reason}`.slice(0, 500)
  const progress = asProgress(c.result)
  const save = () => prisma.shiftCorrection.update({ where: { id }, data: { result: json(progress) } })

  try {
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: c.shiftId }, select: SHIFT_SELECT })
    const facts = shiftFacts(shift)
    if (facts.tenantId !== tenantId) throw new AppError('SHIFT_MOVED', 'This drawer no longer belongs to the correction\'s company', 409)
    await assertBooksOpen(prisma, tenantId, shift.id, facts.businessDate)

    const pending = c.items.filter((i) => !(i.result as { applied?: boolean } | null)?.applied)
    // Every fix still stands as it was checked — before anything moves.
    const orders = new Map<string, OrderRow>()
    for (const i of pending) orders.set(i.orderId, await checkItem(prisma, shift, tenantId, i))
    if (progress.drawer === undefined) {
      const d = await drawerExpectation(shift.id)
      progress.drawer = { expectedCents: d.expectedCents, countedCents: shift.closingFloatCents, varianceCents: null, varianceBeforeCents: shift.closingFloatCents == null ? null : shift.closingFloatCents - d.expectedCents }
    }

    // Does the set change what the close booked? (Money or a comp on this drawer.)
    const touchesBooks = progress.touchesBooks ?? [...orders.values()].some((o) => receiptsOf(o).some((p) => p.shiftId === shift.id))
    progress.touchesBooks = touchesBooks
    const live = touchesBooks && !progress.reposted ? (await liveRevision(tenantId, 'shift.close', shift.id)).live : null

    // a. The night audit's day lock (the business day, and the day the live close was booked on).
    const days = [...new Set([facts.businessDay, ...(live ? [fmtPktDate(live.entryDate)] : [])])]
    for (const day of days) {
      const lock = await dayLockOf(prisma, tenantId, new Date(`${day}T12:00:00+05:00`))
      if (!lock) continue
      const { reopenDay } = await import('../nightAudit/service.js')
      await reopenDay({ tenantId, day, actor: { id: ceo.id, role: ceo.role, email: ceo.email ?? null }, reason: why })
      progress.reopenedDays.push(day)
      await save()
    }

    // b. Reverse the drawer's live close, on its own date (the sale's business day).
    if (touchesBooks && live && !progress.reversed) {
      const r = await reverseJournalEntry(tenantId, 'shift.close', live.sourceId, why, { entryDate: live.entryDate, postedBy: ceo.id })
      progress.reversed = { sourceId: live.sourceId, entryId: r.entryId }
      await save()
    }

    // c. Each fix, through the one cancel engine.
    const { cancelOrder } = await import('../orders/service.js')
    const { enqueueFiscalRefundTx, kickFiscal } = await import('../../connectors/fiscal/outbox.js')
    for (const item of pending) {
      const o = orders.get(item.orderId)!
      const finalBill = item.kind === 'void_bill'
      let fiscal: { id: string; status: string; statusReason: string | null } | null = null
      const voidedPaymentIds: string[] = []
      await cancelOrder(o.id, {
        reason: `${finalBill ? 'Bill voided' : 'KOT cancelled'} by shift correction ${ref}: ${item.reason}`.slice(0, 500),
        actor: { id: ceo.id, email: ceo.email ?? null, tenantId },
        approverId: ceo.id,
        backdatedReason: c.reason,
        onlyFrom: (finalBill ? ['completed'] : [...OPEN_STATUSES]) as OrderStatus[],
        cookedFood: item.foodMade ? { wasteReason: 'cancelled_after_fire', wasteAll: true } : undefined,
        action: finalBill ? 'shift_correction.void_bill' : 'shift_correction.cancel_kot',
        metadata: { correctionId: c.id, itemId: item.id, moneyReturned: item.moneyReturned, foodMade: item.foodMade },
        shiftCorrection: {
          voidFinalBill: finalBill,
          returnAll: !item.foodMade,
          inTx: async (tx) => {
            const at = new Date()
            // Not a refund: the tenders were never right — voided, unless the money really went back.
            if (!item.moneyReturned) {
              const rows = await tx.payment.findMany({
                where: { orderId: o.id, status: { in: ['paid', 'pending'] } },
                select: { id: true, gatewayMeta: true, status: true },
              })
              for (const p of rows) {
                const meta = (p.gatewayMeta && typeof p.gatewayMeta === 'object' && !Array.isArray(p.gatewayMeta)) ? (p.gatewayMeta as Prisma.JsonObject) : {}
                const claimed = await tx.payment.updateMany({
                  where: { id: p.id, status: p.status },
                  data: {
                    status: 'failed',
                    gatewayMeta: { ...meta, voided: { reason: 'shift_correction', correctionId: c.id, at: at.toISOString(), by: ceo.id, was: p.status } },
                  },
                })
                if (claimed.count > 0) voidedPaymentIds.push(p.id)
              }
            }
            // The fiscal VOID of a filed (or queued) sale — once, keyed 'void:<orderId>'.
            if (finalBill) {
              const sale = await tx.fiscalDocument.findUnique({
                where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: `sale:${o.id}` } },
                select: { amountCents: true },
              })
              const doc = await enqueueFiscalRefundTx(tx, {
                orderId: o.id, tenantId, refundPaymentId: null,
                amountCents: sale?.amountCents ?? o.totalCents,
                reason: `Bill voided (human error) — shift correction ${ref}`,
              })
              fiscal = doc ? { id: doc.id, status: doc.status, statusReason: doc.statusReason } : null
            }
            // Parked in the Trash with the CEO's approval: never erasable, "Recover as copy" only.
            await moveToTrash(tx, { userId: ceo.id, actingTenantId: tenantId }, {
              type: TRASH_ORDERS.order, entityId: o.id, tenantId, conceptId: o.conceptId,
              title: `Order ${orderRefOf(o.id)} — PKR ${(o.totalCents / 100).toFixed(2)}`,
              subtitle: `${finalBill ? 'Bill voided' : 'KOT cancelled'} by shift correction ${ref}`,
              reason: item.reason, meta: { correctionId: c.id, kind: item.kind },
            })
            // The applied marker, with the cancel itself (a retry skips this fix).
            await tx.shiftCorrectionItem.update({
              where: { id: item.id },
              data: {
                result: json({
                  applied: true, at: at.toISOString(), fromStatus: o.status, voidedPaymentIds,
                  moneyOwedBackCents: item.moneyReturned ? receiptsOf(o).filter((p) => p.method !== 'comp').reduce((t, p) => t + p.amountCents, 0) : 0,
                  fiscal,
                }),
              },
            })
          },
        },
      })
      const done = await prisma.shiftCorrectionItem.findUniqueOrThrow({ where: { id: item.id }, select: { result: true } })
      if (!(done.result as { applied?: boolean } | null)?.applied) {
        throw new AppError('ORDER_MOVED_ON', `Order ${orderRefOf(o.id)} changed while the correction was applied — reload and retry`, 409, { orderId: o.id })
      }
      const f = fiscal as { id: string; status: string } | null
      if (f?.status === 'pending') void kickFiscal(f.id)
    }

    // d. Re-post the close from the same function as a normal close.
    if (touchesBooks && !progress.reposted) {
      const entry = await buildShiftCloseEntry(shift.id)
      if (!entry.ok) {
        if (entry.reason !== 'no_postable_activity') throw new AppError('CLOSE_NOT_REPOSTED', `The drawer's close could not be rebuilt (${entry.reason})`, 422)
        progress.reposted = { entryId: null, outcome: 'nothing' }
      } else {
        if (entry.debits !== entry.credits) {
          throw new AppError('CLOSE_UNBALANCED', `The drawer's recomputed close does not balance (debits ${entry.debits}, credits ${entry.credits})`, 422)
        }
        const r = await syncSourcePosting({
          tenantId, sourceType: 'shift.close', id: shift.id,
          desired: { description: `POS shift ${shift.id.slice(0, 8)} closeout — corrected (shift correction ${ref})`, entryDate: entry.entryDate, lines: entry.lines },
          postedBy: ceo.id, reason: why,
        })
        progress.reposted = { entryId: r.entryId, outcome: r.outcome }
      }
      await save()
      await resolvePostingFailed('Shift', shift.id, 'shift.close', `Re-posted by shift correction ${ref}.`, { tenantIds: [tenantId] })
    }

    const d = await drawerExpectation(shift.id)
    progress.drawer = {
      ...progress.drawer!,
      expectedCents: d.expectedCents,
      varianceCents: shift.closingFloatCents == null ? null : shift.closingFloatCents - d.expectedCents,
    }
    const applied = await prisma.shiftCorrection.update({
      where: { id }, data: { status: 'applied', appliedAt: new Date(), error: null, result: json(progress) },
    })
    await audit({
      category: 'accounting', action: 'shift_correction.applied', entity: 'ShiftCorrection', entityId: id,
      userId: ceo.id, userEmail: ceo.email ?? null, tenantId,
      before: { status: 'approved' }, after: { status: 'applied' },
      metadata: { actorRole: ceo.role, shiftId: c.shiftId, businessDay: c.businessDay, ...progress, items: c.items.map((i) => ({ orderId: i.orderId, kind: i.kind })) },
    })
    notifyOutcome(applied, ceo.id, 'applied')
    return applied
  } catch (e) {
    const message = e instanceof AppError ? `${e.code}: ${e.message}` : (e as Error).message
    const failed = await prisma.shiftCorrection.update({
      where: { id }, data: { status: 'failed', error: message.slice(0, 1000), result: json(progress) },
    })
    // A close taken off the books and not yet put back is never silent: it blocks the month close until the retry posts it.
    if (progress.reversed && !progress.reposted) {
      await flagPostingFailed({
        tenantId, sourceType: 'shift.close', sourceId: c.shiftId, entityType: 'Shift', entityId: c.shiftId,
        reason: `Shift correction ${ref} reversed this drawer's close and stopped before re-posting it: ${message}`.slice(0, 900),
        title: 'Corrected drawer close not re-posted — retry the shift correction',
        actorId: ceo.id,
        metadata: { correctionId: id, documentDate: shiftBusinessDateIso(c.businessDay) },
      })
    }
    await audit({
      category: 'accounting', action: 'shift_correction.failed', entity: 'ShiftCorrection', entityId: id,
      userId: ceo.id, userEmail: ceo.email ?? null, tenantId,
      after: { status: 'failed' }, metadata: { actorRole: ceo.role, error: message.slice(0, 500), ...progress },
    })
    notifyOutcome(failed, ceo.id, 'failed')
    return failed
  }
}

const shiftBusinessDateIso = (day: string) => `${day}T23:59:59.999+05:00`

/** Finance (with accounting) of the shift's company + the requester: applied / failed. Queued, never throws. */
function notifyOutcome(c: ShiftCorrection, actorId: string, outcome: 'applied' | 'failed'): void {
  queueStaffNotify(async () => {
    const ids = [...new Set([...(await financeOf(c.tenantId)), c.requestedById])].filter((u) => u && u !== actorId)
    if (ids.length === 0) return
    const ref = c.id.slice(-8).toUpperCase()
    await notifyStaffMany(ids.map((userId) => ({
      userId, tenantId: c.tenantId, kind: 'shift_correction.applied' as const,
      severity: outcome === 'applied' ? 'success' as const : 'warning' as const,
      title: outcome === 'applied'
        ? `Shift correction ${ref} applied (drawer ${c.shiftId.slice(-8).toUpperCase()}, ${c.businessDay})`
        : `Shift correction ${ref} could not be applied — the CEO retries it`,
      body: outcome === 'failed' ? (c.error ?? null) : null,
      link: `/finance/shift-corrections?id=${encodeURIComponent(c.id)}`,
      entityType: 'ShiftCorrection', entityId: c.id, actorId,
      dedupeKey: `shift_correction.${outcome}:${c.id}:${c.updatedAt.toISOString()}`,
    })))
  })
}

export async function loadCorrection(db: Db, id: string, tenantWhere: Prisma.ShiftCorrectionWhereInput): Promise<CorrectionWithItems> {
  const c = await db.shiftCorrection.findFirst({ where: { id, ...tenantWhere }, include: { items: { orderBy: { createdAt: 'asc' } } } })
  if (!c) throw new NotFoundError('ShiftCorrection', id)
  return c
}

export { SHIFT_SELECT, SHIFT_COMPANY_INCLUDE }
export type { ShiftRow }
