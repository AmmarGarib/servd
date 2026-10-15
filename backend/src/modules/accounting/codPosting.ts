// Cash on delivery a rider has not handed in — the rider's debt (H5).
//
// The accountant's rule (Hasnain, H5): delivered COD money a rider has not
// paid in is a RECEIVABLE FROM THE RIDER on 1351. The sale itself was booked
// at completion ('order.complete:<orderId>' — the cash as if on hand, 1010);
// finance books the rider's debt by moving that cash out of 1010:
//
//   • OWN rider (rider.tenantId = the order's company, or a rider with no
//     company — the pre-multi-company rows): one entry in the order's company,
//     'cod.rider_debt:<paymentId>'  Dr 1351 / Cr 1010, the order's brand on both
//     lines, codRiderDebtEntryId.
//   • FLEET rider of another company P on an order of client C (H30): an
//     inter-company system transfer, source 'cod', sourceRef 'cod:<paymentId>':
//     P (debtor) Dr 1351 / Cr Due to C; C (creditor) Dr Due from P / Cr 1010.
//     The rider is P's person, so P holds the receivable and owes C the cash.
//     Only someone who belongs to BOTH companies books it (403
//     NOT_IN_BOTH_COMPANIES). codRiderDebtTransferId.
//
// When the rider hands the cash in, settlePayment (pos/service.ts) reverses
// the debt: own rider → 'cod.rider_debt.reversal:<paymentId>' Dr 1010 / Cr 1351
// inside the pay-in transaction (reverseCodRiderDebtTx); fleet rider →
// reverseSystemTransfer after commit (reverseCodRiderDebtAfterCommit). A
// reversal the ledger refused is flagged posting_failed 'cod.rider_debt.reversal'
// and re-posted by codRiderDebtReversalReposter (reconciliation/backfillOrders.ts).
//
// The whole module ships OFF: a company's COD custody is live only while its
// code-only delivery switch is on (lib/deliveryRules.ts); otherwise booking a
// debt is 409 COD_CUSTODY_OFF and today's books are untouched.
//
// TODO(G1-writeoff): COD that is never paid in (the rider leaves, the cash is
// lost) is owner/CA decision G1 — PARKED. When answered, the write-off of a
// 1351 balance goes here (CEO-approved, like every other bad-debt write-off),
// never as a manual journal.

import type { Prisma } from '@prisma/client'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { isRiderCod } from '../../lib/cod.js'
import { DELIVERY_CODE_ONLY_SETTING } from '../../lib/deliveryRules.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { isMemberOfBoth, memberTenantIdsOf } from '../../lib/companyPairs.js'
import { flagException } from '../../lib/exceptions.js'
import { ACCT, postJournalEntry, reverseJournalEntry, type JournalLineInput } from './journal.js'
import { lockOrderTx } from '../pos/service.js'
import { commonOpenPlacement, postSystemTransferTx, reverseSystemTransfer } from '../intercompany/service.js'
import type { Reposter, RefusedDoc } from '../reconciliation/backfillOrders.js'

type Tx = Prisma.TransactionClient

/** The rider's receivable (H5). TODO(H5): the accountant may later want one sub-account per rider. */
export const RIDER_COD_ACCOUNT = ACCT.RIDER_COD_RECEIVABLE
/** Where the COD sale left the cash at completion. */
export const COD_CASH_ACCOUNT = ACCT.CASH_ON_HAND

export const COD_DEBT_SOURCE = 'cod.rider_debt'
/** reverseJournalEntry's default suffix — the reversal's key is 'cod.rider_debt.reversal:<paymentId>'. */
export const COD_DEBT_REVERSAL_SOURCE = `${COD_DEBT_SOURCE}.reversal`
export const COD_TRANSFER_SOURCE_REF = (paymentId: string) => `cod:${paymentId}`
export const COD_PAID_IN_REASON = 'Rider handed the cash in'

/**
 * COD delivered before code-only delivery existed (staff "Delivered", no
 * customer code) may be booked by the legacy path. The cut-off is the later of
 * this release and the moment the company switched code-only delivery on.
 */
export const COD_CODE_RULE_RELEASE = new Date('2026-10-15T00:00:00+05:00')
/** Who may book a legacy (no-code) COD debt. */
export const LEGACY_COD_ROLES: readonly string[] = ['admin', 'finance']
const LEGACY_MIN_REASON = 10
const MIN_REASON = 5

const TX_OPTS = { timeout: 30_000, maxWait: 10_000 } as const

