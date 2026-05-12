import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { resolveTenantScope, tenantWhere } from '../../lib/tenantScope.js'

const createConceptSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  type: z.enum(['restaurant', 'digital', 'cart']),
  description: z.string().optional(),
  logoUrl: z.string().url().optional().or(z.literal('')).transform(v => v || null),
  primaryColor: z.string().optional(),
  taxRate: z.number().min(0).max(100).default(17),
  // Province: drives default sales-tax rate via the provincial revenue authority.
  // Operator picks the province on creation; we auto-fill taxRate from it.
  province:         z.enum(['PB', 'SD', 'KP', 'BL', 'ICT', 'GB', 'AJK']).nullable().optional(),
  // Storefront CMS
  storefrontVisible: z.boolean().optional(),
  heroTagline: z.string().max(120).optional().nullable(),
  announcementBanner: z.string().max(300).optional().nullable(),
  // Per-brand reservations master toggle (false = brand isn't accepting bookings)
  reservationsEnabled: z.boolean().optional(),
  // Brand strategy brief — captured during onboarding
  conceptStatement:    z.string().max(280).nullable().optional(),
  cuisine:             z.string().max(60).nullable().optional(),
  heroProduct:         z.string().max(120).nullable().optional(),
  anchoringExperience: z.string().max(280).nullable().optional(),
  targetCustomer:      z.string().max(280).nullable().optional(),
  priceTier:           z.enum(['budget', 'mid', 'premium', 'luxury']).nullable().optional(),
  daypartFocus:        z.array(z.string()).default([]),
  competitors:         z.array(z.string().max(80)).max(10).default([]),
  differentiator:      z.string().max(280).nullable().optional(),
  brandVoice:          z.string().max(500).nullable().optional(),
})

// Full brand-edit schema. Adds geo, FBR / tax, and isActive on top of the
// base creation fields. Slug is omitted intentionally — slug changes break
// URLs + storefront SEO; expose it as a separate admin-only operation later.
const updateConceptSchema = createConceptSchema.partial().omit({ slug: true }).extend({
  isActive: z.boolean().optional(),
  storefrontLayout: z.array(z.record(z.string(), z.unknown())).optional().nullable(),
  // Delivery geography
  latitude:        z.number().min(-90).max(90).nullable().optional(),
  longitude:       z.number().min(-180).max(180).nullable().optional(),
  deliveryRadiusKm: z.number().min(0).max(50).optional(),
  // Aggregator economics
  foodpandaCommissionRate: z.number().min(0).max(1).optional(),
  // FBR / tax invoice details
  strn:             z.string().max(40).nullable().optional(),
  ntn:              z.string().max(40).nullable().optional(),
  province:         z.enum(['PB', 'SD', 'KP', 'BL', 'ICT', 'GB', 'AJK']).nullable().optional(),
  invoiceLegalName: z.string().max(120).nullable().optional(),
  invoiceAddress:   z.string().max(500).nullable().optional(),
  invoicePrefix:    z.string().max(10).nullable().optional(),
  fbrPosId:         z.number().int().nullable().optional(),
})

export async function conceptRoutes(fastify: FastifyInstance) {
  // GET /concepts — list concepts under the active tenant
  // Reads honour portfolio mode: when the operator has flipped to "All
  // companies", every tenant they're a member of is included via the
  // `x-servd-portfolio` header. Writes (POST/PATCH/DELETE below) stay
  // scoped to the single active tenant — portfolio writes are gated at
  // the client layer.
  fastify.get('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const scope = await resolveTenantScope(req)
    return prisma.concept.findMany({
      where: { deletedAt: null, ...tenantWhere(scope) },
      orderBy: { name: 'asc' },
    })
  })

  // GET /concepts/:id — must belong to the active tenant
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const concept = await prisma.concept.findFirst({
      where: { id: req.params.id, deletedAt: null, tenantId: req.staffUser!.tenantId },
    })
    if (!concept) throw new NotFoundError('Concept', req.params.id)
    return concept
  })

  // POST /concepts — created under the active tenant
  fastify.post('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = createConceptSchema.parse(req.body)
    const concept = await prisma.concept.create({
      data: { ...body, tenantId: req.staffUser!.tenantId },
    })
    return reply.status(201).send(concept)
  })

  // PATCH /concepts/:id — managers can edit storefront content; admin-only for structural changes
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = updateConceptSchema.parse(req.body)
    // Verify the concept belongs to the active tenant before mutating.
    const owned = await prisma.concept.findFirst({
      where: { id: req.params.id, tenantId: req.staffUser!.tenantId, deletedAt: null },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Concept not found in your active company' } })
    const { storefrontLayout, ...rest } = body
    const data: Prisma.ConceptUpdateInput = { ...rest }
    if (storefrontLayout !== undefined) {
      data.storefrontLayout = storefrontLayout === null ? Prisma.JsonNull : (storefrontLayout as Prisma.InputJsonValue)
    }
    const concept = await prisma.concept.update({
      where: { id: req.params.id },
      data,
    })
    return concept
  })

  // DELETE /concepts/:id (soft delete) — must belong to active tenant
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const owned = await prisma.concept.findFirst({
      where: { id: req.params.id, tenantId: req.staffUser!.tenantId, deletedAt: null },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Concept not found in your active company' } })
    await prisma.concept.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date(), isActive: false },
    })
    return reply.status(204).send()
  })
}
