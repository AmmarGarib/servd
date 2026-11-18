// Void a PAID cash voucher (owner, 2026-11-18: "how to void booked cash voucher?" → "finance requests it with a reason
// and you approve it").
//
// Who: finance (role finance holding `accounting`) asks with a reason ≥10 — POST /trustops/cash-vouchers/:id/void →
// 202 { pendingApproval, request }; nothing changes until the CEO approves. The CEO's own void applies at once (200,
// and closes a pending request as approved). One pending request per voucher (409 VOID_PENDING). Approval type
// cash_voucher_void (section ceo, never handed over): POST /void-requests/:id/approve | reject {note ≥10}; the
// requester (or the CEO) may withdraw. Table cash_voucher_void_requests (tenantId = the voucher's company, RLS, merge
// repoint).
//
// What can be voided: a voucher booked in ONE entry when finance paid it (bookedAtPay), paid in cash — from a
// petty-cash box, cash on hand or a bank — with its documents open or checked (status disbursed | posted). Never a
// voucher on credit (void its supplier bill), equipment (CapEx), a PO's cash or a buyer's pay-back (their PO / bill
// carries them), an old 1357 hold, or one with change / conversions recorded (assertVoidable says which, 422).
//
// What a void does (one transaction, the voucher row locked; the CEO's approval is the authority):
//   * paid from a BOX: the cash goes back into the SAME box — a petty-cash top-up (source cash_request) through
//     recordPettyCashTopupTx + postPettyCashMovementTx: Dr 1011 / Cr the expense account the pay debited, under the
//     pay's brand ('pettycash.topup:<movementId>'). The pay's own spend entry stays (history); the two net to zero.
//   * paid from CASH ON HAND / a BANK: the pay entry is reversed ('cashvoucher.pay.reversal:<voucherId>', dated today).
//   Then the voucher is 'voided' (voidedAt / voidedById / voidReason / voidEntryId). Supporting documents stay.
// Nothing is deleted. A spend line of a voided voucher can no longer be moved to another account (409 VOUCHER_VOIDED).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { audit } from '../../lib/audit.js'
import { fmtPkrCents } from '../../lib/money.js'
import { CASH_VOUCHER_PAY_ENTRY, cashRequestPaidAccountTx, postPettyCashMovementTx } from '../accounting/pettyCashPosting.js'
import { reverseJournalEntry } from '../accounting/journal.js'
import { recordPettyCashTopupTx } from './pettyCash.js'

type Db = Prisma.TransactionClient | typeof prisma

const REASON = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500)
const STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const

const VOID_SELECT = {
  id: true, tenantId: true, number: true, status: true, bookedAtPay: true, paySource: true, payJournalEntryId: true,
  pettyCashMovementId: true, postedJournalEntryId: true, supplierBillId: true, assetClassId: true, capexLineId: true,
  purchaseOrderId: true, reimbursesBillId: true, returnedCents: true, convertedCents: true, amountCents: true,
  payeeName: true, purpose: true, voidedAt: true,
} satisfies Prisma.CashVoucherSelect
type VoidRow = Prisma.CashVoucherGetPayload<{ select: typeof VOID_SELECT }>

const no = (code: string, message: string, status = 422) => new AppError(code, message, status)

