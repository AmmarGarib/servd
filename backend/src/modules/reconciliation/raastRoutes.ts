// Finance → Reconciliation → Raast (spec §7.2; amendments M4, S3).
// Registered from reconciliationRoutes at /reconciliation/raast, so the
// module gate is 'reconciliation' (no GATED_PREFIXES change — spec D7).
//
//   GET   /receipts                  the Raast receipts with totals by status
//   GET   /receipts/:id/candidates   unmatched statement lines that could be
//                                    it (+ S3's SUGGESTED line — finance
//                                    confirms it; nothing is matched here)
//   POST  /receipts/:id/match        match to a statement line (FINANCE_TEAM)
//   POST  /receipts/:id/unmatch      undo a match (APPROVERS)
//   PATCH /receipts/:id/reference    fix a typed reference (APPROVERS — M4)
//   POST  /receipts/:id/unreceived   write off as never received (APPROVERS;
//                                    contra by default "the customer owes
//                                    it" = the company's till clearing,
//                                    resolved server-side: 1110 before the
//                                    CEO's cut-over, 1115 after; 8010 loss;
//                                    1350 staff owes)
//   POST  /receipts/:id/resolve      clear a needs-attention receipt whose
//                                    bill is closed (APPROVERS — RV-FIN-1)
//   POST  /receipts/:id/void-request ask the CEO to void a receipt whose sale
//                                    was never booked (admin, owner,
//                                    management, finance — RV-MONEY-1)
//   POST  /receipts/:id/void         the CEO voids it — no ledger entry
//                                    (ADMIN_ONLY; with or without a request)
//   POST  /receipts/:id/void-request/reject  the CEO turns the ask down
//                                    (ADMIN_ONLY)
//   POST  /rematch                   re-run the reference pass (FINANCE_TEAM)
//   GET   /alerts                    the bank SMS log, incl. unparsed bodies
//
// Each receipt row carries the CALLER's capability flags (canMatch,
// canUnmatch, canFixReference, canWriteOff, canResolve, canVoid,
// canRequestVoid, canRejectVoidRequest) — the admin page shows buttons from
// them, never from a role list of its own.
//
// Company scope: reads are view-aware (resolveTenantScope / scopeTenantWhere
// 'read'); acting on a receipt needs it in the operator's write scope (a
// foreign id is 404); a statement line of another company or bank account
// never matches (422). Every write is on the books' audit trail
// ('raast.receipt.*'); the void's three actions are stamped with the
// RECEIPT's company.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Prisma, RaastReceiptStatus, BankSmsAlertStatus, UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCE_TEAM, APPROVERS, ADMIN_ONLY } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, activeTenantId } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { toCents } from '../../lib/money.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { auditApproval } from '../../lib/approvalRights.js'
import { queueStaffNotify, notifyStaffMany } from '../../lib/staffNotify.js'
import { approvalWaiting } from '../approvals/notify.js'
import { normalizeBankRef, refInText } from '../../connectors/raast/reference.js'
import { reportDateRange } from '../reports/service.js'
import {
  matchReceiptToLine, unmatchReceipt, writeOffUnreceived, fixReceiptReference, rematchRaast, resolveAttentionReceipt,
  raastFinanceSettings, receiptAt, pktDay, earliestLineDay, WRITE_OFF_CONTRAS, ATTENTION_OUTCOMES,
  raastVoidEligibilityTx, requestRaastVoid, rejectRaastVoidRequest, voidNeverBooked, RAAST_VOID_REQUESTERS,
  type RaastVoidRefusal,
} from './raast.js'

const RECEIPT_STATUSES = ['awaiting', 'provisional', 'matched', 'cancelled', 'unreceived', 'needs_attention', 'voided'] as const
/** What the Raast tab lists by default: everything that took (or may have taken) money. */
const FINANCE_DEFAULT: RaastReceiptStatus[] = ['provisional', 'needs_attention', 'matched', 'unreceived', 'voided']
/** Bills a receipt can be voided on (RV-MONEY-1). */
const VOIDABLE_ORDER_STATUSES = new Set(['cancelled', 'rejected'])
const ALERT_STATUSES = ['received', 'processing', 'unparsed', 'off', 'debit', 'duplicate', 'matched', 'confirmed', 'unmatched', 'ambiguous', 'needs_attention', 'attached', 'dismissed'] as const

