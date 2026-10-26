// CEO → Head offices → "Set up head office from today's records" (D1, spec
// §14.3, amendments A3 and A15). Mounted by the orchestrator under
// /head-offices next to headOfficeRoutes; CEO only (requireAuth(...ADMIN_ONLY)).
//
//   GET  /setup/preview?companyIds=a,b&name=…   what apply would do, with planning before and after
//   POST /setup  {name?, companyIds?, split?, effectiveFrom?, addHodMemberships?}
//
// Apply runs in ONE transaction:
//   1. createHeadOffice('GS Head Office')       (service.ts; recharge OFF)
//   2. link every company                        (service.ts linkCompany: pair accounts, charges account)
//   3. split v1 effective this Karachi month     (splits.ts createSplitVersion; any other
//                                                 effectiveFrom → 422 EFFECTIVE_FROM_NOT_CURRENT_MONTH)
//   4. applyHeadOfficePeople                     (positions/headOfficeSetup.ts: departments, seats,
//                                                 share = gross, head_office contributions ended)
//   5. optional: the ticked HOD logins become members of the head office (A3 —
//      TenantMember only; their payroll moves at the CA's cutover month with
//      "Move to head office")
//   6. the setup marker (HeadOfficeBooks.setupAppliedAt) — planning, positions
//      and contributions switch to the head-office rules from here; a second
//      run → 409 SETUP_ALREADY_DONE
// then the audit 'ho.setup.apply' in the head office's and each company's trail.
// Recharge stays OFF until the CEO confirms the accounts with the CA.
//
// Company separation: the companies are the CEO's own member companies
// (anything else → 404); a company that is not an active trading company is
// refused by linkCompany (422 LINK_TARGET_NOT_A_COMPANY), any test company by
// 422 TEST_COMPANY_NOT_ALLOWED (the marker is platform-wide); an HOD login must already belong to one of the
// companies (422 HOD_NOT_IN_COMPANIES); an active head_office contribution with
// a company outside the setup is refused (422 CONTRIBUTION_OUTSIDE_SETUP) —
// the setup never ends another company's planning row.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { serviceClient } from '../../lib/prisma.js'
import { appendRlsTenantIds } from '../../lib/rlsContext.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { planMonth } from '../../lib/labour-budget.js'
import { applyHeadOfficePeople, planHeadOfficePeople, type HeadOfficePeoplePlan } from '../positions/headOfficeSetup.js'
import { createHeadOffice, linkCompany } from './service.js'
import { createSplitVersion } from './splits.js'

const TX_OPTS = { timeout: 60_000 } as const
export const DEFAULT_HEAD_OFFICE_NAME = 'GS Head Office'
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * The companies today's records put under a head office: the CEO's own active,
 * non-test trading companies that are party to an active head_office
 * contribution or hold a head-office department with a brand-less seat.
 */
async function defaultCompanies(memberIds: readonly string[]): Promise<string[]> {
  const members = await serviceClient.tenant.findMany({
    where: { id: { in: [...memberIds] }, kind: 'company', isActive: true, deletedAt: null, isTest: false },
    select: { id: true },
  })
  const ids = members.map((m) => m.id)
  if (!ids.length) return []
  const [contribs, seats] = await Promise.all([
    serviceClient.tenantContribution.findMany({
      where: { isActive: true, category: 'head_office', OR: [{ sourceTenantId: { in: ids } }, { destinationTenantId: { in: ids } }] },
      select: { sourceTenantId: true, destinationTenantId: true },
    }),
    serviceClient.position.findMany({
      where: { tenantId: { in: ids }, conceptId: null, status: { not: 'archived' }, department: { isHeadOffice: true, archivedAt: null } },
      select: { tenantId: true },
    }),
  ])
  const found = new Set<string>()
  for (const c of contribs) for (const t of [c.sourceTenantId, c.destinationTenantId]) if (ids.includes(t)) found.add(t)
  for (const s of seats) found.add(s.tenantId)
  return ids.filter((id) => found.has(id))
}

