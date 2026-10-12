// Check splitting at POS.
//
// Strategy: an Order is one bill, but its Payment rows can be split across
// multiple diners. Each diner gets a Payment with the same orderId but a
// distinct splitGroup integer. Sum of all splits' amountCents must equal
// order total.
//
// This module only ALLOCATES the bill into portions. Taking the money for a
// portion is the ONE settle (settlePayment in pos/service.ts): an open drawer
// of the order's company, the card terminal's reference for card / QR, and
// the one coverage rule — the bill completes when the last portion is paid,
// and the group order's 'split' placeholder is voided. The settle here used
// to mark a portion paid on no drawer (group and storefront orders carry no
// shiftId), with no reference, never completing the order.
//
// FOH-10: the bill is re-priced for the portions' tenders BEFORE it is split
// (prepareSplitTx — the same tender rule a single payment uses), so a table
// paying entirely by card is charged GST at the card rate, not the cash rate
// it was rung up at. The split runs under the order lock the payment, settle
// and void take too.
//
// Card machine (spec §7.10): a split and a settle are refused (409
// TERMINAL_CHARGE_ACTIVE) while a card-machine charge is working on the bill
// — prepareSplitTx and settlePayment check it under the lock; likewise (409
// RAAST_AWAITING) while a Raast QR request waits for the customer's transfer.
// The settle returns the sale's `fiscal` view once the last portion completes
// the bill (and the deprecated `srb` alias, spec §8.4).
//
// Raast QR (2026-10-12): portions are paid with cash, Card – Keenu or Raast
// QR. A Raast portion is settled with its bank reference and the cashier's
// counter-device tick (`raastVerified: true` — spec D9), and gets its own
// RaastReceipt (pos/raastTender.ts). Keenu QR is retired: a split or an
// even split by it → 422 KEENU_QR_RETIRED.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { PaymentMethod, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, CASHIERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertShiftOf } from '../../lib/tenantScope.js'
import { settlePayment, prepareSplitTx, assertDrawerOperator, keenuQrRetired } from '../pos/service.js'
import { releaseRaastTargetsTx } from '../pos/raastTender.js'

/** A split portion's tender. 'keenu_qr' parses so it can be refused with 422 KEENU_QR_RETIRED. */
const portionMethodSchema = z.enum(['cash', 'card', 'raast', 'keenu_qr'])

function assertNotKeenuQr(methods: string[]): void {
  if (methods.includes('keenu_qr')) throw keenuQrRetired()
}

/** The order, in the operator's companies (write scope) — never the raw tenantFilter. */
async function orderInScope(req: FastifyRequest, id: string) {
  return prisma.order.findFirst({
    where: { id, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
    select: { id: true },
  })
}

/**
 * Scale portions that were worked out from the bill as it stood before the
 * tender re-price onto the re-priced total, keeping their proportions (largest
 * remainder, so they add up exactly). Null when a portion would round to 0.
 */
export function scalePortions(amounts: number[], from: number, to: number): number[] | null {
  if (from <= 0) return null
  const exact = amounts.map((a) => (a * to) / from)
  const out = exact.map(Math.floor)
  let left = to - out.reduce((s, a) => s + a, 0)
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    out[i]! += 1
    left -= 1
  }
  return out.some((a) => a <= 0) ? null : out
}

type Portion = { label: string; amountCents: number; method: PaymentMethod }

