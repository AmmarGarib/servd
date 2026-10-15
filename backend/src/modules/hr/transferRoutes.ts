// "Move to head office" (D1 spec §5, A16) — CEO only. Registered under '/hr'
// by the orchestrator (backend/src/index.ts):
//
//   POST /hr/head-office-transfers/preview   what the move would do (blockers, warnings, leave, seats, logins)
//   POST /hr/head-office-transfers           do it — one transaction (hr/transfer.ts)
//
// Body: { employeeIds[], headOfficeTenantId, effectiveDate 'YYYY-MM-01',
//         keepJoiningDate? = true, keepCompanyMemberships? = [] }
// A head office or employee outside the CEO's companies → 404.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { previewTransfer, transferEmployeesToHeadOffice, MAX_TRANSFER_BATCH, type TransferActor, type TransferInput } from './transfer.js'

const zTransfer = z.object({
  employeeIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_TRANSFER_BATCH),
  headOfficeTenantId: z.string().min(1).max(64),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-01$/, 'The first day of a month (YYYY-MM-01)'),
  keepJoiningDate: z.boolean().optional().default(true),
  keepCompanyMemberships: z.array(z.string().min(1).max(64)).max(50).optional().default([]),
}).strict()

function actorOf(req: FastifyRequest): TransferActor {
  const su = req.staffUser!
  return { id: su.id, email: su.email, name: su.name, role: su.role, memberTenantIds: [...su.memberTenantIds] }
}

export async function hrHeadOfficeTransferRoutes(fastify: FastifyInstance) {
  const ceo = { preHandler: requireAuth(...ADMIN_ONLY) }

  fastify.post('/head-office-transfers/preview', ceo, async (req) => {
    const body: TransferInput = zTransfer.parse(req.body)
    return previewTransfer(body, actorOf(req))
  })

  fastify.post('/head-office-transfers', ceo, async (req, reply) => {
    const body: TransferInput = zTransfer.parse(req.body)
    return reply.status(201).send(await transferEmployeesToHeadOffice(body, actorOf(req)))
  })
}
