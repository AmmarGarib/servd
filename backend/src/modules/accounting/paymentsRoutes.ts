// /accounting/payments — Payments register and the internal payment
// classification (owner, 2026-10-20). Under the '/accounting' module gate.
// A REPORTING DIMENSION only: nothing here posts, and no ledger, tax or
// statutory report reads the classification (paymentsRegister.ts).
//
//   GET /                      PAYMENT_READERS (CEO, owner, management, finance), resolveTenantScope:
//                              ?classification=official|unofficial|unclassified|all
//                              &from&to (YYYY-MM-DD PKT, default this month)
//                              &category&method&q[&format=csv|xlsx|pdf]. Rows, totals per
//                              classification (of the period, after category /
//                              method / q) and the tie-out of ALL the period's
//                              payments to the ledger.
//   GET /payments.csv          the same as CSV (?format=xlsx|pdf for Excel / PDF; lib/reportExport.ts).
//   GET /:journalEntryId       one payment + its classification history (read scope; foreign 404).
//   PUT /:journalEntryId/classification
//                              CEO, or finance with 'accounting' (403 otherwise):
//                              { classification, taxStatus?, nonDeductionReason?, reason? }.
//                              Another company's entry 404; not a payment 422
//                              NOT_A_PAYMENT; changing an existing value needs a
//                              reason ≥10 (422 REASON_REQUIRED); conditional update
//                              (409 CLASSIFICATION_CHANGED). Audit 'payment.classification'.
//   POST /classify             same people and rules, in bulk (owner, 2026-10-20: older payments start
//                              Unclassified): { journalEntryIds (1–200), classification, taxStatus?,
//                              nonDeductionReason?, reason ≥10 }. All or nothing, one transaction:
//                              any foreign id → 404, any non-payment → 422 NOT_A_PAYMENT. One audit
//                              row per changed entry ('payment.classification', bulk: true).
//
// Supporting documents for the tax status: record files, owner type
// 'payment' (ownerId = the journal entry id; recordFiles/providers.ts).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { audit } from '../../lib/audit.js'
import { requireAuth } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay } from './dates.js'
import { fmtPkr } from './csv.js'
import { exportFormatOf, sendReportFor, type ExportFormat } from '../../lib/reportExport.js'
import { NotFoundError } from '../../lib/errors.js'
import {
  PAYMENT_CATEGORIES, PAYMENT_CLASSIFICATIONS, TAX_STATUSES, PAYMENT_METHOD_LABELS,
  paymentRows, filterRows, totalsByClassification, paymentsSummary, ledgerPaymentsTieOut, setPaymentClassification, classifyPaymentsBulk,
  type PaymentCategory, type PaymentMethodKind, type PaymentRow,
} from './paymentsRegister.js'

/** Who reads the register (never director — DIRECTOR_ROUTES refuses it anyway). */
export const PAYMENT_READERS = ['admin', 'owner', 'management', 'finance'] as UserRole[]
/** Who changes a classification afterwards: the CEO, or finance with 'accounting'. */
export const PAYMENT_CLASSIFIERS = ['admin', 'finance'] as UserRole[]

const listQuery = z.object({
  classification: z.enum([...PAYMENT_CLASSIFICATIONS, 'all']).default('all'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category: z.enum(Object.keys(PAYMENT_CATEGORIES) as [PaymentCategory, ...PaymentCategory[]]).optional(),
  method: z.enum(Object.keys(PAYMENT_METHOD_LABELS) as [PaymentMethodKind, ...PaymentMethodKind[]]).optional(),
  q: z.string().max(100).optional(),
  /** Export only: 'summary' = the classification × method grid instead of the payment lines. */
  view: z.enum(['register', 'summary']).optional(),
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).optional(),
})

const CLASS_LABEL: Record<string, string> = { official: 'Official', unofficial: 'Unofficial', unclassified: 'Unclassified' }
const TAX_LABEL: Record<string, string> = { deducted: 'Deducted', not_deducted: 'Not deducted', not_applicable: 'Not applicable' }

function periodOf(q: { from?: string; to?: string }): { from: Date; to: Date; fromStr: string; toStr: string } {
  const today = fmtPktDate(new Date())
  const fromStr = q.from ?? `${today.slice(0, 7)}-01`
  const toStr = q.to ?? today
  return { from: parsePktStartOfDay(fromStr), to: parsePktEndOfDay(toStr), fromStr, toStr }
}

async function companyNames(tenantIds: string[]): Promise<Map<string, string>> {
  const ts = await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
  return new Map(ts.map((t) => [t.id, t.name]))
}

