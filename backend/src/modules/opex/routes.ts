// OpEx tracker â€” recurring operational expense management.
// Categories (Rent, Payroll, Utilities, etc.) â†’ Lines (specific vendors /
// items) â†’ Payments (per-period actuals). Variance vs budget fires flags.
//
// Special: the Payroll category pulls live from HR payroll runs
// rather than manual entry â€” that's wired in the GET /opex endpoint.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, FINANCE_TEAM } from '../auth/middleware.js'
import { flagException } from '../../lib/exceptions.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, resolveTenantScope } from '../../lib/tenantScope.js'
import { assertConceptOfCompany, assertCapexProjectOfCompany, assertBankAccountOfCompany } from '../financePlanning/companyRefs.js'
import { syncOpexPaymentPosting, OPEX_SOURCE } from './posting.js'
import { assertCategoryAccount, suggestedCategoryAccount } from './categoryAccounts.js'
import { liveRevisionsFor } from '../accounting/sourcePosting.js'
import { isPayrollCategory, expenseCodeForCategoryName } from '../accounting/expenseCategories.js'
import { profitAndLoss } from '../accounting/reports.js'
import { monthlyLabourCents } from '../projections/labour.js'
import { moduleGateForNewRoles } from './moduleGate.js'
import { toCents, zMoneyCents } from '../../lib/money.js'
import { audit } from '../../lib/audit.js'

/** A date the API is given: 'YYYY-MM-DD' or a full ISO timestamp. */
const zDateString = z.string().min(10).max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'Not a date')

/** A paid date can be today or earlier — never a day still to come (Karachi day, one day of slack). */
function assertNotFuturePaid(paidAt: Date | null | undefined): void {
  if (paidAt && paidAt.getTime() > Date.now() + 86_400_000) {
    throw new AppError('PAID_IN_FUTURE', 'A payment cannot be marked paid on a date that has not come yet', 422)
  }
}

/** The 6xxx code a category is booked to: `^6\d{3}$`, null clears it. */
const zExpenseCode = z.string().regex(/^6\d{3}$/, 'An operating-expense account is a 6xxx code').nullable().optional()

const cadenceEnum = z.enum(['monthly', 'quarterly', 'annual', 'per_use'])

// Who works the OpEx tracker (wave 3, UI-07): the manager tiers plus finance.
// OpEx is a page of the 'capital' module, which finance holds by default and
// whose workspace (Finance) it owns — it got 403 on every /opex call. Recording
// a recurring bill as paid posts it to the books (owner decision 23); that is
// finance's normal job. The backfill of old payments stays the CEO's.
// /opex is not a central module-gated prefix, so finance (newly let in) must
// also hold 'capital' — the CEO's Module Access untick closes every route here,
// writes and ledger postings included (W3B-RV-1). Manager tiers unchanged.
const OPEX_TEAM = FINANCE_TEAM
const OPEX_GUARD = [requireAuth(...OPEX_TEAM), moduleGateForNewRoles(['capital'])]

// Every id an opex line points at — its category, brand, capex project and
// paying bank account — must belong to the line's own company (its
// category's). Checked on create and on every PATCH that sets one, so a
// partial update can never re-bind a line to another company's rows. Null
// clears a link and needs no check.
async function assertLineRefsOfCompany(
  tenantId: string | null,
  refs: { conceptId?: string | null; projectId?: string | null; bankAccountId?: string | null },
): Promise<void> {
  if (refs.conceptId)     await assertConceptOfCompany(tenantId, refs.conceptId)
  if (refs.projectId)     await assertCapexProjectOfCompany(tenantId, refs.projectId)
  if (refs.bankAccountId) await assertBankAccountOfCompany(tenantId, refs.bankAccountId)
}

/** A cash-paid line or payment does not name a bank account (lib/bankAccounts.ts BANK_ACCOUNT_ON_CASH). */
function assertMethodAndBank(method: string | null | undefined, bankAccountId: string | null | undefined): void {
  if (method === 'cash' && bankAccountId) {
    throw new AppError('BANK_ACCOUNT_ON_CASH', 'A cash payment does not use a bank account', 422)
  }
}

