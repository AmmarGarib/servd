// /reconciliation/brs/* — Bank Reconciliation Statements (owner, 2026-11-05). The contract is the header of ./brs.ts.
//   reads (statement, list, dashboard, reports)  RECONCILERS (the /reconciliation module gate narrows them)
//   prepare (create, closing balance, section F, marks, review flags, matching, submit, cancel a draft)
//                                                 BANK_BOOKERS — the CEO, co-owners, finance holding `accounting`
//   approve / return                              the CEO (approval type bank_reconciliation, assertCanApprove)
//   reopen                                        finance holding `accounting` or the CEO; the CEO is told
// Company: the BANK's company — a bank of another company is 404, a new reconciliation binds to the active company's
// bank. Every write is audited (category accounting, entity BankReconciliation). Nothing here posts to the ledger.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCE_TEAM, APPROVERS } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { toCents, zMoneyCents } from '../../lib/money.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { notifyStaffMany, queueStaffNotify } from '../../lib/staffNotify.js'
import { exportFormatOf, sendReportFor, type ReportRow, type ReportTable } from '../../lib/reportExport.js'
import {
  ADJ_KINDS, ADJ_KIND_LABEL, MIN_TEXT, assertDay, computeStatement, fingerprintOf, isoDay, loadBank, recordOf,
  suggestMatches, approvedPeriodHolding, type Statement,
} from './brs.js'
import { manualMatchStatementLine } from './service.js'

const RECONCILERS = FINANCE_TEAM
const financeHoldsAccounting = async (req: FastifyRequest) => {
  if (req.staffUser?.role === 'finance') await requireModule('accounting')(req)
}
const BANK_BOOKERS = [requireAuth(...([...APPROVERS, 'finance'] as UserRole[])), financeHoldsAccounting]
const REOPENERS = [requireAuth('admin', 'finance'), financeHoldsAccounting]
const TX = { maxWait: 10_000, timeout: 60_000 }

const idsOf = async (req: FastifyRequest, mode: 'read' | 'write' | 'create'): Promise<string[]> => {
  const w = await scopeTenantWhere(req, mode) as { tenantId: string | { in: string[] } }
  return typeof w.tenantId === 'string' ? [w.tenantId] : w.tenantId.in
}

async function loadRec(req: FastifyRequest, id: string, mode: 'read' | 'write') {
  const r = await prisma.bankReconciliation.findFirst({ where: { id, tenantId: { in: await idsOf(req, mode) } } })
  if (!r) throw new NotFoundError('BankReconciliation', id)
  return r
}
type Rec = Awaited<ReturnType<typeof loadRec>>

