// On-account monthly statements — ReceivableInvoice rows of kind 'statement'
// (AR-ST-YYYY-NNNN, receivables/ledger.ts). Registered by customerAccounts.ts
// as a child plugin, so every path below is under /accounting/customer-accounts.
//
// A statement lists the on-account bills (CustomerAccountCharge) a client ran
// up to the end of a Karachi day (periodTo), and asks for the money. Only
// charges whose sale is already BOOKED (isChargeBookedTx — the drawer's close
// for a till ticket, the order's completion otherwise) go on it: a charge whose
// drawer is still open stays unbilled for the next statement, so a statement
// can never be paid (Cr 1110) before the sale debited 1110.
//
// A statement posts NOTHING on issue and is never a tax invoice: each bill's
// sale, its output tax and its fiscal number were booked / filed at the till.
// It is settled exactly like an invoice (receivables/routes.ts: payments,
// withholding, refunds, reversals, write-offs), in its own company. A refund
// at the till after billing credits the statement (onAccount.ts
// applyChargeRefundTx). A statement cannot take a credit note (refund the bill
// at the till so the fiscal return files); it can be voided only while nothing
// is against it — that releases its charges and posts nothing.
//
//   POST /:id/statements                {periodTo, issueDate?} — one client
//                                       (CLIENT_EDITORS, write scope)
//   POST /statements/issue              {periodTo, issueDate?, accountIds?} —
//                                       every client of the ACTIVE company →
//                                       {created, skipped}
//   GET  /statements/:invoiceId/html    the printable statement (CLIENT_VIEWERS)
//   POST /statements/:invoiceId/send    email it to the client (CLIENT_EDITORS)
//
// Refusals: 409 NOTHING_TO_BILL (no booked, unbilled charge up to periodTo),
// 409 STATEMENT_EXISTS (a live statement for the same client and periodTo —
// also the partial unique receivable_invoices_one_statement_per_period),
// 422 NO_EMAIL, 404 for another company's client or statement.
//
// Lock order (onAccount.ts): order → client account → invoice / statement.

import { exportFormatOf, sendReport, type ReportRow, type ReportTable } from '../../lib/reportExport.js'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { CustomerAccount, CustomerAccountCharge, Prisma, ReceivableInvoice } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, activeTenantId, type ScopeMode } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { assertMoneyFits, toCents } from '../../lib/money.js'
import { sendEmail } from '../../lib/mailer.js'
import { customerScope } from '../../lib/outboundScope.js'
import { isTestTenant } from '../../lib/testCompany.js'
import { isSandbox } from '../../lib/sandbox.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { karachiDay } from '../../connectors/util.js'
import { parsePktEndOfDay } from '../accounting/dates.js'
import { LIVE_KINDS, STATEMENT, balanceOf, nextNumber, totalOf, withNumberRetry } from './ledger.js'
import { CLIENT_EDITORS, CLIENT_VIEWERS, isChargeBookedTx, lockAccountTx } from './onAccount.js'
import { chargeOwedCents } from './cityLedger.js'
import { companyReplyTo } from './customerAccounts.js'

type Tx = Prisma.TransactionClient

const DAY = 86_400_000
const dayStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
/** A YYYY-MM-DD (Karachi day) stored the way receivables store dates: UTC midnight of that day. */
const asDate = (day: string) => new Date(`${day}T00:00:00Z`)
const dayOf = (d: Date) => d.toISOString().slice(0, 10)
const actorOf = (req: FastifyRequest) => ({ userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null })

export interface IssueStatementInput {
  /** The last Karachi day billed (YYYY-MM-DD): charges up to 23:59:59.999 PKT of it. */
  periodTo: string
  /** YYYY-MM-DD; default today in Karachi. Never before periodTo. */
  issueDate?: string
  actor: { id: string }
}

export interface IssuedStatement {
  invoice: ReceivableInvoice
  chargeIds: string[]
  /** Charges up to periodTo left unbilled because their sale is not booked yet (drawer still open). */
  notBookedCount: number
}

/**
 * Bill a client's BOOKED, unbilled charges up to the end of `periodTo`
 * (Karachi) on a new statement, in the CLIENT's company. Posts nothing.
 *
 *   amountCents + taxCents = Σ charge net of refunds; the tax is each charge's
 *   own tax pro rata to what is left of it; conceptId = the brand when every
 *   bill is at one brand; dueDate = issue date + the client's termsDays.
 *
 * 409 STATEMENT_EXISTS (a live statement for this client and periodTo),
 * 409 NOTHING_TO_BILL, 422 BAD_PERIOD (periodTo after the issue date).
 * Run inside withNumberRetry (the number is max+1 per company).
 */
