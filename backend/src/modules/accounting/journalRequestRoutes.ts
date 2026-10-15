// /accounting/journal-requests — Finance prepares a manual journal, the CEO
// approves it (journalRequests.ts holds the rules). Registered by
// accounting/routes.ts, so it sits behind the `accounting` module gate.
//
//   GET    /                ?status&kind&mine&limit → { requests }
//   GET    /:id             → { request }
//   POST   /                preparers (admin, owner, management, finance) → 201 { request }
//   PATCH  /:id             the preparer; draft or returned
//   POST   /:id/submit      the preparer
//   POST   /:id/withdraw    the preparer
//   POST   /:id/approve     assertCanApprove (kind reverse: CEO only) → { request, entryId }
//   POST   /:id/reject      { note } → returned
//
// The four preparer writes are head-office submit routes (lib/headOffice.ts
// HO_SUBMIT_ROUTES); approve / reject are passthrough (the guard resolves the
// row's company itself).

import type { FastifyInstance } from 'fastify'
import type { UserRole } from '@prisma/client'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import {
  JR_PREPARERS, createRequestSchema, listQuerySchema, rejectSchema,
  approveRequest, createRequest, getRequest, listRequests, rejectRequest, submitRequest, updateRequest, withdrawRequest,
} from './journalRequests.js'

const PREPARERS = [...JR_PREPARERS] as UserRole[]

export async function journalRequestRoutes(fastify: FastifyInstance) {
  // Reads: preparers see their companies' requests; an approver (or, later, a
  // delegate) sees the queue they may decide. Anyone else: 403 in the handler.
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return listRequests(req, listQuerySchema.parse(req.query ?? {}))
  })

  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return { request: await getRequest(req, req.params.id) }
  })

  fastify.post('/', { preHandler: requireAuth(...PREPARERS) }, async (req, reply) => {
    const raw = (req.body ?? {}) as Record<string, unknown>
    const body = createRequestSchema.parse(raw.kind === undefined ? { ...raw, kind: 'post' } : raw)
    return reply.status(201).send({ request: await createRequest(req, body) })
  })

  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...PREPARERS) }, async (req) => {
    return { request: await updateRequest(req, req.params.id, req.body) }
  })

  fastify.post<{ Params: { id: string } }>('/:id/submit', { preHandler: requireAuth(...PREPARERS) }, async (req) => {
    return { request: await submitRequest(req, req.params.id) }
  })

  fastify.post<{ Params: { id: string } }>('/:id/withdraw', { preHandler: requireAuth(...PREPARERS) }, async (req) => {
    return { request: await withdrawRequest(req, req.params.id) }
  })

  // Decisions: the role path is the CEO (ADMIN_ONLY) — a Finance delegate only
  // once the owner switches journal_request on (A22). assertCanApprove decides.
  fastify.post<{ Params: { id: string } }>('/:id/approve', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return approveRequest(req, req.params.id)
  })

  fastify.post<{ Params: { id: string } }>('/:id/reject', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { note } = rejectSchema.parse(req.body ?? {})
    return { request: await rejectRequest(req, req.params.id, note) }
  })
}