const DAY_MS = 86_400_000

const last4 = (b: { accountNumber: string | null; iban: string | null }) => {
  const s = String(b.accountNumber ?? b.iban ?? '').replace(/[^0-9A-Za-z]/g, '')
  return s ? s.slice(-4) : null
}

const RECEIPT_INCLUDE = {
  bankAccount: { select: { id: true, name: true, bankName: true, accountNumber: true, iban: true } },
  statementLine: { select: { id: true, importId: true, postedDate: true, description: true, reference: true, amountCents: true } },
  order: { select: { status: true, concept: { select: { id: true, name: true } } } },
} satisfies Prisma.RaastReceiptInclude

type ReceiptRow = Prisma.RaastReceiptGetPayload<{ include: typeof RECEIPT_INCLUDE }>

/** What the caller's view of the rows needs: their role, the void checks of the rows that could be voided, user names. */
interface ViewContext {
  role: string
  /** Receipt id → why it cannot be voided (null = it can). Absent = not a void candidate. */
  voidChecks: Map<string, RaastVoidRefusal | null>
  names: Map<string, string>
}

const pendingVoidRequest = (r: Pick<ReceiptRow, 'voidRequestedAt' | 'status'>) => !!r.voidRequestedAt && r.status === 'provisional'

/** A receipt the CEO could void: provisional, and on a cancelled / rejected bill or already asked for. */
const isVoidCandidate = (r: ReceiptRow) => r.status === 'provisional' && (VOIDABLE_ORDER_STATUSES.has(r.order.status) || !!r.voidRequestedAt)

async function viewContext(req: FastifyRequest, rows: ReceiptRow[]): Promise<ViewContext> {
  const voidChecks = new Map<string, RaastVoidRefusal | null>()
  for (const r of rows) if (isVoidCandidate(r)) voidChecks.set(r.id, await raastVoidEligibilityTx(prisma, r))
  const ids = [...new Set(rows.flatMap((r) => [r.voidRequestedById, r.voidedById]).filter((x): x is string => !!x))]
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
  return { role: req.staffUser?.role ?? '', voidChecks, names: new Map(users.map((u) => [u.id, u.name])) }
}

/** The caller's buttons for a row — the same rules the routes enforce. */
function capabilitiesOf(r: ReceiptRow, ctx: ViewContext) {
  const approver = (APPROVERS as string[]).includes(ctx.role)
  const ceo = ctx.role === 'admin'
  const requester = RAAST_VOID_REQUESTERS.includes(ctx.role)
  const voidable = ctx.voidChecks.get(r.id) === null
  const pending = pendingVoidRequest(r)
  return {
    canMatch: r.status === 'provisional' || r.status === 'unreceived',
    canUnmatch: approver && r.status === 'matched',
    canFixReference: approver && r.status === 'provisional' && !r.smsConfirmedAt,
    canWriteOff: approver && r.status === 'provisional',
    canResolve: approver && r.status === 'needs_attention',
    canVoid: ceo && voidable,
    canRequestVoid: requester && !ceo && voidable && !pending,
    canRejectVoidRequest: ceo && pending,
  }
}

