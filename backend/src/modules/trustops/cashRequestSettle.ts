// Cash vouchers — what happens after the cash is paid (child routes of
// /trustops/cash-vouchers, registered by cashVouchers.ts).
//
// ── Booked at pay (CashVoucher.bookedAtPay true; every pay since 2026-10-16) ──
// Owner, 2026-10-16: "It should pass only one entry when booked by finance,
// either docs are attached or not, if docs are attached with voucher after
// transaction is booked by Finance, it should only save the doc and attached
// it below the system generated voucher". Finance's pay was THE entry (Dr the
// voucher's 6xxx / Cr 1011 | 1010 | the bank — cashVouchers.ts). Here:
//   • POST /:id/documents — stored under the voucher; books nothing.
//   • POST /:id/spend — 409 EXPENSE_BOOKED_AT_PAY (nothing to record).
//   • POST /:id/verify-docs {note?} — finance marks the documents checked
//     (≥ 1 supporting document, receipt confirmed, never its own): disbursed →
//     posted, settledCents = amount. Books NOTHING. lines / changeCents /
//     changeBoxId / topUpBoxId → 422 EXPENSE_BOOKED_AT_PAY: a change or an
//     overspend is corrected by a manual journal (Finance → Journal).
//
// ── Vouchers still held from the 2026-10-15 hold flow (expenseOnVerify true,
//    bookedAtPay false) ──
// Owner, 2026-10-16: "Don't post any entry in 1357 … only book one entry when
// confirmed by finance". Their pay held the cash on 1357; nothing here books
// out of 1357 line by line any more. The boot run (voucherHoldConversion.ts)
// turns each into a one-entry voucher ('cashvoucher.hold_convert:<id>' Dr its
// expense / Cr 1357, dated the day it runs) and POST /:id/verify-docs runs the
// SAME conversion for one the boot could not convert yet, then checks the
// documents like any one-entry voucher (books nothing). One that still cannot
// convert (no usable category, equipment, a refused posting) is 409
// VOUCHER_STILL_HELD — finance fixes the cause or corrects it by manual
// journal. Supporting documents (POST/DELETE /:id/documents: PDF, images,
// Office, CSV / text through lib/evidenceFile.ts allowOffice, ≤ 5 MB, ≤ 20)
// work as for any voucher and book nothing; POST /:id/spend is retired.

// ── Legacy H3 rows (expenseOnVerify false: paid before 2026-10-15) ──
// H3 (Hasnain, 2026-10-14): "Expense at payment; receipts kept for the file."
// The pay already booked the whole amount to the request's category (Dr 6xxx /
// Cr 1011). So here (these four answer 409 USE_DOCUMENTS on a 2026-10-15
// voucher):
//   • POST /:id/receipts — the holder (or a keeper) uploads receipt photos /
//     PDFs. Evidence for the file: they book nothing by themselves.
//   • POST /:id/settlements — the receipts, read as lines, RECLASS the money
//     out of the account the pay booked (P, pettyCashPosting.ts
//     cashRequestPaidAccountTx): another category Dr 6xxx / Cr P; stock
//     Dr 12x0 / Cr P (a settled goods receipt, FIFO lots); equipment through
//     a CapEx cash payment Dr 1340 / Cr P; the same category posts nothing.
//     ONE entry 'cashvoucher.settle:<settlementId>' (postCashVoucherSettlementTx).
//   • PATCH /:id/settlements/:sid/lines/:lineId — finance moves an expense
//     line to another account (the settlement entry is reversed and reposted).
//   • POST /:id/return-change — cash handed back into a box: Dr 1011 / Cr P.
// The request is 'settled' when receipts + change returned cover its amount
// (Σ ≤ amount − settled − returned: 422 RECEIPTS_OVER_REQUEST / OVER_REMAINING).
//
// Company separation: every route loads the request in the operator's write
// scope first (another company's request is 404); boxes, items, CapEx lines,
// brands and outlets must be the request's own company's (422).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { zInt4Cents } from '../../lib/money.js'
import { decodeEvidenceFile } from '../../lib/evidenceFile.js'
import { flagException } from '../../lib/exceptions.js'
import { ensureFifoReady } from '../../lib/stockLedger.js'
import { resolveSpendAccount } from '../accounting/expenseCategories.js'
import {
  bookCashLinesTx, cashRequestPaidAccountTx, postCashVoucherSettlementTx,
  resolveSpendLinesTx, spendLineData, MAX_SPEND_LINES, type ResolvedSpendLine,
} from '../accounting/pettyCashPosting.js'
import { assertNotEquipmentLine } from '../fixedAssets/classes.js'
import { CASH_GUARD, mayBuyStock, recordPettyCashTopupTx } from './pettyCash.js'
import {
  auditVoucher, detailOf, loadVisible, loadVoucher, remainingOf, viewerOf, voucherTaskNotice, wrongStatus, CASH_VOUCHER_PHOTO_MAX_BYTES,
  type Viewer, type VoucherRow,
} from './cashVouchers.js'
import { convertHeldVoucher } from './voucherHoldConversion.js'

