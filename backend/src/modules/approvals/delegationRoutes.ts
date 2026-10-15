// Hand-over routes (D3, spec §7.5). Registered inside the approvals plugin
// (routes.ts), so they live under /approvals:
//
//   POST /approvals/delegations              grant (CEO only)
//   POST /approvals/delegations/:id/revoke   revoke {reason} (CEO only; a second revoke → 409)
//   GET  /approvals/delegations              the CEO: every hand-over of their head offices; others: their own
//   GET  /approvals/delegations/eligible     ?headOfficeId&section — who could hold it (CEO only)
//   GET  /approvals/catalog                  sections → delegable types, with labels
//
// The logic is in delegations.ts on top of lib/approvalRights.ts. Rows are
// never edited or deleted. Granting and revoking stay CEO-only even after any
// hand-over (spec §7.7).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAuth, ADMIN_ONLY, ALL_STAFF } from '../auth/middleware.js'
import { delegationCatalog, eligibleDelegates, grantDelegation, listDelegations, revokeDelegation, type Actor } from './delegations.js'

const actorOf = (req: FastifyRequest): Actor => ({
  id: req.staffUser!.id,
  email: req.staffUser!.email,
  role: req.staffUser!.role,
  memberTenantIds: req.staffUser!.memberTenantIds ?? [],
})

const grantBody = z.object({
  headOfficeId: z.string().min(1).max(64),
  companyTenantId: z.string().min(1).max(64).nullable().optional(),
  section: z.string().min(1).max(40),
  approvalTypes: z.array(z.string().min(1).max(60)).max(30).optional(),
  delegateUserId: z.string().min(1).max(64),
  endsAt: z.coerce.date().nullable().optional(),
  note: z.string().trim().min(3).max(500),
})

export async function delegationRoutes(fastify: FastifyInstance) {
  fastify.get('/catalog', { preHandler: requireAuth(...ALL_STAFF) }, async () => ({ sections: delegationCatalog() }))

  fastify.get('/delegations', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => ({ delegations: await listDelegations(actorOf(req)) }))

  fastify.get('/delegations/eligible', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const q = z.object({ headOfficeId: z.string().min(1).max(64), section: z.string().min(1).max(40) }).parse(req.query ?? {})
    return { delegates: await eligibleDelegates(actorOf(req), q.headOfficeId, q.section) }
  })

  fastify.post('/delegations', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const b = grantBody.parse(req.body ?? {})
    const row = await grantDelegation(actorOf(req), { ...b, companyTenantId: b.companyTenantId ?? null, endsAt: b.endsAt ?? null })
    return reply.status(201).send({ delegation: row })
  })

  fastify.post<{ Params: { id: string } }>('/delegations/:id/revoke', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body ?? {})
    return { delegation: await revokeDelegation(actorOf(req), req.params.id, b.reason) }
  })
}
