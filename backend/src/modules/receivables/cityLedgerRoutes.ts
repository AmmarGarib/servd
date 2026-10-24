// City Ledger doors (owner, 2026-10-24) — the rules are in cityLedger.ts.
//
// Back office, under /accounting/customer-accounts (registered by
// customerAccounts.ts; module 'accounting'):
//   GET  /:id/bills?open=1&from&to   the client's bills with what each owes,
//                                    its due day and status (CLIENT_VIEWERS)
//   GET  /:id/history                every bill, refund, settlement, statement
//                                    payment and write-off, running balance
//   GET  /:id/settlements            its City Ledger settlements
//   POST /:id/settlements            {allocations, method, reference,
//                                    bankAccountId?, receivedAt, note?,
//                                    idempotencyKey?} (CLIENT_EDITORS)
//   POST /settlements/:sid/reverse   {reason ≥10} (CLIENT_EDITORS)
//   GET  /settlements/:sid/receipt   printable receipt (HTML)
//
// The till, under /pos (no module gate, like the till's tenders; CASHIERS):
//   GET  /city-ledger/accounts?q     active clients of the caller's company,
//                                    with what each owes and has left
//   GET  /city-ledger/accounts/:id/bills   the bills that can be settled now
//   POST /city-ledger/settlements    {accountId, shiftId, allocations, method
//                                    cash|bank_transfer, reference?,
//                                    bankAccountId?, idempotencyKey}
//   GET  /city-ledger/settlements/:sid/receipt
//
// Company scope: a client of another company is 404 everywhere ('write' for
// changes); a till settlement lands on an OPEN drawer of the CLIENT's company
// that the caller may use (assertShiftOf + assertDrawerOperator).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { CustomerAccount } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, CASHIERS } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, resolveTenantScope, assertShiftOf, type ScopeMode } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { toCents } from '../../lib/money.js'
import { zPaymentRef, RECEIPT_METHOD_LABEL } from '../../lib/bankAccounts.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { karachiDay } from '../../connectors/util.js'
import { parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import { assertDrawerOperator } from '../pos/service.js'
import { CLIENT_EDITORS, CLIENT_VIEWERS, exposureOfTx } from './onAccount.js'
import {
  ACCOUNT_TYPE_LABEL, OFFICE_SETTLE_METHODS, TILL_SETTLE_METHODS, clientBills, clientHistory, reverseSettlement, settleBills,
  type AccountType,
} from './cityLedger.js'

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const uuid = z.string().uuid()
const allocations = z.array(z.object({ chargeId: uuid, amountCents: z.number().int().positive() })).min(1).max(200)
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function findClient(req: FastifyRequest, id: string, mode: ScopeMode): Promise<CustomerAccount> {
  const p = uuid.safeParse(id)
  if (!p.success) throw new NotFoundError('CustomerAccount', id)
  const a = await prisma.customerAccount.findFirst({ where: { id: p.data, ...(await scopeTenantWhere(req, mode)) } })
  if (!a) throw new NotFoundError('CustomerAccount', id)
  return a
}

async function settlementsOf(account: CustomerAccount) {
  const rows = await prisma.cityLedgerSettlement.findMany({
    where: { tenantId: account.tenantId, accountId: account.id },
    include: { allocations: { include: { charge: { select: { orderId: true } } } } },
    orderBy: { receivedAt: 'desc' },
    take: 500,
  })
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.createdById, r.reversedById ?? '']).filter(Boolean))] } }, select: { id: true, name: true } })
  const nameOf = new Map(users.map((u) => [u.id, u.name]))
  return rows.map((s) => settlementView(s, nameOf))
}