/** Receipts one request may carry. */
export const MAX_RECEIPTS_PER_REQUEST = 20
/** Supporting documents one voucher may carry (2026-10-15 flow). */
export const MAX_DOCUMENTS_PER_VOUCHER = 20
/** A supporting document may be at most 5 MB decoded. */
export const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024
/** base64 of 5 MB is ~6.7 MB; room for a data-URL prefix, the name and line breaks. */
const DOCUMENT_BODY_LIMIT = 8 * 1024 * 1024
/** base64 of 3 MB is 4 MB; room for a data-URL prefix and line breaks. */
const RECEIPT_BODY_LIMIT = 6 * 1024 * 1024

/** One line of a settlement (a box spend's line shape; the description is optional on a stock line). */
const SETTLE_LINE = z.object({
  kind:          z.enum(['expense', 'stock', 'capex']).default('expense'),
  categoryKey:   z.string().trim().min(1).max(40).nullable().optional(),
  accountCode:   z.string().trim().min(1).max(10).nullable().optional(),
  amountCents:   zInt4Cents('A line', { sign: 'positive' }),
  conceptId:     z.string().min(1).nullable().optional(),
  locationId:    z.string().min(1).nullable().optional(),
  description:   z.string().trim().max(200).default(''),
  notEquipment:  z.boolean().optional(),
  notEquipmentReason: z.string().max(500).nullable().optional(),
  inventoryItemId: z.string().min(1).nullable().optional(),
  quantity:      z.number().positive().nullable().optional(),
  unit:          z.string().max(20).nullable().optional(),
  capexLineId:   z.string().min(1).nullable().optional(),
})

const lockVoucherTx = (tx: { $queryRaw: typeof prisma.$queryRaw }, id: string) =>
  tx.$queryRaw`SELECT id FROM cash_vouchers WHERE id = ${id} FOR UPDATE`

/** The legacy H3 routes refuse a voucher paid under the 2026-10-15 flow. */
function assertLegacyRow(v: { number: string; expenseOnVerify: boolean }): void {
  if (v.expenseOnVerify) {
    throw new AppError('USE_DOCUMENTS', `Cash voucher ${v.number} is paid under the new flow — add supporting documents and finance verifies them`, 409)
  }
}

/** The requester, the holder (kind request), finance, a keeper or the paying box's custodian. */
function isDocsParty(viewer: Viewer, v: VoucherRow): boolean {
  return viewer.financeApprover || viewer.keeper || (!!v.box && v.box.custodianId === viewer.id)
    || v.preparedById === viewer.id
    || (v.kind === 'request' && !!v.payeeUserId && v.payeeUserId === viewer.id)
}

/** An expense line booked though it looks like equipment (finance / CEO override): raised in the request's company. */
export async function flagOverrides(
  v: { id: string; tenantId: string; number: string; conceptId: string | null },
  actorId: string,
  lines: Array<Pick<ResolvedSpendLine, 'accountCode' | 'amountCents' | 'description' | 'overrideReason'>>,
): Promise<void> {
  for (const l of lines) {
    await flagException({
      tenantId: v.tenantId,
      conceptId: v.conceptId,
      kind: 'equipment_override',
      severity: 'medium',
      title: `Cash request line booked as an expense though it looks like equipment: ${l.description}`.slice(0, 200),
      description: `${v.number}: "${l.description}" (PKR ${(l.amountCents / 100).toFixed(0)}) was booked to ${l.accountCode}. Reason given: ${l.overrideReason ?? '—'}. Equipment belongs on the register through CapEx.`,
      entityType: 'CashVoucher',
      entityId: v.id,
      actorId,
      amountCents: l.amountCents,
    })
  }
}

/**
 * Finance's check of a voucher booked at pay (bookedAtPay): marks the
 * documents checked — disbursed → posted (docsVerified*, posted*, settledCents
 * = amount) — and books NOTHING (the pay was the one entry). No lines, no
 * change, no overspend (422 EXPENSE_BOOKED_AT_PAY: a manual journal corrects
 * it). The caller has checked finance, self, receipt confirmed and ≥ 1 document.
 */
