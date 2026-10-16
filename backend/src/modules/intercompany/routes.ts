// Accounting → Inter-company (H30). index.ts registers this plugin at
// /accounting/intercompany — under the existing '/accounting' module gate
// (module 'accounting'; no widening: the CEO holds every module and the
// approvals inbox reads the transfers list as the CEO).
//
//   GET  /companies                       the caller's companies + what they may do here
//   GET  /balances?asOf=YYYY-MM-DD        pair balances (both sides only for a member of both)
//   GET  /transfers?status=&limit=        transfers touching the read scope
//   GET  /transfers/:id
//   POST /transfers                       finance / CEO prepare (CEO: postNow). A
//                                         settlement: method bank_transfer | bank_deposit |
//                                         cheque | cash (old 'bank' = bank_transfer) and
//                                         bankReference — the payment reference #,
//                                         required for every method (422
//                                         PAYMENT_REFERENCE_REQUIRED). 201 → the transfer
//                                         + referenceUsedBefore (a warning only).
//   POST /transfers/:id/approve|reject    lib/approvalRights.ts assertCanApprove:
//                                         the CEO of both companies; on a head-office
//                                         pair also a Finance delegate covering the
//                                         company (never the preparer)
//   POST /transfers/:id/reverse           CEO, member of both companies
//   GET  /fleet?from=YYYY-MM&to=YYYY-MM   shared-fleet agreements, rates, trips, charges
//   PUT  /fleet/:agreementId/rate         CEO, member of both (new history row)
//   POST /fleet/charge {month?, agreementId?}    CEO "Charge now" (also the close checklist's fix)
//   GET  /tie-out?asOf=YYYY-MM-DD         2050 / 2060 / 2080 vs subledgers + pre-split residue
//   POST /legacy-writeoff                 CEO, once per company and code (dry run first)
//
// Company separation: lists read through resolveTenantScope (a transfer shows
// to either party's members); an existing row the caller cannot see is 404;
// anything that speaks for both companies needs membership of both
// (lib/companyPairs.ts — 403 NOT_IN_BOTH_COMPANIES), and a NEW transfer or
// rate also needs the active company to be one of the two (422
// ACTIVE_COMPANY_NOT_A_PARTY). Audits are written in BOTH companies.
//
// Head-office pairs (D1; the owner chose to reuse this engine): a member of a
// head office, acting as it, prepares settlements and adjustments with a
// company it serves through a LIVE link (lib/companyPairs.ts
// assertPairPreparer), and sees that pair's transfers and balances — read on
// serviceClient, scoped explicitly to (their head office, the served company);
// through the head-office lens they see NOTHING else of the served company's
// inter-company rows. Approve / reject go through lib/approvalRights.ts
// (approvalSubject → assertCanApprove, ceoOnly unless it is a head-office
// pair). With no head office linked every path is exactly as before.

import { approvalWaiting } from '../approvals/notify.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Prisma, UserRole } from '@prisma/client'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { resolveTenantScope, activeTenantId } from '../../lib/tenantScope.js'
import { assertBothSidesOwned, assertPairPreparer, isMemberOfBoth } from '../../lib/companyPairs.js'
import { reachMapOf } from '../../lib/headOffice.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval, canApprove, type ApprovalGrant } from '../../lib/approvalRights.js'
import { audit } from '../../lib/audit.js'
import { zInt4Cents, zMoneyCents } from '../../lib/money.js'
import { zPaymentRef } from '../../lib/bankAccounts.js'
import { findPaymentReferenceUses, type PaymentRefUse } from '../../lib/paymentRefs.js'
import { parsePktEndOfDay } from '../accounting/dates.js'
import { counterpartiesOf, pairBalances, pairKey, sideBalances } from './accounts.js'
import {
  TRANSFER_KINDS, SETTLEMENT_METHODS, approveTransfer, createTransfer, presentTransfers, rejectTransfer, reverseTransfer,
  type TransferActor, type TransferRow,
} from './service.js'
import {
  addMonths, assertMonth, chargeFleetMonth, fleetMonths, isMonthEnded, monthOf, monthsBetween, ratesOf, setFleetRate,
  type FleetChargeResult,
} from './fleet.js'
import { LEGACY_CODES, controlTieOut, legacyDifference, writeOffLegacy, type LegacyCode } from './legacy.js'

