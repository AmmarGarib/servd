// Intern stipend payroll (owner, 2026-11-06) — SEPARATE from employee payroll (HrPayrollRun): its own runs, slips,
// accounts and approval types. The contract is the header of ./interns.ts ("Stipend payroll"); this file holds the
// math, the ledger and the routes under /hr/interns/payroll.
//
// Math (the employees' basis, hr/logic.ts computePayslip): stipend ÷ the month's calendar days × paid days, rounded
// once; paid days = days engaged in the month (start … last day) − absent days − half days × 0.5 − leave days
// (interns earn no paid leave: a 'leave' day is unpaid). Late, weekly-off, present and unmarked days are paid. Then
// + HR's additions − HR's deductions = net (never negative: a run with a negative slip cannot leave draft).
//
// Books (company = the run's):
//   CEO approval   'hr.intern_stipend.accrual:<runId>'  Dr 6038 Intern Stipends / Cr 2025 Stipends Payable (net),
//                  dated the month's last day. Posted AFTER the approval commits; a refusal (closed month, account
//                  missing) is flagged posting_failed and re-posted from Reconciliation → Backfill unposted
//                  (reconciliation/backfillOrders.ts REPOSTERS 'hr.intern_stipend.accrual').
//   finance paid   'hr.intern_stipend.payment:<runId>'  Dr 2025 / Cr cash 1010 | the bank (lib/bankAccounts.ts
//                  moneyAccountCode of the run's company), dated paidOn; classified (paymentsRegister.ts) in its
//                  transaction. An approval whose accrual never posted is posted first, in the same transaction.
// Never 2020 Wages Payable, never a wages account (6030–6036, WAGE_CODES), never the head-office pool.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Intern, InternPayrollRun, InternStipendSlip, Prisma } from '@prisma/client'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { INT4_MAX_CENTS } from '../../lib/money.js'
import { moneyAccountCode } from '../../lib/bankAccounts.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { exportFormatOf, sendReportFor, type ReportRow } from '../../lib/reportExport.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { postJournalEntry, flagPostingFailed, resolvePostingFailed, withLateNote, type JournalLineInput, type RepostOptions } from '../accounting/journal.js'
import { classificationOf, classifyPaymentTx } from '../accounting/paymentsRegister.js'
import { daysInPeriod, nextPeriod, periodOf, periodStart, pktToday } from './logic.js'
import {
  ENROLLED, YMD, assertInternHr, assertPayrollReader, createTenant, isInternFinance, lastDayOf, memberTenants,
  parseYmd, viewTenants, DAY_MS, type Db,
} from './internAccess.js'
import { stipendSlipsPdf, type StipendSlipPdfInput } from './internPdf.js'

export const STIPEND_EXPENSE_CODE = '6038'
export const STIPENDS_PAYABLE_CODE = '2025'
export const STIPEND_ACCRUAL = 'hr.intern_stipend.accrual'
export const STIPEND_PAYMENT = 'hr.intern_stipend.payment'
export const RUN_STATUSES = ['draft', 'finance_review', 'finance_checked', 'approved', 'paid'] as const
export const RUN_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft (HR)', finance_review: 'With finance for review', finance_checked: 'Waiting for the CEO', approved: 'Approved — to pay', paid: 'Paid',
}
const PAY_METHODS = ['cash', 'bank_transfer', 'cheque'] as const

export interface Adjustment { id: string; kind: 'addition' | 'deduction'; label: string; amountCents: number; note: string | null }

// ─── The math ───────────────────────────────────────────────────────────────

type SlipInputs = Pick<Intern, 'startDate' | 'status' | 'endDate' | 'completedOn' | 'terminationEffectiveDate' | 'monthlyStipendCents'>

/** One intern's stipend for a month from their attendance rows (date + status) and HR's adjustments. */
export function computeStipend(intern: SlipInputs, period: string, attendance: Array<{ date: Date; status: string }>, adjustments: Adjustment[] = []) {
  const monthFrom = periodStart(period)
  const monthTo = new Date(periodStart(nextPeriod(period)).getTime() - DAY_MS)
  const daysInMonth = daysInPeriod(period)
  const last = lastDayOf(intern)
  const from = intern.startDate > monthFrom ? intern.startDate : monthFrom
  const to = last && last < monthTo ? last : monthTo
  const daysEngaged = to >= from ? Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1 : 0
  let absentDays = 0, halfDays = 0, unpaidLeaveDays = 0
  for (const a of attendance) {
    if (a.date < from || a.date > to) continue
    if (a.status === 'absent') absentDays += 1
    else if (a.status === 'half_day') halfDays += 1
    else if (a.status === 'leave') unpaidLeaveDays += 1
  }
  const paidDays = Math.max(0, daysEngaged - absentDays - halfDays * 0.5 - unpaidLeaveDays)
  const baseCents = Math.round((intern.monthlyStipendCents * paidDays) / daysInMonth)
  const additionsCents = adjustments.filter((a) => a.kind === 'addition').reduce((s, a) => s + a.amountCents, 0)
  const deductionsCents = adjustments.filter((a) => a.kind === 'deduction').reduce((s, a) => s + a.amountCents, 0)
  return {
    monthlyStipendCents: intern.monthlyStipendCents, daysInMonth, daysEngaged, absentDays, halfDays, unpaidLeaveDays, paidDays,
    baseCents, additionsCents, deductionsCents, netCents: baseCents + additionsCents - deductionsCents,
    breakdown: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), basis: 'stipend ÷ calendar days × paid days' },
  }
}

