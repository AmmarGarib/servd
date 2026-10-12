import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { requireCustomerAuth } from '../auth/middleware.js'
import { findCustomerInScope, customerIdsInScope, tenantIdsOf } from '../crm/customerScope.js'
import { activeTenantId, scopeTenantWhere } from '../../lib/tenantScope.js'
import { topUpWallet, walletBalancesOf, balanceInView, type TopUpTender } from './service.js'

// The wallet is per company (ONL-R2-01): a top-up credits the ACTIVE company's
// wallet of the customer and posts there (modules/wallet/service.ts); reads
// show the wallets of the companies in view only.

const topUpKind = z.object({
  // goodwill = a manager's credit (Dr 6060 Marketing & Promo); paid = the
  // customer paid for it, at the tender (Dr 1010 cash / 1030 card / 1020 bank).
  kind: z.enum(['goodwill', 'paid']).default('goodwill'),
  tender: z.enum(['cash', 'card', 'bank']).optional(),
}).refine((d) => d.kind !== 'paid' || !!d.tender, { message: 'a paid top-up needs its tender (cash, card or bank)', path: ['tender'] })

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
  fastify.post<{ Body: { customerId: string; amountCents: number; description?: string; kind?: string; tender?: string } }>(
    '/topup',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        customerId: z.string().uuid(),
        amountCents: z.number().int().positive().max(100_000_000),
        description: z.string().max(300).optional(),
      }).and(topUpKind).parse(req.body)

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
        description: body.description ?? (body.kind === 'paid' ? 'Paid top-up' : 'Admin top-up'),
        postedBy: req.staffUser!.id,
      })
      return reply.status(201).send({ newBalance: r.balanceAfter, tenantId, transactionId: r.transactionId, entryId: r.entryId })
    },
  )

  // POST /wallet/bulk-topup — credit several customers at the active company.
  fastify.post<{ Body: { customerIds: string[]; amountCents: number; description?: string; kind?: string; tender?: string } }>(
    '/bulk-topup',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        customerIds: z.array(z.string().uuid()).min(1).max(500),
        amountCents: z.number().int().positive().max(100_000_000),
        description: z.string().max(300).optional(),
      }).and(topUpKind).parse(req.body)

      const tenantId = activeTenantId(req, 'a wallet top-up is booked in one company')
      // Customers the active company has never served are skipped, not credited.
      const allowed = await customerIdsInScope(req, [...new Set(body.customerIds)], 'create')
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
      return { success, total: body.customerIds.length, failed }
    },
  )

  // GET /wallet/customers/:id — staff: the customer's wallets at the companies
  // in view, and their history. Another company's wallet is not ours to show.
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/customers/:id',
    { preHandler: requireAuth(...MANAGERS) },
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