/** Who prepares a transfer: finance and the CEO. Only the CEO approves, posts at once, reverses, sets rates. */
export const TRANSFER_PREPARERS = ['admin', 'finance'] as UserRole[]
const STATUSES = ['submitted', 'posted', 'rejected', 'reversed'] as const
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
/** How far back "Charge now" without a month looks for uncharged months. */
const CHARGE_NOW_MAX_MONTHS = 24

/** The CEO (ADMIN_ONLY) — approves, posts at once, reverses, sets rates, charges, writes off. */
const isCeo = (role: string) => (ADMIN_ONLY as string[]).includes(role)

function actorOf(req: FastifyRequest): TransferActor {
  const su = req.staffUser!
  return { id: su.id, role: su.role, tenantId: su.tenantId, memberTenantIds: su.memberTenantIds }
}

function asOfParam(v: string | undefined): Date | undefined {
  if (!v) return undefined
  if (!ISO_DATE.test(v)) throw new AppError('INVALID_DATE', 'Give asOf as YYYY-MM-DD', 422)
  return parsePktEndOfDay(v)
}

async function companyNames(ids: string[]): Promise<Map<string, string>> {
  const rows = ids.length ? await serviceClient.tenant.findMany({ where: { id: { in: Array.from(new Set(ids)) } }, select: { id: true, name: true } }) : []
  return new Map(rows.map((t) => [t.id, t.name]))
}

/** One audit row in EACH company of the pair (the document belongs to both). */
async function auditBoth(req: FastifyRequest, tenantIds: string[], action: string, entity: string, entityId: string, after: unknown, metadata?: unknown): Promise<void> {
  const su = req.staffUser!
  for (const tenantId of Array.from(new Set(tenantIds))) {
    await audit({ category: 'accounting', action, entity, entityId, userId: su.id, userEmail: su.email, tenantId, after, ...(metadata !== undefined && { metadata }) })
  }
}

/**
 * Where else a company of the settlement that the caller belongs to already
 * recorded its payment reference # (a member of both sees both; a head-office
 * preparer only their head office's), this transfer left out. A warning only.
 */
async function referenceUsesOfPair(t: TransferRow, memberIds: readonly string[]): Promise<PaymentRefUse[]> {
  if (t.kind !== 'settlement' || !t.bankReference) return []
  const exclude = { kind: 'intercompany_transfer' as const, id: t.id }
  const sides = [t.tenantId, t.counterpartyTenantId].filter((id) => memberIds.includes(id))
  const found = await Promise.all(sides.map((id) => findPaymentReferenceUses(serviceClient, id, t.bankReference!, { exclude })))
  const seen = new Set<string>()
  return found.flat()
    .filter((u) => (seen.has(`${u.kind}:${u.id}`) ? false : (seen.add(`${u.kind}:${u.id}`), true)))
    .sort((x, y) => y.at.localeCompare(x.at))
    .slice(0, 5)
}

/** A transfer the caller's companies are a party to (write scope), else 404. */
async function transferInWriteScope(req: FastifyRequest, id: string): Promise<TransferRow> {
  const members = req.staffUser!.memberTenantIds
  const t = await prisma.intercompanyTransfer.findFirst({
    where: { id, OR: [{ tenantId: { in: members } }, { counterpartyTenantId: { in: members } }] },
  })
  if (!t) throw new NotFoundError('Transfer', id)
  return t
}

// ─── Head-office pairs (D1) ──────────────────────────────────────────────────

/**
 * True when (a, b) is a head-office pair the caller sees through a head office
 * they belong to: one side is such a head office and the other a company it
 * serves through a LIVE link (the auth middleware's reach map — never cached).
 */
function isOwnHeadOfficePair(req: FastifyRequest, a: string, b: string): boolean {
  const reach = reachMapOf(req)
  return !!(reach.get(a)?.includes(b) || reach.get(b)?.includes(a))
}