const lineSchema = z.object({
  categoryId:    z.string().min(1),
  conceptId:     z.string().uuid().nullable().optional(),
  projectId:     z.string().min(1).nullable().optional(),    // optional link to a CapexProject
  name:          z.string().min(1).max(120),
  vendor:        z.string().max(120).nullable().optional(),
  vendorContact: z.string().max(120).nullable().optional(),
  amountCents:   zMoneyCents('A line amount'),
  cadence:       cadenceEnum.default('monthly'),
  nextDueDate:   z.string().nullable().optional(),
  paymentMethod: z.string().max(40).nullable().optional(),
  bankAccountId: z.string().min(1).nullable().optional(),
  source:        z.enum(['manual', 'payroll', 'license', 'subscription']).default('manual'),
  notes:         z.string().nullable().optional(),
})

export async function opexRoutes(fastify: FastifyInstance) {

  // â”€â”€â”€ Categories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get<{ Querystring: { projectId?: string; scope?: string } }>('/categories',
    { preHandler: OPEX_GUARD },
    async (req) => {
      const { projectId, scope } = req.query
      // Filter lines by project: 'project' = lines with this projectId,
      // 'company' = lines with no projectId (cross-project), absent = both.
      const lineFilter: { isActive: boolean; projectId?: string | null } = { isActive: true }
      if (projectId && scope !== 'company') lineFilter.projectId = projectId
      else if (scope === 'company')          lineFilter.projectId = null

      const company = await scopeTenantWhere(req, 'read')
      const categories = await prisma.opexCategory.findMany({
        where: { deletedAt: null, isActive: true, ...company },
        include: { lines: { where: lineFilter, include: { payments: { orderBy: { periodStart: 'desc' }, take: 12 } } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      })

      // Hide categories that have no lines after filtering (only when filtering)
      const filtered = (projectId || scope) ? categories.filter((c) => c.lines.length > 0) : categories

      // The ledger state of every payment shown: the actual is what the
      // ledger holds (owner decision 23), so each paid row says whether its
      // entry is on the books.
      const tenantIds = (await resolveTenantScope(req)).tenantIds
      const paymentIds = filtered.flatMap((c) => c.lines.flatMap((l) => l.payments.map((p) => p.id)))
      const live = await liveRevisionsFor(tenantIds, OPEX_SOURCE, paymentIds)

      return filtered.map((c) => {
        const monthlyExpected = c.lines.reduce((s, l) => s + monthlyCents(toCents(l.amountCents), l.cadence), 0)
        const budget = toCents(c.budgetMonthlyCents)
        const overBudgetPct = budget > 0 ? (monthlyExpected / budget) - 1 : 0
        const payroll = isPayrollCategory(c.name)
        return {
          ...c,
          // The name map's guess for a category with no account yet — what the
          // picker offers first. Never posted from until it is saved.
          suggestedExpenseAccountCode: payroll || c.expenseAccountCode ? null : expenseCodeForCategoryName(c.name),
          isPayroll: payroll,
          lines: c.lines.map((l) => ({
            ...l,
            payments: l.payments.map((p) => {
              const entry = live.get(p.id)
              const ledgerStatus = payroll || l.source === 'payroll' ? 'payroll'
                : !p.paidAt ? 'not_paid'
                : entry ? 'posted' : 'unposted'
              return {
                ...p,
                ledger: {
                  status: ledgerStatus, entryId: entry?.entryId ?? null, amountCents: entry?.amountCents ?? null,
                  // Booked to (expense) and paid from (cash / bank chart code).
                  accountCode: entry?.debitCode ?? null, creditCode: entry?.creditCode ?? null,
                },
              }
            }),
          })),
          monthlyExpectedCents: monthlyExpected,
          overBudgetPct,
          lineCount: c.lines.length,
        }
      })
    },
  )

  // A category's expense account (finance gaps 17d): the 6xxx account in its
  // company's chart its payments post to. Named on create or edit (checked
  // against THAT company's chart — 422 otherwise); left out on create, the
  // name map pre-fills it when the chart has the code. The payroll category
  // never has one (HR payroll books wages): naming one is 422.
  fastify.post('/categories', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = z.object({
      name:               z.string().min(1).max(80),
      emoji:              z.string().max(8).nullable().optional(),
      conceptId:          z.string().uuid().nullable().optional(),
      budgetMonthlyCents: zMoneyCents('The monthly budget').default(0),
      notes:              z.string().nullable().optional(),
      sortOrder:          z.number().int().optional(),
      expenseAccountCode: zExpenseCode,
    }).parse(req.body)
    if (body.conceptId) {
      const concept = await prisma.concept.findFirst({
        where: { id: body.conceptId, deletedAt: null, ...(await scopeTenantWhere(req, 'create')) },
      })
      if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    }
    // Bound to the ACTIVE company — a category with no company could never
    // post its payments to the books.
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
    let expenseAccountCode: string | null
    if (body.expenseAccountCode) {
      await assertCategoryAccount(tenantId, body.name, body.expenseAccountCode)
      expenseAccountCode = body.expenseAccountCode
    } else {
      // Explicit null = "not decided yet"; left out = the name map's suggestion.
      expenseAccountCode = body.expenseAccountCode === null ? null : await suggestedCategoryAccount(prisma, tenantId, body.name)
    }
    const cat = await prisma.opexCategory.create({ data: { ...body, expenseAccountCode, tenantId } })
    if (cat.expenseAccountCode) {
      await audit({
        category: 'accounting', action: 'opex.category.account', entity: 'OpexCategory', entityId: cat.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
        after: { name: cat.name, expenseAccountCode: cat.expenseAccountCode }, metadata: { suggested: !body.expenseAccountCode },
      })
    }
    return reply.status(201).send(cat)
  })

  fastify.patch<{ Params: { id: string } }>('/categories/:id', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = z.object({
      name:               z.string().min(1).max(80).optional(),
      emoji:              z.string().max(8).nullable().optional(),
      budgetMonthlyCents: zMoneyCents('The monthly budget').optional(),
      notes:              z.string().nullable().optional(),
      sortOrder:          z.number().int().optional(),
      isActive:           z.boolean().optional(),
      expenseAccountCode: zExpenseCode,
    }).parse(req.body)
    const owned = await prisma.opexCategory.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in your active company' } })
    const name = body.name ?? owned.name
    const data: typeof body = { ...body }
    if (body.expenseAccountCode) {
      // Checked against the CATEGORY's company's chart, never the operator's.
      if (!owned.tenantId) throw new AppError('CATEGORY_HAS_NO_COMPANY', 'This category is not bound to a company — recreate it under the company', 422)
      await assertCategoryAccount(owned.tenantId, name, body.expenseAccountCode)
    } else if (isPayrollCategory(name) && owned.expenseAccountCode) {
      // Renamed into the payroll category: HR payroll books it from now on.
      data.expenseAccountCode = null
    }
    const updated = await prisma.opexCategory.update({ where: { id: req.params.id }, data })
    if (updated.expenseAccountCode !== owned.expenseAccountCode) {
      await audit({
        category: 'accounting', action: 'opex.category.account', entity: 'OpexCategory', entityId: owned.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: req.staffUser!.tenantId,
        before: { name: owned.name, expenseAccountCode: owned.expenseAccountCode },
        after: { name: updated.name, expenseAccountCode: updated.expenseAccountCode },
        metadata: { companyId: owned.tenantId },
      })
    }
    return updated
  })

  fastify.delete<{ Params: { id: string } }>('/categories/:id', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const owned = await prisma.opexCategory.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in your active company' } })
    await prisma.opexCategory.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date(), isActive: false },
    })
    return reply.status(204).send()
  })

  // â”€â”€â”€ Lines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post('/lines', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = lineSchema.parse(req.body)
    // A new line binds to the ACTIVE company: its category must be one of the
    // active company's, and everything else it names must be that company's.
    const cat = await prisma.opexCategory.findFirst({
      where: { id: body.categoryId, deletedAt: null, ...(await scopeTenantWhere(req, 'create')) },
      select: { tenantId: true },
    })
    if (!cat) throw new AppError('CATEGORY_NOT_IN_COMPANY', 'That category does not belong to the active company', 422)
    assertMethodAndBank(body.paymentMethod, body.bankAccountId)
    await assertLineRefsOfCompany(cat.tenantId, body)
    const line = await prisma.opexLine.create({
      data: {
        ...body,
        nextDueDate: body.nextDueDate ? new Date(body.nextDueDate) : null,
      },
    })
    return reply.status(201).send(line)
  })

  fastify.patch<{ Params: { id: string } }>('/lines/:id', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = lineSchema.partial().parse(req.body)
    const owned = await prisma.opexLine.findFirst({
      where: {
        id: req.params.id,
        category: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      },
      include: { category: { select: { tenantId: true } } },
    })
    if (!owned) throw new NotFoundError('OpexLine', req.params.id)
    // The line stays in its company: a new category must be the same
    // company's, and so must any brand / project / bank account being set.
    const tenantId = owned.category.tenantId
    if (body.categoryId !== undefined && body.categoryId !== owned.categoryId) {
      const cat = tenantId
        ? await prisma.opexCategory.findFirst({ where: { id: body.categoryId, tenantId, deletedAt: null }, select: { id: true } })
        : null
      if (!cat) throw new AppError('CATEGORY_NOT_IN_COMPANY', 'That category does not belong to this company', 422)
    }
    assertMethodAndBank(body.paymentMethod !== undefined ? body.paymentMethod : owned.paymentMethod, body.bankAccountId)
    await assertLineRefsOfCompany(tenantId, body)
    // Switched to cash: the line no longer pays from a bank account.
    const clearBank = body.paymentMethod === 'cash' && body.bankAccountId === undefined && owned.bankAccountId != null
    return prisma.opexLine.update({
      where: { id: req.params.id },
      data: {
        ...body,
        ...(clearBank && { bankAccountId: null }),
        nextDueDate: body.nextDueDate !== undefined ? (body.nextDueDate ? new Date(body.nextDueDate) : null) : undefined,
      },
    })
  })

  fastify.delete<{ Params: { id: string } }>('/lines/:id', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const owned = await prisma.opexLine.findFirst({
      where: {
        id: req.params.id,
        category: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Line not found in your active company' } })
    await prisma.opexLine.update({ where: { id: req.params.id }, data: { isActive: false } })
    return reply.status(204).send()
  })

  // â”€â”€â”€ Payments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Marking a payment paid posts it to the books (owner decision 23) — in the
  // SAME transaction as the save, so a payment the ledger refuses (closed
  // month, unmapped category, bank account with no chart code) is not saved
  // as paid either. See opex/posting.ts.
  // The paid date, reference and receipt are the operator's (a bill paid on
  // 28 Sep but keyed on 2 Oct books on 28 Sep). `expenseAccountCode`,
  // `payFrom` and `bankAccountId` are instructions for THIS posting, not
  // columns of the payment: the expense code is remembered on an unmapped
  // category (opex/posting.ts); the bank lives on the line, and a payment paid
  // from somewhere else keeps that in its own journal entry (its live credit).
  const paymentBody = {
    actualCents:   zMoneyCents('The amount paid').nullable().optional(),
    paidAt:        zDateString.nullable().optional(),
    paymentRef:    z.string().max(120).nullable().optional(),
    receiptUrl:    z.string().url().max(2048).nullable().optional(),
    notes:         z.string().nullable().optional(),
    // The 6xxx account the payment is booked to (accounting/expenseCategories.ts).
    expenseAccountCode: z.string().regex(/^6\d{3}$/).nullable().optional(),
    // Where this payment's money came from, when not the line's own account.
    payFrom:       z.enum(['bank', 'cash']).optional(),
    bankAccountId: z.string().min(1).nullable().optional(),
  }

  fastify.post('/payments', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = z.object({
      lineId:        z.string().min(1),
      periodStart:   zDateString,
      periodEnd:     zDateString,
      expectedCents: zMoneyCents('The expected amount'),
      ...paymentBody,
    }).parse(req.body)
    const ownedLine = await prisma.opexLine.findFirst({
      where: {
        id: body.lineId,
        category: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      },
    })
    if (!ownedLine) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Line does not belong to your active company' } })
    const { expenseAccountCode, payFrom, bankAccountId, ...data } = body
    if (payFrom === 'cash') assertMethodAndBank('cash', bankAccountId)
    const paidAt = data.paidAt ? new Date(data.paidAt) : null
    assertNotFuturePaid(paidAt)
    // Paid with no actual → it was paid as expected.
    const actualCents = data.actualCents ?? (paidAt ? data.expectedCents : null)
    const { p, ledger } = await prisma.$transaction(async (tx) => {
      const p = await tx.opexPayment.create({
        data: {
          ...data,
          actualCents,
          periodStart: new Date(data.periodStart),
          periodEnd:   new Date(data.periodEnd),
          paidAt,
        },
        include: { line: { include: { category: true } } },
      })
      const ledger = await syncOpexPaymentPosting(p.id, { tx, postedBy: req.staffUser!.id, expenseAccountCode, payFrom, bankAccountId })
      return { p, ledger }
    })
    if (ledger.status === 'posted') {
      await audit({
        category: 'accounting', action: 'opex.payment.paid', entity: 'OpexPayment', entityId: p.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: req.staffUser!.tenantId,
        after: { lineId: p.lineId, actualCents: p.actualCents, paidAt: p.paidAt, paymentRef: p.paymentRef },
        metadata: { entryId: ledger.entryId, companyId: p.line.category.tenantId, expenseAccountCode, payFrom, bankAccountId },
      })
    }

    // Variance flag: actual significantly higher than expected (vendor invoice
    // jumped). > 15% over expected fires `price_drift`. Catches inflated
    // utility bills, surprise software price hikes, etc.
    if (actualCents != null && body.expectedCents > 0) {
      const variancePct = (actualCents - body.expectedCents) / body.expectedCents
      if (variancePct > 0.15) {
        await flagException({
          tenantId: p.line.category.tenantId,
          kind: 'price_drift',
          severity: variancePct > 0.5 ? 'high' : 'medium',
          title: `OpEx jump: ${p.line.name} +${(variancePct * 100).toFixed(0)}%`,
          description: `Expected PKR ${(body.expectedCents / 100).toLocaleString()}, vendor charged PKR ${(actualCents / 100).toLocaleString()} for ${new Date(body.periodStart).toLocaleDateString('en-GB')} to ${new Date(body.periodEnd).toLocaleDateString('en-GB')}. Either the rate changed (negotiate) or it's a billing error (dispute).`,
          entityType: 'OpexPayment',
          entityId: p.id,
          actorId: req.staffUser!.id,
          amountCents: actualCents - body.expectedCents,
          metadata: { lineId: body.lineId, lineName: p.line.name, expected: body.expectedCents, actual: actualCents, variancePct },
        })
      }
    }

    return reply.status(201).send({ ...p, ledger })
  })

  // Correct a payment: amount, paid date, reference, receipt, period, the
  // expense account or where the money came from — or un-mark it paid. The
  // ledger follows in the same transaction (opex/posting.ts): before it is on
  // the books this simply saves (and posts once it is paid); after, a change
  // to the amount, the date or an account reverses the live entry and reposts
  // (opex.payment:<id>@n), a note / reference / receipt alone changes nothing
  // on the books, and un-marking it reverses it. A date in a closed month is
  // 422 PERIOD_LOCKED with nothing saved.
  fastify.patch<{ Params: { id: string } }>('/payments/:id', { preHandler: OPEX_GUARD }, async (req, reply) => {
    const body = z.object({
      ...paymentBody,
      periodStart: zDateString.optional(),
      periodEnd:   zDateString.optional(),
    }).parse(req.body)
    const owned = await prisma.opexPayment.findFirst({
      where: {
        id: req.params.id,
        line: { category: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
      },
      include: { line: { select: { category: { select: { tenantId: true } } } } },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
    const { expenseAccountCode, payFrom, bankAccountId, periodStart, periodEnd, ...data } = body
    if (payFrom === 'cash') assertMethodAndBank('cash', bankAccountId)
    const paidAt = data.paidAt !== undefined ? (data.paidAt ? new Date(data.paidAt) : null) : undefined
    assertNotFuturePaid(paidAt)
    const nowPaid = paidAt !== undefined ? paidAt : owned.paidAt
    const actualCents = data.actualCents !== undefined
      ? data.actualCents
      : (nowPaid && owned.actualCents == null ? owned.expectedCents : undefined)
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.opexPayment.update({
        where: { id: owned.id },
        data: {
          ...data, paidAt, actualCents,
          ...(periodStart !== undefined && { periodStart: new Date(periodStart) }),
          ...(periodEnd !== undefined && { periodEnd: new Date(periodEnd) }),
        },
      })
      const ledger = await syncOpexPaymentPosting(owned.id, { tx, postedBy: req.staffUser!.id, expenseAccountCode, payFrom, bankAccountId })
      return { ...updated, ledger }
    })
    await audit({
      category: 'accounting', action: 'opex.payment.correct', entity: 'OpexPayment', entityId: owned.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: req.staffUser!.tenantId,
      before: { actualCents: owned.actualCents, paidAt: owned.paidAt, paymentRef: owned.paymentRef, receiptUrl: owned.receiptUrl, periodStart: owned.periodStart, periodEnd: owned.periodEnd },
      after: { actualCents: result.actualCents, paidAt: result.paidAt, paymentRef: result.paymentRef, receiptUrl: result.receiptUrl, periodStart: result.periodStart, periodEnd: result.periodEnd },
      metadata: { ledger: result.ledger, expenseAccountCode, payFrom, bankAccountId, companyId: owned.line.category.tenantId },
    })
    return result
  })

  // POST /opex/payments/post-unposted — put paid OpEx payments that predate
  // the posting rule on the books (admin; dry run by default). Payroll is
  // skipped (HR payroll books wages). Each payment is tried in its own
  // transaction; the dry run tries it too and rolls back, so the preview says
  // exactly what posting would do. Nothing is ever forced: a payment that
  // can't post is listed with WHY —
  //   needs_account  the category has no expense account (set it on the category)
  //   needs_bank     the company has several banks and the line names none, or
  //                  the line's bank is not a live, linked bank of the company
  //   period_locked  its paid date is in a closed month
  //   failed         anything else (code + reason in the row)
  fastify.post('/payments/post-unposted', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ dryRun: z.boolean().default(true) }).parse(req.body ?? {})
    const tenantIds = (await resolveTenantScope(req)).tenantIds
    const paid = await prisma.opexPayment.findMany({
      where: { paidAt: { not: null }, line: { category: { tenantId: { in: tenantIds }, deletedAt: null } } },
      select: {
        id: true, paidAt: true, actualCents: true,
        line: { select: { id: true, name: true, source: true, category: { select: { id: true, name: true, tenantId: true } } } },
      },
      orderBy: { paidAt: 'asc' },
    })
    const live = await liveRevisionsFor(tenantIds, OPEX_SOURCE, paid.map((p) => p.id))
    type Outcome = 'payroll' | 'already_posted' | 'would_post' | 'posted' | 'needs_account' | 'needs_bank' | 'period_locked' | 'failed'
    const rows: Array<{
      paymentId: string; line: string; lineId: string; categoryId: string; category: string; tenantId: string | null
      paidAt: Date | null; amountCents: number | null; outcome: Outcome; code?: string; reason?: string
    }> = []
    class DryRun extends Error {}
    for (const p of paid) {
      const base = {
        paymentId: p.id, line: `${p.line.category.name} — ${p.line.name}`, lineId: p.line.id,
        categoryId: p.line.category.id, category: p.line.category.name, tenantId: p.line.category.tenantId,
        paidAt: p.paidAt, amountCents: p.actualCents == null ? null : toCents(p.actualCents),
      }
      if (isPayrollCategory(p.line.category.name) || p.line.source === 'payroll') { rows.push({ ...base, outcome: 'payroll' }); continue }
      if (live.has(p.id)) { rows.push({ ...base, outcome: 'already_posted' }); continue }
      try {
        await prisma.$transaction(async (tx) => {
          await syncOpexPaymentPosting(p.id, { tx, postedBy: req.staffUser!.id })
          if (body.dryRun) throw new DryRun()
        })
        rows.push({ ...base, outcome: 'posted' })
      } catch (err) {
        if (err instanceof DryRun) { rows.push({ ...base, outcome: 'would_post' }); continue }
        const code = err instanceof AppError ? err.code : 'INTERNAL'
        const outcome: Outcome =
          ['CATEGORY_NOT_MAPPED', 'ACCOUNT_NOT_FOUND', 'NOT_AN_EXPENSE_CODE'].includes(code) ? 'needs_account'
          : ['BANK_ACCOUNT_REQUIRED', 'BANK_ACCOUNT_NOT_IN_COMPANY', 'BANK_ACCOUNT_NOT_LINKED', 'BANK_ACCOUNT_ON_CASH'].includes(code) ? 'needs_bank'
          : code === 'PERIOD_LOCKED' ? 'period_locked'
          : 'failed'
        rows.push({ ...base, outcome, code, reason: (err as Error).message })
      }
    }
    const counts: Partial<Record<Outcome, number>> = {}
    for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
    if (!body.dryRun && (counts.posted ?? 0) > 0) {
      await audit({
        category: 'accounting', action: 'opex.payments.post_unposted', entity: 'OpexPayment',
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: req.staffUser!.tenantId,
        metadata: { counts, posted: rows.filter((r) => r.outcome === 'posted').map((r) => r.paymentId) },
      })
    }
    return { dryRun: body.dryRun, counts, rows }
  })

  // GET /opex/actuals — what was actually spent, FROM THE LEDGER (decision
  // 23): the P&L's operating-expense accounts for the period, and per OpEx
  // category what its posted payments put on the books. The tracker's own
  // "paid" rows are only a view of these entries.
  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string } }>('/actuals', { preHandler: OPEX_GUARD }, async (req) => {
    const to = req.query.dateTo ? new Date(req.query.dateTo) : new Date()
    const from = req.query.dateFrom ? new Date(req.query.dateFrom) : new Date(to.getFullYear(), to.getMonth(), 1)
    const tenantIds = (await resolveTenantScope(req)).tenantIds
    const pl = await profitAndLoss(tenantIds, from, to)
    const payments = await prisma.opexPayment.findMany({
      where: { paidAt: { gte: from, lte: to }, line: { category: { tenantId: { in: tenantIds } } } },
      select: { id: true, line: { select: { category: { select: { id: true, name: true, budgetMonthlyCents: true } } } } },
    })
    const live = await liveRevisionsFor(tenantIds, OPEX_SOURCE, payments.map((p) => p.id))
    const byCategory = new Map<string, { categoryId: string; name: string; budgetMonthlyCents: number; postedCents: number; unpostedCount: number }>()
    for (const p of payments) {
      const c = p.line.category
      const row = byCategory.get(c.id) ?? { categoryId: c.id, name: c.name, budgetMonthlyCents: toCents(c.budgetMonthlyCents), postedCents: 0, unpostedCount: 0 }
      const e = live.get(p.id)
      if (e) row.postedCents += e.amountCents
      else if (!isPayrollCategory(c.name)) row.unpostedCount += 1
      byCategory.set(c.id, row)
    }
    return {
      dateFrom: pl.dateFrom,
      dateTo: pl.dateTo,
      source: 'ledger' as const,
      opexByAccount: pl.opex,
      totalOpexCents: pl.totals.opexCents,
      byCategory: Array.from(byCategory.values()).sort((a, b) => b.postedCents - a.postedCents),
    }
  })

  // â”€â”€â”€ Live data: payroll snapshot for the Payroll category â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/payroll-snapshot', { preHandler: OPEX_GUARD }, async (req) => {
    // Last 6 months of HR payroll runs for the companies in view; the UI
    // renders them as a "live" line under the Payroll category instead of
    // manual entry.
    const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    const tenantIds = (await resolveTenantScope(req)).tenantIds
    const hrRuns = await prisma.hrPayrollRun.findMany({
      where: { tenantId: { in: tenantIds }, period: { gte: sixMonthsAgo.toISOString().slice(0, 7) } },
      orderBy: { period: 'desc' },
      include: { _count: { select: { payslips: true } } },
      take: 12,
    })
    const runs = hrRuns.map((r) => {
      const [y, m] = r.period.split('-').map(Number) as [number, number]
      const totals = (r.totals ?? {}) as { earningsCents?: number }
      return { id: r.id, periodStart: new Date(Date.UTC(y, m - 1, 1)), periodEnd: new Date(Date.UTC(y, m, 0)), status: r.status, totalGrossCents: totals.earningsCents ?? 0, lineCount: r._count.payslips }
    })

    // Also project this month — sum unposted clock logs × wage rates
    const monthStart = new Date()
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
    const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)

    // The budgeted payroll: THE labour rule (projections/labour.ts, owner
    // decision 25) — open and filled seats at each company's cost share,
    // frozen seats excluded, JV / head-office contributions netted — summed
    // over the companies in view. The Projections labour line is the same
    // figure. Edits in workforce/positions show on the next refresh.
    const labours = await Promise.all(tenantIds.map((t) => monthlyLabourCents(t)))
    const budgetedMonthly      = labours.reduce((s, l) => s + l.seatsCents, 0)
    const budgetedGrossMonthly = labours.reduce((s, l) => s + l.grossSalaryCents, 0)
    const headcountTotal       = labours.reduce((s, l) => s + l.headcount, 0)
    const openSeats            = labours.reduce((s, l) => s + l.openSeats, 0)
    // Contributions between two companies BOTH in view cancel out.
    let incomingMonthly = labours.reduce((s, l) => s + l.incomingContributionCents, 0)
    let outgoingMonthly = labours.reduce((s, l) => s + l.outgoingContributionCents, 0)
    if (tenantIds.length > 1) {
      const internal = await prisma.tenantContribution.aggregate({
        where: { isActive: true, sourceTenantId: { in: tenantIds }, destinationTenantId: { in: tenantIds } },
        _sum: { monthlyCents: true },
      })
      incomingMonthly -= internal._sum.monthlyCents ?? 0
      outgoingMonthly -= internal._sum.monthlyCents ?? 0
    }
    const netMonthly = budgetedMonthly + outgoingMonthly - incomingMonthly

    return {
      runs,
      currentMonth: { start: monthStart, end: monthEnd },
      // Live position-based budget. UI surfaces this above the run history
      // so the operator sees what they're COMMITTED to before they see
      // what's already been paid out.
      budget: {
        monthlyCents:       budgetedMonthly,
        grossMonthlyCents:  budgetedGrossMonthly,
        headcount:          headcountTotal,
        openSeats,
        // Inter-tenant contributions shown as separate lines under the
        // Payroll category. netMonthlyCents = what hits this tenant's P&L
        // after chargebacks.
        incomingContributionMonthlyCents: incomingMonthly,
        outgoingContributionMonthlyCents: outgoingMonthly,
        netMonthlyCents:                  netMonthly,
      },
    }
  })

  // â”€â”€â”€ Cash-flow forecast (next 90 days) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/cashflow', { preHandler: OPEX_GUARD }, async (req) => {
    const now = new Date()
    const horizon = new Date(now); horizon.setDate(horizon.getDate() + 90)

    const lines = await prisma.opexLine.findMany({
      where: {
        isActive: true,
        nextDueDate: { gte: now, lte: horizon },
        // Company scoping via the line's category tenant — matches every other
        // opex read in this module.
        category: await scopeTenantWhere(req, 'read'),
      },
      include: { category: { select: { name: true, emoji: true } } },
      orderBy: { nextDueDate: 'asc' },
    })

    return lines.map((l) => ({
      id: l.id,
      name: l.name,
      categoryName: l.category.name,
      categoryEmoji: l.category.emoji,
      dueDate: l.nextDueDate,
      amountCents: l.amountCents,
      vendor: l.vendor,
    }))
  })
}

// Cadence â†’ equivalent monthly cents for budget comparison.
function monthlyCents(amountCents: number, cadence: string): number {
  switch (cadence) {
    case 'quarterly': return Math.round(amountCents / 3)
    case 'annual':    return Math.round(amountCents / 12)
    case 'per_use':   return amountCents      // not strictly monthly; show as-is
    case 'monthly':
    default:          return amountCents
  }
}
