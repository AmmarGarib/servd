import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import type { FastifyRequest } from 'fastify'
import { requireAuth, MANAGERS, FINANCE_TEAM } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { AppError } from '../../lib/errors.js'
import { requireCustomerAuth } from '../auth/middleware.js'
import { findCustomerInScope, customerIdsInScope, tenantIdsOf, customerOfCompanies } from '../crm/customerScope.js'
import { activeTenantId, scopeTenantWhere } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { zReceiptMethod, zPaymentRef, isBankMethod, assertPaymentReference } from '../../lib/bankAccounts.js'
import { findPaymentReferenceUses } from '../../lib/paymentRefs.js'
import { topUpWallet, walletBalancesOf, balanceInView, TOPUP_TENDERS, type TopUpTender } from './service.js'

// The wallet is per company (ONL-R2-01): a top-up credits the ACTIVE company's
// wallet of the customer and posts there (modules/wallet/service.ts); reads
// show the wallets of the companies in view only.

const topUpKind = z.object({
  // goodwill = a manager's credit (Dr 6060 Marketing & Promo); paid = the
  // customer paid for it (Dr 1010 cash / the bank account of the
  // ACTIVE company it was received into — lib/bankAccounts.ts moneyAccountCode).
  kind: z.enum(['goodwill', 'paid']).default('goodwill'),
  // RECEIPT_METHODS (owner, 2026-10-14: + bank deposit, cheque). The old
  // 'bank' still reads as bank_transfer (earlier admin builds sent it).
  tender: z.preprocess((v) => (v === 'bank' ? 'bank_transfer' : v), zReceiptMethod(TOPUP_TENDERS)).optional(),
  // A paid top-up's payment reference # — required on every tender (422
  // PAYMENT_REFERENCE_REQUIRED, service); a goodwill credit takes none.
  paymentRef: zPaymentRef.nullable().optional(),
  // A bank-type tender: which of the company's bank accounts. Omitted → its
  // only bank (422 BANK_ACCOUNT_REQUIRED when it has two or more); another
  // company's or an unlinked one → 422.
  bankAccountId: z.string().min(1).nullable().optional(),
})
  .refine((d) => d.kind !== 'paid' || !!d.tender, { message: 'a paid top-up needs its tender (cash, bank transfer, bank deposit or cheque)', path: ['tender'] })
  .refine((d) => !d.bankAccountId || (d.kind === 'paid' && isBankMethod(d.tender)), { message: 'a bank account goes with a top-up paid into a bank only (transfer, deposit or cheque)', path: ['bankAccountId'] })
  .refine((d) => d.kind === 'paid' || !d.paymentRef, { message: 'a goodwill credit has no payment reference', path: ['paymentRef'] })

// Who records a top-up (owner, 2026-10-16: finance records paid wallet
// top-ups — a back-office receipt like a gift-card sale). Managers record both
// kinds; finance (with its 'accounting' module) records PAID top-ups only — a
// goodwill credit is our own cost (Dr 6060) and stays a manager's call (403
// GOODWILL_MANAGERS_ONLY). Every top-up is audited (wallet.topup /
// wallet.bulk_topup) with the actor.
const TOPUP_RECORDERS = FINANCE_TEAM
const MANAGER_ROLES = new Set<string>(MANAGERS)
const TOPUP_GUARD = [
  requireAuth(...TOPUP_RECORDERS),
  async (req: FastifyRequest) => { if (req.staffUser?.role === 'finance') await requireModule('accounting')(req) },
]
function assertMayCredit(req: FastifyRequest, kind: 'goodwill' | 'paid') {
  if (kind === 'goodwill' && !MANAGER_ROLES.has(req.staffUser!.role)) {
    throw new AppError('GOODWILL_MANAGERS_ONLY', 'A goodwill credit is a manager\'s call — finance records paid top-ups only', 403)
  }
}