/**
 * The transfers the caller sees in `scopeIds` (resolveTenantScope), as two
 * explicit filters:
 *   member  either side is an in-scope company the caller belongs to (as
 *           before; read through `prisma`);
 *   ho      for an in-scope company the caller only REACHES (the head-office
 *           lens), just its pairs with the caller's own head offices (read on
 *           serviceClient — nothing else of that company's rows).
 */
function transferFilters(req: FastifyRequest, scopeIds: readonly string[]): { member: Prisma.IntercompanyTransferWhereInput | null; ho: Prisma.IntercompanyTransferWhereInput | null } {
  const members = new Set(req.staffUser!.memberTenantIds)
  const memberScope = scopeIds.filter((t) => members.has(t))
  const reach = reachMapOf(req)
  const hoPairs: Prisma.IntercompanyTransferWhereInput[] = []
  for (const c of scopeIds) {
    if (members.has(c)) continue
    for (const ho of reach.get(c) ?? []) {
      if (!members.has(ho)) continue
      hoPairs.push({ tenantId: ho, counterpartyTenantId: c }, { tenantId: c, counterpartyTenantId: ho })
    }
  }
  return {
    member: memberScope.length ? { OR: [{ tenantId: { in: memberScope } }, { counterpartyTenantId: { in: memberScope } }] } : null,
    ho: hoPairs.length ? { OR: hoPairs } : null,
  }
}

/**
 * The views with canApprove decided by lib/approvalRights.ts for every
 * submitted transfer with a head office on one side (the CEO, or a Finance
 * delegate covering the company — never its preparer). Other rows keep
 * presentTransfers' flag (the CEO of both companies), which is what
 * assertCanApprove decides for them.
 */
async function withApprovalFlags<T extends { id: string; tenantId: string; counterpartyTenantId: string; status: string; canApprove: boolean }>(req: FastifyRequest, views: T[]): Promise<T[]> {
  const submitted = views.filter((v) => v.status === 'submitted')
  if (submitted.length === 0) return views
  const ids = Array.from(new Set(submitted.flatMap((v) => [v.tenantId, v.counterpartyTenantId])))
  const hos = new Set((await serviceClient.tenant.findMany({ where: { id: { in: ids }, kind: 'head_office' }, select: { id: true } })).map((t) => t.id))
  if (hos.size === 0) return views
  const out: T[] = []
  for (const v of views) {
    if (v.status !== 'submitted' || (!hos.has(v.tenantId) && !hos.has(v.counterpartyTenantId))) { out.push(v); continue }
    const s = await approvalSubject('intercompany_transfer', v.id)
    const ok = !!s && await canApprove(req, approvalInputOf('intercompany_transfer', v.id, s, { ceoOnly: !s.headOfficePair }))
    out.push({ ...v, canApprove: ok })
  }
  return out
}

/**
 * Approve / reject: resolve the transfer on serviceClient (A5), then
 * assertCanApprove — CEO only unless it is a head-office pair. 404 when the
 * caller cannot see it at all.
 */
async function decisionGrant(req: FastifyRequest, id: string, action: 'approve' | 'reject'): Promise<{ grant: ApprovalGrant; ownerTenantId: string | null }> {
  const s = await approvalSubject('intercompany_transfer', id)
  if (!s) throw new NotFoundError('Transfer', id)
  const grant = await assertCanApprove(req, approvalInputOf('intercompany_transfer', id, s, {
    ceoOnly: !s.headOfficePair, entity: 'IntercompanyTransfer', action: `${action} an inter-company transfer`,
  }))
  return { grant, ownerTenantId: s.ownerTenantId }
}

const grantMeta = (g: ApprovalGrant) => ({ decidedVia: g.via, ...(g.via === 'delegation' ? { delegationId: g.delegationId } : {}) })

const conceptShareSchema = z.object({
  conceptId: z.string().min(1),
  cents: zMoneyCents('A brand share', { sign: 'positive' }),
})

