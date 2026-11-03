// Marketing board API (owner, 2026-11-03) — /marketing-board/*. Contract: ./README.md.
//
// Gates: the `marketing_board` module (lib/moduleAccess.ts GATED_PREFIXES) + BOARD_ROLES on every route. An intern
// (role marketing_intern) is admitted here only (auth/middleware.ts INTERN_ROUTES) and sees ONLY the cards they are a
// resource / owner on (anything else 404); they edit content, comment and upload files, never create, delete, move a
// stage, change who is on a card or manage boards. Stage moves and board management: the CEO or a marketing_lead
// holder (403 STAGE_MOVE_LEAD_ONLY / BOARD_LEAD_ONLY).
//
// Company scope: a card belongs to its BOARD's company. Lists read the companies in view; edits reach every company
// the caller belongs to; a new card binds to a board of the ACTIVE company (else 404). Foreign rows are 404; a
// resource / owner who is not staff of the card's company, or a link to another company's dish / promo / campaign,
// is 422.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode, assertConceptOwned } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'
import { TRASH_MARKETING } from '../trash/providers/masters/marketing.js'
import { queueStaffNotify, notifyStaffMany } from '../../lib/staffNotify.js'
import { exportFormatOf, sendReportFor } from '../../lib/reportExport.js'
import { presignMediaUpload } from '../media/routes.js'
import { BOARD_ROLES, BOARD_STAFF, isIntern, isLead, internCardWhere, assertCompanyMembers } from './access.js'
import { CARD_INCLUDE, CARD_TYPES, PRIORITIES, STAGES, STAGE_LABEL, cardDto, isRevision, type Stage } from './cards.js'
import { weeklyReport, weeklyReportTable } from './weekly.js'
import { isYmd, mondayOf, pktDay } from './week.js'

// ── Validation ─────────────────────────────────────────────────────────────

/** A reference link: http(s) only (the sections/safe.ts rule — never javascript:, data: or a relative path). */
const zLink = z.string().trim().max(500).refine((v) => {
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false }
}, 'Links must start with http:// or https://')

/** A deadline: a Karachi day (YYYY-MM-DD → the end of that day) or an ISO instant. */
const zDeadline = z.string().refine((v) => isYmd(v) || !Number.isNaN(Date.parse(v)), 'A date (YYYY-MM-DD) or date-time')
function deadlineOf(v: string): Date {
  return isYmd(v) ? new Date(Date.parse(`${v}T23:59:59.999Z`) - 5 * 3_600_000) : new Date(v)
}

const zLinkTarget = z.object({ kind: z.enum(['menu_item', 'promo', 'campaign']), id: z.string().min(1) }).nullable()

const contentSchema = z.object({
  title:          z.string().trim().min(1).max(200),
  brief:          z.string().max(10_000).nullable(),
  referenceLinks: z.array(zLink).max(20),
})
const staffSchema = z.object({
  type:        z.enum(CARD_TYPES),
  deadline:    zDeadline,
  priority:    z.enum(PRIORITIES),
  ownerId:     z.string().min(1).nullable(),
  resourceIds: z.array(z.string().min(1)).max(30),
  link:        zLinkTarget,
})

// ── Helpers ────────────────────────────────────────────────────────────────

async function boardInScope(req: FastifyRequest, id: string, mode: ScopeMode) {
  const board = await prisma.marketingBoard.findFirst({ where: { id, ...(await scopeTenantWhere(req, mode)) } })
  if (!board) throw new NotFoundError('MarketingBoard', id)
  return board
}

/** A board card the caller may see in `mode` (interns: only their own), or 404. */
async function cardInScope(req: FastifyRequest, id: string, mode: ScopeMode) {
  const card = await prisma.contentEvent.findFirst({
    where: { id, boardId: { not: null }, ...(await scopeTenantWhere(req, mode)), ...internCardWhere(req) },
    include: CARD_INCLUDE,
  })
  if (!card || !card.tenantId) throw new NotFoundError('Card', id)
  return card as typeof card & { tenantId: string; boardId: string }
}

