// One-click merge of two ledger accounts (owner, 2026-11-24: "I want same entries with same narration to be moved to
// other ledger, journal entry will do the bulk amount transfer" → "Move the entries themselves" → "Build one click
// merger").
//
// The ENTRIES move: every journal line of the old account is re-pointed to the account that is kept — same entry, same
// date, narration, voucher number, brand and amount. Nothing is posted, reversed or re-dated. The old account ends
// empty and is switched off. Totals of the books never change; only these two accounts' own figures do.
//
//   POST /accounting/account-merges {fromAccountId, intoAccountId, reason ≥10}
//        the CEO → merged at once (201). Finance holding `accounting` → 202 {pendingApproval, request}, nothing moves;
//        approval type `account_merge` (section ceo, never delegable).
//   GET  /accounting/account-merges/preview?fromAccountId&intoAccountId   what would move + what blocks it
//   GET  /accounting/account-merges?status=                               the merges of the companies in view
//   POST /accounting/account-merges/:id/approve            the CEO — re-checks everything, then merges
//   POST /accounting/account-merges/:id/reject {note ≥10}  the CEO
//   POST /accounting/account-merges/:id/withdraw           the asker or the CEO
//   POST /accounting/account-merges/:id/undo {reason ≥10}  the CEO — the recorded lines go back, the old account is
//                                                          switched on again (409 UNDO_NOT_POSSIBLE when a sub-account
//                                                          was folded into its twin)
//
// RULES (checked at the ask AND inside the merge's transaction, both account rows locked):
//   • both accounts in ONE company (another company's account 404), two different accounts — 422 SAME_ACCOUNT
//   • the same type, and the same place in the P&L — 422 MERGE_TYPE_MISMATCH / MERGE_SECTION_MISMATCH
//   • both OPENED BY HAND: never an account servd posts to (template / module codes, controlled accounts, a brand's
//     sales account, a bank's ledger account, a fixed-asset class account, a head-office mapping) — 422
//     MERGE_NOT_HAND_MADE. Their balances are tied to registers that a merge would break.
//   • the kept account is switched on — 422 MERGE_INTO_INACTIVE
//   • no entry of the old account is dated in CLOSED books — 409 ENTRIES_IN_CLOSED_BOOKS (reopen from that date first)
//   • one waiting merge per account — 409 MERGE_PENDING
// Sub-accounts of the old account move with it (one of the same name / employee on the kept account takes its tags).
// Links from other companies' accounts to the old code follow to the kept code.
// Audit `account.merge(.request|.approve|.reject|.withdraw|.undo)`. Tables account_merges / account_merge_lines
// (tenantId, RLS, merge repoint). Tests: tests/accountMerge.test.ts.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { toCents } from '../../lib/money.js'
import { plSectionOf } from '../../lib/accountSection.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { SYSTEM_ACCOUNT_CODES, SYSTEM_POSTED_CODES } from '../setup/routes.js'
import { revenueCodeForConcept } from './journal.js'
import { fmtPktDate } from './dates.js'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
const REASON = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500)
const notPending = () => new AppError('REQUEST_NOT_PENDING', 'This merge was already decided or withdrawn — reload.', 409)

interface Acc { id: string; tenantId: string | null; code: string; name: string; type: string; isActive: boolean; controlledBy: string | null; plSection: string | null }
const ACC_SELECT = { id: true, tenantId: true, code: true, name: true, type: true, isActive: true, controlledBy: true, plSection: true } as const
export interface MergeBlocker { code: string; message: string; status: number }

