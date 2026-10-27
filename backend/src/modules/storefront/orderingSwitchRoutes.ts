// The servd-wide customer-ordering switch (lib/onlineOrdering.ts; owner, 2026-10-27).
//   GET /ordering-switch — any staff login (the hours page shows it)
//   PUT /ordering-switch { on, reason ≥10 } — the CEO only, audited
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { audit } from '../../lib/audit.js'
import { readOnlineOrdering, writeOnlineOrdering } from '../../lib/onlineOrdering.js'

export async function orderingSwitchRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async () => readOnlineOrdering())

  fastify.put('/', { preHandler: requireAuth('admin') }, async (req) => {
    const body = z.object({ on: z.boolean(), reason: z.string().trim().min(10).max(300) }).parse(req.body)
    const before = await readOnlineOrdering()
    const after = await writeOnlineOrdering({ on: body.on, reason: body.reason, actorId: req.staffUser!.id })
    await audit({
      category: 'identity', action: body.on ? 'ordering.online.on' : 'ordering.online.off',
      entity: 'Setting', entityId: 'ordering.online',
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: req.staffUser!.tenantId ?? null,
      before: { on: before.on }, after: { on: after.on }, metadata: { reason: body.reason },
    })
    return after
  })
}