/** Resolve a link target to the card's company: { menuItemId | promoCodeId | campaignId } (all three set). 422 when foreign. */
async function linkColumns(tenantId: string, link: z.infer<typeof zLinkTarget>): Promise<{ menuItemId: string | null; promoCodeId: string | null; campaignId: string | null }> {
  const none = { menuItemId: null, promoCodeId: null, campaignId: null }
  if (!link) return none
  const refuse = () => new AppError('LINK_NOT_IN_COMPANY', 'That dish, promo or campaign is not one of this board\'s company', 422)
  if (link.kind === 'menu_item') {
    const m = await prisma.menuItem.findFirst({ where: { id: link.id, deletedAt: null, concept: { tenantId } }, select: { id: true } })
    if (!m) throw refuse()
    return { ...none, menuItemId: m.id }
  }
  if (link.kind === 'promo') {
    const p = await prisma.promoCode.findFirst({ where: { id: link.id, tenantId, deletedAt: null }, select: { id: true } })
    if (!p) throw refuse()
    return { ...none, promoCodeId: p.id }
  }
  const c = await prisma.campaign.findFirst({ where: { id: link.id, tenantId }, select: { id: true } })
  if (!c) throw refuse()
  return { ...none, campaignId: c.id }
}

/** Bell: tell people about a card (after the commit; the actor is never told). */
function tellAboutCard(card: { id: string; tenantId: string; title: string }, userIds: string[], actorId: string, title: string, dedupe: string) {
  const ids = Array.from(new Set(userIds)).filter((u) => u !== actorId)
  if (ids.length === 0) return
  queueStaffNotify(() => notifyStaffMany(ids.map((userId) => ({
    userId, tenantId: card.tenantId, kind: 'marketing.card' as const, severity: 'info' as const,
    title, body: card.title, link: `/marketing/board?card=${card.id}`,
    entityType: 'content_event', entityId: card.id, actorId, dedupeKey: `marketing.card:${card.id}:${dedupe}`,
  }))))
}

function peopleOnCard(card: { assigneeId: string | null; resources: Array<{ userId: string }> }): string[] {
  return [...(card.assigneeId ? [card.assigneeId] : []), ...card.resources.map((r) => r.userId)]
}

// ── Routes ─────────────────────────────────────────────────────────────────