/** The companies named (or the default), each one of the CEO's own — 404 otherwise. */
async function companiesFor(req: FastifyRequest, named: string[] | undefined): Promise<string[]> {
  const su = req.staffUser!
  const ids = named && named.length ? [...new Set(named)] : await defaultCompanies(su.memberTenantIds)
  for (const id of ids) if (!su.memberTenantIds.includes(id)) throw new NotFoundError('Company', id)
  // The setup marker is read platform-wide (headOfficeSetupApplied), so a
  // practice run must never set it: test companies are refused outright.
  if (ids.length) {
    const tests = await serviceClient.tenant.findMany({ where: { id: { in: ids }, isTest: true }, select: { id: true } })
    if (tests.length) {
      throw new AppError('TEST_COMPANY_NOT_ALLOWED', 'The head-office setup runs on trading companies only', 422, { companyIds: tests.map((t) => t.id) })
    }
  }
  // Membership of every company is proven above: the planning reads
  // (budgetedLabour, on the request's client) may see all of them under the
  // company lock (RLS), not only the company in view.
  appendRlsTenantIds(ids)
  return ids
}

async function alreadyApplied(db: Prisma.TransactionClient | typeof serviceClient) {
  return db.headOfficeBooks.findFirst({
    where: { setupAppliedAt: { not: null }, tenant: { isTest: false } },
    select: { tenantId: true, setupAppliedAt: true, tenant: { select: { name: true } } },
  })
}

const zSplitLine = z.object({ companyTenantId: z.string().min(1), shareBps: z.number().int().min(1).max(10_000) })
const zApply = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  companyIds: z.array(z.string().min(1)).max(50).optional(),
  split: z.array(zSplitLine).min(1).max(50).optional(),
  effectiveFrom: z.string().regex(MONTH).optional(),
  addHodMemberships: z.array(z.string().min(1)).max(200).optional(),
})

export interface SetupResult {
  headOffice: { id: string; name: string; slug: string; isTest: boolean }
  links: Array<{ companyTenantId: string; companyName: string; chargesAccountCode: string }>
  split: { id: string; effectiveFrom: string; lines: Array<{ companyTenantId: string; shareBps: number }> }
  people: Awaited<ReturnType<typeof applyHeadOfficePeople>>
  hodMembershipsAdded: string[]
  planning: HeadOfficePeoplePlan['planning']
}

