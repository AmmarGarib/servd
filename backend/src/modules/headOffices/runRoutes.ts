// Head office (D1) — recharge runs API. The orchestrator mounts
// `rechargeRunRoutes` at /accounting/intercompany/recharge-runs (under the
// existing '/accounting' module gate — module 'accounting'; no new module).
//
//   GET  /preview?headOfficeId&period        the run as it would be now (nothing saved)
//   GET  /?headOfficeId&period&status        runs the caller may see → { runs }
//   POST /  {headOfficeId, period}           prepare (IC_PREPARERS who belong to the head office)
//   GET  /statement?headOfficeId&companyId&from&to   one pair's statement (YYYY-MM-DD)
//   GET  /close-status?tenantId&through      would the head-office close checks block a close through `through`?
//   GET  /summary?headOfficeId               per company: pair balances, share, last runs, readiness
//   GET  /:id
//   POST /:id/refresh | /:id/submit | /:id/withdraw     head-office preparers
//   POST /:id/approve {postInOpenPeriod?, acknowledgeWarnings?, note?}   the CEO or a head-office-wide
//                                            Finance delegate (lib/approvalRights.ts assertCanApprove)
//   POST /:id/reject {note}                  the same rights
//   POST /:id/reverse {reason ≥ 10}          the CEO, a member of the head office and every company on the run
//
// Company separation (A5): every read runs on serviceClient with an explicit
// filter — a member of the head office (or the holder of its recharge
// hand-over) sees its runs whole; a member of a served company sees the runs
// that charge it, with its own lines only. Anything else is 404. Audits go to
// the head office's trail AND each company's on the run (A19: never the
// caller's active company).

import { exportFormatOf, sendReport, type ReportRow } from '../../lib/reportExport.js'
import { fmtPkr } from '../accounting/csv.js'
import { approvalWaiting } from '../approvals/notify.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Prisma, UserRole } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { toCents } from '../../lib/money.js'
import { auditApproval, delegatedTenantsByType } from '../../lib/approvalRights.js'
import { parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import { addMonths, isMonthEnded, monthOf } from '../intercompany/fleet.js'
import { pairBalances } from '../intercompany/accounts.js'
import {
  IC_PREPARERS, RUN_INCLUDE, RUN_STATUSES, approveRun, assertHoPreparer, computeRun, headOfficeOr404, monthReadiness,
  prepareRun, presentRuns, refreshRun, rejectRun, reverseRun, submitRun, withdrawRun,
  type RunActor, type RunRow, type RunView,
} from './runs.js'
import { endedMonthsThrough, headOfficeChargeProblems, headOfficeRechargeProblems } from './closeChecks.js'
import { headOfficeStatement, maySeePair, runInvariants } from './reconciliation.js'
import { splitForOrNull } from './splits.js'
import { monthsInRange } from '../accounting/closeChecks.js'

const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const PREPARERS = [...IC_PREPARERS] as UserRole[]

function actorOf(req: FastifyRequest): RunActor {
  const su = req.staffUser!
  return { id: su.id, role: su.role, memberTenantIds: su.memberTenantIds ?? [] }
}

/** Head offices the viewer sees whole: those it belongs to, plus those whose recharges it holds by hand-over. */
async function fullHeadOffices(req: FastifyRequest): Promise<Set<string>> {
  const su = req.staffUser!
  const out = new Set<string>(su.memberTenantIds ?? [])
  const delegated = (await delegatedTenantsByType(su.id)).get('ho_recharge')
  for (const t of delegated ?? []) out.add(t)
  return out
}

/** The filter of runs the viewer may see (A5: explicit, on serviceClient). */
async function visibleRunsWhere(req: FastifyRequest): Promise<{ where: Prisma.RechargeRunWhereInput; full: Set<string> }> {
  const full = await fullHeadOffices(req)
  const members = req.staffUser!.memberTenantIds ?? []
  return {
    full,
    where: {
      OR: [
        { tenantId: { in: [...full] } },
        ...(members.length ? [{ lines: { some: { companyTenantId: { in: members } } } }] : []),
      ],
    },
  }
}

async function runInView(req: FastifyRequest, id: string): Promise<{ run: RunRow; full: Set<string> }> {
  const { where, full } = await visibleRunsWhere(req)
  const run = await serviceClient.rechargeRun.findFirst({ where: { AND: [{ id }, where] }, include: RUN_INCLUDE })
  if (!run) throw new NotFoundError('Recharge run', id)
  return { run, full }
}

async function view(req: FastifyRequest, run: RunRow, full?: Set<string>): Promise<RunView> {
  const f = full ?? (await fullHeadOffices(req))
  return (await presentRuns([run], { memberTenantIds: req.staffUser!.memberTenantIds ?? [], fullHeadOffices: f }))[0]!
}

/** One audit row in the head office's trail and in each company on the run (A19). */
async function auditRun(req: FastifyRequest, run: RunRow, action: string, metadata?: Record<string, unknown>): Promise<void> {
  const su = req.staffUser!
  const tenants = [...new Set([run.tenantId, ...run.lines.map((l) => l.companyTenantId)])]
  for (const tenantId of tenants) {
    await audit({
      category: 'accounting', action, entity: 'RechargeRun', entityId: run.id, userId: su.id, userEmail: su.email, tenantId,
      after: { period: run.period, kind: run.kind, status: run.status, baseCents: toCents(run.baseCents), rechargedCents: toCents(run.rechargedCents) },
      ...(metadata && { metadata }),
    })
  }
}

function monthParam(v: unknown, field: string): string {
  if (typeof v !== 'string' || !ISO_MONTH.test(v)) throw new AppError('INVALID_MONTH', `Give ${field} as YYYY-MM`, 422)
  return v
}

function dateParam(v: unknown, field: string): string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) throw new AppError('INVALID_DATE', `Give ${field} as YYYY-MM-DD`, 422)
  return v
}

