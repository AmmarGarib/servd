// Raast QR at the till (spec §6.6). Prefix /pos/raast, CASHIERS — ungated
// like /pos/terminal/* (no GATED_PREFIXES change, spec D7). Every order,
// drawer, intent and alert is resolved through the operator's companies first
// (foreign → 404; another company's drawer → 422). The money itself is taken
// by the existing processPayment / settlePayment (stream B) — these routes
// only create, confirm, cancel and attach.
//
// The rule every Raast screen repeats (D9): check the money on the COUNTER
// phone (bank SMS / merchant app), never the customer's screen.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CASHIERS, requireAuth } from '../auth/middleware.js'
import {
  raastConfigForShift, createRaastIntent, intentInScope, intentView, intentsForOrder, confirmRaastIntent, cancelRaastIntent,
  raastAlertsForShift, attachRaastAlert, fixReferenceFromAlert, dismissRaastAlert,
} from '../../connectors/raast/intents.js'
import { MANAGERS } from '../auth/middleware.js'

const idParam = z.object({ id: z.string().min(1).max(64) })
const isManager = (role: string) => (MANAGERS as readonly string[]).includes(role)

export async function raastPosRoutes(fastify: FastifyInstance) {
  // GET /pos/raast/config?shiftId&conceptId
  fastify.get('/config', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const q = z.object({ shiftId: z.string().min(1).max(64), conceptId: z.string().min(1).max(64).optional() }).parse(req.query)
    return raastConfigForShift(req, q)
  })

  // POST /pos/raast/intents — put the bill up for Raast (SMS matching ON).
  fastify.post('/intents', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const body = z.object({
      orderId: z.string().min(1).max(64),
      shiftId: z.string().min(1).max(64),
      paymentId: z.string().min(1).max(64).optional(),
      tipCents: z.number().int().min(0).default(0),
      expectedDueCents: z.number().int().min(0),
      idempotencyKey: z.string().min(8).max(100),
    }).strict().parse(req.body)
    const { view, replay } = await createRaastIntent(req, body)
    return reply.status(replay ? 200 : 201).send(view)
  })

  // GET /pos/raast/intents?orderId&active=1
  fastify.get('/intents', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const q = z.object({ orderId: z.string().min(1).max(64), active: z.enum(['0', '1']).optional() }).parse(req.query)
    return intentsForOrder(req, q.orderId, q.active === '1')
  })

  // GET /pos/raast/intents/:id
  fastify.get('/intents/:id', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    return intentView(await intentInScope(req, id), { staff: isManager(req.staffUser!.role) })
  })

  // POST /pos/raast/intents/:id/confirm {bankRef, counterVerified: true}
  fastify.post('/intents/:id/confirm', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ bankRef: z.string().trim().min(1).max(64), counterVerified: z.literal(true) }).strict().parse(req.body)
    return confirmRaastIntent(req, id, body)
  })

  // POST /pos/raast/intents/:id/cancel {reason?}
  fastify.post('/intents/:id/cancel', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ reason: z.string().trim().max(200).optional() }).strict().parse(req.body ?? {})
    return cancelRaastIntent(req, id, body.reason)
  })

  // GET /pos/raast/alerts?shiftId — open bank alerts for this drawer's company (last 48 h).
  fastify.get('/alerts', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const q = z.object({ shiftId: z.string().min(1).max(64) }).parse(req.query)
    return raastAlertsForShift(req, q.shiftId)
  })

  // POST /pos/raast/alerts/:id/attach {orderId, shiftId, paymentId?} | {receiptId, managerOverridePin?}
  fastify.post('/alerts/:id/attach', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.union([
      z.object({ orderId: z.string().min(1).max(64), shiftId: z.string().min(1).max(64), paymentId: z.string().min(1).max(64).optional() }).strict(),
      z.object({ receiptId: z.string().min(1).max(64), managerOverridePin: z.string().max(12).optional() }).strict(),
    ]).parse(req.body)
    if ('receiptId' in body) return { outcome: 'attached', intent: await fixReferenceFromAlert(req, id, body) }
    return attachRaastAlert(req, id, body)
  })

  // POST /pos/raast/alerts/:id/dismiss {reason, managerOverridePin?} — "not a sale" (manager).
  fastify.post('/alerts/:id/dismiss', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ reason: z.string().trim().min(3).max(300), managerOverridePin: z.string().max(12).optional() }).strict().parse(req.body)
    return dismissRaastAlert(req, id, body)
  })
}
