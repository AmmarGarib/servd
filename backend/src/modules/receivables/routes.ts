// /accounting/receivables — invoices a customer pays later.
//
// Base layer. Before this nothing receivable was tracked: account 1110 was
// never posted to, there was no "on account" tender, no aging, no statements.
// Fine while every sale settles at the till; blocking the first time a
// corporate client wants 30 days.
//
// Postings (idempotent on sourceType + sourceId):
//   issue    Dr 1110 receivable (total) / Cr revenue (net) / Cr output tax (tax)
//            — the brand's authority, the same rule as a sale (outputTaxCodeFor:
//            2032 SRB for a Sindh kitchen, 2031 PRA, …; 2030 FBR for a brand
//            with no province, or an invoice with no brand), tagged with it
//   payment  Dr 1020 bank or 1010 cash  / Cr 1110
//   void     reversal of the issue entry — only while nothing has been paid

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, activeTenantId } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { postJournalEntry, reverseJournalEntry } from '../accounting/journal.js'
import { outputTaxCodeFor } from '../accounting/orderPosting.js'
import { assertMoneyFits, toCents, zMoneyCents } from '../../lib/money.js'

const RECEIVABLE = '1110'
const PAYMENT_ACCOUNT: Record<string, string> = { bank: '1020', cheque: '1020', card: '1030', cash: '1010' }

const activeTenant = (req: { staffUser?: { tenantId: string | null } }): string => activeTenantId(req, 'the ledger is per company')

const DAY = 86_400_000
export function agingBucket(dueDate: Date, now = new Date()): 'current' | '1-30' | '31-60' | '61-90' | '90+' {
  const days = Math.floor((now.getTime() - dueDate.getTime()) / DAY)
  if (days <= 0) return 'current'
  if (days <= 30) return '1-30'
  if (days <= 60) return '31-60'
  if (days <= 90) return '61-90'
  return '90+'
}