export async function checkSplitRoutes(fastify: FastifyInstance) {
  // POST /check-split/orders/:id/split — replace any existing splits with
  // these. Each entry will become a Payment with status='pending'. POS then
  // settles each one independently.
  //
  // The portions must add up to the bill AS RE-PRICED for their tenders. A
  // client that worked them out from the bill as it stood before (the stored
  // total) has them scaled onto the re-priced total, proportions kept; the
  // created rows (returned) carry the amounts to collect.
  fastify.post<{ Params: { id: string } }>(
    '/orders/:id/split',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({
        splits: z.array(z.object({
          label:       z.string().max(40).optional(),
          amountCents: z.number().int().min(1),
          // F-PAY02. No 'comp': a comp is not a split tender — it goes through
          // POST /pos/orders/:id/comp (caps, manager PIN, audit, drawer). No
          // 'split': a portion is paid with a real tender.
          method:      portionMethodSchema.default('card'),
        })).min(2).max(20),
      }).parse(req.body)
      assertNotKeenuQr(body.splits.map((s) => s.method))

      const order = await orderInScope(req, req.params.id)
      if (!order) throw new NotFoundError('Order', req.params.id)

      return prisma.$transaction(async (tx) => {
        const { totalCents, previousTotalCents } = await prepareSplitTx(tx, order.id, body.splits.map((s) => s.method))
        const asked = body.splits.map((s) => s.amountCents)
        const sum = asked.reduce((s, a) => s + a, 0)
        let amounts: number[] | null = sum === totalCents ? asked : null
        if (!amounts && sum === previousTotalCents && totalCents !== previousTotalCents) {
          amounts = scalePortions(asked, previousTotalCents, totalCents)
        }
        if (!amounts) {
          throw new AppError(
            'SPLIT_TOTAL_MISMATCH',
            `Splits sum to ${sum}, order total is ${totalCents}`,
            422,
            { totalCents },
          )
        }
        const portions: Portion[] = body.splits.map((s, i) => ({ label: s.label ?? `Split ${i + 1}`, amountCents: amounts![i]!, method: s.method }))
        return writePortions(tx, order.id, portions)
      }, { maxWait: 10_000, timeout: 15_000 })
    },
  )

  // POST /check-split/payments/:id/settle — take the money for one portion,
  // through the one settle. The drawer is the operator's open shift. A Raast
  // portion: `gatewayRef` is the bank reference and `raastVerified: true` the
  // cashier's counter-device tick; `raast` in the answer is its receipt.
  fastify.post<{ Params: { id: string } }>(
    '/payments/:id/settle',
    { preHandler: requireAuth(...CASHIERS) },
    async (req) => {
      const body = z.object({
        shiftId: z.string().uuid(),
        gatewayRef: z.string().trim().max(120).optional(),
        tenderedCents: z.number().int().min(0).optional(),
        raastVerified: z.literal(true).optional(),
      }).parse(req.body)
      const p = await prisma.payment.findFirst({
        where: {
          id: req.params.id,
          order: { concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        },
        select: { id: true, status: true, order: { select: { concept: { select: { tenantId: true } } } } },
      })
      if (!p) throw new NotFoundError('Payment', req.params.id)
      if (p.status !== 'pending') throw new AppError('ALREADY_SETTLED', 'Payment is not pending', 422)
      // TILL-R7: an open drawer of the ORDER's company first — a foreign
      // drawer and a made-up id both answer 422, never "someone else's".
      await assertShiftOf(p.order.concept.tenantId, body.shiftId, true)
      // FOH-15: onto the caller's own drawer, unless a manager.
      await assertDrawerOperator(body.shiftId, req.staffUser!)
      const result = await settlePayment({
        paymentId: p.id, via: 'till', shiftId: body.shiftId, gatewayRef: body.gatewayRef, tenderedCents: body.tenderedCents,
        actorId: req.staffUser!.id,
        // The server sets the Raast meta of a cashier-typed reference (spec D9).
        raast: { via: 'cashier', cashierVerified: body.raastVerified === true },
      })
      return { ...result.payment, orderCompleted: result.orderCompleted, fiscal: result.fiscal, srb: result.srb, raast: result.raast }
    },
  )

  // Even-split helper — divide the bill among N equal portions, after the
  // bill is re-priced for the tender they will be paid with (FOH-10).
  fastify.post<{ Params: { id: string }; Body: { ways: number; method?: string } }>(
    '/orders/:id/split-evenly',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({
        ways:   z.number().int().min(2).max(20),
        method: portionMethodSchema.default('card'),   // F-PAY02
      }).parse(req.body)
      assertNotKeenuQr([body.method])
      const order = await orderInScope(req, req.params.id)
      if (!order) throw new NotFoundError('Order', req.params.id)

      return prisma.$transaction(async (tx) => {
        const { totalCents } = await prepareSplitTx(tx, order.id, Array.from({ length: body.ways }, () => body.method))
        const base   = Math.floor(totalCents / body.ways)
        const remainder = totalCents - base * body.ways
        if (base <= 0) throw new AppError('SPLIT_TOO_SMALL', `A bill of ${totalCents} cannot be split ${body.ways} ways`, 422)
        const portions: Portion[] = Array.from({ length: body.ways }, (_, i) => ({
          label: `Diner ${i + 1}`,
          amountCents: base + (i < remainder ? 1 : 0),  // residue to first N
          method: body.method,
        }))
        return writePortions(tx, order.id, portions)
      }, { maxWait: 10_000, timeout: 15_000 })
    },
  )
}

/**
 * Replace the pending rows (the group placeholder, an earlier split) with
 * these portions. A Raast receipt that pointed at a replaced portion (one
 * that needs attention — an awaiting Raast request blocks the re-split) has
 * no portion to settle any more: its target is cleared (S6).
 */
async function writePortions(
  tx: Prisma.TransactionClient,
  orderId: string,
  portions: Portion[],
) {
  const replaced = await tx.payment.findMany({ where: { orderId, status: 'pending' }, select: { id: true } })
  await releaseRaastTargetsTx(tx, replaced.map((p) => p.id))
  await tx.payment.deleteMany({ where: { orderId, status: 'pending' } })
  const created = []
  for (const [i, s] of portions.entries()) {
    created.push(await tx.payment.create({
      data: {
        orderId,
        // The drawer is the one that takes the money, set at settle.
        shiftId:     null,
        method:      s.method,
        amountCents: s.amountCents,
        status:      'pending',
        splitGroup:  i + 1,
        splitLabel:  s.label,
      },
    }))
  }
  return created
}