async function markDocsChecked(
  req: FastifyRequest,
  v: VoucherRow,
  viewer: Viewer,
  body: { lines?: unknown[]; changeCents?: number; changeBoxId?: string; topUpBoxId?: string; note?: string },
) {
  if (body.lines || (body.changeCents ?? 0) > 0 || body.changeBoxId || body.topUpBoxId) {
    throw new AppError('EXPENSE_BOOKED_AT_PAY', `Cash voucher ${v.number} was booked in one entry when finance paid it — checking its documents books nothing; correct any change or overspend with a manual journal`, 422)
  }
  const me = viewer.id
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await lockVoucherTx(tx, v.id)
    const docs = await tx.cashVoucherAttachment.count({ where: { voucherId: v.id, tenantId: v.tenantId, kind: 'supporting' } })
    if (docs === 0) throw new AppError('DOCS_REQUIRED', `Cash voucher ${v.number} has no supporting document yet`, 422)
    // The claim: checked once.
    const claimed = await tx.cashVoucher.updateMany({
      where: { id: v.id, tenantId: v.tenantId, status: 'disbursed', bookedAtPay: true, postedAt: null },
      data: {
        status: 'posted', docsVerifiedById: me, docsVerifiedAt: now, postedAt: now, postedById: me,
        settledCents: v.amountCents, settledAt: now,
      },
    })
    if (claimed.count === 0) {
      const cur = await tx.cashVoucher.findUniqueOrThrow({ where: { id: v.id }, select: { status: true, number: true } })
      if (cur.status === 'posted') throw new AppError('ALREADY_POSTED', `Cash voucher ${v.number} is already checked`, 409)
      throw wrongStatus('VOUCHER_NOT_AWAITING_DOCS', cur, 'finance checks a paid voucher')
    }
  })
  // A converted hold (voucherHoldConversion.ts) was booked by its conversion entry (postedJournalEntryId).
  const entryId = v.postedJournalEntryId ?? v.payJournalEntryId
    ?? (v.pettyCashMovementId
      ? (await prisma.pettyCashMovement.findUnique({ where: { id: v.pettyCashMovementId }, select: { journalEntryId: true } }))?.journalEntryId ?? null
      : null)
  await auditVoucher(req, 'verify_docs', v, {
    status: 'posted', bookedAtPay: true, payEntryId: entryId, postsNothing: true, ...(body.note && { note: body.note }),
  }, { status: v.status })
  voucherTaskNotice('verified', v.id, me)
  return { entryId, spentCents: v.amountCents, changeCents: 0, topUpCents: 0, voucher: await detailOf(v.id, viewer) }
}

