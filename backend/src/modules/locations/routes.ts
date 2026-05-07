import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

export async function locationRoutes(fastify: FastifyInstance) {
  // GET /locations
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    return prisma.location.findMany({
      where: { deletedAt: null },
      include: {
        concepts: { include: { concept: { select: { id: true, name: true, slug: true } } } },
        _count: { select: { orders: true, shifts: true } },
      },
      orderBy: { name: 'asc' },
    })
  })

  // POST /locations — create a new physical location
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:    z.string().min(1).max(100),
      address: z.string().max(500).optional(),
      city:    z.string().max(100).optional(),
      phone:   z.string().max(50).optional(),
      latitude:  z.number().nullable().optional(),
      longitude: z.number().nullable().optional(),
      conceptIds: z.array(z.string().uuid()).default([]),
    }).parse(req.body)

    let slug = slugify(body.name) || 'location'
    let i = 1
    while (await prisma.location.findUnique({ where: { slug } })) {
      i++; slug = `${slugify(body.name)}-${i}`
    }

    const location = await prisma.location.create({
      data: {
        slug, name: body.name, address: body.address, city: body.city,
        phone: body.phone, latitude: body.latitude, longitude: body.longitude,
        concepts: { create: body.conceptIds.map((cid) => ({ conceptId: cid })) },
      },
      include: { concepts: { include: { concept: { select: { id: true, name: true } } } } },
    })
    return reply.status(201).send(location)
  })

  // PATCH /locations/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        name:     z.string().min(1).optional(),
        address:  z.string().optional(),
        city:     z.string().optional(),
        phone:    z.string().optional(),
        latitude:  z.number().optional(),
        longitude: z.number().optional(),
        isActive: z.boolean().optional(),
        conceptIds: z.array(z.string().uuid()).optional(),
      }).parse(req.body)

      const existing = await prisma.location.findUnique({ where: { id: req.params.id } })
      if (!existing) throw new NotFoundError('Location', req.params.id)

      // Sync concept-location links if provided
      if (body.conceptIds) {
        await prisma.conceptLocation.deleteMany({ where: { locationId: req.params.id } })
        await prisma.conceptLocation.createMany({
          data: body.conceptIds.map((cid) => ({ conceptId: cid, locationId: req.params.id })),
          skipDuplicates: true,
        })
      }

      const { conceptIds, ...rest } = body
      void conceptIds
      return prisma.location.update({
        where: { id: req.params.id },
        data: rest,
        include: { concepts: { include: { concept: { select: { id: true, name: true, slug: true } } } } },
      })
    },
  )

  // DELETE /locations/:id (soft delete — keeps historical orders intact)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      await prisma.location.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date(), isActive: false },
      })
      return reply.status(204).send()
    },
  )
}
