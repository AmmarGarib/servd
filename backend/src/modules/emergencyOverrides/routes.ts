// /emergency-overrides — Operations → Emergency overrides (Delivery &
// customers, resumed 2026-10-15). Contract and rules: ./README.md.
//
// Gate: GATED_PREFIXES in lib/moduleAccess.ts already gates this prefix on
// module `emergency_overrides` (default: foh_management, boh_management,
// fnb_manager, management and the CEO — never cashier, co-owner or the legacy
// manager), so the role list here is MANAGERS and the module decides. The
// CEO can untick the module per role in Module Access.
//
// Company scope: every order is resolved through the caller's scope on its
// brand's company (`write` for actions, `read` for reads) before anything is
// read or done — a foreign id is 404. Every action runs in the ORDER's
// company, and answers 409 CODE_ONLY_OFF unless that company's code-only
// delivery switch is on (the switch is the CEO's: GET/PUT /settings).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { rerouteHandoverCode, resendReroutedCode } from '../dispatch/service.js'
import { returnUndeliveredOrder, RETURN_CAUSES } from '../orders/returnedFood.js'
import {
  listSwitches, switchCodeOnly, orderInScope, assertCodeOnly, listOverrides, returnPreview, tenantIdsOf, orderNotFound,
} from './service.js'

type OrderParams = { Params: { id: string } }

declare module 'fastify' {
  interface FastifyRequest {
    /** The order an /emergency-overrides action resolved through the caller's write scope. */
    emergencyOrder?: { id: string; tenantId: string }
  }
}

const settingsBody = z.object({
  tenantId: z.string().uuid(),
  codeOnly: z.boolean(),
  reason: z.string().trim().min(10).max(500),
}).strict()

const sendCodeBody = z.object({
  reason: z.string().trim().min(10).max(300),
}).strict()

const foodReturnedBody = z.object({
  cause: z.enum(RETURN_CAUSES),
  reason: z.string().trim().min(5).max(500),
  managerOverridePin: z.string().trim().min(1).max(12).optional(),
}).strict()

/**
 * preHandler: resolve the order through the caller's WRITE scope (foreign →
 * 404) and refuse unless its company's code-only switch is on. Runs before
 * the route's rate limiter, so a foreign or refused call never spends an
 * order's resend budget.
 */
async function resolveActionOrder(req: FastifyRequest<OrderParams>): Promise<void> {
  const order = await orderInScope(req.params.id, await scopeTenantWhere(req, 'write'))
  await assertCodeOnly(order.tenantId)
  req.emergencyOrder = order
}

function actorOf(req: FastifyRequest, tenantId: string) {
  const su = req.staffUser!
  return { id: su.id, email: su.email ?? null, tenantId, role: su.role }
}

function orderOf(req: FastifyRequest): { id: string; tenantId: string } {
  if (!req.emergencyOrder) throw orderNotFound()
  return req.emergencyOrder
}

export default async function emergencyOverridesRoutes(fastify: FastifyInstance) {
  // ── 0. The switch ─────────────────────────────────────────────────────────
  // GET /settings — code-only delivery per company in the caller's read scope.
  fastify.get('/settings', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const companies = await listSwitches(tenantIdsOf(await scopeTenantWhere(req, 'read')))
    return { companies }
  })

  // PUT /settings — CEO only; the company must be one the CEO belongs to.
  fastify.put('/settings', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = settingsBody.parse(req.body)
    const su = req.staffUser!
    if (!(su.memberTenantIds ?? []).includes(body.tenantId)) throw orderNotFound()
    const company = await switchCodeOnly({ tenantId: body.tenantId, codeOnly: body.codeOnly, reason: body.reason, actorId: su.id })
    return { company }
  })

  // ── 1. The list ───────────────────────────────────────────────────────────
  fastify.get('/orders', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return listOverrides(tenantIdsOf(await scopeTenantWhere(req, 'read')))
  })

  // ── 2. Send the hand-over code to the rider (once per order) ──────────────
  fastify.post<OrderParams>(
    '/orders/:id/send-code-to-rider',
    { preHandler: [requireAuth(...MANAGERS), resolveActionOrder] },
    async (req) => {
      const body = sendCodeBody.parse(req.body ?? {})
      const order = orderOf(req)
      return rerouteHandoverCode(order.id, { actor: actorOf(req, order.tenantId), reason: body.reason })
    },
  )

  // ── 3. Resend the same code to the same rider: 3 per 10 minutes per order ─
  fastify.post<OrderParams>(
    '/orders/:id/send-code-to-rider/resend',
    {
      preHandler: [requireAuth(...MANAGERS), resolveActionOrder],
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '10 minutes',
          hook: 'preHandler',
          keyGenerator: (req: FastifyRequest) => `eo-resend:${String((req.params as { id?: string } | undefined)?.id ?? '')}`,
        },
      },
    },
    async (req) => {
      const order = orderOf(req)
      return resendReroutedCode(order.id, { actor: actorOf(req, order.tenantId) })
    },
  )

  // ── 4. Food came back ─────────────────────────────────────────────────────
  fastify.post<OrderParams>(
    '/orders/:id/food-returned',
    { preHandler: [requireAuth(...MANAGERS), resolveActionOrder] },
    async (req) => {
      const body = foodReturnedBody.parse(req.body ?? {})
      const order = orderOf(req)
      return returnUndeliveredOrder(order.id, {
        actor: actorOf(req, order.tenantId),
        cause: body.cause,
        reason: body.reason,
        ...(body.managerOverridePin ? { managerOverridePin: body.managerOverridePin } : {}),
      })
    },
  )

  // ── 5. What "Food came back" will do (the dialog) ─────────────────────────
  fastify.get<OrderParams>(
    '/orders/:id/return-preview',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const order = await orderInScope(req.params.id, await scopeTenantWhere(req, 'read'))
      return returnPreview(order.id)
    },
  )
}

export { emergencyOverridesRoutes }
