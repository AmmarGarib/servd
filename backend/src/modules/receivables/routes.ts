// /accounting/receivables — invoices a customer pays later.
//
// One AR subledger: ReceivableInvoice rows of kind 'invoice' (AR-YYYY-NNNN)
// and kind 'credit_note' (AR-CN-YYYY-NNNN, against their original invoice),
// with ReceivablePayment rows for everything that settles an invoice —
// money received, income tax the client withheld, and money handed back.
//
// What the customer still owes on an invoice is ONE figure everywhere
// (balanceOf — status, aging, the overpayment check):
//     total − paid − credited − withheld
// Negative = the customer is in credit (a credit note on money already
// received), which a refund pays out.
//
// Postings — every one inside the document's transaction (a closed period is
// 422 and nothing is saved), in the INVOICE's company, idempotent on
// sourceType:sourceId:
//   receivable.issue        Dr 1110 (total) / Cr revenue (net) / Cr output tax
//                           — the brand's authority, the same rule as a sale
//                           (outputTaxCodeFor: 2032 SRB for a Sindh kitchen,
//                           2031 PRA, …; 2030 FBR with no brand / province)
//   receivable.payment      Dr the bank / cash / card account the money went
//                           into (lib/bankAccounts.ts moneyAccountCode) / Cr 1110
//   receivable.wht          Dr 1330 Income Tax (WHT) Receivable / Cr 1110 —
//                           income tax the client withheld (s.153) and paid to
//                           FBR for us
//   receivable.credit_note  Dr the invoice's revenue account (net) + Dr the
//                           output-tax account the invoice credited (tax) /
//                           Cr 1110 (total)
//   receivable.refund       Dr 1110 / Cr the bank / cash account it left from
//   <any>.reversal          a receipt reversed (bounced cheque), a withholding
//                           certificate withdrawn, a refund that never went
//                           out, a credit note voided, an unpaid invoice voided
//
// Not here yet (pending owner decisions): bad-debt write-off (G12), sales tax
// withheld by the customer as a withholding agent (G13), the on-account
// tender at the till (G14).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma, ReceivableInvoice, ReceivablePayment } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma, prisma as appPrisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, activeTenantId } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { ACCT, postJournalEntry, reverseJournalEntry } from '../accounting/journal.js'
import { outputTaxCodeFor, OUTPUT_TAX_ACCOUNTS, refundTaxAccountFor } from '../accounting/orderPosting.js'
import { assertMoneyFits, sumCents, toCents, zMoneyCents, type DbMoney } from '../../lib/money.js'
import { moneyAccountCode } from '../../lib/bankAccounts.js'
import { CHART_OF_ACCOUNTS } from '../../lib/chartOfAccounts.js'

type Tx = Prisma.TransactionClient

const RECEIVABLE = ACCT.CUSTOMER_AR          // 1110
const WHT_RECEIVABLE = ACCT.WHT_RECEIVABLE   // 1330

export const INVOICE = 'invoice'
export const CREDIT_NOTE = 'credit_note'
/** ReceivablePayment.method of a withholding row (income tax the client withheld). */
export const WHT_METHOD = 'wht'

/** A credit note this long after its invoice is flagged for the accountant (sales-tax adjustment window). */
const CREDIT_NOTE_WARN_DAYS = 180

const activeTenant = (req: { staffUser?: { tenantId: string | null } }): string => activeTenantId(req, 'the ledger is per company')
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}/)

const DAY = 86_400_000
export function agingBucket(dueDate: Date, now = new Date()): 'current' | '1-30' | '31-60' | '61-90' | '90+' {
  const days = Math.floor((now.getTime() - dueDate.getTime()) / DAY)
  if (days <= 0) return 'current'
  if (days <= 30) return '1-30'
  if (days <= 60) return '31-60'
  if (days <= 90) return '61-90'
  return '90+'
}

// ─── The one balance ─────────────────────────────────────────────────────────

interface Figures {
  kind: string
  status: string
  amountCents: DbMoney
  taxCents: DbMoney
  paidCents: DbMoney
  creditedCents: DbMoney
  whtCents: DbMoney
}

export const totalOf = (inv: Pick<Figures, 'amountCents' | 'taxCents'>): number => toCents(inv.amountCents) + toCents(inv.taxCents)

/**
 * What the customer still owes: total − paid − credited − withheld. Negative
 * = the customer is in credit. 0 for a void invoice and for a credit note
 * (its value sits on the invoice it credits).
 */