type SettlementRow = Awaited<ReturnType<typeof prisma.cityLedgerSettlement.findFirstOrThrow>> & {
  allocations: Array<{ chargeId: string; amountCents: number; charge?: { orderId: string } }>
}
function settlementView(s: SettlementRow, nameOf: Map<string, string | null> = new Map()) {
  return {
    id: s.id, number: s.number, accountId: s.accountId, amountCents: toCents(s.amountCents), method: s.method,
    methodLabel: RECEIPT_METHOD_LABEL[s.method] ?? s.method, reference: s.reference, bankAccountId: s.bankAccountId,
    receivedAt: s.receivedAt, channel: s.channel, shiftId: s.shiftId, moneyAccountCode: s.moneyAccountCode, note: s.note,
    createdById: s.createdById, createdByName: nameOf.get(s.createdById) ?? null, createdAt: s.createdAt,
    reversedAt: s.reversedAt, reversedReason: s.reversedReason, reversedByName: s.reversedById ? nameOf.get(s.reversedById) ?? null : null,
    voucher: `cityledger.settlement:${s.id}`,
    allocations: s.allocations.map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents, orderRef: a.charge ? orderRefOf(a.charge.orderId) : null, orderId: a.charge?.orderId ?? null })),
  }
}

async function receiptHtml(settlementId: string, tenantIds: string[]): Promise<string> {
  const s = await prisma.cityLedgerSettlement.findFirst({
    where: { id: settlementId, tenantId: { in: tenantIds } },
    include: { allocations: { include: { charge: true } }, account: true },
  })
  if (!s) throw new NotFoundError('CityLedgerSettlement', settlementId)
  const [company, exposure] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: s.tenantId }, select: { name: true } }),
    exposureOfTx(prisma, s.accountId),
  ])
  const rows = s.allocations.map((a) => {
    const owed = a.charge.amountCents - a.charge.refundedCents - a.charge.settledCents
    return `<tr><td>#${escapeHtml(orderRefOf(a.charge.orderId))}</td><td>${karachiDay(a.charge.chargedAt)}</td><td style="text-align:right">${pkr(a.charge.amountCents - a.charge.refundedCents)}</td><td style="text-align:right">${pkr(a.amountCents)}</td><td style="text-align:right">${pkr(Math.max(0, owed))}</td></tr>`
  }).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(s.number)}</title>