/** Why this account is one servd posts to itself (never merged), or null when it was opened by hand. */
async function systemReason(db: Db, acc: Acc): Promise<string | null> {
  const label = `${acc.code} ${acc.name}`
  if (acc.controlledBy) return `${label} is kept by a servd module`
  if (SYSTEM_ACCOUNT_CODES.has(acc.code) || SYSTEM_POSTED_CODES.has(acc.code)) return `${label} is an account servd posts to itself`
  if (!acc.tenantId) return `${label} has no company`
  const brands = await db.concept.findMany({ where: { tenantId: acc.tenantId }, select: { slug: true, name: true, revenueAccountCode: true, servdRevenueAccountCode: true } })
  if (brands.some((b) => revenueCodeForConcept(b) === acc.code || b.revenueAccountCode === acc.code || b.servdRevenueAccountCode === acc.code)) return `${label} is a brand's sales account`
  if (await db.bankAccount.count({ where: { tenantId: acc.tenantId, accountCode: acc.code } })) return `${label} is a bank account's ledger account`
  if (await db.fixedAssetClass.count({ where: { tenantId: acc.tenantId, OR: [{ costAccountCode: acc.code }, { accumAccountCode: acc.code }] } })) return `${label} is a fixed-asset class account`
  const [hoBooks, hoLinks] = await Promise.all([
    serviceClient.headOfficeBooks.count({ where: { rechargeAccountId: acc.id } }),
    serviceClient.headOfficeLink.count({ where: { chargesAccountId: acc.id } }),
  ])
  if (hoBooks || hoLinks) return `${label} is mapped to a head office`
  return null
}

/** What a merge of `fromId` into `intoId` would move, and everything that blocks it. Both accounts in `tenantId`. */
export async function mergeCheck(db: Db, tenantId: string, fromId: string, intoId: string, opts: { ignoreMergeId?: string } = {}) {
  const [from, into] = await Promise.all([
    db.account.findFirst({ where: { id: fromId, tenantId }, select: ACC_SELECT }),
    db.account.findFirst({ where: { id: intoId, tenantId }, select: ACC_SELECT }),
  ])
  if (!from) throw new NotFoundError('Account', fromId)
  if (!into) throw new NotFoundError('Account', intoId)
  const blockers: MergeBlocker[] = []
  const block = (code: string, message: string, status = 422) => blockers.push({ code, message, status })
  if (from.id === into.id) block('SAME_ACCOUNT', 'Pick two different accounts')
  if (from.type !== into.type) block('MERGE_TYPE_MISMATCH', `${from.code} is ${from.type} and ${into.code} is ${into.type} — only accounts of the same type can be merged`)
  else if (plSectionOf(from) !== plSectionOf(into)) block('MERGE_SECTION_MISMATCH', `${from.code} and ${into.code} show under different headings of the P&L — give them the same heading on the chart of accounts first`)
  for (const a of [from, into]) {
    const why = await systemReason(db, a)
    if (why) block('MERGE_NOT_HAND_MADE', `${why} — only accounts opened by hand can be merged`)
  }
  if (!into.isActive) block('MERGE_INTO_INACTIVE', `${into.code} ${into.name} is switched off — switch it on first`)

  const sums = await db.journalLine.groupBy({ by: ['type'], _sum: { amountCents: true }, _count: { _all: true }, where: { accountId: from.id } })
  const debitCents = toCents(sums.find((g) => g.type === 'debit')?._sum.amountCents ?? 0)
  const creditCents = toCents(sums.find((g) => g.type === 'credit')?._sum.amountCents ?? 0)
  const lineCount = sums.reduce((n, g) => n + g._count._all, 0)
  const span = await db.journalEntry.aggregate({ where: { lines: { some: { accountId: from.id } } }, _min: { entryDate: true }, _max: { entryDate: true }, _count: { _all: true } })

  const lock = await db.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
  if (lock && span._min.entryDate && span._min.entryDate <= lock.lockedThrough) {
    const closed = await db.journalEntry.count({ where: { entryDate: { lte: lock.lockedThrough }, lines: { some: { accountId: from.id } } } })
    block('ENTRIES_IN_CLOSED_BOOKS', `${closed} entr${closed === 1 ? 'y' : 'ies'} of ${from.code} ${from.name} ${closed === 1 ? 'is' : 'are'} dated in closed books (closed through ${fmtPktDate(lock.lockedThrough)}; the earliest is ${fmtPktDate(span._min.entryDate)}) — reopen the books from that date first (Accounting → Period close)`, 409)
  }
  const waiting = await db.accountMerge.findFirst({
    where: {
      tenantId, status: 'pending', ...(opts.ignoreMergeId ? { id: { not: opts.ignoreMergeId } } : {}),
      OR: [{ fromAccountId: { in: [from.id, into.id] } }, { intoAccountId: { in: [from.id, into.id] } }],
    },
    select: { fromCode: true, intoCode: true },
  })
  if (waiting) block('MERGE_PENDING', `A merge of ${waiting.fromCode} into ${waiting.intoCode} is already waiting for the CEO`, 409)
  const subAccounts = await db.subAccount.count({ where: { accountId: from.id } })
  return {
    from, into, lineCount, entryCount: span._count._all, debitCents, creditCents, netCents: debitCents - creditCents,
    firstDate: span._min.entryDate, lastDate: span._max.entryDate, subAccounts, blockers,
  }
}
const throwFirst = (blockers: MergeBlocker[]) => { const b = blockers[0]; if (b) throw new AppError(b.code, b.message, b.status) }

