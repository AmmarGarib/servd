// GET /approvals         — the inbox: sections, counts per type + the items
//                          (?type= narrows the items, ?section= too, ?view=all
//                          lists the CEO's handed-over items inline)
// GET /approvals/counts  — counts only (the sidebar badge)
// + the hand-over routes (delegationRoutes.ts): /approvals/delegations*, /approvals/catalog
//
// Open to every staff login: what comes back is only what that login's
// EXISTING approve routes would let it act on, in the companies in view (plus
// the companies a live hand-over covers). Nothing here writes to a module; the
// inbox's buttons call each module's own route.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { reachTenantIds } from '../../lib/headOffice.js'
import { collectApprovals } from './service.js'
import { LIVE_DELEGATIONS, type ApprovalDelegations } from './delegations.js'
import { delegationRoutes } from './delegationRoutes.js'
import { APPROVAL_SECTIONS, APPROVAL_TYPES, type ProviderContext } from './types.js'

export interface ApprovalsPluginOptions {
  /** Where the module routes live (default: this plugin's prefix minus
   *  '/approvals', i.e. '/api/v1' when registered on the /api/v1 scope). */
  apiBase?: string
  /** Default: the live hand-overs (approval_delegations). Tests may pass NO_DELEGATIONS. */
  delegations?: ApprovalDelegations
}

/** The headers that make an internal read the same user, in the same
 *  company view. Nothing else is forwarded — in particular no forwarding
 *  headers, so these reads are internal (lib/internalRequest.ts) and never
 *  spend the user's rate-limit allowance. */
const FORWARD = ['authorization', 'cookie', 'x-servd-portfolio', 'x-servd-active-tenant'] as const

const AuthOnly = new Set([401, 403, 404])

export async function approvalsRoutes(fastify: FastifyInstance, opts: ApprovalsPluginOptions = {}) {
  const apiBase = (opts.apiBase ?? fastify.prefix.replace(/\/approvals\/?$/, '')).replace(/\/$/, '')
  const delegations = opts.delegations ?? LIVE_DELEGATIONS

  async function contextFor(req: FastifyRequest): Promise<ProviderContext> {
    const headers: Record<string, string> = {}
    for (const h of FORWARD) {
      const v = req.headers[h]
      if (typeof v === 'string' && v) headers[h] = v
    }
    const scope = await resolveTenantScope(req)
    return {
      user: { id: req.staffUser!.id, role: req.staffUser!.role },
      tenantIds: scope.tenantIds,
      memberTenantIds: req.staffUser!.memberTenantIds ?? [],
      reachTenantIds: reachTenantIds(req),
      delegated: delegations.tenantsByType ? await delegations.tenantsByType(req.staffUser!.id) : new Map(),
      async read<T>(path: string): Promise<T | null> {
        const res = await fastify.inject({ method: 'GET', url: `${apiBase}${path}`, headers })
        if (AuthOnly.has(res.statusCode)) return null
        if (res.statusCode >= 400) throw new Error(`GET ${path} answered ${res.statusCode}`)
        return res.json() as T
      },
    }
  }

  const query = z.object({
    type: z.enum(APPROVAL_TYPES).optional(),
    section: z.enum(APPROVAL_SECTIONS).optional(),
    view: z.enum(['all']).optional(),
  })

  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const q = query.parse(req.query ?? {})
    return collectApprovals(await contextFor(req), {
      delegations, ...(q.type && { only: q.type }), ...(q.section && { section: q.section }), ...(q.view && { view: q.view }),
    })
  })

  fastify.get('/counts', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const inbox = await collectApprovals(await contextFor(req), { delegations })
    return { total: inbox.total, elsewhere: inbox.elsewhere, types: inbox.types, sections: inbox.sections, handedOver: inbox.handedOver }
  })

  // The hand-over routes share the /approvals prefix.
  await fastify.register(delegationRoutes)
}

/**
 * Register the inbox on `app` — the /api/v1 scope in src/index.ts:
 *   await registerApprovalsPlugin(api)   →   /api/v1/approvals
 */
export async function registerApprovalsPlugin(app: FastifyInstance, opts: ApprovalsPluginOptions = {}): Promise<void> {
  await app.register(approvalsRoutes, { prefix: '/approvals', ...opts })
}