export async function issueStatementTx(tx: Tx, accountId: string, input: IssueStatementInput): Promise<IssuedStatement> {
  const account = await lockAccountTx(tx, accountId)
  const issueDay = input.issueDate ?? karachiDay(new Date())
  if (input.periodTo > issueDay) {
    throw new AppError('BAD_PERIOD', 'A statement cannot bill a period that ends after its issue date', 422)
  }
  const periodTo = asDate(input.periodTo)

  // Under the account lock: two issues for the same client run one after the other.
  const existing = await tx.receivableInvoice.findFirst({
    where: { tenantId: account.tenantId, customerAccountId: account.id, kind: STATEMENT, periodTo, status: { not: 'void' } },
    select: { id: true, number: true },
  })
  if (existing) {
    throw new AppError('STATEMENT_EXISTS', `Statement ${existing.number} already bills this client up to ${input.periodTo}`, 409, {
      invoiceId: existing.id, number: existing.number,
    })
  }

  const candidates = await tx.customerAccountCharge.findMany({
    where: {
      tenantId: account.tenantId, accountId: account.id, statementInvoiceId: null,
      chargedAt: { lte: parsePktEndOfDay(input.periodTo) },
    },
    orderBy: [{ chargedAt: 'asc' }, { id: 'asc' }],
  })
  const booked: CustomerAccountCharge[] = []
  // City Ledger (2026-10-24): a bill paid off one by one (owing nothing) is not billed again.
  for (const c of candidates) if (chargeOwedCents(c) > 0 && await isChargeBookedTx(tx, c)) booked.push(c)
  const notBookedCount = candidates.length - booked.length
  if (booked.length === 0 || booked.reduce((t, c) => t + chargeOwedCents(c), 0) <= 0) {
    throw new AppError('NOTHING_TO_BILL', `Nothing to bill for this client up to ${input.periodTo}`, 409, { notBookedCount })
  }

  // Claim them (conditional: a charge another statement took in between is never billed twice).
  const invoiceId = randomUUID()
  const ids = booked.map((c) => c.id)
  const claimed = await tx.customerAccountCharge.updateMany({
    where: { id: { in: ids }, tenantId: account.tenantId, accountId: account.id, statementInvoiceId: null },
    data: { statementInvoiceId: invoiceId },
  })
  if (claimed.count !== ids.length) throw new AppError('CHARGE_CHANGED', 'The client\'s bills changed while billing — try again', 409)

  // The figures from the claimed rows as they now stand.
  const rows = await tx.customerAccountCharge.findMany({ where: { statementInvoiceId: invoiceId, tenantId: account.tenantId } })
  let totalCents = 0
  let taxCents = 0
  for (const c of rows) {
    // What the bill still owes — net of refunds and of what was paid on the bill itself (City Ledger).
    const net = chargeOwedCents(c)
    totalCents += net
    taxCents += c.amountCents > 0 ? Math.round((c.taxCents * net) / c.amountCents) : 0
  }
  assertMoneyFits(totalCents, 'The statement total')
  const brands = [...new Set(rows.map((c) => c.conceptId))]
  const periodFromDay = karachiDay(rows.reduce((m, c) => (c.chargedAt < m ? c.chargedAt : m), rows[0]!.chargedAt))
  const issueDate = asDate(issueDay)
  const dueDate = new Date(issueDate.getTime() + account.termsDays * DAY)

  const invoice = await tx.receivableInvoice.create({
    data: {
      id: invoiceId,
      tenantId: account.tenantId,
      kind: STATEMENT,
      number: await nextNumber(tx, account.tenantId, issueDate, STATEMENT),
      customerAccountId: account.id,
      customerName: account.legalName,
      customerNtn: account.ntn,
      customerEmail: account.contactEmail,
      customerPhone: account.contactPhone,
      conceptId: brands.length === 1 ? brands[0]! : null,
      issueDate,
      dueDate,
      periodFrom: asDate(periodFromDay),
      periodTo,
      description: `Statement ${periodFromDay} to ${input.periodTo} — ${rows.length} bill${rows.length === 1 ? '' : 's'} on account ${account.number}`,
      amountCents: totalCents - taxCents,
      taxCents,
      createdById: input.actor.id,
    },
  })
  return { invoice, chargeIds: rows.map((c) => c.id), notBookedCount }
}