function receiptView(r: ReceiptRow, now: Date, ctx: ViewContext) {
  const at = receiptAt(r)
  const by = (id: string | null) => (id ? { id, name: ctx.names.get(id) ?? null } : null)
  const check = ctx.voidChecks.get(r.id)
  return {
    id: r.id,
    tenantId: r.tenantId,
    orderId: r.orderId,
    orderRef: orderRefOf(r.orderId),
    conceptId: r.conceptId,
    brand: r.order.concept.name,
    shiftId: r.shiftId,
    status: r.status,
    amountCents: r.amountCents,
    tipCents: r.tipCents,
    bankRef: r.bankRef,
    confirmedVia: r.confirmedVia,
    confirmedAt: r.confirmedAt,
    createdAt: r.createdAt,
    cashierVerified: r.cashierVerified,
    smsConfirmed: !!r.smsConfirmedAt,
    smsConfirmedAt: r.smsConfirmedAt,
    matchedAt: r.matchedAt,
    matchedAutomatically: r.status === 'matched' && !r.matchedById,
    attentionReason: r.attentionReason,
    ageDays: Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY_MS)),
    ledgerCode: r.ledgerCode,
    writeOffEntryId: r.writeOffEntryId,
    bankAccount: { id: r.bankAccount.id, name: r.bankAccount.name, bankName: r.bankAccount.bankName, last4: last4(r.bankAccount) },
    statementLine: r.statementLine
      ? { ...r.statementLine, amountCents: toCents(r.statementLine.amountCents) }
      : null,
    orderStatus: r.order.status,
    // RV-MONEY-1: a pending ask for the CEO's void, and the void itself.
    voidRequest: r.voidRequestedAt ? { at: r.voidRequestedAt, by: by(r.voidRequestedById), reason: r.voidRequestReason, pending: pendingVoidRequest(r) } : null,
    voided: r.voidedAt ? { at: r.voidedAt, by: by(r.voidedById), reason: r.voidReason } : null,
    /** Why the CEO cannot void it (a provisional receipt on a cancelled bill, or one asked for); null otherwise. */
    voidBlockedReason: check ? check.message : null,
    voidBlockedCode: check ? check.code : null,
    ...capabilitiesOf(r, ctx),
  }
}

/** A receipt the operator may act on (write scope), else 404. */
async function receiptForWrite(req: FastifyRequest, id: string) {
  const r = await prisma.raastReceipt.findFirst({ where: { id, ...(await scopeTenantWhere(req, 'write')) }, include: RECEIPT_INCLUDE })
  if (!r) throw new NotFoundError('RaastReceipt', id)
  return r
}

/** One receipt as the caller sees it, after an action (fresh row, the caller's flags). */
async function viewOne(req: FastifyRequest, id: string) {
  const r = await receiptForWrite(req, id)
  return receiptView(r, new Date(), await viewContext(req, [r]))
}

const reasonSchema = z.string().trim().min(3).max(500)
/** A void (or the ask for one) says why in a sentence. */
const voidReasonSchema = z.string().trim().min(10, 'Say why in at least 10 characters').max(500)

