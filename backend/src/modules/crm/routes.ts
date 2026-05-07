import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { sendEmail, sendSms } from '../../lib/notify.js'
import { computeAllSegments, getSegmentsWithMembers } from './segmentComputation.js'
import { deliverToCustomer } from '../../lib/customer-channels.js'

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
        orders: { some: { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } } },
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
      const ops = await getOperationsConfig()
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
      const customer = await prisma.customer.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          // Only allow viewing if this customer has ordered from a concept
          // under the active tenant.
          orders: { some: { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } } },
        },
        select: {
          ...safeCustomerSelect,
          orders: {
            where: { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
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

  // POST /crm/segments
  fastify.post('/segments', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z
      .object({ name: z.string().min(1), description: z.string().optional(), filters: segmentFilterSchema })
      .parse(req.body)
    const segment = await prisma.segment.create({ data: { ...body, filters: body.filters } })
    return reply.status(201).send(segment)
  })

  // GET /crm/segments
  fastify.get('/segments', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.segment.findMany({ orderBy: { name: 'asc' } })
  })

  // GET /crm/smart-segments — auto-computed live counts
  fastify.get('/smart-segments', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const now = new Date()
    const d30 = new Date(now.getTime() - 30 * 86_400_000)
    const d60 = new Date(now.getTime() - 60 * 86_400_000)
    const d10 = new Date(now.getTime() - 10 * 86_400_000)

    // Tenant scope helper — only customers with at least one order in a
    // concept under the active tenant count toward the operator's segments.
    const tenantOrderFilter = { orders: { some: { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } } } }

    const [newCustomers, vipCustomers, repeatBuyers, zeroOrders, dormant, totalCustomers, totalRevAgg, totalWithOrders] = await Promise.all([
      prisma.customer.count({ where: { createdAt: { gte: d30 }, deletedAt: null, ...tenantOrderFilter } }),
      prisma.customer.count({ where: { totalSpentCents: { gte: 50_000_00 }, deletedAt: null, ...tenantOrderFilter } }), // 50k PKR+
      prisma.customer.count({ where: { ...tenantOrderFilter, deletedAt: null } }),
      prisma.customer.count({ where: { firstOrderAt: null, deletedAt: null } }),
      prisma.customer.count({ where: { lastOrderAt: { lt: d60 }, deletedAt: null, ...tenantOrderFilter } }),
      prisma.customer.count({ where: { deletedAt: null, ...tenantOrderFilter } }),
      prisma.customer.aggregate({ where: { deletedAt: null, ...tenantOrderFilter }, _sum: { totalSpentCents: true } }),
      prisma.customer.count({ where: { deletedAt: null, firstOrderAt: { not: null }, ...tenantOrderFilter } }),
    ])

    // Frequent buyers (3+ orders) — raw query for efficiency
    const frequentCount = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM customers c
      WHERE c."deletedAt" IS NULL
      AND (SELECT COUNT(*) FROM orders o WHERE o."customerId" = c.id AND o."deletedAt" IS NULL) >= 3
    `
    const oneTimeCount = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM customers c
      WHERE c."deletedAt" IS NULL
      AND (SELECT COUNT(*) FROM orders o WHERE o."customerId" = c.id AND o."deletedAt" IS NULL) = 1
    `
    const cartAbandonerCount = await prisma.abandonedCart.count({
      where: { abandonedAt: { gte: d10 }, recoveredAt: null },
    })

    const avgOrderValue = totalWithOrders > 0
      ? Math.round((totalRevAgg._sum.totalSpentCents ?? 0) / totalWithOrders)
      : 0
    const repeatRate = totalWithOrders > 0
      ? Math.round((Number(frequentCount[0]?.count ?? 0) / totalWithOrders) * 100)
      : 0

    return {
      summary: {
        totalCustomers,
        repeatRate,
        avgOrderValueCents: avgOrderValue,
      },
      segments: [
        { key: 'new', label: 'New Customers', desc: 'Joined in last 30 days', count: newCustomers },
        { key: 'vip', label: 'VIP Customers', desc: 'Spent 50k PKR+', count: vipCustomers },
        { key: 'repeat', label: 'Repeat Buyers', desc: 'More than 1 order', count: repeatBuyers },
        { key: 'zero', label: 'Zero Orders', desc: 'Never ordered', count: zeroOrders },
        { key: 'dormant', label: 'Dormant Customers', desc: 'No orders in 60 days', count: dormant },
        { key: 'frequent', label: 'Frequent Buyers', desc: '3+ orders', count: Number(frequentCount[0]?.count ?? 0) },
        { key: 'cart_abandoners', label: 'Cart Abandoners', desc: 'Left items in cart (10 days)', count: cartAbandonerCount },
        { key: 'one_time', label: 'One-time Buyers', desc: 'Only one order placed', count: Number(oneTimeCount[0]?.count ?? 0) },
      ],
    }
  })

  // GET /crm/smart-segments/:key — customers in a specific smart segment
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

      const key = req.params.key
      if (key === 'new') return prisma.customer.findMany({ where: { createdAt: { gte: d30 }, deletedAt: null }, select: baseSelect, take: limit })
      if (key === 'vip') return prisma.customer.findMany({ where: { totalSpentCents: { gte: 5_000_000 }, deletedAt: null }, select: baseSelect, take: limit })
      if (key === 'zero') return prisma.customer.findMany({ where: { firstOrderAt: null, deletedAt: null }, select: baseSelect, take: limit })
      if (key === 'dormant') return prisma.customer.findMany({ where: { lastOrderAt: { lt: d60 }, deletedAt: null }, select: baseSelect, take: limit })
      if (key === 'cart_abandoners') {
        const carts = await prisma.abandonedCart.findMany({ where: { abandonedAt: { gte: d10 }, recoveredAt: null }, take: limit, select: { customerId: true, customerPhone: true, customerEmail: true, subtotalCents: true } })
        return carts
      }

      // frequent / one_time / repeat — raw query
      if (key === 'frequent') {
        return prisma.$queryRaw`SELECT c.id, c.name, c.phone, c.email, c."totalSpentCents", c."lastOrderAt", c."walletBalance", c."isBlacklisted" FROM customers c WHERE c."deletedAt" IS NULL AND (SELECT COUNT(*) FROM orders o WHERE o."customerId" = c.id AND o."deletedAt" IS NULL) >= 3 LIMIT ${limit}`
      }
      if (key === 'one_time') {
        return prisma.$queryRaw`SELECT c.id, c.name, c.phone, c.email, c."totalSpentCents", c."lastOrderAt", c."walletBalance", c."isBlacklisted" FROM customers c WHERE c."deletedAt" IS NULL AND (SELECT COUNT(*) FROM orders o WHERE o."customerId" = c.id AND o."deletedAt" IS NULL) = 1 LIMIT ${limit}`
      }
      return prisma.customer.findMany({ where: { orders: { some: {} }, deletedAt: null }, select: baseSelect, take: limit })
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
      const owned = await prisma.customer.findFirst({
        where: {
          id: req.params.id,
          orders: { some: { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } } },
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

  // POST /crm/campaigns
  fastify.post('/campaigns', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createCampaignSchema.parse(req.body)
    const campaign = await prisma.campaign.create({
      data: {
        ...body,
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
      const campaign = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: { segment: true },
      })
      if (!campaign) throw new NotFoundError('Campaign', req.params.id)

      // Build recipient list: apply segment JSON filters if a segment is attached
      const segmentFilters = campaign.segment?.filters as {
        minSpendCents?: number
        maxSpendCents?: number
        minOrders?: number
        daysSinceLastOrder?: number
        preferredConceptId?: string
      } | null | undefined

      const customers = await prisma.customer.findMany({
        where: {
          marketingOptIn: true,
          deletedAt: null,
          ...(segmentFilters?.minSpendCents !== undefined && {
            totalSpentCents: { gte: segmentFilters.minSpendCents },
          }),
          ...(segmentFilters?.maxSpendCents !== undefined && {
            totalSpentCents: { lte: segmentFilters.maxSpendCents },
          }),
          ...(segmentFilters?.daysSinceLastOrder !== undefined && {
            lastOrderAt: {
              lt: new Date(Date.now() - segmentFilters.daysSinceLastOrder * 86_400_000),
            },
          }),
          ...(segmentFilters?.preferredConceptId && {
            preferredConceptId: segmentFilters.preferredConceptId,
          }),
          ...(segmentFilters?.minOrders !== undefined && {
            orders: { some: {} }, // refined below via having-count if needed
          }),
        },
        select: { id: true, name: true, email: true, phone: true, _count: { select: { orders: true } } },
        take: 2000,
      }).then((rows) =>
        segmentFilters?.minOrders !== undefined
          ? rows.filter((r) => r._count.orders >= segmentFilters.minOrders!)
          : rows,
      )

      const campaignId = req.params.id
      const recipientCount = customers.length

      // Fire-and-forget — don't block the HTTP response (2000 sends at 100ms each = 200s)
      void (async () => {
        let sent = 0
        for (const c of customers) {
          try {
            if (campaign.channel === 'email' && c.email) {
              await sendEmail(c.email, campaign.subject ?? campaign.name, `<p>${campaign.body}</p>`)
              sent++
            } else if ((campaign.channel === 'sms' || campaign.channel === 'whatsapp') && c.phone) {
              await sendSms(c.phone, campaign.body)
              sent++
            }
          } catch (err) {
            fastify.log.warn({ customerId: c.id, err }, 'Campaign send failed for customer')
          }
        }
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: 'sent', sentAt: new Date() },
        })
        fastify.log.info({ campaignId, sent, total: recipientCount }, 'Campaign broadcast complete')
      })()

      return { message: 'Campaign broadcast started', campaignId, recipientCount }
    },
  )

  // GET /crm/campaigns
  fastify.get('/campaigns', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.campaign.findMany({
      include: { segment: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    })
  })

  // GET /crm/behavioral-segments — all 15 computed segments with counts
  fastify.get(
    '/behavioral-segments',
    { preHandler: requireAuth(...MANAGERS) },
    async () => {
      return prisma.customerSegment.findMany({
        orderBy: [{ memberCount: 'desc' }, { name: 'asc' }],
        select: {
          id: true, slug: true, name: true, description: true,
          color: true, emoji: true, memberCount: true, lastComputedAt: true,
        },
      })
    },
  )

  // GET /crm/behavioral-segments/:slug/members
  fastify.get<{ Params: { slug: string }; Querystring: { limit?: string } }>(
    '/behavioral-segments/:slug/members',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '200', 10), 500)
      return getSegmentsWithMembers(req.params.slug, limit)
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

  // GET /crm/conversations — all customer threads
  fastify.get<{ Querystring: { customerId?: string } }>(
    '/conversations',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const where = req.query.customerId ? { customerId: req.query.customerId } : {}
      return prisma.customerConversation.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, email: true, phone: true } },
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

      const customer = await prisma.customer.findUnique({ where: { id: body.customerId } })
      if (!customer || customer.deletedAt) throw new NotFoundError('Customer', body.customerId)

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
      const conv = await prisma.customerConversation.findUnique({ where: { id: req.params.id } })
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

      const conv = await prisma.customerConversation.findUnique({
        where: { id: req.params.id },
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
}
