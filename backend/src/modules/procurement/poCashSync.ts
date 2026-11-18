// A PO's cash voucher follows what the buyer REALLY bought (owner, 2026-11-18: "Voucher not picking updated rates
// entered by buyer. extra cash has been disbursed … update vouchers as per updated rates through out servd. make sure
// no extra amount is lost").
//
// Applies to the ADVANCE vouchers of POs approved before the no-advance flow (poCash.ts; CashVoucher.purchaseOrderId).
// A PO approved since then raises no advance — its buyer is paid back at the bill (raiseReimbursementTx).
//
//   * NOT PAID yet (waiting for finance / the CEO, approved, returned): the voucher's amount IS the PO's current total.
//     syncPoCashVoucherTx sets it whenever the total changes (the buyer's completion, a GRN resubmit) and the boot
//     sweep fixes every one already out of step. Posts nothing (nothing was booked for an unpaid voucher).
//   * PAID (the cash went into the buyer's box): the amount stays what was handed over — it is what the ledger booked
//     (Dr 1011). poCashFigures compares it with what was bought (the PO's current total once the buyer completed it;
//     the bills of its approved GRNs once the PO is cancelled) and gives the EXTRA still in the buyer's box. Finance
//     returns it through the petty-cash return engine (POST /trustops/cash-vouchers/:id/return-po-excess →
//     recordPettyCashReturnTx: Dr 1010 | bank / Cr 1011), counted on CashVoucher.returnedCents. Until it is back an
//     open flag 'po_cash_excess' names the voucher, the buyer and the amount (the CEO's exceptions inbox + bell), so
//     it is never lost; it resolves itself when nothing is left to return. A shortfall (bought more than given) is
//     shown too — finance tops the box up (the existing top-up).

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { toCents } from '../../lib/money.js'
import { flagException } from '../../lib/exceptions.js'

type Db = Prisma.TransactionClient | typeof prisma

/** Voucher states in which nothing has been paid yet — the amount still follows the PO. */
export const PO_VOUCHER_UNPAID = ['draft', 'submitted', 'finance_approved', 'hod_signed', 'approved', 'returned'] as const
const PAID = ['disbursed', 'settled', 'converted', 'posted'] as const
/** PO states in which the buyer has entered what was really bought. */
const BOUGHT_STATES = ['completed', 'received', 'partial', 'closed'] as const

export const PO_CASH_EXCESS_FLAG = 'po_cash_excess' as const

/**
 * Set an UNPAID PO voucher's amount to the PO's current total (inside the caller's transaction). Returns the change,
 * or null when there is nothing to do (no voucher, already paid / closed, same amount, total 0).
 */
export async function syncPoCashVoucherTx(tx: Prisma.TransactionClient, poId: string, actorId: string | null): Promise<{ voucherId: string; number: string; from: number; to: number } | null> {
  const v = await tx.cashVoucher.findUnique({ where: { purchaseOrderId: poId }, select: { id: true, number: true, status: true, amountCents: true, tenantId: true } })
  if (!v || !(PO_VOUCHER_UNPAID as readonly string[]).includes(v.status)) return null
  const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, select: { totalCents: true, reference: true } })
  if (!po) return null
  const total = toCents(po.totalCents)
  if (!(total > 0) || total === v.amountCents || total > 2_147_483_647) return null
  const claimed = await tx.cashVoucher.updateMany({ where: { id: v.id, status: v.status, amountCents: v.amountCents }, data: { amountCents: total, grossCents: null } })
  if (claimed.count === 0) return null
  await tx.auditLog.create({
    data: {
      category: 'accounting', action: 'cash_voucher.po_amount_synced', entity: 'CashVoucher', entityId: v.id, tenantId: v.tenantId,
      userId: actorId, before: { amountCents: v.amountCents }, after: { amountCents: total, purchaseOrderId: poId, reference: po.reference },
    },
  })
  return { voucherId: v.id, number: v.number, from: v.amountCents, to: total }
}

export interface PoCashFigures {
  paid: boolean
  /** What the voucher handed over (its amount once paid). */
  givenCents: number
  /** What was really bought: the PO's current total once the buyer completed it; null while still being bought. */
  boughtCents: number | null
  /** Already handed back (CashVoucher.returnedCents). */
  returnedCents: number
  /** Extra still in the buyer's box: given − bought − returned (0 when none or not known yet). */
  excessCents: number
  /** Bought more than given: the box is short by this much (a top-up). */
  shortCents: number
  boxId: string | null
}