<style>body{font-family:system-ui,sans-serif;color:#261038;max-width:640px;margin:24px auto;padding:0 16px}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}td,th{border-bottom:1px solid #e5dcef;padding:6px;text-align:left}.muted{color:#6b5b7c;font-size:12px}</style></head><body>
<p class="muted">${escapeHtml(company?.name ?? '')}</p>
<h1>City Ledger receipt ${escapeHtml(s.number)}</h1>
<p>${escapeHtml(s.account.number)} · ${escapeHtml(s.account.legalName)}<br>
Received ${karachiDay(s.receivedAt)} · ${escapeHtml(RECEIPT_METHOD_LABEL[s.method] ?? s.method)}${s.reference ? ` · ref ${escapeHtml(s.reference)}` : ''}</p>
${s.reversedAt ? `<p><strong>REVERSED</strong> ${karachiDay(s.reversedAt)} — ${escapeHtml(s.reversedReason ?? '')}</p>` : ''}
<table><thead><tr><th>Bill</th><th>Date</th><th style="text-align:right">Bill amount</th><th style="text-align:right">Paid now</th><th style="text-align:right">Still owed</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><th colspan="3">Total received</th><th style="text-align:right">${pkr(toCents(s.amountCents))}</th><th></th></tr></tfoot></table>
<p>Balance owed on the account now: <strong>${pkr(exposure.exposureCents - exposure.creditCents)}</strong></p>
<p class="muted">Not a tax invoice — each bill's tax invoice is its own receipt.</p>
</body></html>`
}

const actorOf = (req: FastifyRequest) => ({ userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null })

/** Child plugin of /accounting/customer-accounts. */
export async function cityLedgerBackOfficeRoutes(app: FastifyInstance): Promise<void> {
  const viewers = { preHandler: requireAuth(...CLIENT_VIEWERS) }
  const editors = { preHandler: requireAuth(...CLIENT_EDITORS) }

  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>('/:id/bills', viewers, async (req) => {
    const a = await findClient(req, req.params.id, 'read')
    const q = z.object({ open: z.enum(['0', '1']).optional(), from: dateStr.optional(), to: dateStr.optional() }).parse(req.query)
    const bills = await clientBills(prisma, a, {
      onlyOpen: q.open === '1', includeOwedBack: true,
      ...(q.from && { from: parsePktStartOfDay(q.from) }), ...(q.to && { to: parsePktEndOfDay(q.to) }),
    })
    return { items: bills, owedCents: bills.reduce((t, b) => t + Math.max(0, b.owedCents), 0) }
  })

  app.get<{ Params: { id: string } }>('/:id/history', viewers, async (req) => {
    const a = await findClient(req, req.params.id, 'read')
    const rows = await clientHistory(prisma, a)
    const exposure = await exposureOfTx(prisma, a.id)
    return { items: rows, balanceCents: exposure.exposureCents - exposure.creditCents }
  })

  app.get<{ Params: { id: string } }>('/:id/settlements', viewers, async (req) => {
    const a = await findClient(req, req.params.id, 'read')
    return { items: await settlementsOf(a) }
  })

  app.post<{ Params: { id: string } }>('/:id/settlements', editors, async (req, reply) => {
    const a = await findClient(req, req.params.id, 'write')
    const body = z.object({
      allocations,
      method: z.enum(OFFICE_SETTLE_METHODS),
      reference: zPaymentRef.nullable().optional(),
      bankAccountId: z.string().min(1).nullable().optional(),
      receivedAt: dateStr,
      note: z.string().trim().max(500).optional(),
      idempotencyKey: z.string().min(8).max(100),
      /** 'out' = pay back money a bill owes back (refunded after it was paid). */
      direction: z.enum(['in', 'out']).default('in'),
    }).parse(req.body)
    const r = await settleBills({
      account: a, allocations: body.allocations, method: body.method, reference: body.reference ?? null,
      bankAccountId: body.bankAccountId ?? null, receivedAt: new Date(`${body.receivedAt}T12:00:00+05:00`), channel: 'back_office',
      note: body.note ?? null, idempotencyKey: body.idempotencyKey, actorId: req.staffUser!.id, direction: body.direction,
    })
    if (!r.replayed) {
      await audit({
        category: 'accounting', action: 'city_ledger.settlement', entity: 'CityLedgerSettlement', entityId: r.settlement.id,
        tenantId: a.tenantId, ...actorOf(req),
        after: { number: r.settlement.number, accountId: a.id, amountCents: toCents(r.settlement.amountCents), method: body.method, channel: 'back_office', direction: body.direction, allocations: body.allocations },
      })
    }
    return reply.status(r.replayed ? 200 : 201).send({ settlement: settlementView(r.settlement), replayed: r.replayed })
  })

  app.post<{ Params: { sid: string } }>('/settlements/:sid/reverse', editors, async (req) => {
    const body = z.object({
      reason: z.string().trim().min(10, 'Say why in at least 10 characters').max(500),
      // Till cash whose drawer has closed: where the money goes back out from (default cash on hand).
      refundFrom: z.object({ method: z.enum(OFFICE_SETTLE_METHODS), bankAccountId: z.string().min(1).nullable().optional() }).optional(),
    }).parse(req.body)
    const sid = uuid.safeParse(req.params.sid)
    if (!sid.success) throw new NotFoundError('CityLedgerSettlement', req.params.sid)
    const tenantIds = (await resolveTenantScope(req)).tenantIds
    const s = await reverseSettlement({ settlementId: sid.data, tenantIds, reason: body.reason, actorId: req.staffUser!.id, refundFrom: body.refundFrom ?? null })
    await audit({
      category: 'accounting', action: 'city_ledger.settlement_reverse', entity: 'CityLedgerSettlement', entityId: s.id,
      tenantId: s.tenantId, ...actorOf(req), after: { number: s.number, reason: body.reason },
    })
    return { settlement: settlementView({ ...s, allocations: [] }) }
  })

  app.get<{ Params: { sid: string } }>('/settlements/:sid/receipt', viewers, async (req, reply) => {
    const sid = uuid.safeParse(req.params.sid)
    if (!sid.success) throw new NotFoundError('CityLedgerSettlement', req.params.sid)
    const html = await receiptHtml(sid.data, (await resolveTenantScope(req)).tenantIds)
    return reply.type('text/html; charset=utf-8').send(html)
  })
}

/** Registered under /pos (index.ts). */
export default async function posCityLedgerRoutes(app: FastifyInstance): Promise<void> {
  const till = { preHandler: requireAuth(...CASHIERS) }

  app.get<{ Querystring: { q?: string } }>('/city-ledger/accounts', till, async (req) => {
    const q = (req.query.q ?? '').trim().slice(0, 100)
    const rows = await prisma.customerAccount.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'write')),
        status: 'active',
        ...(q && { OR: [{ legalName: { contains: q, mode: 'insensitive' } }, { tradeName: { contains: q, mode: 'insensitive' } }, { number: { contains: q, mode: 'insensitive' } }] }),
      },
      orderBy: { legalName: 'asc' },
      take: 50,
    })
    return {
      items: await Promise.all(rows.map(async (a) => {
        const e = await exposureOfTx(prisma, a.id)
        const limit = toCents(a.creditLimitCents)
        return {
          id: a.id, number: a.number, legalName: a.legalName, tradeName: a.tradeName, accountType: a.accountType,
          accountTypeLabel: ACCOUNT_TYPE_LABEL[a.accountType as AccountType] ?? a.accountType,
          conceptIds: a.conceptIds, requiresReference: a.requiresReference,
          creditLimitCents: limit, owedCents: e.exposureCents, availableCents: Math.max(0, limit - e.exposureCents),
          overdue: e.overdue, creditCents: e.creditCents,
        }
      })),
    }
  })

  app.get<{ Params: { id: string } }>('/city-ledger/accounts/:id/bills', till, async (req) => {
    const a = await findClient(req, req.params.id, 'write')
    const bills = await clientBills(prisma, a, { onlyOpen: true })
    return { items: bills, owedCents: bills.reduce((t, b) => t + Math.max(0, b.owedCents), 0) }
  })

  app.post('/city-ledger/settlements', till, async (req, reply) => {
    const body = z.object({
      accountId: uuid,
      shiftId: uuid,
      allocations,
      method: z.enum(TILL_SETTLE_METHODS),
      reference: zPaymentRef.nullable().optional(),
      bankAccountId: z.string().min(1).nullable().optional(),
      idempotencyKey: z.string().min(8).max(100),
      /** Bank transfer: the cashier saw the credit on the counter device. */
      transferVerified: z.boolean().optional(),
    }).parse(req.body)
    const a = await findClient(req, body.accountId, 'write')
    // The drawer: an OPEN shift of the CLIENT's company, the caller's own unless a manager.
    await assertShiftOf(a.tenantId, body.shiftId, true)
    await assertDrawerOperator(body.shiftId, req.staffUser!)
    const r = await settleBills({
      account: a, allocations: body.allocations, method: body.method, reference: body.reference ?? null,
      bankAccountId: body.bankAccountId ?? null, receivedAt: new Date(), channel: 'till', shiftId: body.shiftId,
      idempotencyKey: body.idempotencyKey, actorId: req.staffUser!.id, transferVerified: body.transferVerified,
    })
    if (!r.replayed) {
      await audit({
        category: 'accounting', action: 'city_ledger.settlement', entity: 'CityLedgerSettlement', entityId: r.settlement.id,
        tenantId: a.tenantId, ...actorOf(req),
        after: { number: r.settlement.number, accountId: a.id, amountCents: toCents(r.settlement.amountCents), method: body.method, channel: 'till', transferVerified: body.transferVerified ?? false, shiftId: body.shiftId, allocations: body.allocations },
      })
    }
    const e = await exposureOfTx(prisma, a.id)
    return reply.status(r.replayed ? 200 : 201).send({ settlement: settlementView(r.settlement), replayed: r.replayed, owedCents: e.exposureCents - e.creditCents })
  })

  app.get<{ Params: { sid: string } }>('/city-ledger/settlements/:sid/receipt', till, async (req, reply) => {
    const sid = uuid.safeParse(req.params.sid)
    if (!sid.success) throw new NotFoundError('CityLedgerSettlement', req.params.sid)
    const html = await receiptHtml(sid.data, (await resolveTenantScope(req)).tenantIds)
    return reply.type('text/html; charset=utf-8').send(html)
  })
}