export interface CodActor { id: string; role: string; memberTenantIds: string[] }

export interface BookCodRiderDebtInput {
  paymentId: string
  actor: CodActor
  reason: string
  legacy?: boolean
}

export interface BookCodRiderDebtResult {
  ok: true
  entryId?: string
  transferId?: string
  alreadyBooked?: boolean
}

/** When a company switched code-only delivery on, or null when it is off. */
async function codeOnlySince(db: Tx, tenantId: string): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: `${DELIVERY_CODE_ONLY_SETTING}:${tenantId}` }, select: { value: true } })
  if (!row) return null
  const at = new Date(String(row.value))
  return Number.isNaN(at.getTime()) ? COD_CODE_RULE_RELEASE : at
}

const PAYMENT_SELECT = {
  id: true, method: true, status: true, amountCents: true, createdAt: true,
  codRiderDebtAt: true, codRiderDebtEntryId: true, codRiderDebtTransferId: true,
  order: {
    select: {
      id: true, source: true, status: true, fulfilmentType: true, riderId: true, conceptId: true,
      deliveryOtpVerifiedAt: true, completedAt: true, deliveredAt: true,
      concept: { select: { tenantId: true, name: true } },
      rider: { select: { id: true, name: true, tenantId: true } },
    },
  },
} satisfies Prisma.PaymentSelect

type LoadedPayment = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>

const already = (p: { codRiderDebtEntryId: string | null; codRiderDebtTransferId: string | null }): BookCodRiderDebtResult => ({
  ok: true, alreadyBooked: true,
  ...(p.codRiderDebtEntryId ? { entryId: p.codRiderDebtEntryId } : {}),
  ...(p.codRiderDebtTransferId ? { transferId: p.codRiderDebtTransferId } : {}),
})

/** The rider's company, as the posting sees it: null (no company) counts as the order's own. */
function isFleetRider(p: LoadedPayment, orderTenant: string): { fleet: false } | { fleet: true; providerTenantId: string } {
  const rt = p.order.rider?.tenantId ?? null
  return rt && rt !== orderTenant ? { fleet: true, providerTenantId: rt } : { fleet: false }
}

interface Checked {
  p: LoadedPayment
  orderTenant: string
  riderName: string
  legacyUsed: boolean
}

/**
 * Every precondition, inside the booking transaction after the order lock.
 * Returns the already-booked result on a replay.
 */
async function checkInTx(tx: Tx, a: BookCodRiderDebtInput, reason: string, expectFleet: boolean): Promise<Checked | BookCodRiderDebtResult> {
  const p = await tx.payment.findUnique({ where: { id: a.paymentId }, select: PAYMENT_SELECT })
  if (!p) throw new NotFoundError('Payment not found')
  if (p.codRiderDebtAt) return already(p)
  const o = p.order
  if (p.method !== 'cash' || p.amountCents <= 0 || o.source === 'pos') {
    throw new AppError('NOT_CASH_ON_DELIVERY', 'Only cash on delivery from an online order can be booked as owed by the rider', 422)
  }
  if (p.status !== 'pending') {
    throw new AppError('COD_ALREADY_PAID', `This cash is already ${p.status === 'paid' ? 'paid in' : p.status} — nothing is owed by the rider`, 409)
  }
  if (o.status !== 'completed') {
    throw new AppError('ORDER_NOT_COMPLETED', `The order is ${o.status}, not completed — only delivered cash can be owed by the rider`, 409)
  }
  if (!isRiderCod(o) || !o.rider) {
    throw new AppError('NO_RIDER', 'This is not a delivery a rider carried (a pickup or counter payment) — it cannot be owed by a rider', 422)
  }
  const orderTenant = o.concept.tenantId
  if (!orderTenant) throw new AppError('NO_COMPANY', "The order's brand has no company — fix the brand first", 422)
  if (isFleetRider(p, orderTenant).fleet !== expectFleet) {
    throw new AppError('RIDER_CHANGED', 'The rider on this order changed while booking — try again', 409)
  }

  const since = await codeOnlySince(tx, orderTenant)
  if (!since) {
    throw new AppError('COD_CUSTODY_OFF', "Cash-on-delivery custody is not switched on for this order's company (code-only delivery is off)", 409)
  }

  let legacyUsed = false
  if (!o.deliveryOtpVerifiedAt) {
    const cutoff = since > COD_CODE_RULE_RELEASE ? since : COD_CODE_RULE_RELEASE
    const completed = o.completedAt ?? p.createdAt
    if (!a.legacy || completed >= cutoff) {
      throw new AppError(
        'COD_NOT_DELIVERED_WITH_CODE',
        completed < cutoff
          ? 'This delivery was completed without the customer\'s code (before code-only delivery) — book it with "legacy" and a reason (finance or the CEO)'
          : 'This delivery was not completed with the customer\'s code — it cannot be booked as owed by the rider',
        409,
      )
    }
    if (!LEGACY_COD_ROLES.includes(a.actor.role)) {
      throw new AppError('LEGACY_NEEDS_FINANCE', 'Only finance or the CEO books cash from a delivery completed without the customer\'s code', 403)
    }
    if (reason.length < LEGACY_MIN_REASON) {
      throw new AppError('REASON_TOO_SHORT', `Say why (at least ${LEGACY_MIN_REASON} characters) — this delivery has no customer code`, 422)
    }
    legacyUsed = true
  }

  const sale = await tx.journalEntry.findFirst({
    where: { tenantId: orderTenant, reference: `order.complete:${o.id}` },
    select: { id: true },
  })
  if (!sale) {
    throw new AppError('COD_SALE_NOT_BOOKED', 'The sale is not on the books yet — post it first (Reconciliation → Backfill unposted), then book the rider\'s debt', 409)
  }
  return { p, orderTenant, riderName: o.rider.name, legacyUsed }
}