/** Why `v` cannot be voided (null = it can). Read-only. */
export async function voidBlockOf(db: Db, v: VoidRow): Promise<AppError | null> {
  if (v.status === 'voided' || v.voidedAt) return no('ALREADY_VOIDED', `Cash voucher ${v.number} is already voided`, 409)
  if (v.status !== 'disbursed' && v.status !== 'posted') {
    return no('VOUCHER_NOT_PAID', `Cash voucher ${v.number} is not paid — cancel or reject it instead`, 409)
  }
  if (v.purchaseOrderId || v.reimbursesBillId) {
    return no('VOID_PO_VOUCHER', `Cash voucher ${v.number} carries a purchase order's money — correct it on the PO / its bill`)
  }
  if (v.paySource === 'credit' || v.supplierBillId) {
    return no('VOID_USE_SUPPLIER_BILL', `Cash voucher ${v.number} was booked on credit as a supplier bill — void that bill instead`)
  }
  if (v.assetClassId || v.capexLineId) {
    return no('VOID_EQUIPMENT', `Cash voucher ${v.number} bought equipment through CapEx — correct it there`)
  }
  if (!v.bookedAtPay || v.postedJournalEntryId) {
    return no('VOID_OLD_FLOW', `Cash voucher ${v.number} was paid under an older flow — correct it with a manual journal`)
  }
  if (v.returnedCents > 0 || v.convertedCents > 0) {
    return no('VOID_HAS_CHANGE', `Cash voucher ${v.number} already has change or a conversion recorded — correct it with a manual journal`)
  }
  if (v.paySource === 'box') {
    if (!v.pettyCashMovementId) return no('PAYMENT_NOT_BOOKED', `The payment of cash voucher ${v.number} is not on the books`, 409)
    const m = await db.pettyCashMovement.findUnique({ where: { id: v.pettyCashMovementId }, select: { journalEntryId: true, box: { select: { deletedAt: true, name: true } } } })
    if (!m?.journalEntryId) return no('PAYMENT_NOT_BOOKED', `The payment of cash voucher ${v.number} is not on the books`, 409)
    if (m.box.deletedAt) return no('BOX_REMOVED', `The petty-cash box "${m.box.name}" this voucher was paid from has been removed — correct it with a manual journal`)
    try { await cashRequestPaidAccountTx(db, v.id) } catch (err) { return err instanceof AppError ? err : no('PAYMENT_NOT_BOOKED', (err as Error).message, 409) }
    return null
  }
  if (v.paySource === 'cash_on_hand' || v.paySource === 'bank') {
    if (!v.payJournalEntryId) return no('PAYMENT_NOT_BOOKED', `The payment of cash voucher ${v.number} is not on the books`, 409)
    const reversed = await db.journalEntry.findFirst({ where: { tenantId: v.tenantId, reference: `${CASH_VOUCHER_PAY_ENTRY}.reversal:${v.id}` }, select: { id: true } })
    if (reversed) return no('ALREADY_VOIDED', `The payment of cash voucher ${v.number} is already reversed`, 409)
    return null
  }
  return no('VOID_UNKNOWN_SOURCE', `Cash voucher ${v.number} was paid in a way that cannot be voided here`)
}

/** Void `voucherId` inside `tx` (the CEO's authority): put the cash back / reverse the pay, mark it voided. */
export async function voidVoucherTx(tx: Prisma.TransactionClient, voucherId: string, actorId: string, reason: string): Promise<{ entryId: string; boxId: string | null }> {
  await tx.$queryRaw`SELECT id FROM cash_vouchers WHERE id = ${voucherId} FOR UPDATE`
  const v = await tx.cashVoucher.findUniqueOrThrow({ where: { id: voucherId }, select: VOID_SELECT })
  const block = await voidBlockOf(tx, v)
  if (block) throw block
  let entryId: string
  let boxId: string | null = null
  if (v.paySource === 'box') {
    const m = await tx.pettyCashMovement.findUniqueOrThrow({ where: { id: v.pettyCashMovementId! }, select: { boxId: true } })
    boxId = m.boxId
    const top = await recordPettyCashTopupTx(tx, {
      box: { id: m.boxId }, amountCents: v.amountCents, source: 'cash_request', cashVoucherId: v.id,
      reason: `${v.number} voided — cash put back: ${reason}`.slice(0, 500), createdById: actorId,
    })
    const posted = await postPettyCashMovementTx(tx, top.movementId, { postedBy: actorId })
    if (!posted.entryId) throw new AppError('VOID_NOT_BOOKED', `The cash put back for ${v.number} could not be booked`, 409)
    entryId = posted.entryId
  } else {
    const r = await reverseJournalEntry(v.tenantId, CASH_VOUCHER_PAY_ENTRY, v.id, `${v.number} voided: ${reason}`.slice(0, 200), { tx, postedBy: actorId })
    if (!r.posted) throw new AppError('ALREADY_VOIDED', `The payment of cash voucher ${v.number} is already reversed`, 409)
    entryId = r.entryId
  }
  const claimed = await tx.cashVoucher.updateMany({
    where: { id: v.id, status: v.status },
    data: { status: 'voided', voidedAt: new Date(), voidedById: actorId, voidReason: reason, voidEntryId: entryId },
  })
  if (claimed.count === 0) throw new AppError('VOUCHER_CHANGED', `Cash voucher ${v.number} changed meanwhile — reload it`, 409)
  return { entryId, boxId }
}