async function nextNumber(tenantId: string, issueDate: Date): Promise<string> {
  const year = issueDate.getUTCFullYear()
  const prefix = `AR-${year}-`
  const last = await prisma.receivableInvoice.findFirst({
    where: { tenantId, number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const n = last ? parseInt(last.number.slice(prefix.length), 10) + 1 : 1
  return `${prefix}${String(n).padStart(4, '0')}`
}

export async function receivableRoutes(fastify: FastifyInstance) {
  // GET /accounting/receivables — list + aging summary.
  fastify.get<{ Querystring: { status?: string } }>('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const status = req.query.status
    const rows = await prisma.receivableInvoice.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'read')),
        ...(status === 'outstanding' ? { status: { in: ['open', 'partial'] } } : status ? { status } : {}),
      },
      include: { payments: { orderBy: { receivedAt: 'desc' } } },
      orderBy: [{ dueDate: 'asc' }],
    })
    const now = new Date()
    const invoices = rows.map((r) => {
      const total = toCents(r.amountCents) + toCents(r.taxCents)
      const balance = r.status === 'void' ? 0 : total - toCents(r.paidCents)
      return { ...r, totalCents: total, balanceCents: balance, bucket: balance > 0 ? agingBucket(r.dueDate, now) : null }
    })
    const aging = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 } as Record<string, number>
    for (const i of invoices) if (i.bucket) aging[i.bucket]! += i.balanceCents
    return {
      invoices,
      aging,
      outstandingCents: invoices.reduce((s, i) => s + i.balanceCents, 0),
    }
  })

  // POST /accounting/receivables — raise an invoice.
  fastify.post('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req, reply) => {
    const body = z.object({
      customerName: z.string().min(1).max(160),
      customerEmail: z.string().email().optional().or(z.literal('')),
      customerPhone: z.string().max(20).optional(),
      customerNtn: z.string().max(40).optional(),
      conceptId: z.string().uuid().nullable().optional(),
      issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
      description: z.string().min(1).max(500),
      // BIGINT paisa (lib/money.ts): one amount ≤ PKR 900bn, else 422.
      amountCents: zMoneyCents('The invoice amount', { sign: 'positive' }),
      taxCents: zMoneyCents('The invoice tax').default(0),
      revenueAccountCode: z.string().regex(/^4\d{3}$/).default('4090'),
      notes: z.string().max(1000).optional(),
    }).parse(req.body)
    assertMoneyFits(body.amountCents + body.taxCents, 'The invoice total')
    const tenantId = activeTenant(req)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    const issueDate = new Date(body.issueDate)
    const dueDate = new Date(body.dueDate)
    if (dueDate < issueDate) throw new AppError('BAD_DUE_DATE', 'Due date cannot be before the issue date', 400)

    // The number is max+1 per company; two invoices raised at the same instant
    // can pick the same one, and the unique index rejects the second. Retry the
    // whole transaction — it rolls back cleanly, ledger entry included.
    // Output tax follows the brand's province, like every sale (BOOKS-10).
    const brand = body.conceptId
      ? await prisma.concept.findUnique({ where: { id: body.conceptId }, select: { province: true, srbPosId: true } })
      : null
    const taxAccountCode = outputTaxCodeFor(brand)

    const createOnce = () => prisma.$transaction(async (tx) => {
      const inv = await tx.receivableInvoice.create({
        data: {
          tenantId,
          number: await nextNumber(tenantId, issueDate),
          customerName: body.customerName.trim(),
          customerEmail: body.customerEmail || null,
          customerPhone: body.customerPhone || null,
          customerNtn: body.customerNtn || null,
          conceptId: body.conceptId ?? null,
          issueDate, dueDate,
          description: body.description,
          amountCents: body.amountCents,
          taxCents: body.taxCents,
          revenueAccountCode: body.revenueAccountCode,
          notes: body.notes || null,
          createdById: req.staffUser!.id,
        },
      })
      const amount = toCents(inv.amountCents)
      const tax    = toCents(inv.taxCents)
      await postJournalEntry({
        tenantId,
        sourceType: 'receivable.issue',
        sourceId: inv.id,
        description: `Invoice ${inv.number} — ${inv.customerName}`,
        entryDate: issueDate,
        postedBy: req.staffUser!.id,
        reference: inv.number,
        lines: [
          { accountCode: RECEIVABLE, type: 'debit', amountCents: amount + tax, conceptId: inv.conceptId },
          { accountCode: inv.revenueAccountCode, type: 'credit', amountCents: amount, conceptId: inv.conceptId },
          ...(tax > 0 ? [{ accountCode: taxAccountCode, type: 'credit' as const, amountCents: tax, conceptId: inv.conceptId }] : []),
        ],
      }, { tx })
      return inv
    })
    let invoice: Awaited<ReturnType<typeof createOnce>> | undefined
    for (let attempt = 0; attempt < 3 && !invoice; attempt++) {
      try { invoice = await createOnce() }
      catch (err) {
        if ((err as { code?: string }).code !== 'P2002' || attempt === 2) throw err
      }
    }
    if (!invoice) throw new AppError('INVOICE_NUMBER', 'Could not allocate an invoice number — try again', 409)
    await audit({
      category: 'accounting', action: 'receivable.issue', entity: 'ReceivableInvoice', entityId: invoice.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: invoice,
    })
    return reply.status(201).send(invoice)
  })

  // POST /accounting/receivables/:id/payments — money received.
  fastify.post<{ Params: { id: string } }>('/:id/payments', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req, reply) => {
    const body = z.object({
      amountCents: zMoneyCents('This payment', { sign: 'positive' }),
      receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
      method: z.enum(['bank', 'cash', 'cheque', 'card']),
      reference: z.string().max(80).optional(),
    }).parse(req.body)
    const inv = await prisma.receivableInvoice.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!inv) throw new NotFoundError('ReceivableInvoice', req.params.id)
    if (inv.status === 'void') throw new AppError('INVOICE_VOID', 'This invoice has been voided', 409)

    const payment = await prisma.$transaction(async (tx) => {
      // Claim the balance atomically — two people recording the same cheque
      // must not both succeed and overpay the invoice.
      const total = toCents(inv.amountCents) + toCents(inv.taxCents)
      const claimed = await tx.receivableInvoice.updateMany({
        where: { id: inv.id, status: { in: ['open', 'partial'] }, paidCents: { lte: total - body.amountCents } },
        data: { paidCents: { increment: body.amountCents } },
      })
      if (claimed.count === 0) {
        throw new AppError('OVERPAYMENT', 'That is more than the balance owed on this invoice', 409)
      }
      const after = await tx.receivableInvoice.findUniqueOrThrow({ where: { id: inv.id } })
      await tx.receivableInvoice.update({
        where: { id: inv.id },
        data: { status: toCents(after.paidCents) >= total ? 'paid' : 'partial' },
      })
      const p = await tx.receivablePayment.create({
        data: {
          tenantId: inv.tenantId, invoiceId: inv.id, amountCents: body.amountCents,
          receivedAt: new Date(body.receivedAt), method: body.method,
          reference: body.reference || null, createdById: req.staffUser!.id,
        },
      })
      await postJournalEntry({
        tenantId: inv.tenantId,
        sourceType: 'receivable.payment',
        sourceId: p.id,
        description: `Payment on ${inv.number} — ${inv.customerName}`,
        entryDate: new Date(body.receivedAt),
        postedBy: req.staffUser!.id,
        reference: body.reference ?? inv.number,
        lines: [
          { accountCode: PAYMENT_ACCOUNT[body.method]!, type: 'debit', amountCents: body.amountCents },
          { accountCode: RECEIVABLE, type: 'credit', amountCents: body.amountCents, conceptId: inv.conceptId },
        ],
      }, { tx })
      return p
    })
    await audit({
      category: 'accounting', action: 'receivable.payment', entity: 'ReceivablePayment', entityId: payment.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: inv.tenantId, after: payment,
    })
    return reply.status(201).send(payment)
  })

  // POST /accounting/receivables/:id/void — cancel an invoice raised in error.
  fastify.post<{ Params: { id: string } }>('/:id/void', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const body = z.object({ reason: z.string().min(3).max(300) }).parse(req.body)
    const inv = await prisma.receivableInvoice.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!inv) throw new NotFoundError('ReceivableInvoice', req.params.id)
    await prisma.$transaction(async (tx) => {
      // Only an unpaid invoice can be voided — once money has come in, the fix
      // is a credit note, which this base layer does not have yet.
      const claimed = await tx.receivableInvoice.updateMany({
        where: { id: inv.id, status: 'open', paidCents: 0 },
        data: { status: 'void', voidedAt: new Date(), voidReason: body.reason },
      })
      if (claimed.count === 0) {
        throw new AppError('CANNOT_VOID', 'Only an unpaid invoice can be voided', 409)
      }
      await reverseJournalEntry(inv.tenantId, 'receivable.issue', inv.id, body.reason, {
        tx, postedBy: req.staffUser!.id,
      })
    })
    await audit({
      category: 'accounting', action: 'receivable.void', entity: 'ReceivableInvoice', entityId: inv.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: inv.tenantId,
      after: { reason: body.reason },
    })
    return { ok: true }
  })
}
