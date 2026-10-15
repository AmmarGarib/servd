// POS connector change requests — the Dev hand-over (D1/D3 B4; spec §8.3).
// Prefix /connectors (module gate api_pos, like every /connectors route).
//
// IT prepares a change to a company's fiscal POS or card-machine settings; the
// CEO — or a live Dev hand-over (lib/approvalRights.ts, type
// `connector_change`) — applies it. This is the connectors module's own
// pending state (no second approval engine): the approvals inbox only READS
// GET /connectors/change-requests?status=submitted and its buttons call the
// approve / reject routes below, whose own guard decides.
//
//   GET  /connectors/change-requests?status&kind   read scope ∪ the companies the caller may approve in
//   POST /connectors/:kind/change-requests         CONNECTOR_ADMINS; through the head-office lens for a reach-only IT member
//   POST /connectors/change-requests/:id/approve   approvalSubject → assertCanApprove → claim submitted→applied → applyConnectorConfig (same tx)
//   POST /connectors/change-requests/:id/reject    same right; note required
//   POST /connectors/change-requests/:id/withdraw  the preparer only
//
// Secrets: an API key / webhook secret in a request is sealed with
// lib/secretBox.ts into apiKeyEnc / webhookSecretEnc (503 SECRET_KEY_MISSING
// without SERVD_SECRET_KEY), decrypted only inside the approve transaction,
// and wiped from the request row once it is decided. No response or audit row
// ever carries a secret or its ciphertext — `patch` holds only the markers
// 'set' / 'clear'. Regenerating a secret or rotating the webhook token is
// refused here (it returns a secret once — IT does it on the live page).
//
// NEVER delegable and never in a request: go-live, switch-off, "Fiscal
// reporting required" and releasing held sales stay the CEO's own routes
// (routes.ts). `enabled` on the fiscal POS is refused; the reporting switch
// is not a setting the patch schema accepts.
//
// Head offices (A24) have no fiscal POS: a request for a head office is 422.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Prisma, PosConnectorChange, UserRole } from '@prisma/client'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { decryptSecret, encryptSecret } from '../../lib/secretBox.js'
import { CONNECTOR_ADMINS } from '../../lib/connectorRoles.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { activeTenantId, scopeTenantWhere } from '../../lib/tenantScope.js'
import { isHeadOfficeTenant, viaHeadOfficeForSubmit, reachTenantIds } from '../../lib/headOffice.js'
import {
  APPROVAL_RIGHTS, approvalInputOf, approvalQueueTenantIds, approvalSubject, assertCanApprove, auditApproval,
  delegatedTenantsByType, type ApprovalGrant, type ApprovalType,
} from '../../lib/approvalRights.js'
import { invalidateConnector, isKnownDriver } from '../../connectors/registry.js'
import type { ConnectorKindT } from '../../connectors/types.js'
import {
  applyConnectorConfig, fiscalSettingsPatch, prepareConnectorConfig, putBody, terminalSettingsPatch, viewOf,
  type ConnectorConfigBody,
} from './applyConfig.js'

const TYPE: ApprovalType = 'connector_change'
const ADMINS = [...CONNECTOR_ADMINS] as UserRole[]
const VIEWERS = [...CONNECTOR_ADMINS, 'management'] as string[]

const kindParam = z.object({ kind: z.enum(['fiscal', 'terminal']) })
const idParam = z.object({ id: z.string().min(1).max(64) })

/** The request body: the PUT body, plus the two secret-returning actions — refused here. */
const changeBody = z.object({
  driver: z.string().min(1).max(40).optional(),
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(1000).optional(),
  webhookSecret: z.string().max(1000).optional(),
  regenerateWebhookSecret: z.boolean().optional(),
  rotateWebhookToken: z.boolean().optional(),
  enabled: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
}).strict()

/** What is stored in `patch` (never a secret: only the markers 'set' / 'clear'). */
const storedPatch = z.object({
  driver: z.string().min(1).max(40).optional(),
  baseUrl: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
  apiKey: z.enum(['set', 'clear']).optional(),
  webhookSecret: z.enum(['set', 'clear']).optional(),
}).strict()
type StoredPatch = z.infer<typeof storedPatch>