const lockBank = (tx: Prisma.TransactionClient, bankId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`brs:${bankId}`}))`

async function liveStatement(db: Prisma.TransactionClient | typeof prisma, r: Rec): Promise<Statement> {
  const bank = await loadBank(db, r.bankAccountId, [r.tenantId])
  return computeStatement(db, { bank, ...recordOf(r), reconciliationId: r.id })
}

const assertDraft = (r: Rec) => {
  if (r.status !== 'draft') throw new AppError('RECONCILIATION_NOT_DRAFT', `This reconciliation is ${r.status} — only a draft can be changed (reopen an approved one first)`, 409)
}

async function names(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))]
  if (list.length === 0) return new Map()
  return new Map((await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name ?? u.email ?? 'Someone']))
}

function view(r: Rec, who: Map<string, string>) {
  return {
    tenantId: r.tenantId, bankAccountId: r.bankAccountId, accountCode: r.accountCode, ...recordOf(r),
    periodKind: r.periodKind, status: r.status,
    preparedById: r.preparedById, submittedById: r.submittedById,
    preparedBy: who.get(r.preparedById) ?? null, preparedAt: r.preparedAt.toISOString(),
    submittedBy: r.submittedById ? who.get(r.submittedById) ?? null : null, submittedAt: r.submittedAt?.toISOString() ?? null,
    approvedBy: r.approvedById ? who.get(r.approvedById) ?? null : null, approvedAt: r.approvedAt?.toISOString() ?? null,
    returnedBy: r.returnedById ? who.get(r.returnedById) ?? null : null, returnedAt: r.returnedAt?.toISOString() ?? null, returnNote: r.returnNote,
    reopenedBy: r.reopenedById ? who.get(r.reopenedById) ?? null : null, reopenedAt: r.reopenedAt?.toISOString() ?? null,
    reopenReason: r.reopenReason, reopenCount: r.reopenCount,
  }
}
const whoOf = (r: Rec) => names([r.preparedById, r.submittedById, r.approvedById, r.returnedById, r.reopenedById])

async function auditRec(req: FastifyRequest, r: { id: string; tenantId: string }, action: string, metadata: Record<string, unknown>, before?: unknown, after?: unknown) {
  await audit({
    category: 'accounting', action: `bank_reconciliation.${action}`, entity: 'BankReconciliation', entityId: r.id,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: r.tenantId,
    before: before as never, after: after as never, metadata: { actorRole: req.staffUser!.role, ...metadata },
  })
}

const createSchema = z.object({
  bankAccountId: z.string().min(1),
  periodFrom: z.string(), periodTo: z.string(),
  periodKind: z.enum(['month', 'quarter', 'custom']).default('custom'),
  bankClosingCents: zMoneyCents('The closing balance as per the bank statement', { sign: 'any' }).nullable().optional(),
})

export async function brsRoutes(fastify: FastifyInstance) {
  // ── Dashboard ──────────────────────────────────────────────────────────────────────────────────────────────────
  fastify.get('/dashboard', { preHandler: requireAuth(...RECONCILERS) }, async (req) => {
    const tenantIds = await idsOf(req, 'read')
    const banks = await prisma.bankAccount.findMany({ where: { tenantId: { in: tenantIds }, deletedAt: null, isActive: true, accountCode: { not: null } }, select: { id: true } })
    const recs = await prisma.bankReconciliation.findMany({ where: { tenantId: { in: tenantIds }, status: { not: 'cancelled' } }, select: { status: true, snapshot: true, bankAccountId: true, periodTo: true } })
    const count = (s: string) => recs.filter((r) => r.status === s).length
    // Outstanding = the latest approved statement of each bank (what was signed off).
    const latest = new Map<string, { periodTo: Date; snapshot: Statement | null }>()
    for (const r of recs) {
      if (r.status !== 'approved') continue
      const cur = latest.get(r.bankAccountId)
      if (!cur || cur.periodTo < r.periodTo) latest.set(r.bankAccountId, { periodTo: r.periodTo, snapshot: r.snapshot as unknown as Statement | null })
    }
    let cheques = 0, deposits = 0
    for (const l of latest.values()) { cheques += l.snapshot?.totals.chequesCents ?? 0; deposits += l.snapshot?.totals.depositsCents ?? 0 }
    // Unreconciled differences of the reconciliations still being worked (drafts with a closing balance).
    let difference = 0
    for (const r of await prisma.bankReconciliation.findMany({ where: { tenantId: { in: tenantIds }, status: 'draft', bankClosingCents: { not: null } } })) {
      difference += Math.abs((await liveStatement(prisma, r)).totals.differenceCents ?? 0)
    }
    const reconciledBanks = new Set(latest.keys())
    return {
      bankAccounts: banks.length,
      pending: count('draft') + banks.filter((b) => !recs.some((r) => r.bankAccountId === b.id)).length,
      drafts: count('draft'),
      awaitingApproval: count('submitted'),
      completed: count('approved'),
      banksNeverReconciled: banks.filter((b) => !reconciledBanks.has(b.id)).length,
      outstandingChequesCents: cheques,
      uncreditedDepositsCents: deposits,
      unreconciledDifferenceCents: difference,
    }
  })

  // ── Bank-wise status (also the report) ───────────────────────────────────────────────────────────────────────
  const bankStatus = async (req: FastifyRequest) => {
    const tenantIds = await idsOf(req, 'read')
    const banks = await prisma.bankAccount.findMany({
      where: { tenantId: { in: tenantIds }, deletedAt: null },
      select: { id: true, tenantId: true, name: true, bankName: true, accountNumber: true, accountCode: true, isActive: true },
      orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
    })
    const recs = await prisma.bankReconciliation.findMany({ where: { bankAccountId: { in: banks.map((b) => b.id) }, status: { not: 'cancelled' } }, orderBy: { periodTo: 'desc' } })
    const tenants = new Map((await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]))
    return banks.map((b) => {
      const mine = recs.filter((r) => r.bankAccountId === b.id)
      const approved = mine.find((r) => r.status === 'approved')
      const open = mine.find((r) => r.status !== 'approved')
      const snap = approved?.snapshot as unknown as Statement | null
      return {
        bankAccountId: b.id, companyName: b.tenantId ? tenants.get(b.tenantId) ?? null : null, name: b.name, bankName: b.bankName,
        accountNumber: b.accountNumber, accountCode: b.accountCode, isActive: b.isActive,
        lastApprovedPeriodTo: approved ? isoDay(approved.periodTo) : null, lastApprovedId: approved?.id ?? null,
        outstandingChequesCents: snap?.totals.chequesCents ?? null, uncreditedDepositsCents: snap?.totals.depositsCents ?? null,
        open: open ? { id: open.id, status: open.status, periodFrom: isoDay(open.periodFrom), periodTo: isoDay(open.periodTo) } : null,
      }
    })
  }
  fastify.get<{ Querystring: { format?: string } }>('/banks', { preHandler: requireAuth(...RECONCILERS) }, async (req, reply) => {
    const rows = await bankStatus(req)
    const format = exportFormatOf(req.query.format)
    if (!format) return rows
    return sendReportFor(req, reply, format, 'bank-reconciliation-status', {
      title: 'Bank-wise Reconciliation Status',
      rows: rows.map((r) => ({
        company: r.companyName, bank: r.name, bank_name: r.bankName, account_number: r.accountNumber, chart_code: r.accountCode,
        last_approved_through: r.lastApprovedPeriodTo ?? 'Never', outstanding_cheques: r.outstandingChequesCents, uncredited_deposits: r.uncreditedDepositsCents,
        in_progress: r.open ? `${r.open.status} ${r.open.periodFrom} to ${r.open.periodTo}` : '',
      })),
      types: { outstanding_cheques: 'cents', uncredited_deposits: 'cents' },
    })
  })

  // ── List ───────────────────────────────────────────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { bankAccountId?: string; status?: string; limit?: string } }>('/', { preHandler: requireAuth(...RECONCILERS) }, async (req) => {
    const rows = await prisma.bankReconciliation.findMany({
      where: {
        tenantId: { in: await idsOf(req, 'read') },
        ...(req.query.bankAccountId && { bankAccountId: req.query.bankAccountId }),
        ...(req.query.status ? { status: req.query.status } : { status: { not: 'cancelled' } }),
      },
      orderBy: [{ periodTo: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(Number(req.query.limit) || 200, 500),
    })
    const banks = new Map((await prisma.bankAccount.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.bankAccountId))] } }, select: { id: true, name: true, bankName: true, accountNumber: true } })).map((b) => [b.id, b]))
    const who = await names(rows.flatMap((r) => [r.preparedById, r.submittedById, r.approvedById, r.returnedById, r.reopenedById]))
    return rows.map((r) => {
      const snap = r.snapshot as unknown as Statement | null
      return {
        ...view(r, who), bank: banks.get(r.bankAccountId) ?? null,
        totals: snap?.totals ?? null, bookClosingCents: snap?.book.closingCents ?? null,
      }
    })
  })

  // ── Create ─────────────────────────────────────────────────────────────────────────────────────────────────────
  fastify.post('/', { preHandler: BANK_BOOKERS }, async (req, reply) => {
    const body = createSchema.parse(req.body ?? {})
    const from = assertDay(body.periodFrom, 'Reconciliation start date')
    const to = assertDay(body.periodTo, 'Reconciliation end date')
    if (from > to) throw new AppError('PERIOD_BACKWARDS', 'The start date is after the end date', 422)
    const bank = await loadBank(prisma, body.bankAccountId, await idsOf(req, 'create'))
    const rec = await prisma.$transaction(async (tx) => {
      await lockBank(tx, bank.id)
      const clash = await tx.bankReconciliation.findFirst({
        where: { bankAccountId: bank.id, status: { not: 'cancelled' }, periodFrom: { lte: new Date(`${to}T00:00:00Z`) }, periodTo: { gte: new Date(`${from}T00:00:00Z`) } },
        select: { id: true, periodFrom: true, periodTo: true },
      })
      if (clash) throw new AppError('PERIOD_OVERLAPS', `This bank already has a reconciliation for ${isoDay(clash.periodFrom)} to ${isoDay(clash.periodTo)} — periods of one bank never overlap`, 409, { reconciliationId: clash.id })
      // Default closing balance: the statement import of this bank dated the period end.
      let closing = body.bankClosingCents ?? null
      if (closing == null) {
        const imp = await tx.bankStatementImport.findFirst({
          where: { tenantId: bank.tenantId, OR: [{ bankAccountId: bank.id }, { bankAccountId: null, accountCode: bank.accountCode }], statementDate: { gte: new Date(`${to}T00:00:00Z`), lt: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000) } },
          orderBy: { importedAt: 'desc' }, select: { closingBalanceCents: true },
        })
        closing = imp ? toCents(imp.closingBalanceCents) : null
      }
      return tx.bankReconciliation.create({
        data: {
          tenantId: bank.tenantId, bankAccountId: bank.id, accountCode: bank.accountCode,
          periodFrom: new Date(`${from}T00:00:00Z`), periodTo: new Date(`${to}T00:00:00Z`), periodKind: body.periodKind,
          bankClosingCents: closing, preparedById: req.staffUser!.id,
        },
      })
    }, TX)
    await auditRec(req, rec, 'create', { bankAccountId: bank.id, periodFrom: from, periodTo: to, bankClosingCents: rec.bankClosingCents == null ? null : toCents(rec.bankClosingCents) })
    return reply.status(201).send(view(rec, await whoOf(rec)))
  })

  // ── One reconciliation: the record + its statement (live while open; the approved snapshot once approved) ─────
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...RECONCILERS) }, async (req) => {
    const r = await loadRec(req, req.params.id, 'read')
    const live = await liveStatement(prisma, r)
    const snap = r.status === 'approved' ? (r.snapshot as unknown as Statement | null) : null
    const history = await prisma.auditLog.findMany({
      where: { entity: 'BankReconciliation', entityId: r.id }, orderBy: { createdAt: 'asc' },
      select: { action: true, userEmail: true, createdAt: true, metadata: true, userId: true },
    })
    const who = await whoOf(r)
    const people = await names(history.map((h) => h.userId))
    const bankRow = await prisma.bankAccount.findUnique({ where: { id: r.bankAccountId }, select: { name: true, bankName: true, accountNumber: true } })
    return {
      reconciliation: { ...view(r, who), bank: bankRow, totals: (snap ?? live).totals, bookClosingCents: (snap ?? live).book.closingCents },
      statement: snap ?? live,
      /** An approved statement whose live figures no longer agree (a back-dated entry, a reopened match): shown, never hidden. */
      changedSinceApproval: snap ? fingerprintOf(snap) !== fingerprintOf(live) : false,
      live: snap ? live.totals : null,
      history: history.map((h) => ({ action: h.action.replace('bank_reconciliation.', ''), by: (h.userId && people.get(h.userId)) ?? h.userEmail, at: h.createdAt.toISOString(), metadata: h.metadata })),
    }
  })

  // ── Closing balance as per bank ──────────────────────────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: BANK_BOOKERS }, async (req) => {
    const body = z.object({ bankClosingCents: zMoneyCents('The closing balance as per the bank statement', { sign: 'any' }).nullable() }).parse(req.body ?? {})
    const r = await loadRec(req, req.params.id, 'write')
    assertDraft(r)
    const n = await prisma.bankReconciliation.updateMany({ where: { id: r.id, status: 'draft' }, data: { bankClosingCents: body.bankClosingCents } })
    if (n.count === 0) throw new AppError('RECONCILIATION_NOT_DRAFT', 'This reconciliation is no longer a draft — reload it', 409)
    await auditRec(req, r, 'closing_balance', {}, { bankClosingCents: r.bankClosingCents == null ? null : toCents(r.bankClosingCents) }, { bankClosingCents: body.bankClosingCents })
    return { ok: true }
  })

  fastify.post<{ Params: { id: string } }>('/:id/cancel', { preHandler: BANK_BOOKERS }, async (req) => {
    const body = z.object({ reason: z.string().trim().min(MIN_TEXT, `Say why (at least ${MIN_TEXT} characters)`).max(500) }).parse(req.body ?? {})
    const r = await loadRec(req, req.params.id, 'write')
    assertDraft(r)
    const n = await prisma.bankReconciliation.updateMany({ where: { id: r.id, status: 'draft' }, data: { status: 'cancelled', cancelledAt: new Date(), cancelledById: req.staffUser!.id } })
    if (n.count === 0) throw new AppError('RECONCILIATION_NOT_DRAFT', 'This reconciliation is no longer a draft — reload it', 409)
    await auditRec(req, r, 'cancel', { reason: body.reason })
    return { ok: true }
  })

  // ── Section F: other adjustments / errors ───────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/:id/adjustments', { preHandler: BANK_BOOKERS }, async (req, reply) => {
    const body = z.object({
      side: z.enum(['bank', 'book']), kind: z.enum(ADJ_KINDS),
      amountCents: zMoneyCents('The adjustment', { sign: 'any' }).refine((v) => v !== 0, 'An adjustment of zero changes nothing'),
      narration: z.string().trim().min(MIN_TEXT, `Narration: at least ${MIN_TEXT} characters — say what the error is`).max(1000),
      reference: z.string().trim().min(1, 'A supporting reference is required (bank letter, voucher number, statement page…)').max(200),
      statementLineId: z.string().min(1).max(64).optional(), journalLineId: z.string().min(1).max(64).optional(),
    }).parse(req.body ?? {})
    const r = await loadRec(req, req.params.id, 'write')
    assertDraft(r)
    // A named line must be THIS bank's (statement line of its imports / journal line on its code, its company).
    if (body.statementLineId) {
      const bank = await loadBank(prisma, r.bankAccountId, [r.tenantId])
      const ok = await prisma.bankStatementLine.findFirst({ where: { id: body.statementLineId, import: { tenantId: r.tenantId, OR: [{ bankAccountId: bank.id }, { bankAccountId: null, accountCode: bank.accountCode }] } }, select: { id: true } })
      if (!ok) throw new AppError('LINE_NOT_THIS_BANK', 'That statement line is not on this bank account', 422)
    }
    if (body.journalLineId) {
      const ok = await prisma.journalLine.findFirst({ where: { id: body.journalLineId, journalEntry: { tenantId: r.tenantId }, account: { code: r.accountCode, tenantId: r.tenantId } }, select: { id: true } })
      if (!ok) throw new AppError('LINE_NOT_THIS_BANK', 'That book entry is not on this bank account', 422)
    }
    const a = await prisma.bankReconciliationAdjustment.create({
      data: { tenantId: r.tenantId, reconciliationId: r.id, side: body.side, kind: body.kind, amountCents: body.amountCents, narration: body.narration, reference: body.reference, statementLineId: body.statementLineId ?? null, journalLineId: body.journalLineId ?? null, createdById: req.staffUser!.id },
    })
    await auditRec(req, r, 'adjustment_add', { adjustmentId: a.id, side: a.side, kind: a.kind, amountCents: body.amountCents, narration: a.narration, reference: a.reference })
    return reply.status(201).send({ id: a.id })
  })

  fastify.post<{ Params: { id: string; adjId: string } }>('/:id/adjustments/:adjId/remove', { preHandler: BANK_BOOKERS }, async (req) => {
    const body = z.object({ reason: z.string().trim().min(MIN_TEXT, `Say why (at least ${MIN_TEXT} characters)`).max(500) }).parse(req.body ?? {})
    const r = await loadRec(req, req.params.id, 'write')
    assertDraft(r)
    const n = await prisma.bankReconciliationAdjustment.updateMany({ where: { id: req.params.adjId, reconciliationId: r.id, removedAt: null }, data: { removedAt: new Date(), removedById: req.staffUser!.id, removeReason: body.reason } })
    if (n.count === 0) throw new NotFoundError('BankReconciliationAdjustment', req.params.adjId)
    await auditRec(req, r, 'adjustment_remove', { adjustmentId: req.params.adjId, reason: body.reason })
    return { ok: true }
  })

  // ── Under review (a status only — the item stays on its side of the statement) ─────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/:id/review', { preHandler: BANK_BOOKERS }, async (req) => {
    const body = z.object({
      statementLineId: z.string().min(1).max(64).optional(), journalLineId: z.string().min(1).max(64).optional(),
      underReview: z.boolean(), note: z.string().trim().max(500).optional(),
    }).refine((b) => !!b.statementLineId !== !!b.journalLineId, 'Name one statement line or one book line').parse(req.body ?? {})
    const r = await loadRec(req, req.params.id, 'write')
    assertDraft(r)
    const bank = await loadBank(prisma, r.bankAccountId, [r.tenantId])
    if (body.statementLineId) {
      const line = await prisma.bankStatementLine.findFirst({ where: { id: body.statementLineId, import: { tenantId: r.tenantId, OR: [{ bankAccountId: bank.id }, { bankAccountId: null, accountCode: bank.accountCode }] } }, select: { id: true } })
      if (!line) throw new NotFoundError('BankStatementLine', body.statementLineId)
      await prisma.bankStatementLine.update({ where: { id: line.id }, data: { underReview: body.underReview, ...(body.note ? { notes: `Under review: ${body.note}`.slice(0, 520) } : {}) } })
    } else {
      const jl = await prisma.journalLine.findFirst({ where: { id: body.journalLineId!, journalEntry: { tenantId: r.tenantId }, account: { code: r.accountCode, tenantId: r.tenantId } }, select: { id: true } })
      if (!jl) throw new NotFoundError('JournalLine', body.journalLineId!)
      const mark = await prisma.bankReconBookMark.findUnique({ where: { journalLineId: jl.id } })
      if (mark?.status === 'cleared_prior') throw new AppError('LINE_CLEARED_PRIOR', 'That entry is marked cleared before the first reconciliation — remove that mark first', 409)
      if (body.underReview) {
        if (!body.note || body.note.length < 3) throw new AppError('NOTE_REQUIRED', 'Say what is being reviewed', 422)
        await prisma.bankReconBookMark.upsert({
          where: { journalLineId: jl.id },
          create: { tenantId: r.tenantId, bankAccountId: bank.id, journalLineId: jl.id, status: 'under_review', note: body.note, createdById: req.staffUser!.id },
          update: { note: body.note },
        })
      } else if (mark) await prisma.bankReconBookMark.delete({ where: { id: mark.id } })
    }
    await auditRec(req, r, 'review', { statementLineId: body.statementLineId ?? null, journalLineId: body.journalLineId ?? null, underReview: body.underReview, note: body.note ?? null })
    return { ok: true }
  })

  // ── Cleared before the first reconciliation (the opening bank balance) ───────────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/:id/cleared-prior', { preHandler: BANK_BOOKERS }, async (req) => {
    const body = z.object({
      journalLineId: z.string().min(1).max(64), cleared: z.boolean(),
      note: z.string().trim().min(MIN_TEXT, `Say why (at least ${MIN_TEXT} characters)`).max(500),
      reference: z.string().trim().max(200).optional(),
    }).parse(req.body ?? {})
    const r = await loadRec(req, req.params.id, 'write')
    assertDraft(r)
    const earlier = await prisma.bankReconciliation.count({ where: { bankAccountId: r.bankAccountId, status: { not: 'cancelled' }, periodTo: { lt: r.periodFrom } } })
    if (earlier > 0) throw new AppError('NOT_FIRST_RECONCILIATION', 'Only the first reconciliation of a bank may mark entries as cleared before it — later, an item clears only against a bank statement line', 409)
    const jl = await prisma.journalLine.findFirst({
      where: { id: body.journalLineId, journalEntry: { tenantId: r.tenantId }, account: { code: r.accountCode, tenantId: r.tenantId } },
      select: { id: true, journalEntry: { select: { entryDate: true } } },
    })
    if (!jl) throw new NotFoundError('JournalLine', body.journalLineId)
    if (jl.journalEntry.entryDate.getTime() >= new Date(`${isoDay(r.periodFrom)}T00:00:00+05:00`).getTime()) {
      throw new AppError('NOT_BEFORE_PERIOD', 'Only an entry dated before this reconciliation\'s start can be cleared before it — match it to its statement line instead', 422)
    }
    if (body.cleared) {
      await prisma.bankReconBookMark.upsert({
        where: { journalLineId: jl.id },
        create: { tenantId: r.tenantId, bankAccountId: r.bankAccountId, journalLineId: jl.id, status: 'cleared_prior', note: body.note, reference: body.reference ?? null, createdById: req.staffUser!.id },
        update: { status: 'cleared_prior', note: body.note, reference: body.reference ?? null },
      })
    } else {
      await prisma.bankReconBookMark.deleteMany({ where: { journalLineId: jl.id, status: 'cleared_prior' } })
    }
    await auditRec(req, r, body.cleared ? 'cleared_prior' : 'cleared_prior_undo', { journalLineId: jl.id, note: body.note, reference: body.reference ?? null })
    return { ok: true }
  })

  // ── Matching: suggestions, and applying them through the manual-match engine ─────────────────────────────────
  fastify.get<{ Params: { id: string }; Querystring: { days?: string } }>('/:id/suggestions', { preHandler: requireAuth(...RECONCILERS) }, async (req) => {
    const r = await loadRec(req, req.params.id, 'read')
    const bank = await loadBank(prisma, r.bankAccountId, [r.tenantId])
    return suggestMatches(prisma, bank, isoDay(r.periodTo), Math.min(Math.max(Number(req.query.days) || 7, 1), 60))
  })

  // GET /:id/bank-lines?journalLineId= — the book side's own "Match to bank line" (owner, 2026-11-05: "Give finance
  // option to settle these type of issues" — a deposit shown as not credited although the bank has it). Unmatched,
  // non-Raast statement lines of THIS bank with the same signed amount as the book line (a receipt = a bank credit),
  // nearest date first; `inPeriod` says whether a match clears it in this reconciliation (statement day ≤ period end).
  // The match itself goes through POST /:id/auto-match {pairs} — the manual-match engine, its locks and audit.
  fastify.get<{ Params: { id: string }; Querystring: { journalLineId?: string } }>('/:id/bank-lines', { preHandler: requireAuth(...RECONCILERS) }, async (req) => {
    const jlId = z.string().min(1).max(64).parse(req.query.journalLineId)
    const r = await loadRec(req, req.params.id, 'read')
    const bank = await loadBank(prisma, r.bankAccountId, [r.tenantId])
    const jl = await prisma.journalLine.findFirst({
      where: { id: jlId, account: { tenantId: r.tenantId, code: bank.accountCode }, journalEntry: { tenantId: r.tenantId } },
      select: { type: true, amountCents: true, journalEntry: { select: { entryDate: true } } },
    })
    if (!jl) throw new NotFoundError('JournalLine', jlId)
    const signed = (jl.type === 'debit' ? 1 : -1) * toCents(jl.amountCents)
    const lines = await prisma.bankStatementLine.findMany({
      where: {
        import: { tenantId: r.tenantId, OR: [{ bankAccountId: bank.id }, { bankAccountId: null, accountCode: bank.accountCode }] },
        matchStatus: 'unmatched', raastReceipt: null, amountCents: signed,
      },
      select: { id: true, postedDate: true, description: true, reference: true, amountCents: true, underReview: true },
      take: 200,
    })
    const periodEnd = isoDay(r.periodTo)
    const at = jl.journalEntry.entryDate.getTime()
    return lines
      .map((l) => ({ statementLineId: l.id, date: isoDay(l.postedDate), description: l.description, reference: l.reference, amountCents: toCents(l.amountCents), underReview: l.underReview, inPeriod: isoDay(l.postedDate) <= periodEnd, gapDays: Math.round(Math.abs(l.postedDate.getTime() - at) / 86_400_000) }))
      .sort((a, b) => a.gapDays - b.gapDays)
  })

  fastify.post<{ Params: { id: string } }>('/:id/auto-match', { preHandler: BANK_BOOKERS }, async (req) => {
    const body = z.object({
      pairs: z.array(z.object({ statementLineId: z.string().min(1).max(64), journalLineId: z.string().min(1).max(64) })).max(500).optional(),
      days: z.number().int().min(1).max(60).optional(),
    }).parse(req.body ?? {})
    const r = await loadRec(req, req.params.id, 'write')
    assertDraft(r)
    const bank = await loadBank(prisma, r.bankAccountId, [r.tenantId])
    const pairs = body.pairs ?? (await suggestMatches(prisma, bank, isoDay(r.periodTo), body.days ?? 7)).map((s) => ({ statementLineId: s.statementLineId, journalLineId: s.journalLineId }))
    let matched = 0
    const refused: Array<{ statementLineId: string; code: string; message: string }> = []
    for (const p of pairs) {
      try {
        const line = await prisma.bankStatementLine.findFirst({ where: { id: p.statementLineId, import: { tenantId: r.tenantId, OR: [{ bankAccountId: bank.id }, { bankAccountId: null, accountCode: bank.accountCode }] } }, select: { id: true, postedDate: true } })
        if (!line) throw new AppError('LINE_NOT_THIS_BANK', 'That statement line is not on this bank account', 422)
        const locked = await approvedPeriodHolding(prisma, bank, isoDay(line.postedDate))
        if (locked) throw new AppError('RECONCILIATION_LOCKED', 'That statement line is in an approved reconciliation', 409)
        const res = await manualMatchStatementLine(line.id, p.journalLineId)
        matched++
        await audit({
          category: 'accounting', action: 'reconciliation.line.match', entity: 'BankStatementLine', entityId: line.id,
          userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: res.tenantId,
          before: { matchStatus: 'unmatched', matchedJournalLineId: null }, after: { matchStatus: 'matched', matchedJournalLineId: p.journalLineId },
          metadata: { actorRole: req.staffUser!.role, amountCents: res.amountCents, journalEntryId: res.journalEntryId, via: 'bank_reconciliation', reconciliationId: r.id },
        })
      } catch (err) {
        refused.push({ statementLineId: p.statementLineId, code: (err as AppError).code ?? 'ERROR', message: (err as Error).message })
      }
    }
    if (matched > 0) await auditRec(req, r, 'auto_match', { matched, refused: refused.length })
    return { matched, refused }
  })

  // ── Workflow ───────────────────────────────────────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/:id/submit', { preHandler: BANK_BOOKERS }, async (req) => {
    const r = await loadRec(req, req.params.id, 'write')
    assertDraft(r)
    if (r.bankClosingCents == null) throw new AppError('BANK_CLOSING_REQUIRED', 'Enter the closing balance as per the bank statement first', 422)
    const at = new Date()
    const snap = await prisma.$transaction(async (tx) => {
      await lockBank(tx, r.bankAccountId)
      const s = await liveStatement(tx, r)
      if (s.totals.differenceCents !== 0) {
        throw new AppError('UNRECONCILED_DIFFERENCE', `The statement does not reconcile: a difference of PKR ${((s.totals.differenceCents ?? 0) / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} remains. Match, classify or explain every item (no balancing figure) before submitting.`, 422, { differenceCents: s.totals.differenceCents })
      }
      const n = await tx.bankReconciliation.updateMany({ where: { id: r.id, status: 'draft' }, data: { status: 'submitted', submittedById: req.staffUser!.id, submittedAt: at, snapshot: s as never, returnNote: null } })
      if (n.count === 0) throw new AppError('RECONCILIATION_NOT_DRAFT', 'This reconciliation is no longer a draft — reload it', 409)
      return s
    }, TX)
    await auditRec(req, r, 'submit', { bookClosingCents: snap.book.closingCents, bankClosingCents: snap.bankClosingCents, totals: snap.totals })
    approvalWaiting('bank_reconciliation', r.id, { round: `submit:${at.toISOString()}`, actorId: req.staffUser!.id })
    return { ok: true, statement: snap }
  })

  const grantFor = async (req: FastifyRequest, id: string) => {
    const s = await approvalSubject('bank_reconciliation', id)
    if (!s) throw new NotFoundError('BankReconciliation', id)
    return assertCanApprove(req, approvalInputOf('bank_reconciliation', id, s))
  }

  fastify.post<{ Params: { id: string } }>('/:id/approve', { preHandler: requireAuth('admin') }, async (req) => {
    const r = await loadRec(req, req.params.id, 'write')
    const grant = await grantFor(req, r.id)
    if (r.status !== 'submitted') throw new AppError('RECONCILIATION_NOT_SUBMITTED', `This reconciliation is ${r.status} — only a submitted one can be approved`, 409)
    const at = new Date()
    const snap = await prisma.$transaction(async (tx) => {
      await lockBank(tx, r.bankAccountId)
      const earlier = await tx.bankReconciliation.findFirst({ where: { bankAccountId: r.bankAccountId, status: { in: ['draft', 'submitted'] }, periodTo: { lt: r.periodFrom } }, select: { periodFrom: true, periodTo: true } })
      if (earlier) throw new AppError('EARLIER_NOT_APPROVED', `Approve the earlier reconciliation of this bank (${isoDay(earlier.periodFrom)} to ${isoDay(earlier.periodTo)}) first`, 409)
      const live = await liveStatement(tx, r)
      const submitted = r.snapshot as unknown as Statement | null
      if (!submitted || fingerprintOf(submitted) !== fingerprintOf(live) || live.totals.differenceCents !== 0) {
        throw new AppError('STATEMENT_CHANGED', 'The books or the bank lines changed after this reconciliation was submitted — return it to finance to recheck and submit again', 409)
      }
      const n = await tx.bankReconciliation.updateMany({ where: { id: r.id, status: 'submitted' }, data: { status: 'approved', approvedById: req.staffUser!.id, approvedAt: at, snapshot: live as never } })
      if (n.count === 0) throw new AppError('RECONCILIATION_NOT_SUBMITTED', 'This reconciliation is no longer waiting — reload it', 409)
      return live
    }, TX)
    await auditApproval(req, { type: 'bank_reconciliation', id: r.id, tenantId: r.tenantId, decision: 'approve', grant, entity: 'BankReconciliation', metadata: { decidedAt: at.toISOString(), totals: snap.totals } })
    await auditRec(req, r, 'approve', { totals: snap.totals })
    return { ok: true }
  })

  fastify.post<{ Params: { id: string } }>('/:id/return', { preHandler: requireAuth('admin') }, async (req) => {
    const body = z.object({ note: z.string().trim().min(MIN_TEXT, `Say what to fix (at least ${MIN_TEXT} characters)`).max(1000) }).parse(req.body ?? {})
    const r = await loadRec(req, req.params.id, 'write')
    const grant = await grantFor(req, r.id)
    if (r.status !== 'submitted') throw new AppError('RECONCILIATION_NOT_SUBMITTED', `This reconciliation is ${r.status} — only a submitted one can be returned`, 409)
    const at = new Date()
    const n = await prisma.bankReconciliation.updateMany({ where: { id: r.id, status: 'submitted' }, data: { status: 'draft', returnedById: req.staffUser!.id, returnedAt: at, returnNote: body.note } })
    if (n.count === 0) throw new AppError('RECONCILIATION_NOT_SUBMITTED', 'This reconciliation is no longer waiting — reload it', 409)
    await auditApproval(req, { type: 'bank_reconciliation', id: r.id, tenantId: r.tenantId, decision: 'return', grant, entity: 'BankReconciliation', metadata: { decidedAt: at.toISOString(), note: body.note, waitingUserIds: [r.submittedById, r.preparedById].filter(Boolean) } })
    await auditRec(req, r, 'return', { note: body.note })
    return { ok: true }
  })

  fastify.post<{ Params: { id: string } }>('/:id/reopen', { preHandler: REOPENERS }, async (req) => {
    const body = z.object({ reason: z.string().trim().min(MIN_TEXT, `Say why (at least ${MIN_TEXT} characters)`).max(1000) }).parse(req.body ?? {})
    const r = await loadRec(req, req.params.id, 'write')
    if (r.status !== 'approved') throw new AppError('RECONCILIATION_NOT_APPROVED', `This reconciliation is ${r.status} — only an approved one is reopened`, 409)
    await prisma.$transaction(async (tx) => {
      await lockBank(tx, r.bankAccountId)
      const later = await tx.bankReconciliation.findFirst({ where: { bankAccountId: r.bankAccountId, status: 'approved', periodFrom: { gt: r.periodTo } }, select: { periodFrom: true, periodTo: true } })
      if (later) throw new AppError('LATER_APPROVED', `A later reconciliation of this bank (${isoDay(later.periodFrom)} to ${isoDay(later.periodTo)}) is approved — reopen that one first`, 409)
      const n = await tx.bankReconciliation.updateMany({ where: { id: r.id, status: 'approved' }, data: { status: 'draft', reopenedById: req.staffUser!.id, reopenedAt: new Date(), reopenReason: body.reason, reopenCount: { increment: 1 } } })
      if (n.count === 0) throw new AppError('RECONCILIATION_NOT_APPROVED', 'This reconciliation is no longer approved — reload it', 409)
    }, TX)
    await auditRec(req, r, 'reopen', { reason: body.reason, approvedSnapshotTotals: (r.snapshot as unknown as Statement | null)?.totals ?? null })
    // Finance reopened what the CEO approved: the company's CEO(s) are told (owner, 2026-11-05).
    if (req.staffUser!.role !== 'admin') {
      const actorId = req.staffUser!.id
      queueStaffNotify(async () => {
        const ceos = await prisma.user.findMany({ where: { role: 'admin', isActive: true, accountStatus: 'active', tenantMemberships: { some: { tenantId: r.tenantId } } }, select: { id: true } })
        const bank = await prisma.bankAccount.findUnique({ where: { id: r.bankAccountId }, select: { name: true } })
        await notifyStaffMany(ceos.map((u) => ({
          userId: u.id, tenantId: r.tenantId, kind: 'bank_reconciliation.reopened' as const, severity: 'warning' as const,
          title: `Bank reconciliation reopened: ${bank?.name ?? 'bank'} ${isoDay(r.periodFrom)} to ${isoDay(r.periodTo)}`,
          body: `Reason: ${body.reason}`.slice(0, 500), link: `/finance/bank-reconciliation/${r.id}`,
          entityType: 'BankReconciliation', entityId: r.id, actorId, dedupeKey: `brs.reopen:${r.id}:${r.reopenCount + 1}`,
        })))
      })
    }
    return { ok: true }
  })

  // ── Reports ─────────────────────────────────────────────────────────────────────────────────────────────────
  // GET /:id/report?kind=statement|cheques|deposits|unmatched&format=pdf|xlsx|csv
  fastify.get<{ Params: { id: string }; Querystring: { kind?: string; format?: string } }>('/:id/report', { preHandler: requireAuth(...RECONCILERS) }, async (req, reply) => {
    const r = await loadRec(req, req.params.id, 'read')
    const s = (r.status === 'approved' ? (r.snapshot as unknown as Statement | null) : null) ?? await liveStatement(prisma, r)
    const format = exportFormatOf(req.query.format, 'pdf')!
    const kind = req.query.kind ?? 'statement'
    const who = await whoOf(r)
    const period = `${s.periodFrom} to ${s.periodTo}`
    const bankLine = `${s.bank.name}${s.bank.bankName ? ` · ${s.bank.bankName}` : ''}${s.bank.accountNumber ? ` · A/C ${s.bank.accountNumber}` : ''} · ${s.bank.accountCode} ${s.bank.accountName ?? ''}`.trim()
    const base = { companies: [(await prisma.tenant.findUnique({ where: { id: r.tenantId }, select: { name: true } }))?.name ?? ''], period }
    const bookCols = [
      { key: 'date', label: 'Date' }, { key: 'voucher', label: 'Voucher' }, { key: 'reference', label: 'Cheque / ref' },
      { key: 'party', label: 'Payee / depositor' }, { key: 'description', label: 'Description' }, { key: 'amount', label: 'Amount', type: 'cents' as const },
    ]
    const bookRows = (items: Statement['deposits']): ReportRow[] => items.map((i) => ({
      date: i.date, voucher: i.voucherNo ?? '', reference: i.chequeRef ?? '', party: i.party ?? '',
      description: `${i.description}${i.underReview ? ' [under review]' : ''}${i.clearedOn ? ` (cleared ${i.clearedOn})` : ''}`, amount: i.amountCents,
    }))
    const bankRows = (items: Statement['bankCredits']): ReportRow[] => items.map((i) => ({
      date: i.date, voucher: '', reference: i.reference ?? '', party: '', description: `${i.description}${i.underReview ? ' [under review]' : ''}${i.recordedOn ? ` (in books ${i.recordedOn})` : ''}`, amount: i.amountCents,
    }))
    let t: ReportTable
    if (kind === 'cheques' || kind === 'deposits') {
      const items = kind === 'cheques' ? s.cheques : s.deposits
      t = { ...base, title: kind === 'cheques' ? 'Outstanding Cheques (Issued, Not Presented)' : 'Uncredited Deposits (Not Yet Credited by Bank)', columns: bookCols, rows: [...bookRows(items), { date: 'TOTAL', amount: items.reduce((x, i) => x + i.amountCents, 0) }], notes: [bankLine], wrapKeys: ['description'] }
    } else if (kind === 'unmatched') {
      const rows: ReportRow[] = [
        ...s.bankCredits.map((i) => ({ section: 'Credited by bank, not in books', ...bankRows([i])[0]! })),
        ...s.bankDebits.map((i) => ({ section: 'Debited by bank, not in books', ...bankRows([i])[0]! })),
      ]
      t = { ...base, title: 'Unmatched Bank Transactions', columns: [{ key: 'section', label: 'Section' }, ...bookCols], rows, sectionKey: 'section', notes: [bankLine], wrapKeys: ['description'] }
    } else {
      // The statement: summary (both methods), then each section's items, then the sign-off. One shared header
      // (Date · Voucher · Cheque / ref · Particulars · PKR) so long particulars wrap in the PDF.
      const T = s.totals
      const sum = (section: string, label: string, cents: number | null) => ({ section, date: '', voucher: '', reference: '', particulars: label, amount: cents })
      const items = (section: string, xs: ReportRow[]) => (xs.length ? xs : [{ date: '', voucher: '', reference: '', party: '', description: 'None', amount: null }])
        .map((x) => ({ section, date: x.date, voucher: x.voucher, reference: x.reference, particulars: [x.party, x.description].filter(Boolean).join(' — '), amount: x.amount }))
      const S1 = 'Summary — Method 1: bank statement to books'
      const S2 = 'Summary — Method 2: books to bank statement (check)'
      const rows: ReportRow[] = [
        sum(S1, 'Closing balance as per bank statement (A)', s.bankClosingCents),
        sum(S1, 'Add: deposits not yet credited by the bank (B)', T.depositsCents),
        sum(S1, 'Less: cheques issued but not presented (C)', -T.chequesCents),
        ...(T.bankAdjustmentsCents ? [sum(S1, 'Add / (less): bank-side adjustments (F)', T.bankAdjustmentsCents)] : []),
        sum(S1, 'ADJUSTED BALANCE AS PER BANK', T.adjustedBankCents),
        sum(S1, 'Closing balance as per books (bank ledger)', s.book.closingCents),
        sum(S1, 'Add: credited by the bank, not recorded in the books (D)', T.bankCreditsCents),
        sum(S1, 'Less: debited by the bank, not recorded in the books (E)', -T.bankDebitsCents),
        ...(T.bookAdjustmentsCents ? [sum(S1, 'Add / (less): book-side adjustments (F)', T.bookAdjustmentsCents)] : []),
        sum(S1, 'ADJUSTED BALANCE AS PER BOOKS', T.adjustedBookCents),
        sum(S1, 'UNRECONCILED DIFFERENCE', T.differenceCents),
        sum(S2, 'Closing balance as per books', s.book.closingCents),
        sum(S2, 'Less: deposits not yet credited (B)', -T.depositsCents),
        sum(S2, 'Add: cheques not presented (C)', T.chequesCents),
        sum(S2, 'Add: credited by the bank, not in the books (D)', T.bankCreditsCents),
        sum(S2, 'Less: debited by the bank, not in the books (E)', -T.bankDebitsCents),
        ...(T.bookAdjustmentsCents || T.bankAdjustmentsCents ? [sum(S2, 'Add / (less): adjustments (F)', T.bookAdjustmentsCents - T.bankAdjustmentsCents)] : []),
        sum(S2, 'BALANCE THE BANK STATEMENT SHOULD SHOW', T.expectedBankCents),
        sum(S2, 'Closing balance as per bank statement', s.bankClosingCents),
        sum('Book balances (general ledger)', 'Opening balance as per books', s.book.openingCents),
        sum('Book balances (general ledger)', 'Receipts in the period', s.book.receiptsCents),
        sum('Book balances (general ledger)', 'Payments in the period', -s.book.paymentsCents),
        sum('Book balances (general ledger)', 'CLOSING BALANCE AS PER BOOKS', s.book.closingCents),
        ...items('B. Deposits not yet credited by the bank (uncredited cheques)', bookRows(s.deposits)),
        ...items('C. Cheques issued but not presented (unpresented cheques)', bookRows(s.cheques)),
        ...items('D. Amounts credited by the bank, not recorded in the books', bankRows(s.bankCredits)),
        ...items('E. Amounts debited by the bank, not recorded in the books', bankRows(s.bankDebits)),
        ...items('F. Other adjustments / errors', s.adjustments.map((a) => ({ date: a.createdAt.slice(0, 10), voucher: a.side === 'bank' ? 'Bank side' : 'Book side', reference: a.reference, party: a.kindLabel, description: a.narration, amount: a.amountCents }))),
      ]
      t = {
        ...base, title: 'Bank Reconciliation Statement',
        columns: [
          { key: 'section' }, { key: 'date', label: 'Date' }, { key: 'voucher', label: 'Voucher' }, { key: 'reference', label: 'Cheque / ref' },
          { key: 'particulars', label: 'Particulars' }, { key: 'amount', label: 'PKR', type: 'cents' },
        ],
        rows, sectionKey: 'section', wrapKeys: ['particulars'], narrowKeys: ['voucher', 'reference'],
        isTotal: (row) => typeof row.particulars === 'string' && /^[A-Z][A-Z ()/:-]+$/.test(row.particulars),
        notes: [
          bankLine, `Financial year ${s.financialYear} · status ${r.status}${r.status !== 'approved' ? ' (figures live — not yet approved)' : ''}`,
          'Unpresented cheques and uncredited deposits remain recorded in the books; this statement changes no entry.',
        ],
        signatures: [
          { label: 'Prepared by', name: who.get(r.preparedById) ?? null, at: isoDay(r.preparedAt) },
          { label: 'Reviewed by', name: r.submittedById ? who.get(r.submittedById) ?? null : null, at: r.submittedAt ? isoDay(r.submittedAt) : null },
          { label: 'Approved by', name: r.status === 'approved' && r.approvedById ? who.get(r.approvedById) ?? null : null, at: r.status === 'approved' && r.approvedAt ? isoDay(r.approvedAt) : null },
        ],
      }
    }
    return sendReportFor(req, reply, format, { base: `bank-reconciliation-${kind}`, suffix: `${s.bank.accountCode}-${s.periodTo}` }, t)
  })

  // GET /reports/charges?from&to&bankAccountId&format — bank charges, tax deducted and other bank debits / credits
  // booked from the bank statement (reconciliation.adjustment entries), by account.
  fastify.get<{ Querystring: { from?: string; to?: string; bankAccountId?: string; format?: string } }>('/reports/charges', { preHandler: requireAuth(...RECONCILERS) }, async (req, reply) => {
    const from = assertDay(req.query.from ?? '', 'From'), to = assertDay(req.query.to ?? '', 'To')
    const tenantIds = await idsOf(req, 'read')
    const banks = await prisma.bankAccount.findMany({ where: { tenantId: { in: tenantIds }, deletedAt: null, accountCode: { not: null }, ...(req.query.bankAccountId && { id: req.query.bankAccountId }) }, select: { id: true, tenantId: true, name: true, accountCode: true } })
    const entries = await prisma.journalEntry.findMany({
      where: {
        tenantId: { in: tenantIds }, reference: { startsWith: 'reconciliation.adjustment:' },
        entryDate: { gte: new Date(`${from}T00:00:00+05:00`), lte: new Date(`${to}T23:59:59.999+05:00`) },
      },
      select: { id: true, tenantId: true, entryDate: true, description: true, voucherNo: true, lines: { select: { type: true, amountCents: true, account: { select: { code: true, name: true } } } } },
      orderBy: { entryDate: 'asc' },
    })
    const { deadEntryIds } = await import('./service.js')
    const rows: ReportRow[] = []
    for (const e of entries) {
      if ((await deadEntryIds(prisma, e.tenantId!, [{ id: e.id, reference: null, description: e.description }])).has(e.id)) continue
      const bank = banks.find((b) => b.tenantId === e.tenantId && e.lines.some((l) => l.account.code === b.accountCode))
      if (!bank) continue
      for (const l of e.lines) {
        if (l.account.code === bank.accountCode) continue
        rows.push({
          date: isoDay(new Date(e.entryDate.getTime() + 5 * 3600_000)), bank: bank.name, voucher: e.voucherNo ?? '', account: `${l.account.code} ${l.account.name}`,
          description: e.description, debit: l.type === 'debit' ? toCents(l.amountCents) : null, credit: l.type === 'credit' ? toCents(l.amountCents) : null,
        })
      }
    }
    const format = exportFormatOf(req.query.format)
    if (!format) return rows
    return sendReportFor(req, reply, format, 'bank-charges-and-taxes', {
      title: 'Bank Charges and Tax Deductions (booked from bank statements)', period: `${from} to ${to}`, rows,
      types: { debit: 'cents', credit: 'cents' }, wrapKeys: ['description'],
    })
  })

  // GET /reports/monthly?from&to&format — every reconciliation in the window, one row each (the monthly summary).
  fastify.get<{ Querystring: { from?: string; to?: string; format?: string } }>('/reports/monthly', { preHandler: requireAuth(...RECONCILERS) }, async (req, reply) => {
    const from = assertDay(req.query.from ?? '', 'From'), to = assertDay(req.query.to ?? '', 'To')
    const recs = await prisma.bankReconciliation.findMany({
      where: { tenantId: { in: await idsOf(req, 'read') }, status: { not: 'cancelled' }, periodTo: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
      orderBy: [{ periodTo: 'asc' }, { bankAccountId: 'asc' }],
    })
    const banks = new Map((await prisma.bankAccount.findMany({ where: { id: { in: [...new Set(recs.map((r) => r.bankAccountId))] } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]))
    const rows: ReportRow[] = []
    for (const r of recs) {
      const s = (r.status === 'approved' ? r.snapshot as unknown as Statement | null : null) ?? await liveStatement(prisma, r)
      rows.push({
        month: isoDay(r.periodTo).slice(0, 7), bank: banks.get(r.bankAccountId) ?? '', period: `${isoDay(r.periodFrom)} to ${isoDay(r.periodTo)}`, status: r.status,
        book_closing: s.book.closingCents, bank_closing: s.bankClosingCents, uncredited_deposits: s.totals.depositsCents, unpresented_cheques: s.totals.chequesCents,
        bank_credits_not_in_books: s.totals.bankCreditsCents, bank_debits_not_in_books: s.totals.bankDebitsCents, difference: s.totals.differenceCents,
      })
    }
    const format = exportFormatOf(req.query.format)
    if (!format) return rows
    const cents = ['book_closing', 'bank_closing', 'uncredited_deposits', 'unpresented_cheques', 'bank_credits_not_in_books', 'bank_debits_not_in_books', 'difference']
    return sendReportFor(req, reply, format, 'bank-reconciliation-monthly', {
      title: 'Monthly Bank Reconciliation Summary', period: `${from} to ${to}`, rows, types: Object.fromEntries(cents.map((k) => [k, 'cents' as const])),
    })
  })
}