/** What the voucher screen shows about voiding: the pending request, who may ask, and why not. */
export async function voidStateOf(v: VoidRow & { voidedById: string | null; voidReason: string | null }, viewer: { id: string; isAdmin: boolean; financeApprover: boolean }) {
  const pending = await prisma.cashVoucherVoidRequest.findFirst({ where: { voucherId: v.id, tenantId: v.tenantId, status: 'pending' } })
  const names = new Map((await prisma.user.findMany({
    where: { id: { in: [pending?.requestedById, v.voidedById].filter((x): x is string => !!x) } }, select: { id: true, name: true },
  })).map((u) => [u.id, u.name]))
  const paid = v.status === 'disbursed' || v.status === 'posted'
  const block = paid ? await voidBlockOf(prisma, v) : null
  return {
    canRequestVoid: paid && !pending && !block && viewer.financeApprover,
    voidBlockedReason: paid && block ? block.message : null,
    voidRequest: pending
      ? { id: pending.id, reason: pending.reason, requestedById: pending.requestedById, requestedByName: names.get(pending.requestedById) ?? null, createdAt: pending.createdAt,
        canWithdraw: viewer.isAdmin || pending.requestedById === viewer.id, canDecide: viewer.isAdmin }
      : null,
    voidedByName: v.voidedById ? names.get(v.voidedById) ?? null : null,
  }
}

function auditVoid(req: FastifyRequest, action: string, tenantId: string, entity: string, entityId: string, metadata: Record<string, unknown>) {
  return audit({
    category: 'accounting', action, entity, entityId, tenantId,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null,
    metadata: { actorRole: req.staffUser!.role, ...metadata },
  })
}

const notPending = () => new AppError('REQUEST_NOT_PENDING', 'This void request is no longer waiting for the CEO.', 409)