const listQuery = z.object({
  status: z.enum(['submitted', 'applied', 'rejected', 'withdrawn']).optional(),
  kind: z.enum(['fiscal', 'terminal']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

export interface ConnectorChangeView {
  id: string
  tenantId: string
  kind: string
  status: string
  /** The requested change — secrets appear only as 'set' / 'clear'. */
  patch: StoredPatch
  secretsIncluded: boolean
  preparedById: string
  preparedByIds: string[]
  preparedByName: string | null
  preparedAt: string
  viaHeadOfficeId: string | null
  decidedById: string | null
  decidedAt: string | null
  decisionNote: string | null
  decidedVia: string | null
}

function patchOf(raw: unknown): StoredPatch {
  const r = storedPatch.safeParse(raw)
  return r.success ? r.data : {}
}

function changeView(c: PosConnectorChange, names: Map<string, string | null> = new Map()): ConnectorChangeView {
  const patch = patchOf(c.patch)
  return {
    id: c.id,
    tenantId: c.tenantId,
    kind: c.kind,
    status: c.status,
    patch,
    secretsIncluded: patch.apiKey === 'set' || patch.webhookSecret === 'set',
    preparedById: c.preparedById,
    preparedByIds: c.preparedByIds,
    preparedByName: names.get(c.preparedById) ?? null,
    preparedAt: c.preparedAt.toISOString(),
    viaHeadOfficeId: c.viaHeadOfficeId,
    decidedById: c.decidedById,
    decidedAt: c.decidedAt?.toISOString() ?? null,
    decisionNote: c.decisionNote,
    decidedVia: c.decidedVia,
  }
}

async function namesOf(ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map()
  const rows = await serviceClient.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } })
  return new Map(rows.map((u) => [u.id, u.name]))
}

/** The PUT body a stored request stands for, its sealed secrets decrypted (inside the approve transaction only). */
function bodyOfChange(c: Pick<PosConnectorChange, 'patch' | 'apiKeyEnc' | 'webhookSecretEnc'>): ConnectorConfigBody {
  const p = patchOf(c.patch)
  const secret = (marker: 'set' | 'clear' | undefined, enc: string | null, what: string): string | undefined => {
    if (marker === undefined) return undefined
    if (marker === 'clear') return ''
    if (!enc) throw new AppError('CHANGE_CORRUPT', `The sealed ${what} of this request is missing — ask IT to send it again`, 409)
    return decryptSecret(enc)
  }
  const apiKey = secret(p.apiKey, c.apiKeyEnc, 'API key')
  const webhookSecret = secret(p.webhookSecret, c.webhookSecretEnc, 'webhook secret')
  return putBody.parse({
    ...(p.driver !== undefined && { driver: p.driver }),
    ...(p.baseUrl !== undefined && { baseUrl: p.baseUrl }),
    ...(p.enabled !== undefined && { enabled: p.enabled }),
    ...(p.settings !== undefined && { settings: p.settings }),
    ...(apiKey !== undefined && { apiKey }),
    ...(webhookSecret !== undefined && { webhookSecret }),
  })
}

/** The PUT body of a request with secrets left out (validation before the approve transaction). */
function bodyWithoutSecrets(p: StoredPatch): ConnectorConfigBody {
  return {
    ...(p.driver !== undefined && { driver: p.driver }),
    ...(p.baseUrl !== undefined && { baseUrl: p.baseUrl }),
    ...(p.enabled !== undefined && { enabled: p.enabled }),
    ...(p.settings !== undefined && { settings: p.settings }),
  }
}

/**
 * Approve / reject / the queue are ALL_STAFF in the preHandler (a hand-over
 * names an IT login), so the role gate is here: the type's role list
 * (APPROVAL_RIGHTS — the CEO) or a live hand-over of the type.
 */
async function assertApproverRoleOrDelegate(req: FastifyRequest): Promise<void> {
  const su = req.staffUser!
  if ((APPROVAL_RIGHTS[TYPE].roles as readonly string[]).includes(su.role)) return
  if (((await delegatedTenantsByType(su.id)).get(TYPE)?.size ?? 0) > 0) return
  throw new ForbiddenError(`Role '${su.role}' is not allowed for this resource`)
}

/** The right to decide one request: the facts on serviceClient first (A5), then assertCanApprove (widens RLS on success). */
async function decisionRight(req: FastifyRequest, id: string, action: 'approve' | 'reject') {
  await assertApproverRoleOrDelegate(req)
  const s = await approvalSubject(TYPE, id)
  if (!s) throw new NotFoundError('PosConnectorChange', id)
  let grant: ApprovalGrant
  try {
    grant = await assertCanApprove(req, approvalInputOf(TYPE, id, s, { entity: 'PosConnectorChange', action: `${action} POS connector change` }))
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) throw new NotFoundError('PosConnectorChange', id)
    throw err
  }
  if (s.status !== 'submitted') throw new AppError('BAD_STATE', `This request is already ${s.status}`, 409)
  return { s, grant }
}

function tenantIdsOf(where: { tenantId: string } | { tenantId: { in: string[] } }): string[] {
  return typeof where.tenantId === 'string' ? [where.tenantId] : [...where.tenantId.in]
}

