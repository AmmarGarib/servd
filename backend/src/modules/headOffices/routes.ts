// CEO → Head offices (D1). Mounted at /head-offices by headOffices/index.ts
// (registerHeadOfficePlugins); module gate 'tenants' (lib/moduleAccess.ts
// GATED_PREFIXES). EVERY route is CEO-only (requireAuth(...ADMIN_ONLY)), and
// the CEO only sees head offices and companies they are a member of (404).
//
//   GET    /                                      head offices (member) + counts
//   POST   /                                      {name, isTest?} — create (recharge OFF)
//   GET    /:id                                   links, current split, books status, last runs, HO-wide hand-overs
//   PATCH  /:id                                   {name?, isActive?} — 409 HEAD_OFFICE_IN_USE to switch off while in use
//   POST   /:id/companies                         {companyTenantId, extendDelegationIds?, revokeDelegationIds?}
//   POST   /:id/companies/:companyId/end          {reason, lastChargedPeriod}
//   GET    /:id/splits                            every version
//   POST   /:id/splits                            {effectiveFrom, lines[{companyTenantId, shareBps}], note?}
//   DELETE /:id/splits/:splitId                   only while no run uses it
//   GET    /:id/books
//   PUT    /:id/books/accounts                    {rechargeAccountId?, charges?[{companyTenantId, accountId}]}
//   PUT    /:id/books/pool                        {include[{from,to}], includeCodes[], excludeCodes[]}
//   POST   /:id/books/confirm                     {note, taxAnswer} (both ≥10 characters)
//   PUT    /:id/books/recharge                    {enabled, fromPeriod?, requireLockedPayroll?}
//
// The setup wizard (/setup/preview, /setup) lives in headOffices/setup.ts and
// the recharge runs at /accounting/intercompany/recharge-runs (runRoutes.ts).
//
// Every write runs in ONE serviceClient transaction (the head office and its
// companies are proven to be the CEO's first) and is audited in the head
// office's trail AND each touched company's trail.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { serviceClient } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit, type AuditCategory } from '../../lib/audit.js'
import { invalidateTestTenants } from '../../lib/testCompany.js'
import { monthOf } from '../intercompany/fleet.js'
import { createHeadOffice, linkCompany, endLink, assertHeadOfficeMayDeactivate, liveHoWideDelegationIds } from './service.js'
import { createSplitVersion, deleteSplitVersion, listSplits, splitForOrNull } from './splits.js'
import { trashReasonOf } from '../../lib/trash.js'
import { applyMapping } from './accounts.js'
import { booksView, confirmBooks, setRecharge, updatePool, zConfirm, zCostPool, zRecharge } from './books.js'

const TX_OPTS = { timeout: 30_000 } as const
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/** 404 unless :id is a live head office the CEO is a member of. */
async function headOfficeOf(req: FastifyRequest, id: string) {
  const su = req.staffUser!
  const ho = await serviceClient.tenant.findFirst({
    where: { id, kind: 'head_office', deletedAt: null },
    select: { id: true, name: true, slug: true, isActive: true, isTest: true, createdAt: true },
  })
  if (!ho || !su.memberTenantIds.includes(ho.id)) throw new NotFoundError('Head office', id)
  return ho
}

/** One audit row per tenant (the head office and each company the change touches). */
async function auditIn(
  req: FastifyRequest,
  tenantIds: Array<string | null | undefined>,
  e: { category: AuditCategory; action: string; entity: string; entityId: string; before?: unknown; after?: unknown; metadata?: unknown },
): Promise<void> {
  const su = req.staffUser!
  for (const tenantId of new Set(tenantIds.filter((t): t is string => !!t))) {
    await audit({ ...e, userId: su.id, userEmail: su.email, tenantId, metadata: { ...(e.metadata as object | undefined), ip: req.ip } })
  }
}

/** Audit the recharge switch going OFF as a side effect of a change. */
async function auditRechargeOff(req: FastifyRequest, hoId: string, wasEnabled: boolean, why: string): Promise<void> {
  if (!wasEnabled) return
  await auditIn(req, [hoId], {
    category: 'accounting', action: 'ho.recharge.disable', entity: 'HeadOfficeBooks', entityId: hoId,
    before: { rechargeEnabled: true }, after: { rechargeEnabled: false }, metadata: { reason: why },
  })
}