/** Cash given vs bought for a PO's voucher (header). */
export async function poCashFigures(db: Db, voucherId: string): Promise<PoCashFigures | null> {
  const v = await db.cashVoucher.findUnique({
    where: { id: voucherId },
    select: { purchaseOrderId: true, status: true, amountCents: true, returnedCents: true, pettyCashMovementId: true },
  })
  if (!v?.purchaseOrderId) return null
  const paid = (PAID as readonly string[]).includes(v.status)
  const po = await db.purchaseOrder.findUnique({ where: { id: v.purchaseOrderId }, select: { id: true, status: true, totalCents: true } })
  let bought: number | null = null
  if (po && (BOUGHT_STATES as readonly string[]).includes(po.status)) bought = toCents(po.totalCents)
  else if (po?.status === 'cancelled') {
    const bills = await db.supplierBill.findMany({ where: { poId: po.id, kind: 'bill', status: { not: 'void' } }, select: { totalCents: true } })
    bought = bills.reduce((s, b) => s + toCents(b.totalCents), 0)
  }
  const move = paid && v.pettyCashMovementId
    ? await db.pettyCashMovement.findUnique({ where: { id: v.pettyCashMovementId }, select: { boxId: true } })
    : null
  const given = v.amountCents
  const excess = paid && bought != null ? Math.max(0, given - bought - v.returnedCents) : 0
  const short = paid && bought != null ? Math.max(0, bought - given) : 0
  return { paid, givenCents: given, boughtCents: bought, returnedCents: v.returnedCents, excessCents: excess, shortCents: short, boxId: move?.boxId ?? null }
}

/**
 * Keep the 'po_cash_excess' flag true to the figures (after commit; never fails the caller): an open flag while extra
 * cash is still in the buyer's box (one per voucher, its amount kept current), resolved once nothing is left.
 */
export async function refreshPoCashExcessFlag(voucherId: string, actorId: string | null = null): Promise<void> {
  try {
    const f = await poCashFigures(prisma, voucherId)
    if (!f) return
    const open = await prisma.exceptionFlag.findFirst({ where: { kind: PO_CASH_EXCESS_FLAG, entityType: 'CashVoucher', entityId: voucherId, status: { in: ['open', 'acknowledged'] } }, select: { id: true } })
    if (f.excessCents <= 0) {
      if (open) await prisma.exceptionFlag.update({ where: { id: open.id }, data: { status: 'resolved', resolvedById: actorId, resolvedAt: new Date(), resolution: 'Extra cash returned — nothing left with the buyer' } })
      return
    }
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: voucherId }, select: { number: true, tenantId: true, payeeName: true, conceptId: true, purchaseOrderId: true } })
    const poRef = v.purchaseOrderId ? (await prisma.purchaseOrder.findUnique({ where: { id: v.purchaseOrderId }, select: { reference: true } }))?.reference : null
    const { fmtPkrCents } = await import('../../lib/money.js')
    const title = `${fmtPkrCents(f.excessCents)} extra cash with ${v.payeeName} — ${v.number}`
    const description = `${v.number} gave ${fmtPkrCents(f.givenCents)} for ${poRef ?? 'a PO'}, but the buyer bought ${fmtPkrCents(f.boughtCents ?? 0)}`
      + `${f.returnedCents ? ` (${fmtPkrCents(f.returnedCents)} already returned)` : ''}. Return the extra from the buyer's box on the voucher.`
    if (open) {
      await prisma.exceptionFlag.update({ where: { id: open.id }, data: { title, description, amountCents: f.excessCents } })
      return
    }
    await flagException({
      kind: PO_CASH_EXCESS_FLAG, severity: 'high', title, description, tenantId: v.tenantId, conceptId: v.conceptId,
      entityType: 'CashVoucher', entityId: voucherId, amountCents: f.excessCents, actorId,
      metadata: { givenCents: f.givenCents, boughtCents: f.boughtCents, returnedCents: f.returnedCents },
    })
  } catch (err) {
    console.warn('[poCashSync] flag refresh failed:', (err as Error).message)
  }
}

/** After a PO's total changed (commit done): its paid voucher's flag follows. */
export async function afterPoTotalChanged(poId: string, actorId: string | null): Promise<void> {
  const v = await prisma.cashVoucher.findUnique({ where: { purchaseOrderId: poId }, select: { id: true } })
  if (v) await refreshPoCashExcessFlag(v.id, actorId)
}

/**
 * Boot, every start (idempotent): every unpaid PO voucher takes its PO's current total; every paid one with extra cash
 * still with the buyer has its flag. Returns counts.
 */
export async function sweepPoCashVouchers(): Promise<{ synced: number; flagged: number }> {
  const vouchers = await prisma.cashVoucher.findMany({ where: { purchaseOrderId: { not: null } }, select: { id: true, purchaseOrderId: true, status: true } })
  let synced = 0, flagged = 0
  for (const v of vouchers) {
    if ((PO_VOUCHER_UNPAID as readonly string[]).includes(v.status)) {
      const r = await prisma.$transaction((tx) => syncPoCashVoucherTx(tx, v.purchaseOrderId!, null))
      if (r) synced++
    } else if ((PAID as readonly string[]).includes(v.status)) {
      const f = await poCashFigures(prisma, v.id)
      if (f && f.excessCents > 0) flagged++
      await refreshPoCashExcessFlag(v.id, null)
    }
  }
  return { synced, flagged }
}