/** Paid interns enrolled (active / completed / terminated) whose internship overlaps the month. */
async function eligibleInterns(db: Db, tenantId: string, period: string): Promise<Intern[]> {
  const monthFrom = periodStart(period)
  const monthTo = new Date(periodStart(nextPeriod(period)).getTime() - DAY_MS)
  const rows = await db.intern.findMany({
    where: { tenantId, internshipType: 'paid', status: { in: ENROLLED }, startDate: { lte: monthTo } },
    orderBy: { internCode: 'asc' },
  })
  return rows.filter((i) => { const last = lastDayOf(i); return !last || last >= monthFrom })
}

const adjustmentsOf = (v: Prisma.JsonValue): Adjustment[] => (Array.isArray(v) ? (v as unknown as Adjustment[]) : [])

/** (Re)build a draft run's slips: eligible interns now, HR's adjustments kept. */
async function buildSlips(tx: Prisma.TransactionClient, run: InternPayrollRun): Promise<void> {
  const interns = await eligibleInterns(tx, run.tenantId, run.period)
  const old = await tx.internStipendSlip.findMany({ where: { runId: run.id } })
  const keep = new Map(old.map((s) => [s.internId, adjustmentsOf(s.adjustments)]))
  const monthFrom = periodStart(run.period)
  const monthTo = new Date(periodStart(nextPeriod(run.period)).getTime() - DAY_MS)
  const att = await tx.internAttendance.findMany({
    where: { internId: { in: interns.map((i) => i.id) }, date: { gte: monthFrom, lte: monthTo } },
    select: { internId: true, date: true, status: true },
  })
  await tx.internStipendSlip.deleteMany({ where: { runId: run.id } })
  for (const i of interns) {
    const c = computeStipend(i, run.period, att.filter((a) => a.internId === i.id), keep.get(i.id) ?? [])
    if (c.daysEngaged === 0) continue
    await tx.internStipendSlip.create({
      data: {
        tenantId: run.tenantId, runId: run.id, internId: i.id, ...c, breakdown: c.breakdown,
        adjustments: (keep.get(i.id) ?? []) as unknown as Prisma.InputJsonValue,
      },
    })
  }
  await refreshTotals(tx, run.id)
}

async function refreshTotals(tx: Db, runId: string): Promise<void> {
  const slips = await tx.internStipendSlip.findMany({ where: { runId }, select: { baseCents: true, additionsCents: true, deductionsCents: true, netCents: true } })
  const sum = (k: 'baseCents' | 'additionsCents' | 'deductionsCents' | 'netCents') => slips.reduce((s, x) => s + x[k], 0)
  const totals = { interns: slips.length, baseCents: sum('baseCents'), additionsCents: sum('additionsCents'), deductionsCents: sum('deductionsCents'), netCents: sum('netCents'), negativeSlips: slips.filter((s) => s.netCents < 0).length }
  const run = await tx.internPayrollRun.findUnique({ where: { id: runId }, select: { totals: true } })
  const prev = (run?.totals ?? {}) as Record<string, unknown>
  await tx.internPayrollRun.update({ where: { id: runId }, data: { totals: { ...prev, ...totals } as Prisma.InputJsonValue } })
}

/** Why a run cannot go on (null = it can). */
async function runBlocker(runId: string): Promise<string | null> {
  const slips = await prisma.internStipendSlip.findMany({ where: { runId }, select: { netCents: true } })
  if (slips.length === 0) return 'This stipend payroll has no paid interns for the month'
  if (slips.some((s) => s.netCents < 0)) return 'A stipend slip comes to less than zero — fix its deductions first'
  return null
}

// ─── The books ──────────────────────────────────────────────────────────────

const monthEndOf = (period: string) => new Date(periodStart(nextPeriod(period)).getTime() - DAY_MS)