/** Claim the payment for the debt (once). A lost race is a replay or a pay-in. */
async function claimInTx(tx: Tx, paymentId: string, actorId: string): Promise<BookCodRiderDebtResult | null> {
  const claim = await tx.payment.updateMany({
    where: { id: paymentId, codRiderDebtAt: null, status: 'pending' },
    data: { codRiderDebtAt: new Date(), codRiderDebtById: actorId },
  })
  if (claim.count === 1) return null
  const now = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { codRiderDebtAt: true, codRiderDebtEntryId: true, codRiderDebtTransferId: true } })
  if (now.codRiderDebtAt) return already(now)
  throw new AppError('COD_ALREADY_PAID', 'This cash was paid in while booking — nothing is owed by the rider', 409)
}

async function auditInTx(tx: Tx, c: Checked, a: BookCodRiderDebtInput, reason: string, after: Record<string, unknown>): Promise<void> {
  await tx.auditLog.create({
    data: {
      category: 'accounting',
      tenantId: c.orderTenant,
      action: c.legacyUsed ? 'cod.rider_debt.book_legacy' : 'cod.rider_debt.book',
      entity: 'Payment',
      entityId: c.p.id,
      userId: a.actor.id,
      before: { codRiderDebtAt: null },
      after: after as Prisma.InputJsonObject,
      metadata: {
        reason, orderId: c.p.order.id, riderId: c.p.order.riderId, amountCents: c.p.amountCents, legacy: c.legacyUsed,
      },
    },
  })
}

function describe(c: Checked, reason: string): string {
  const o = c.p.order
  return `Cash on delivery not handed in by rider ${c.riderName}: order ${orderRefOf(o.id)} (${o.id}) — ${reason}`.slice(0, 500)
}

/**
 * Book a delivered COD payment as owed by its rider. Finance (or the CEO /
 * owner / management) does it from Reconciliation → Cash on delivery.
 * Idempotent: a replay returns { alreadyBooked: true } and posts nothing.
 */
