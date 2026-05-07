import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'

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
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    const configs = await prisma.paymentGatewayConfig.findMany({
      where: { conceptId: null },        // global configs only for now
    })
    const byProvider = new Map(configs.map((c) => [c.provider, c]))

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

  // PATCH /payment-gateways/:provider — update non-secret config
  fastify.patch<{ Params: { provider: string } }>(
    '/:provider',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      const provider = req.params.provider
      if (!GATEWAYS.some((g) => g.provider === provider)) {
        return { error: { code: 'UNKNOWN_PROVIDER', message: `'${provider}' is not in the gateway catalogue` } }
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
        where: { provider, conceptId: null },
      })
      if (existing) {
        return prisma.paymentGatewayConfig.update({
          where: { id: existing.id },
          data: { ...body, updatedById: req.staffUser!.id },
        })
      }
      return prisma.paymentGatewayConfig.create({
        data: { provider, conceptId: null, ...body, updatedById: req.staffUser!.id },
      })
    },
  )
}