export async function marketingBoardRoutes(fastify: FastifyInstance) {
  const anyBoard = { preHandler: requireAuth(...BOARD_ROLES) }
  const staffOnly = { preHandler: requireAuth(...BOARD_STAFF) }

  // GET /marketing-board/me — what the caller may do here (drives the page).
  fastify.get('/me', anyBoard, async (req) => ({
    lead: await isLead(req),
    intern: isIntern(req),
    canCreate: !isIntern(req),
    canDelete: !isIntern(req),
    // A deleted card is in the Trash under the calendar's own type, which the managers restore (trash provider
    // content_event) — the page offers Undo only to them.
    canUndoDelete: (MANAGERS as string[]).includes(req.staffUser!.role),
  }))

  // ── Boards ──
  // GET /marketing-board/boards?archived=1 — brand boards first, then platforms (never a brand).
  fastify.get<{ Querystring: { archived?: string } }>('/boards', anyBoard, async (req) => {
    const boards = await prisma.marketingBoard.findMany({
      where: { ...(await scopeTenantWhere(req, 'read')), ...(req.query.archived === '1' ? {} : { archivedAt: null }) },
      include: { concept: { select: { id: true, name: true } } },
      orderBy: [{ kind: 'asc' }, { sort: 'asc' }, { name: 'asc' }],
    })
    // Card counts the caller can see (an intern: their own).
    const counts = await prisma.contentEvent.groupBy({
      by: ['boardId'],
      where: { boardId: { in: boards.map((b) => b.id) }, stage: { not: 'published' }, ...internCardWhere(req) },
      _count: { _all: true },
    })
    const open = new Map(counts.map((c) => [c.boardId, c._count._all]))
    return boards.map((b) => ({
      id: b.id, tenantId: b.tenantId, name: b.name, kind: b.kind, conceptId: b.conceptId, concept: b.concept,
      sort: b.sort, archivedAt: b.archivedAt, openCards: open.get(b.id) ?? 0,
    }))
  })

  // POST /marketing-board/boards — lead / CEO. A brand board names a brand of the ACTIVE company; a platform none.
  fastify.post('/boards', staffOnly, async (req, reply) => {
    if (!(await isLead(req))) throw new AppError('BOARD_LEAD_ONLY', 'Only the marketing lead or the CEO manages boards.', 403)
    const body = z.object({
      name: z.string().trim().min(1).max(80),
      kind: z.enum(['brand', 'platform']),
      conceptId: z.string().min(1).nullish(),
      sort: z.number().int().min(0).max(10_000).optional(),
    }).parse(req.body)
    const create = await scopeTenantWhere(req, 'create')
    const tenantId = typeof create.tenantId === 'string' ? create.tenantId : null
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
    if (body.kind === 'brand') {
      if (!body.conceptId) throw new AppError('BRAND_REQUIRED', 'A brand board names its brand', 422)
      await assertConceptOwned(req, body.conceptId, 'create')
    } else if (body.conceptId) {
      throw new AppError('PLATFORM_HAS_NO_BRAND', 'A platform board (an account such as beanzbakes) is not a brand', 422)
    }
    const taken = await prisma.marketingBoard.findUnique({ where: { tenantId_name: { tenantId, name: body.name } }, select: { id: true } })
    if (taken) throw new AppError('BOARD_NAME_TAKEN', 'A board with that name already exists', 409)
    const board = await prisma.marketingBoard.create({
      data: { tenantId, name: body.name, kind: body.kind, conceptId: body.kind === 'brand' ? body.conceptId! : null, sort: body.sort ?? (body.kind === 'platform' ? 100 : 50) },
    })
    return reply.status(201).send(board)
  })

  // PATCH /marketing-board/boards/:id {name?, sort?, archived?} — lead / CEO. Boards archive, never delete.
  fastify.patch<{ Params: { id: string } }>('/boards/:id', staffOnly, async (req) => {
    if (!(await isLead(req))) throw new AppError('BOARD_LEAD_ONLY', 'Only the marketing lead or the CEO manages boards.', 403)
    const body = z.object({
      name: z.string().trim().min(1).max(80).optional(),
      sort: z.number().int().min(0).max(10_000).optional(),
      archived: z.boolean().optional(),
    }).strict().parse(req.body)
    const board = await boardInScope(req, req.params.id, 'write')
    if (body.name && body.name !== board.name) {
      const taken = await prisma.marketingBoard.findUnique({ where: { tenantId_name: { tenantId: board.tenantId, name: body.name } }, select: { id: true } })
      if (taken) throw new AppError('BOARD_NAME_TAKEN', 'A board with that name already exists', 409)
    }
    return prisma.marketingBoard.update({
      where: { id: board.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.sort !== undefined ? { sort: body.sort } : {}),
        ...(body.archived !== undefined ? { archivedAt: body.archived ? (board.archivedAt ?? new Date()) : null } : {}),
      },
    })
  })

  // ── Pickers ──
  // GET /marketing-board/boards/:id/people — the board company's active staff (resources / owner picker).
  fastify.get<{ Params: { id: string } }>('/boards/:id/people', staffOnly, async (req) => {
    const board = await boardInScope(req, req.params.id, 'read')
    return prisma.user.findMany({
      where: { deletedAt: null, isActive: true, accountStatus: 'active', role: { not: 'director' }, OR: [{ tenantId: board.tenantId }, { tenantMemberships: { some: { tenantId: board.tenantId } } }] },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
      take: 500,
    })
  })

  // GET /marketing-board/boards/:id/link-options?q= — dishes (of the board's brand, else the company), promos and
  // campaigns of the board's company.
  fastify.get<{ Params: { id: string }; Querystring: { q?: string } }>('/boards/:id/link-options', staffOnly, async (req) => {
    const board = await boardInScope(req, req.params.id, 'read')
    const q = req.query.q?.trim()
    const like = q ? { contains: q, mode: 'insensitive' as const } : undefined
    const [menuItems, promos, campaigns] = await Promise.all([
      prisma.menuItem.findMany({
        where: { deletedAt: null, ...(board.conceptId ? { conceptId: board.conceptId } : { concept: { tenantId: board.tenantId } }), ...(like ? { name: like } : {}) },
        select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 50,
      }),
      prisma.promoCode.findMany({ where: { tenantId: board.tenantId, deletedAt: null, ...(like ? { code: like } : {}) }, select: { id: true, code: true }, orderBy: { code: 'asc' }, take: 50 }),
      prisma.campaign.findMany({ where: { tenantId: board.tenantId, ...(like ? { name: like } : {}) }, select: { id: true, name: true }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ])
    return { menuItems, promos, campaigns }
  })

  // ── Cards ──
  // GET /marketing-board/cards?boardId=&from=&to= — an intern gets only their own cards.
  fastify.get<{ Querystring: { boardId?: string; from?: string; to?: string } }>('/cards', anyBoard, async (req) => {
    const { boardId, from, to } = req.query
    const where: Prisma.ContentEventWhereInput = {
      boardId: boardId ? boardId : { not: null },
      board: { archivedAt: null },
      ...(await scopeTenantWhere(req, 'read')),
      ...internCardWhere(req),
      ...(from || to ? { startDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    }
    const now = new Date()
    const cards = await prisma.contentEvent.findMany({ where, include: CARD_INCLUDE, orderBy: [{ startDate: 'asc' }], take: 1000 })
    return cards.map((c) => cardDto(c, now))
  })

  // GET /marketing-board/cards/:id — with the comment thread.
  fastify.get<{ Params: { id: string } }>('/cards/:id', anyBoard, async (req) => {
    const card = await cardInScope(req, req.params.id, 'read')
    const comments = await prisma.contentEventComment.findMany({
      where: { eventId: card.id, tenantId: card.tenantId },
      select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return { ...cardDto(card), comments }
  })

  // POST /marketing-board/cards — board staff (not an intern). Starts at Idea (a lead may pick another stage).
  fastify.post('/cards', staffOnly, async (req, reply) => {
    const body = contentSchema.partial({ brief: true, referenceLinks: true })
      .merge(staffSchema.partial({ priority: true, ownerId: true, resourceIds: true, link: true }))
      .extend({ boardId: z.string().min(1), stage: z.enum(STAGES).optional() })
      .strict().parse(req.body)
    const board = await boardInScope(req, body.boardId, 'create')
    if (board.archivedAt) throw new AppError('BOARD_ARCHIVED', 'That board is archived', 409)
    const lead = await isLead(req)
    const stage: Stage = body.stage ?? 'idea'
    if (stage !== 'idea' && !lead) throw new AppError('STAGE_MOVE_LEAD_ONLY', 'Only the marketing lead or the CEO sets a card\'s stage.', 403)
    const resourceIds = Array.from(new Set(body.resourceIds ?? []))
    await assertCompanyMembers(board.tenantId, [...resourceIds, ...(body.ownerId ? [body.ownerId] : [])])
    const links = await linkColumns(board.tenantId, body.link ?? null)
    const created = await prisma.$transaction(async (tx) => {
      const ev = await tx.contentEvent.create({
        data: {
          tenantId: board.tenantId, boardId: board.id, conceptId: board.conceptId,
          title: body.title, description: body.brief ?? null, type: body.type,
          startDate: deadlineOf(body.deadline), allDay: true, status: 'draft',
          department: 'marketing', stage, priority: body.priority ?? 'normal',
          referenceLinks: body.referenceLinks ?? [], assigneeId: body.ownerId ?? null,
          publishedAt: stage === 'published' ? new Date() : null,
          createdById: req.staffUser!.id, ...links,
        },
        select: { id: true },
      })
      if (resourceIds.length) {
        await tx.contentEventResource.createMany({ data: resourceIds.map((userId) => ({ tenantId: board.tenantId, eventId: ev.id, userId })) })
      }
      return tx.contentEvent.findUniqueOrThrow({ where: { id: ev.id }, include: CARD_INCLUDE })
    })
    tellAboutCard({ id: created.id, tenantId: board.tenantId, title: created.title }, peopleOnCard(created), req.staffUser!.id, 'You were put on a marketing card', 'assigned:create')
    return reply.status(201).send(cardDto(created))
  })

  // PATCH /marketing-board/cards/:id — content (anyone who sees the card, interns included); type, deadline,
  // priority, owner, resources and the link (board staff only — an intern gets 403 INTERN_CONTENT_ONLY).
  fastify.patch<{ Params: { id: string } }>('/cards/:id', anyBoard, async (req) => {
    const body = contentSchema.merge(staffSchema).partial().strict().parse(req.body)
    const card = await cardInScope(req, req.params.id, 'write')
    const staffKeys = ['type', 'deadline', 'priority', 'ownerId', 'resourceIds', 'link'] as const
    if (isIntern(req) && staffKeys.some((k) => body[k] !== undefined)) {
      throw new AppError('INTERN_CONTENT_ONLY', 'You can edit the title, brief and links of your cards; ask the marketing team for anything else.', 403)
    }
    const newPeople: string[] = []
    if (body.ownerId) await assertCompanyMembers(card.tenantId, [body.ownerId])
    if (body.resourceIds) await assertCompanyMembers(card.tenantId, body.resourceIds)
    const links = body.link !== undefined ? await linkColumns(card.tenantId, body.link) : {}
    const updated = await prisma.$transaction(async (tx) => {
      await tx.contentEvent.update({
        where: { id: card.id },
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.brief !== undefined ? { description: body.brief } : {}),
          ...(body.referenceLinks !== undefined ? { referenceLinks: body.referenceLinks } : {}),
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.deadline !== undefined ? { startDate: deadlineOf(body.deadline) } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.ownerId !== undefined ? { assigneeId: body.ownerId } : {}),
          ...links,
        },
      })
      if (body.resourceIds) {
        const want = new Set(body.resourceIds)
        const had = new Set(card.resources.map((r) => r.userId))
        await tx.contentEventResource.deleteMany({ where: { eventId: card.id, userId: { notIn: [...want] } } })
        const add = [...want].filter((u) => !had.has(u))
        if (add.length) await tx.contentEventResource.createMany({ data: add.map((userId) => ({ tenantId: card.tenantId, eventId: card.id, userId })), skipDuplicates: true })
        newPeople.push(...add)
      }
      if (body.ownerId && body.ownerId !== card.assigneeId) newPeople.push(body.ownerId)
      return tx.contentEvent.findUniqueOrThrow({ where: { id: card.id }, include: CARD_INCLUDE })
    })
    if (newPeople.length) tellAboutCard(card, newPeople, req.staffUser!.id, 'You were put on a marketing card', `assigned:${Date.now()}`)
    return cardDto(updated)
  })

  // POST /marketing-board/cards/:id/stage {stage} — the CEO or a marketing_lead holder only.
  fastify.post<{ Params: { id: string } }>('/cards/:id/stage', anyBoard, async (req) => {
    if (!(await isLead(req))) throw new AppError('STAGE_MOVE_LEAD_ONLY', 'Only the marketing lead or the CEO moves a card between stages.', 403)
    const { stage } = z.object({ stage: z.enum(STAGES) }).strict().parse(req.body)
    const card = await cardInScope(req, req.params.id, 'write')
    const from = card.stage as Stage | null
    if (from === stage) return cardDto(card)
    // Conditional on the stage we read: two leads moving the same card at once — the second gets 409.
    const moved = await prisma.contentEvent.updateMany({
      where: { id: card.id, stage: from },
      data: {
        stage,
        ...(isRevision(from, stage) ? { revisionCount: { increment: 1 } } : {}),
        // On time = published by the deadline: stamped on entering Published, cleared on leaving it.
        ...(stage === 'published' ? { publishedAt: new Date() } : from === 'published' ? { publishedAt: null } : {}),
      },
    })
    if (moved.count === 0) throw new AppError('CARD_CHANGED', 'Someone else moved this card — refresh and try again.', 409)
    const fresh = await prisma.contentEvent.findUniqueOrThrow({ where: { id: card.id }, include: CARD_INCLUDE })
    tellAboutCard(card, peopleOnCard(card), req.staffUser!.id, `Card moved to ${STAGE_LABEL[stage]}`, `stage:${stage}:${Date.now()}`)
    return cardDto(fresh)
  })

  // DELETE /marketing-board/cards/:id — board staff (never an intern; INTERN_ROUTES has no DELETE either). Into the
  // Trash with its resources, comments and file links (the content_event provider).
  fastify.delete<{ Params: { id: string } }>('/cards/:id', staffOnly, async (req, reply) => {
    const card = await cardInScope(req, req.params.id, 'write')
    await prisma.$transaction(async (tx) => {
      const row = await tx.contentEvent.findUniqueOrThrow({ where: { id: card.id } })
      const [post, resources, comments, files] = await Promise.all([
        tx.socialPost.findUnique({ where: { eventId: card.id } }),
        tx.contentEventResource.findMany({ where: { eventId: card.id } }),
        tx.contentEventComment.findMany({ where: { eventId: card.id } }),
        tx.contentEventMedia.findMany({ where: { eventId: card.id } }),
      ])
      await moveToTrash(tx, req, {
        type: TRASH_MARKETING.content_event, entityId: card.id, tenantId: card.tenantId, conceptId: card.conceptId,
        title: card.title, subtitle: `${card.type} · ${card.board?.name ?? 'board'} card`, reason: trashReasonOf(req),
        parent: card.conceptId ? { type: 'brand', id: card.conceptId } : null,
        snapshot: takeSnapshot('ContentEvent', row, {
          ...(post ? { SocialPost: [post] } : {}),
          ContentEventResource: resources, ContentEventComment: comments, ContentEventMedia: files,
        }),
      })
      await tx.contentEvent.delete({ where: { id: card.id } })
    })
    return reply.status(204).send()
  })

  // POST /marketing-board/cards/:id/comments {body} — anyone who sees the card.
  fastify.post<{ Params: { id: string } }>('/cards/:id/comments', anyBoard, async (req, reply) => {
    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).strict().parse(req.body)
    const card = await cardInScope(req, req.params.id, 'write')
    const c = await prisma.contentEventComment.create({
      data: { tenantId: card.tenantId, eventId: card.id, authorId: req.staffUser!.id, body },
      select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true, role: true } } },
    })
    tellAboutCard(card, peopleOnCard(card), req.staffUser!.id, 'New comment on a marketing card', `comment:${c.id}`)
    return reply.status(201).send(c)
  })

  // GET /marketing-board/cards/:id/upload-url?filename&contentType — upload a file to the card: the ONE media upload
  // (media/routes.ts presignMediaUpload) into the CARD's company library, linked to the card at once. The way an
  // intern adds files — /media itself stays closed to them.
  fastify.get<{ Params: { id: string }; Querystring: { filename?: string; contentType?: string; name?: string } }>('/cards/:id/upload-url', anyBoard, async (req) => {
    const q = z.object({
      filename: z.string().min(1).max(255),
      contentType: z.string().max(120).default(''),
      name: z.string().max(120).optional(),
    }).parse(req.query)
    const card = await cardInScope(req, req.params.id, 'write')
    const signed = await presignMediaUpload(req, { filename: q.filename, contentType: q.contentType, category: 'marketing', name: q.name }, card.tenantId)
    await prisma.$transaction(async (tx) => {
      if (card.conceptId) await tx.mediaAsset.update({ where: { id: signed.assetId }, data: { conceptId: card.conceptId } })
      await tx.contentEventMedia.create({ data: { tenantId: card.tenantId, eventId: card.id, mediaAssetId: signed.assetId, addedById: req.staffUser!.id } })
    })
    return signed
  })

  // POST /marketing-board/cards/:id/files {mediaAssetIds} — link files already in the company's library (board staff).
  fastify.post<{ Params: { id: string } }>('/cards/:id/files', staffOnly, async (req, reply) => {
    const { mediaAssetIds } = z.object({ mediaAssetIds: z.array(z.string().min(1)).min(1).max(20) }).strict().parse(req.body)
    const card = await cardInScope(req, req.params.id, 'write')
    const assets = await prisma.mediaAsset.findMany({ where: { id: { in: mediaAssetIds }, tenantId: card.tenantId, kind: { not: 'copy' } }, select: { id: true } })
    if (assets.length !== new Set(mediaAssetIds).size) throw new AppError('FILE_NOT_IN_COMPANY', 'Pick files from this board\'s company library', 422)
    await prisma.contentEventMedia.createMany({
      data: assets.map((a) => ({ tenantId: card.tenantId, eventId: card.id, mediaAssetId: a.id, addedById: req.staffUser!.id })),
      skipDuplicates: true,
    })
    return reply.status(201).send(cardDto(await prisma.contentEvent.findUniqueOrThrow({ where: { id: card.id }, include: CARD_INCLUDE })))
  })

  // DELETE /marketing-board/cards/:id/files/:linkId — unlink a file (the file stays in the library). Board staff.
  fastify.delete<{ Params: { id: string; linkId: string } }>('/cards/:id/files/:linkId', staffOnly, async (req, reply) => {
    const card = await cardInScope(req, req.params.id, 'write')
    const gone = await prisma.contentEventMedia.deleteMany({ where: { id: req.params.linkId, eventId: card.id } })
    if (gone.count === 0) throw new NotFoundError('CardFile', req.params.linkId)
    return reply.status(204).send()
  })

  // ── Weekly report ──
  // GET /marketing-board/report/weekly?weekOf=YYYY-MM-DD&boardId=&format=csv|xlsx|pdf — published vs slipped per
  // board for the Karachi week (Mon–Sun) containing weekOf (default this week). Board staff (not interns).
  fastify.get<{ Querystring: { weekOf?: string; boardId?: string; format?: string } }>('/report/weekly', staffOnly, async (req, reply) => {
    const weekOf = isYmd(req.query.weekOf) ? req.query.weekOf : pktDay(new Date())
    const monday = mondayOf(weekOf)
    const scope = await scopeTenantWhere(req, 'read')
    const report = await weeklyReport({ ...scope, ...(req.query.boardId ? { id: req.query.boardId } : {}) }, monday)
    const format = exportFormatOf(req.query.format)
    if (format) return sendReportFor(req, reply, format, { base: 'marketing-published-vs-slipped', suffix: monday }, weeklyReportTable(report))
    return report
  })
}