/** issueStatementTx in its own transaction, retried on a number clash. */
export async function issueStatement(accountId: string, input: IssueStatementInput): Promise<IssuedStatement> {
  return withNumberRetry(() => prisma.$transaction((tx) => issueStatementTx(tx, accountId, input), { timeout: 30_000 }))
}

/** The client, or 404 — never another company's. */
async function findAccount(req: FastifyRequest, id: string, mode: ScopeMode): Promise<CustomerAccount> {
  const a = await prisma.customerAccount.findFirst({ where: { id, ...(await scopeTenantWhere(req, mode)) } })
  if (!a) throw new NotFoundError('CustomerAccount', id)
  return a
}

/** The statement, or 404 — never another company's, never an invoice or credit note. */
async function findStatement(req: FastifyRequest, id: string, mode: ScopeMode): Promise<ReceivableInvoice> {
  const inv = await prisma.receivableInvoice.findFirst({ where: { id, kind: STATEMENT, ...(await scopeTenantWhere(req, mode)) } })
  if (!inv) throw new NotFoundError('Statement', id)
  return inv
}

function statementView(inv: ReceivableInvoice) {
  return {
    ...inv,
    totalCents: totalOf(inv),
    balanceCents: balanceOf(inv),
    periodFromDay: inv.periodFrom ? dayOf(inv.periodFrom) : null,
    periodToDay: inv.periodTo ? dayOf(inv.periodTo) : null,
  }
}

/**
 * The printable statement, headed "Statement — not a tax invoice": every bill
 * (Karachi date, order reference, brand, card hint, reference, fiscal number),
 * the previous balance (what the client's earlier bills still owe), the total
 * due, the due date and the company's bank details. Read in the statement's
 * own company only.
 */