const createSchema = z.object({
  kind: z.enum(TRANSFER_KINDS),
  debtorTenantId: z.string().min(1),
  creditorTenantId: z.string().min(1),
  amountCents: zMoneyCents('The transfer', { sign: 'positive' }),
  entryDate: z.string().regex(ISO_DATE, 'YYYY-MM-DD'),
  memo: z.string().trim().min(3).max(300),
  debtorAccountCode: z.string().trim().min(1).max(20).nullable().optional(),
  creditorAccountCode: z.string().trim().min(1).max(20).nullable().optional(),
  conceptSplit: z.array(conceptShareSchema).max(100).nullable().optional(),
  // The old 'bank' (clients before 2026-10-14) is a bank transfer.
  method: z.preprocess((v) => (v === 'bank' ? 'bank_transfer' : v), z.enum(SETTLEMENT_METHODS).nullable().optional()),
  debtorBankAccountId: z.string().min(1).nullable().optional(),
  creditorBankAccountId: z.string().min(1).nullable().optional(),
  // The payment reference # (required for a settlement — service.ts).
  bankReference: zPaymentRef.nullable().optional(),
  postNow: z.boolean().optional(),
})

const rateSchema = z.object({
  ratePerTripCents: zInt4Cents('The rate per trip'),
  fromPeriod: z.string().regex(ISO_MONTH, 'YYYY-MM'),
  note: z.string().trim().max(300).nullable().optional(),
})

const chargeSchema = z.object({
  month: z.string().regex(ISO_MONTH, 'YYYY-MM').optional(),
  agreementId: z.string().min(1).optional(),
})

const writeOffSchema = z.object({
  code: z.enum(LEGACY_CODES),
  reason: z.string().trim().max(500).optional(),
  dryRun: z.boolean().default(true),
  /** A company the caller belongs to; default the active company. */
  tenantId: z.string().min(1).optional(),
})