/** Book the CEO-approved stipends (idempotent per run). Throws on a refusal. */
export async function postStipendAccrual(runId: string, o: RepostOptions & { tx?: Prisma.TransactionClient } = {}): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const db = o.tx ?? prisma
  const run = await db.internPayrollRun.findUnique({ where: { id: runId } })
  if (!run) return { posted: false, entryId: null, reason: 'run_not_found' }
  if (run.status !== 'approved' && run.status !== 'paid') return { posted: false, entryId: null, reason: 'run_not_approved' }
  const net = ((run.totals ?? {}) as Record<string, unknown>)['netCents']
  const amount = typeof net === 'number' ? net : 0
  if (amount <= 0) return { posted: false, entryId: null, reason: 'zero_amount' }
  const base = `Intern stipends ${run.period}`
  const { description, lines } = withLateNote(base, [
    { accountCode: STIPEND_EXPENSE_CODE, type: 'debit', amountCents: amount, memo: base },
    { accountCode: STIPENDS_PAYABLE_CODE, type: 'credit', amountCents: amount, memo: base },
  ] as JournalLineInput[], o.memoNote)
  const go = async (tx: Prisma.TransactionClient) => {
    await assertTemplateAccounts(tx, run.tenantId, [STIPEND_EXPENSE_CODE, STIPENDS_PAYABLE_CODE])
    const res = await postJournalEntry({
      tenantId: run.tenantId, sourceType: STIPEND_ACCRUAL, sourceId: run.id, description,
      entryDate: o.entryDate ?? monthEndOf(run.period), postedBy: o.postedBy ?? run.approvedById ?? 'system', lines,
    }, { tx })
    await tx.internPayrollRun.update({ where: { id: run.id }, data: { accrualEntryId: res.entryId } })
    return res
  }
  const res = o.tx ? await go(o.tx) : await prisma.$transaction(go)
  return { posted: res.posted, entryId: res.entryId }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const P = '/interns/payroll'
const zPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month as YYYY-MM')

async function runInScope(req: FastifyRequest, id: string): Promise<InternPayrollRun> {
  const run = await prisma.internPayrollRun.findFirst({ where: { id, tenantId: { in: memberTenants(req) } } })
  if (!run) throw new NotFoundError('Stipend payroll', id)
  return run
}

async function runView(run: InternPayrollRun) {
  const slips = await prisma.internStipendSlip.findMany({ where: { runId: run.id }, include: { intern: true }, orderBy: { intern: { internCode: 'asc' } } })
  const deptIds = [...new Set(slips.map((s) => s.intern.departmentId).filter((x): x is string => !!x))]
  const depts = new Map((await prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]))
  const userIds = [run.createdById, run.sentToFinanceById, run.financeCheckedById, run.approvedById, run.paidById, ...run.preparedByIds].filter((x): x is string => !!x)
  const names = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
  return {
    ...run, statusLabel: RUN_STATUS_LABEL[run.status] ?? run.status,
    people: Object.fromEntries(userIds.map((id) => [id, names.get(id) ?? null])),
    slips: slips.map(({ intern, ...s }) => ({
      ...s, intern: { id: intern.id, internCode: intern.internCode, fullName: intern.fullName, departmentId: intern.departmentId, department: intern.departmentId ? depts.get(intern.departmentId) ?? null : null, designation: intern.designation, status: intern.status },
    })),
  }
}

const notePreparers = (run: InternPayrollRun) => [...new Set([run.createdById, run.sentToFinanceById, ...run.preparedByIds].filter((x): x is string => !!x))]

async function slipPdfInputs(run: InternPayrollRun, slips: Array<InternStipendSlip & { intern: Intern }>): Promise<StipendSlipPdfInput[]> {
  const company = (await prisma.tenant.findUnique({ where: { id: run.tenantId }, select: { name: true } }))?.name ?? ''
  const deptIds = [...new Set(slips.map((s) => s.intern.departmentId).filter((x): x is string => !!x))]
  const depts = new Map((await prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]))
  return slips.map((s) => ({
    companyName: company, period: run.period, status: run.status, paid: run.status === 'paid',
    intern: { internCode: s.intern.internCode, fullName: s.intern.fullName, department: s.intern.departmentId ? depts.get(s.intern.departmentId) ?? null : null, designation: s.intern.designation, institution: s.intern.institution, startDate: s.intern.startDate, endDate: lastDayOf(s.intern), cnic: s.intern.cnic },
    slip: { ...s, adjustments: adjustmentsOf(s.adjustments) },
  }))
}