export function balanceOf(inv: Figures): number {
  if (inv.status === 'void' || inv.kind === CREDIT_NOTE) return 0
  return totalOf(inv) - toCents(inv.paidCents) - toCents(inv.creditedCents) - toCents(inv.whtCents)
}

/**
 * An invoice's status from its figures: open (nothing against it), partial,
 * paid (settled with money or withholding received), credited (settled by
 * credit notes alone — nothing was ever received).
 */
export function statusFor(inv: Figures): 'open' | 'partial' | 'paid' | 'credited' {
  const received = toCents(inv.paidCents) !== 0 || toCents(inv.whtCents) !== 0
  if (balanceOf({ ...inv, status: 'open', kind: INVOICE }) <= 0) return received ? 'paid' : 'credited'
  return received || toCents(inv.creditedCents) !== 0 ? 'partial' : 'open'
}

/** payment = money received · withholding = income tax the client withheld · refund = money handed back. */
export function paymentKind(p: Pick<ReceivablePayment, 'method' | 'amountCents'>): 'payment' | 'withholding' | 'refund' {
  if (p.method === WHT_METHOD) return 'withholding'
  return toCents(p.amountCents) < 0 ? 'refund' : 'payment'
}
const SOURCE_OF_KIND = { payment: 'receivable.payment', withholding: 'receivable.wht', refund: 'receivable.refund' } as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The invoice (or credit note), or 404 — never another company's. */
async function findInScope(req: FastifyRequest, id: string): Promise<ReceivableInvoice> {
  const inv = await prisma.receivableInvoice.findFirst({ where: { id, ...(await scopeTenantWhere(req, 'write')) } })
  if (!inv) throw new NotFoundError('ReceivableInvoice', id)
  return inv
}

/** Lock the invoice row for the rest of `tx` and read it fresh. Every change to an invoice's figures takes this first. */
async function lockInvoice(tx: Tx, id: string): Promise<ReceivableInvoice> {
  await tx.$queryRaw`SELECT id FROM receivable_invoices WHERE id = ${id} FOR UPDATE`
  return tx.receivableInvoice.findUniqueOrThrow({ where: { id } })
}

/** 409 unless this is a live invoice (not a credit note, not void). */
function assertLiveInvoice(inv: ReceivableInvoice): void {
  if (inv.kind !== INVOICE) throw new AppError('NOT_AN_INVOICE', 'This is a credit note — record this against the invoice it credits', 409)
  if (inv.status === 'void') throw new AppError('INVOICE_VOID', 'This invoice has been voided', 409)
}

/** Write the status the invoice's figures now give. */
async function restatus(tx: Tx, id: string): Promise<ReceivableInvoice> {
  const inv = await tx.receivableInvoice.findUniqueOrThrow({ where: { id } })
  if (inv.status === 'void' || inv.kind === CREDIT_NOTE) return inv
  const status = statusFor(inv)
  return status === inv.status ? inv : tx.receivableInvoice.update({ where: { id }, data: { status } })
}

async function nextNumber(tx: Tx, tenantId: string, date: Date, kind: string): Promise<string> {
  const year = date.getUTCFullYear()
  const prefix = kind === CREDIT_NOTE ? `AR-CN-${year}-` : `AR-${year}-`
  const last = await tx.receivableInvoice.findFirst({
    where: { tenantId, number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const n = last ? parseInt(last.number.slice(prefix.length), 10) + 1 : 1
  return `${prefix}${String(n).padStart(4, '0')}`
}

/**
 * The number is max+1 per company and prefix; two documents raised at the
 * same instant can pick the same one, and the unique index rejects the
 * second. Retry the whole transaction — it rolls back cleanly, ledger entry
 * included.
 */
async function withNumberRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err
      if (attempt === 2) throw new AppError('INVOICE_NUMBER', 'Could not allocate an invoice number — try again', 409)
    }
  }
}

/**
 * The output-tax account a credit note on `inv` debits: the account the
 * invoice's own entry credited, while it still holds that brand's tax
 * (refundTaxAccountFor — the same rule a sale's refund follows); the brand's
 * authority today only when it has been reclassed away.
 */