const createSchema = z.object({ headOfficeId: z.string().min(1), period: z.string().regex(ISO_MONTH, 'YYYY-MM') })
const approveSchema = z.object({
  postInOpenPeriod: z.boolean().optional(),
  acknowledgeWarnings: z.boolean().optional(),
  note: z.string().trim().max(500).nullable().optional(),
})
const noteSchema = z.object({ note: z.string().trim().min(3, 'Say why').max(500) })
const withdrawSchema = z.object({ note: z.string().trim().max(500).nullable().optional() })
const reverseSchema = z.object({ reason: z.string().trim().min(10, 'Give the reason (at least 10 characters)').max(500) })

export async function rechargeRunRoutes(fastify: FastifyInstance) {
  // ─── Preview ───────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { headOfficeId?: string; period?: string } }>('/preview', { preHandler: requireAuth(...PREPARERS) }, async (req) => {
    const hoId = req.query.headOfficeId ?? ''
    const period = monthParam(req.query.period, 'period')
    await headOfficeOr404(serviceClient, hoId)
    assertHoPreparer(actorOf(req), hoId)
    const c = await computeRun(serviceClient, hoId, period)
    const names = new Map((await serviceClient.tenant.findMany({ where: { id: { in: c.lines.map((l) => l.companyTenantId) } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]))
    return {
      headOfficeId: hoId, period, monthEnded: isMonthEnded(period), kind: c.kind, splitId: c.splitId, splitTotalBps: c.splitTotalBps,
      basis: c.pool.basis, costPool: c.pool.costPool, poolCents: c.pool.poolCents, priorCents: c.priorCents, baseCents: c.baseCents,
      rechargedCents: c.rechargedCents, retainedCents: c.retainedCents, warnings: c.warnings,
      lines: c.lines.map((l) => ({ ...l, companyName: names.get(l.companyTenantId) ?? null })),
    }
  })

  // ─── List ──────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { headOfficeId?: string; period?: string; status?: string; limit?: string } }>('/', { preHandler: requireAuth() }, async (req) => {
    const q = z.object({
      headOfficeId: z.string().min(1).optional(),
      period: z.string().regex(ISO_MONTH).optional(),
      status: z.enum(RUN_STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query)
    const { where, full } = await visibleRunsWhere(req)
    const rows = await serviceClient.rechargeRun.findMany({
      where: {
        AND: [
          where,
          ...(q.headOfficeId ? [{ tenantId: q.headOfficeId }] : []),
          ...(q.period ? [{ period: q.period }] : []),
          ...(q.status ? [{ status: q.status }] : []),
        ],
      },
      include: RUN_INCLUDE,
      orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
      take: q.limit,
    })
    return { runs: await presentRuns(rows, { memberTenantIds: req.staffUser!.memberTenantIds ?? [], fullHeadOffices: full }) }
  })

  // ─── Prepare ───────────────────────────────────────────────────────────────
  fastify.post('/', { preHandler: requireAuth(...PREPARERS) }, async (req, reply) => {
    const body = createSchema.parse(req.body ?? {})
    const run = await prepareRun(actorOf(req), body.headOfficeId, body.period)
    await auditRun(req, run, 'ho.recharge.prepare')
    return reply.status(201).send(await view(req, run))
  })

  // ─── Statement, close status, summary ──────────────────────────────────────
  // ?format=csv|xlsx|pdf exports the pair's statement (lib/reportExport.ts); same viewers, same pair check.
  fastify.get<{ Querystring: { headOfficeId?: string; companyId?: string; from?: string; to?: string; format?: string } }>('/statement', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req, reply) => {
    const hoId = req.query.headOfficeId ?? ''
    const companyId = req.query.companyId ?? ''
    if (!(await maySeePair(actorOf(req), hoId, companyId))) throw new NotFoundError('Head office pair', `${hoId}:${companyId}`)
    const current = monthOf(new Date())
    const from = req.query.from ? dateParam(req.query.from, 'from') : `${addMonths(current, -2)}-01`
    const to = req.query.to ? dateParam(req.query.to, 'to') : new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10)
    if (from > to) throw new AppError('INVALID_RANGE', 'from is after to', 422)
    const st = await headOfficeStatement(serviceClient, hoId, companyId, parsePktStartOfDay(from), parsePktEndOfDay(to))
    const format = exportFormatOf(req.query.format)
    if (!format) return st
    const names = await serviceClient.tenant.findMany({ where: { id: { in: [hoId, companyId] } }, select: { id: true, name: true } })
    const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? ''
    let bal = st.openingCents
    const rows: ReportRow[] = [{ date: from, category: '', description: 'OPENING BALANCE', reference: '', amountCents: null, balanceCents: bal }]
    for (const r of st.rows) {
      bal += r.cents
      rows.push({ date: r.date.slice(0, 10), category: r.category, description: `${r.description}${r.reversal ? ' (reversal)' : ''}`, reference: r.reference ?? '', amountCents: r.cents, balanceCents: bal })
    }
    rows.push({ date: to, category: '', description: 'CLOSING BALANCE', reference: '', amountCents: null, balanceCents: st.closingCents })
    return sendReport(reply, format, { base: 'head-office-statement', suffix: `${from}-${to}` }, {
      title: `Head office statement — ${nameOf(companyId)}`, companies: [nameOf(hoId)].filter(Boolean),
      period: `${from} to ${to} · owed by the company to the head office (head office's books)`,
      rows, types: { amountCents: 'cents', balanceCents: 'cents' }, labels: { amountCents: 'Amount' },
      isTotal: (r) => r.description === 'OPENING BALANCE' || r.description === 'CLOSING BALANCE',
      notes: [`By the company's books at ${to}: ${fmtPkr(st.companyClosingCents)} (difference ${fmtPkr(st.differenceCents)}).`],
    })
  })

  fastify.get<{ Querystring: { tenantId?: string; through?: string } }>('/close-status', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const tenantId = req.query.tenantId ?? req.staffUser!.tenantId ?? ''
    if (!(req.staffUser!.memberTenantIds ?? []).includes(tenantId)) throw new NotFoundError('Company', tenantId)
    const through = parsePktEndOfDay(dateParam(req.query.through, 'through'))
    const lock = await serviceClient.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
    const first = await serviceClient.journalEntry.findFirst({ where: { tenantId }, orderBy: { entryDate: 'asc' }, select: { entryDate: true } })
    const months = endedMonthsThrough(monthsInRange(lock?.lockedThrough ?? null, through, first?.entryDate ?? null), through)
    const [recharge, charges] = await Promise.all([
      headOfficeRechargeProblems(serviceClient, tenantId, months),
      headOfficeChargeProblems(serviceClient, tenantId, months),
    ])
    return { tenantId, through: through.toISOString(), months, ready: recharge.length === 0 && charges.length === 0, headOffice: recharge, charges }
  })

  fastify.get<{ Querystring: { headOfficeId?: string } }>('/summary', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const hoId = req.query.headOfficeId ?? ''
    const ho = await headOfficeOr404(serviceClient, hoId)
    if (!(req.staffUser!.memberTenantIds ?? []).includes(hoId)) throw new NotFoundError('Head office', hoId)
    const books = await serviceClient.headOfficeBooks.findUnique({
      where: { tenantId: hoId },
      select: { rechargeEnabled: true, rechargeFromPeriod: true, requireLockedPayroll: true, accountsConfirmedAt: true },
    })
    const current = monthOf(new Date())
    const lastMonth = addMonths(current, -1)
    const split = await splitForOrNull(serviceClient, hoId, current)
    const links = await serviceClient.headOfficeLink.findMany({
      where: { tenantId: hoId },
      orderBy: { startedAt: 'asc' },
      select: { id: true, companyTenantId: true, startedAt: true, endedAt: true, lastChargedPeriod: true, company: { select: { name: true } } },
    })
    const companies = []
    for (const l of links) {
      const b = await pairBalances(serviceClient, hoId, l.companyTenantId)
      companies.push({
        linkId: l.id, companyTenantId: l.companyTenantId, companyName: l.company.name,
        startedAt: l.startedAt.toISOString(), endedAt: l.endedAt?.toISOString() ?? null, lastChargedPeriod: l.lastChargedPeriod,
        shareBps: split?.lines.find((x) => x.companyTenantId === l.companyTenantId)?.shareBps ?? 0,
        owedByCompanyCents: b.aDueFromB - b.aDueToB, mismatchCents: b.mismatchCents,
      })
    }
    const recent = await serviceClient.rechargeRun.findMany({ where: { tenantId: hoId }, include: RUN_INCLUDE, orderBy: [{ period: 'desc' }, { createdAt: 'desc' }], take: 12 })
    const lastMonthReadiness = books?.rechargeFromPeriod && lastMonth >= books.rechargeFromPeriod ? await monthReadiness(serviceClient, hoId, lastMonth) : null
    return {
      headOffice: { id: ho.id, name: ho.name, isActive: ho.isActive },
      books: books && { ...books, accountsConfirmedAt: books.accountsConfirmedAt?.toISOString() ?? null },
      split, companies, lastMonth, lastMonthReadiness,
      runs: await presentRuns(recent, { memberTenantIds: req.staffUser!.memberTenantIds ?? [], fullHeadOffices: new Set([hoId]) }),
    }
  })

  // ─── One run ───────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth() }, async (req) => {
    const { run, full } = await runInView(req, req.params.id)
    const v = await view(req, run, full)
    return full.has(run.tenantId) ? { ...v, invariants: await runInvariants(run.id) } : v
  })

  fastify.post<{ Params: { id: string } }>('/:id/refresh', { preHandler: requireAuth(...PREPARERS) }, async (req) => {
    const run = await refreshRun(actorOf(req), req.params.id)
    await auditRun(req, run, 'ho.recharge.refresh')
    return view(req, run)
  })

  fastify.post<{ Params: { id: string } }>('/:id/submit', { preHandler: requireAuth(...PREPARERS) }, async (req) => {
    const run = await submitRun(actorOf(req), req.params.id)
    await auditRun(req, run, 'ho.recharge.submit')
    // The bell (queued, after the commit): the approver has a recharge run to decide.
    approvalWaiting('ho_recharge', run.id, { round: `submit:${(run.submittedAt ?? new Date()).toISOString()}`, actorId: req.staffUser!.id })
    return view(req, run)
  })

  fastify.post<{ Params: { id: string } }>('/:id/withdraw', { preHandler: requireAuth(...PREPARERS) }, async (req) => {
    const body = withdrawSchema.parse(req.body ?? {})
    const run = await withdrawRun(actorOf(req), req.params.id, body.note ?? null)
    await auditRun(req, run, 'ho.recharge.withdraw', { note: body.note ?? null })
    return view(req, run)
  })

  fastify.post<{ Params: { id: string } }>('/:id/approve', { preHandler: requireAuth() }, async (req) => {
    const body = approveSchema.parse(req.body ?? {})
    const r = await approveRun(req, req.params.id, body)
    await auditRun(req, r.run, 'ho.recharge.approve', {
      via: r.grant.via, ...(r.grant.via === 'delegation' && { delegationId: r.grant.delegationId }),
      postInOpenPeriod: !!body.postInOpenPeriod, driftCents: r.driftCents, lockedBooks: r.lockedBooks,
    })
    await auditApproval(req, { type: 'ho_recharge', id: r.run.id, tenantId: r.run.tenantId, decision: 'approve', grant: r.grant, entity: 'RechargeRun' })
    const v = await view(req, r.run)
    return {
      ...v,
      driftCents: r.driftCents,
      ...(r.driftCents !== 0 && { notice: `The head office's cost for ${r.run.period} moved by ${(r.driftCents / 100).toFixed(2)} PKR since this run was prepared — a true-up will follow` }),
    }
  })

  fastify.post<{ Params: { id: string } }>('/:id/reject', { preHandler: requireAuth() }, async (req) => {
    const body = noteSchema.parse(req.body ?? {})
    const r = await rejectRun(req, req.params.id, body.note)
    await auditRun(req, r.run, 'ho.recharge.reject', { via: r.grant.via, note: body.note })
    await auditApproval(req, { type: 'ho_recharge', id: r.run.id, tenantId: r.run.tenantId, decision: 'reject', grant: r.grant, entity: 'RechargeRun', metadata: { note: body.note } })
    return view(req, r.run)
  })

  fastify.post<{ Params: { id: string } }>('/:id/reverse', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = reverseSchema.parse(req.body ?? {})
    const members = req.staffUser!.memberTenantIds ?? []
    const run = await serviceClient.rechargeRun.findUnique({ where: { id: req.params.id }, include: RUN_INCLUDE })
    if (!run || !members.includes(run.tenantId)) throw new NotFoundError('Recharge run', req.params.id)
    if (run.lines.some((l) => !members.includes(l.companyTenantId))) {
      throw new ForbiddenError('Reversing posts in every company on the run — you must belong to each of them')
    }
    const r = await reverseRun(actorOf(req), run.id, body.reason)
    await auditRun(req, r.run, 'ho.recharge.reverse', { reason: body.reason, withdrawnRunIds: r.withdrawnRunIds })
    for (const wid of r.withdrawnRunIds) {
      const w = await serviceClient.rechargeRun.findUnique({ where: { id: wid }, include: RUN_INCLUDE })
      if (w) await auditRun(req, w, 'ho.recharge.withdraw', { reason: 'superseded by reversal', reversedRunId: run.id })
    }
    return { ...(await view(req, r.run)), withdrawnRunIds: r.withdrawnRunIds }
  })
}