export async function connectorChangeRoutes(fastify: FastifyInstance) {
  // GET /connectors/change-requests — the companies in read scope (connector
  // viewers), plus every company the caller may approve in (the CEO's member
  // companies in view, a Dev hand-over's cover). Anyone else: 403.
  fastify.get('/change-requests', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const q = listQuery.parse(req.query ?? {})
    const su = req.staffUser!
    const viewer = VIEWERS.includes(su.role)
    const approvable = await approvalQueueTenantIds(req, TYPE)
    if (!viewer && approvable.length === 0) throw new ForbiddenError(`Role '${su.role}' is not allowed for this resource`)
    const ids = new Set<string>(approvable)
    if (viewer) for (const t of tenantIdsOf(await scopeTenantWhere(req, 'read'))) ids.add(t)
    const rows = await serviceClient.posConnectorChange.findMany({
      where: { tenantId: { in: [...ids] }, ...(q.status && { status: q.status }), ...(q.kind && { kind: q.kind }) },
      orderBy: [{ preparedAt: 'desc' }, { id: 'asc' }],
      take: q.limit,
    })
    const names = await namesOf(rows.map((r) => r.preparedById))
    return { changes: rows.map((r) => changeView(r, names)) }
  })

  // POST /connectors/:kind/change-requests — IT prepares a change for the
  // active company (through the head-office lens: the reached company).
  fastify.post('/:kind/change-requests', { preHandler: requireAuth(...ADMINS) }, async (req, reply) => {
    const { kind } = kindParam.parse(req.params)
    const body = changeBody.parse(req.body ?? {})
    const tenantId = activeTenantId(req, 'the POS connector belongs to one company')
    if (body.regenerateWebhookSecret || body.rotateWebhookToken) {
      throw new AppError('REGENERATE_NOT_ALLOWED', 'A new webhook secret or address is shown only once — generate it on the POS connector page, not in a change request', 422)
    }
    if (await isHeadOfficeTenant(tenantId)) {
      throw new AppError('HEAD_OFFICE_HAS_NO_POS', 'A head office has no fiscal POS or card machine — pick a trading company', 422)
    }
    if (kind === 'fiscal' && body.enabled !== undefined) {
      throw new AppError('CEO_ONLY_SWITCH', 'Going live and switching the fiscal POS off are the CEO\'s own actions — they cannot be requested', 422)
    }
    if (body.driver !== undefined && !isKnownDriver(kind, body.driver)) throw new AppError('UNKNOWN_DRIVER', `No ${kind} driver called '${body.driver}'`, 422)
    if (body.settings !== undefined) {
      if (kind === 'fiscal') fiscalSettingsPatch.parse(body.settings)
      else terminalSettingsPatch.parse(body.settings)
    }

    const patch: StoredPatch = {
      ...(body.driver !== undefined && { driver: body.driver }),
      ...(body.baseUrl !== undefined && { baseUrl: body.baseUrl }),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.settings !== undefined && { settings: body.settings }),
    }
    const apiKey = body.apiKey?.trim()
    const webhookSecret = body.webhookSecret?.trim()
    if (apiKey !== undefined) patch.apiKey = apiKey ? 'set' : 'clear'
    if (webhookSecret !== undefined) patch.webhookSecret = webhookSecret ? 'set' : 'clear'
    if (Object.keys(patch).length === 0) throw new AppError('NOTHING_TO_CHANGE', 'The request changes nothing', 422)

    // Same early refusals as PUT (live fiscal driver / address, SSRF guard);
    // approval re-runs every check under the row lock.
    await prepareConnectorConfig(tenantId, kind, bodyWithoutSecrets(patch))
    // Seal (503 SECRET_KEY_MISSING without the key) — never stored in clear.
    const apiKeyEnc = apiKey ? encryptSecret(apiKey) : null
    const webhookSecretEnc = webhookSecret ? encryptSecret(webhookSecret) : null
    const viaHeadOfficeId = await viaHeadOfficeForSubmit(req, tenantId)

    const row = await prisma.posConnectorChange.create({
      data: {
        tenantId, kind, status: 'submitted',
        patch: JSON.parse(JSON.stringify(patch)) as Prisma.InputJsonValue,
        apiKeyEnc, webhookSecretEnc,
        preparedById: req.staffUser!.id, preparedByIds: [req.staffUser!.id],
        viaHeadOfficeId,
      },
    })
    await audit({
      category: 'identity', action: 'connectors.change_request.submit', entity: 'PosConnectorChange', entityId: row.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      metadata: { kind, changes: Object.keys(patch), viaHeadOfficeId },
    })
    return reply.status(201).send(changeView(row, await namesOf([row.preparedById])))
  })

  // POST /connectors/change-requests/:id/approve — apply it, in ONE
  // transaction: claim submitted → applied, decrypt the sealed secrets, then
  // applyConnectorConfig (the PUT's writer: row lock, validation, live-fiscal
  // refusals). Any refusal rolls the claim back — the request stays submitted.
  fastify.post('/change-requests/:id/approve', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const { s, grant } = await decisionRight(req, id, 'approve')
    const tenantId = s.ownerTenantId!
    const head = await serviceClient.posConnectorChange.findUniqueOrThrow({ where: { id }, select: { kind: true, patch: true } })
    const kind = head.kind as ConnectorKindT
    // Outside the transaction: seed the row, early live refusal, SSRF guard (DNS).
    const prepared = await prepareConnectorConfig(tenantId, kind, bodyWithoutSecrets(patchOf(head.patch)))
    const actorId = req.staffUser!.id
    const { change, updated, changed } = await prisma.$transaction(async (tx) => {
      const claimed = await tx.posConnectorChange.updateMany({
        where: { id, tenantId, status: 'submitted' },
        data: {
          status: 'applied', decidedById: actorId, decidedAt: new Date(), decidedVia: grant.via,
          delegationId: grant.via === 'delegation' ? grant.delegationId : null,
        },
      })
      if (claimed.count !== 1) throw new AppError('BAD_STATE', 'This request was decided by someone else a moment ago', 409)
      const c = await tx.posConnectorChange.findUniqueOrThrow({ where: { id } })
      const body = bodyOfChange(c)
      const out = await applyConnectorConfig(tx, tenantId, kind, body, { userId: actorId }, prepared)
      // The sealed secrets now live on the connector; the request keeps only the markers.
      const change = await tx.posConnectorChange.update({ where: { id }, data: { apiKeyEnc: null, webhookSecretEnc: null } })
      return { change, updated: out.updated, changed: out.changed }
    }, { maxWait: 10_000, timeout: 15_000 })
    invalidateConnector(tenantId, kind)
    await audit({
      category: 'identity', action: 'connectors.update', entity: 'PosConnector', entityId: updated.id,
      userId: actorId, userEmail: req.staffUser!.email, tenantId,
      metadata: { kind, driver: updated.driver, changed, changeRequestId: id, via: grant.via },
    })
    await auditApproval(req, { type: TYPE, id, tenantId, decision: 'approve', grant, entity: 'PosConnectorChange', metadata: { kind, changed } })
    return { change: changeView(change, await namesOf([change.preparedById])), connector: viewOf(updated) }
  })

  // POST /connectors/change-requests/:id/reject — note required.
  fastify.post('/change-requests/:id/reject', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const { s, grant } = await decisionRight(req, id, 'reject')
    const { note } = z.object({ note: z.string().trim().min(1).max(500) }).parse(req.body ?? {})
    const tenantId = s.ownerTenantId!
    const claimed = await prisma.posConnectorChange.updateMany({
      where: { id, tenantId, status: 'submitted' },
      data: {
        status: 'rejected', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: note, decidedVia: grant.via,
        delegationId: grant.via === 'delegation' ? grant.delegationId : null, apiKeyEnc: null, webhookSecretEnc: null,
      },
    })
    if (claimed.count !== 1) throw new AppError('BAD_STATE', 'This request was decided by someone else a moment ago', 409)
    await auditApproval(req, { type: TYPE, id, tenantId, decision: 'reject', grant, entity: 'PosConnectorChange', metadata: { reason: note } })
    const row = await serviceClient.posConnectorChange.findUniqueOrThrow({ where: { id } })
    return changeView(row, await namesOf([row.preparedById]))
  })

  // POST /connectors/change-requests/:id/withdraw — the preparer, while submitted.
  fastify.post('/change-requests/:id/withdraw', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const su = req.staffUser!
    const row = await serviceClient.posConnectorChange.findUnique({ where: { id } })
    const visible = new Set<string>([...(su.memberTenantIds ?? []), ...reachTenantIds(req)])
    if (!row || !visible.has(row.tenantId)) throw new NotFoundError('PosConnectorChange', id)
    if (row.preparedById !== su.id) throw new AppError('NOT_PREPARER', 'Only the person who prepared this request can withdraw it', 403)
    const claimed = await serviceClient.posConnectorChange.updateMany({
      where: { id, tenantId: row.tenantId, status: 'submitted', preparedById: su.id },
      data: { status: 'withdrawn', decidedById: su.id, decidedAt: new Date(), apiKeyEnc: null, webhookSecretEnc: null },
    })
    if (claimed.count !== 1) throw new AppError('BAD_STATE', `This request is already ${row.status}`, 409)
    await audit({
      category: 'identity', action: 'connectors.change_request.withdraw', entity: 'PosConnectorChange', entityId: id,
      userId: su.id, userEmail: su.email, tenantId: row.tenantId, metadata: { kind: row.kind },
    })
    const after = await serviceClient.posConnectorChange.findUniqueOrThrow({ where: { id } })
    return changeView(after, await namesOf([after.preparedById]))
  })
}