export async function raastReconciliationRoutes(fastify: FastifyInstance) {
  // ── GET /receipts ────────────────────────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string | undefined> }>('/receipts', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const q = z.object({
      status: z.enum(RECEIPT_STATUSES).optional(),
      bankAccountId: z.string().min(1).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      q: z.string().trim().max(64).optional(),
      // RV-MONEY-1: only the receipts whose void is waiting for the CEO (the
      // approvals inbox reads this).
      voidRequested: z.enum(['1', 'true']).optional(),
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query)
    const company = await scopeTenantWhere(req, 'read')
    const and: Prisma.RaastReceiptWhereInput[] = [company]
    if (q.bankAccountId) and.push({ bankAccountId: q.bankAccountId })
    if (q.from || q.to) {
      const { from, to } = reportDateRange(q.from, q.to, 3650)
      and.push({ OR: [{ confirmedAt: { gte: from, lte: to } }, { confirmedAt: null, createdAt: { gte: from, lte: to } }] })
    }
    if (q.q) {
      const ref = normalizeBankRef(q.q)
      const tail = q.q.trim().toLowerCase()
      and.push({
        OR: [
          ...(ref ? [{ bankRef: { contains: ref } }] : []),
          // The 8-character order reference is the end of the order id.
          { orderId: { endsWith: tail } },
        ],
      })
    }
    const base: Prisma.RaastReceiptWhereInput = { AND: and }
    const statusWhere: Prisma.RaastReceiptWhereInput = q.voidRequested
      ? { voidRequestedAt: { not: null }, status: q.status ?? 'provisional' }
      : { status: q.status ? q.status : { in: FINANCE_DEFAULT } }
    const where: Prisma.RaastReceiptWhereInput = { AND: [...and, statusWhere] }

    const rows = await prisma.raastReceipt.findMany({
      where,
      include: RECEIPT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    })
    const groups = await prisma.raastReceipt.groupBy({ by: ['status'], where: base, _count: true, _sum: { amountCents: true } })
    const totals: Record<string, { count: number; cents: number }> = {}
    for (const s of RECEIPT_STATUSES) totals[s] = { count: 0, cents: 0 }
    for (const g of groups) totals[g.status] = { count: g._count, cents: g._sum.amountCents ?? 0 }

    // "Older than N days" uses each company's own setting (the active
    // company's when one; else the default).
    const now = new Date()
    const tenantForSettings = req.staffUser?.tenantId ?? null
    const flagDays = tenantForSettings ? (await raastFinanceSettings(prisma, tenantForSettings)).provisionalFlagDays : 3
    const olderCut = new Date(now.getTime() - flagDays * DAY_MS)
    const older = await prisma.raastReceipt.aggregate({
      where: { AND: [...and, { status: 'provisional' }, { OR: [{ confirmedAt: { lt: olderCut } }, { confirmedAt: null, createdAt: { lt: olderCut } }] }] },
      _count: true, _sum: { amountCents: true },
    })
    const unmatchedAlerts = await prisma.bankSmsAlert.count({
      where: { ...company, kind: 'credit', status: { in: ['unmatched', 'ambiguous', 'needs_attention'] } },
    })
    const voidRequested = await prisma.raastReceipt.aggregate({
      where: { AND: [...and, { status: 'provisional', voidRequestedAt: { not: null } }] },
      _count: true, _sum: { amountCents: true },
    })

    const page = rows.slice(0, q.limit)
    const ctx = await viewContext(req, page)
    return {
      receipts: page.map((r) => receiptView(r, now, ctx)),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
      totals,
      kpis: {
        provisional: totals['provisional'],
        olderThanFlagDays: { days: flagDays, count: older._count, cents: older._sum.amountCents ?? 0 },
        matched: totals['matched'],
        needsAttention: totals['needs_attention'],
        unreceived: totals['unreceived'],
        voided: totals['voided'],
        voidRequested: { count: voidRequested._count, cents: voidRequested._sum.amountCents ?? 0 },
        unmatchedBankAlerts: unmatchedAlerts,
      },
    }
  })

  // ── GET /receipts/:id/candidates ─────────────────────────────────────────
  // Unmatched credit lines of the same company and receiving account, equal
  // amount, ±statementMatchDays. `suggested` (S3): no line names the
  // reference, exactly one line has the amount on the receipt's own day, and
  // that line's day has exactly one provisional receipt of that amount on
  // the account — finance CONFIRMS it with POST /match; never automatic.
  fastify.get<{ Params: { id: string } }>('/receipts/:id/candidates', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const r = await prisma.raastReceipt.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) }, include: RECEIPT_INCLUDE })
    if (!r) throw new NotFoundError('RaastReceipt', req.params.id)
    const { statementMatchDays: n, matchWindowMin } = await raastFinanceSettings(prisma, r.tenantId)
    const at = receiptAt(r)
    // M4 (RV-FRAUD-1): a line dated before the bill existed is listed (finance
    // decides) but never flagged as naming it, nor suggested.
    const firstDay = earliestLineDay(r, matchWindowMin)
    const lines = await prisma.bankStatementLine.findMany({
      where: {
        matchStatus: 'unmatched', amountCents: r.amountCents,
        postedDate: { gte: new Date(at.getTime() - (n + 1) * DAY_MS), lte: new Date(at.getTime() + (n + 1) * DAY_MS) },
        import: { tenantId: r.tenantId, bankAccountId: r.bankAccountId },
      },
      select: { id: true, importId: true, postedDate: true, description: true, reference: true, amountCents: true },
      orderBy: { postedDate: 'asc' },
      take: 50,
    })
    const day = pktDay(at)
    const inWindow = lines.filter((l) => Math.abs(pktDay(l.postedDate) - day) <= n)
    const withRef = inWindow.map((l) => {
      const beforeBill = pktDay(l.postedDate) < firstDay
      return {
        ...l,
        amountCents: toCents(l.amountCents),
        beforeBill,
        refHit: !beforeBill && !!r.bankRef && refInText(r.bankRef, `${l.description} ${l.reference ?? ''}`),
        sameDay: pktDay(l.postedDate) === day,
      }
    })
    let suggestedId: string | null = null
    if (!withRef.some((l) => l.refHit)) {
      const sameDay = withRef.filter((l) => l.sameDay)
      if (sameDay.length === 1) {
        const dayStart = new Date(day * DAY_MS - 5 * 3_600_000)
        const dayEnd = new Date(dayStart.getTime() + DAY_MS - 1)
        const twins = await prisma.raastReceipt.count({
          where: {
            tenantId: r.tenantId, bankAccountId: r.bankAccountId, status: { in: ['provisional', 'unreceived'] }, amountCents: r.amountCents,
            OR: [{ confirmedAt: { gte: dayStart, lte: dayEnd } }, { confirmedAt: null, createdAt: { gte: dayStart, lte: dayEnd } }],
          },
        })
        if (twins === 1) suggestedId = sameDay[0]!.id
      }
    }
    return {
      receipt: receiptView(r, new Date(), await viewContext(req, [r])),
      statementMatchDays: n,
      candidates: withRef.map((l) => ({ ...l, suggested: l.id === suggestedId })),
    }
  })

  // ── POST /receipts/:id/match ─────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/receipts/:id/match', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const body = z.object({ statementLineId: z.string().min(1) }).parse(req.body)
    const r = await receiptForWrite(req, req.params.id)
    const updated = await matchReceiptToLine({ receiptId: r.id, statementLineId: body.statementLineId, actorId: req.staffUser!.id })
    await audit({
      category: 'accounting', action: 'raast.receipt.match', entity: 'RaastReceipt', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null,
      before: { status: r.status, statementLineId: r.statementLineId },
      after: { status: updated.status, statementLineId: updated.statementLineId },
      metadata: { receiptTenantId: r.tenantId, orderId: r.orderId, bankRef: r.bankRef, amountCents: r.amountCents, wasWrittenOff: r.status === 'unreceived' },
    })
    return viewOne(req, r.id)
  })

  // ── POST /receipts/:id/unmatch (APPROVERS) ───────────────────────────────
  fastify.post<{ Params: { id: string } }>('/receipts/:id/unmatch', { preHandler: requireAuth(...APPROVERS) }, async (req) => {
    const body = z.object({ reason: reasonSchema.optional() }).parse(req.body ?? {})
    const r = await receiptForWrite(req, req.params.id)
    const { receipt, lineId } = await unmatchReceipt({ receiptId: r.id, actorId: req.staffUser!.id })
    await audit({
      category: 'accounting', action: 'raast.receipt.unmatch', entity: 'RaastReceipt', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null,
      before: { status: r.status, statementLineId: lineId },
      after: { status: receipt.status, statementLineId: null },
      metadata: { receiptTenantId: r.tenantId, orderId: r.orderId, reason: body.reason ?? null },
    })
    return viewOne(req, r.id)
  })

  // ── PATCH /receipts/:id/reference (APPROVERS — M4) ───────────────────────
  // A provisional receipt's typed reference only; the same checks as the
  // till (format, not the bill's own number, one transfer pays one bill per
  // company, never a dismissed / debit reference, the bank SMS's amount when
  // SMS matching is on), Payment.gatewayRef in the same transaction, then
  // the statement match is re-run for it. Audited with before / after.
  fastify.patch<{ Params: { id: string } }>('/receipts/:id/reference', { preHandler: requireAuth(...APPROVERS) }, async (req) => {
    const body = z.object({ bankRef: z.string().trim().min(1).max(80), reason: reasonSchema }).parse(req.body)
    const r = await receiptForWrite(req, req.params.id)
    const res = await fixReceiptReference({ receiptId: r.id, actorId: req.staffUser!.id, bankRefRaw: body.bankRef })
    await audit({
      category: 'accounting', action: 'raast.receipt.reference', entity: 'RaastReceipt', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null,
      before: { bankRef: res.before, bankRefRaw: r.bankRefRaw },
      after: { bankRef: res.receipt.bankRef, bankRefRaw: res.receipt.bankRefRaw, status: res.receipt.status },
      metadata: { receiptTenantId: r.tenantId, orderId: r.orderId, paymentId: r.paymentId, reason: body.reason, smsConfirmed: res.smsConfirmed, statementMatched: res.statementMatched },
    })
    return { ...(await viewOne(req, r.id)), smsConfirmedNow: res.smsConfirmed, statementMatchedNow: res.statementMatched }
  })

  // ── POST /receipts/:id/unreceived (APPROVERS) ────────────────────────────
  fastify.post<{ Params: { id: string } }>('/receipts/:id/unreceived', { preHandler: requireAuth(...APPROVERS) }, async (req) => {
    const body = z.object({
      reason: reasonSchema,
      // 1115 (or the legacy 1110) the customer still owes it — posted to the
      // company's CURRENT till-clearing code; omitted = that default, resolved
      // server-side (raast.ts writeOffUnreceived) / 8010 a loss / 1350 staff owes.
      contraAccountCode: z.enum(WRITE_OFF_CONTRAS).optional(),
    }).parse(req.body)
    const r = await receiptForWrite(req, req.params.id)
    const res = await writeOffUnreceived({ receiptId: r.id, actorId: req.staffUser!.id, reason: body.reason, contraAccountCode: body.contraAccountCode })
    await audit({
      category: 'accounting', action: 'raast.receipt.unreceived', entity: 'RaastReceipt', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null,
      before: { status: r.status },
      after: { status: res.receipt.status, writeOffEntryId: res.entryId },
      metadata: { receiptTenantId: r.tenantId, orderId: r.orderId, bankRef: r.bankRef, amountCents: r.amountCents, contraAccountCode: res.contraAccountCode, contraRequested: body.contraAccountCode ?? null, ledgerCode: r.ledgerCode, reason: body.reason },
    })
    return viewOne(req, r.id)
  })

  // ── POST /receipts/:id/resolve (APPROVERS — RV-FIN-1) ───────────────────
  // A needs-attention receipt (no payment) whose bill is closed: refunded to
  // the customer, not a sale, or booked elsewhere. No ledger posting — the
  // transfer was never booked; finance books the statement credit (and the
  // refund out) with the statement line's adjustment.
  fastify.post<{ Params: { id: string } }>('/receipts/:id/resolve', { preHandler: requireAuth(...APPROVERS) }, async (req) => {
    const body = z.object({
      outcome: z.enum(ATTENTION_OUTCOMES),
      reason: reasonSchema,
      refundReference: z.string().trim().min(1).max(80).optional(),
    }).parse(req.body)
    const r = await receiptForWrite(req, req.params.id)
    const res = await resolveAttentionReceipt({ receiptId: r.id, actorId: req.staffUser!.id, outcome: body.outcome, reason: body.reason, refundReference: body.refundReference ?? null })
    await audit({
      category: 'accounting', action: 'raast.receipt.resolve', entity: 'RaastReceipt', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null,
      before: { status: res.before.status, smsAlertId: res.before.smsAlertId, attentionReason: res.before.attentionReason },
      after: { status: res.receipt.status, cancelReason: res.receipt.cancelReason },
      metadata: {
        receiptTenantId: r.tenantId, orderId: r.orderId, amountCents: r.amountCents, outcome: body.outcome, reason: body.reason,
        refundReference: res.refundReference, alertId: res.alertId,
      },
    })
    return viewOne(req, r.id)
  })

  // ── POST /receipts/:id/void-request (RV-MONEY-1) ─────────────────────────
  // Finance (or management / an owner) asks the CEO to void a receipt whose
  // sale was never booked. The same checks as the void (raast.ts
  // raastVoidEligibilityTx) — a request the CEO could never act on is refused
  // here. Audited in the receipt's company.
  fastify.post<{ Params: { id: string } }>('/receipts/:id/void-request', { preHandler: requireAuth(...(RAAST_VOID_REQUESTERS as UserRole[])) }, async (req) => {
    const body = z.object({ reason: voidReasonSchema }).parse(req.body)
    const r = await receiptForWrite(req, req.params.id)
    const res = await requestRaastVoid(r.id, { actorId: req.staffUser!.id, reason: body.reason })
    await audit({
      category: 'accounting', action: 'raast.receipt.void_request', entity: 'RaastReceipt', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: r.tenantId,
      before: { voidRequestedAt: null },
      after: { voidRequestedAt: res.receipt.voidRequestedAt, reason: body.reason },
      metadata: { orderId: r.orderId, bankRef: r.bankRef, amountCents: r.amountCents, actorTenantId: req.staffUser!.tenantId ?? null },
    })
    // The bell (queued, after the commit): the CEO has a void request to decide. A new request = a new round.
    approvalWaiting('raast_void', r.id, { round: `void-request:${(res.receipt.voidRequestedAt ?? new Date()).toISOString()}`, actorId: req.staffUser!.id })
    return viewOne(req, r.id)
  })

  // ── POST /receipts/:id/void (ADMIN_ONLY — the CEO, RV-MONEY-1) ───────────
  // With or without a request. NO ledger posting; the bank reference stays
  // claimed. Audited in the receipt's company.
  fastify.post<{ Params: { id: string } }>('/receipts/:id/void', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ reason: voidReasonSchema }).parse(req.body)
    const r = await receiptForWrite(req, req.params.id)
    const voided = await voidNeverBooked(r.id, { actorId: req.staffUser!.id, reason: body.reason })
    await audit({
      category: 'accounting', action: 'raast.receipt.void', entity: 'RaastReceipt', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: r.tenantId,
      before: { status: r.status, voidRequestedAt: r.voidRequestedAt, voidRequestedById: r.voidRequestedById },
      after: { status: voided.status, voidedAt: voided.voidedAt },
      metadata: {
        orderId: r.orderId, orderStatus: r.order.status, bankRef: r.bankRef, amountCents: r.amountCents, ledgerCode: r.ledgerCode,
        reason: body.reason, requestReason: r.voidRequestReason, noLedgerEntry: true, actorTenantId: req.staffUser!.tenantId ?? null,
      },
    })
    // approval.decide + "decided" notice to whoever asked for the void (grant 'role': ADMIN_ONLY guard). Never fails the void.
    try {
      await auditApproval(req, {
        type: 'raast_void', id: r.id, tenantId: r.tenantId, decision: 'approve', grant: { via: 'role' }, entity: 'RaastReceipt',
        metadata: { decidedAt: (voided.voidedAt ?? new Date()).toISOString(), reason: body.reason },
      })
    } catch (err) {
      console.warn(`[raast] approval.decide not recorded: ${(err as Error).message}`)
    }
    return viewOne(req, r.id)
  })

  // ── POST /receipts/:id/void-request/reject (ADMIN_ONLY) ──────────────────
  fastify.post<{ Params: { id: string } }>('/receipts/:id/void-request/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: reasonSchema }).parse(req.body)
    const r = await receiptForWrite(req, req.params.id)
    const res = await rejectRaastVoidRequest(r.id, { actorId: req.staffUser!.id, note: body.note })
    await audit({
      category: 'accounting', action: 'raast.receipt.void_request_reject', entity: 'RaastReceipt', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: r.tenantId,
      before: { voidRequestedAt: res.before.voidRequestedAt, voidRequestedById: res.before.voidRequestedById, reason: res.before.voidRequestReason },
      after: { voidRequestedAt: null },
      metadata: { orderId: r.orderId, note: body.note, actorTenantId: req.staffUser!.tenantId ?? null },
    })
    // approval.decide (audit row) + the requester's notice. The rejection CLEARS voidRequestedById, so the
    // funnel can no longer find the requester: tell them directly from the id read before the reject.
    const decidedAt = new Date().toISOString()
    try {
      await auditApproval(req, {
        type: 'raast_void', id: r.id, tenantId: r.tenantId, decision: 'reject', grant: { via: 'role' }, entity: 'RaastReceipt',
        metadata: { decidedAt, reason: body.note },
      })
    } catch (err) {
      console.warn(`[raast] approval.decide not recorded: ${(err as Error).message}`)
    }
    const requesterId = res.before.voidRequestedById
    if (requesterId && requesterId !== req.staffUser!.id) {
      const actorId = req.staffUser!.id
      queueStaffNotify(() => notifyStaffMany([{
        userId: requesterId, tenantId: r.tenantId, kind: 'approval.decided', severity: 'warning',
        title: `Raast void request for order ${orderRefOf(r.orderId)} rejected`, body: `Reason: ${body.note}`.slice(0, 500),
        link: '/reconciliation?tab=raast', entityType: 'raast_void', entityId: r.id, actorId,
        dedupeKey: `approval.decided:raast_void:${r.id}:reject:${decidedAt}`,
      }]))
    }
    return viewOne(req, r.id)
  })

  // ── POST /rematch ────────────────────────────────────────────────────────
  // The ACTIVE company's unmatched credit lines of the last 60 days (or one
  // of its imports — another company's import is 404).
  fastify.post('/rematch', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const body = z.object({ importId: z.string().min(1).optional() }).parse(req.body ?? {})
    const tenantId = activeTenantId(req, 'statements are matched per company')
    if (body.importId) {
      const imp = await prisma.bankStatementImport.findFirst({ where: { id: body.importId, tenantId }, select: { id: true } })
      if (!imp) throw new NotFoundError('BankStatementImport', body.importId)
    }
    const res = await rematchRaast({ tenantId, importId: body.importId ?? null, actorId: req.staffUser!.id })
    await audit({
      category: 'accounting', action: 'raast.receipt.rematch', entity: 'RaastReceipt',
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      after: { matched: res.matched, mismatched: res.mismatched, accounts: res.accounts },
      metadata: { importId: body.importId ?? null, receiptIds: res.matchedReceiptIds },
    })
    return { matched: res.matched, mismatched: res.mismatched, accounts: res.accounts, receiptIds: res.matchedReceiptIds }
  })

  // ── GET /alerts ──────────────────────────────────────────────────────────
  // The bank SMS log for finance (read only — attaching is a till action,
  // dismissing a manager's). Unparsed bodies are shown so finance can see
  // what the bank actually sent.
  fastify.get<{ Querystring: Record<string, string | undefined> }>('/alerts', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const q = z.object({
      status: z.enum(ALERT_STATUSES).optional(),
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query)
    const where: Prisma.BankSmsAlertWhereInput = {
      ...(await scopeTenantWhere(req, 'read')),
      ...(q.status && { status: q.status as BankSmsAlertStatus }),
    }
    const rows = await prisma.bankSmsAlert.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
      include: { receipt: { select: { id: true, orderId: true, status: true } } },
    })
    const accountIds = [...new Set(rows.map((a) => a.bankAccountId).filter((x): x is string => !!x))]
    const accounts = accountIds.length
      ? await prisma.bankAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, tenantId: true, name: true, bankName: true, accountNumber: true, iban: true } })
      : []
    const accountOf = new Map(accounts.map((a) => [a.id, a]))
    const page = rows.slice(0, q.limit)
    return {
      alerts: page.map((a) => {
        const acc = a.bankAccountId ? accountOf.get(a.bankAccountId) : undefined
        return {
          id: a.id, tenantId: a.tenantId, status: a.status, kind: a.kind, sender: a.sender,
          amountCents: toCents(a.amountCents), bankRef: a.bankRef, occurredAt: a.occurredAt, receivedAt: a.receivedAt,
          payer: a.payer, accountLast4: a.accountLast4, body: a.body, resolution: a.resolution, resolvedAt: a.resolvedAt,
          bankAccount: acc && acc.tenantId === a.tenantId ? { id: acc.id, name: acc.name, bankName: acc.bankName, last4: last4(acc) } : null,
          receipt: a.receipt ? { id: a.receipt.id, orderId: a.receipt.orderId, orderRef: orderRefOf(a.receipt.orderId), status: a.receipt.status } : null,
        }
      }),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
    }
  })

}

/** Raast figures for a set of shifts (the /reconciliation/summary rows). */
export function raastPaidCents(payments: Array<{ method: string; status: string; amountCents: number }>): number {
  return payments.filter((p) => p.method === 'raast' && p.status === 'paid').reduce((s, p) => s + p.amountCents, 0)
}
