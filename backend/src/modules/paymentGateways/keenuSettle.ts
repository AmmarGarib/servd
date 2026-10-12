// What a Keenu gateway callback does to our books — the webhook's body after
// the signature and idempotency checks (webhooks/routes.ts POST /webhooks/keenu).
//
//   SUCCESS  → the ONE settle (settlePayment in pos/service.ts, via 'gateway'):
//              the row is marked paid through the same claim, coverage rule
//              and completion as a till tender — never a bare status flip.
//              An underpayment (amount below the row) is refused.
//   FAILED   → the row is failed; a till card whose drawer already closed is
//              moved to the customer's receivable (postPosCardFailure).
//   REFUNDED → recorded on the row only. Money handed back to a customer is
//              a refund through the one refund engine (POST /pos/orders/:id/
//              refund), which books it; a processor-side reversal is
//              reconciled against the Keenu settlement statement.
//
// The old handler flipped the status with updateMany, so a confirmed card
// never completed its order, never filed its tax invoice and never reached
// the ledger.
//
// Card machine separation (spec D12 / §7.12): a callback only ever touches
// rows with gateway 'keenu', or legacy 'none' rows that are NOT a card-machine
// charge (no gatewayMeta.terminalChargeId). A 'card_terminal' payment is
// settled by the POS connector alone — even if the processor behind the card
// machine is Keenu and a callback carries the same transaction id, it is
// never settled, failed or marked refunded here (no double settlement).
//
// Raast QR (2026-10-12) replaced Keenu QR at the till. A Raast payment is a
// transfer straight to the company's bank (gateway 'raast'), recorded at the
// till or by the bank SMS — Keenu never settles, fails or refunds it. The
// gateway filter below already leaves 'raast' rows out; the method filter
// keeps any Raast row out too, whatever its gateway. Old keenu_qr rows are
// unchanged: still Keenu's to confirm.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { settlePayment } from '../pos/service.js'

type KeenuRow = { id: string; amountCents: number; status: string; shiftId: string | null; gateway: string; gatewayMeta: Prisma.JsonValue }

function metaOf(v: Prisma.JsonValue): Prisma.JsonObject {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Prisma.JsonObject : {}
}

/** A row a Keenu callback may act on: Keenu's own, or a legacy row that is not a card-machine charge. */
export function isKeenuRow(r: Pick<KeenuRow, 'gateway' | 'gatewayMeta'>): boolean {
  if (r.gateway === 'keenu') return true
  if (r.gateway !== 'none') return false
  return typeof metaOf(r.gatewayMeta)['terminalChargeId'] !== 'string'
}

export interface KeenuCallback {
  orderId: string
  transactionId: string
  status: string
  /** Paisa, as Keenu sends it. */
  amount?: number
}

export type KeenuOutcome =
  | { result: 'unmatched' }
  | { result: 'amount_mismatch'; expectedCents: number; gotCents: number }
  | { result: 'settled'; paymentId: string; orderCompleted: boolean; alreadySettled: boolean }
  | { result: 'failed'; paymentIds: string[] }
  | { result: 'refunded'; paymentIds: string[] }
  | { result: 'ignored'; status: string }

export async function applyKeenuCallback(cb: KeenuCallback, log: { error: (o: object, m: string) => void } = console as never): Promise<KeenuOutcome> {
  const all: KeenuRow[] = await prisma.payment.findMany({
    where: { orderId: cb.orderId, gatewayRef: cb.transactionId, gateway: { in: ['keenu', 'none'] }, method: { not: 'raast' } },
    select: { id: true, amountCents: true, status: true, shiftId: true, gateway: true, gatewayMeta: true },
  })
  const rows = all.filter(isKeenuRow)
  if (rows.length === 0) return { result: 'unmatched' }

  if (cb.status === 'SUCCESS') {
    const row = rows.find((r) => r.status === 'pending') ?? rows[0]!
    if (typeof cb.amount === 'number' && cb.amount < row.amountCents) {
      return { result: 'amount_mismatch', expectedCents: row.amountCents, gotCents: cb.amount }
    }
    const r = await settlePayment({ paymentId: row.id, via: 'gateway', gatewayRef: cb.transactionId })
    return { result: 'settled', paymentId: row.id, orderCompleted: r.orderCompleted, alreadySettled: r.alreadySettled }
  }

  if (cb.status === 'FAILED') {
    const open = rows.filter((r) => r.status === 'pending' || r.status === 'paid')
    await prisma.payment.updateMany({ where: { id: { in: open.map((r) => r.id) } }, data: { status: 'failed' } })
    const { postPosCardFailure } = await import('../accounting/shiftPosting.js')
    for (const p of open.filter((r) => r.shiftId)) {
      await postPosCardFailure(p.id).catch((err: Error) =>
        log.error({ paymentId: p.id, err: err.message }, 'Keenu failure could not be posted to the ledger'))
    }
    return { result: 'failed', paymentIds: open.map((r) => r.id) }
  }

  if (cb.status === 'REFUNDED') {
    // Recorded for reconciliation; the books move only through refundOrder.
    // Merged into the row's own meta (its idempotency key, tip, refund note).
    const at = new Date().toISOString()
    for (const r of rows) {
      await prisma.payment.update({
        where: { id: r.id },
        data: { gatewayMeta: { ...metaOf(r.gatewayMeta), keenu: { status: 'REFUNDED', at } } },
      })
    }
    return { result: 'refunded', paymentIds: rows.map((r) => r.id) }
  }

  return { result: 'ignored', status: cb.status }
}
