import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { sendEmail, sendSms } from '../../lib/notify.js'
import { sendText } from '../../lib/whatsapp.js'
import { reachableCustomer, companyAudience, unsubscribeUrl } from '../../lib/marketingAudience.js'
import { computeAllSegments, getSegmentsWithMembers } from './segmentComputation.js'
import { deliverToCustomer } from '../../lib/customer-channels.js'
import { scopeTenantWhere, assertConceptOwned, conceptIdsInScope, type TenantIdWhere } from '../../lib/tenantScope.js'
import {
  customerScopeWhere, customerOfCompanies, findCustomerInScope, tenantIdsOf,
  strikeCompanies, banCompanies, inCompanies, userOfCompanies,
} from './customerScope.js'

// ─── Campaign link / open tracking helpers ────────────────────────────────────
// Rewrite links in outbound campaign content to route through the public
// /t/c/:sendId redirect (records a click, then forwards), and embed a 1x1 open
// pixel in email. Per-recipient sendId attributes engagement → CTR / open rate.
const URL_RX = /(https?:\/\/[^\s<>"')]+)/g
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function trackUrl(target: string, sendId: string, apiBase: string): string {
  return `${apiBase}/api/v1/t/c/${sendId}?u=${encodeURIComponent(target)}`
}
function trackedHtml(body: string, sendId: string, apiBase: string): string {
  let out = ''
  let last = 0
  body.replace(URL_RX, (m: string, _g1: string, offset: number) => {
    out += escapeHtml(body.slice(last, offset))
    out += `<a href="${trackUrl(m, sendId, apiBase)}">${escapeHtml(m)}</a>`
    last = offset + m.length
    return m
  })
  out += escapeHtml(body.slice(last))
  const pixel = `<img src="${apiBase}/api/v1/t/o/${sendId}" width="1" height="1" alt="" style="display:none" />`
  return `<p>${out}</p>${pixel}`
}
function trackedText(body: string, sendId: string, apiBase: string): string {
  return body.replace(URL_RX, (m) => trackUrl(m, sendId, apiBase))
}

const segmentFilterSchema = z.object({
  minSpendCents: z.number().int().optional(),
  maxSpendCents: z.number().int().optional(),
  minOrders: z.number().int().optional(),
  daysSinceLastOrder: z.number().int().optional(),
  preferredConceptId: z.string().uuid().optional(),
})

const createCampaignSchema = z
  .object({
    name: z.string().min(1),
    segmentId: z.string().uuid().nullable().optional(),
    channel: z.enum(['email', 'sms', 'whatsapp']),
    subject: z.string().optional(),
    body: z.string().min(1),
    scheduledAt: z.string().datetime().optional(),
    // Empty or omitted = every brand.
    conceptIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .refine((d) => d.channel !== 'email' || (d.subject && d.subject.length > 0), {
    message: 'subject is required for email campaigns',
    path: ['subject'],
  })

const safeCustomerSelect = {
  id: true, name: true, email: true, phone: true,
  marketingOptIn: true, birthdayMmDd: true,
  firstOrderAt: true, lastOrderAt: true,
  totalSpentCents: true, walletBalance: true,
  isBlacklisted: true, blacklistReason: true,
  preferredConceptId: true, createdAt: true, updatedAt: true,
} as const

type SegmentFilters = {
  minSpendCents?: number
  maxSpendCents?: number
  minOrders?: number
  daysSinceLastOrder?: number
  preferredConceptId?: string
}

type CompanyStat = { id: string; n: number; spent: number; lastAt: Date | null }

/**
 * Per-customer completed-order stats at THESE brands only. Customer rollups
 * (totalSpentCents, lastOrderAt, firstOrderAt) are global across companies, so
 * every company-facing segment reads this instead — a customer who spent
 * PKR 80k at company A is not company B's VIP.
 */
async function companyCustomerStats(conceptIds: string[], customerIds?: string[]): Promise<CompanyStat[]> {
  if (conceptIds.length === 0 || (customerIds && customerIds.length === 0)) return []
  const rows = await prisma.$queryRaw<Array<{ id: string; n: number; spent: bigint; last_at: Date | null }>>`
    SELECT o."customerId" AS id, COUNT(*)::int AS n, COALESCE(SUM(o."totalCents"), 0)::bigint AS spent,
           MAX(COALESCE(o."completedAt", o."placedAt")) AS last_at
    FROM orders o
    JOIN customers c ON c.id = o."customerId" AND c."deletedAt" IS NULL
    WHERE o."deletedAt" IS NULL AND o.status = 'completed'
      AND o."conceptId" = ANY(${conceptIds}::text[])
      ${customerIds ? Prisma.sql`AND o."customerId" = ANY(${customerIds}::text[])` : Prisma.empty}
    GROUP BY o."customerId"`
  return rows.map((r) => ({ id: r.id, n: Number(r.n), spent: Number(r.spent), lastAt: r.last_at }))
}

/** Every live brand of one company. */
async function companyConceptIds(tenantId: string | null): Promise<string[]> {
  if (!tenantId) return []
  const rows = await prisma.concept.findMany({ where: { tenantId, deletedAt: null }, select: { id: true } })
  return rows.map((r) => r.id)
}

/**
 * The recipient filter for a campaign: reachable (opt-out model) ∩ the owning
 * company's brand audience ∩ segment filters ∩ has a contact for the channel.
 * Shared by the audience preview and the real send so the number shown is the
 * number sent. `companyConcepts` is every brand of the campaign's company; an
 * empty `conceptIds` means all of those, never the platform.
 */
async function campaignAudienceWhere(c: {
  companyConcepts: string[]
  conceptIds?: string[] | null
  segment?: { filters: unknown } | null
  channel?: string | null
}): Promise<Prisma.CustomerWhereInput> {
  const f = (c.segment?.filters ?? null) as SegmentFilters | null
  const and: Prisma.CustomerWhereInput[] = [reachableCustomer, companyAudience(c.companyConcepts, c.conceptIds)]
  if (c.channel === 'email') and.push({ email: { not: null } })
  if (c.channel === 'sms' || c.channel === 'whatsapp') and.push({ phone: { not: null } })
  if (f?.preferredConceptId) {
    and.push(c.companyConcepts.includes(f.preferredConceptId) ? { preferredConceptId: f.preferredConceptId } : { id: { in: [] } })
  }
  const needsStats = f && (f.minSpendCents !== undefined || f.maxSpendCents !== undefined
    || f.daysSinceLastOrder !== undefined || (f.minOrders !== undefined && f.minOrders > 0))
  if (f && needsStats) {
    // Spend / order count / recency at THIS company's brands. Resolved to ids
    // up front: Prisma cannot filter on a relation aggregate.
    const stats = await companyCustomerStats(c.companyConcepts)
    const include = (pred: (s: CompanyStat) => boolean) => and.push({ id: { in: stats.filter(pred).map((s) => s.id) } })
    if (f.minSpendCents !== undefined) include((s) => s.spent >= f.minSpendCents!)
    if (f.maxSpendCents !== undefined) {
      // Customers with no orders here have spent 0, so they stay in.
      and.push({ id: { notIn: stats.filter((s) => s.spent > f.maxSpendCents!).map((s) => s.id) } })
    }
    if (f.daysSinceLastOrder !== undefined) {
      const cutoff = Date.now() - f.daysSinceLastOrder * 86_400_000
      include((s) => !!s.lastAt && s.lastAt.getTime() < cutoff)
    }
    if (f.minOrders !== undefined && f.minOrders > 0) include((s) => s.n >= f.minOrders!)
  }
  return { AND: and }
}

const isVip = (x: CompanyStat) => x.spent >= 5_000_000          // PKR 50,000 (decision 16)
const isRepeat = (x: CompanyStat) => x.n >= 2
const isFrequent = (x: CompanyStat) => x.n >= 3
const isOneTime = (x: CompanyStat) => x.n === 1
const isDormant = (x: CompanyStat, cutoff: Date) => !!x.lastAt && x.lastAt < cutoff

/**
 * "Zero orders" for a company: people connected to it — booked at one of its
 * brands, or signed up through one (preferred brand) — who have no completed
 * order at any of its brands.
 */
function zeroOrdersWhere(conceptIds: string[]): Prisma.CustomerWhereInput {
  return {
    deletedAt: null,
    AND: [
      { OR: [
        { preferredConceptId: { in: conceptIds } },
        { reservations: { some: { conceptId: { in: conceptIds } } } },
        { orders: { some: { conceptId: { in: conceptIds }, deletedAt: null } } },
      ] },
      { orders: { none: { conceptId: { in: conceptIds }, status: 'completed', deletedAt: null } } },
    ],
  }
}

/**
 * A customer thread belongs to a company when the customer is one of its
 * customers AND the staff member who opened it works there. The table has no
 * company column yet (see customerScope.ts), so a thread opened by someone in
 * both companies about a shared customer is visible to both.
 */
function conversationOfCompanies(t: TenantIdWhere): Prisma.CustomerConversationWhereInput {
  return { customer: customerOfCompanies(t), staff: userOfCompanies(t) }
}

export async function crmRoutes(fastify: FastifyInstance) {
  // GET /crm/customers
  fastify.get<{
    Querystring: {
      search?: string
      conceptId?: string
      minSpend?: string
      maxOrders?: string
      cursor?: string
      limit?: string
    }
  }>('/customers', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { search, conceptId, cursor, limit: limitStr } = req.query
    const limit = Math.min(parseInt(limitStr ?? '50', 10), 200)
    const t = await scopeTenantWhere(req, 'read')

    const customers = await prisma.customer.findMany({
      where: {
        deletedAt: null,
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
          ],
        }),
        ...(conceptId && { preferredConceptId: conceptId }),
        ...(cursor && { id: { lt: cursor } }),
        // Tenant scope: only customers who have ordered from a concept under
        // the active tenant. Customers are global, but the operator's view
        // should be limited to people they've actually served.
        orders: { some: { concept: { ...t, deletedAt: null } } },
      },
      select: {
        ...safeCustomerSelect,
        loyaltyAccount: { select: { pointsBalance: true, tier: true } },
        preferredConcept: { select: { name: true, slug: true } },
        _count: { select: { orders: true } },
      },
      orderBy: { lastOrderAt: 'desc' },
      take: limit + 1,
    })

    const hasMore = customers.length > limit
    if (hasMore) customers.pop()

    // PII-export audit + threshold flag — bulk customer reads above the
    // operator's threshold fire a flag so the owner can spot exfiltration.
    if (customers.length > 0) {
      const { getOperationsConfig } = await import('../../lib/setup-config.js')
      const ops = await getOperationsConfig(req.staffUser!.tenantId)
      const threshold = ops?.pii_export_row_threshold ?? 100
      if (customers.length >= threshold) {
        const { flagException } = await import('../../lib/exceptions.js')
        await flagException({
          kind: 'pii_export',
          severity: customers.length >= 500 ? 'high' : 'medium',
          title: `Bulk customer read: ${customers.length} rows`,
          description: `${req.staffUser!.email} read ${customers.length} customer records in one request from IP ${req.ip}. ${search ? `Search: "${search}".` : 'No search filter — full list scan.'}`,
          actorId: req.staffUser!.id,
          metadata: { rowCount: customers.length, search: search ?? null, ip: req.ip },
        })
      }
    }

    return { data: customers, cursor: hasMore ? (customers[customers.length - 1]?.id ?? null) : null, hasMore }
  })

  // GET /crm/customers/:id
  fastify.get<{ Params: { id: string } }>(
    '/customers/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const t = await scopeTenantWhere(req, 'read')
      const customer = await prisma.customer.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          // Only allow viewing if this customer has ordered from a concept
          // under the active tenant.
          orders: { some: { concept: { ...t, deletedAt: null } } },
        },
        select: {
          ...safeCustomerSelect,
          orders: {
            where: { concept: { ...t, deletedAt: null } },
            orderBy: { placedAt: 'desc' },
            take: 20,
            include: { concept: { select: { name: true } } },
          },
          loyaltyAccount: { include: { transactions: { take: 10, orderBy: { createdAt: 'desc' } } } },
          preferredConcept: { select: { name: true, slug: true } },
        },
      })
      if (!customer) throw new NotFoundError('Customer', req.params.id)
      return customer
    },
  )

  // GET /crm/customers/:id/context — one call returns everything the host
  // / cashier / kitchen need to know about a customer in one render. Used by
  // the CustomerContextSidebar component on /reservations and /orders.
  // Pulls: profile + rollups + recent orders + recent reservations + open
  // complaints + recent reviews + loyalty + segments. Trimmed selects and
  // small limits so this is cheap to call inline.
  fastify.get<{ Params: { id: string } }>(
    '/customers/:id/context',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const t = await scopeTenantWhere(req, 'read')
      const customer = await prisma.customer.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          // Tenant scope (same rule as GET /crm/customers/:id): staff can only
          // open the profile of a customer who has actually interacted with a
          // concept in their company. Without this, any staff login could pull
          // ANY customer's PII + order history by UUID.
          ...customerOfCompanies(t),
        },
        select: {
          id: true, name: true, email: true, phone: true, isBlacklisted: true,
          blacklistReason: true, birthdayMmDd: true,
          firstOrderAt: true, lastOrderAt: true, lastVisitAt: true,
          totalSpentCents: true, walletBalance: true, staffNotes: true,
          // Rollup fields — denormalized so this endpoint is fast.
          noShowCount: true, complaintCount: true, reviewCount: true,
          avgReviewRating: true, lastNoShowAt: true, lastComplaintAt: true,
          lastReviewedAt: true,
          // Naughty list — surfaced front-and-center so a host opening a
          // reservation immediately sees risk + recent strike history.
          strikeCount: true, bannedAt: true,
          loyaltyAccount: { select: { tier: true, pointsBalance: true, lifetimePoints: true } },
          preferredConcept: { select: { name: true, slug: true } },
        },
      })
      if (!customer) throw new NotFoundError('Customer', req.params.id)

      // Pull recent activity in parallel for snappy response. Every list is
      // this company's own activity: the customer is global, but what they
      // did at another company's brands is not ours to show.
      const inCo = { concept: t }
      const [orders, reservations, complaints, reviews, segments, strikeRows] = await Promise.all([
        prisma.order.findMany({
          where: { customerId: customer.id, deletedAt: null, ...inCo },
          orderBy: { placedAt: 'desc' },
          take: 10,
          select: {
            id: true, status: true, totalCents: true, placedAt: true, source: true,
            concept: { select: { name: true, slug: true } },
          },
        }),
        prisma.reservation.findMany({
          where: { customerId: customer.id, ...inCo },
          orderBy: { startTime: 'desc' },
          take: 10,
          select: {
            id: true, status: true, partySize: true, startTime: true, isVip: true,
            concept: { select: { name: true, slug: true } },
          },
        }),
        prisma.orderComplaint.findMany({
          where: { customerId: customer.id, status: { in: ['open', 'in_progress'] }, ...inCo },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true, title: true, category: true, status: true, priority: true,
            createdAt: true, concept: { select: { name: true } },
          },
        }),
        prisma.orderReview.findMany({
          where: { customerId: customer.id, ...inCo },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true, rating: true, comment: true, tags: true, createdAt: true,
            concept: { select: { name: true } },
          },
        }),
        prisma.customerSegmentMembership.findMany({
          where: { customerId: customer.id },
          select: { segment: { select: { name: true } } },
        }).catch(() => [] as Array<{ segment: { name: string } | null }>),
        prisma.customerStrike.findMany({
          where: { customerId: customer.id },
          orderBy: { recordedAt: 'desc' },
          take: 50,
          select: {
            id: true, kind: true, severity: true, reason: true, recordedAt: true, reversedAt: true, expiresAt: true,
            customerId: true, sourceType: true, sourceId: true, recordedById: true,
          },
        }),
      ])
      // Only this company's strikes (decision 15).
      const sc = await strikeCompanies(strikeRows)
      const scope = tenantIdsOf(t)
      const recentStrikes = strikeRows
        .filter((st) => inCompanies(sc.get(st.id), scope, true))
        .slice(0, 5)
        .map(({ customerId: _c, sourceType: _t, sourceId: _s, recordedById: _r, ...rest }) => rest)

      return {
        ...customer,
        recent: { orders, reservations, openComplaints: complaints, reviews, strikes: recentStrikes },
        segments: segments.map((s) => s.segment?.name).filter((n): n is string => n != null),
      }
    },
  )

  // PATCH /crm/customers/:id/notes — host-curated free-form notes that stick
  // around on every reservation/order view. "Allergy: shellfish", "Always
  // takes window seat", "Big tipper", that kind of thing.
  fastify.patch<{ Params: { id: string } }>(
    '/customers/:id/notes',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({ staffNotes: z.string().max(2000).nullable() }).parse(req.body)
      // Same ownership rule as GET /customers/:id/context — only a customer
      // this company has served (write scope: any company the operator is in).
      await findCustomerInScope(req, req.params.id, 'write')
      const updated = await prisma.customer.update({
        where: { id: req.params.id },
        data: { staffNotes: body.staffNotes },
        select: { id: true, staffNotes: true },
      })
      return updated
    },
  )

  // POST /crm/segments — a saved filter belongs to the ACTIVE company.
  fastify.post('/segments', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z
      .object({ name: z.string().min(1), description: z.string().optional(), filters: segmentFilterSchema })
      .parse(req.body)
    const own = await scopeTenantWhere(req, 'create')
    if (typeof own.tenantId !== 'string') throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before saving a segment', 422)
    if (body.filters.preferredConceptId) await assertConceptOwned(req, body.filters.preferredConceptId, 'create')
    const segment = await prisma.segment.create({ data: { ...body, filters: body.filters, tenantId: own.tenantId } })
    return reply.status(201).send(segment)
  })

  // GET /crm/segments
  fastify.get('/segments', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.segment.findMany({ where: await scopeTenantWhere(req, 'read'), orderBy: { name: 'asc' } })
  })

  // GET /crm/smart-segments — auto-computed live counts, for THIS company:
  // customers who ordered or booked at its brands, with spend / order count /
  // recency measured at its brands only (the customer rollups are global).
  // Definitions follow owner decision 16: VIP = PKR 50k lifetime spend,
  // dormant (lapsed) = no order in 60 days with at least one earlier order.
  fastify.get('/smart-segments', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const now = new Date()
    const d30 = new Date(now.getTime() - 30 * 86_400_000)
    const d60 = new Date(now.getTime() - 60 * 86_400_000)
    const d10 = new Date(now.getTime() - 10 * 86_400_000)

    const conceptIds = await conceptIdsInScope(req, 'read')
    const inScope = await customerScopeWhere(req, 'read')

    const [stats, newCustomers, zeroOrders, totalCustomers, cartAbandonerCount] = await Promise.all([
      companyCustomerStats(conceptIds),
      prisma.customer.count({ where: { createdAt: { gte: d30 }, deletedAt: null, ...inScope } }),
      prisma.customer.count({ where: zeroOrdersWhere(conceptIds) }),
      prisma.customer.count({ where: { deletedAt: null, ...inScope } }),
      prisma.abandonedCart.count({ where: { abandonedAt: { gte: d10 }, recoveredAt: null, conceptId: { in: conceptIds } } }),
    ])
    const count = (pred: (x: CompanyStat) => boolean) => stats.filter(pred).length
    const totalWithOrders = stats.length
    const revenue = stats.reduce((sum, x) => sum + x.spent, 0)
    const frequent = count(isFrequent)

    const avgOrderValue = totalWithOrders > 0 ? Math.round(revenue / totalWithOrders) : 0
    const repeatRate = totalWithOrders > 0 ? Math.round((frequent / totalWithOrders) * 100) : 0

    return {
      summary: {
        totalCustomers,
        repeatRate,
        avgOrderValueCents: avgOrderValue,
      },
      segments: [
        { key: 'new', label: 'New Customers', desc: 'Joined in last 30 days', count: newCustomers },
        { key: 'vip', label: 'VIP Customers', desc: 'Spent 50k PKR+', count: count(isVip) },
        { key: 'repeat', label: 'Repeat Buyers', desc: 'More than 1 order', count: count(isRepeat) },
        { key: 'zero', label: 'Zero Orders', desc: 'Never ordered', count: zeroOrders },
        { key: 'dormant', label: 'Dormant Customers', desc: 'No orders in 60 days', count: count((x) => isDormant(x, d60)) },
        { key: 'frequent', label: 'Frequent Buyers', desc: '3+ orders', count: frequent },
        { key: 'cart_abandoners', label: 'Cart Abandoners', desc: 'Left items in cart (10 days)', count: cartAbandonerCount },
        { key: 'one_time', label: 'One-time Buyers', desc: 'Only one order placed', count: count(isOneTime) },
      ],
    }
  })

  // GET /crm/smart-segments/:key — this company's customers in a smart segment
  fastify.get<{ Params: { key: string }; Querystring: { limit?: string } }>(
    '/smart-segments/:key',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)
      const now = new Date()
      const d30 = new Date(now.getTime() - 30 * 86_400_000)
      const d60 = new Date(now.getTime() - 60 * 86_400_000)
      const d10 = new Date(now.getTime() - 10 * 86_400_000)

      const baseSelect = { id: true, name: true, phone: true, email: true, totalSpentCents: true, lastOrderAt: true, createdAt: true, loyaltyAccount: { select: { pointsBalance: true, tier: true } }, walletBalance: true, isBlacklisted: true }
      const conceptIds = await conceptIdsInScope(req, 'read')
      const inScope = await customerScopeWhere(req, 'read')

      // Spend and last order are shown as measured at THIS company's brands.
      const withCompanyStats = async <T extends { id: string; totalSpentCents: number; lastOrderAt: Date | null }>(rows: T[]) => {
        const st = new Map((await companyCustomerStats(conceptIds, rows.map((r) => r.id))).map((x) => [x.id, x]))
        return rows.map((r) => ({ ...r, totalSpentCents: st.get(r.id)?.spent ?? 0, lastOrderAt: st.get(r.id)?.lastAt ?? null }))
      }

      const key = req.params.key
      if (key === 'new') {
        return withCompanyStats(await prisma.customer.findMany({ where: { createdAt: { gte: d30 }, deletedAt: null, ...inScope }, select: baseSelect, take: limit }))
      }
      if (key === 'zero') {
        return withCompanyStats(await prisma.customer.findMany({ where: zeroOrdersWhere(conceptIds), select: baseSelect, take: limit }))
      }
      if (key === 'cart_abandoners') {
        return prisma.abandonedCart.findMany({
          where: { abandonedAt: { gte: d10 }, recoveredAt: null, conceptId: { in: conceptIds } },
          take: limit,
          select: { customerId: true, customerPhone: true, customerEmail: true, subtotalCents: true },
        })
      }

      const preds: Record<string, (x: CompanyStat) => boolean> = {
        vip: isVip,
        dormant: (x) => isDormant(x, d60),
        frequent: isFrequent,
        one_time: isOneTime,
        repeat: isRepeat,
      }
      const pred = preds[key] ?? preds['repeat']!
      const ids = (await companyCustomerStats(conceptIds)).filter(pred).map((x) => x.id)
      const rows = await prisma.customer.findMany({ where: { id: { in: ids }, deletedAt: null }, select: baseSelect, take: limit })
      return withCompanyStats(rows)
    },
  )

  // PATCH /crm/customers/:id/blacklist
  fastify.patch<{ Params: { id: string }; Body: { isBlacklisted: boolean; reason?: string } }>(
    '/customers/:id/blacklist',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { isBlacklisted, reason } = z.object({
        isBlacklisted: z.boolean(),
        reason: z.string().optional(),
      }).parse(req.body)
      // Only allow blacklisting customers that have ordered from one of our
      // tenant's concepts. (Customer is a global table; this prevents one
      // tenant from globally blacklisting another tenant's customer.)
      const t = await scopeTenantWhere(req, 'write')
      const owned = await prisma.customer.findFirst({
        where: {
          id: req.params.id,
          orders: { some: { concept: { ...t, deletedAt: null } } },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Customer not found in your active company' } })
      return prisma.customer.update({
        where: { id: req.params.id },
        data: { isBlacklisted, blacklistReason: isBlacklisted ? (reason ?? null) : null },
        select: safeCustomerSelect,
      })
    },
  )

  // POST /crm/campaigns — a campaign belongs to the ACTIVE company. Every brand
  // it names must be one of that company's (404 otherwise); none named means
  // every brand of that company, never the platform.
  fastify.post('/campaigns', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createCampaignSchema.parse(req.body)
    const own = await scopeTenantWhere(req, 'create')
    if (typeof own.tenantId !== 'string') throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before creating a campaign', 422)
    const conceptIds = [...new Set(body.conceptIds ?? [])]
    for (const id of conceptIds) await assertConceptOwned(req, id, 'create')
    if (body.segmentId) {
      const seg = await prisma.segment.findFirst({ where: { id: body.segmentId, tenantId: own.tenantId }, select: { id: true } })
      if (!seg) throw new NotFoundError('Segment', body.segmentId)
    }
    const campaign = await prisma.campaign.create({
      data: {
        ...body,
        conceptIds,
        tenantId: own.tenantId,
        status: body.scheduledAt ? 'scheduled' : 'draft',
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
      },
    })
    return reply.status(201).send(campaign)
  })

  // POST /crm/campaigns/:id/send — immediately broadcast
  fastify.post<{ Params: { id: string } }>(
    '/campaigns/:id/send',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      // Company-scoped lookup: a campaign of a company the operator is not in
      // is a 404. A legacy campaign with no company cannot be sent at all.
      const campaign = await prisma.campaign.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        include: { segment: true },
      })
      if (!campaign) throw new NotFoundError('Campaign', req.params.id)

      const where = await campaignAudienceWhere({
        companyConcepts: await companyConceptIds(campaign.tenantId),
        conceptIds: campaign.conceptIds,
        // A segment of another company is ignored rather than trusted.
        segment: campaign.segment && campaign.segment.tenantId === campaign.tenantId ? campaign.segment : null,
        channel: campaign.channel,
      })
      const recipientCount = await prisma.customer.count({ where })
      const campaignId = req.params.id
      const apiBase = process.env['API_URL'] ?? 'http://localhost:3001'

      // Fire-and-forget — don't block the HTTP response. Walks the audience in
      // pages rather than loading it whole; there used to be a hard 2,000 cap
      // here that silently dropped everyone after the 2,000th customer.
      void (async () => {
        let sent = 0
        let cursor: string | undefined
        for (;;) {
          const page = await prisma.customer.findMany({
            where,
            select: { id: true, name: true, email: true, phone: true },
            orderBy: { id: 'asc' },
            take: 500,
            ...(cursor && { cursor: { id: cursor }, skip: 1 }),
          })
          if (page.length === 0) break
          cursor = page[page.length - 1]!.id
          for (const c of page) {
            // One CampaignSend per recipient — the unit click/open tracking and
            // unsubscribe attribute to. Created first so its id can be baked in.
            let send: { id: string }
            try {
              send = await prisma.campaignSend.create({
                data: { campaignId, customerId: c.id, status: 'queued' },
                select: { id: true },
              })
            } catch (err) {
              fastify.log.warn({ customerId: c.id, err }, 'CampaignSend row create failed')
              continue
            }
            const stop = unsubscribeUrl(send.id)
            try {
              if (campaign.channel === 'email' && c.email) {
                const html = trackedHtml(campaign.body, send.id, apiBase) +
                  `<p style="font-size:11px;color:#888;margin-top:24px">Don't want these? <a href="${stop}">Unsubscribe</a>.</p>`
                await sendEmail(c.email, campaign.subject ?? campaign.name, html)
              } else if (campaign.channel === 'whatsapp' && c.phone) {
                // Through the configured WhatsApp gateway. This used to call
                // sendSms (Twilio), which is not configured, so every WhatsApp
                // campaign failed one recipient at a time.
                await sendText(c.phone, `${trackedText(campaign.body, send.id, apiBase)}\n\nStop these messages: ${stop}`)
              } else if (campaign.channel === 'sms' && c.phone) {
                await sendSms(c.phone, `${trackedText(campaign.body, send.id, apiBase)} Stop: ${stop}`)
              } else {
                await prisma.campaignSend.update({ where: { id: send.id }, data: { status: 'failed', errorMsg: 'no contact for channel' } })
                continue
              }
              sent++
              await prisma.campaignSend.update({ where: { id: send.id }, data: { status: 'sent', sentAt: new Date() } })
            } catch (err) {
              await prisma.campaignSend
                .update({ where: { id: send.id }, data: { status: 'failed', errorMsg: String((err as Error).message).slice(0, 280) } })
                .catch(() => { /* ignore */ })
              fastify.log.warn({ customerId: c.id, err }, 'Campaign send failed for customer')
            }
          }
        }
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: 'sent', sentAt: new Date(), recipientCount },
        })
        fastify.log.info({ campaignId, sent, total: recipientCount }, 'Campaign broadcast complete')
      })()

      return { message: 'Campaign broadcast started', campaignId, recipientCount }
    },
  )

  // GET /crm/campaigns/audience — how many people a campaign would reach, so
  // the operator sees the number before pressing send rather than after.
  // Previewed for the ACTIVE company, the one a new campaign is created in.
  fastify.get<{ Querystring: { conceptIds?: string; segmentId?: string; channel?: string } }>(
    '/campaigns/audience',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const own = await scopeTenantWhere(req, 'create')
      const conceptIds = [...new Set((req.query.conceptIds ?? '').split(',').filter(Boolean))]
      for (const id of conceptIds) await assertConceptOwned(req, id, 'create')
      const segment = req.query.segmentId
        ? await prisma.segment.findFirst({ where: { id: req.query.segmentId, ...own } })
        : null
      if (req.query.segmentId && !segment) throw new NotFoundError('Segment', req.query.segmentId)
      const companyConcepts = await companyConceptIds(typeof own.tenantId === 'string' ? own.tenantId : null)
      const where = await campaignAudienceWhere({ companyConcepts, conceptIds, segment, channel: req.query.channel ?? null })
      const [total, optedOut] = await Promise.all([
        prisma.customer.count({ where }),
        prisma.customer.count({
          where: { AND: [{ deletedAt: null, marketingOptOutAt: { not: null } }, companyAudience(companyConcepts, conceptIds)] },
        }),
      ])
      return { total, optedOut }
    },
  )

  // GET /crm/campaigns — this company's campaigns only.
  fastify.get('/campaigns', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.campaign.findMany({
      where: await scopeTenantWhere(req, 'read'),
      include: { segment: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    })
  })

  // GET /crm/behavioral-segments — all 15 computed segments, counted over THIS
  // company's customers. Memberships are computed platform-wide (the table has
  // no company column), so the count and member list are narrowed at read.
  fastify.get(
    '/behavioral-segments',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const inScope = await customerScopeWhere(req, 'read')
      const [segments, counts] = await Promise.all([
        prisma.customerSegment.findMany({
          select: {
            id: true, slug: true, name: true, description: true,
            color: true, emoji: true, memberCount: true, lastComputedAt: true,
          },
        }),
        prisma.customerSegmentMembership.groupBy({
          by: ['segmentId'],
          where: { customer: { deletedAt: null, ...inScope } },
          _count: { _all: true },
        }),
      ])
      const n = new Map(counts.map((c) => [c.segmentId, c._count._all]))
      return segments
        .map((sg) => ({ ...sg, memberCount: n.get(sg.id) ?? 0 }))
        .sort((x, y) => y.memberCount - x.memberCount || x.name.localeCompare(y.name))
    },
  )

  // GET /crm/behavioral-segments/:slug/members — this company's customers only.
  fastify.get<{ Params: { slug: string }; Querystring: { limit?: string } }>(
    '/behavioral-segments/:slug/members',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '200', 10), 500)
      return getSegmentsWithMembers(req.params.slug, limit, { deletedAt: null, ...(await customerScopeWhere(req, 'read')) })
    },
  )

  // POST /crm/behavioral-segments/compute — trigger recomputation (admin/manager)
  fastify.post(
    '/behavioral-segments/compute',
    { preHandler: requireAuth(...MANAGERS) },
    async (_, reply) => {
      // Fire and forget — client polls /behavioral-segments for updated counts
      setImmediate(async () => {
        try {
          await computeAllSegments()
        } catch (err) {
          console.error('[segments] Manual compute failed:', (err as Error).message)
        }
      })
      return reply.status(202).send({ message: 'Segment computation started' })
    },
  )

  // ─── Customer conversations (CRM outreach) ──────────────────────────────────
  // Symmetric to /procurement/conversations but with a `source` + `sourceRefId`
  // for linkage back to the originating complaint/review when applicable.

  // GET /crm/conversations — all customer threads, tenant-scoped via the
  // customer's order history. Each row carries the customer's preferred
  // brand so a centralised CRM operator can tell whether they're handling
  // a Bukhari / Clifton / etc. customer before they reply.
  fastify.get<{ Querystring: { customerId?: string } }>(
    '/conversations',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const where: Prisma.CustomerConversationWhereInput = {
        // Only this company's threads: the customer has dealt with one of its
        // brands and the thread was opened by its staff. Portfolio mode
        // (x-servd-portfolio: 1) expands to every company the operator is in.
        ...conversationOfCompanies(await scopeTenantWhere(req, 'read')),
        ...(req.query.customerId ? { customerId: req.query.customerId } : {}),
      }
      return prisma.customerConversation.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true, name: true, email: true, phone: true,
              preferredConcept: { select: { name: true, slug: true } },
            },
          },
          staff:    { select: { id: true, name: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          _count:   { select: { messages: true } },
        },
        orderBy: { updatedAt: 'desc' },
      })
    },
  )

  // POST /crm/conversations — start a thread (staff-initiated outreach)
  fastify.post(
    '/conversations',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        customerId:  z.string().uuid(),
        subject:     z.string().max(200).optional(),
        message:     z.string().min(1).max(5000),
        source:      z.enum(['complaint', 'review', 'manual']).default('manual'),
        sourceRefId: z.string().optional(),
      }).parse(req.body)

      // Only a customer of the ACTIVE company: the message goes out on that
      // company's channels, so it must be someone that company has served.
      const customer = await findCustomerInScope(req, body.customerId, 'create')

      const conversation = await prisma.customerConversation.create({
        data: {
          customerId:  body.customerId,
          staffId:     req.staffUser!.id,
          subject:     body.subject,
          source:      body.source,
          sourceRefId: body.sourceRefId,
          messages: {
            create: {
              fromStaff: true,
              senderId:  req.staffUser!.id,
              body:      body.message,
              channel:   'web_portal',
            },
          },
        },
        include: {
          customer: { select: { id: true, name: true, email: true, phone: true } },
          staff:    { select: { id: true, name: true } },
          messages: true,
        },
      })

      // Best-effort email + WhatsApp fan-out — see supplier chat for rationale.
      void deliverToCustomer({
        conversation: { id: conversation.id, subject: conversation.subject },
        customer:     { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone },
        body:         body.message,
        fromStaffName: req.staffUser!.name ?? 'servd',
        isFirstMessage: true,
      }).catch((err) => console.error(`[crm/chat] fan-out failed for conv=${conversation.id}:`, (err as Error).message))

      return reply.status(201).send(conversation)
    },
  )

  // GET /crm/conversations/:id/messages — load thread + mark customer-side seen
  fastify.get<{ Params: { id: string } }>(
    '/conversations/:id/messages',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const conv = await prisma.customerConversation.findFirst({
        where: { id: req.params.id, ...conversationOfCompanies(await scopeTenantWhere(req, 'read')) },
      })
      if (!conv) throw new NotFoundError('Conversation', req.params.id)

      await prisma.customerMessage.updateMany({
        where: { conversationId: req.params.id, fromStaff: false, seenAt: null },
        data:  { seenAt: new Date() },
      })

      return prisma.customerMessage.findMany({
        where:   { conversationId: req.params.id },
        orderBy: { createdAt: 'asc' },
      })
    },
  )

  // POST /crm/conversations/:id/messages — staff replies in an existing thread
  fastify.post<{ Params: { id: string } }>(
    '/conversations/:id/messages',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        body:     z.string().min(1).max(5000),
        mediaUrl: z.string().url().optional(),
      }).parse(req.body)

      const conv = await prisma.customerConversation.findFirst({
        where: { id: req.params.id, ...conversationOfCompanies(await scopeTenantWhere(req, 'write')) },
        include: { customer: true },
      })
      if (!conv) throw new NotFoundError('Conversation', req.params.id)

      const message = await prisma.customerMessage.create({
        data: {
          conversationId: req.params.id,
          fromStaff:      true,
          senderId:       req.staffUser!.id,
          body:           body.body,
          mediaUrl:       body.mediaUrl,
          channel:        'web_portal',
        },
      })
      await prisma.customerConversation.update({
        where: { id: req.params.id },
        data:  { updatedAt: new Date() },
      })

      void deliverToCustomer({
        conversation: { id: conv.id, subject: conv.subject },
        customer:     { id: conv.customer.id, name: conv.customer.name, email: conv.customer.email, phone: conv.customer.phone },
        body:         body.body,
        fromStaffName: req.staffUser!.name ?? 'servd',
        isFirstMessage: false,
      }).catch((err) => console.error(`[crm/chat] fan-out failed for conv=${conv.id}:`, (err as Error).message))

      return reply.status(201).send(message)
    },
  )

  // ════════════════════════════════════════════════════════════════════════
  // Naughty list — strikes + bans
  // ════════════════════════════════════════════════════════════════════════

  // GET /crm/naughty-list — operator inbox. Customers of THIS company with
  // strikes or bans that THIS company raised (decision 15: a ban applies only
  // to the company that raised it), sorted by severity. Strikes/bans carry no
  // company column yet; they are attributed through their source order /
  // reservation or the staff member who raised them (crm/customerScope.ts).
  fastify.get<{ Querystring: { kind?: string; bannedOnly?: string } }>(
    '/naughty-list',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const now = new Date()
      const bannedOnly = req.query.bannedOnly === '1' || req.query.bannedOnly === 'true'
      const t = await scopeTenantWhere(req, 'read')
      const scope = tenantIdsOf(t)

      const customers = await prisma.customer.findMany({
        where: {
          deletedAt: null,
          AND: [
            customerOfCompanies(t),
            { OR: [
              { bannedAt:    { not: null } },
              { strikeCount: { gt: 0 } },
              { isBlacklisted: true },
            ] },
          ],
          ...(bannedOnly && { bannedAt: { not: null } }),
        },
        select: {
          id: true, name: true, email: true, phone: true,
          strikeCount: true, bannedAt: true,
          isBlacklisted: true, blacklistReason: true,
          totalSpentCents: true, lastOrderAt: true,
        },
        orderBy: [{ bannedAt: 'desc' }, { strikeCount: 'desc' }],
        take: 200,
      })

      const ids = customers.map((c) => c.id)
      const [strikeRows, banRows] = ids.length > 0 ? await Promise.all([
        prisma.customerStrike.findMany({
          where: { customerId: { in: ids }, ...(req.query.kind && { kind: req.query.kind }) },
          orderBy: { recordedAt: 'desc' },
        }),
        prisma.customerBan.findMany({
          where: { customerId: { in: ids } },
          select: { id: true, customerId: true, bannedById: true, bannedAt: true, liftedAt: true, expiresAt: true },
        }),
      ]) : [[], []]
      const [sc, bc] = await Promise.all([strikeCompanies(strikeRows), banCompanies(banRows)])
      const strikes = strikeRows.filter((st) => inCompanies(sc.get(st.id), scope, true))
      const ourActiveBan = new Map<string, Date>()
      const hasAnyBan = new Set<string>()
      for (const b of banRows) {
        if (!b.customerId) continue
        hasAnyBan.add(b.customerId)
        const active = !b.liftedAt && (!b.expiresAt || b.expiresAt > now)
        if (active && inCompanies(bc.get(b.id), scope, true) && !ourActiveBan.has(b.customerId)) ourActiveBan.set(b.customerId, b.bannedAt)
      }

      // Group + summarise per customer
      const byCustomer = new Map<string, typeof strikes>()
      for (const st of strikes) {
        const list = byCustomer.get(st.customerId) ?? []
        list.push(st)
        byCustomer.set(st.customerId, list)
      }

      return customers
        .map((c) => {
          const list = byCustomer.get(c.id) ?? []
          const active = list.filter((st) => !st.reversedAt && (!st.expiresAt || st.expiresAt > now))
          // Show this company's ban, not another company's.
          const bannedAt = ourActiveBan.get(c.id) ?? null
          return {
            customer: { ...c, bannedAt, strikeCount: active.reduce((n, st) => n + st.severity, 0) },
            activeStrikes: active.length,
            totalStrikes:  list.length,
            strikes: list.slice(0, 10),    // most recent 10 for the row
            // A legacy blacklist flag with no ban row behind it is shown as is.
            _keep: list.length > 0 || !!bannedAt || (c.isBlacklisted && !hasAnyBan.has(c.id)),
          }
        })
        .filter((r) => r._keep && (!bannedOnly || r.customer.bannedAt))
        .map(({ _keep: _k, ...r }) => r)
    },
  )

  // POST /crm/strikes — manually record a strike (operator's call).
  // Used when something happens IRL that the system can't auto-detect:
  // verbal abuse to staff, dine-and-dash, etc. Only against a customer of
  // the ACTIVE company; the strike is attributed to it through recordedById.
  fastify.post(
    '/strikes',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        customerId: z.string().uuid(),
        kind:       z.enum(['reservation_no_show', 'cod_unpaid', 'cod_refused', 'chargeback', 'other']),
        severity:   z.number().int().min(1).max(3).default(1),
        reason:     z.string().max(500),
      }).parse(req.body)

      await findCustomerInScope(req, body.customerId, 'create')
      const { recordStrike } = await import('../../lib/strikes.js')
      await recordStrike({
        customerId:   body.customerId,
        kind:         body.kind,
        severity:     body.severity,
        reason:       body.reason,
        recordedById: req.staffUser!.id,
      })
      const customer = await prisma.customer.findUnique({
        where: { id: body.customerId },
        select: { strikeCount: true, bannedAt: true },
      })
      return reply.status(201).send({ ok: true, customer })
    },
  )

  // POST /crm/strikes/:id/reverse — manager forgives a strike. If reversing
  // drops the customer below the ban threshold, the auto-ban is auto-lifted.
  // Only a strike this company raised (404 otherwise).
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/strikes/:id/reverse',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({ reason: z.string().max(500) }).parse(req.body)
      const strike = await prisma.customerStrike.findUnique({
        where: { id: req.params.id },
        select: { id: true, customerId: true, sourceType: true, sourceId: true, recordedById: true },
      })
      if (!strike) throw new NotFoundError('Strike', req.params.id)
      const t = await scopeTenantWhere(req, 'write')
      const customerOk = !!(await prisma.customer.findFirst({ where: { id: strike.customerId, ...customerOfCompanies(t) }, select: { id: true } }))
      const sc = await strikeCompanies([strike])
      if (!customerOk || !inCompanies(sc.get(strike.id), tenantIdsOf(t), customerOk)) throw new NotFoundError('Strike', req.params.id)
      const { reverseStrike } = await import('../../lib/strikes.js')
      const result = await reverseStrike(req.params.id, req.staffUser!.id, body.reason)
      return result
    },
  )

  // GET /crm/bans — every ban THIS company raised, active + historical.
  fastify.get<{ Querystring: { activeOnly?: string } }>(
    '/bans',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const now = new Date()
      const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true'
      const t = await scopeTenantWhere(req, 'read')

      // Candidates: bans on this company's customers, plus watchlist bans
      // (no customer) raised by this company's staff.
      const staff = await prisma.user.findMany({ where: userOfCompanies(t), select: { id: true } })
      const bans = await prisma.customerBan.findMany({
        where: {
          ...(activeOnly && {
            liftedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          }),
          AND: [{ OR: [
            { customer: customerOfCompanies(t) },
            { customerId: null, bannedById: { in: staff.map((u) => u.id) } },
          ] }],
        },
        include: {
          customer: { select: { id: true, name: true, email: true, phone: true } },
        },
        orderBy: { bannedAt: 'desc' },
        take: 500,
      })
      const bc = await banCompanies(bans)
      const scope = tenantIdsOf(t)
      return bans.filter((b) => inCompanies(bc.get(b.id), scope, true)).slice(0, 200)
    },
  )

  // POST /crm/bans/:id/lift — operator lifts a ban (forgives the customer).
  // Requires a reason for the audit trail. Only a ban this company raised.
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/bans/:id/lift',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({ reason: z.string().max(500) }).parse(req.body)
      const ban = await prisma.customerBan.findUnique({ where: { id: req.params.id } })
      if (!ban) throw new NotFoundError('Ban', req.params.id)
      const t = await scopeTenantWhere(req, 'write')
      const customerOk = ban.customerId
        ? !!(await prisma.customer.findFirst({ where: { id: ban.customerId, ...customerOfCompanies(t) }, select: { id: true } }))
        : true
      const bc = await banCompanies([ban])
      if (!customerOk || !inCompanies(bc.get(ban.id), tenantIdsOf(t), customerOk)) throw new NotFoundError('Ban', req.params.id)
      if (ban.liftedAt) return ban

      const updated = await prisma.customerBan.update({
        where: { id: ban.id },
        data:  {
          liftedAt:    new Date(),
          liftedById:  req.staffUser!.id,
          liftReason:  body.reason,
        },
      })
      // Sync the denormalized customer flag — only when no other ban on the
      // customer is still active (another company's ban stays in force).
      if (ban.customerId) {
        const now = new Date()
        const stillBanned = await prisma.customerBan.findFirst({
          where: { customerId: ban.customerId, liftedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          select: { id: true },
        })
        if (!stillBanned) {
          await prisma.customer.update({
            where: { id: ban.customerId },
            data:  { bannedAt: null, isBlacklisted: false, blacklistReason: null },
          })
        }
      }
      return updated
    },
  )

  // POST /crm/bans — operator-initiated ban. For when a customer hasn't hit
  // 3 strikes yet but they've done something egregious. Doesn't bypass the
  // strikes — just creates the ban directly. Only a customer of the ACTIVE
  // company; the ban is attributed to it through bannedById.
  fastify.post(
    '/bans',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        customerId: z.string().uuid().optional(),
        email:      z.string().email().optional(),
        phone:      z.string().min(7).max(20).optional(),
        reason:     z.string().min(3).max(500),
        expiresAt:  z.string().datetime().optional(),
      }).refine((v) => !!(v.customerId || v.email || v.phone), {
        message: 'Provide at least one of customerId / email / phone',
      }).parse(req.body)

      // Resolve customerId from email/phone if not supplied
      let customerId = body.customerId ?? null
      if (!customerId && (body.email || body.phone)) {
        const c = await prisma.customer.findFirst({
          where: {
            OR: [
              ...(body.email ? [{ email: body.email.toLowerCase() }] : []),
              ...(body.phone ? [{ phone: body.phone }] : []),
            ],
          },
          select: { id: true },
        })
        if (c) customerId = c.id
      }
      // A known customer must be one this company has served. (An unknown
      // contact becomes a watchlist entry with no customer attached.)
      if (customerId) await findCustomerInScope(req, customerId, 'create')

      const ban = await prisma.customerBan.create({
        data: {
          customerId,
          email:      body.email?.toLowerCase() ?? null,
          phone:      body.phone ?? null,
          reason:     body.reason,
          bannedById: req.staffUser!.id,
          expiresAt:  body.expiresAt ? new Date(body.expiresAt) : null,
        },
      })
      if (customerId) {
        await prisma.customer.update({
          where: { id: customerId },
          data:  { bannedAt: new Date(), isBlacklisted: true, blacklistReason: body.reason },
        })
      }
      return reply.status(201).send(ban)
    },
  )
}
