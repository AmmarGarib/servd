import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js'
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

  // ── List tenants (admin only — internal dashboard for the SaaS owner).
  // Scoped to the companies the operator belongs to: a company they are not
  // a member of is not theirs to list, admin role or not.
  fastify.get('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    return prisma.tenant.findMany({
      where: { deletedAt: null, id: { in: req.staffUser!.memberTenantIds } },
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
  // soft-deletes the source. Admin only, and the caller must be a member of
  // BOTH companies — a foreign id 404s rather than confirming it exists.
  // Everything anchored on a tenantId column moves in the same transaction:
  // brands, staff, memberships, locations, suppliers, inventory, riders, bank
  // accounts, modifier templates, webhooks, domains, capex/opex/pro-forma rows,
  // workforce rows and the per-company singleton configs. Concept-scoped data
  // (orders, items, etc.) follows its brand. Where the target already holds a
  // row with the same company-keyed unique key the target's row wins and the
  // source's duplicate is dropped — except kitchen staff, where the merge is
  // refused so two people's payroll history is never silently collapsed.
  fastify.post('/merge', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      sourceId: z.string().min(1),
      targetId: z.string().min(1),
    }).parse(req.body)
    if (body.sourceId === body.targetId) {
      return reply.status(400).send({ error: { code: 'SAME_TENANT', message: 'Source and target must differ' } })
    }
    const src = body.sourceId
    const dst = body.targetId
    // memberTenantIds = every company the operator belongs to (non-GET, so
    // never narrowed by the active-company header). Checked before any DB
    // read so a guessed id never confirms a company exists.
    for (const id of [src, dst]) {
      if (!req.staffUser!.memberTenantIds.includes(id)) throw new NotFoundError('Tenant', id)
    }
    const live = await prisma.tenant.findMany({
      where: { id: { in: [src, dst] }, deletedAt: null },
      select: { id: true },
    })
    for (const id of [src, dst]) {
      if (!live.some((t) => t.id === id)) throw new NotFoundError('Tenant', id)
    }

    const result = await prisma.$transaction(async (tx) => {
      // Refuse before any write if a kitchen staffer (unique per company on
      // CNIC) exists on both sides.
      const srcStaff = await tx.kitchenStaff.findMany({ where: { tenantId: src }, select: { cnic: true } })
      if (srcStaff.length > 0) {
        const dstStaff = await tx.kitchenStaff.findMany({
          where: { tenantId: dst, cnic: { in: srcStaff.map((s) => s.cnic) } },
          select: { cnic: true },
        })
        if (dstStaff.length > 0) {
          throw new ConflictError(
            `Kitchen staff with CNIC ${dstStaff.map((s) => s.cnic).join(', ')} exist in both companies — resolve them before merging`,
          )
        }
      }

      const conceptsMoved = await tx.concept.updateMany({
        where: { tenantId: src }, data: { tenantId: dst },
      })
      const usersMoved = await tx.user.updateMany({
        where: { tenantId: src }, data: { tenantId: dst },
      })
      // Move memberships — but preserve unique (userId, tenantId). Drop members
      // already in target; otherwise repoint to target.
      const sourceMembers = await tx.tenantMember.findMany({ where: { tenantId: src } })
      for (const m of sourceMembers) {
        const exists = await tx.tenantMember.findUnique({
          where: { userId_tenantId: { userId: m.userId, tenantId: dst } },
        })
        if (exists) {
          await tx.tenantMember.delete({ where: { id: m.id } })
        } else {
          await tx.tenantMember.update({ where: { id: m.id }, data: { tenantId: dst } })
        }
      }

      // Company master data with no company-keyed unique constraint (kitchen
      // staff included — CNIC clashes were refused above): a straight repoint.
      // The ledger merges account-by-account: both companies run the same
      // code numbers (4001, 1010, …) on separate rows, so every journal line
      // pointing at a source account is repointed to the destination's account
      // with the same code before the entries move. A code the destination
      // doesn't have is carried across as-is. Source accounts are then retired.
      const srcAccounts = await tx.account.findMany({
        where: { tenantId: src }, select: { id: true, code: true },
      })
      if (srcAccounts.length > 0) {
        const dstAccounts = await tx.account.findMany({
          where: { tenantId: dst, code: { in: srcAccounts.map((a) => a.code) } },
          select: { id: true, code: true },
        })
        const dstByCode = new Map(dstAccounts.map((a) => [a.code, a.id]))
        for (const a of srcAccounts) {
          const twin = dstByCode.get(a.code)
          if (twin) {
            await tx.journalLine.updateMany({ where: { accountId: a.id }, data: { accountId: twin } })
            await tx.account.delete({ where: { id: a.id } })
          } else {
            await tx.account.update({ where: { id: a.id }, data: { tenantId: dst } })
          }
        }
      }

      const repoint: Array<{
        updateMany(args: { where: { tenantId: string }; data: { tenantId: string } }): Promise<unknown>
      }> = [
        tx.location, tx.inventoryItem, tx.supplier, tx.rider, tx.modifierTemplate,
        tx.bankAccount, tx.kdsDevice, tx.webhookSubscription, tx.domain,
        tx.deliveryZone, tx.notificationTemplate, tx.scheduledReport, tx.shift,
        tx.journalEntry, tx.periodLock,
        tx.capitalLedgerEntry, tx.capexProject, tx.opexCategory, tx.proForma, tx.projection,
        tx.position, tx.kitchenStaff, tx.kitchenPayrollRun, tx.complianceViolation,
      ]
      for (const model of repoint) {
        await model.updateMany({ where: { tenantId: src }, data: { tenantId: dst } })
      }

      // Per-company singleton configs — unique on (tenantId, scope, scopeId).
      // The target's row wins on a clash; the source's duplicate is dropped.
      // Concept-scoped rows can't clash: their scopeId is a brand that just
      // moved with the source.
      const singletons: Array<{
        findMany(args: { where: { tenantId: string }; select: { id: true; scope: true; scopeId: true } }):
          Promise<Array<{ id: string; scope: string; scopeId: string | null }>>
        update(args: { where: { id: string }; data: { tenantId: string } }): Promise<unknown>
        delete(args: { where: { id: string } }): Promise<unknown>
      }> = [tx.refundPolicy, tx.reservationPolicy, tx.receiptConfig, tx.operationsConfig]
      const scopeKey = (r: { scope: string; scopeId: string | null }) => `${r.scope}:${r.scopeId ?? ''}`
      for (const model of singletons) {
        const srcRows = await model.findMany({ where: { tenantId: src }, select: { id: true, scope: true, scopeId: true } })
        if (srcRows.length === 0) continue
        const dstRows = await model.findMany({ where: { tenantId: dst }, select: { id: true, scope: true, scopeId: true } })
        const taken = new Set(dstRows.map(scopeKey))
        for (const r of srcRows) {
          if (taken.has(scopeKey(r))) await model.delete({ where: { id: r.id } })
          else await model.update({ where: { id: r.id }, data: { tenantId: dst } })
        }
      }

      // Wage settings: one row per company.
      const srcWages = await tx.wageSettings.findUnique({ where: { tenantId: src }, select: { id: true } })
      if (srcWages) {
        const dstWages = await tx.wageSettings.findUnique({ where: { tenantId: dst }, select: { id: true } })
        if (dstWages) await tx.wageSettings.delete({ where: { id: srcWages.id } })
        else await tx.wageSettings.update({ where: { id: srcWages.id }, data: { tenantId: dst } })
      }

      // Departments and shift bands are unique per (company, name) and are
      // referenced by positions: a same-named row on the target absorbs the
      // source's positions, otherwise the row itself moves.
      const srcDepts = await tx.department.findMany({ where: { tenantId: src }, select: { id: true, name: true } })
      if (srcDepts.length > 0) {
        const dstDepts = await tx.department.findMany({ where: { tenantId: dst }, select: { id: true, name: true } })
        const twinByName = new Map(dstDepts.map((d) => [d.name, d.id]))
        for (const d of srcDepts) {
          const twin = twinByName.get(d.name)
          if (twin) {
            await tx.position.updateMany({ where: { departmentId: d.id }, data: { departmentId: twin } })
            await tx.department.delete({ where: { id: d.id } })
          } else {
            await tx.department.update({ where: { id: d.id }, data: { tenantId: dst } })
          }
        }
      }
      const srcBands = await tx.shiftBand.findMany({ where: { tenantId: src }, select: { id: true, name: true } })
      if (srcBands.length > 0) {
        const dstBands = await tx.shiftBand.findMany({ where: { tenantId: dst }, select: { id: true, name: true } })
        const twinByName = new Map(dstBands.map((b) => [b.name, b.id]))
        for (const b of srcBands) {
          const twin = twinByName.get(b.name)
          if (twin) {
            await tx.position.updateMany({ where: { shiftBandId: b.id }, data: { shiftBandId: twin } })
            await tx.shiftBand.delete({ where: { id: b.id } })
          } else {
            await tx.shiftBand.update({ where: { id: b.id }, data: { tenantId: dst } })
          }
        }
      }

      // Component par levels — unique on (tenantId, componentId, date); the
      // target's figure wins for a day it already tracks.
      const srcPars = await tx.componentParLevel.findMany({
        where: { tenantId: src }, select: { id: true, componentId: true, date: true },
      })
      if (srcPars.length > 0) {
        const dstPars = await tx.componentParLevel.findMany({
          where: { tenantId: dst, componentId: { in: srcPars.map((p) => p.componentId) } },
          select: { componentId: true, date: true },
        })
        const parKey = (p: { componentId: string; date: Date }) => `${p.componentId}:${p.date.toISOString()}`
        const taken = new Set(dstPars.map(parKey))
        for (const p of srcPars) {
          if (taken.has(parKey(p))) await tx.componentParLevel.delete({ where: { id: p.id } })
          else await tx.componentParLevel.update({ where: { id: p.id }, data: { tenantId: dst } })
        }
      }

      // Inter-company contributions: repoint both ends. One that would now
      // pay the target from the target is meaningless and is closed out.
      await tx.tenantContribution.updateMany({ where: { sourceTenantId: src }, data: { sourceTenantId: dst } })
      await tx.tenantContribution.updateMany({ where: { destinationTenantId: src }, data: { destinationTenantId: dst } })
      await tx.tenantContribution.updateMany({
        where: { sourceTenantId: dst, destinationTenantId: dst, isActive: true },
        data: { isActive: false, endedAt: new Date() },
      })

      // Soft-delete the source tenant
      await tx.tenant.update({
        where: { id: src },
        data: { deletedAt: new Date(), isActive: false },
      })
      return { conceptsMoved: conceptsMoved.count, usersMoved: usersMoved.count }
    }, {
      // Many sequential statements — the default 5s interactive-transaction
      // budget is too tight for a company with real history.
      maxWait: 10_000,
      timeout: 60_000,
    })
    return result
  })

  // ── Update tenant — owner edits company name, industry, timezone, etc.
  // No password / no signup; this only mutates safe profile fields. The
  // onboarding wizard hits this on every "Continue". Only a company the
  // operator belongs to — a foreign id 404s rather than confirming it exists.
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
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
    // memberTenantIds = every company the operator belongs to (non-GET, so
    // never narrowed by the active-company header).
    if (!req.staffUser!.memberTenantIds.includes(req.params.id)) throw new NotFoundError('Tenant', req.params.id)
    const existing = await prisma.tenant.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('Tenant', req.params.id)
    return prisma.tenant.update({
      where: { id: existing.id },
      data: {
        ...body,
        jvPartners: body.jvPartners === undefined ? undefined : (body.jvPartners ?? undefined),
      },
    })
  })

  // ── Apply a template to the ACTIVE company (in-app — for owners who want
  // to bootstrap a new concept after the initial signup). Binds the new brand
  // to req.staffUser.tenantId, which honours x-servd-active-tenant — never to
  // the user's primary company, or a brand picked for GSX Viva would land in
  // GS Foods.
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

      const tenantId = req.staffUser!.tenantId
      if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before applying a template', 422)

      const conceptName = body.conceptName ?? tpl.conceptName
      const conceptSlug = await uniqueSlug(conceptName, 'concept')

      const concept = await prisma.$transaction(async (tx) => {
        const c = await tx.concept.create({
          data: {
            tenantId,
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