/** The merge itself — inside the caller's transaction, after its claim. Returns the figures it moved. */
async function applyMergeTx(tx: Tx, m: { id: string; tenantId: string; fromAccountId: string; intoAccountId: string }) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${m.tenantId}::text), hashtext('account-merge'))`
  await tx.$queryRaw`SELECT "id" FROM "accounts" WHERE "id" IN (${m.fromAccountId}, ${m.intoAccountId}) ORDER BY "id" FOR UPDATE`
  const c = await mergeCheck(tx, m.tenantId, m.fromAccountId, m.intoAccountId, { ignoreMergeId: m.id })
  throwFirst(c.blockers)
  // The record of every line that moves (the undo reads it), then the move.
  await tx.$executeRaw`
    INSERT INTO "account_merge_lines" ("id", "tenantId", "mergeId", "journalLineId")
    SELECT gen_random_uuid()::text, ${m.tenantId}, ${m.id}, "id" FROM "journal_lines" WHERE "accountId" = ${m.fromAccountId}`
  await tx.journalLine.updateMany({ where: { accountId: m.fromAccountId }, data: { accountId: m.intoAccountId } })
  // Sub-accounts follow; a twin on the kept account (same employee, else same name) takes the tags.
  const subs = await tx.subAccount.findMany({ where: { accountId: m.fromAccountId } })
  const moved: { id: string; name: string; foldedIntoId: string | null }[] = []
  for (const s of subs) {
    const twin = await tx.subAccount.findFirst({
      where: { accountId: m.intoAccountId, OR: [...(s.employeeId ? [{ employeeId: s.employeeId }] : []), { name: s.name }] }, select: { id: true },
    })
    if (twin) {
      // A line tagged to both would clash on (line, sub-account): fold the amounts.
      const tags = await tx.journalLineSubAccount.findMany({ where: { subAccountId: s.id }, select: { id: true, journalLineId: true, amountCents: true } })
      for (const t of tags) {
        const same = await tx.journalLineSubAccount.findFirst({ where: { journalLineId: t.journalLineId, subAccountId: twin.id }, select: { id: true, amountCents: true } })
        if (same) {
          await tx.journalLineSubAccount.update({ where: { id: same.id }, data: { amountCents: toCents(same.amountCents) + toCents(t.amountCents) } })
          await tx.journalLineSubAccount.delete({ where: { id: t.id } })
        } else await tx.journalLineSubAccount.update({ where: { id: t.id }, data: { subAccountId: twin.id } })
      }
      await tx.subAccount.delete({ where: { id: s.id } })
      moved.push({ id: s.id, name: s.name, foldedIntoId: twin.id })
    } else {
      await tx.subAccount.update({ where: { id: s.id }, data: { accountId: m.intoAccountId } })
      moved.push({ id: s.id, name: s.name, foldedIntoId: null })
    }
  }
  if (moved.length) await tx.account.update({ where: { id: m.intoAccountId }, data: { subAccountsEnabled: true } })
  await tx.account.update({ where: { id: m.fromAccountId }, data: { isActive: false, subAccountsEnabled: false } })
  // Other companies' accounts linked to the old code follow to the kept code (their own rows: service client).
  await serviceClient.account.updateMany({ where: { relatedTenantId: m.tenantId, relatedAccountCode: c.from.code }, data: { relatedAccountCode: c.into.code } })
  await tx.accountMerge.update({
    where: { id: m.id },
    data: { lineCount: c.lineCount, debitCents: c.debitCents, creditCents: c.creditCents, subAccounts: moved as unknown as Prisma.InputJsonValue, appliedAt: new Date() },
  })
  return c
}

export async function accountMergeRoutes(fastify: FastifyInstance) {
  const gate = [requireAuth('finance', 'admin'), requireModule('accounting')]
  const activeTenant = (req: FastifyRequest) => {
    const t = req.staffUser!.tenantId
    if (!t) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company — each company has its own chart of accounts', 422)
    return t
  }
  /** The company of two accounts the caller may write in; 404 when either is not theirs or they differ. */
  async function companyOf(req: FastifyRequest, fromId: string, intoId: string): Promise<string> {
    const scope = await scopeTenantWhere(req, 'write')
    const rows = await prisma.account.findMany({ where: { id: { in: [fromId, intoId] }, ...scope }, select: { id: true, tenantId: true } })
    const from = rows.find((r) => r.id === fromId)
    const into = rows.find((r) => r.id === intoId)
    if (!from?.tenantId) throw new NotFoundError('Account', fromId)
    if (!into?.tenantId || into.tenantId !== from.tenantId) throw new NotFoundError('Account', intoId)
    return from.tenantId
  }
  const view = (c: Awaited<ReturnType<typeof mergeCheck>>) => ({
    from: { id: c.from.id, code: c.from.code, name: c.from.name, type: c.from.type },
    into: { id: c.into.id, code: c.into.code, name: c.into.name, type: c.into.type },
    lineCount: c.lineCount, entryCount: c.entryCount, debitCents: c.debitCents, creditCents: c.creditCents, netCents: c.netCents,
    firstDate: c.firstDate ? fmtPktDate(c.firstDate) : null, lastDate: c.lastDate ? fmtPktDate(c.lastDate) : null,
    subAccounts: c.subAccounts, blockers: c.blockers.map((b) => ({ code: b.code, message: b.message })),
  })

  fastify.get<{ Querystring: { fromAccountId?: string; intoAccountId?: string } }>('/preview', { preHandler: gate }, async (req) => {
    const q = z.object({ fromAccountId: z.string().min(1), intoAccountId: z.string().min(1) }).parse(req.query)
    const tenantId = await companyOf(req, q.fromAccountId, q.intoAccountId)
    return view(await mergeCheck(prisma, tenantId, q.fromAccountId, q.intoAccountId))
  })

  fastify.post('/', { preHandler: gate }, async (req, reply) => {
    const body = z.object({ fromAccountId: z.string().min(1), intoAccountId: z.string().min(1), reason: REASON }).parse(req.body ?? {})
    const su = req.staffUser!
    activeTenant(req)
    const tenantId = await companyOf(req, body.fromAccountId, body.intoAccountId)
    const isCeo = su.role === 'admin'
    const out = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext('account-merge'))`
      const c = await mergeCheck(tx, tenantId, body.fromAccountId, body.intoAccountId)
      throwFirst(c.blockers)
      const row = await tx.accountMerge.create({
        data: {
          tenantId, fromAccountId: c.from.id, intoAccountId: c.into.id, fromCode: c.from.code, fromName: c.from.name,
          intoCode: c.into.code, intoName: c.into.name, reason: body.reason, requestedById: su.id,
          lineCount: c.lineCount, debitCents: c.debitCents, creditCents: c.creditCents,
          ...(isCeo ? { status: 'done', decidedById: su.id, decidedAt: new Date() } : {}),
        },
      })
      if (isCeo) await applyMergeTx(tx, row)
      return tx.accountMerge.findUniqueOrThrow({ where: { id: row.id } })
    }, { timeout: 120_000 })
    await audit({
      category: 'accounting', action: isCeo ? 'account.merge' : 'account.merge.request', entity: 'AccountMerge', entityId: out.id, tenantId,
      userId: su.id, userEmail: su.email ?? null,
      metadata: { from: `${out.fromCode} ${out.fromName}`, into: `${out.intoCode} ${out.intoName}`, lines: out.lineCount, debitCents: out.debitCents, creditCents: out.creditCents, reason: body.reason, actorRole: su.role },
    })
    if (isCeo) return reply.status(201).send({ merged: true, merge: out })
    approvalWaiting('account_merge', out.id, { round: out.createdAt.toISOString(), actorId: su.id })
    return reply.status(202).send({ pendingApproval: true, request: out })
  })

  fastify.get<{ Querystring: { status?: string } }>('/', { preHandler: gate }, async (req) => {
    const status = ['pending', 'done', 'rejected', 'withdrawn', 'undone'].includes(req.query.status ?? '') ? req.query.status : undefined
    const rows = await prisma.accountMerge.findMany({ where: { ...(await scopeTenantWhere(req, 'read')), ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 })
    const [users, tenants] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
      prisma.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } }, select: { id: true, name: true } }),
    ])
    const u = new Map<string, string | null>(users.map((x) => [x.id, x.name]))
    const t = new Map<string, string | null>(tenants.map((x) => [x.id, x.name]))
    const me = req.staffUser!
    return {
      items: await Promise.all(rows.map(async (r) => {
        // A waiting merge shows what blocks it NOW (the approve button reads it).
        const blockedBy = r.status === 'pending'
          ? (await mergeCheck(prisma, r.tenantId, r.fromAccountId, r.intoAccountId, { ignoreMergeId: r.id }).then((c) => c.blockers[0]?.message ?? null).catch(() => 'one of the accounts is gone'))
          : null
        return {
          ...r, companyName: t.get(r.tenantId) ?? null, requestedByName: u.get(r.requestedById) ?? null,
          decidedByName: r.decidedById ? u.get(r.decidedById) ?? null : null, blockedBy,
          canWithdraw: r.status === 'pending' && (me.role === 'admin' || r.requestedById === me.id),
          canUndo: r.status === 'done' && me.role === 'admin',
        }
      })),
    }
  })

  async function forDecision(req: FastifyRequest, id: string) {
    const r = await prisma.accountMerge.findFirst({ where: { id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!r) throw new NotFoundError('Account merge', id)
    return r
  }
  async function grantFor(req: FastifyRequest, id: string) {
    const s = await approvalSubject('account_merge', id)
    if (!s) throw new NotFoundError('Account merge', id)
    return assertCanApprove(req, approvalInputOf('account_merge', id, s))
  }

  fastify.post<{ Params: { id: string } }>('/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    if (r.status !== 'pending') throw notPending()
    const decidedAt = new Date()
    const c = await prisma.$transaction(async (tx) => {
      const claimed = await tx.accountMerge.updateMany({
        where: { id: r.id, status: 'pending' },
        data: { status: 'done', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note ?? null },
      })
      if (claimed.count === 0) throw notPending()
      return applyMergeTx(tx, r)
    }, { timeout: 120_000 })
    await auditApproval(req, {
      type: 'account_merge', id: r.id, tenantId: r.tenantId, decision: 'approve', grant, entity: 'AccountMerge',
      metadata: { from: `${r.fromCode} ${r.fromName}`, into: `${r.intoCode} ${r.intoName}`, lines: c.lineCount, debitCents: c.debitCents, creditCents: c.creditCents, note: body.note ?? null, decidedAt, requestedBy: r.requestedById },
    })
    return { id: r.id, approved: true, lineCount: c.lineCount }
  })

  fastify.post<{ Params: { id: string } }>('/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: REASON }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    const decidedAt = new Date()
    const claimed = await prisma.accountMerge.updateMany({
      where: { id: r.id, status: 'pending' }, data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note },
    })
    if (claimed.count === 0) throw notPending()
    await auditApproval(req, {
      type: 'account_merge', id: r.id, tenantId: r.tenantId, decision: 'reject', grant, entity: 'AccountMerge',
      metadata: { from: `${r.fromCode} ${r.fromName}`, into: `${r.intoCode} ${r.intoName}`, note: body.note, decidedAt, requestedBy: r.requestedById },
    })
    return { id: r.id, rejected: true }
  })

  fastify.post<{ Params: { id: string } }>('/:id/withdraw', { preHandler: gate }, async (req) => {
    const r = await forDecision(req, req.params.id)
    if (req.staffUser!.role !== 'admin' && r.requestedById !== req.staffUser!.id) throw new ForbiddenError('Only the person who asked (or the CEO) may withdraw it.')
    const claimed = await prisma.accountMerge.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'withdrawn', decidedById: req.staffUser!.id, decidedAt: new Date() } })
    if (claimed.count === 0) throw notPending()
    await audit({
      category: 'accounting', action: 'account.merge.withdraw', entity: 'AccountMerge', entityId: r.id, tenantId: r.tenantId,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, metadata: { requestedBy: r.requestedById },
    })
    return { id: r.id, withdrawn: true }
  })

  // POST /:id/undo {reason} — the CEO puts the recorded lines back on the old account and switches it on again.
  fastify.post<{ Params: { id: string } }>('/:id/undo', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ reason: REASON }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const moved = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${r.tenantId}::text), hashtext('account-merge'))`
      const claimed = await tx.accountMerge.updateMany({ where: { id: r.id, status: 'done' }, data: { status: 'undone', undoneAt: new Date(), undoneById: req.staffUser!.id } })
      if (claimed.count === 0) throw new AppError('MERGE_NOT_DONE', 'Only a completed merge can be undone', 409)
      const subs = (r.subAccounts as { id: string; name: string; foldedIntoId: string | null }[] | null) ?? []
      if (subs.some((s) => s.foldedIntoId)) throw new AppError('UNDO_NOT_POSSIBLE', 'A sub-account of the old account was combined with one on the kept account, so this merge cannot be undone by itself — move the entries back with journal entries', 409)
      const lock = await tx.periodLock.findFirst({ where: { tenantId: r.tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
      if (lock) {
        const closed = await tx.journalEntry.count({ where: { entryDate: { lte: lock.lockedThrough }, lines: { some: { id: { in: (await tx.accountMergeLine.findMany({ where: { mergeId: r.id }, select: { journalLineId: true } })).map((l) => l.journalLineId) } } } } })
        if (closed > 0) throw new AppError('ENTRIES_IN_CLOSED_BOOKS', `${closed} of the moved entries are now dated in closed books (closed through ${fmtPktDate(lock.lockedThrough)}) — reopen the books from that date first`, 409)
      }
      await tx.account.update({ where: { id: r.fromAccountId }, data: { isActive: true, ...(subs.length ? { subAccountsEnabled: true } : {}) } })
      const n = await tx.$executeRaw`
        UPDATE "journal_lines" SET "accountId" = ${r.fromAccountId}
        WHERE "accountId" = ${r.intoAccountId} AND "id" IN (SELECT "journalLineId" FROM "account_merge_lines" WHERE "mergeId" = ${r.id})`
      if (subs.length) await tx.subAccount.updateMany({ where: { id: { in: subs.map((s) => s.id) }, accountId: r.intoAccountId }, data: { accountId: r.fromAccountId } })
      return n
    }, { timeout: 120_000 })
    await audit({
      category: 'accounting', action: 'account.merge.undo', entity: 'AccountMerge', entityId: r.id, tenantId: r.tenantId,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null,
      metadata: { from: `${r.fromCode} ${r.fromName}`, into: `${r.intoCode} ${r.intoName}`, linesBack: moved, reason: body.reason },
    })
    return { id: r.id, undone: true, linesBack: moved }
  })
}
