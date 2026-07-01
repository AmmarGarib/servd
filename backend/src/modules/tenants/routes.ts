import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { TEMPLATES, getTemplate, TEMPLATE_KEYS } from './templates.js'

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

async function uniqueSlug(baseName: string, table: 'tenant' | 'concept'): Promise<string> {
  let slug = slugify(baseName) || (table === 'tenant' ? 'restaurant' : 'brand')
  let i = 1
  while (true) {
    const existing = table === 'tenant'
      ? await prisma.tenant.findUnique({ where: { slug } })
      : await prisma.concept.findUnique({ where: { slug } })
    if (!existing) return slug
    i++; slug = `${slugify(baseName)}-${i}`
  }
}

export async function tenantRoutes(fastify: FastifyInstance) {
  // ── Templates catalogue (public — needed for signup wizard) ─────────────
  fastify.get('/templates', async () => {
    return TEMPLATES.map((t) => ({
      key: t.key, emoji: t.emoji, label: t.label, blurb: t.blurb,
      conceptType: t.conceptType, primaryColor: t.primaryColor,
      stationCount: t.stations.length, categoryCount: t.categories.length,
      itemCount: t.items.length,
    }))
  })

  // ── List tenants (admin only — internal dashboard for the SaaS owner) ───
  fastify.get('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => {
    return prisma.tenant.findMany({
      where: { deletedAt: null },
      include: {
        _count: { select: { concepts: true, users: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  // ── Get current tenant (whoever the logged-in user belongs to) ──────────
  fastify.get('/me', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { tenantId: true },
    })
    if (!user?.tenantId) return null
    return prisma.tenant.findUnique({
      where: { id: user.tenantId },
      include: { _count: { select: { concepts: true, users: true } } },
    })
  })

  // ── List tenants the current user is a member of (multi-tenant switcher)
  fastify.get('/mine', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { tenantId: true },
    })
    // Admins (owners) manage the whole portfolio — surface EVERY company, not
    // just ones they hold an explicit TenantMember row for. Otherwise the CEO
    // can't see (or assign staff to) a company they own but never formally
    // "joined" — e.g. GS Foods shows but GSX Viva doesn't.
    if (req.staffUser!.role === 'admin') {
      const all = await prisma.tenant.findMany({
        where: { deletedAt: null },
        include: { _count: { select: { concepts: true, users: true } } },
        orderBy: { createdAt: 'asc' },
      })
      return all.map((t) => ({ ...t, role: 'admin', isActive: t.id === user?.tenantId }))
    }
    const memberships = await prisma.tenantMember.findMany({
      where: { userId: req.staffUser!.id, tenant: { deletedAt: null } },
      include: {
        tenant: {
          include: { _count: { select: { concepts: true, users: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    })
    return memberships.map((m) => ({
      ...m.tenant,
      role:     m.role,
      isActive: m.tenantId === user?.tenantId,
    }))
  })

  // ── Create a new tenant (authenticated operator only — used by the
  // in-house onboarding wizard for adding a new brand/JV). Switches the
  // user's active tenant to the newly created one so subsequent wizard
  // steps populate it.
  fastify.post('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      name:        z.string().min(1).max(200),
      industry:    z.string().max(40).nullable().optional(),
      countryCode: z.string().length(2).default('PK'),
      timezone:    z.string().max(64).default('Asia/Karachi'),
    }).parse(req.body)

    const slug = await uniqueSlug(body.name, 'tenant')

    const tenant = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          slug, name: body.name,
          industry:    body.industry ?? null,
          countryCode: body.countryCode,
          currency:    body.countryCode === 'PK' ? 'PKR' : 'USD',
          timezone:    body.timezone,
        },
      })
      await tx.tenantMember.create({
        data: { userId: req.staffUser!.id, tenantId: t.id, role: 'owner' },
      })
      // Switch active tenant to the new one
      await tx.user.update({ where: { id: req.staffUser!.id }, data: { tenantId: t.id } })
      return t
    })
    return reply.status(201).send(tenant)
  })

  // ── Switch active tenant (verifies membership) ──────────────────────────
  fastify.post<{ Params: { id: string } }>('/switch/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const membership = await prisma.tenantMember.findUnique({
      where: { userId_tenantId: { userId: req.staffUser!.id, tenantId: req.params.id } },
    })
    if (!membership) return reply.status(403).send({ error: { code: 'NOT_A_MEMBER', message: 'You are not a member of this tenant' } })
    await prisma.user.update({ where: { id: req.staffUser!.id }, data: { tenantId: req.params.id } })
    return { activeTenantId: req.params.id }
  })

  // ── Combine companies — moves everything from `sourceId` into `targetId`,
  // soft-deletes the source. Caller must be a member of both tenants. The data
  // moved: concepts, users (their tenantId column), and tenant memberships.
  // Concept-scoped data (orders, items, etc.) follows automatically because
  // it's foreign-keyed to concepts, not tenants.
  fastify.post('/merge', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      sourceId: z.string().min(1),
      targetId: z.string().min(1),
    }).parse(req.body)
    if (body.sourceId === body.targetId) {
      return reply.status(400).send({ error: { code: 'SAME_TENANT', message: 'Source and target must differ' } })
    }
    const memberships = await prisma.tenantMember.findMany({
      where: { userId: req.staffUser!.id, tenantId: { in: [body.sourceId, body.targetId] } },
    })
    if (memberships.length < 2) {
      return reply.status(403).send({ error: { code: 'NOT_A_MEMBER', message: 'You must be a member of both companies' } })
    }

    const result = await prisma.$transaction(async (tx) => {
      const conceptsMoved = await tx.concept.updateMany({
        where: { tenantId: body.sourceId }, data: { tenantId: body.targetId },
      })
      const usersMoved = await tx.user.updateMany({
        where: { tenantId: body.sourceId }, data: { tenantId: body.targetId },
      })
      // Move memberships — but preserve unique (userId, tenantId). Drop members
      // already in target; otherwise repoint to target.
      const sourceMembers = await tx.tenantMember.findMany({ where: { tenantId: body.sourceId } })
      for (const m of sourceMembers) {
        const exists = await tx.tenantMember.findUnique({
          where: { userId_tenantId: { userId: m.userId, tenantId: body.targetId } },
        })
        if (exists) {
          await tx.tenantMember.delete({ where: { id: m.id } })
        } else {
          await tx.tenantMember.update({ where: { id: m.id }, data: { tenantId: body.targetId } })
        }
      }
      // Soft-delete the source tenant
      await tx.tenant.update({
        where: { id: body.sourceId },
        data: { deletedAt: new Date(), isActive: false },
      })
      return { conceptsMoved: conceptsMoved.count, usersMoved: usersMoved.count }
    })
    return result
  })

  // ── Update tenant — owner edits company name, industry, timezone, etc.
  // No password / no signup; this only mutates safe profile fields. The
  // onboarding wizard hits this on every "Continue".
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      name:        z.string().min(1).max(200).optional(),
      industry:    z.string().max(40).nullable().optional(),
      countryCode: z.string().length(2).optional(),
      currency:    z.string().length(3).optional(),
      timezone:    z.string().max(64).optional(),
      // JV config: flip a tenant into JV mode and supply the partner shares.
      // Empty jvPartners (null) when isJointVenture=false. Frontend uses
      // this to render "Viva 60% / GS 40%" chips on every cost line.
      isJointVenture: z.boolean().optional(),
      jvPartners: z.array(z.object({
        label: z.string().min(1).max(80),
        pct:   z.number().min(0).max(100),
      })).nullable().optional(),
    }).parse(req.body)
    try {
      return await prisma.tenant.update({
        where: { id: req.params.id },
        data: {
          ...body,
          jvPartners: body.jvPartners === undefined ? undefined : (body.jvPartners ?? undefined),
        },
      })
    } catch (err) {
      return reply.status(404).send({ error: { code: 'TENANT_NOT_FOUND', message: (err as Error).message } })
    }
  })

  // ── Apply a template to the current tenant (in-app — for owners who want
  // to bootstrap a new concept after the initial signup).
  fastify.post(
    '/apply-template',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const body = z.object({
        templateKey: z.enum(TEMPLATE_KEYS as [string, ...string[]]),
        conceptName: z.string().min(1).max(100).optional(),
      }).parse(req.body)

      const tpl = getTemplate(body.templateKey)
      if (!tpl) return reply.status(400).send({ error: { code: 'BAD_TEMPLATE' } })

      const me = await prisma.user.findUnique({ where: { id: req.staffUser!.id }, select: { tenantId: true } })
      if (!me?.tenantId) return reply.status(400).send({ error: { code: 'NO_TENANT', message: 'Your user is not linked to a tenant' } })

      const conceptName = body.conceptName ?? tpl.conceptName
      const conceptSlug = await uniqueSlug(conceptName, 'concept')

      const concept = await prisma.$transaction(async (tx) => {
        const c = await tx.concept.create({
          data: {
            tenantId: me.tenantId,
            slug: conceptSlug, name: conceptName, type: tpl.conceptType,
            primaryColor: tpl.primaryColor, taxRate: tpl.taxRate,
            heroTagline: tpl.heroTagline, isActive: true, storefrontVisible: true,
          },
        })
        const stations = await Promise.all(
          tpl.stations.map((n) => tx.station.create({ data: { conceptId: c.id, name: n } })),
        )
        const stationByName = new Map(stations.map((s) => [s.name, s]))
        const cats = await Promise.all(
          tpl.categories.map((n, i) => tx.category.create({ data: { conceptId: c.id, name: n, sortOrder: i } })),
        )
        const catByName = new Map(cats.map((c) => [c.name, c]))
        for (const it of tpl.items) {
          const cat = catByName.get(it.category)
          if (!cat) continue
          const sid = it.station ? stationByName.get(it.station)?.id ?? null : null
          const m = await tx.menuItem.create({
            data: {
              conceptId: c.id, categoryId: cat.id, name: it.name, nameUrdu: it.nameUrdu ?? null,
              description: it.description ?? null, priceCents: it.priceCents, stationId: sid, isAvailable: true,
            },
          })
          if (it.recipe) {
            await tx.recipe.create({
              data: {
                menuItemId: m.id, servings: 1,
                laborMinutes: it.recipe.laborMinutes ?? 0,
                steps: it.recipe.steps ?? null,
                seasons: it.recipe.seasons ?? [],
                isActive: true,
              },
            })
          }
        }
        return c
      })

      return reply.status(201).send({ conceptId: concept.id, conceptSlug: concept.slug })
    },
  )
}