async function register(req: FastifyRequest) {
  const q = listQuery.parse(req.query)
  const scope = await resolveTenantScope(req)
  const p = periodOf(q)
  const all = await paymentRows(prisma, scope.tenantIds, p.from, p.to)
  const narrowed = filterRows(all, { category: q.category, method: q.method, q: q.q })
  const rows = filterRows(narrowed, { classification: q.classification })
  const totalAll = all.reduce((s, r) => s + r.netCents, 0)
  const tieOut = await ledgerPaymentsTieOut(prisma, scope.tenantIds, p.from, p.to, totalAll)
  const names = await companyNames([...new Set(all.map((r) => r.tenantId))])
  return {
    query: q, from: p.fromStr, to: p.toStr,
    multiCompany: scope.tenantIds.length > 1,
    rows: rows.map((r) => ({ ...r, companyName: names.get(r.tenantId) ?? null })),
    totals: totalsByClassification(narrowed),
    // The grid: the period's payments narrowed by category and search only (it is itself the split by method and class).
    summary: paymentsSummary(filterRows(all, { category: q.category, q: q.q })),
    tieOut,
    categories: PAYMENT_CATEGORIES,
    methods: PAYMENT_METHOD_LABELS,
    note: 'Classification is an internal reporting label. It changes no posting, account, trial balance, tax return or statutory report.',
  }
}

/** Owner, 2026-10-20: the register export is Date · Voucher no. · Narration · Payment method · Total amount · Classification. */
const CLASS_SHORT: Record<string, string> = { official: 'O', unofficial: 'U', unclassified: 'UC' }
function recordsOf(rows: Array<PaymentRow & { companyName: string | null }>, multi: boolean) {
  const out: Array<Record<string, string>> = rows.map((r) => ({
    ...(multi && { company: r.companyName ?? '' }),
    date: fmtPktDate(new Date(r.entryDate)),
    voucher_no: r.voucherNo ?? r.voucherNumber,
    narration: r.narration,
    payment_method: r.methodLabel,
    total_amount: fmtPkr(r.netCents),
    classification: CLASS_SHORT[r.classification] ?? r.classification,
  }))
  if (out.length) {
    out.push({
      ...(multi && { company: '' }), date: '', voucher_no: '', narration: 'TOTAL', payment_method: '',
      total_amount: fmtPkr(rows.reduce((s, r) => s + r.netCents, 0)), classification: '',
    })
  }
  return out
}

function sendRegister(req: FastifyRequest, reply: FastifyReply, format: ExportFormat, out: Awaited<ReturnType<typeof register>>) {
  if (out.query.view === 'summary') {
    const { methods, rows } = out.summary
    return sendReportFor(req, reply, format, { base: 'payments-summary', suffix: `${out.from}-to-${out.to}` }, {
      title: 'Payments summary — by classification and method',
      period: `${out.from} to ${out.to}${out.query.category ? ` · ${PAYMENT_CATEGORIES[out.query.category]}` : ''}`,
      rows: rows.map((r) => ({
        classification: r.classification === 'all' ? 'TOTAL' : CLASS_LABEL[r.classification]!,
        ...Object.fromEntries(methods.map((m) => [m.key, fmtPkr(r.cells[m.key]!.netCents)])),
        total: fmtPkr(r.total.netCents),
        payments: r.total.count,
      })),
      types: { ...Object.fromEntries(methods.map((m) => [m.key, 'pkr' as const])), total: 'pkr', payments: 'number' },
      labels: { ...Object.fromEntries(methods.map((m) => [m.key, m.label])), total: 'Total', payments: 'Payments' },
      isTotal: (r) => r['classification'] === 'TOTAL',
      notes: ['Net amounts paid (after tax withheld).', out.note],
    })
  }
  return sendReportFor(req, reply, format, { base: 'payments', suffix: `${out.query.classification}-${out.from}-to-${out.to}` }, {
    title: `Payments register${out.query.classification === 'all' ? '' : ` — ${CLASS_LABEL[out.query.classification]}`}`,
    period: `${out.from} to ${out.to}`,
    rows: recordsOf(out.rows, out.multiCompany),
    types: { total_amount: 'pkr' },
    labels: { voucher_no: 'Voucher no.', payment_method: 'Payment method', total_amount: 'Total amount', classification: 'Class' },
    notes: ['Class: O = Official, U = Unofficial, UC = Unclassified. Total amount = the amount paid (after tax withheld).', out.note],
  })
}