export async function cashRequestSettleRoutes(fastify: FastifyInstance) {
  // POST /:id/receipts { photo, mime } — the holder or a keeper, while the
  // request is paid and open. JPEG / PNG / WebP / PDF (lib/evidenceFile.ts,
  // magic bytes, ≤ 3 MB → 400 BAD_FILE); at most 20 per request (409
  // TOO_MANY_RECEIPTS). Books nothing.
  fastify.post<{ Params: { id: string } }>('/:id/receipts', { preHandler: requireAuth(...ALL_STAFF), bodyLimit: RECEIPT_BODY_LIMIT }, async (req, reply) => {
    const body = z.object({ photo: z.string().min(1), mime: z.string().min(1).max(100) }).parse(req.body ?? {})
    const { v, viewer } = await loadVisible(req, req.params.id)
    if (!viewer.keeper && v.payeeUserId !== viewer.id) {
      throw new AppError('RECEIPT_NOT_ALLOWED', 'Only the person who holds this cash, finance or a manager can add its receipts', 403)
    }
    if (v.status !== 'disbursed') throw wrongStatus('VOUCHER_NOT_PAID', v, 'receipts are added once it is paid, until it is settled')
    assertLegacyRow(v)
    // Decoded before the transaction (never hold one across a decode).
    const file = decodeEvidenceFile(body.photo, body.mime, { allowPdf: true, maxBytes: CASH_VOUCHER_PHOTO_MAX_BYTES })
    const row = await prisma.$transaction(async (tx) => {
      await lockVoucherTx(tx, v.id)
      const cur = await tx.cashVoucher.findUniqueOrThrow({ where: { id: v.id }, select: { status: true, number: true } })
      if (cur.status !== 'disbursed') throw wrongStatus('VOUCHER_NOT_PAID', cur, 'receipts are added once it is paid, until it is settled')
      const count = await tx.cashVoucherAttachment.count({ where: { voucherId: v.id, kind: 'receipt' } })
      if (count >= MAX_RECEIPTS_PER_REQUEST) {
        throw new AppError('TOO_MANY_RECEIPTS', `A cash request takes at most ${MAX_RECEIPTS_PER_REQUEST} receipts`, 409)
      }
      return tx.cashVoucherAttachment.create({
        data: {
          tenantId: v.tenantId, voucherId: v.id, kind: 'receipt', mime: file.mime, sizeBytes: file.sizeBytes,
          data: file.bytes, uploadedById: viewer.id,
        },
        select: { id: true, mime: true, sizeBytes: true, createdAt: true, kind: true },
      })
    })
    await auditVoucher(req, 'receipt_add', v, { attachmentId: row.id, mime: row.mime, sizeBytes: row.sizeBytes })
    return reply.status(201).send(row)
  })

  // DELETE /:id/receipts/:aid — its uploader or a keeper, only while it is on
  // no settlement (409 RECEIPT_IN_USE).
  fastify.delete<{ Params: { id: string; aid: string } }>('/:id/receipts/:aid', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const { v, viewer } = await loadVisible(req, req.params.id)
    const att = await prisma.cashVoucherAttachment.findFirst({
      where: { id: req.params.aid, voucherId: v.id, tenantId: v.tenantId, kind: 'receipt' },
      select: { id: true, uploadedById: true },
    })
    if (!att) throw new NotFoundError('Receipt', req.params.aid)
    if (att.uploadedById !== viewer.id && !viewer.keeper) {
      throw new AppError('RECEIPT_NOT_ALLOWED', 'Only the person who added this receipt, finance or a manager can remove it', 403)
    }
    const gone = await prisma.cashVoucherAttachment.deleteMany({ where: { id: att.id, settlementId: null } })
    if (gone.count === 0) throw new AppError('RECEIPT_IN_USE', 'This receipt is on a submitted settlement — it cannot be removed', 409)
    await auditVoucher(req, 'receipt_remove', v, { attachmentId: att.id })
    return reply.status(204).send()
  })

  // POST /:id/settlements { lines, receiptIds, note? } — the holder or a
  // keeper submits receipts: lines [expense | stock | capex] (Σ ≤ what is
  // still open: 422 RECEIPTS_OVER_REQUEST), receipts of THIS request (≥ 1:
  // 400 RECEIPT_REQUIRED; another request's: 422 RECEIPT_NOT_ON_REQUEST; on
  // another settlement: 409 RECEIPT_IN_USE). Stock lines: keepers or roles
  // with the inventory module (403 STOCK_LINES_NOT_ALLOWED). One transaction
  // under the request's row lock: settlement + lines + receipts linked, stock
  // received / CapEx paid, the reclass entry posted, the counter moved, and
  // 'settled' when nothing is left open.
  fastify.post<{ Params: { id: string } }>('/:id/settlements', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({
      lines: z.array(SETTLE_LINE).max(MAX_SPEND_LINES),
      receiptIds: z.array(z.string().min(1).max(64)).max(MAX_RECEIPTS_PER_REQUEST).default([]),
      note: z.string().trim().max(500).nullable().optional(),
    }).parse(req.body ?? {})
    const { v, viewer } = await loadVisible(req, req.params.id)
    if (!viewer.keeper && v.payeeUserId !== viewer.id) {
      throw new AppError('SETTLE_NOT_ALLOWED', 'Only the person who holds this cash, finance or a manager can submit its receipts', 403)
    }
    if (v.status !== 'disbursed') throw wrongStatus('VOUCHER_NOT_PAID', v, 'receipts are submitted once it is paid, until it is settled')
    assertLegacyRow(v)
    if (body.lines.length === 0) throw new AppError('LINES_EMPTY', 'Say what the receipts were for — add at least one line', 400)
    const receiptIds = [...new Set(body.receiptIds)]
    if (receiptIds.length === 0) throw new AppError('RECEIPT_REQUIRED', 'Attach the receipts these lines come from', 400)
    const receipts = await prisma.cashVoucherAttachment.findMany({
      where: { id: { in: receiptIds }, voucherId: v.id, tenantId: v.tenantId, kind: 'receipt' },
      select: { id: true, settlementId: true },
    })
    if (receipts.length !== receiptIds.length) throw new AppError('RECEIPT_NOT_ON_REQUEST', 'A receipt was not uploaded on this cash request', 422)
    if (receipts.some((r) => r.settlementId)) throw new AppError('RECEIPT_IN_USE', 'A receipt is already on another settlement', 409)
    const total = body.lines.reduce((s, l) => s + l.amountCents, 0)
    if (total > remainingOf(v)) {
      throw new AppError('RECEIPTS_OVER_REQUEST', `The lines come to PKR ${(total / 100).toFixed(0)} but only PKR ${(remainingOf(v) / 100).toFixed(0)} of ${v.number} is still open`, 422)
    }
    const wantsStock = body.lines.some((l) => l.kind === 'stock')
    const stockAllowed = wantsStock ? await mayBuyStock(viewer) : false
    // The FIFO cut-over runs in its own transaction — before ours (stockLedger.ts).
    if (wantsStock && stockAllowed) await ensureFifoReady(v.tenantId)

    const done = await prisma.$transaction(async (tx) => {
      await lockVoucherTx(tx, v.id)
      const cur = await tx.cashVoucher.findUniqueOrThrow({
        where: { id: v.id },
        select: { status: true, number: true, amountCents: true, settledCents: true, returnedCents: true, convertedCents: true },
      })
      if (cur.status !== 'disbursed') throw wrongStatus('VOUCHER_NOT_PAID', cur, 'receipts are submitted once it is paid, until it is settled')
      const open = remainingOf(cur)
      if (total > open) {
        throw new AppError('RECEIPTS_OVER_REQUEST', `The lines come to PKR ${(total / 100).toFixed(0)} but only PKR ${(open / 100).toFixed(0)} of ${cur.number} is still open`, 422)
      }
      const paid = await cashRequestPaidAccountTx(tx, v.id)
      const resolved = await resolveSpendLinesTx(tx, v.tenantId, body.lines, {
        allowExplicit: viewer.keeper,
        actor: { id: viewer.id, role: viewer.role },
        stockAllowed,
      })
      const max = await tx.cashVoucherSettlement.aggregate({ where: { tenantId: v.tenantId, voucherId: v.id }, _max: { seq: true } })
      const settlement = await tx.cashVoucherSettlement.create({
        data: { tenantId: v.tenantId, voucherId: v.id, seq: (max._max.seq ?? 0) + 1, totalCents: total, note: body.note ?? null, submittedById: viewer.id },
      })
      const lineIds: string[] = []
      for (const l of resolved) {
        const row = await tx.pettyCashSpendLine.create({ data: { ...spendLineData(v.tenantId, l), settlementId: settlement.id }, select: { id: true } })
        lineIds.push(row.id)
      }
      const linked = await tx.cashVoucherAttachment.updateMany({
        where: { id: { in: receiptIds }, voucherId: v.id, kind: 'receipt', settlementId: null },
        data: { settlementId: settlement.id },
      })
      if (linked.count !== receiptIds.length) throw new AppError('RECEIPT_IN_USE', 'A receipt is already on another settlement', 409)
      await bookCashLinesTx(tx, {
        tenantId: v.tenantId, doc: { kind: 'cash_voucher_settlement', id: settlement.id }, creditCode: paid,
        lineIds, occurredAt: settlement.createdAt, actorId: viewer.id,
      })
      const posted = await postCashVoucherSettlementTx(tx, settlement.id, { postedBy: viewer.id })
      const closes = total === open
      await tx.cashVoucher.update({
        where: { id: v.id },
        data: { settledCents: { increment: total }, ...(closes && { status: 'settled', settledAt: new Date() }) },
      })
      return { settlementId: settlement.id, entryId: posted.entryId, paid, closes, overrides: resolved.filter((l) => l.equipmentOverride) }
    }, { timeout: 30_000, maxWait: 10_000 })

    await auditVoucher(req, 'settle', v, {
      settlementId: done.settlementId, totalCents: total, entryId: done.entryId, paidAccountCode: done.paid,
      lines: body.lines.length, receipts: receiptIds.length, settled: done.closes,
    })
    if (done.overrides.length) await flagOverrides(v, viewer.id, done.overrides)
    return { settlementId: done.settlementId, entryId: done.entryId, voucher: await detailOf(v.id, viewer) }
  })

  // PATCH /:id/settlements/:sid/lines/:lineId { categoryKey | accountCode } —
  // finance moves an EXPENSE line to another account (409 STOCK_LINE_FIXED
  // for stock / capex lines: their documents fix them). The settlement entry
  // is reversed today and reposted on its own date.
  fastify.patch<{ Params: { id: string; sid: string; lineId: string } }>('/:id/settlements/:sid/lines/:lineId', { preHandler: CASH_GUARD }, async (req) => {
    const body = z.object({
      categoryKey: z.string().trim().min(1).max(40).nullable().optional(),
      accountCode: z.string().trim().min(1).max(10).nullable().optional(),
      notEquipment: z.boolean().optional(),
      notEquipmentReason: z.string().max(500).nullable().optional(),
    }).parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    // A voucher of the 2026-10-15 flow: its booked entry is never re-posted (it would touch 1357) — a manual journal moves it.
    if (v.expenseOnVerify) {
      throw new AppError('USE_JOURNAL', `Cash voucher ${v.number} is booked — move its expense with a manual journal (Finance → Journal)`, 409)
    }
    const settlement = await prisma.cashVoucherSettlement.findFirst({ where: { id: req.params.sid, voucherId: v.id, tenantId: v.tenantId }, select: { id: true } })
    if (!settlement) throw new NotFoundError('CashVoucherSettlement', req.params.sid)
    const line = await prisma.pettyCashSpendLine.findFirst({ where: { id: req.params.lineId, settlementId: settlement.id, tenantId: v.tenantId } })
    if (!line) throw new NotFoundError('PettyCashSpendLine', req.params.lineId)
    if (line.kind !== 'expense') {
      throw new AppError('STOCK_LINE_FIXED', 'Only an expense line can be moved to another account — stock and CapEx lines are fixed by their documents', 409)
    }
    const acct = await resolveSpendAccount(prisma, v.tenantId, { categoryKey: body.categoryKey, accountCode: body.accountCode }, { allowExplicit: true })
    const eq = assertNotEquipmentLine({
      description: line.description, expenseAccountCode: acct.code, notEquipment: body.notEquipment, notEquipmentReason: body.notEquipmentReason ?? null,
    }, { role: req.staffUser!.role })
    if (acct.code === line.accountCode && acct.categoryKey === line.categoryKey) return { line, entryId: null, outcome: 'unchanged' }
    const result = await prisma.$transaction(async (tx) => {
      await lockVoucherTx(tx, v.id)
      const updated = await tx.pettyCashSpendLine.update({ where: { id: line.id }, data: { accountCode: acct.code, categoryKey: acct.categoryKey } })
      const posted = await postCashVoucherSettlementTx(tx, settlement.id, { postedBy: req.staffUser!.id })
      return { line: updated, entryId: posted.entryId }
    })
    await auditVoucher(req, 'settlement_line_reclass', v, { lineId: line.id, accountCode: acct.code, categoryKey: acct.categoryKey, entryId: result.entryId },
      { accountCode: line.accountCode, categoryKey: line.categoryKey })
    if (eq.overridden) {
      await flagOverrides(v, req.staffUser!.id, [{ accountCode: acct.code, amountCents: line.amountCents, description: line.description, overrideReason: body.notEquipmentReason ?? null }])
    }
    return { ...result, outcome: 'reposted' }
  })

  // POST /:id/return-change { amountCents, boxId? } — cash handed back into a
  // box (default the request's): its custodian or a keeper. ≤ what is still
  // open (422 OVER_REMAINING). A 'cash_request' top-up: Dr 1011 / Cr the
  // account the request was paid to; no top-up-limit check (it is the box's
  // own money coming back). 'settled' when nothing is left open.
  fastify.post<{ Params: { id: string } }>('/:id/return-change', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({
      amountCents: zInt4Cents('The change', { sign: 'positive' }),
      boxId: z.string().min(1).max(64).optional(),
    }).parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (v.status !== 'disbursed') throw wrongStatus('VOUCHER_NOT_PAID', v, 'change comes back on a paid request that is still open')
    assertLegacyRow(v)
    const boxId = body.boxId ?? v.boxId
    if (!boxId) throw new AppError('BOX_REQUIRED', 'Pick the cash box the change goes into', 422)
    const box = await prisma.pettyCashBox.findFirst({
      where: { id: boxId, tenantId: v.tenantId, deletedAt: null, isActive: true },
      select: { id: true, name: true, custodianId: true },
    })
    if (!box) throw new AppError('BOX_NOT_IN_COMPANY', 'That cash box is not an open petty-cash box of this request\'s company', 422)
    if (box.custodianId !== viewer.id && !viewer.keeper) {
      throw new ForbiddenError(`Only the cashier who holds ${box.name}, finance or a manager can take change back into it`)
    }
    if (body.amountCents > remainingOf(v)) {
      throw new AppError('OVER_REMAINING', `Only PKR ${(remainingOf(v) / 100).toFixed(0)} of ${v.number} is still open`, 422)
    }
    const done = await prisma.$transaction(async (tx) => {
      await lockVoucherTx(tx, v.id)
      const cur = await tx.cashVoucher.findUniqueOrThrow({
        where: { id: v.id },
        select: { status: true, number: true, amountCents: true, settledCents: true, returnedCents: true, convertedCents: true },
      })
      if (cur.status !== 'disbursed') throw wrongStatus('VOUCHER_NOT_PAID', cur, 'change comes back on a paid request that is still open')
      const open = remainingOf(cur)
      if (body.amountCents > open) throw new AppError('OVER_REMAINING', `Only PKR ${(open / 100).toFixed(0)} of ${cur.number} is still open`, 422)
      const topup = await recordPettyCashTopupTx(tx, {
        box: { id: box.id },
        amountCents: body.amountCents,
        reason: `Change returned on cash request ${cur.number}`,
        createdById: viewer.id,
        source: 'cash_request',
        cashVoucherId: v.id,
      })
      const closes = body.amountCents === open
      await tx.cashVoucher.update({
        where: { id: v.id },
        data: { returnedCents: { increment: body.amountCents }, ...(closes && { status: 'settled', settledAt: new Date() }) },
      })
      return { movement: topup.movement, newFloatCents: topup.newFloatCents, closes }
    }, { timeout: 20_000, maxWait: 10_000 })
    await auditVoucher(req, 'return_change', v, {
      amountCents: body.amountCents, boxId: box.id, pettyCashMovementId: done.movement.id, settled: done.closes,
    })
    return {
      voucher: await detailOf(v.id, viewer),
      movement: { id: done.movement.id, amountCents: done.movement.amountCents, createdAt: done.movement.createdAt, journalEntryId: done.movement.journalEntryId },
      newFloatCents: done.newFloatCents,
    }
  })

  // ── 2026-10-15 flow: supporting documents, spend lines, verification ──────

  // POST /:id/documents { fileName, mime, dataBase64 } — a supporting document
  // (kind 'supporting'). The holder (kind request), finance, a keeper or the
  // paying box's custodian, from 'approved' until it is posted; after posting
  // (or on a settled / converted legacy row) keepers only. Extension, mime and
  // magic bytes must agree (400 BAD_FILE); ≤ 5 MB; ≤ 20 per voucher (409
  // TOO_MANY_DOCUMENTS). Books nothing.
  fastify.post<{ Params: { id: string } }>('/:id/documents', { preHandler: requireAuth(...ALL_STAFF), bodyLimit: DOCUMENT_BODY_LIMIT }, async (req, reply) => {
    const body = z.object({
      fileName: z.string().trim().min(1).max(200),
      mime: z.string().trim().max(150).default(''),
      dataBase64: z.string().min(1),
    }).parse(req.body ?? {})
    const { v, viewer } = await loadVisible(req, req.params.id)
    const open = v.status === 'approved' || v.status === 'disbursed'
    const closed = v.status === 'posted' || v.status === 'settled' || v.status === 'converted'
    if (!open && !closed) throw wrongStatus('VOUCHER_NOT_APPROVED', v, 'documents are added once the CEO has approved it')
    if (open ? !isDocsParty(viewer, v) : !viewer.keeper) {
      throw new AppError('DOCUMENT_NOT_ALLOWED', open
        ? 'Only whoever asked for this cash, the person who holds it, the cashier, finance or a manager can add its documents'
        : 'Once it is verified, only finance or a manager can add documents', 403)
    }
    // Decoded before the transaction (never hold one across a decode).
    const file = decodeEvidenceFile(body.dataBase64, body.mime, { allowOffice: true, fileName: body.fileName, maxBytes: DOCUMENT_MAX_BYTES })
    const { row, receivedAt } = await prisma.$transaction(async (tx) => {
      await lockVoucherTx(tx, v.id)
      const cur = await tx.cashVoucher.findUniqueOrThrow({ where: { id: v.id }, select: { status: true, number: true, cashReceivedAt: true } })
      if (cur.status !== v.status && !(v.status === 'approved' && cur.status === 'disbursed') && !(v.status === 'disbursed' && cur.status === 'posted' && viewer.keeper)) {
        throw new AppError('VOUCHER_CHANGED', `Cash request ${cur.number} was changed by someone else — reload it`, 409)
      }
      const count = await tx.cashVoucherAttachment.count({ where: { voucherId: v.id, kind: 'supporting' } })
      if (count >= MAX_DOCUMENTS_PER_VOUCHER) {
        throw new AppError('TOO_MANY_DOCUMENTS', `A cash voucher takes at most ${MAX_DOCUMENTS_PER_VOUCHER} documents`, 409)
      }
      const created = await tx.cashVoucherAttachment.create({
        data: {
          tenantId: v.tenantId, voucherId: v.id, kind: 'supporting', mime: file.mime, fileName: file.fileName, sizeBytes: file.sizeBytes,
          data: file.bytes, uploadedById: viewer.id,
        },
        select: { id: true, kind: true, mime: true, fileName: true, sizeBytes: true, createdAt: true, uploadedById: true },
      })
      // The requester / holder attaching the bills of a paid request clearly has the cash: the upload confirms
      // receipt when nobody has yet (owner, 2026-10-16). Conditional, so a confirm racing it wins once.
      let receivedAt: Date | null = null
      const mine = v.payeeUserId === viewer.id || v.preparedById === viewer.id
      if (v.kind === 'request' && cur.status === 'disbursed' && !cur.cashReceivedAt && mine) {
        const now = new Date()
        const done = await tx.cashVoucher.updateMany({
          where: { id: v.id, status: 'disbursed', cashReceivedAt: null },
          data: { cashReceivedById: viewer.id, cashReceivedAt: now },
        })
        if (done.count === 1) receivedAt = now
      }
      return { row: created, receivedAt }
    })
    await auditVoucher(req, 'document_add', v, { attachmentId: row.id, fileName: row.fileName, mime: row.mime, sizeBytes: row.sizeBytes })
    if (receivedAt) await auditVoucher(req, 'confirm_received', v, { cashReceivedAt: receivedAt.toISOString(), via: 'document_upload', attachmentId: row.id })
    return reply.status(201).send(row)
  })

  // DELETE /:id/documents/:aid — its uploader or finance, only before finance
  // has verified the voucher (409 DOCUMENTS_LOCKED after).
  fastify.delete<{ Params: { id: string; aid: string } }>('/:id/documents/:aid', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const { v, viewer } = await loadVisible(req, req.params.id)
    const att = await prisma.cashVoucherAttachment.findFirst({
      where: { id: req.params.aid, voucherId: v.id, tenantId: v.tenantId, kind: 'supporting' },
      select: { id: true, uploadedById: true, fileName: true },
    })
    if (!att) throw new NotFoundError('Document', req.params.aid)
    if (att.uploadedById !== viewer.id && !viewer.financeApprover) {
      throw new AppError('DOCUMENT_NOT_ALLOWED', 'Only the person who added this document or finance can remove it', 403)
    }
    const gone = await prisma.$transaction(async (tx) => {
      await lockVoucherTx(tx, v.id)
      const cur = await tx.cashVoucher.findUniqueOrThrow({ where: { id: v.id }, select: { status: true } })
      if (cur.status !== 'approved' && cur.status !== 'disbursed') return -1
      return (await tx.cashVoucherAttachment.deleteMany({ where: { id: att.id, voucherId: v.id, tenantId: v.tenantId } })).count
    })
    if (gone === -1) throw new AppError('DOCUMENTS_LOCKED', `Cash voucher ${v.number} is verified — its documents stay on file`, 409)
    if (gone === 0) throw new NotFoundError('Document', req.params.aid)
    await auditVoucher(req, 'document_remove', v, { attachmentId: att.id, fileName: att.fileName })
    return reply.status(204).send()
  })

  // POST /:id/spend — retired (owner, 2026-10-16: one entry, nothing on
  // 1357): 409 EXPENSE_BOOKED_AT_PAY on every voucher of the documents flow.
  fastify.post<{ Params: { id: string } }>('/:id/spend', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { v } = await loadVisible(req, req.params.id)
    // Nothing is recorded line by line any more (1357 retired, owner 2026-10-16): a voucher booked at pay, or one
    // still held from the old flow (it is booked as one entry in its category when finance checks it).
    if (v.bookedAtPay || v.expenseOnVerify) {
      throw new AppError('EXPENSE_BOOKED_AT_PAY', `Cash voucher ${v.number} is booked in one entry in its category — attach the documents; finance corrects any difference with a manual journal`, 409)
    }
    throw wrongStatus('VOUCHER_NOT_AWAITING_DOCS', v, 'what was spent is recorded with receipts on a legacy cash request')
  })

  // POST /:id/verify-docs { note? } — finance checks the supporting documents.
  // A finance approver, never on their own voucher (409 SELF_APPROVE); a paid
  // voucher of the documents flow (409 ALREADY_POSTED once checked;
  // VOUCHER_NOT_AWAITING_DOCS otherwise); the cash receipt confirmed; ≥ 1
  // supporting document (422 DOCS_REQUIRED). Books NOTHING (markDocsChecked):
  // the pay was the one entry — or, for a voucher still held from the
  // 2026-10-15 flow, its one conversion entry, posted here first (409
  // VOUCHER_STILL_HELD if it cannot be). lines / changeCents / changeBoxId /
  // topUpBoxId → 422 EXPENSE_BOOKED_AT_PAY (a manual journal corrects change
  // or an overspend). Nothing ever posts to 1357 from here but that conversion.
  fastify.post<{ Params: { id: string } }>('/:id/verify-docs', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({
      lines: z.array(SETTLE_LINE).min(1).max(MAX_SPEND_LINES).optional(),
      changeCents: zInt4Cents('The change', { sign: 'nonnegative' }).optional(),
      changeBoxId: z.string().min(1).max(64).optional(),
      topUpBoxId: z.string().min(1).max(64).optional(),
      note: z.string().trim().max(500).optional(),
    }).parse(req.body ?? {})
    const v = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (!viewer.financeApprover) throw new AppError('NOT_FINANCE', 'Only finance verifies the documents of a cash voucher', 403)
    if (v.status === 'posted' || v.postedAt) throw new AppError('ALREADY_POSTED', `Cash voucher ${v.number} is already verified and booked`, 409)
    if (v.status !== 'disbursed' || !v.expenseOnVerify) {
      throw wrongStatus('VOUCHER_NOT_AWAITING_DOCS', v, 'finance verifies a voucher paid under the 2026-10-15 flow')
    }
    if (v.preparedById === viewer.id || v.payeeUserId === viewer.id) {
      throw new AppError('SELF_APPROVE', 'You raised or hold this voucher — another finance person verifies its documents', 409)
    }
    if (v.kind === 'request' && !v.cashReceivedAt) {
      throw new AppError('CASH_RECEIPT_NOT_CONFIRMED', `${v.number}: the person who took the cash has not confirmed receiving it yet`, 422)
    }
    if (!v.attachments.some((a) => a.kind === 'supporting')) {
      throw new AppError('DOCS_REQUIRED', `Cash voucher ${v.number} has no supporting document yet — they are uploaded first`, 422)
    }
    if (v.bookedAtPay) return markDocsChecked(req, v, viewer, body)
    // Still held on 1357 (paid under the 2026-10-15 hold flow): nothing is
    // booked out of 1357 here any more (owner, 2026-10-16). The voucher is
    // first made a one-entry voucher by THE conversion (voucherHoldConversion.ts,
    // the same keyed entry the boot run posts: Dr its expense / Cr 1357), and
    // its documents check then books nothing. If it cannot convert (no usable
    // category, equipment, a refused posting …) the check is refused — finance
    // fixes the cause or corrects it with a manual journal.
    if (body.lines || (body.changeCents ?? 0) > 0 || body.changeBoxId || body.topUpBoxId) {
      throw new AppError('EXPENSE_BOOKED_AT_PAY', `Cash voucher ${v.number} is booked as one entry in its category — checking its documents books nothing else; correct any change or overspend with a manual journal`, 422)
    }
    const conv = await convertHeldVoucher(v.id, { actorId: viewer.id })
    if (conv.outcome === 'refused') {
      throw new AppError(
        'VOUCHER_STILL_HELD',
        `Cash voucher ${v.number} was paid under the old hold flow and cannot be booked as one expense entry: ${conv.reason}. `
          + 'Fix that (for example set its expense category) and check its documents again, or correct it with a manual journal (Finance → Journal).',
        409,
        { reason: conv.code },
      )
    }
    const converted = await loadVoucher(req, v.id)
    if (!converted.bookedAtPay) throw wrongStatus('VOUCHER_NOT_AWAITING_DOCS', converted, 'finance checks a paid voucher')
    if (conv.outcome === 'converted') {
      await auditVoucher(req, 'hold_convert', v, { entryId: conv.entryId, accountCode: conv.accountCode, amountCents: conv.amountCents, bookedAtPay: true }, { bookedAtPay: false })
    }
    return markDocsChecked(req, converted, viewer, body)
  })
}
