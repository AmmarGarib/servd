// /api/v1/trash — the Trash bin (README.md).
//
//   GET    /trash/types                    types this login can see, open counts
//   GET    /trash                          list (?type&module&kind&state&from&to&q&cursor&limit)
//   GET    /trash/:type/:id                detail (preview, parent, references, history)
//   POST   /trash/:type/:id/restore        { rename?, unlink?, reason? }   masters
//   POST   /trash/:type/:id/copy           "Recover as copy"               transactions
//   DELETE /trash/:type/:id                ?reason= / { reason ≥10 }       CEO only
//   POST   /trash/:type/:id/archive|unarchive                              CEO only
//
// Open to every staff login, like /approvals: NOT in GATED_PREFIXES. Each type
// is gated here by its provider's module + roles; the company scope is
// scopeTenantWhere (read for lists, write for restore / purge / archive, the
// ACTIVE company for a copy). A head-office lens write is refused by the auth
// middleware (HEAD_OFFICE_SUBMIT_ONLY) — these routes are not on its allow-list.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { serviceClient } from '../../lib/prisma.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { trashReasonOf } from '../../lib/trash.js'
import {
  archiveTrashItem, copyTrashItem, getTrashItem, listTrash, listTypes, purgeTrashItem, restoreTrashItem,
} from './service.js'
import type { TrashCtx } from './types.js'

const FORWARD = ['authorization', 'cookie', 'x-servd-portfolio', 'x-servd-active-tenant'] as const

export interface TrashPluginOptions {
  /** Where module routes live for injected copies (default: this prefix minus '/trash'). */
  apiBase?: string
}

export async function trashRoutes(fastify: FastifyInstance, opts: TrashPluginOptions = {}) {
  const apiBase = (opts.apiBase ?? fastify.prefix.replace(/\/trash\/?$/, '')).replace(/\/$/, '')

  async function ctxOf(req: FastifyRequest): Promise<TrashCtx> {
    const su = req.staffUser!
    const u = await serviceClient.user.findUnique({ where: { id: su.id }, select: { moduleAllow: true, moduleDeny: true } })
    const headers: Record<string, string> = {}
    for (const h of FORWARD) {
      const v = req.headers[h]
      if (typeof v === 'string' && v) headers[h] = v
    }
    const [readScope, writeScope] = await Promise.all([scopeTenantWhere(req, 'read'), scopeTenantWhere(req, 'write')])
    return {
      req,
      user: { id: su.id, role: su.role as UserRole, name: su.name, email: su.email },
      isCeo: su.role === 'admin',
      modules: await effectiveModulesForUser({ role: su.role as UserRole, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] }),
      readScope,
      writeScope,
      activeTenantId: su.tenantId ?? null,
      async inject(method, path, body) {
        const res = await fastify.inject({
          method, url: `${apiBase}${path}`,
          headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
        })
        let json: unknown = null
        try { json = res.body ? res.json() : null } catch { json = res.body }
        return { statusCode: res.statusCode, json }
      },
    }
  }

  const params = z.object({ type: z.string().min(1).max(64), id: z.string().min(1).max(128) })
  const listQ = z.object({
    type: z.string().max(64).optional(),
    module: z.string().max(64).optional(),
    kind: z.enum(['master', 'transaction']).optional(),
    state: z.enum(['in_trash', 'restored', 'purged', 'archived']).default('in_trash'),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    q: z.string().trim().max(100).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  const restoreBody = z.object({
    rename: z.record(z.string().max(64), z.string().trim().min(1).max(200)).optional(),
    unlink: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
  }).default({})

  fastify.get('/types', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => listTypes(await ctxOf(req)))

  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const q = listQ.parse(req.query ?? {})
    return listTrash(await ctxOf(req), { ...q, q: q.q || undefined })
  })

  fastify.get('/:type/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { type, id } = params.parse(req.params)
    return getTrashItem(await ctxOf(req), type, id)
  })

  fastify.post('/:type/:id/restore', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { type, id } = params.parse(req.params)
    return restoreTrashItem(await ctxOf(req), type, id, restoreBody.parse(req.body ?? {}))
  })

  fastify.post('/:type/:id/copy', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { type, id } = params.parse(req.params)
    return copyTrashItem(await ctxOf(req), type, id)
  })

  fastify.delete('/:type/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const { type, id } = params.parse(req.params)
    await purgeTrashItem(await ctxOf(req), type, id, trashReasonOf(req) ?? '')
    return reply.status(204).send()
  })

  fastify.post('/:type/:id/archive', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const { type, id } = params.parse(req.params)
    await archiveTrashItem(await ctxOf(req), type, id, true)
    return reply.status(204).send()
  })

  fastify.post('/:type/:id/unarchive', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const { type, id } = params.parse(req.params)
    await archiveTrashItem(await ctxOf(req), type, id, false)
    return reply.status(204).send()
  })
}

/** Register on the /api/v1 scope:  await registerTrashPlugin(api)  →  /api/v1/trash */
export async function registerTrashPlugin(app: FastifyInstance, opts: TrashPluginOptions = {}): Promise<void> {
  await app.register(trashRoutes, { prefix: '/trash', ...opts })
}
