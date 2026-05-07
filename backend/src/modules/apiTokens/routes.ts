import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomBytes, createHash } from 'crypto'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'

function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex')
}

function generateToken(): string {
  // 32 bytes -> 43-char base64url. Prefix makes it easy to spot in logs/leaks.
  return 'svrd_' + randomBytes(32).toString('base64url')
}

export async function apiTokenRoutes(fastify: FastifyInstance) {
  // GET /api-tokens — list tokens scoped to concepts of the active tenant
  fastify.get('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const tenantConcepts = await prisma.concept.findMany({
      where: { tenantId: req.staffUser!.tenantId, deletedAt: null },
      select: { id: true },
    })
    const tenantConceptIds = tenantConcepts.map((c) => c.id)
    return prisma.apiToken.findMany({
      where: {
        conceptId: { in: tenantConceptIds },
      },
      select: {
        id: true, name: true, scopes: true, conceptId: true,
        createdById: true, lastUsedAt: true, expiresAt: true,
        revokedAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  // POST /api-tokens — create a new token (returns plaintext ONCE)
  fastify.post('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      name:      z.string().min(1).max(100),
      scopes:    z.array(z.string()).min(1).max(20),
      conceptId: z.string().uuid(),
      expiresInDays: z.number().int().min(1).max(3650).optional(),
    }).parse(req.body)

    // Verify concept belongs to active tenant.
    const concept = await prisma.concept.findFirst({
      where: { id: body.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
    })
    if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })

    const plain = generateToken()
    const tokenHash = hashToken(plain)
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 86_400_000)
      : null

    const created = await prisma.apiToken.create({
      data: {
        name: body.name,
        tokenHash,
        scopes: body.scopes,
        conceptId: body.conceptId,
        expiresAt,
        createdById: req.staffUser!.id,
      },
      select: { id: true, name: true, scopes: true, conceptId: true, expiresAt: true, createdAt: true },
    })

    return reply.status(201).send({
      ...created,
      token: plain,    // plaintext shown ONCE
      hint:  'Store this token now — it won\'t be displayed again.',
    })
  })

  // PATCH /api-tokens/:id/revoke — irreversibly disable a token
  fastify.patch<{ Params: { id: string } }>(
    '/:id/revoke',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const tenantConcepts = await prisma.concept.findMany({
        where: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        select: { id: true },
      })
      const tenantConceptIds = tenantConcepts.map((c) => c.id)
      const owned = await prisma.apiToken.findFirst({
        where: { id: req.params.id, conceptId: { in: tenantConceptIds } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'API token not found in your active company' } })
      return prisma.apiToken.update({
        where: { id: req.params.id },
        data:  { revokedAt: new Date() },
        select: { id: true, revokedAt: true },
      })
    },
  )
}