export async function headOfficeRoutes(fastify: FastifyInstance) {
  const ceo = { preHandler: requireAuth(...ADMIN_ONLY) }

  // ── List ─────────────────────────────────────────────────────────────────
  fastify.get('/', ceo, async (req) => {
    const su = req.staffUser!
    const rows = await serviceClient.tenant.findMany({
      where: { kind: 'head_office', deletedAt: null, id: { in: su.memberTenantIds } },
      select: {
        id: true, name: true, slug: true, isActive: true, isTest: true, createdAt: true,
        headOfficeBooks: { select: { accountsConfirmedAt: true, rechargeEnabled: true, rechargeFromPeriod: true, setupAppliedAt: true } },
        headOfficeLinks: { where: { endedAt: null }, select: { companyTenantId: true, company: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    })
    return {
      headOffices: rows.map((r) => ({
        id: r.id, name: r.name, slug: r.slug, isActive: r.isActive, isTest: r.isTest, createdAt: r.createdAt,
        companies: r.headOfficeLinks.map((l) => ({ id: l.companyTenantId, name: l.company.name })),
        confirmed: !!r.headOfficeBooks?.accountsConfirmedAt,
        rechargeEnabled: r.headOfficeBooks?.rechargeEnabled ?? false,
        rechargeFromPeriod: r.headOfficeBooks?.rechargeFromPeriod ?? null,
        setupAppliedAt: r.headOfficeBooks?.setupAppliedAt ?? null,
      })),
    }
  })

  // ── Create ───────────────────────────────────────────────────────────────
  fastify.post('/', ceo, async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(2).max(200), isTest: z.boolean().optional() }).parse(req.body)
    const su = req.staffUser!
    const created = await serviceClient.$transaction((tx) => createHeadOffice(tx, { name: body.name, actorId: su.id, isTest: body.isTest }), TX_OPTS)
    if (created.isTest) invalidateTestTenants()
    await auditIn(req, [created.id], {
      category: 'identity', action: 'ho.create', entity: 'Tenant', entityId: created.id,
      before: null, after: { name: created.name, kind: 'head_office', isTest: created.isTest, rechargeAccountId: created.rechargeAccountId },
    })
    return reply.status(201).send({ headOffice: created })
  })

  // ── Detail ───────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id', ceo, async (req) => {
    const ho = await headOfficeOf(req, req.params.id)
    const [links, currentSplit, books, runs, hoWideIds] = await Promise.all([
      serviceClient.headOfficeLink.findMany({
        where: { tenantId: ho.id },
        select: {
          id: true, companyTenantId: true, startedAt: true, endedAt: true, lastChargedPeriod: true, endReason: true,
          company: { select: { name: true, isTest: true, isActive: true } },
          charges: { select: { id: true, code: true, name: true, isActive: true } },
        },
        orderBy: [{ endedAt: { sort: 'desc', nulls: 'first' } }, { startedAt: 'asc' }],
      }),
      splitForOrNull(serviceClient, ho.id, monthOf(new Date())),
      booksView(serviceClient, ho.id).catch(() => null),
      serviceClient.rechargeRun.findMany({
        where: { tenantId: ho.id },
        select: {
          id: true, period: true, kind: true, status: true, stale: true, baseCents: true, rechargedCents: true,
          retainedCents: true, submittedAt: true, postedAt: true, createdAt: true,
        },
        orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
        take: 12,
      }),
      liveHoWideDelegationIds(serviceClient, ho.id),
    ])
    const delegations = hoWideIds.length
      ? await serviceClient.approvalDelegation.findMany({
        where: { id: { in: hoWideIds } },
        select: { id: true, section: true, approvalTypes: true, delegateUserId: true, startsAt: true, endsAt: true },
      })
      : []
    const users = delegations.length
      ? await serviceClient.user.findMany({ where: { id: { in: delegations.map((d) => d.delegateUserId) } }, select: { id: true, name: true } })
      : []
    const nameOf = new Map(users.map((u) => [u.id, u.name]))
    return {
      headOffice: ho,
      links: links.map((l) => ({
        id: l.id, companyTenantId: l.companyTenantId, companyName: l.company.name, companyIsTest: l.company.isTest,
        live: l.endedAt === null, startedAt: l.startedAt, endedAt: l.endedAt, lastChargedPeriod: l.lastChargedPeriod,
        endReason: l.endReason, chargesAccount: l.charges,
      })),
      currentSplit,
      books,
      lastRuns: runs,
      // A12: what a new link would extend — the link dialog asks extend / revoke for each.
      hoWideDelegations: delegations.map((d) => ({ ...d, delegateName: nameOf.get(d.delegateUserId) ?? null })),
    }
  })

  // ── Rename / switch off ──────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>('/:id', ceo, async (req) => {
    const body = z.object({ name: z.string().trim().min(2).max(200).optional(), isActive: z.boolean().optional() }).parse(req.body)
    const ho = await headOfficeOf(req, req.params.id)
    const updated = await serviceClient.$transaction(async (tx) => {
      if (body.isActive === false && ho.isActive) await assertHeadOfficeMayDeactivate(tx, ho.id)
      return tx.tenant.update({
        where: { id: ho.id },
        data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) },
        select: { id: true, name: true, slug: true, isActive: true, isTest: true },
      })
    }, TX_OPTS)
    await auditIn(req, [ho.id], {
      category: 'identity', action: 'ho.update', entity: 'Tenant', entityId: ho.id,
      before: { name: ho.name, isActive: ho.isActive }, after: { name: updated.name, isActive: updated.isActive },
    })
    return { headOffice: updated }
  })

  // ── Link a company ───────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/:id/companies', ceo, async (req, reply) => {
    const body = z.object({
      companyTenantId: z.string().min(1),
      extendDelegationIds: z.array(z.string().min(1)).max(200).optional(),
      revokeDelegationIds: z.array(z.string().min(1)).max(200).optional(),
    }).parse(req.body)
    const ho = await headOfficeOf(req, req.params.id)
    const su = req.staffUser!
    const r = await serviceClient.$transaction((tx) => linkCompany(tx, {
      hoId: ho.id, companyId: body.companyTenantId, actorId: su.id,
      extendDelegationIds: body.extendDelegationIds, revokeDelegationIds: body.revokeDelegationIds,
    }), TX_OPTS)
    await auditIn(req, [ho.id, r.link.companyTenantId], {
      category: 'identity', action: 'ho.link', entity: 'HeadOfficeLink', entityId: r.link.id,
      before: null,
      after: { headOffice: r.hoName, company: r.companyName, pairAccounts: r.pairAccounts, chargesAccount: r.chargesAccount },
      metadata: { extendedDelegationIds: r.extendedDelegationIds, revokedDelegationIds: r.revokedDelegationIds, confirmationCleared: r.wasConfirmed },
    })
    for (const id of r.revokedDelegationIds) {
      await auditIn(req, [ho.id], {
        category: 'identity', action: 'approval.delegation.revoke', entity: 'ApprovalDelegation', entityId: id,
        before: { revokedAt: null }, after: { reason: `revoked when ${r.companyName} was linked` },
      })
    }
    await auditRechargeOff(req, ho.id, r.wasEnabled, `${r.companyName} linked`)
    return reply.status(201).send(r)
  })

  // ── End a link ───────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string; companyId: string } }>('/:id/companies/:companyId/end', ceo, async (req) => {
    const body = z.object({
      reason: z.string().trim().min(3).max(500),
      lastChargedPeriod: z.string().regex(MONTH, 'Give the last charged month as YYYY-MM'),
    }).parse(req.body)
    const ho = await headOfficeOf(req, req.params.id)
    const su = req.staffUser!
    const r = await serviceClient.$transaction((tx) => endLink(tx, {
      hoId: ho.id, companyId: req.params.companyId, reason: body.reason, lastChargedPeriod: body.lastChargedPeriod, actorId: su.id,
    }), TX_OPTS)
    await auditIn(req, [ho.id, req.params.companyId], {
      category: 'identity', action: 'ho.unlink', entity: 'HeadOfficeLink', entityId: r.linkId,
      before: { live: true }, after: { live: false, lastChargedPeriod: body.lastChargedPeriod },
      metadata: { reason: body.reason, revokedDelegationIds: r.revokedDelegationIds, autoSplitId: r.autoSplit?.id ?? null, staleRuns: r.staleRuns },
    })
    for (const id of r.revokedDelegationIds) {
      await auditIn(req, [ho.id, req.params.companyId], {
        category: 'identity', action: 'approval.delegation.revoke', entity: 'ApprovalDelegation', entityId: id,
        before: { revokedAt: null }, after: { reason: 'company unlinked' },
      })
    }
    if (r.autoSplit) {
      await auditIn(req, [ho.id, ...r.autoSplit.lines.map((l) => l.companyTenantId), req.params.companyId], {
        category: 'accounting', action: 'ho.split.create', entity: 'RechargeSplit', entityId: r.autoSplit.id,
        before: null, after: r.autoSplit, metadata: { automatic: true, reason: `${r.companyName} unlinked` },
      })
    }
    await auditRechargeOff(req, ho.id, r.wasEnabled, `${r.companyName} unlinked`)
    return r
  })

  // ── Splits ───────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id/splits', ceo, async (req) => {
    const ho = await headOfficeOf(req, req.params.id)
    return { splits: await listSplits(serviceClient, ho.id), current: await splitForOrNull(serviceClient, ho.id, monthOf(new Date())) }
  })

  fastify.post<{ Params: { id: string } }>('/:id/splits', ceo, async (req, reply) => {
    const body = z.object({
      effectiveFrom: z.string().regex(MONTH, 'Give the first month as YYYY-MM'),
      lines: z.array(z.object({ companyTenantId: z.string().min(1), shareBps: z.number().int() })).min(1).max(100),
      note: z.string().trim().max(500).nullable().optional(),
    }).parse(req.body)
    const ho = await headOfficeOf(req, req.params.id)
    const su = req.staffUser!
    for (const l of body.lines) {
      if (!su.memberTenantIds.includes(l.companyTenantId)) throw new NotFoundError('Company', l.companyTenantId)
    }
    const r = await serviceClient.$transaction((tx) => createSplitVersion(tx, {
      hoId: ho.id, effectiveFrom: body.effectiveFrom, lines: body.lines, note: body.note ?? null, actorId: su.id,
    }), TX_OPTS)
    await auditIn(req, [ho.id, ...body.lines.map((l) => l.companyTenantId)], {
      category: 'accounting', action: 'ho.split.create', entity: 'RechargeSplit', entityId: r.split.id,
      before: null, after: r.split, metadata: { staleRuns: r.staleRuns },
    })
    return reply.status(201).send({
      ...r,
      retainedBps: 10_000 - r.split.totalBps,
      ...(r.split.totalBps < 10_000 ? { warning: `${((10_000 - r.split.totalBps) / 100).toFixed(2)}% stays with the head office` } : {}),
    })
  })

  fastify.delete<{ Params: { id: string; splitId: string } }>('/:id/splits/:splitId', ceo, async (req) => {
    const ho = await headOfficeOf(req, req.params.id)
    const r = await serviceClient.$transaction((tx) => deleteSplitVersion(tx, {
      hoId: ho.id, splitId: req.params.splitId, actorId: req.staffUser!.id, reason: trashReasonOf(req),
    }), TX_OPTS)
    await auditIn(req, [ho.id, ...r.split.lines.map((l) => l.companyTenantId)], {
      category: 'accounting', action: 'ho.split.delete', entity: 'RechargeSplit', entityId: r.split.id,
      before: r.split, after: null, metadata: { staleRuns: r.staleRuns },
    })
    return { deleted: r.split.id, staleRuns: r.staleRuns }
  })

  // ── Books ────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id/books', ceo, async (req) => {
    const ho = await headOfficeOf(req, req.params.id)
    return { books: await booksView(serviceClient, ho.id) }
  })

  fastify.put<{ Params: { id: string } }>('/:id/books/accounts', ceo, async (req) => {
    const body = z.object({
      rechargeAccountId: z.string().min(1).optional(),
      charges: z.array(z.object({ companyTenantId: z.string().min(1), accountId: z.string().min(1) })).max(100).optional(),
    }).parse(req.body)
    if (!body.rechargeAccountId && !(body.charges?.length)) {
      throw new AppError('NOTHING_TO_MAP', 'Give the recharge account or a company charges account', 422)
    }
    const ho = await headOfficeOf(req, req.params.id)
    const su = req.staffUser!
    for (const c of body.charges ?? []) {
      if (!su.memberTenantIds.includes(c.companyTenantId)) throw new NotFoundError('Company', c.companyTenantId)
    }
    const r = await serviceClient.$transaction((tx) => applyMapping(tx, ho.id, body, su.id), TX_OPTS)
    if (r.changed) {
      await auditIn(req, [ho.id, ...(body.charges ?? []).map((c) => c.companyTenantId)], {
        category: 'accounting', action: 'ho.accounts.map', entity: 'HeadOfficeBooks', entityId: ho.id,
        before: r.before, after: r.after, metadata: { confirmationCleared: r.wasConfirmed },
      })
      await auditRechargeOff(req, ho.id, r.wasEnabled, 'accounts re-mapped')
    }
    return { ...r, books: await booksView(serviceClient, ho.id) }
  })

  fastify.put<{ Params: { id: string } }>('/:id/books/pool', ceo, async (req) => {
    const pool = zCostPool.parse(req.body)
    const ho = await headOfficeOf(req, req.params.id)
    const su = req.staffUser!
    const r = await serviceClient.$transaction((tx) => updatePool(tx, ho.id, pool, su.id), TX_OPTS)
    await auditIn(req, [ho.id], {
      category: 'accounting', action: 'ho.pool.update', entity: 'HeadOfficeBooks', entityId: ho.id,
      before: r.before, after: r.after, metadata: { confirmationCleared: r.wasConfirmed },
    })
    await auditRechargeOff(req, ho.id, r.wasEnabled, 'cost pool changed')
    return { books: await booksView(serviceClient, ho.id) }
  })

  fastify.post<{ Params: { id: string } }>('/:id/books/confirm', ceo, async (req) => {
    const body = zConfirm.parse(req.body)
    const ho = await headOfficeOf(req, req.params.id)
    const su = req.staffUser!
    const row = await serviceClient.$transaction((tx) => confirmBooks(tx, ho.id, body, su.id), TX_OPTS)
    const companies = (await serviceClient.headOfficeLink.findMany({ where: { tenantId: ho.id, endedAt: null }, select: { companyTenantId: true } })).map((l) => l.companyTenantId)
    await auditIn(req, [ho.id, ...companies], {
      category: 'accounting', action: 'ho.accounts.confirm', entity: 'HeadOfficeBooks', entityId: ho.id,
      before: null, after: { accountsConfirmedAt: row.accountsConfirmedAt, note: body.note, taxAnswer: body.taxAnswer },
    })
    return { books: await booksView(serviceClient, ho.id) }
  })

  fastify.put<{ Params: { id: string } }>('/:id/books/recharge', ceo, async (req) => {
    const body = zRecharge.parse(req.body)
    const ho = await headOfficeOf(req, req.params.id)
    const su = req.staffUser!
    const r = await serviceClient.$transaction((tx) => setRecharge(tx, ho.id, body, su.id), TX_OPTS)
    if (r.before.rechargeEnabled !== r.after.rechargeEnabled || r.before.rechargeFromPeriod !== r.after.rechargeFromPeriod
      || r.before.requireLockedPayroll !== r.after.requireLockedPayroll) {
      const companies = (await serviceClient.headOfficeLink.findMany({ where: { tenantId: ho.id, endedAt: null }, select: { companyTenantId: true } })).map((l) => l.companyTenantId)
      await auditIn(req, [ho.id, ...companies], {
        category: 'accounting', action: r.after.rechargeEnabled ? 'ho.recharge.enable' : 'ho.recharge.disable', entity: 'HeadOfficeBooks', entityId: ho.id,
        before: { rechargeEnabled: r.before.rechargeEnabled, rechargeFromPeriod: r.before.rechargeFromPeriod, requireLockedPayroll: r.before.requireLockedPayroll },
        after: { rechargeEnabled: r.after.rechargeEnabled, rechargeFromPeriod: r.after.rechargeFromPeriod, requireLockedPayroll: r.after.requireLockedPayroll },
      })
    }
    return { books: await booksView(serviceClient, ho.id) }
  })
}