async function loadStatement(inv: ReceivableInvoice) {
  const tenantId = inv.tenantId
  const [company, account, charges, banks] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    inv.customerAccountId
      ? prisma.customerAccount.findFirst({ where: { id: inv.customerAccountId, tenantId } })
      : null,
    prisma.customerAccountCharge.findMany({
      where: { tenantId, statementInvoiceId: inv.id },
      orderBy: [{ chargedAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.bankAccount.findMany({
      where: { tenantId, isActive: true, deletedAt: null, OR: [{ accountNumber: { not: null } }, { iban: { not: null } }] },
      orderBy: [{ raastDefault: 'desc' }, { createdAt: 'asc' }],
    }),
  ])
  const orderIds = charges.map((c) => c.orderId)
  const [concepts, cards, fiscal, earlier] = await Promise.all([
    prisma.concept.findMany({ where: { id: { in: [...new Set(charges.map((c) => c.conceptId))] }, tenantId }, select: { id: true, name: true } }),
    prisma.customerAccountCard.findMany({
      where: { tenantId, id: { in: [...new Set(charges.map((c) => c.cardId).filter((x): x is string => !!x))] } },
      select: { id: true, tokenHint: true, label: true },
    }),
    orderIds.length
      ? prisma.fiscalDocument.findMany({
          where: { tenantId, orderId: { in: orderIds }, kind: 'sale', fiscalNumber: { not: null } },
          select: { orderId: true, fiscalNumber: true, isTest: true },
        })
      : [],
    inv.customerAccountId
      ? prisma.receivableInvoice.findMany({
          where: {
            tenantId, customerAccountId: inv.customerAccountId, kind: { in: [...LIVE_KINDS] },
            status: { in: ['open', 'partial'] }, id: { not: inv.id }, issueDate: { lte: inv.issueDate },
          },
        })
      : [],
  ])
  const brandOf = new Map(concepts.map((c) => [c.id, c.name]))
  const cardOf = new Map(cards.map((c) => [c.id, c]))
  const fiscalOf = new Map(fiscal.map((f) => [f.orderId, f.isTest ? `${f.fiscalNumber} (test)` : f.fiscalNumber!]))
  const previousCents = earlier.reduce((t, b) => t + Math.max(0, balanceOf(b)), 0)
  const thisCents = inv.status === 'void' ? 0 : balanceOf(inv)
  const dueCents = previousCents + thisCents
  const total = totalOf(inv)
  return { company, account, charges, banks, brandOf, cardOf, fiscalOf, previousCents, thisCents, dueCents, total }
}

/**
 * The statement as a report table (?format=csv|xlsx|pdf on the printable
 * route, lib/reportExport.ts): the same bills, totals, previous balance and
 * total due as the printed copy.
 */
export async function statementReport(inv: ReceivableInvoice): Promise<ReportTable> {
  const { company, account, charges, cardOf, brandOf, fiscalOf, previousCents, thisCents, dueCents, total } = await loadStatement(inv)
  const rows: ReportRow[] = charges.map((c) => {
    const card = c.cardId ? cardOf.get(c.cardId) : undefined
    return {
      date: karachiDay(c.chargedAt), order: orderRefOf(c.orderId), brand: brandOf.get(c.conceptId) ?? '',
      card: card ? `${card.label} ··${card.tokenHint}` : '', reference: c.reference ?? '', fiscalNo: fiscalOf.get(c.orderId) ?? '',
      amountCents: toCents(c.amountCents), refundedCents: toCents(c.refundedCents) + c.settledCents || null, netCents: chargeOwedCents(c),
    }
  })
  const sum = (label: string, cents: number) => ({ date: '', order: '', brand: label, card: '', reference: '', fiscalNo: '', amountCents: null, refundedCents: null, netCents: cents })
  rows.push(sum('THIS STATEMENT', total))
  if (total !== thisCents) rows.push(sum('Paid / credited since', -(total - thisCents)))
  rows.push(sum('Previous balance', previousCents))
  rows.push(sum('TOTAL DUE', dueCents))
  return {
    title: `Statement ${inv.number} — ${account?.legalName ?? inv.customerName}`,
    companies: company?.name ? [company.name] : [],
    period: `${inv.periodFrom ? dayOf(inv.periodFrom) : ''} to ${inv.periodTo ? dayOf(inv.periodTo) : ''} · issued ${dayOf(inv.issueDate)} · due ${dayOf(inv.dueDate)}`,
    rows,
    labels: { fiscalNo: 'Fiscal no.', amountCents: 'Amount', refundedCents: 'Refunded / paid on bill', netCents: 'Net' },
    types: { amountCents: 'cents', refundedCents: 'cents', netCents: 'cents' },
    isTotal: (r) => r.brand === 'THIS STATEMENT' || r.brand === 'TOTAL DUE',
    notes: [
      'Statement — not a tax invoice. Each bill was charged on account at the till; its tax invoice is the fiscal receipt numbered on its line.',
      ...(inv.status === 'void' ? ['This statement has been voided.'] : []),
      `Please quote ${inv.number} as the payment reference.`,
    ],
  }
}

export async function renderStatementHtml(inv: ReceivableInvoice): Promise<string> {
  const { company, account, charges, banks, brandOf, cardOf, fiscalOf, previousCents, thisCents, dueCents, total } = await loadStatement(inv)

  const td = (s: string, right = false) => `<td${right ? ' style="text-align:right"' : ''}>${s}</td>`
  const lines = charges.map((c) => {
    const card = c.cardId ? cardOf.get(c.cardId) : undefined
    return `<tr>${[
      td(karachiDay(c.chargedAt)),
      td(escapeHtml(orderRefOf(c.orderId))),
      td(escapeHtml(brandOf.get(c.conceptId) ?? '')),
      td(card ? escapeHtml(`${card.label} ··${card.tokenHint}`) : ''),
      td(escapeHtml(c.reference ?? '')),
      td(escapeHtml(fiscalOf.get(c.orderId) ?? '')),
      td(pkr(c.amountCents), true),
      td(c.refundedCents + c.settledCents ? `−${pkr(c.refundedCents + c.settledCents)}` : '', true),
      td(pkr(chargeOwedCents(c)), true),
    ].join('')}</tr>`
  })
  const bankLines = banks.map((b) => `<li>${escapeHtml([
    b.bankName ?? b.name,
    b.accountTitle ? `Title: ${b.accountTitle}` : null,
    b.accountNumber ? `Account: ${b.accountNumber}` : null,
    b.iban ? `IBAN: ${b.iban}` : null,
    b.raastId ? `Raast: ${b.raastId}` : null,
  ].filter(Boolean).join(' · '))}</li>`)
  const from = inv.periodFrom ? dayOf(inv.periodFrom) : ''
  const to = inv.periodTo ? dayOf(inv.periodTo) : ''
  const clientName = escapeHtml(account?.legalName ?? inv.customerName)

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Statement ${escapeHtml(inv.number)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#261038;background:#fff;margin:24px;font-size:13px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:20px 0 6px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e6e0ee;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f3eefa}.muted{color:#6b5b7c}.totals td{border:none;padding:3px 8px}.void{color:#b00020;font-weight:700}
</style></head><body>
<h1>Statement — not a tax invoice</h1>
<p class="muted">Each bill below was charged on account at the till; its tax invoice is the fiscal receipt numbered on its line.</p>
${inv.status === 'void' ? '<p class="void">This statement has been voided.</p>' : ''}
<table class="totals"><tr><td><strong>${escapeHtml(company?.name ?? '')}</strong></td><td style="text-align:right"><strong>${escapeHtml(inv.number)}</strong></td></tr>
<tr><td>To: ${clientName}${account?.number ? ` (${escapeHtml(account.number)})` : ''}</td><td style="text-align:right">Issued ${dayOf(inv.issueDate)}</td></tr>
${account?.address ? `<tr><td>${escapeHtml(account.address)}</td><td></td></tr>` : ''}
${inv.customerNtn ? `<tr><td>NTN: ${escapeHtml(inv.customerNtn)}</td><td></td></tr>` : ''}
<tr><td>Period: ${from} to ${to}</td><td style="text-align:right">Due ${dayOf(inv.dueDate)}</td></tr></table>
<h2>Bills</h2>
<table><thead><tr><th>Date</th><th>Order</th><th>Brand</th><th>Card</th><th>Reference</th><th>Fiscal no.</th><th style="text-align:right">Amount</th><th style="text-align:right">Refunded</th><th style="text-align:right">Net</th></tr></thead>
<tbody>${lines.join('\n')}</tbody></table>
<table class="totals" style="margin-top:12px;width:auto;margin-left:auto">
<tr><td>This statement</td><td style="text-align:right">${pkr(total)}</td></tr>
<tr><td class="muted">of which sales tax</td><td style="text-align:right" class="muted">${pkr(toCents(inv.taxCents))}</td></tr>
${toCents(inv.paidCents) + toCents(inv.creditedCents) + toCents(inv.whtCents) + toCents(inv.writtenOffCents) !== 0
    ? `<tr><td>Paid / credited since</td><td style="text-align:right">−${pkr(total - thisCents)}</td></tr>`
    : ''}
<tr><td>Previous balance</td><td style="text-align:right">${pkr(previousCents)}</td></tr>
<tr><td><strong>Total due</strong></td><td style="text-align:right"><strong>${pkr(dueCents)}</strong></td></tr>
<tr><td>Due date</td><td style="text-align:right">${dayOf(inv.dueDate)}</td></tr></table>
${bankLines.length ? `<h2>Pay to</h2><ul>${bankLines.join('')}</ul>` : ''}
<p class="muted">Please quote ${escapeHtml(inv.number)} as the payment reference.</p>
</body></html>`
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function statementRoutes(app: FastifyInstance): Promise<void> {
  const viewers = { preHandler: requireAuth(...CLIENT_VIEWERS) }
  const editors = { preHandler: requireAuth(...CLIENT_EDITORS) }
  const IssueBody = z.object({ periodTo: dayStr, issueDate: dayStr.optional() })

  // ── One client ──
  app.post<{ Params: { id: string } }>('/:id/statements', editors, async (req, reply) => {
    const body = IssueBody.parse(req.body)
    const a = await findAccount(req, req.params.id, 'write')
    const done = await issueStatement(a.id, { ...body, actor: { id: req.staffUser!.id } })
    await audit({
      category: 'accounting', action: 'on_account.statement.issue', entity: 'ReceivableInvoice', entityId: done.invoice.id,
      tenantId: a.tenantId, ...actorOf(req), after: done.invoice,
      metadata: { accountId: a.id, chargeIds: done.chargeIds, notBookedCount: done.notBookedCount },
    })
    return reply.status(201).send({ ...statementView(done.invoice), chargeCount: done.chargeIds.length, notBookedCount: done.notBookedCount })
  })

  // ── Every client of the ACTIVE company (or the ones named) ──
  app.post('/statements/issue', editors, async (req) => {
    const body = IssueBody.extend({ accountIds: z.array(z.string().min(1).max(64)).min(1).max(500).optional() }).parse(req.body)
    const tenantId = activeTenantId(req, 'statements are issued for one company at a time')
    const ids = body.accountIds ? [...new Set(body.accountIds)] : null
    const accounts = await prisma.customerAccount.findMany({
      where: { tenantId, ...(ids ? { id: { in: ids } } : {}) },
      orderBy: { number: 'asc' },
      select: { id: true, number: true, legalName: true },
    })
    if (ids && accounts.length !== ids.length) {
      const missing = ids.find((id) => !accounts.some((a) => a.id === id))!
      throw new NotFoundError('CustomerAccount', missing)
    }
    const created: Array<{ accountId: string; accountNumber: string; invoiceId: string; number: string; totalCents: number; chargeCount: number }> = []
    const skipped: Array<{ accountId: string; accountNumber: string; code: string; message: string }> = []
    for (const a of accounts) {
      try {
        const done = await issueStatement(a.id, { periodTo: body.periodTo, issueDate: body.issueDate, actor: { id: req.staffUser!.id } })
        created.push({
          accountId: a.id, accountNumber: a.number, invoiceId: done.invoice.id, number: done.invoice.number,
          totalCents: totalOf(done.invoice), chargeCount: done.chargeIds.length,
        })
        await audit({
          category: 'accounting', action: 'on_account.statement.issue', entity: 'ReceivableInvoice', entityId: done.invoice.id,
          tenantId, ...actorOf(req), after: done.invoice,
          metadata: { accountId: a.id, chargeIds: done.chargeIds, notBookedCount: done.notBookedCount, bulk: true },
        })
      } catch (err) {
        if (!(err instanceof AppError)) throw err
        skipped.push({ accountId: a.id, accountNumber: a.number, code: err.code, message: err.message })
      }
    }
    return { periodTo: body.periodTo, created, skipped }
  })

  // ── Printable ──
  // ?format=csv|xlsx|pdf: the same statement as a file (same viewers and scope).
  app.get<{ Params: { invoiceId: string }; Querystring: { format?: string } }>('/statements/:invoiceId/html', viewers, async (req, reply) => {
    const inv = await findStatement(req, req.params.invoiceId, 'read')
    const format = exportFormatOf(req.query.format)
    if (format) return sendReport(reply, format, `statement-${inv.number}`, await statementReport(inv))
    return reply.type('text/html; charset=utf-8').send(await renderStatementHtml(inv))
  })

  // ── Email it to the client ──
  app.post<{ Params: { invoiceId: string } }>('/statements/:invoiceId/send', editors, async (req) => {
    const inv = await findStatement(req, req.params.invoiceId, 'write')
    if (inv.status === 'void') throw new AppError('INVOICE_VOID', 'This statement has been voided', 409)
    const account = inv.customerAccountId
      ? await prisma.customerAccount.findFirst({ where: { id: inv.customerAccountId, tenantId: inv.tenantId } })
      : null
    const to = account?.contactEmail?.trim() || inv.customerEmail?.trim() || null
    if (!to) throw new AppError('NO_EMAIL', 'This client has no contact email — add one first', 422)
    const [company, replyTo, testCompany, html] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: inv.tenantId }, select: { name: true } }),
      companyReplyTo(inv.tenantId, account?.conceptIds ?? []),
      isTestTenant(inv.tenantId),
      renderStatementHtml(inv),
    ])
    try {
      await sendEmail({
        to,
        subject: `${company?.name ?? 'servd'} — statement ${inv.number}`,
        html,
        replyTo,
        scope: customerScope(inv.tenantId),
      })
    } catch (err) {
      throw new AppError('EMAIL_FAILED', `The statement could not be sent: ${(err as Error).message}`, 502)
    }
    await audit({
      category: 'accounting', action: 'on_account.statement.send', entity: 'ReceivableInvoice', entityId: inv.id,
      tenantId: inv.tenantId, ...actorOf(req),
      metadata: { to, number: inv.number, accountId: inv.customerAccountId, testCompany },
    })
    // A test company and the practice copy send nothing — said plainly.
    const skipped = isSandbox() ? 'practice' as const : testCompany ? 'test_company' as const : null
    return { sent: skipped === null, ...(skipped ? { skipped } : {}), to, number: inv.number }
  })
}