function sendPdf(reply: FastifyReply, buf: Buffer, name: string, download: boolean) {
  reply.header('Content-Type', 'application/pdf')
  reply.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`)
  return reply.send(buf)
}

/** Finance's review step: the role check, then the registry's separation of duties (never a preparer, the CEO excepted). */
async function financeDecision(req: FastifyRequest, id: string, action: string) {
  if (!(await isInternFinance(req))) throw new AppError('FINANCE_ONLY', 'Only finance (with the accounting module) or the CEO reviews the intern stipend payroll', 403)
  const run = await runInScope(req, id)
  const subj = await approvalSubject('intern_payroll_finance', id)
  if (!subj) throw new NotFoundError('Stipend payroll', id)
  if (run.status !== 'finance_review') throw new AppError('NOT_WITH_FINANCE', `This stipend payroll is ${RUN_STATUS_LABEL[run.status] ?? run.status}, not with finance`, 409)
  const grant = await assertCanApprove(req, approvalInputOf('intern_payroll_finance', id, subj, { entity: 'InternPayrollRun', action: `${action} an intern stipend payroll` }))
  return { run, grant }
}

async function ceoDecision(req: FastifyRequest, id: string, action: string) {
  const run = await runInScope(req, id)
  const subj = await approvalSubject('intern_payroll', id)
  if (!subj) throw new NotFoundError('Stipend payroll', id)
  const grant = await assertCanApprove(req, approvalInputOf('intern_payroll', id, subj, { entity: 'InternPayrollRun', action: `${action} an intern stipend payroll` }))
  return { run, grant }
}

const auditRun = (req: FastifyRequest, run: InternPayrollRun, action: string, after: Record<string, unknown>, category: 'identity' | 'accounting' = 'accounting') => audit({
  category, action: `hr.intern_payroll.${action}`, entity: 'InternPayrollRun', entityId: run.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null,
  tenantId: run.tenantId, after: { period: run.period, ...after }, metadata: { actorRole: req.staffUser!.role },
})

export async function internPayrollRoutes(fastify: FastifyInstance) {
  const staff = { preHandler: requireAuth(...ALL_STAFF) }

  // List: HR and finance. ?status=&period=
  fastify.get<{ Querystring: { status?: string; period?: string } }>(`${P}/runs`, staff, async (req) => {
    await assertPayrollReader(req)
    const rows = await prisma.internPayrollRun.findMany({
      where: { tenantId: { in: viewTenants(req) }, ...(req.query.status && { status: { in: req.query.status.split(',') } }), ...(req.query.period && { period: req.query.period }) },
      orderBy: [{ period: 'desc' }],
    })
    return { items: rows.map((r) => ({ ...r, statusLabel: RUN_STATUS_LABEL[r.status] ?? r.status })) }
  })

  fastify.post(`${P}/runs`, staff, async (req, reply) => {
    await assertInternHr(req)
    const { period } = z.object({ period: zPeriod }).strict().parse(req.body)
    if (period > periodOf(pktToday())) throw new AppError('FUTURE_PERIOD', 'A stipend payroll is for the current month or an earlier one', 422)
    const tenantId = createTenant(req)
    if (await prisma.internPayrollRun.findUnique({ where: { tenantId_period: { tenantId, period } }, select: { id: true } })) {
      throw new AppError('RUN_EXISTS', `There is already a stipend payroll for ${period} in this company`, 409)
    }
    const run = await prisma.$transaction(async (tx) => {
      const r = await tx.internPayrollRun.create({ data: { tenantId, period, createdById: req.staffUser!.id, preparedByIds: [req.staffUser!.id] } })
      await buildSlips(tx, r)
      return r
    }, { timeout: 60_000 })
    await auditRun(req, run, 'create', {}, 'identity')
    return reply.status(201).send(await runView((await prisma.internPayrollRun.findUnique({ where: { id: run.id } }))!))
  })

  fastify.get<{ Params: { id: string } }>(`${P}/runs/:id`, staff, async (req) => {
    await assertPayrollReader(req)
    return runView(await runInScope(req, req.params.id))
  })

  fastify.post<{ Params: { id: string } }>(`${P}/runs/:id/recalculate`, staff, async (req) => {
    await assertInternHr(req)
    const run = await runInScope(req, req.params.id)
    if (run.status !== 'draft') throw new AppError('RUN_NOT_DRAFT', 'Only a draft stipend payroll can be recalculated', 409)
    await prisma.$transaction(async (tx) => {
      const n = await tx.internPayrollRun.updateMany({ where: { id: run.id, status: 'draft' }, data: { preparedByIds: [...new Set([...run.preparedByIds, req.staffUser!.id])] } })
      if (n.count === 0) throw new AppError('RUN_NOT_DRAFT', 'Only a draft stipend payroll can be recalculated', 409)
      await buildSlips(tx, run)
    }, { timeout: 60_000 })
    await auditRun(req, run, 'recalculate', {}, 'identity')
    return runView((await prisma.internPayrollRun.findUnique({ where: { id: run.id } }))!)
  })

  // HR's additional payments / deductions on one slip (replaces the list), draft only.
  fastify.put<{ Params: { id: string } }>(`${P}/slips/:id/adjustments`, staff, async (req) => {
    await assertInternHr(req)
    const body = z.object({
      items: z.array(z.object({
        id: z.string().max(64).optional(), kind: z.enum(['addition', 'deduction']), label: z.string().trim().min(2).max(80),
        amountCents: z.number().int().min(1).max(INT4_MAX_CENTS), note: z.string().trim().max(300).nullish(),
      })).max(20),
    }).strict().parse(req.body)
    const slip = await prisma.internStipendSlip.findFirst({ where: { id: req.params.id, tenantId: { in: memberTenants(req) } }, include: { run: true, intern: true } })
    if (!slip) throw new NotFoundError('Stipend slip', req.params.id)
    if (slip.run.status !== 'draft') throw new AppError('RUN_NOT_DRAFT', 'Adjustments change only while the stipend payroll is a draft', 409)
    const items: Adjustment[] = body.items.map((a) => ({ id: a.id ?? randomUUID(), kind: a.kind, label: a.label, amountCents: a.amountCents, note: a.note ?? null }))
    const before = adjustmentsOf(slip.adjustments)
    await prisma.$transaction(async (tx) => {
      const n = await tx.internPayrollRun.updateMany({ where: { id: slip.runId, status: 'draft' }, data: { preparedByIds: [...new Set([...slip.run.preparedByIds, req.staffUser!.id])] } })
      if (n.count === 0) throw new AppError('RUN_NOT_DRAFT', 'Adjustments change only while the stipend payroll is a draft', 409)
      const att = await tx.internAttendance.findMany({ where: { internId: slip.internId, date: { gte: periodStart(slip.run.period), lte: monthEndOf(slip.run.period) } }, select: { date: true, status: true } })
      const c = computeStipend(slip.intern, slip.run.period, att, items)
      await tx.internStipendSlip.update({ where: { id: slip.id }, data: { ...c, breakdown: c.breakdown, adjustments: items as unknown as Prisma.InputJsonValue } })
      await refreshTotals(tx, slip.runId)
    })
    await audit({
      category: 'accounting', action: 'hr.intern_payroll.adjustments_set', entity: 'InternStipendSlip', entityId: slip.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null,
      tenantId: slip.tenantId, before: { adjustments: before }, after: { adjustments: items, runId: slip.runId, period: slip.run.period, internId: slip.internId }, metadata: { actorRole: req.staffUser!.role },
    })
    return prisma.internStipendSlip.findUnique({ where: { id: slip.id } })
  })

  fastify.post<{ Params: { id: string } }>(`${P}/runs/:id/send-to-finance`, staff, async (req) => {
    await assertInternHr(req)
    const run = await runInScope(req, req.params.id)
    if (run.status !== 'draft') throw new AppError('RUN_NOT_DRAFT', 'Only a draft stipend payroll can be sent to finance', 409)
    const blocker = await runBlocker(run.id)
    if (blocker) throw new AppError('RUN_INCOMPLETE', blocker, 409)
    const at = new Date()
    const n = await prisma.internPayrollRun.updateMany({
      where: { id: run.id, status: 'draft' },
      data: { status: 'finance_review', sentToFinanceById: req.staffUser!.id, sentToFinanceAt: at, financeCheckedById: null, financeCheckedAt: null, financeNote: null, ceoReturnNote: null, ceoReturnedById: null, ceoReturnedAt: null },
    })
    if (n.count === 0) throw new AppError('RUN_NOT_DRAFT', 'Only a draft stipend payroll can be sent to finance', 409)
    await auditRun(req, run, 'send_to_finance', { totals: run.totals }, 'identity')
    approvalWaiting('intern_payroll_finance', run.id, { round: `send:${at.toISOString()}`, actorId: req.staffUser!.id })
    return prisma.internPayrollRun.findUnique({ where: { id: run.id } })
  })

  fastify.post<{ Params: { id: string } }>(`${P}/runs/:id/finance-pass`, staff, async (req) => {
    const { note } = z.object({ note: z.string().trim().max(1000).optional() }).parse(req.body ?? {})
    const { run, grant } = await financeDecision(req, req.params.id, 'pass')
    const at = new Date()
    const n = await prisma.internPayrollRun.updateMany({
      where: { id: run.id, status: 'finance_review' },
      data: { status: 'finance_checked', financeCheckedById: req.staffUser!.id, financeCheckedAt: at, financeNote: note || null, ceoReturnNote: null, ceoReturnedById: null, ceoReturnedAt: null },
    })
    if (n.count === 0) throw new AppError('NOT_WITH_FINANCE', 'This stipend payroll is no longer with finance', 409)
    await auditRun(req, run, 'finance_pass', { note: note || null })
    await auditApproval(req, { type: 'intern_payroll_finance', id: run.id, tenantId: run.tenantId, decision: 'approve', grant, entity: 'InternPayrollRun', metadata: { period: run.period, decidedAt: at.toISOString(), final: false, ...(note && { note }) } })
    approvalWaiting('intern_payroll', run.id, { round: `finance:${at.toISOString()}`, actorId: req.staffUser!.id })
    return prisma.internPayrollRun.findUnique({ where: { id: run.id } })
  })

  // Pull back (owner, 2026-11-07): finance takes a run it passed (finance_checked) back to its own review step before the
  // CEO decides; it leaves the CEO's inbox.
  fastify.post<{ Params: { id: string } }>(`${P}/runs/:id/pull-back`, staff, async (req) => {
    if (!(await isInternFinance(req))) throw new AppError('FINANCE_ONLY', 'Only finance (with the accounting module) or the CEO pulls a stipend payroll back', 403)
    const run = await runInScope(req, req.params.id)
    if (run.status !== 'finance_checked') throw new AppError('NOT_FINANCE_CHECKED', 'Only a stipend payroll waiting for the CEO can be pulled back', 409)
    const n = await prisma.internPayrollRun.updateMany({ where: { id: run.id, status: 'finance_checked' }, data: { status: 'finance_review', financeCheckedById: null, financeCheckedAt: null } })
    if (n.count === 0) throw new AppError('NOT_FINANCE_CHECKED', 'This stipend payroll is no longer waiting for the CEO — reload it', 409)
    await auditRun(req, run, 'pull_back', { from: 'finance_checked', to: 'finance_review' })
    return prisma.internPayrollRun.findUnique({ where: { id: run.id } })
  })

  fastify.post<{ Params: { id: string } }>(`${P}/runs/:id/finance-return`, staff, async (req) => {
    const { note } = z.object({ note: z.string().trim().max(1000).optional() }).parse(req.body ?? {})
    if (!note || note.length < 10) throw new AppError('NOTE_TOO_SHORT', 'Say what HR needs to correct (at least 10 characters)', 422)
    const { run, grant } = await financeDecision(req, req.params.id, 'return')
    const at = new Date()
    const n = await prisma.internPayrollRun.updateMany({
      where: { id: run.id, status: 'finance_review' },
      data: { status: 'draft', financeReturnNote: note, financeReturnedById: req.staffUser!.id, financeReturnedAt: at, financeCheckedById: null, financeCheckedAt: null, financeNote: null, sentToFinanceById: null, sentToFinanceAt: null },
    })
    if (n.count === 0) throw new AppError('NOT_WITH_FINANCE', 'This stipend payroll is no longer with finance', 409)
    await auditRun(req, run, 'finance_return', { note })
    await auditApproval(req, { type: 'intern_payroll_finance', id: run.id, tenantId: run.tenantId, decision: 'return', grant, entity: 'InternPayrollRun', metadata: { period: run.period, decidedAt: at.toISOString(), note, waitingUserIds: notePreparers(run) } })
    return prisma.internPayrollRun.findUnique({ where: { id: run.id } })
  })

  // The CEO approves: the run is approved, then the stipends are booked (Dr 6038 / Cr 2025). A refused posting
  // leaves the approval standing, flagged for Backfill unposted; the payment books it first if still missing.
  fastify.post<{ Params: { id: string } }>(`${P}/runs/:id/approve`, staff, async (req) => {
    const { run, grant } = await ceoDecision(req, req.params.id, 'approve')
    if (run.status !== 'finance_checked') {
      throw new AppError('NOT_FINANCE_CHECKED', run.status === 'draft' || run.status === 'finance_review'
        ? 'Finance checks this stipend payroll before the CEO approves it'
        : 'This stipend payroll is not waiting for approval', 409)
    }
    const blocker = await runBlocker(run.id)
    if (blocker) throw new AppError('RUN_INCOMPLETE', blocker, 409)
    const at = new Date()
    const n = await prisma.internPayrollRun.updateMany({ where: { id: run.id, status: 'finance_checked' }, data: { status: 'approved', approvedById: req.staffUser!.id, approvedAt: at } })
    if (n.count === 0) throw new AppError('NOT_FINANCE_CHECKED', 'This stipend payroll is no longer waiting for approval', 409)
    await auditRun(req, run, 'approve', { totals: run.totals })
    await auditApproval(req, { type: 'intern_payroll', id: run.id, tenantId: run.tenantId, decision: 'approve', grant, entity: 'InternPayrollRun', metadata: { period: run.period, decidedAt: at.toISOString() } })
    let accrual: { posted: boolean; entryId: string | null; reason?: string }
    try {
      accrual = await postStipendAccrual(run.id, { postedBy: req.staffUser!.id })
    } catch (err) {
      const reason = (err as Error).message
      accrual = { posted: false, entryId: null, reason }
      await flagPostingFailed({
        tenantId: run.tenantId, sourceType: STIPEND_ACCRUAL, sourceId: run.id, entityType: 'InternPayrollRun', entityId: run.id,
        reason, title: `Intern stipends ${run.period} did not reach the ledger`, actorId: req.staffUser!.id,
        amountCents: Number(((run.totals ?? {}) as Record<string, unknown>)['netCents'] ?? 0) || null,
        metadata: { documentDate: monthEndOf(run.period).toISOString(), period: run.period },
      })
    }
    return { ...(await prisma.internPayrollRun.findUnique({ where: { id: run.id } })), accrual }
  })

  // The CEO returns it for correction: to finance (with finance again) or to HR (a draft). Note ≥10.
  fastify.post<{ Params: { id: string } }>(`${P}/runs/:id/return`, staff, async (req) => {
    const body = z.object({ note: z.string().trim().max(1000).optional(), to: z.enum(['hr', 'finance']).default('hr') }).parse(req.body ?? {})
    const note = body.note ?? ''
    if (note.length < 10) throw new AppError('NOTE_TOO_SHORT', 'Say what needs correcting (at least 10 characters)', 422)
    const { run, grant } = await ceoDecision(req, req.params.id, 'return')
    if (run.status !== 'finance_checked') throw new AppError('NOT_FINANCE_CHECKED', 'Only a stipend payroll waiting for approval can be returned', 409)
    const at = new Date()
    const back = { ceoReturnNote: note, ceoReturnedById: req.staffUser!.id, ceoReturnedAt: at, financeCheckedById: null, financeCheckedAt: null, financeNote: null }
    const n = await prisma.internPayrollRun.updateMany({
      where: { id: run.id, status: 'finance_checked' },
      data: body.to === 'finance' ? { status: 'finance_review', ...back } : { status: 'draft', ...back, sentToFinanceById: null, sentToFinanceAt: null },
    })
    if (n.count === 0) throw new AppError('NOT_FINANCE_CHECKED', 'This stipend payroll is no longer waiting for approval', 409)
    await auditRun(req, run, 'return', { note, to: body.to })
    await auditApproval(req, {
      type: 'intern_payroll', id: run.id, tenantId: run.tenantId, decision: 'return', grant, entity: 'InternPayrollRun',
      metadata: { period: run.period, decidedAt: at.toISOString(), note, to: body.to, waitingUserIds: body.to === 'finance' ? [run.financeCheckedById].filter((x): x is string => !!x) : notePreparers(run) },
    })
    return prisma.internPayrollRun.findUnique({ where: { id: run.id } })
  })

  // Finance pays (cash / bank transfer / cheque): Dr 2025 / Cr the money account of the run's company.
  fastify.post<{ Params: { id: string } }>(`${P}/runs/:id/paid`, staff, async (req) => {
    if (!(await isInternFinance(req))) throw new AppError('FINANCE_ONLY', 'Only finance (with the accounting module) or the CEO pays the intern stipends', 403)
    const body = z.object({
      method: z.enum(PAY_METHODS), bankAccountId: z.string().min(1).max(64).nullish(),
      reference: z.string().trim().max(100).nullish(), paidOn: z.string().regex(YMD).optional(),
    }).passthrough().parse(req.body ?? {})
    const classification = classificationOf(req.body)
    const run = await runInScope(req, req.params.id)
    if (run.status !== 'approved') throw new AppError('NOT_PAYABLE', run.status === 'paid' ? 'This stipend payroll is already paid' : 'Only an approved stipend payroll can be paid', 409)
    if (body.method !== 'cash' && !body.reference) throw new AppError('PAYMENT_REFERENCE_REQUIRED', 'Give the bank transfer or cheque reference', 422)
    if (body.method === 'cash' && body.bankAccountId) throw new AppError('BANK_ACCOUNT_ON_CASH', 'A cash payment does not use a bank account', 422)
    const paidOn = body.paidOn ? parseYmd(body.paidOn, 'payment date') : pktToday()
    if (paidOn > pktToday()) throw new AppError('PAID_ON_FUTURE', 'The payment date cannot be in the future', 422)
    // Nobody pays a run carrying their own stipend.
    if (await prisma.internStipendSlip.count({ where: { runId: run.id, intern: { userId: req.staffUser!.id } } })) {
      throw new AppError('OWN_PAY_IN_RUN', 'Your own stipend is on this payroll — someone else marks it paid', 403)
    }
    let accrualPostedNow = false
    const paid = await prisma.$transaction(async (tx) => {
      const n = await tx.internPayrollRun.updateMany({ where: { id: run.id, status: 'approved', paidAt: null }, data: { status: 'paid', paidAt: new Date(), paidOn, paidById: req.staffUser!.id, paymentMethod: body.method, paymentReference: body.reference ?? null } })
      if (n.count === 0) throw new AppError('NOT_PAYABLE', 'Only an approved stipend payroll that has not been paid can be paid', 409)
      // The accrual first (an approval whose posting was refused): the payment always clears a real liability.
      const accrualBefore = await tx.journalEntry.findFirst({ where: { tenantId: run.tenantId, reference: `${STIPEND_ACCRUAL}:${run.id}` }, select: { id: true } })
      if (!accrualBefore) { const r = await postStipendAccrual(run.id, { tx, postedBy: req.staffUser!.id }); accrualPostedNow = r.posted }
      const accrual = await tx.journalEntry.findFirst({
        where: { tenantId: run.tenantId, reference: `${STIPEND_ACCRUAL}:${run.id}` },
        select: { id: true, lines: { select: { type: true, amountCents: true, account: { select: { code: true } } } } },
      })
      const net = accrual ? accrual.lines.filter((l) => l.account.code === STIPENDS_PAYABLE_CODE && l.type === 'credit').reduce((s, l) => s + Number(l.amountCents), 0) : 0
      const money = await moneyAccountCode(tx, run.tenantId, { method: body.method, bankAccountId: body.bankAccountId ?? null })
      let entryId: string | null = null
      if (net > 0) {
        const memo = `Intern stipends ${run.period} paid${body.reference ? ` — ref ${body.reference}` : ''}`
        const res = await postJournalEntry({
          tenantId: run.tenantId, sourceType: STIPEND_PAYMENT, sourceId: run.id, description: memo, entryDate: paidOn, postedBy: req.staffUser!.id,
          lines: [
            { accountCode: STIPENDS_PAYABLE_CODE, type: 'debit', amountCents: net, memo },
            { accountCode: money.code, type: 'credit', amountCents: net, memo },
          ],
        }, { tx })
        entryId = res.entryId
        await classifyPaymentTx(tx, { journalEntryId: entryId, input: classification, setById: req.staffUser!.id, tenantId: run.tenantId })
      }
      return tx.internPayrollRun.update({ where: { id: run.id }, data: { paymentEntryId: entryId, paymentBankAccountId: money.bankAccountId } })
    }, { timeout: 60_000 })
    if (accrualPostedNow) await resolvePostingFailed('InternPayrollRun', run.id, STIPEND_ACCRUAL, 'Booked when the stipends were paid')
    await auditRun(req, run, 'paid', { method: body.method, reference: body.reference ?? null, paidOn: paidOn.toISOString().slice(0, 10), paymentEntryId: paid.paymentEntryId })
    return paid
  })

  // The stipend sheet: ?format=csv|xlsx|pdf (JSON without).
  fastify.get<{ Params: { id: string }; Querystring: { format?: string } }>(`${P}/runs/:id/sheet`, staff, async (req, reply) => {
    await assertPayrollReader(req)
    const v = await runView(await runInScope(req, req.params.id))
    const rows: ReportRow[] = v.slips.map((s) => ({
      code: s.intern.internCode, name: s.intern.fullName, department: s.intern.department ?? '', designation: s.intern.designation ?? '',
      stipend: s.monthlyStipendCents, days_in_month: s.daysInMonth, days_engaged: s.daysEngaged, absent: s.absentDays, half_days: s.halfDays,
      leave: s.unpaidLeaveDays, paid_days: s.paidDays, base: s.baseCents, additions: s.additionsCents, deductions: s.deductionsCents, net: s.netCents,
    }))
    rows.push({ code: 'TOTAL', name: '', department: '', designation: '', stipend: null, days_in_month: null, days_engaged: null, absent: null, half_days: null, leave: null, paid_days: null, base: v.slips.reduce((a, s) => a + s.baseCents, 0), additions: v.slips.reduce((a, s) => a + s.additionsCents, 0), deductions: v.slips.reduce((a, s) => a + s.deductionsCents, 0), net: v.slips.reduce((a, s) => a + s.netCents, 0) })
    const format = exportFormatOf(req.query.format)
    const table = {
      title: `Intern stipend sheet — ${v.period}`, period: `${v.period} · ${v.statusLabel}`, rows,
      types: { stipend: 'cents', base: 'cents', additions: 'cents', deductions: 'cents', net: 'cents', days_in_month: 'number', days_engaged: 'number', absent: 'number', half_days: 'number', leave: 'number', paid_days: 'number' } as const,
      labels: { code: 'Intern ID', name: 'Name', department: 'Department', designation: 'Position', stipend: 'Monthly stipend', days_in_month: 'Days in month', days_engaged: 'Days engaged', absent: 'Absent', half_days: 'Half days', leave: 'Leave', paid_days: 'Paid days', base: 'Prorated stipend', additions: 'Additions', deductions: 'Deductions', net: 'Net payable' },
      isTotal: (r: ReportRow) => r['code'] === 'TOTAL',
    }
    if (!format) return { ...table, isTotal: undefined, run: { id: v.id, period: v.period, status: v.status } }
    return sendReportFor(req, reply, format, { base: 'intern-stipend-sheet', suffix: v.period }, table)
  })

  // Stipend slip PDF: one, or every slip of a run. ?download=1 = attachment.
  fastify.get<{ Params: { id: string }; Querystring: { download?: string } }>(`${P}/slips/:id/pdf`, staff, async (req, reply) => {
    await assertPayrollReader(req)
    const slip = await prisma.internStipendSlip.findFirst({ where: { id: req.params.id, tenantId: { in: memberTenants(req) } }, include: { intern: true, run: true } })
    if (!slip) throw new NotFoundError('Stipend slip', req.params.id)
    const [input] = await slipPdfInputs(slip.run, [slip])
    return sendPdf(reply, await stipendSlipsPdf([input!]), `stipend-slip-${slip.intern.internCode}-${slip.run.period}.pdf`, req.query.download === '1')
  })
  fastify.get<{ Params: { id: string }; Querystring: { download?: string } }>(`${P}/runs/:id/slips.pdf`, staff, async (req, reply) => {
    await assertPayrollReader(req)
    const run = await runInScope(req, req.params.id)
    const slips = await prisma.internStipendSlip.findMany({ where: { runId: run.id }, include: { intern: true }, orderBy: { intern: { internCode: 'asc' } } })
    return sendPdf(reply, await stipendSlipsPdf(await slipPdfInputs(run, slips)), `stipend-slips-${run.period}.pdf`, req.query.download === '1')
  })
}

/** Is this intern on a stipend payroll of the month that has left draft? (Attendance is then locked.) */
export async function attendanceLocked(db: Db, intern: Pick<Intern, 'id' | 'tenantId'>, day: Date): Promise<boolean> {
  const period = periodOf(day)
  const n = await db.internStipendSlip.count({ where: { internId: intern.id, run: { tenantId: intern.tenantId, period, status: { not: 'draft' } } } })
  return n > 0
}