export async function paymentsRoutes(fastify: FastifyInstance) {
  const readGate = { preHandler: requireAuth(...PAYMENT_READERS) }

  fastify.get('/', readGate, async (req, reply) => {
    const out = await register(req)
    const format = exportFormatOf(out.query.format)
    if (format) return sendRegister(req, reply, format, out)
    return out
  })

  fastify.get('/payments.csv', readGate, async (req, reply) => {
    const out = await register(req)
    return sendRegister(req, reply, exportFormatOf(out.query.format, 'csv')!, out)
  })

  fastify.get<{ Params: { journalEntryId: string } }>('/:journalEntryId', readGate, async (req) => {
    const where = await scopeTenantWhere(req, 'read')
    const entry = await prisma.journalEntry.findFirst({
      where: { id: req.params.journalEntryId, ...where },
      select: { id: true, tenantId: true, entryDate: true },
    })
    if (!entry?.tenantId) throw new NotFoundError('Payment', req.params.journalEntryId)
    const [row] = await paymentRows(prisma, [entry.tenantId], entry.entryDate, entry.entryDate, { entryId: entry.id })
    if (!row) throw new NotFoundError('Payment', req.params.journalEntryId)
    const history = await prisma.auditLog.findMany({
      where: { action: 'payment.classification', entityId: entry.id, tenantId: entry.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, createdAt: true, userEmail: true, before: true, after: true, metadata: true },
    })
    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entry.id },
      select: { type: true, amountCents: true, memo: true, account: { select: { code: true, name: true } } },
    })
    return { payment: row, lines, history }
  })

  fastify.post(
    '/classify',
    { preHandler: [requireAuth(...PAYMENT_CLASSIFIERS), requireModule('accounting')] },
    async (req) => {
      const body = z.object({
        journalEntryIds: z.array(z.string().min(1).max(64)).min(1).max(200),
        classification: z.enum(PAYMENT_CLASSIFICATIONS),
        taxStatus: z.enum(TAX_STATUSES).nullish(),
        nonDeductionReason: z.string().trim().max(500).nullish(),
        reason: z.string().trim().max(500),
      }).parse(req.body)
      const where = await scopeTenantWhere(req, 'write')
      const tenantIds = typeof where.tenantId === 'string' ? [where.tenantId] : where.tenantId.in
      const su = req.staffUser!
      const results = await classifyPaymentsBulk({
        tenantIds,
        journalEntryIds: body.journalEntryIds,
        input: { classification: body.classification, taxStatus: body.taxStatus ?? null, nonDeductionReason: body.nonDeductionReason ?? null },
        reason: body.reason,
        userId: su.id,
      })
      for (const r of results.filter((x) => x.changed)) {
        await audit({
          category: 'accounting',
          tenantId: r.tenantId,
          action: 'payment.classification',
          entity: 'journal_entry',
          entityId: r.journalEntryId,
          userId: su.id,
          userEmail: su.email,
          before: r.before ?? { classification: 'unclassified', taxStatus: null, nonDeductionReason: null },
          after: r.after,
          metadata: { actorRole: su.role, reason: body.reason, bulk: true, count: results.length, actingTenantId: su.tenantId ?? null },
        })
      }
      return {
        classification: body.classification,
        changed: results.filter((r) => r.changed).length,
        unchanged: results.filter((r) => !r.changed).length,
        journalEntryIds: results.map((r) => r.journalEntryId),
      }
    },
  )

  fastify.put<{ Params: { journalEntryId: string } }>(
    '/:journalEntryId/classification',
    { preHandler: [requireAuth(...PAYMENT_CLASSIFIERS), requireModule('accounting')] },
    async (req) => {
      const body = z.object({
        classification: z.enum(PAYMENT_CLASSIFICATIONS),
        taxStatus: z.enum(TAX_STATUSES).nullish(),
        nonDeductionReason: z.string().trim().max(500).nullish(),
        reason: z.string().trim().max(500).nullish(),
      }).parse(req.body)
      const where = await scopeTenantWhere(req, 'write')
      const tenantIds = typeof where.tenantId === 'string' ? [where.tenantId] : where.tenantId.in
      const su = req.staffUser!
      const res = await setPaymentClassification({
        tenantIds,
        journalEntryId: req.params.journalEntryId,
        input: { classification: body.classification, taxStatus: body.taxStatus ?? null, nonDeductionReason: body.nonDeductionReason ?? null },
        reason: body.reason ?? null,
        userId: su.id,
      })
      await audit({
        category: 'accounting',
        tenantId: res.tenantId,
        action: 'payment.classification',
        entity: 'journal_entry',
        entityId: req.params.journalEntryId,
        userId: su.id,
        userEmail: su.email,
        before: res.before ?? { classification: 'unclassified', taxStatus: null, nonDeductionReason: null },
        after: res.after,
        metadata: { actorRole: su.role, reason: body.reason ?? null, actingTenantId: su.tenantId ?? null },
      })
      return { journalEntryId: req.params.journalEntryId, ...res.after }
    },
  )
}