export async function intercompanyRoutes(fastify: FastifyInstance) {
  // ─── The caller's companies and capabilities ───────────────────────────────
  fastify.get('/companies', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const su = req.staffUser!
    const rows = await serviceClient.tenant.findMany({
      where: { id: { in: su.memberTenantIds }, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
    // D1: the caller's head offices and the companies each serves through a
    // LIVE link (the pairs they may prepare for, acting as that head office).
    const reach = reachMapOf(req)
    const byHo = new Map<string, string[]>()
    for (const [company, hos] of reach) {
      for (const ho of hos) if (su.memberTenantIds.includes(ho)) byHo.set(ho, [...(byHo.get(ho) ?? []), company])
    }
    const hoNames = byHo.size ? await companyNames([...byHo.keys(), ...[...byHo.values()].flat()]) : new Map<string, string>()
    const headOfficePairs = [...byHo.entries()].map(([ho, companies]) => ({
      headOffice: { id: ho, name: hoNames.get(ho) ?? null },
      companies: companies.map((c) => ({ id: c, name: hoNames.get(c) ?? null })).sort((x, y) => (x.name ?? '').localeCompare(y.name ?? '')),
    }))
    return {
      activeTenantId: su.tenantId,
      companies: rows,
      headOfficePairs,
      can: {
        /** Prepare a transfer (finance, the CEO). */
        prepare: TRANSFER_PREPARERS.includes(su.role),
        /** Approve / reject / reverse, post at once, set fleet rates, Charge now, write off residue — the CEO. */
        decide: isCeo(su.role),
      },
    }
  })

  // ─── Balances ──────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { asOf?: string } }>('/balances', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const asOf = asOfParam(req.query.asOf)
    const scope = await resolveTenantScope(req)
    const viewer = actorOf(req)
    const seen = new Set<string>()
    const pairs: Array<{ a: string; b: string }> = []
    const reach = reachMapOf(req)
    for (const self of scope.tenantIds) {
      // A company seen only through the head-office lens: just its pairs with
      // the caller's own head offices.
      const lensOnly = !viewer.memberTenantIds.includes(self)
      const others = lensOnly
        ? (reach.get(self) ?? []).filter((ho) => viewer.memberTenantIds.includes(ho))
        : await counterpartiesOf(serviceClient, self)
      for (const other of others) {
        const key = pairKey(self, other)
        if (seen.has(key)) continue
        seen.add(key)
        // a = the active company when it is a party, else a side the caller
        // belongs to (a head office through the lens), else the in-scope side.
        const a = other === viewer.tenantId ? other : (lensOnly ? other : self)
        pairs.push({ a, b: a === self ? other : self })
      }
    }
    const names = await companyNames(pairs.flatMap((p) => [p.a, p.b]))
    const out = []
    for (const p of pairs) {
      const both = isMemberOfBoth(viewer, p.a, p.b)
      // headOfficePair = one side is a head office of the caller's with a LIVE
      // link to the other (true for the CEO who belongs to both as well).
      const hoPair = isOwnHeadOfficePair(req, p.a, p.b)
      if (both || hoPair) {
        // A member of both, or a head-office member on their own head office's
        // pair with a company it serves (spec §4.8): both sides.
        const bal = await pairBalances(serviceClient, p.a, p.b, asOf)
        out.push({ a: { id: p.a, name: names.get(p.a) ?? null }, b: { id: p.b, name: names.get(p.b) ?? null }, memberOfBoth: both, headOfficePair: hoPair, ...bal })
      } else {
        // Only the side the caller belongs to; the other company's books stay closed to them.
        const s = await sideBalances(serviceClient, p.a, p.b, asOf)
        out.push({
          a: { id: p.a, name: names.get(p.a) ?? null }, b: { id: p.b, name: names.get(p.b) ?? null }, memberOfBoth: false, headOfficePair: false,
          aDueFromB: s.dueFrom, aDueToB: s.dueTo, bDueFromA: null, bDueToA: null, netOwedByA: s.dueTo - s.dueFrom, mismatchCents: null,
        })
      }
    }
    return { asOf: asOf?.toISOString() ?? null, pairs: out }
  })

  // ─── Transfers ─────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { status?: string; limit?: string } }>('/transfers', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const q = z.object({
      status: z.enum(STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query)
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) return { items: [] }
    const f = transferFilters(req, scope.tenantIds)
    const orderBy = [{ preparedAt: 'desc' as const }, { id: 'desc' as const }]
    const status = q.status ? { status: q.status } : {}
    const [mine, ho] = await Promise.all([
      f.member ? prisma.intercompanyTransfer.findMany({ where: { ...status, ...f.member }, orderBy, take: q.limit }) : [],
      f.ho ? serviceClient.intercompanyTransfer.findMany({ where: { ...status, ...f.ho }, orderBy, take: q.limit }) : [],
    ])
    const byId = new Map<string, TransferRow>()
    for (const r of [...mine, ...ho]) byId.set(r.id, r)
    const rows = [...byId.values()]
      .sort((x, y) => y.preparedAt.getTime() - x.preparedAt.getTime() || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0))
      .slice(0, q.limit)
    return { items: await withApprovalFlags(req, await presentTransfers(rows, actorOf(req))) }
  })

  fastify.get<{ Params: { id: string } }>('/transfers/:id', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const scope = await resolveTenantScope(req)
    const f = transferFilters(req, scope.tenantIds)
    const t = (f.member ? await prisma.intercompanyTransfer.findFirst({ where: { id: req.params.id, ...f.member } }) : null)
      ?? (f.ho ? await serviceClient.intercompanyTransfer.findFirst({ where: { id: req.params.id, ...f.ho } }) : null)
    if (!t) throw new NotFoundError('Transfer', req.params.id)
    return (await withApprovalFlags(req, await presentTransfers([t], actorOf(req))))[0]
  })

  fastify.post('/transfers', { preHandler: requireAuth(...TRANSFER_PREPARERS) }, async (req, reply) => {
    const body = createSchema.parse(req.body)
    // Both companies' member, or (D1) a head-office member acting as the head
    // office for a company it serves through a live link.
    await assertPairPreparer(req, body.debtorTenantId, body.creditorTenantId, { what: 'transfer' })
    if (body.postNow && !isCeo(req.staffUser!.role)) {
      throw new ForbiddenError('Only the CEO can post a transfer at once — submit it for approval instead')
    }
    // Posting at once writes BOTH books: it needs membership of both companies,
    // as before. The head-office preparer path (a served company the caller is
    // not a member of) may only submit for approval.
    if (body.postNow && !isMemberOfBoth(req.staffUser!, body.debtorTenantId, body.creditorTenantId)) {
      throw new AppError('NOT_IN_BOTH_COMPANIES', 'Only someone who belongs to both companies can post a transfer at once — submit it for approval instead', 403)
    }
    const row = await createTransfer(actorOf(req), body, { postNow: body.postNow })
    const [view] = await withApprovalFlags(req, await presentTransfers([row], actorOf(req)))
    await auditBoth(req, [row.tenantId, row.counterpartyTenantId], body.postNow ? 'intercompany.transfer.post' : 'intercompany.transfer.submit', 'IntercompanyTransfer', row.id, view)
    // The bell (queued, after the write): a submitted transfer waits for its approver.
    if (row.status === 'submitted') approvalWaiting('intercompany_transfer', row.id, { round: `submit:${row.preparedAt.toISOString()}`, actorId: req.staffUser!.id })
    return reply.status(201).send({ ...view, referenceUsedBefore: await referenceUsesOfPair(row, req.staffUser!.memberTenantIds) })
  })

  // Any staff role reaches the handler (the '/accounting' module gate still
  // applies); assertCanApprove decides — the CEO of both companies, or on a
  // head-office pair a Finance delegate covering the company.
  fastify.post<{ Params: { id: string } }>('/transfers/:id/approve', { preHandler: requireAuth() }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).nullable().optional() }).parse(req.body ?? {})
    const { grant, ownerTenantId } = await decisionGrant(req, req.params.id, 'approve')
    const row = await approveTransfer(actorOf(req), req.params.id, body.note ?? null, { grant })
    const [view] = await presentTransfers([row], actorOf(req))
    await auditBoth(req, [row.tenantId, row.counterpartyTenantId], 'intercompany.transfer.approve', 'IntercompanyTransfer', row.id, view, grantMeta(grant))
    await auditApproval(req, { type: 'intercompany_transfer', id: row.id, tenantId: ownerTenantId, decision: 'approve', grant, entity: 'IntercompanyTransfer' })
    return view
  })

  fastify.post<{ Params: { id: string } }>('/transfers/:id/reject', { preHandler: requireAuth() }, async (req) => {
    const body = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body ?? {})
    const { grant, ownerTenantId } = await decisionGrant(req, req.params.id, 'reject')
    const row = await rejectTransfer(actorOf(req), req.params.id, body.note, { grant })
    const [view] = await presentTransfers([row], actorOf(req))
    await auditBoth(req, [row.tenantId, row.counterpartyTenantId], 'intercompany.transfer.reject', 'IntercompanyTransfer', row.id, view, grantMeta(grant))
    await auditApproval(req, { type: 'intercompany_transfer', id: row.id, tenantId: ownerTenantId, decision: 'reject', grant, entity: 'IntercompanyTransfer', metadata: { note: body.note } })
    return view
  })

  fastify.post<{ Params: { id: string } }>('/transfers/:id/reverse', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ reason: z.string().trim().min(10).max(500) }).parse(req.body ?? {})
    await transferInWriteScope(req, req.params.id)
    const row = await reverseTransfer(actorOf(req), req.params.id, body.reason)
    const [view] = await presentTransfers([row], actorOf(req))
    await auditBoth(req, [row.tenantId, row.counterpartyTenantId], 'intercompany.transfer.reverse', 'IntercompanyTransfer', row.id, view, { reason: body.reason })
    return view
  })

  // ─── Shared fleet ──────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { from?: string; to?: string } }>('/fleet', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const current = monthOf(new Date())
    const q = z.object({
      from: z.string().regex(ISO_MONTH).optional(),
      to: z.string().regex(ISO_MONTH).optional(),
    }).parse(req.query)
    const to = q.to ?? current
    const from = q.from ?? addMonths(to, -5)
    if (from > to) throw new AppError('INVALID_RANGE', 'from is after to', 422)
    const months = monthsBetween(from, to).slice(-24)
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) return { from, to, agreements: [] }
    const viewer = actorOf(req)
    const agreements = await prisma.fleetAgreement.findMany({
      where: { OR: [{ providerTenantId: { in: scope.tenantIds } }, { clientTenantId: { in: scope.tenantIds } }] },
      orderBy: { createdAt: 'asc' },
    })
    const names = await companyNames(agreements.flatMap((a) => [a.providerTenantId, a.clientTenantId]))
    const out = []
    for (const ag of agreements) {
      const both = isMemberOfBoth(viewer, ag.providerTenantId, ag.clientTenantId)
      const seesClient = viewer.memberTenantIds.includes(ag.clientTenantId)
      const [rates, rows] = await Promise.all([ratesOf(serviceClient, ag.id), fleetMonths(serviceClient, ag, months)])
      const setters = await serviceClient.user.findMany({ where: { id: { in: rates.map((r) => r.setById) } }, select: { id: true, name: true } })
      const conceptIds = seesClient ? Array.from(new Set(rows.flatMap((r) => r.byBrand.map((b) => b.conceptId)))) : []
      const concepts = conceptIds.length ? await serviceClient.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true } }) : []
      out.push({
        id: ag.id,
        isActive: ag.isActive,
        provider: { id: ag.providerTenantId, name: names.get(ag.providerTenantId) ?? null },
        client: { id: ag.clientTenantId, name: names.get(ag.clientTenantId) ?? null },
        memberOfBoth: both,
        canDecide: both && isCeo(viewer.role),
        rates: rates.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), setByName: setters.find((u) => u.id === r.setById)?.name ?? null })),
        months: rows.map((r) => ({
          ...r,
          // A client brand's name only to members of the client company.
          byBrand: seesClient ? r.byBrand.map((b) => ({ ...b, conceptName: concepts.find((c) => c.id === b.conceptId)?.name ?? null })) : [],
        })),
      })
    }
    return { from, to, agreements: out }
  })

  fastify.put<{ Params: { agreementId: string } }>('/fleet/:agreementId/rate', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = rateSchema.parse(req.body)
    const members = req.staffUser!.memberTenantIds
    const ag = await prisma.fleetAgreement.findFirst({
      where: { id: req.params.agreementId, OR: [{ providerTenantId: { in: members } }, { clientTenantId: { in: members } }] },
    })
    if (!ag) throw new NotFoundError('Fleet agreement', req.params.agreementId)
    await assertBothSidesOwned(req, ag.providerTenantId, ag.clientTenantId, { what: 'fleet rate' })
    const rate = await setFleetRate(actorOf(req), ag.id, { ratePerTripCents: body.ratePerTripCents, fromPeriod: body.fromPeriod, note: body.note ?? null })
    const view = { ...rate, createdAt: rate.createdAt.toISOString() }
    await auditBoth(req, [ag.providerTenantId, ag.clientTenantId], 'intercompany.fleet_rate.set', 'FleetRate', rate.id, view, { agreementId: ag.id })
    return view
  })

  fastify.post('/fleet/charge', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = chargeSchema.parse(req.body ?? {})
    const viewer = actorOf(req)
    if (body.month) {
      assertMonth(body.month)
      if (!isMonthEnded(body.month)) throw new AppError('MONTH_NOT_ENDED', 'That month has not ended yet — a month is charged after its last day', 422)
    }
    let agreements: Array<{ id: string; providerTenantId: string; clientTenantId: string }>
    if (body.agreementId) {
      const ag = await prisma.fleetAgreement.findFirst({
        where: { id: body.agreementId, OR: [{ providerTenantId: { in: viewer.memberTenantIds } }, { clientTenantId: { in: viewer.memberTenantIds } }] },
        select: { id: true, providerTenantId: true, clientTenantId: true },
      })
      if (!ag) throw new NotFoundError('Fleet agreement', body.agreementId)
      await assertBothSidesOwned(req, ag.providerTenantId, ag.clientTenantId, { what: 'fleet charge' })
      agreements = [ag]
    } else {
      // Every agreement the CEO may charge: both companies theirs, the active one a party.
      const active = activeTenantId(req, 'a fleet charge is made from one of its two companies')
      const rows = await prisma.fleetAgreement.findMany({
        where: { OR: [{ providerTenantId: active }, { clientTenantId: active }] },
        select: { id: true, providerTenantId: true, clientTenantId: true },
      })
      agreements = rows.filter((a) => isMemberOfBoth(viewer, a.providerTenantId, a.clientTenantId))
    }

    // What to charge: the month asked for, else every ended month still due.
    const lastEnded = addMonths(monthOf(new Date()), -1)
    const targets: Array<{ ag: (typeof agreements)[number]; month: string }> = []
    for (const ag of agreements) {
      if (body.month) { targets.push({ ag, month: body.month }); continue }
      const rates = await ratesOf(serviceClient, ag.id)
      const first = rates.length ? rates[rates.length - 1]!.fromPeriod : null
      if (!first) continue
      const floor = addMonths(lastEnded, -(CHARGE_NOW_MAX_MONTHS - 1))
      const months = monthsBetween(first > floor ? first : floor, lastEnded)
      for (const m of await fleetMonths(serviceClient, ag, months)) if (m.status === 'due') targets.push({ ag, month: m.month })
    }

    const single = !!body.month && !!body.agreementId
    const results: Array<FleetChargeResult & { agreementId: string; month: string; error?: { code: string; message: string } }> = []
    for (const t of targets) {
      try {
        const r = await chargeFleetMonth(t.ag.id, t.month, { postedBy: viewer.id })
        results.push({ agreementId: t.ag.id, month: t.month, ...r })
        if (r.charged && r.transferId) {
          await auditBoth(req, [t.ag.providerTenantId, t.ag.clientTenantId], 'intercompany.fleet.charge', 'IntercompanyTransfer', r.transferId,
            { agreementId: t.ag.id, month: t.month, amountCents: r.amountCents, trips: r.trips })
        }
      } catch (err) {
        if (single) throw err
        const e = err instanceof AppError ? { code: err.code, message: err.message } : { code: 'ERROR', message: (err as Error).message }
        results.push({ agreementId: t.ag.id, month: t.month, charged: false, error: e })
      }
    }
    return { charged: results.filter((r) => r.charged).length, results }
  })

  // ─── Tie-out and the legacy residue ───────────────────────────────────────
  fastify.get<{ Querystring: { asOf?: string } }>('/tie-out', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const asOf = asOfParam(req.query.asOf) ?? new Date()
    const scope = await resolveTenantScope(req)
    const names = await companyNames(scope.tenantIds)
    const viewer = actorOf(req)
    const companies = []
    for (const tenantId of scope.tenantIds) {
      // One after the other: the first read of a company's loyalty settings
      // may write its defaults, and two at once would race.
      const tieOut = await controlTieOut(prisma, tenantId, asOf)
      const legacy = []
      for (const code of LEGACY_CODES) legacy.push(await legacyDifference(prisma, tenantId, code))
      companies.push({
        tenantId, name: names.get(tenantId) ?? null, tieOut, legacy,
        canWriteOff: isCeo(viewer.role) && viewer.memberTenantIds.includes(tenantId),
      })
    }
    return { asOf: asOf.toISOString(), companies }
  })

  fastify.post('/legacy-writeoff', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = writeOffSchema.parse(req.body ?? {})
    const su = req.staffUser!
    const tenantId = body.tenantId ?? activeTenantId(req, 'the write-off is booked in one company')
    if (!su.memberTenantIds.includes(tenantId)) throw new NotFoundError('Company', tenantId)
    const reason = body.reason?.trim() ?? ''
    if (!body.dryRun && reason.length < 10) {
      throw new AppError('REASON_REQUIRED', 'Say why the residue is written off (at least 10 characters)', 422)
    }
    const res = await writeOffLegacy(tenantId, body.code as LegacyCode, reason, su.id, body.dryRun)
    if (!body.dryRun) {
      await audit({
        category: 'accounting', action: 'legacy.cross_company_writeoff', entity: 'JournalEntry', entityId: res.entryId ?? null,
        userId: su.id, userEmail: su.email, tenantId,
        after: { code: res.code, splitAt: res.splitAt, differenceCents: res.differenceCents, lines: res.lines },
        metadata: { reason },
      })
    }
    return res
  })
}
