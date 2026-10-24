// On account at the till — the doors (the rules are in onAccountTender.ts).
//
//   GET  /pos/on-account/enabled?orderId=…            → { enabled }
//        true only when the order's company has ≥ 1 active client AND its
//        till clearing is cut over to 1115 (until then every charge would be
//        refused TILL_CLEARING_NOT_SPLIT — the till hides the tender).
//   POST /pos/on-account/lookup { orderId, code }     → { account, card, quote, blocked }
//        20 a minute per login. 404 ON_ACCOUNT_CARD_UNKNOWN for a card that is
//        not this company's; 409 ON_ACCOUNT_CARD_REVOKED (flagged once a day).
//   GET  /pos/orders/:orderId/on-account/quote        → the bill at the cash rate
//   POST /pos/orders/:orderId/on-account
//        { shiftId, code, reference?, idempotencyKey } → 201 { payment, charge,
//        orderCompleted, fiscal, srb, replayed }
//        The drawer must be an OPEN shift of the order's company, and the
//        caller's own unless they are a manager. No manager PIN: the client's
//        card, credit limit and signature on the bill are the control.
//
// Who: the till (CASHIERS) of the ORDER's company — 'write' scope; a foreign
// order is 404. /pos is not module-gated (the till), like /pos/payments.
//
// The card code is a bearer secret, sent only in request BODIES: it is never
// logged (the app's request serializer logs method + URL only, never a body),
// never audited and never echoed in an error or a response.
//
// index.ts registers it: app.register(posOnAccountRoutes, { prefix: '/pos' }).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAuth, CASHIERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertShiftOf } from '../../lib/tenantScope.js'
import { assertDrawerOperator, quoteOrderForTender, requireManagerApproval } from './service.js'
import { chargeOrderToAccount, findTillOrderInScope, lookupCardForOrder, onAccountEnabledFor } from './onAccountTender.js'

const uuid = z.string().uuid()
const enabledQuery = z.object({ orderId: uuid })
const lookupBody = z.object({ orderId: uuid, code: z.string().min(1).max(40) })
const chargeBody = z.object({
  shiftId: uuid,
  // The client card — or (City Ledger, 2026-10-24) an account picked from the list plus a manager's approval.
  code: z.string().min(1).max(40).optional(),
  accountId: uuid.optional(),
  managerOverridePin: z.string().max(12).optional(),
  reference: z.string().max(80).nullish(),
  idempotencyKey: z.string().min(8).max(100),
})

/** Per-login limit on the routes that take a card code (keyed after auth). */
function perUser(prefix: string, max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: '1 minute',
      hook: 'preHandler' as const,
      keyGenerator: (req: FastifyRequest) => `${prefix}:${req.staffUser?.id ?? req.ip}`,
    },
  }
}

/** A bad order id is a 404 (never a hint that it exists elsewhere). */
function orderIdOf(raw: string): string {
  const p = uuid.safeParse(raw)
  if (!p.success) throw new NotFoundError('Order', String(raw))
  return p.data
}

export default async function posOnAccountRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/on-account/enabled', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const q = enabledQuery.safeParse(req.query)
    if (!q.success) throw new NotFoundError('Order')
    const order = await findTillOrderInScope(req, q.data.orderId)
    return { enabled: await onAccountEnabledFor(order.tenantId) }
  })

  fastify.post(
    '/on-account/lookup',
    { preHandler: requireAuth(...CASHIERS), config: perUser('oa-lookup', 20) },
    async (req) => {
      const body = lookupBody.parse(req.body)
      return lookupCardForOrder(req, body.orderId, body.code)
    },
  )

  fastify.get<{ Params: { orderId: string } }>(
    '/orders/:orderId/on-account/quote',
    { preHandler: requireAuth(...CASHIERS) },
    async (req) => {
      const order = await findTillOrderInScope(req, orderIdOf(req.params.orderId))
      return quoteOrderForTender(order.id, 'on_account')
    },
  )

  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/on-account',
    { preHandler: requireAuth(...CASHIERS), config: perUser('oa-charge', 30) },
    async (req, reply) => {
      const order = await findTillOrderInScope(req, orderIdOf(req.params.orderId))
      const body = chargeBody.parse(req.body)
      const su = req.staffUser!
      // The drawer: an OPEN shift of the order's own company, the caller's own unless a manager (FOH-15).
      await assertShiftOf(order.tenantId, body.shiftId, true)
      await assertDrawerOperator(body.shiftId, su)
      // No card: the account is picked from the City Ledger list, and a manager approves (signed in, or by PIN).
      let approverId: string | null = null
      if (!body.code) {
        if (!body.accountId) throw new AppError('ON_ACCOUNT_CARD_OR_MANAGER', 'Scan the client card, or pick the account and have a manager approve', 422)
        approverId = (await requireManagerApproval({
          actorId: su.id, actorRole: su.role, managerOverridePin: body.managerOverridePin ?? null,
          tenantId: order.tenantId, action: 'Charging a City Ledger account without its card', orderId: order.id,
        })).approverId
      }
      const result = await chargeOrderToAccount({
        orderId: order.id,
        shiftId: body.shiftId,
        code: body.code ?? null,
        accountId: body.code ? null : body.accountId ?? null,
        approverId,
        reference: body.reference ?? null,
        idempotencyKey: body.idempotencyKey,
        actor: { id: su.id, email: su.email },
      })
      return reply.status(201).send(result)
    },
  )
}