export async function bookCodRiderDebt(a: BookCodRiderDebtInput): Promise<BookCodRiderDebtResult> {
  const reason = (a.reason ?? '').trim()
  if (reason.length < MIN_REASON) throw new AppError('REASON_REQUIRED', `Say why (at least ${MIN_REASON} characters)`, 422)

  // Which path (own / fleet) and the membership rule, before any lock. Re-checked in the transaction.
  const pre = await serviceClient.payment.findUnique({ where: { id: a.paymentId }, select: PAYMENT_SELECT })
  if (!pre) throw new NotFoundError('Payment not found')
  if (pre.codRiderDebtAt) return already(pre)
  const orderTenant = pre.order.concept.tenantId
  if (!orderTenant) throw new AppError('NO_COMPANY', "The order's brand has no company — fix the brand first", 422)
  const path = isFleetRider(pre, orderTenant)

  let legacyNote: { c: Checked } | null = null
  let result: BookCodRiderDebtResult

  if (!path.fleet) {
    result = await prisma.$transaction(async (tx) => {
      await lockOrderTx(tx, pre.order.id)
      const c = await checkInTx(tx, a, reason, false)
      if (!('p' in c)) return c
      const replay = await claimInTx(tx, a.paymentId, a.actor.id)
      if (replay) return replay

      await assertTemplateAccounts(tx, c.orderTenant, [RIDER_COD_ACCOUNT, COD_CASH_ACCOUNT])
      const conceptId = c.p.order.conceptId
      const memo = `COD order ${orderRefOf(c.p.order.id)} (${c.p.order.id}) — rider ${c.riderName}`.slice(0, 250)
      const lines: JournalLineInput[] = [
        { accountCode: RIDER_COD_ACCOUNT, type: 'debit', amountCents: c.p.amountCents, memo, conceptId },
        { accountCode: COD_CASH_ACCOUNT, type: 'credit', amountCents: c.p.amountCents, memo, conceptId },
      ]
      const dr = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
      const cr = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
      if (dr !== cr) throw new AppError('JOURNAL_UNBALANCED', `COD rider debt ${a.paymentId}: debits ${dr} ≠ credits ${cr}`, 500)

      const posted = await postJournalEntry({
        tenantId: c.orderTenant,
        sourceType: COD_DEBT_SOURCE,
        sourceId: a.paymentId,
        description: describe(c, reason),
        postedBy: a.actor.id,
        lines,
      }, { tx })
      await tx.payment.update({ where: { id: a.paymentId }, data: { codRiderDebtEntryId: posted.entryId } })
      await auditInTx(tx, c, a, reason, { codRiderDebtEntryId: posted.entryId, account: RIDER_COD_ACCOUNT })
      if (c.legacyUsed) legacyNote = { c }
      return { ok: true as const, entryId: posted.entryId }
    }, TX_OPTS)
  } else {
    const P = path.providerTenantId
    if (!isMemberOfBoth(a.actor, P, orderTenant)) {
      throw new AppError(
        'NOT_IN_BOTH_COMPANIES',
        "This rider belongs to another company (shared fleet) — a finance user of both companies books a fleet rider's cash on delivery",
        403,
      )
    }
    result = await serviceClient.$transaction(async (tx) => {
      await lockOrderTx(tx, pre.order.id)
      const c = await checkInTx(tx, a, reason, true)
      if (!('p' in c)) return c
      const replay = await claimInTx(tx, a.paymentId, a.actor.id)
      if (replay) return replay

      await assertTemplateAccounts(tx, P, [RIDER_COD_ACCOUNT])
      await assertTemplateAccounts(tx, c.orderTenant, [COD_CASH_ACCOUNT])
      const ref = orderRefOf(c.p.order.id)
      const place = await commonOpenPlacement(tx, [P, c.orderTenant], new Date(), `the cash-on-delivery debt of order ${ref}`)
      if ('lockedThroughToday' in place) {
        throw new AppError('PERIOD_LOCKED', 'The books of one of the two companies are closed through today — nothing can be booked until today is open', 422, { tenantId: place.tenantId })
      }
      const t = await postSystemTransferTx(tx, {
        kind: 'charge',
        source: 'cod',
        sourceRef: COD_TRANSFER_SOURCE_REF(a.paymentId),
        debtorTenantId: P,
        creditorTenantId: c.orderTenant,
        amountCents: c.p.amountCents,
        entryDate: place.entryDate,
        debtorAccountCode: RIDER_COD_ACCOUNT,
        creditorAccountCode: COD_CASH_ACCOUNT,
        memo: describe(c, reason),
        preparedById: a.actor.id,
        ...(place.memoNote ? { memoNote: place.memoNote } : {}),
      })
      await tx.payment.update({ where: { id: a.paymentId }, data: { codRiderDebtTransferId: t.transferId } })
      await auditInTx(tx, c, a, reason, { codRiderDebtTransferId: t.transferId, providerTenantId: P, account: RIDER_COD_ACCOUNT })
      if (c.legacyUsed) legacyNote = { c }
      return { ok: true as const, transferId: t.transferId }
    }, TX_OPTS)
  }

  // A legacy booking leaves a note in the order company's exception inbox
  // (after commit: flagException writes on its own connection).
  const note = legacyNote as { c: Checked } | null
  if (note) {
    const { c } = note
    await flagException({
      tenantId: c.orderTenant,
      kind: 'cod_cash_overdue',
      severity: 'low',
      title: 'Cash on delivery booked to the rider without a customer code',
      description: `Order ${orderRefOf(c.p.order.id)}: delivered before code-only delivery (no customer code). `
        + `Booked as owed by rider ${c.riderName} by the legacy path — ${reason}`.slice(0, 900),
      entityType: 'Payment',
      entityId: c.p.id,
      conceptId: c.p.order.conceptId,
      actorId: a.actor.id,
      amountCents: c.p.amountCents,
      metadata: { legacy: true, orderId: c.p.order.id, reason },
    })
  }
  return result
}

