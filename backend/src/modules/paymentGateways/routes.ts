import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, ForbiddenError } from '../../lib/errors.js'
import { assertConceptOwned } from '../../lib/tenantScope.js'

// Company scope. PaymentGatewayConfig has no tenantId column, so a config is
// scoped through its brand: a per-brand override (conceptId set) is reachable
// only when that brand is in the operator's scope (assertConceptOwned — a
// foreign brand is a 404). The conceptId-null row is ONE row shared by every
// company, so only an admin may write it. The proper fix is a tenantId column
// with one default row per company (CLAUDE.md singleton rule); until then the
// global row holds nothing secret — secrets live in env vars.
const conceptParam = z.string().uuid().optional()

// Catalogue of supported gateways. New providers go here — the UI auto-renders
// a config card for each entry. Secret env-var names are listed so the admin
// page can show "set R2_ACCESS_KEY_ID in your .env" without ever transmitting
// the actual secret.
const GATEWAYS = [
  {
    provider: 'cash',
    label: 'Cash',
    emoji: '💵',
    description: 'Physical cash, counted in shift drawer.',
    requiresMerchantId: false,
    requiresCallback: false,
    envVars: [],                   // no secrets — works out of the box
    fees: '0% — no processing fees',
    docsUrl: null,
  },
  {
    provider: 'keenu',
    label: 'Keenu (cards)',
    emoji: '💳',
    description: 'Card processing for Visa / MasterCard / UnionPay via Keenu PSP.',
    requiresMerchantId: true,
    requiresCallback: true,
    envVars: ['KEENU_MERCHANT_ID', 'KEENU_SECRET_KEY', 'KEENU_API_BASE_URL'],
    fees: '1.5% – 2.5% per transaction (negotiated with bank)',
    docsUrl: 'https://www.keenu.pk/business',
  },
  {
    provider: 'jazzcash',
    label: 'JazzCash',
    emoji: '📱',
    description: 'Mobile wallet payments. Customer enters CNIC + MPIN or scans QR.',
    requiresMerchantId: true,
    requiresCallback: true,
    envVars: ['JAZZCASH_MERCHANT_ID', 'JAZZCASH_PASSWORD', 'JAZZCASH_HASH_KEY', 'JAZZCASH_RETURN_URL'],
    fees: '1% – 2% per transaction',
    docsUrl: 'https://sandbox.jazzcash.com.pk/Sandbox/Documentation',
  },
  {
    provider: 'easypaisa',
    label: 'Easypaisa',
    emoji: '💚',
    description: 'Mobile wallet by Telenor. Wide reach in mass-market segments.',
    requiresMerchantId: true,
    requiresCallback: true,
    envVars: ['EASYPAISA_STORE_ID', 'EASYPAISA_HASH_KEY'],
    fees: '1% – 2% per transaction',
    docsUrl: 'https://easypaisa.com.pk/business',
  },
] as const

export async function paymentGatewayRoutes(fastify: FastifyInstance) {
  // GET /payment-gateways — catalogue + current config + env-var presence check
  // ?conceptId= → that brand's overrides layered over the global defaults.
  fastify.get<{ Querystring: { conceptId?: string } }>('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const conceptId = conceptParam.parse(req.query.conceptId || undefined)
    if (conceptId) await assertConceptOwned(req, conceptId, 'read')
    const configs = await prisma.paymentGatewayConfig.findMany({
      where: conceptId ? { OR: [{ conceptId: null }, { conceptId }] } : { conceptId: null },
    })
    // A brand override wins over the global row for the same provider.
    const byProvider = new Map<string, (typeof configs)[number]>()
    for (const c of configs) {
      if (c.conceptId === null && byProvider.has(c.provider)) continue
      byProvider.set(c.provider, c)
    }

    return GATEWAYS.map((gw) => {
      const cfg = byProvider.get(gw.provider)
      // For each env var, just check presence — never expose the value
      const envStatus = gw.envVars.map((name) => ({
        name,
        set: !!process.env[name],
      }))
      const allSecretsSet = envStatus.every((e) => e.set)

      return {
        ...gw,
        config: cfg ? {
          conceptId:   cfg.conceptId,
          isEnabled:   cfg.isEnabled,
          isLive:      cfg.isLive,
          merchantId:  cfg.merchantId,
          callbackUrl: cfg.callbackUrl,
          successUrl:  cfg.successUrl,
          failureUrl:  cfg.failureUrl,
          notes:       cfg.notes,
          updatedAt:   cfg.updatedAt,
        } : null,
        envStatus,
        ready: gw.envVars.length === 0 || allSecretsSet,
      }
    })
  })

  // PATCH /payment-gateways/:provider[?conceptId=] — update non-secret config.
  // With conceptId: that brand's override (brand must be in the operator's
  // companies). Without: the global row shared by every company — admin only.
  fastify.patch<{ Params: { provider: string }; Querystring: { conceptId?: string } }>(
    '/:provider',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      const provider = req.params.provider
      if (!GATEWAYS.some((g) => g.provider === provider)) {
        throw new AppError('UNKNOWN_PROVIDER', `'${provider}' is not in the gateway catalogue`, 404)
      }
      const conceptId = conceptParam.parse(req.query.conceptId || undefined) ?? null
      if (conceptId) await assertConceptOwned(req, conceptId, 'write')
      else if (req.staffUser?.role !== 'admin') {
        // Belt and braces: the route is admin-only today, but the shared row
        // must stay admin-only even if the route is ever opened to managers.
        throw new ForbiddenError('Only an admin may change the gateway defaults shared by every company')
      }

      const body = z.object({
        isEnabled:   z.boolean().optional(),
        isLive:      z.boolean().optional(),
        merchantId:  z.string().nullable().optional(),
        callbackUrl: z.string().url().nullable().optional(),
        successUrl:  z.string().url().nullable().optional(),
        failureUrl:  z.string().url().nullable().optional(),
        notes:       z.string().max(500).nullable().optional(),
      }).parse(req.body)

      // Compound-unique with nullable conceptId is unreliable in Prisma — do
      // findFirst + branch.
      const existing = await prisma.paymentGatewayConfig.findFirst({
        where: { provider, conceptId },
      })
      if (existing) {
        return prisma.paymentGatewayConfig.update({
          where: { id: existing.id },
          data: { ...body, updatedById: req.staffUser!.id },
        })
      }
      return prisma.paymentGatewayConfig.create({
        data: { provider, conceptId, ...body, updatedById: req.staffUser!.id },
      })
    },
  )
}