export async function walletRoutes(fastify: FastifyInstance) {
  // GET /wallet/me — customer: the wallet at ONE company (the company of
  // ?conceptSlug=, else the company they last ordered from) with its history,
  // plus every company's balance.
  fastify.get<{ Querystring: { conceptSlug?: string } }>('/me', { preHandler: requireCustomerAuth }, async (req) => {
    const customerId = req.customer!.id
    const { loyaltyCompanyOf, companyOfConceptSlug } = await import('../loyalty/service.js')
    const tenantId = (await companyOfConceptSlug(req.query.conceptSlug)) ?? (await loyaltyCompanyOf(customerId))
    const all = await prisma.customerWallet.findMany({
      where: { customerId },
      select: { tenantId: true, balanceCents: true },
      orderBy: { createdAt: 'asc' },
    })
    const history = tenantId
      ? await prisma.walletTransaction.findMany({
          where: { customerId, tenantId },
          orderBy: { createdAt: 'desc' },
          take: 30,
        })
      : []
    return {
      tenantId,
      balance: Math.max(0, all.find((w) => w.tenantId === tenantId)?.balanceCents ?? 0),
      wallets: all,
      history,
    }
  })

  // POST /wallet/topup — staff: credit a customer's wallet AT THE ACTIVE
  // COMPANY, booked in that company in the same transaction.
  //   body: customerId, amountCents, kind, tender (RECEIPT_METHODS), paymentRef
  //         (paid: required), bankAccountId (bank-type tender only).
  //   201:  { newBalance, tenantId, transactionId, entryId, referenceUsedBefore }
  fastify.post<{ Body: { customerId: string; amountCents: number; description?: string; kind?: string; tender?: string; paymentRef?: string | null; bankAccountId?: string | null } }>(
    '/topup',
    { preHandler: TOPUP_GUARD },
    async (req, reply) => {
      const body = z.object({
        customerId: z.string().uuid(),
        amountCents: z.number().int().positive().max(100_000_000),
        description: z.string().max(300).optional(),
      }).and(topUpKind).parse(req.body)
      assertMayCredit(req, body.kind)

      // Only a customer of the ACTIVE company (ordered or booked at one of its
      // brands); anyone else is a 404, so a foreign id is not confirmed.
      await findCustomerInScope(req, body.customerId, 'create')
      const tenantId = activeTenantId(req, 'a wallet top-up is booked in one company')

      const r = await topUpWallet({
        tenantId,
        customerId: body.customerId,
        amountCents: body.amountCents,
        kind: body.kind,
        tender: body.tender as TopUpTender | undefined,
        paymentRef: body.paymentRef ?? null,
        bankAccountId: body.bankAccountId,
        description: body.description ?? (body.kind === 'paid' ? 'Paid top-up' : 'Admin top-up'),
        postedBy: req.staffUser!.id,
      })
      await audit({
        category: 'accounting', action: 'wallet.topup', entity: 'WalletTransaction', entityId: r.transactionId,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
        after: { customerId: body.customerId, amountCents: body.amountCents, kind: body.kind, tender: body.tender ?? null, paymentRef: body.paymentRef?.trim() || null, bankAccountId: body.bankAccountId ?? null },
      })
      // Where else THIS company recorded the same reference — saved anyway.
      const referenceUsedBefore = body.kind === 'paid'
        ? await findPaymentReferenceUses(prisma, tenantId, body.paymentRef, { exclude: { kind: 'wallet_topup', id: r.transactionId } })
        : []
      return reply.status(201).send({ newBalance: r.balanceAfter, tenantId, transactionId: r.transactionId, entryId: r.entryId, referenceUsedBefore })
    },
  )

  // POST /wallet/bulk-topup — credit several customers at the active company.
  // A paid batch takes ONE payment reference # for every customer in it (one
  // payment covering the batch — e.g. a corporate client's transfer); each
  // top-up stores it. `referenceUsedBefore` lists uses from BEFORE this
  // batch (the batch's own rows are not a warning).
  fastify.post<{ Body: { customerIds: string[]; amountCents: number; description?: string; kind?: string; tender?: string; paymentRef?: string | null; bankAccountId?: string | null } }>(
    '/bulk-topup',
    { preHandler: TOPUP_GUARD },
    async (req) => {
      const body = z.object({
        customerIds: z.array(z.string().uuid()).min(1).max(500),
        amountCents: z.number().int().positive().max(100_000_000),
        description: z.string().max(300).optional(),
      }).and(topUpKind).parse(req.body)
      assertMayCredit(req, body.kind)

      const tenantId = activeTenantId(req, 'a wallet top-up is booked in one company')
      // Customers the active company has never served are skipped, not credited.
      const allowed = await customerIdsInScope(req, [...new Set(body.customerIds)], 'create')
      // A paid batch without its reference is refused whole (422), not
      // customer by customer.
      if (body.kind === 'paid') assertPaymentReference(body.tender, body.paymentRef)
      // Read before the batch writes, so its own rows are not "used before".
      const referenceUsedBefore = body.kind === 'paid'
        ? await findPaymentReferenceUses(prisma, tenantId, body.paymentRef)
        : []
      let success = 0
      const failed: Array<{ customerId: string; error: string }> = []
      for (const id of new Set(body.customerIds)) {
        if (!allowed.has(id)) continue
        try {
          await topUpWallet({
            tenantId,
            customerId: id,
            amountCents: body.amountCents,
            kind: body.kind,
            tender: body.tender as TopUpTender | undefined,
            paymentRef: body.paymentRef ?? null,
            bankAccountId: body.bankAccountId,
            description: body.description ?? 'Bulk top-up',
            postedBy: req.staffUser!.id,
          })
          success++
        } catch (err) {
          // Nothing moved for this customer (credit and posting are one
          // transaction); say why rather than dropping it silently.
          failed.push({ customerId: id, error: (err as { code?: string; message?: string }).code ?? (err as Error).message })
        }
      }
      if (success > 0) {
        await audit({
          category: 'accounting', action: 'wallet.bulk_topup', entity: 'WalletTransaction',
          userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
          after: { credited: success, amountCents: body.amountCents, kind: body.kind, tender: body.tender ?? null, paymentRef: body.paymentRef?.trim() || null, bankAccountId: body.bankAccountId ?? null },
        })
      }
      return { success, total: body.customerIds.length, failed, referenceUsedBefore: success > 0 ? referenceUsedBefore : [] }
    },
  )

  // GET /wallet/customers?q= — find the customer to top up (finance's Wallet
  // top-ups page; finance holds no CRM module). Only customers of the ACTIVE
  // company (the company a top-up is booked in); name, phone or email, at
  // least 3 characters, 20 at most, with their wallet there.
  fastify.get<{ Querystring: { q?: string } }>(
    '/customers',
    { preHandler: TOPUP_GUARD },
    async (req) => {
      const q = z.string().trim().min(3).max(100).parse(req.query.q ?? '')
      const tenantId = activeTenantId(req, 'a wallet top-up is booked in one company')
      const rows = await prisma.customer.findMany({
        where: {
          deletedAt: null,
          ...customerOfCompanies({ tenantId }),
          AND: [{ OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
            { email: { contains: q, mode: 'insensitive' } },
          ] }],
        },
        select: { id: true, name: true, phone: true, email: true },
        orderBy: { name: 'asc' },
        take: 20,
      })
      const balances = await walletBalancesOf(rows.map((r) => r.id), [tenantId])
      return {
        tenantId,
        customers: rows.map((r) => ({ ...r, walletBalanceCents: balances.get(r.id)?.get(tenantId) ?? 0 })),
      }
    },
  )

  // GET /wallet/customers/:id — staff: the customer's wallets at the companies
  // in view, and their history. Another company's wallet is not ours to show.
  // Finance reads it too (the wallet liability 2050 is theirs to reconcile).
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/customers/:id',
    { preHandler: TOPUP_GUARD },
    async (req) => {
      const limit = Math.min(Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50), 200)
      const found = await findCustomerInScope(req, req.params.id, 'read')
      const scope = tenantIdsOf(await scopeTenantWhere(req, 'read'))
      const balances = (await walletBalancesOf([found.id], scope)).get(found.id)
      const history = scope.length
        ? await prisma.walletTransaction.findMany({
            where: { customerId: found.id, tenantId: { in: scope } },
            orderBy: { createdAt: 'desc' },
            take: limit,
          })
        : []
      return {
        name: found.name,
        walletBalance: balanceInView(balances, scope),
        wallets: scope.filter((t) => balances?.has(t)).map((t) => ({ tenantId: t, balanceCents: balances!.get(t)! })),
        history,
      }
    },
  )
}
