// Guest tag catalogue (owner, 2026-10-26, B8): the company's own list of guest tags (VIP, allergy, birthday …).
// Staff pick from it on the guest card (POST /reservations/guest-tags {customerId, tagTypeId}); managers create,
// rename and switch entries off here. Company data: every row carries tenantId; a read lists the companies in view,
// a create binds to the ACTIVE company, a change needs the entry to be in one of the operator's companies (else 404).
// Switched off, never deleted — tags already on a guest keep their label.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { scopeTenantWhere, activeTenantId } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

/** One normalised key per name: trimmed, spaces collapsed, lower case. */
export const guestTagKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()
const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ')

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)

/** A tag type of one of the operator's companies (mode 'write'), or 404. */
export async function findTagTypeInScope(req: Parameters<typeof scopeTenantWhere>[0], id: string, mode: 'read' | 'write') {
  const type = await prisma.guestTagType.findFirst({ where: { id, ...(await scopeTenantWhere(req, mode)) } })
  if (!type) throw new NotFoundError('Guest tag type', id)
  return type
}

export async function guestTagTypeRoutes(fastify: FastifyInstance) {
  // GET /reservations/guest-tag-types[?all=1] — the pick list (active only unless all=1, which managers use to manage).
  fastify.get<{ Querystring: { all?: string } }>(
    '/guest-tag-types',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const all = req.query.all === '1'
      return prisma.guestTagType.findMany({
        where: { ...(await scopeTenantWhere(req, 'read')), ...(all ? {} : { active: true }) },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
      })
    },
  )

  fastify.post('/guest-tag-types', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(40), color: colorSchema.nullish() }).parse(req.body)
    const tenantId = activeTenantId(req, 'guest tags belong to one company')
    const nameKey = guestTagKey(body.name)
    const taken = await prisma.guestTagType.findUnique({ where: { tenantId_nameKey: { tenantId, nameKey } } })
    if (taken) throw new AppError('TAG_NAME_TAKEN', `Your company already has a guest tag called "${taken.name}".`, 409)
    const created = await prisma.guestTagType.create({
      data: { tenantId, name: cleanName(body.name), nameKey, color: body.color ?? null, createdById: req.staffUser!.id },
    })
    await audit({
      category: 'identity', action: 'guest_tag_type.create', entity: 'GuestTagType', entityId: created.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId,
      after: { name: created.name, color: created.color },
    })
    return reply.status(201).send(created)
  })

  // PATCH /reservations/guest-tag-types/:id { name?, color?, active? } — rename, recolour, switch off / on.
  fastify.patch<{ Params: { id: string } }>(
    '/guest-tag-types/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        name: z.string().trim().min(1).max(40).optional(),
        color: colorSchema.nullish(),
        active: z.boolean().optional(),
      }).parse(req.body)
      const existing = await findTagTypeInScope(req, req.params.id, 'write')
      const nameKey = body.name !== undefined ? guestTagKey(body.name) : existing.nameKey
      if (nameKey !== existing.nameKey) {
        const taken = await prisma.guestTagType.findUnique({ where: { tenantId_nameKey: { tenantId: existing.tenantId, nameKey } } })
        if (taken && taken.id !== existing.id) throw new AppError('TAG_NAME_TAKEN', `Your company already has a guest tag called "${taken.name}".`, 409)
      }
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.guestTagType.update({
          where: { id: existing.id },
          data: {
            ...(body.name !== undefined && { name: cleanName(body.name), nameKey }),
            ...(body.color !== undefined && { color: body.color }),
            ...(body.active !== undefined && { active: body.active }),
          },
        })
        // A rename carries to the tags already on guests (their label is the entry's name).
        if (body.name !== undefined || body.color !== undefined) {
          await tx.guestTag.updateMany({
            where: { tagTypeId: existing.id },
            data: { ...(body.name !== undefined && { label: u.name }), ...(body.color !== undefined && { color: u.color }) },
          })
        }
        return u
      })
      await audit({
        category: 'identity', action: 'guest_tag_type.update', entity: 'GuestTagType', entityId: existing.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: existing.tenantId,
        before: { name: existing.name, color: existing.color, active: existing.active },
        after: { name: updated.name, color: updated.color, active: updated.active },
      })
      return updated
    },
  )
}