// ─── Reversal: the rider handed the cash in ─────────────────────────────────

/**
 * Inside the pay-in transaction (settlePayment, after the pending → paid
 * claim). Own rider: posts 'cod.rider_debt.reversal:<paymentId>' Dr 1010 /
 * Cr 1351 in `tenantId` (the order's company) — idempotent. Fleet rider:
 * nothing here; `needsAfterCommit` tells the caller to run
 * reverseCodRiderDebtAfterCommit once its transaction has committed.
 * A refusal (e.g. PERIOD_LOCKED) throws: the caller runs this in a savepoint
 * and flags posting_failed 'cod.rider_debt.reversal'.
 */
export async function reverseCodRiderDebtTx(
  tx: Tx,
  a: { paymentId: string; tenantId: string },
  o: { entryDate?: Date; postedBy?: string } = {},
): Promise<{ reversed: boolean; needsAfterCommit: boolean }> {
  const p = await tx.payment.findUnique({
    where: { id: a.paymentId },
    select: { codRiderDebtAt: true, codRiderDebtEntryId: true, codRiderDebtTransferId: true },
  })
  if (!p || !p.codRiderDebtAt) return { reversed: false, needsAfterCommit: false }
  if (p.codRiderDebtTransferId) {
    const t = await tx.intercompanyTransfer.findUnique({ where: { id: p.codRiderDebtTransferId }, select: { status: true } })
    return { reversed: false, needsAfterCommit: t?.status === 'posted' }
  }
  if (!p.codRiderDebtEntryId) return { reversed: false, needsAfterCommit: false }
  const r = await reverseJournalEntry(a.tenantId, COD_DEBT_SOURCE, a.paymentId, COD_PAID_IN_REASON, {
    tx, postedBy: o.postedBy ?? 'system', ...(o.entryDate ? { entryDate: o.entryDate } : {}),
  })
  return { reversed: r.posted, needsAfterCommit: false }
}

/** After the pay-in committed: reverse a fleet rider's COD transfer in both books (idempotent). */
export async function reverseCodRiderDebtAfterCommit(paymentId: string, o: { entryDate?: Date } = {}): Promise<void> {
  const p = await serviceClient.payment.findUnique({ where: { id: paymentId }, select: { codRiderDebtTransferId: true } })
  if (!p?.codRiderDebtTransferId) return
  await reverseSystemTransfer(p.codRiderDebtTransferId, COD_PAID_IN_REASON, o.entryDate ? { entryDate: o.entryDate } : {})
}

/** Why a reversal is not owed (the reposter's nothingToPost). */
const NOTHING = { payment_not_found: 'payment_not_found', no_debt: 'no_debt', not_paid_in: 'not_paid_in', already_reversed: 'already_reversed' } as const
const PAID_IN: ReadonlySet<string> = new Set(['paid', 'refunded'])

/**
 * Reverse a booked rider debt whose cash has been handed in (the re-poster's
 * path; also safe to call any time — it never reverses a debt still owed).
 */