export async function headOfficeSetupRoutes(fastify: FastifyInstance) {
  const ceo = { preHandler: requireAuth(...ADMIN_ONLY) }

  // ── Preview ──────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { companyIds?: string; name?: string } }>('/setup/preview', ceo, async (req) => {
    const named = req.query.companyIds ? req.query.companyIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined
    const companyIds = await companiesFor(req, named)
    const name = req.query.name?.trim() || DEFAULT_HEAD_OFFICE_NAME
    const done = await alreadyApplied(serviceClient)
    const plan = await planHeadOfficePeople(serviceClient, { hoName: name, companyIds })
    return {
      alreadyApplied: done ? { headOfficeId: done.tenantId, name: done.tenant.name, at: done.setupAppliedAt } : null,
      effectiveFrom: planMonth(),
      rechargeStaysOff: true,
      ...plan,
    }
  })

  // ── Apply ────────────────────────────────────────────────────────────────
  fastify.post('/setup', ceo, async (req, reply) => {
    const body = zApply.parse(req.body ?? {})
    const su = req.staffUser!
    if (await alreadyApplied(serviceClient)) throw new AppError('SETUP_ALREADY_DONE', 'The head office has already been set up from today\'s records', 409)
    const companyIds = await companiesFor(req, body.companyIds)
    if (companyIds.length === 0) {
      throw new AppError('NO_COMPANIES', 'There are no head-office records to set up — name the companies the head office serves', 422)
    }
    const name = body.name ?? DEFAULT_HEAD_OFFICE_NAME
    // Spec §14.3: split v1 starts THIS Karachi month. A later month would set
    // the marker (head_office contributions stop counting, seats leave the
    // companies) while no split covers today → planning would drop until then.
    const effectiveFrom = planMonth()
    if (body.effectiveFrom !== undefined && body.effectiveFrom !== effectiveFrom) {
      throw new AppError('EFFECTIVE_FROM_NOT_CURRENT_MONTH', `Split v1 starts this month (${effectiveFrom})`, 422, { effectiveFrom })
    }
    // The preview the CEO saw (with the split chosen) — its planning is returned and kept.
    const plan = await planHeadOfficePeople(serviceClient, { hoName: name, companyIds, split: body.split })
    const split = plan.split
    if (split.length === 0) throw new AppError('SPLIT_REQUIRED', 'Give each company its share of the head office', 422)
    for (const l of split) {
      if (!companyIds.includes(l.companyTenantId)) {
        throw new AppError('COMPANY_NOT_LINKED', 'Every company in the % table must be one of the companies being set up', 422)
      }
    }
    const hods = [...new Set(body.addHodMemberships ?? [])].filter((u) => u !== su.id)

    const result = await serviceClient.$transaction(async (tx): Promise<SetupResult> => {
      // One setup at a time; the marker is the guard (a second run → 409).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'ho.setup'}::text))`
      if (await alreadyApplied(tx)) throw new AppError('SETUP_ALREADY_DONE', 'The head office has already been set up from today\'s records', 409)

      const ho = await createHeadOffice(tx, { name, actorId: su.id })
      const links: SetupResult['links'] = []
      for (const companyId of companyIds) {
        const l = await linkCompany(tx, { hoId: ho.id, companyId, actorId: su.id })
        links.push({ companyTenantId: companyId, companyName: l.companyName, chargesAccountCode: l.chargesAccount.code })
      }
      const { split: v1 } = await createSplitVersion(tx, {
        hoId: ho.id, effectiveFrom, lines: split, actorId: su.id,
        note: "Split v1 — set up from today's records",
      })
      const people = await applyHeadOfficePeople(tx, { hoId: ho.id, companyIds })

      // A3: HOD logins become head-office members now (TenantMember only).
      const hodMembershipsAdded: string[] = []
      if (hods.length) {
        const ok = await tx.user.findMany({
          where: {
            id: { in: hods }, deletedAt: null,
            OR: [{ tenantId: { in: companyIds } }, { tenantMemberships: { some: { tenantId: { in: companyIds } } } }],
          },
          select: { id: true },
        })
        const okIds = new Set(ok.map((u) => u.id))
        const bad = hods.filter((u) => !okIds.has(u))
        if (bad.length) throw new AppError('HOD_NOT_IN_COMPANIES', 'Only logins of the companies being set up can join the head office', 422, { userIds: bad })
        for (const userId of hods) {
          await tx.tenantMember.upsert({
            where: { userId_tenantId: { userId, tenantId: ho.id } },
            create: { userId, tenantId: ho.id, role: 'member' },
            update: {},
          })
          hodMembershipsAdded.push(userId)
        }
      }

      const out: SetupResult = {
        headOffice: { id: ho.id, name: ho.name, slug: ho.slug, isTest: ho.isTest },
        links,
        split: { id: v1.id, effectiveFrom: v1.effectiveFrom, lines: v1.lines },
        people,
        hodMembershipsAdded,
        planning: plan.planning,
      }
      await tx.headOfficeBooks.update({
        where: { tenantId: ho.id },
        data: {
          setupAppliedAt: new Date(),
          setupAppliedById: su.id,
          setupSummary: JSON.parse(JSON.stringify(out)) as Prisma.InputJsonValue,
          updatedById: su.id,
        },
      })
      return out
    }, TX_OPTS)

    const hoId = result.headOffice.id
    appendRlsTenantIds([hoId]) // the CEO just created it (company lock, RLS)
    for (const tenantId of [hoId, ...companyIds]) {
      await audit({
        category: 'accounting', action: 'ho.setup.apply', entity: 'Tenant', entityId: hoId,
        userId: su.id, userEmail: su.email, tenantId,
        before: { planning: result.planning.before },
        after: {
          headOffice: result.headOffice, links: result.links, split: result.split,
          seatsMoved: result.people.seatsMoved.length, seatsNormalised: result.people.seatsNormalised.length,
          contributionsEnded: result.people.contributionsEnded.map((c) => c.id), hodMembershipsAdded: result.hodMembershipsAdded,
          planning: result.planning.after,
        },
        metadata: { ip: req.ip },
      })
    }
    return reply.status(201).send(result)
  })
}
