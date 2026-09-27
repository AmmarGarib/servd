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
// never completed its order, never filed FBR / SRB and never reached the
// ledger.

import { prisma } from '../../lib/prisma.js'
import { settlePayment } from '../pos/service.js'

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
  const rows = await prisma.payment.findMany({
    where: { orderId: cb.orderId, gatewayRef: cb.transactionId },
    select: { id: true, amountCents: true, status: true, shiftId: true },
  })
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
    await prisma.payment.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { gatewayMeta: { keenu: { status: 'REFUNDED', at: new Date().toISOString() } } },
    })
    return { result: 'refunded', paymentIds: rows.map((r) => r.id) }
  }

  return { result: 'ignored', status: cb.status }
}