export async function reverseCodRiderDebt(
  paymentId: string,
  o: { entryDate?: Date; postedBy?: string } = {},
): Promise<{ reversed: boolean; entryId?: string | null; reason?: string }> {
  const p = await serviceClient.payment.findUnique({
    where: { id: paymentId },
    select: {
      status: true, codRiderDebtAt: true, codRiderDebtEntryId: true, codRiderDebtTransferId: true,
      order: { select: { concept: { select: { tenantId: true } } } },
    },
  })
  if (!p) return { reversed: false, reason: NOTHING.payment_not_found }
  if (!p.codRiderDebtAt || (!p.codRiderDebtEntryId && !p.codRiderDebtTransferId)) return { reversed: false, reason: NOTHING.no_debt }
  if (!PAID_IN.has(p.status)) return { reversed: false, reason: NOTHING.not_paid_in }
  const tenantId = p.order.concept.tenantId
  if (!tenantId) return { reversed: false, reason: 'no_company' }

  if (p.codRiderDebtTransferId) {
    const t = await serviceClient.intercompanyTransfer.findUnique({
      where: { id: p.codRiderDebtTransferId }, select: { id: true, status: true, tenantId: true, counterpartyTenantId: true },
    })
    if (!t || t.status === 'reversed') return { reversed: false, reason: NOTHING.already_reversed }
    // A person re-posting it must belong to both companies (both books move).
    if (o.postedBy && o.postedBy !== 'system') {
      const mine = await memberTenantIdsOf(o.postedBy)
      if (!isMemberOfBoth({ id: o.postedBy, memberTenantIds: mine }, t.tenantId, t.counterpartyTenantId)) {
        return { reversed: false, reason: 'not_in_both_companies' }
      }
    }
    await reverseSystemTransfer(t.id, COD_PAID_IN_REASON, o.entryDate ? { entryDate: o.entryDate } : {})
    const e = await serviceClient.journalEntry.findFirst({
      where: { tenantId, reference: `ic.transfer.reversal:${t.id}` }, select: { id: true },
    })
    return { reversed: true, entryId: e?.id ?? null }
  }

  const done = await serviceClient.journalEntry.findFirst({
    where: { tenantId, reference: `${COD_DEBT_REVERSAL_SOURCE}:${paymentId}` }, select: { id: true },
  })
  if (done) return { reversed: false, entryId: done.id, reason: NOTHING.already_reversed }
  const r = await serviceClient.$transaction(
    (tx) => reverseCodRiderDebtTx(tx, { paymentId, tenantId }, o),
    TX_OPTS,
  )
  const e = await serviceClient.journalEntry.findFirst({
    where: { tenantId, reference: `${COD_DEBT_REVERSAL_SOURCE}:${paymentId}` }, select: { id: true },
  })
  return { reversed: r.reversed, entryId: e?.id ?? null }
}

/**
 * The re-poster of a refused reversal (flag posting_failed, entityType
 * 'Payment', metadata.sourceType 'cod.rider_debt.reversal'). The orchestrator
 * registers it in reconciliation/backfillOrders.ts REPOSTERS under
 * 'cod.rider_debt.reversal'. multiPost: a fleet rider's reversal lives under
 * the transfer's own key, so the payment's state decides (load).
 */
export const codRiderDebtReversalReposter: Reposter = {
  entityType: 'Payment',
  title: "A rider's cash-on-delivery pay-in did not clear the rider's debt",
  multiPost: true,
  nothingToPost: new Set(Object.values(NOTHING)),
  load: async (paymentId): Promise<RefusedDoc | null> => {
    const p = await serviceClient.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true, status: true, amountCents: true, processedAt: true,
        codRiderDebtAt: true, codRiderDebtEntryId: true, codRiderDebtTransferId: true,
        order: { select: { id: true, concept: { select: { tenantId: true } } } },
      },
    })
    if (!p) return null
    const tenantId = p.order.concept.tenantId
    let nothingOwed: string | undefined
    if (!p.codRiderDebtAt || (!p.codRiderDebtEntryId && !p.codRiderDebtTransferId)) {
      nothingOwed = 'No rider debt was booked on this payment — nothing to reverse.'
    } else if (!PAID_IN.has(p.status)) {
      nothingOwed = 'The rider has not handed this cash in yet — the debt stays until they do.'
    } else if (p.codRiderDebtTransferId) {
      const t = await serviceClient.intercompanyTransfer.findUnique({ where: { id: p.codRiderDebtTransferId }, select: { status: true } })
      if (!t || t.status === 'reversed') nothingOwed = "The fleet rider's transfer is already reversed — nothing to post."
    } else if (tenantId && await serviceClient.journalEntry.findFirst({
      where: { tenantId, reference: `${COD_DEBT_REVERSAL_SOURCE}:${paymentId}` }, select: { id: true },
    })) {
      nothingOwed = "The rider's debt is already reversed — nothing to post."
    }
    return {
      tenantId,
      date: p.processedAt ?? null,
      orderId: p.order.id,
      what: `Rider debt on order ${orderRefOf(p.order.id)} cleared by the pay-in`,
      amountCents: p.amountCents,
      ...(nothingOwed ? { nothingOwed } : {}),
      post: async (opts) => {
        const r = await reverseCodRiderDebt(paymentId, { entryDate: opts.entryDate, postedBy: opts.postedBy })
        return { posted: r.reversed, entryId: r.entryId ?? null, ...(r.reason ? { reason: r.reason } : {}) }
      },
    }
  },
}