export async function voucherVoidRoutes(fastify: FastifyInstance) {
  const { viewerOf, detailOf, loadVoucher } = await import('./cashVouchers.js')

  // POST /:id/void {reason} — finance asks (202); the CEO voids at once (200).
  fastify.post<{ Params: { id: string } }>('/:id/void', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const { reason } = z.object({ reason: REASON }).parse(req.body ?? {})
    const loaded = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (!viewer.financeApprover) throw new ForbiddenError('Only finance (or the CEO) can void a paid cash voucher')
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: loaded.id }, select: VOID_SELECT })
    const block = await voidBlockOf(prisma, v)
    if (block) throw block

    if (viewer.isAdmin) {
      const out = await prisma.$transaction(async (tx) => {
        const r = await voidVoucherTx(tx, v.id, viewer.id, reason)
        await tx.cashVoucherVoidRequest.updateMany({
          where: { voucherId: v.id, status: 'pending' },
          data: { status: 'approved', decidedById: viewer.id, decidedAt: new Date(), decisionNote: 'Voided by the CEO directly' },
        })
        return r
      })
      await auditVoid(req, 'cash_voucher.void', v.tenantId, 'CashVoucher', v.id, { number: v.number, amountCents: v.amountCents, reason, entryId: out.entryId, boxId: out.boxId, direct: true })
      return reply.status(200).send(await detailOf(v.id, viewer))
    }

    let row
    try {
      row = await prisma.cashVoucherVoidRequest.create({ data: { tenantId: v.tenantId, voucherId: v.id, reason, requestedById: viewer.id } })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new AppError('VOID_PENDING', `A void of ${v.number} is already waiting for the CEO.`, 409)
      throw err
    }
    await auditVoid(req, 'cash_voucher.void_request', v.tenantId, 'CashVoucherVoidRequest', row.id, { voucherId: v.id, number: v.number, amountCents: v.amountCents, reason })
    approvalWaiting('cash_voucher_void', row.id, { round: row.createdAt.toISOString(), actorId: viewer.id })
    return reply.status(202).send({ pendingApproval: true, request: row })
  })

  // GET /void-requests?status=pending — the requests of the companies in view (finance and the CEO).
  fastify.get<{ Querystring: { status?: string } }>('/void-requests', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const viewer = await viewerOf(req)
    if (!viewer.financeApprover) throw new ForbiddenError('Only finance (or the CEO) sees void requests')
    const status = (STATUSES as readonly string[]).includes(req.query.status ?? '') ? req.query.status : undefined
    const rows = await prisma.cashVoucherVoidRequest.findMany({
      where: { ...(await scopeTenantWhere(req, 'read')), ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' }, take: 200,
    })
    const vouchers = await prisma.cashVoucher.findMany({
      where: { id: { in: rows.map((r) => r.voucherId) } },
      select: { ...VOID_SELECT, conceptId: true, box: { select: { name: true } } },
    })
    const vById = new Map(vouchers.map((x) => [x.id, x]))
    const userIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter((x): x is string => !!x))]
    const tenantIds = [...new Set(rows.map((r) => r.tenantId))]
    const [users, tenants] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
    ])
    const u = new Map(users.map((x) => [x.id, x.name]))
    const t = new Map(tenants.map((x) => [x.id, x.name]))
    const items = []
    for (const r of rows) {
      const v = vById.get(r.voucherId)
      let paidAccountCode: string | null = null
      if (v && v.status !== 'voided') { try { paidAccountCode = await cashRequestPaidAccountTx(prisma, v.id) } catch { paidAccountCode = null } }
      const block = r.status === 'pending' && v ? await voidBlockOf(prisma, v) : null
      items.push({
        ...r,
        voucherNumber: v?.number ?? null, payeeName: v?.payeeName ?? null, purpose: v?.purpose ?? null,
        amountCents: v?.amountCents ?? null, paySource: v?.paySource ?? null, boxName: v?.box?.name ?? null, paidAccountCode,
        companyName: t.get(r.tenantId) ?? null,
        requestedByName: u.get(r.requestedById) ?? null,
        decidedByName: r.decidedById ? u.get(r.decidedById) ?? null : null,
        blockedBy: block ? block.message : null,
      })
    }
    return { items }
  })

  async function forDecision(req: FastifyRequest, id: string) {
    const r = await prisma.cashVoucherVoidRequest.findFirst({ where: { id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!r) throw new NotFoundError('Void request', id)
    return r
  }
  async function grantFor(req: FastifyRequest, id: string) {
    const s = await approvalSubject('cash_voucher_void', id)
    if (!s) throw new NotFoundError('Void request', id)
    return assertCanApprove(req, approvalInputOf('cash_voucher_void', id, s))
  }

  // POST /void-requests/:id/approve — the CEO voids the voucher now.
  fastify.post<{ Params: { id: string } }>('/void-requests/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    if (r.status !== 'pending') throw notPending()
    const decidedAt = new Date()
    const out = await prisma.$transaction(async (tx) => {
      const claimed = await tx.cashVoucherVoidRequest.updateMany({
        where: { id: r.id, status: 'pending' },
        data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note ?? null },
      })
      if (claimed.count === 0) throw notPending()
      return voidVoucherTx(tx, r.voucherId, req.staffUser!.id, r.reason)
    })
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: r.voucherId }, select: { number: true, amountCents: true } })
    await auditVoid(req, 'cash_voucher.void', r.tenantId, 'CashVoucher', r.voucherId, {
      number: v.number, amountCents: v.amountCents, reason: r.reason, entryId: out.entryId, boxId: out.boxId, requestId: r.id, requestedBy: r.requestedById,
    })
    await auditApproval(req, {
      type: 'cash_voucher_void', id: r.id, tenantId: r.tenantId, decision: 'approve', grant, entity: 'CashVoucherVoidRequest',
      metadata: { voucherId: r.voucherId, note: body.note ?? null, decidedAt, amount: fmtPkrCents(v.amountCents) },
    })
    return { id: r.id, approved: true, voucherId: r.voucherId, entryId: out.entryId }
  })

  // POST /void-requests/:id/reject {note ≥10} — the CEO turns it down; the voucher stays as it is.
  fastify.post<{ Params: { id: string } }>('/void-requests/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: REASON }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    const decidedAt = new Date()
    const claimed = await prisma.cashVoucherVoidRequest.updateMany({
      where: { id: r.id, status: 'pending' },
      data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note },
    })
    if (claimed.count === 0) throw notPending()
    await auditVoid(req, 'cash_voucher.void_request.reject', r.tenantId, 'CashVoucherVoidRequest', r.id, { voucherId: r.voucherId, requestedBy: r.requestedById, note: body.note })
    await auditApproval(req, {
      type: 'cash_voucher_void', id: r.id, tenantId: r.tenantId, decision: 'reject', grant, entity: 'CashVoucherVoidRequest',
      metadata: { voucherId: r.voucherId, note: body.note, decidedAt },
    })
    return { id: r.id, rejected: true }
  })

  // POST /void-requests/:id/withdraw — the requester (or the CEO) takes it back.
  fastify.post<{ Params: { id: string } }>('/void-requests/:id/withdraw', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const r = await forDecision(req, req.params.id)
    if (req.staffUser!.role !== 'admin' && r.requestedById !== req.staffUser!.id) {
      throw new AppError('NOT_YOUR_REQUEST', 'Only the person who asked (or the CEO) may withdraw it.', 403)
    }
    const claimed = await prisma.cashVoucherVoidRequest.updateMany({
      where: { id: r.id, status: 'pending' },
      data: { status: 'withdrawn', decidedById: req.staffUser!.id, decidedAt: new Date() },
    })
    if (claimed.count === 0) throw notPending()
    await auditVoid(req, 'cash_voucher.void_request.withdraw', r.tenantId, 'CashVoucherVoidRequest', r.id, { voucherId: r.voucherId, requestedBy: r.requestedById })
    return { id: r.id, withdrawn: true }
  })
}