async function taxAccountOfInvoice(inv: ReceivableInvoice, taxShareCents: number): Promise<string> {
  const issue = await prisma.journalEntry.findFirst({
    where: { tenantId: inv.tenantId, reference: `receivable.issue:${inv.id}` },
    select: { lines: { select: { type: true, account: { select: { code: true } } } } },
  })
  const invoiced = issue?.lines.find((l) => l.type === 'credit' && OUTPUT_TAX_ACCOUNTS.includes(l.account.code))?.account.code ?? null
  if (!inv.conceptId) return invoiced ?? outputTaxCodeFor(null)
  const brand = await prisma.concept.findUnique({ where: { id: inv.conceptId }, select: { province: true, srbPosId: true } })
  return refundTaxAccountFor(appPrisma, inv.tenantId, { conceptId: inv.conceptId, concept: brand ?? {} }, invoiced, taxShareCents)
}

const staffOf = (req: FastifyRequest) => ({ userId: req.staffUser!.id, userEmail: req.staffUser!.email })

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function receivableRoutes(fastify: FastifyInstance) {
  // GET /accounting/receivables — list + aging summary.
  //   ?status= outstanding (open / partial invoices) · in_credit (customers we
  //   owe a refund) · credit_notes · paid · credited · void · '' (everything).
  // The summary (aging, outstanding, in credit) always covers every invoice
  // in view, whatever the filter.
  fastify.get<{ Querystring: { status?: string } }>('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const status = req.query.status
    const scope = await scopeTenantWhere(req, 'read')
    const include = { payments: { orderBy: [{ receivedAt: 'desc' as const }, { createdAt: 'desc' as const }] } }

    // Summary: every invoice still owed, and every one that could be in credit
    // (a credit note, or a reversed refund, can push an invoice below zero).
    const [owed, maybeInCredit] = await Promise.all([
      prisma.receivableInvoice.findMany({ where: { ...scope, kind: INVOICE, status: { in: ['open', 'partial'] } }, include }),
      prisma.receivableInvoice.findMany({
        where: { ...scope, kind: INVOICE, status: 'paid', OR: [{ creditedCents: { gt: 0 } }, { payments: { some: { reversedAt: { not: null } } } }] },
        include,
      }),
    ])
    const inCredit = maybeInCredit.filter((r) => balanceOf(r) < 0)
    const now = new Date()
    const aging = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 } as Record<string, number>
    let outstandingCents = 0
    for (const r of owed) {
      const b = balanceOf(r)
      if (b <= 0) continue
      outstandingCents += b
      aging[agingBucket(r.dueDate, now)]! += b
    }
    const creditBalanceCents = inCredit.reduce((s, r) => s - balanceOf(r), 0)

    let rows: Array<ReceivableInvoice & { payments: ReceivablePayment[] }>
    if (status === 'outstanding') rows = owed
    else if (status === 'in_credit') rows = inCredit
    else {
      rows = await prisma.receivableInvoice.findMany({
        where: {
          ...scope,
          ...(status === 'credit_notes' ? { kind: CREDIT_NOTE } : status ? { status } : {}),
        },
        include,
        orderBy: [{ dueDate: 'asc' }],
      })
    }
    rows = [...rows].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())

    // Credit notes against the listed invoices, the originals of the listed
    // credit notes, and the banks money went through — all in scope.
    const invoiceIds = rows.filter((r) => r.kind === INVOICE).map((r) => r.id)
    const originalIds = [...new Set(rows.map((r) => r.originalInvoiceId).filter((x): x is string => !!x))]
    const bankIds = [...new Set(rows.flatMap((r) => r.payments.map((p) => p.bankAccountId)).filter((x): x is string => !!x))]
    const [notes, originals, banks] = await Promise.all([
      invoiceIds.length
        ? prisma.receivableInvoice.findMany({
            where: { ...scope, kind: CREDIT_NOTE, originalInvoiceId: { in: invoiceIds } },
            select: { id: true, number: true, originalInvoiceId: true, issueDate: true, amountCents: true, taxCents: true, status: true, description: true },
            orderBy: { issueDate: 'asc' },
          })
        : [],
      originalIds.length
        ? prisma.receivableInvoice.findMany({ where: { ...scope, id: { in: originalIds } }, select: { id: true, number: true } })
        : [],
      bankIds.length
        ? prisma.bankAccount.findMany({ where: { ...scope, id: { in: bankIds } }, select: { id: true, name: true, accountCode: true } })
        : [],
    ])
    const bankById = new Map(banks.map((b) => [b.id, b]))
    const numberOf = new Map(originals.map((o) => [o.id, o.number]))

    const invoices = rows.map((r) => {
      const balance = balanceOf(r)
      return {
        ...r,
        totalCents: totalOf(r),
        balanceCents: balance,
        bucket: balance > 0 ? agingBucket(r.dueDate, now) : null,
        originalNumber: r.originalInvoiceId ? numberOf.get(r.originalInvoiceId) ?? null : null,
        creditNotes: r.kind === INVOICE
          ? notes.filter((n) => n.originalInvoiceId === r.id).map((n) => ({ ...n, totalCents: totalOf(n) }))
          : [],
        payments: r.payments.map((p) => ({
          ...p,
          kind: paymentKind(p),
          bankName: p.bankAccountId ? bankById.get(p.bankAccountId)?.name ?? null : null,
          bankAccountCode: p.bankAccountId ? bankById.get(p.bankAccountId)?.accountCode ?? null : null,
        })),
      }
    })
    return { invoices, aging, outstandingCents, creditBalanceCents }
  })

  // GET /accounting/receivables/tax-preview?conceptId= — the brand's own
  // sales-tax rates (Concept.taxRateCash / taxRateCard — never the legacy
  // concept.taxRate) and the output-tax account an invoice for it is booked
  // to, so the new-invoice form never assumes a rate.
  fastify.get<{ Querystring: { conceptId?: string } }>('/tax-preview', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const tenantId = activeTenant(req)
    const conceptId = req.query.conceptId || null
    const brand = conceptId
      ? (await assertConceptOwned(req, conceptId, 'create'),
         await prisma.concept.findUniqueOrThrow({
           where: { id: conceptId },
           select: { id: true, name: true, taxRateCash: true, taxRateCard: true, province: true, srbPosId: true },
         }))
      : null
    const accountCode = outputTaxCodeFor(brand)
    const account = await prisma.account.findFirst({ where: { tenantId, code: accountCode }, select: { name: true } })
    return {
      conceptId: brand?.id ?? null,
      brandName: brand?.name ?? null,
      rates: brand ? { cashPct: brand.taxRateCash, cardPct: brand.taxRateCard } : null,
      accountCode,
      accountName: account?.name ?? CHART_OF_ACCOUNTS.find((a) => a.code === accountCode)?.name ?? accountCode,
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
      issueDate: dateStr,
      dueDate: dateStr,
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

    // Output tax follows the brand's province, like every sale (BOOKS-10).
    const brand = body.conceptId
      ? await prisma.concept.findUnique({ where: { id: body.conceptId }, select: { province: true, srbPosId: true } })
      : null
    const taxAccountCode = outputTaxCodeFor(brand)

    const invoice = await withNumberRetry(() => prisma.$transaction(async (tx) => {
      const inv = await tx.receivableInvoice.create({
        data: {
          tenantId,
          kind: INVOICE,
          number: await nextNumber(tx, tenantId, issueDate, INVOICE),
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
    }))
    await audit({
      category: 'accounting', action: 'receivable.issue', entity: 'ReceivableInvoice', entityId: invoice.id,
      ...staffOf(req), tenantId, after: invoice,
    })
    return reply.status(201).send(invoice)
  })

  // POST /accounting/receivables/:id/payments — money received, into the bank
  // (or cash / card account) it actually went to.
  fastify.post<{ Params: { id: string } }>('/:id/payments', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req, reply) => {
    const body = z.object({
      amountCents: zMoneyCents('This payment', { sign: 'positive' }),
      receivedAt: dateStr,
      method: z.enum(['bank', 'cash', 'cheque', 'card']),
      // A bank account of the INVOICE's company. Omitted: its only bank;
      // required (422 BANK_ACCOUNT_REQUIRED) when it has two or more.
      bankAccountId: z.string().min(1).nullable().optional(),
      reference: z.string().max(80).optional(),
    }).parse(req.body)
    const found = await findInScope(req, req.params.id)
    assertLiveInvoice(found)
    const receivedAt = new Date(body.receivedAt)

    const payment = await prisma.$transaction(async (tx) => {
      // Locked, so two people recording the same cheque cannot both succeed
      // and overpay the invoice.
      const inv = await lockInvoice(tx, found.id)
      assertLiveInvoice(inv)
      if (body.amountCents > balanceOf(inv)) {
        throw new AppError('OVERPAYMENT', 'That is more than the balance owed on this invoice', 409)
      }
      const money = await moneyAccountCode(tx, inv.tenantId, { method: body.method, bankAccountId: body.bankAccountId })
      await tx.receivableInvoice.update({ where: { id: inv.id }, data: { paidCents: { increment: body.amountCents } } })
      const p = await tx.receivablePayment.create({
        data: {
          tenantId: inv.tenantId, invoiceId: inv.id, amountCents: body.amountCents,
          receivedAt, method: body.method, bankAccountId: money.bankAccountId,
          reference: body.reference || null, createdById: req.staffUser!.id,
        },
      })
      await postJournalEntry({
        tenantId: inv.tenantId,
        sourceType: 'receivable.payment',
        sourceId: p.id,
        description: `Payment on ${inv.number} — ${inv.customerName}`,
        entryDate: receivedAt,
        postedBy: req.staffUser!.id,
        reference: body.reference ?? inv.number,
        lines: [
          { accountCode: money.code, type: 'debit', amountCents: body.amountCents },
          { accountCode: RECEIVABLE, type: 'credit', amountCents: body.amountCents, conceptId: inv.conceptId },
        ],
      }, { tx })
      await restatus(tx, inv.id)
      return p
    })
    await audit({
      category: 'accounting', action: 'receivable.payment', entity: 'ReceivablePayment', entityId: payment.id,
      ...staffOf(req), tenantId: found.tenantId, after: payment,
    })
    return reply.status(201).send(payment)
  })

  // POST /accounting/receivables/:id/withholding — income tax the client
  // withheld at source (ITO 2001 s.153) and paid to FBR for us. It settles
  // that part of the invoice and is a tax credit on our own return: Dr 1330
  // / Cr 1110. Capped at what is still due. A withholding-only entry is fine
  // (the certificate often arrives after the money).
  //
  // TODO(pending owner decision G13): sales tax the client withholds as a
  // withholding agent (SRB / PRA) is NOT recorded here — the account (a
  // separate 1335 netted in the return, or the output account itself) is the
  // accountant's call.
  fastify.post<{ Params: { id: string } }>('/:id/withholding', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req, reply) => {
    const body = z.object({
      amountCents: zMoneyCents('The tax withheld', { sign: 'positive' }),
      certificateNo: z.string().trim().max(80).optional(),
      date: dateStr,
    }).parse(req.body)
    const found = await findInScope(req, req.params.id)
    assertLiveInvoice(found)
    const date = new Date(body.date)

    const row = await prisma.$transaction(async (tx) => {
      const inv = await lockInvoice(tx, found.id)
      assertLiveInvoice(inv)
      if (body.amountCents > balanceOf(inv)) {
        throw new AppError('OVER_WITHHOLDING', 'That is more than is still due on this invoice', 409)
      }
      await tx.receivableInvoice.update({ where: { id: inv.id }, data: { whtCents: { increment: body.amountCents } } })
      const w = await tx.receivablePayment.create({
        data: {
          tenantId: inv.tenantId, invoiceId: inv.id, amountCents: body.amountCents,
          receivedAt: date, method: WHT_METHOD, reference: body.certificateNo || null, createdById: req.staffUser!.id,
        },
      })
      await postJournalEntry({
        tenantId: inv.tenantId,
        sourceType: 'receivable.wht',
        sourceId: w.id,
        description: `Income tax withheld by ${inv.customerName} on ${inv.number}${body.certificateNo ? ` (certificate ${body.certificateNo})` : ''}`,
        entryDate: date,
        postedBy: req.staffUser!.id,
        reference: body.certificateNo || inv.number,
        lines: [
          { accountCode: WHT_RECEIVABLE, type: 'debit', amountCents: body.amountCents },
          { accountCode: RECEIVABLE, type: 'credit', amountCents: body.amountCents, conceptId: inv.conceptId },
        ],
      }, { tx })
      await restatus(tx, inv.id)
      return w
    })
    await audit({
      category: 'accounting', action: 'receivable.withholding', entity: 'ReceivablePayment', entityId: row.id,
      ...staffOf(req), tenantId: found.tenantId, after: row,
    })
    return reply.status(201).send(row)
  })

  // POST /accounting/receivables/:id/credit-notes — credit all or part of an
  // invoice (a dispute, a price adjustment, a cancelled event). A credit note
  // can never credit more than was invoiced (before tax and tax, each), and
  // never on a credit note or a void invoice (409). Credited beyond what is
  // still owed, the customer is in credit — /refunds pays it out.
  fastify.post<{ Params: { id: string } }>('/:id/credit-notes', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req, reply) => {
    const body = z.object({
      amountCents: zMoneyCents('The credit before tax').default(0),
      taxCents: zMoneyCents('The tax credited').default(0),
      reason: z.string().trim().min(3).max(500),
      date: dateStr,
    }).parse(req.body)
    const credit = body.amountCents + body.taxCents
    if (credit <= 0) throw new AppError('EMPTY_CREDIT_NOTE', 'A credit note must credit an amount, its tax, or both', 400)
    assertMoneyFits(credit, 'The credit note total')
    const found = await findInScope(req, req.params.id)
    assertLiveInvoice(found)
    const date = new Date(body.date)
    if (date < found.issueDate) throw new AppError('BAD_DATE', 'A credit note cannot be dated before its invoice', 400)
    // Read outside the transaction: the invoice's own entry never changes.
    const taxAccount = body.taxCents > 0 ? await taxAccountOfInvoice(found, body.taxCents) : null

    const { note, invoice } = await withNumberRetry(() => prisma.$transaction(async (tx) => {
      const inv = await lockInvoice(tx, found.id)
      assertLiveInvoice(inv)
      // What earlier credit notes took, part by part (under the invoice lock,
      // so two credit notes at once cannot both take the last of it).
      const prior = await tx.receivableInvoice.aggregate({
        where: { originalInvoiceId: inv.id, kind: CREDIT_NOTE, status: { not: 'void' } },
        _sum: { amountCents: true, taxCents: true },
      })
      const leftAmount = toCents(inv.amountCents) - sumCents(prior._sum.amountCents)
      const leftTax = toCents(inv.taxCents) - sumCents(prior._sum.taxCents)
      if (body.amountCents > leftAmount || body.taxCents > leftTax || toCents(inv.creditedCents) + credit > totalOf(inv)) {
        throw new AppError(
          'OVER_CREDIT',
          `That is more than is left to credit on ${inv.number} (PKR ${(leftAmount / 100).toLocaleString('en-PK')} before tax, PKR ${(leftTax / 100).toLocaleString('en-PK')} tax)`,
          409,
          { leftAmountCents: leftAmount, leftTaxCents: leftTax },
        )
      }
      const cn = await tx.receivableInvoice.create({
        data: {
          tenantId: inv.tenantId,
          kind: CREDIT_NOTE,
          originalInvoiceId: inv.id,
          number: await nextNumber(tx, inv.tenantId, date, CREDIT_NOTE),
          customerName: inv.customerName,
          customerEmail: inv.customerEmail,
          customerPhone: inv.customerPhone,
          customerNtn: inv.customerNtn,
          customerId: inv.customerId,
          conceptId: inv.conceptId,
          issueDate: date,
          dueDate: date,
          description: body.reason,
          amountCents: body.amountCents,
          taxCents: body.taxCents,
          revenueAccountCode: inv.revenueAccountCode,
          status: 'issued',
          createdById: req.staffUser!.id,
        },
      })
      await tx.receivableInvoice.update({ where: { id: inv.id }, data: { creditedCents: { increment: credit } } })
      await postJournalEntry({
        tenantId: inv.tenantId,
        sourceType: 'receivable.credit_note',
        sourceId: cn.id,
        description: `Credit note ${cn.number} on ${inv.number} — ${inv.customerName}: ${body.reason}`.slice(0, 500),
        entryDate: date,
        postedBy: req.staffUser!.id,
        reference: cn.number,
        lines: [
          { accountCode: inv.revenueAccountCode, type: 'debit', amountCents: body.amountCents, conceptId: inv.conceptId },
          ...(body.taxCents > 0 ? [{ accountCode: taxAccount!, type: 'debit' as const, amountCents: body.taxCents, conceptId: inv.conceptId }] : []),
          { accountCode: RECEIVABLE, type: 'credit', amountCents: credit, conceptId: inv.conceptId },
        ],
      }, { tx })
      return { note: cn, invoice: await restatus(tx, inv.id) }
    }))
    const late = (date.getTime() - found.issueDate.getTime()) / DAY > CREDIT_NOTE_WARN_DAYS
    await audit({
      category: 'accounting', action: 'receivable.credit_note', entity: 'ReceivableInvoice', entityId: note.id,
      ...staffOf(req), tenantId: found.tenantId, after: note, metadata: { invoiceId: found.id, taxAccount },
    })
    return reply.status(201).send({
      ...note,
      invoice: { id: invoice.id, number: invoice.number, status: invoice.status, balanceCents: balanceOf(invoice) },
      warning: late
        ? `This credit note is more than ${CREDIT_NOTE_WARN_DAYS} days after the invoice — check with the accountant that the sales-tax adjustment is still allowed.`
        : null,
    })
  })

  // POST /accounting/receivables/:id/refunds — pay a customer in credit back
  // (a credit note on money already received). Capped at the credit balance
  // and at what was received: Dr 1110 / Cr the bank or cash it left from.
  fastify.post<{ Params: { id: string } }>('/:id/refunds', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req, reply) => {
    const body = z.object({
      amountCents: zMoneyCents('This refund', { sign: 'positive' }),
      date: dateStr,
      method: z.enum(['bank', 'cheque', 'cash']).default('bank'),
      bankAccountId: z.string().min(1).nullable().optional(),
      reference: z.string().max(80).optional(),
    }).parse(req.body)
    const found = await findInScope(req, req.params.id)
    assertLiveInvoice(found)
    const date = new Date(body.date)

    const row = await prisma.$transaction(async (tx) => {
      const inv = await lockInvoice(tx, found.id)
      assertLiveInvoice(inv)
      const inCredit = -balanceOf(inv)
      if (inCredit <= 0) throw new AppError('NO_CREDIT_BALANCE', 'This customer is not in credit on this invoice', 409)
      if (body.amountCents > inCredit || body.amountCents > toCents(inv.paidCents)) {
        throw new AppError('OVER_REFUND', 'That is more than the customer is owed back on this invoice', 409, {
          maxCents: Math.max(0, Math.min(inCredit, toCents(inv.paidCents))),
        })
      }
      const money = await moneyAccountCode(tx, inv.tenantId, { method: body.method, bankAccountId: body.bankAccountId })
      await tx.receivableInvoice.update({ where: { id: inv.id }, data: { paidCents: { decrement: body.amountCents } } })
      // A refund is a payment row with a NEGATIVE amount (paymentKind).
      const r = await tx.receivablePayment.create({
        data: {
          tenantId: inv.tenantId, invoiceId: inv.id, amountCents: -body.amountCents,
          receivedAt: date, method: body.method, bankAccountId: money.bankAccountId,
          reference: body.reference || null, createdById: req.staffUser!.id,
        },
      })
      await postJournalEntry({
        tenantId: inv.tenantId,
        sourceType: 'receivable.refund',
        sourceId: r.id,
        description: `Refund to ${inv.customerName} on ${inv.number}`,
        entryDate: date,
        postedBy: req.staffUser!.id,
        reference: body.reference || inv.number,
        lines: [
          { accountCode: RECEIVABLE, type: 'debit', amountCents: body.amountCents, conceptId: inv.conceptId },
          { accountCode: money.code, type: 'credit', amountCents: body.amountCents },
        ],
      }, { tx })
      await restatus(tx, inv.id)
      return r
    })
    await audit({
      category: 'accounting', action: 'receivable.refund', entity: 'ReceivablePayment', entityId: row.id,
      ...staffOf(req), tenantId: found.tenantId, after: row,
    })
    return reply.status(201).send(row)
  })

  // POST /accounting/receivables/:id/payments/:paymentId/reverse — a receipt
  // that did not stick (a bounced cheque, a transfer recalled), a withholding
  // certificate withdrawn, or a refund that never went out. The row stays on
  // record stamped reversed; its entry is reversed (dated `date`, default
  // today) and the invoice owes it again. Idempotent: a second call changes
  // nothing.
  fastify.post<{ Params: { id: string; paymentId: string } }>(
    '/:id/payments/:paymentId/reverse',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req) => {
      const body = z.object({
        reason: z.string().trim().min(3).max(300),
        date: dateStr.optional(),
      }).parse(req.body)
      const found = await findInScope(req, req.params.id)
      const pay = await prisma.receivablePayment.findFirst({
        where: { id: req.params.paymentId, invoiceId: found.id, tenantId: found.tenantId },
      })
      if (!pay) throw new NotFoundError('ReceivablePayment', req.params.paymentId)
      if (pay.reversedAt) return { ...pay, kind: paymentKind(pay), alreadyReversed: true }
      const kind = paymentKind(pay)
      const amount = toCents(pay.amountCents)

      const done = await prisma.$transaction(async (tx) => {
        const inv = await lockInvoice(tx, found.id)
        // A voided invoice is closed: its receipts are settled by the void's
        // own reversals, never one by one afterwards.
        if (inv.status === 'void') throw new AppError('INVOICE_VOID', 'This invoice is void — nothing on it can be reversed', 409)
        const claimed = await tx.receivablePayment.updateMany({
          where: { id: pay.id, reversedAt: null },
          data: { reversedAt: new Date(), reversedReason: body.reason },
        })
        if (claimed.count === 0) return null // another call reversed it first
        await tx.receivableInvoice.update({
          where: { id: inv.id },
          data: kind === 'withholding' ? { whtCents: { decrement: amount } } : { paidCents: { increment: -amount } },
        })
        await reverseJournalEntry(inv.tenantId, SOURCE_OF_KIND[kind], pay.id, body.reason, {
          tx, postedBy: req.staffUser!.id, entryDate: body.date ? new Date(body.date) : undefined,
        })
        await restatus(tx, inv.id)
        return tx.receivablePayment.findUniqueOrThrow({ where: { id: pay.id } })
      })
      if (!done) {
        const now = await prisma.receivablePayment.findUniqueOrThrow({ where: { id: pay.id } })
        return { ...now, kind, alreadyReversed: true }
      }
      await audit({
        category: 'accounting', action: `receivable.${kind}.reverse`, entity: 'ReceivablePayment', entityId: pay.id,
        ...staffOf(req), tenantId: found.tenantId, before: pay, after: done,
      })
      return { ...done, kind, alreadyReversed: false }
    },
  )

  // POST /accounting/receivables/:id/void — cancel an invoice raised in error
  // (only while nothing has been received, credited or withheld on it — after
  // that the fix is a credit note), or withdraw a credit note (the invoice it
  // credited owes that amount again).
  fastify.post<{ Params: { id: string } }>('/:id/void', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const body = z.object({ reason: z.string().min(3).max(300) }).parse(req.body)
    const found = await findInScope(req, req.params.id)

    if (found.kind === CREDIT_NOTE) {
      await prisma.$transaction(async (tx) => {
        // Lock order: the original invoice, then the credit note — the order
        // the credit-note route takes them in.
        const original = found.originalInvoiceId ? await lockInvoice(tx, found.originalInvoiceId) : null
        const cn = await lockInvoice(tx, found.id)
        if (cn.status !== 'issued') throw new AppError('CANNOT_VOID', 'This credit note is already void', 409)
        await tx.receivableInvoice.update({
          where: { id: cn.id },
          data: { status: 'void', voidedAt: new Date(), voidReason: body.reason },
        })
        if (original) {
          await tx.receivableInvoice.update({ where: { id: original.id }, data: { creditedCents: { decrement: totalOf(cn) } } })
          await restatus(tx, original.id)
        }
        await reverseJournalEntry(cn.tenantId, 'receivable.credit_note', cn.id, body.reason, { tx, postedBy: req.staffUser!.id })
      })
      await audit({
        category: 'accounting', action: 'receivable.credit_note.void', entity: 'ReceivableInvoice', entityId: found.id,
        ...staffOf(req), tenantId: found.tenantId, after: { reason: body.reason, invoiceId: found.originalInvoiceId },
      })
      return { ok: true }
    }

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.receivableInvoice.updateMany({
        // Nothing received, credited or withheld — and no live receipt or
        // refund row either (a payment and a refund that net to zero still
        // sit in 1110 until reversed).
        where: { id: found.id, kind: INVOICE, status: 'open', paidCents: 0, creditedCents: 0, whtCents: 0, payments: { none: { reversedAt: null } } },
        data: { status: 'void', voidedAt: new Date(), voidReason: body.reason },
      })
      if (claimed.count === 0) {
        throw new AppError('CANNOT_VOID', 'Only an invoice with nothing received, credited, withheld or refunded can be voided — reverse those first, or issue a credit note instead', 409)
      }
      await reverseJournalEntry(found.tenantId, 'receivable.issue', found.id, body.reason, {
        tx, postedBy: req.staffUser!.id,
      })
    })
    await audit({
      category: 'accounting', action: 'receivable.void', entity: 'ReceivableInvoice', entityId: found.id,
      ...staffOf(req), tenantId: found.tenantId,
      after: { reason: body.reason },
    })
    return { ok: true }
  })
}
