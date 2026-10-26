import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, MARKETING_TEAM, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError, ForbiddenError } from '../../lib/errors.js'
import { sendEmail, sendPhoneMessage } from '../../lib/notify.js'
import {
  escapeHtml, isCampaignSegment, campaignSegmentOf, companyConceptIds, campaignAudienceWhere,
  assertCampaignChannel, sendableSegment, claimAndBroadcast, CAMPAIGN_SEND_SELECT,
} from './campaignBroadcast.js'
import { audit } from '../../lib/audit.js'
import { companyAudience } from '../../lib/marketingAudience.js'
import { WAITLIST_AUDIENCE, WAITLIST_AUDIENCE_NAME, waitlistMemberWhere, staffModules } from '../waitlist/service.js'
import {
  computeAllSegments, getSegmentsWithMembers, companySegments, isSegmentSlug, SEGMENT_DEFS,
} from './segmentComputation.js'
import { deliverToCustomer } from '../../lib/customer-channels.js'
import { customerScope } from '../../lib/outboundScope.js'
import { scopeTenantWhere, assertConceptOwned, conceptIdsInScope, activeTenantId, type TenantIdWhere } from '../../lib/tenantScope.js'
import { walletBalancesOf, balanceInView } from '../wallet/service.js'
import {
  customerOfCompanies, findCustomerInScope, tenantIdsOf,
  strikeCompanies, banCompanies, inCompanies, userOfCompanies,
} from './customerScope.js'
import { contactCorrectionRoutes } from './contactCorrection.js'

// Loyalty accounts are per company (ONL-04): staff read only the accounts of
// the companies in view (`loyaltyAccounts: { where: t }`), and `loyaltyAccount`
// — the one-account shape the admin reads — is the account at the operator's
// active company, else the first in view.
function loyaltyAccountInView<A extends { tenantId: string }>(accounts: A[], activeTenantId: string | null | undefined): A | null {
  return accounts.find((a) => a.tenantId === activeTenantId) ?? accounts[0] ?? null
}

/**
 * The waitlist is a servd-level list, not one company's customers, so sending
 * to it (or creating a campaign for it) needs the CEO or the campaigns module.
 */
async function assertCanUseWaitlist(req: FastifyRequest): Promise<void> {
  if (req.staffUser!.role === 'admin') return
  if (!(await staffModules(req)).has('campaigns')) {
    throw new ForbiddenError('Sending to the new-brand waitlist needs the Campaigns module. Ask the CEO to enable it.')
  }
}

// Channels: email and WhatsApp only (owner decision 17 — Twilio SMS is gone).
// A campaign targets one customer segment (./segmentComputation.ts) or, with
// none, everyone reachable in the chosen brands.
const createCampaignSchema = z
  .object({
    name: z.string().min(1),
    segment: z.string().max(40).nullable().optional(),
    channel: z.enum(['email', 'whatsapp']),
    subject: z.string().optional(),
    body: z.string().min(1),
    scheduledAt: z.string().datetime().optional(),
    // Empty or omitted = every brand of the active company.
    conceptIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .refine((d) => d.channel !== 'email' || (d.subject && d.subject.length > 0), {
    message: 'subject is required for email campaigns',
    path: ['subject'],
  })
  .refine((d) => !d.segment || isCampaignSegment(d.segment), { message: 'unknown segment', path: ['segment'] })

// The customer card the CRM lists. The customer's own rollups
// (totalSpentCents, firstOrderAt, lastOrderAt, the order count) are GLOBAL
// across companies, so they are not selected here: scopedCustomerFigures()
// replaces them with what the customer did at the brands in view (W3A-RV-02).
const safeCustomerSelect = {
  id: true, name: true, email: true, phone: true,
  // The servd name + the internal member barcode (owner, 2026-10-26).
  nickname: true, memberCode: true,
  marketingOptIn: true, birthdayMmDd: true,
  preferredConceptId: true, createdAt: true, updatedAt: true,
  preferredConcept: { select: { name: true, slug: true, tenantId: true } },
} as const

type CompanyStat = { id: string; n: number; spent: number; firstAt: Date | null; lastAt: Date | null }

/**
 * The company-facing figures of a customer card (W3A-RV-02). A customer is
 * global; what they spent, how often and when they ordered at ANOTHER
 * company's brands — and which of its brands they prefer — is that company's
 * business, not this operator's:
 *   - spend / order count / first + last order = completed orders at the
 *     brands in view only (companyCustomerStats);
 *   - preferredConcept(Id) only when that brand is a company in view, else null;
 *   - walletBalance is the customer's wallet at the companies in view (the
 *     wallet is per company, ONL-R2-01 — another company's balance is not
 *     ours to show), and only to the roles that run wallets (MANAGERS, who
 *     credit it via /wallet); the marketing roles get null.
 */
async function scopedCustomerFigures<C extends {
  id: string
  preferredConceptId: string | null
  preferredConcept: { name: string; slug: string; tenantId: string | null } | null
}>(req: FastifyRequest, scope: string[], customers: C[]) {
  const conceptIds = await conceptIdsInScope(req, 'read')
  const stats = new Map((await companyCustomerStats(conceptIds, customers.map((c) => c.id))).map((s) => [s.id, s]))
  const seesWallet = (MANAGERS as string[]).includes(req.staffUser!.role)
  const wallets = seesWallet ? await walletBalancesOf(customers.map((c) => c.id), scope) : null
  return customers.map(({ preferredConcept, ...c }) => {
    const s = stats.get(c.id)
    const ownBrand = !!preferredConcept?.tenantId && scope.includes(preferredConcept.tenantId)
    return {
      ...c,
      totalSpentCents: s?.spent ?? 0,
      firstOrderAt: s?.firstAt ?? null,
      lastOrderAt: s?.lastAt ?? null,
      _count: { orders: s?.n ?? 0 },
      walletBalance: wallets ? balanceInView(wallets.get(c.id), scope) : null,
      preferredConceptId: ownBrand ? c.preferredConceptId : null,
      preferredConcept: ownBrand && preferredConcept ? { name: preferredConcept.name, slug: preferredConcept.slug } : null,
    }
  })
}

/**
 * Per-customer completed-order stats at THESE brands only. Customer rollups
 * (totalSpentCents, lastOrderAt, firstOrderAt) are global across companies, so
 * every company-facing segment reads this instead — a customer who spent
 * PKR 80k at company A is not company B's VIP.
 */
async function companyCustomerStats(conceptIds: string[], customerIds?: string[]): Promise<CompanyStat[]> {
  if (conceptIds.length === 0 || (customerIds && customerIds.length === 0)) return []
  const rows = await prisma.$queryRaw<Array<{ id: string; n: number; spent: bigint; first_at: Date | null; last_at: Date | null }>>`
    SELECT o."customerId" AS id, COUNT(*)::int AS n, COALESCE(SUM(o."totalCents"), 0)::bigint AS spent,
           MIN(COALESCE(o."completedAt", o."placedAt")) AS first_at,
           MAX(COALESCE(o."completedAt", o."placedAt")) AS last_at
    FROM orders o
    JOIN customers c ON c.id = o."customerId" AND c."deletedAt" IS NULL
    WHERE o."deletedAt" IS NULL AND o.status = 'completed'
      AND o."conceptId" = ANY(${conceptIds}::text[])
      ${customerIds ? Prisma.sql`AND o."customerId" = ANY(${customerIds}::text[])` : Prisma.empty}
    GROUP BY o."customerId"`
  return rows.map((r) => ({ id: r.id, n: Number(r.n), spent: Number(r.spent), firstAt: r.first_at, lastAt: r.last_at }))
}

/**
 * No-show, complaint, review and last-seated figures of one customer at the
 * brands in view (`t` = scopeTenantWhere). The Customer columns of the same
 * name are servd-wide rollups (lib/customerRollups.ts) — the same definitions,
 * narrowed to this company's brands.
 */
async function companyActivityFigures(customerId: string, t: Prisma.ConceptWhereInput) {
  const inCo = { concept: t }
  const [noShows, complaints, reviews, lastSeated] = await Promise.all([
    prisma.reservation.aggregate({
      where: { customerId, status: 'no_show', ...inCo },
      _count: { _all: true }, _max: { updatedAt: true },
    }),
    prisma.orderComplaint.aggregate({
      where: { customerId, kind: 'complaint', ...inCo },
      _count: { _all: true }, _max: { createdAt: true },
    }),
    prisma.orderReview.aggregate({
      where: { customerId, ...inCo },
      _count: { _all: true }, _max: { createdAt: true }, _avg: { rating: true },
    }),
    prisma.reservation.findFirst({
      where: { customerId, seatedAt: { not: null }, ...inCo },
      select: { seatedAt: true }, orderBy: { seatedAt: 'desc' },
    }),
  ])
  return {
    lastSeatedAt: lastSeated?.seatedAt ?? null,
    figures: {
      noShowCount: noShows._count._all,
      lastNoShowAt: noShows._max.updatedAt ?? null,
      complaintCount: complaints._count._all,
      lastComplaintAt: complaints._max.createdAt ?? null,
      reviewCount: reviews._count._all,
      lastReviewedAt: reviews._max.createdAt ?? null,
      avgReviewRating: reviews._avg.rating ?? null,
    },
  }
}

/** Every live brand of one company. */
// ─── Campaign → segment ───────────────────────────────────────────────────────
// Campaign.segmentId still points at the legacy `segments` table, and there is
// no column yet for a CustomerSegment (see report: Campaign.customerSegment).
// Until it lands, a campaign's segment is recorded as a pointer row in
// `segments` for the campaign's company — name `segment:<slug>`, filters
// { customerSegment: <slug> } — and these two functions are the only code that
// knows that. Saved-filter segments are gone; a legacy campaign still bound to
// one cannot be sent (it would silently widen to everyone).

const POINTER_PREFIX = 'segment:'

async function segmentPointerId(tenantId: string, slug: string): Promise<string> {
  const name = `${POINTER_PREFIX}${slug}`
  const found = await prisma.segment.findFirst({ where: { tenantId, name }, select: { id: true } })
  if (found) return found.id
  const created = await prisma.segment.create({
    data: { tenantId, name, description: 'Customer segment (see /crm/segments)', filters: { customerSegment: slug } },
    select: { id: true },
  })
  return created.id
}

const segmentName = (slug: string | null | 'legacy'): string | null =>
  slug === null ? null : slug === 'legacy' ? 'Old saved filter (retarget before sending)'
    : slug === WAITLIST_AUDIENCE ? WAITLIST_AUDIENCE_NAME : (SEGMENT_DEFS.find((d) => d.slug === slug)?.name ?? slug)

/** How another company's incident is shown to a company that did not raise it. */
export const OTHER_KITCHEN = 'Another servd kitchen'

export type BanView = { id: string | null; reason: string; bannedAt: Date; raisedHere: boolean; otherKitchen: boolean }

/**
 * Each customer's active ban — SERVD-WIDE (owner, 2026-10-15: a block is on the
 * customer's servd account and applies at every company). A ban raised by one
 * of `scope`'s companies (crm/customerScope.banCompanies attributes legacy NULL
 * rows) is shown in full and preferred; one raised elsewhere is shown only as
 * "blocked by another servd kitchen" — no id, no reason. (The CEO, a member of
 * every company, sees each block in full through the company that raised it.)
 */
async function bansInScope(customerIds: string[], scope: string[]): Promise<Map<string, BanView>> {
  const out = new Map<string, BanView>()
  if (customerIds.length === 0) return out
  const now = new Date()
  const bans = await prisma.customerBan.findMany({
    where: { customerId: { in: customerIds }, liftedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true, customerId: true, bannedById: true, tenantId: true, reason: true, bannedAt: true },
    orderBy: { bannedAt: 'desc' },
  })
  const bc = await banCompanies(bans)
  for (const b of bans) {
    if (!b.customerId) continue
    const here = inCompanies(bc.get(b.id), scope, true)
    const cur = out.get(b.customerId)
    if (cur && (cur.raisedHere || !here)) continue
    out.set(b.customerId, here
      ? { id: b.id, reason: b.reason, bannedAt: b.bannedAt, raisedHere: here, otherKitchen: !here }
      : { id: null, reason: `Blocked by ${OTHER_KITCHEN.toLowerCase()}`, bannedAt: b.bannedAt, raisedHere: false, otherKitchen: true })
  }
  return out
}

type StrikeOut = { id: string; customerId: string; kind: string; severity: number; reason: string | null; recordedAt: Date; reversedAt: Date | null; expiresAt: Date | null; sourceType: string | null; sourceId: string | null; recordedById: string | null; tenantId: string | null }

/**
 * Strikes for a staff screen — servd-wide: every strike on the account is
 * listed (they all count), but one another company recorded keeps only its
 * kind, weight and dates: no reason, no source order / reservation, no staff,
 * labelled "Another servd kitchen" (`otherKitchen`).
 */
async function strikesForView<T extends StrikeOut>(rows: T[], scope: string[]) {
  const sc = await strikeCompanies(rows)
  return rows.map(({ customerId, sourceType: _t, sourceId: _s, recordedById: _r, tenantId: _tid, ...rest }) => {
    const here = inCompanies(sc.get(rest.id), scope, true)
    return here
      ? { ...rest, customerId, otherKitchen: false, where: null }
      : { ...rest, customerId, reason: null, otherKitchen: true, where: OTHER_KITCHEN }
  })
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
  // Correct a guest's phone / email (owner C20, 2026-10-26) — ./contactCorrection.ts.
  await fastify.register(contactCorrectionRoutes)
  // Who may do what (wave 3, UI-06). The Marketing workspace (lib/workspaces.ts:
  // owners marketing + brand_manager) holds crm + campaigns by default, so
  // MARKETING_TEAM (MANAGERS + marketing + brand_manager) reads the customer
  // list, the KPIs and segments, and creates AND sends campaigns — running
  // campaigns is that workspace's job. Strikes and bans (who may order or book
  // at all) stay with MANAGERS: they are an operations call about service, and
  // the admin hides those buttons from the marketing roles. Every read and
  // write here is company-scoped through lib/tenantScope.ts whatever the role.

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
  }>('/customers', { preHandler: requireAuth(...MARKETING_TEAM) }, async (req) => {
    const { search, conceptId, cursor, limit: limitStr } = req.query
    const limit = Math.min(parseInt(limitStr ?? '50', 10), 200)
    const t = await scopeTenantWhere(req, 'read')
    // A brand filter must be a brand in view: filtering shared customers by
    // another company's brand would reveal who prefers it (404, as everywhere).
    if (conceptId) await assertConceptOwned(req, conceptId, 'read')

    const found = await prisma.customer.findMany({
      where: {
        deletedAt: null,
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
            // A scanned / typed member code (owner, 2026-10-26), and the servd name.
            { memberCode: { equals: search.trim().toUpperCase() } },
            { nickname: { equals: search.trim(), mode: 'insensitive' } },
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
        loyaltyAccounts: { where: t, select: { tenantId: true, pointsBalance: true, tier: true } },
      },
      orderBy: { lastOrderAt: 'desc' },
      take: limit + 1,
    })

    const hasMore = found.length > limit
    if (hasMore) found.pop()
    const customers = await scopedCustomerFigures(req, tenantIdsOf(t), found)
    // Blocked = an active ban anywhere on servd (owner, 2026-10-15); another
    // company's shown anonymised.
    const bans = await bansInScope(customers.map((c) => c.id), tenantIdsOf(t))

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

    return {
      data: customers.map((c) => ({
        ...c,
        loyaltyAccount: loyaltyAccountInView(c.loyaltyAccounts, req.staffUser!.tenantId),
        activeBan: bans.get(c.id) ?? null,
      })),
      cursor: hasMore ? (customers[customers.length - 1]?.id ?? null) : null,
      hasMore,
    }
  })

  // GET /crm/customers/:id
  fastify.get<{ Params: { id: string } }>(
    '/customers/:id',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const t = await scopeTenantWhere(req, 'read')
      const found = await prisma.customer.findFirst({
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
            include: { concept: { select: { name: true } }, items: { select: { name: true, quantity: true } } },
          },
          loyaltyAccounts: { where: t, include: { transactions: { take: 10, orderBy: { createdAt: 'desc' } } } },
        },
      })
      if (!found) throw new NotFoundError('Customer', req.params.id)
      const customer = (await scopedCustomerFigures(req, tenantIdsOf(t), [found]))[0]!
      const bans = await bansInScope([customer.id], tenantIdsOf(t))
      return {
        ...customer,
        loyaltyAccount: loyaltyAccountInView(customer.loyaltyAccounts, req.staffUser!.tenantId),
        activeBan: bans.get(customer.id) ?? null,
      }
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
      const found = await prisma.customer.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          // Tenant scope (same rule as GET /crm/customers/:id): staff can only
          // open the profile of a customer who has actually interacted with a
          // concept in their company. Without this, any staff login could pull
          // ANY customer's PII + order history by UUID.
          ...customerOfCompanies(t),
        },
        // The Customer rollup columns (totalSpentCents, first/last order,
        // lastVisitAt, no-show / complaint / review counts) are GLOBAL across
        // companies, so they are never selected here: the figures below are
        // recomputed for the companies in view only (F2 — the guest card
        // leaked another company's totals).
        select: {
          id: true, name: true, email: true, phone: true, birthdayMmDd: true,
          staffNotes: true, preferredConceptId: true,
          nickname: true, memberCode: true,
          // Naughty list — surfaced front-and-center so a host opening a
          // reservation immediately sees risk + recent strike history.
          // Strikes are servd-wide account standing (owner, 2026-10-15).
          strikeCount: true,
          loyaltyAccounts: { where: t, select: { tenantId: true, tier: true, pointsBalance: true, lifetimePoints: true } },
          preferredConcept: { select: { name: true, slug: true, tenantId: true } },
        },
      })
      if (!found) throw new NotFoundError('Customer', req.params.id)
      const scope = tenantIdsOf(t)
      // Spend, order count, first / last order and the preferred brand at the
      // companies in view — the same figures as the list and GET /customers/:id.
      const { walletBalance: _w, ...customer } = (await scopedCustomerFigures(req, scope, [found]))[0]!
      const activity = await companyActivityFigures(customer.id, t)
      const lastVisitAt =
        customer.lastOrderAt && activity.lastSeatedAt
          ? (customer.lastOrderAt > activity.lastSeatedAt ? customer.lastOrderAt : activity.lastSeatedAt)
          : (customer.lastOrderAt ?? activity.lastSeatedAt ?? null)

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
          // Complaints only — a ban appeal is not a service complaint.
          where: { customerId: customer.id, kind: 'complaint', status: { in: ['open', 'in_progress'] }, ...inCo },
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
          select: { segment: { select: { name: true, slug: true } } },
        }).catch(() => [] as Array<{ segment: { name: string; slug: string } | null }>),
        prisma.customerStrike.findMany({
          where: { customerId: customer.id },
          orderBy: { recordedAt: 'desc' },
          take: 50,
          select: {
            id: true, kind: true, severity: true, reason: true, recordedAt: true, reversedAt: true, expiresAt: true,
            customerId: true, sourceType: true, sourceId: true, recordedById: true, tenantId: true,
          },
        }),
      ])
      // Strikes and bans are servd-wide (owner, 2026-10-15): every strike on
      // the account, another company's anonymised ("Another servd kitchen").
      const recentStrikes = (await strikesForView(strikeRows.slice(0, 5), scope))
        .map(({ customerId: _c, ...rest }) => rest)

      // This company's segments; the servd-wide ban.
      const ban = (await bansInScope([customer.id], scope)).get(customer.id) ?? null
      const ours = (slug: string) => scope.some((tid) => slug.endsWith(`.${tid}`))
      return {
        ...customer,
        ...activity.figures,
        lastVisitAt,
        // The wallet at the companies in view only (ONL-R2-01).
        walletBalance: balanceInView((await walletBalancesOf([customer.id], scope)).get(customer.id), scope),
        loyaltyAccount: loyaltyAccountInView(customer.loyaltyAccounts, req.staffUser!.tenantId),
        bannedAt: ban?.bannedAt ?? null,
        activeBan: ban,
        recent: { orders, reservations, openComplaints: complaints, reviews, strikes: recentStrikes },
        segments: [...new Set(segments.filter((s) => s.segment && ours(s.segment.slug)).map((s) => s.segment!.name))],
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

  // GET /crm/summary — the customer KPIs and segment counts for the companies
  // in view: total customers, repeat rate (3+ orders), average order value,
  // and every segment's size (./segmentComputation.ts — the one segment
  // system; the old live-counted /crm/smart-segments is gone). Spend and
  // order counts are measured at the companies' own brands.
  fastify.get('/summary', { preHandler: requireAuth(...MARKETING_TEAM) }, async (req) => {
    const t = await scopeTenantWhere(req, 'read')
    const conceptIds = await conceptIdsInScope(req, 'read')
    const [stats, totalCustomers, segments] = await Promise.all([
      companyCustomerStats(conceptIds),
      prisma.customer.count({ where: { deletedAt: null, ...customerOfCompanies(t) } }),
      companySegments(tenantIdsOf(t)),
    ])
    const withOrders = stats.length
    const orders = stats.reduce((n, x) => n + x.n, 0)
    const revenue = stats.reduce((n, x) => n + x.spent, 0)
    return {
      summary: {
        totalCustomers,
        repeatRate: withOrders > 0 ? Math.round((stats.filter((x) => x.n >= 3).length / withOrders) * 100) : 0,
        avgOrderValueCents: orders > 0 ? Math.round(revenue / orders) : 0,
      },
      segments: segments.map((sg) => ({ key: sg.slug, label: sg.name, desc: sg.description, count: sg.memberCount, lastComputedAt: sg.lastComputedAt })),
    }
  })

  // When a campaign may be scheduled for (owner B9, 2026-10-26): from a minute from now, at most a year ahead.
  function scheduleDate(iso: string): Date {
    const at = new Date(iso)
    const now = Date.now()
    if (Number.isNaN(at.getTime()) || at.getTime() < now + 60_000) throw new AppError('SCHEDULE_IN_PAST', 'Pick a time at least a minute from now', 422)
    if (at.getTime() > now + 366 * 86_400_000) throw new AppError('SCHEDULE_TOO_FAR', 'A campaign can be scheduled at most a year ahead', 422)
    return at
  }

  // POST /crm/campaigns — a campaign belongs to the ACTIVE company. Every brand
  // it names must be one of that company's (404 otherwise); none named means
  // every brand of that company, never the platform. With `scheduledAt` it is
  // saved as scheduled (same rules as POST /:id/schedule), else as a draft.
  fastify.post('/campaigns', { preHandler: requireAuth(...MARKETING_TEAM) }, async (req, reply) => {
    const body = createCampaignSchema.parse(req.body)
    const own = await scopeTenantWhere(req, 'create')
    if (typeof own.tenantId !== 'string') throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before creating a campaign', 422)
    const conceptIds = [...new Set(body.conceptIds ?? [])]
    for (const id of conceptIds) await assertConceptOwned(req, id, 'create')
    const { segment, scheduledAt: when, ...fields } = body
    if (segment === WAITLIST_AUDIENCE) await assertCanUseWaitlist(req)
    let scheduledAt: Date | null = null
    if (when) {
      assertCampaignChannel(fields.channel)
      scheduledAt = scheduleDate(when)
    }
    const campaign = await prisma.campaign.create({
      data: {
        ...fields,
        conceptIds,
        tenantId: own.tenantId,
        segmentId: segment ? await segmentPointerId(own.tenantId, segment) : null,
        status: scheduledAt ? 'scheduled' : 'draft',
        scheduledAt,
      },
    })
    if (scheduledAt) {
      await audit({
        category: 'identity', action: 'campaign.schedule', entity: 'Campaign', entityId: campaign.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: own.tenantId,
        metadata: { scheduledAt: scheduledAt.toISOString(), channel: campaign.channel },
      })
    }
    return reply.status(201).send({ ...campaign, segment: segment ? { slug: segment, name: segmentName(segment) } : null })
  })

  /** A campaign of a company in `write` scope, or 404. A legacy campaign with no company is never sendable. */
  async function campaignInScope(req: FastifyRequest, id: string) {
    const campaign = await prisma.campaign.findFirst({
      where: { id, ...(await scopeTenantWhere(req, 'write')) },
      select: { ...CAMPAIGN_SEND_SELECT, scheduledAt: true },
    })
    if (!campaign || !campaign.tenantId) throw new NotFoundError('Campaign', id)
    return campaign as typeof campaign & { tenantId: string }
  }

  // POST /crm/campaigns/:id/send — broadcast now (email only; WhatsApp is 422
  // WHATSAPP_CAMPAIGN_NEEDS_OWN_NUMBER — modules/crm/campaignBroadcast.ts).
  fastify.post<{ Params: { id: string } }>(
    '/campaigns/:id/send',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      // Company-scoped lookup: a campaign of a company the operator is not in is a 404.
      const campaign = await campaignInScope(req, req.params.id)
      assertCampaignChannel(campaign.channel)
      if (sendableSegment(campaign) === WAITLIST_AUDIENCE) await assertCanUseWaitlist(req)
      const { recipientCount, run } = await claimAndBroadcast(campaign, { status: { in: ['draft', 'scheduled'] } }, fastify.log)
      void run // fire-and-forget — the response does not wait for the broadcast
      return { message: 'Campaign broadcast started', campaignId: campaign.id, recipientCount }
    },
  )

  // POST /crm/campaigns/:id/schedule {scheduledAt} — a draft (or a scheduled one, to move it) is sent once at that
  // time by the worker (workers/campaignSchedule.ts), to its segment inside its own company.
  fastify.post<{ Params: { id: string } }>(
    '/campaigns/:id/schedule',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const body = z.object({ scheduledAt: z.string().datetime() }).parse(req.body ?? {})
      const campaign = await campaignInScope(req, req.params.id)
      assertCampaignChannel(campaign.channel)
      if (sendableSegment(campaign) === WAITLIST_AUDIENCE) await assertCanUseWaitlist(req)
      const at = scheduleDate(body.scheduledAt)
      const n = await prisma.campaign.updateMany({
        where: { id: campaign.id, tenantId: campaign.tenantId, status: { in: ['draft', 'scheduled'] } },
        data: { status: 'scheduled', scheduledAt: at },
      })
      if (n.count === 0) throw new AppError('CAMPAIGN_NOT_DRAFT', 'Only a draft or scheduled campaign can be scheduled', 409)
      await audit({
        category: 'identity', action: 'campaign.schedule', entity: 'Campaign', entityId: campaign.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: campaign.tenantId,
        metadata: { scheduledAt: at.toISOString(), before: campaign.scheduledAt?.toISOString() ?? null, channel: campaign.channel },
      })
      return { id: campaign.id, status: 'scheduled', scheduledAt: at }
    },
  )

  // POST /crm/campaigns/:id/cancel-schedule — back to a draft; nothing is sent.
  fastify.post<{ Params: { id: string } }>(
    '/campaigns/:id/cancel-schedule',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const campaign = await campaignInScope(req, req.params.id)
      const n = await prisma.campaign.updateMany({
        where: { id: campaign.id, tenantId: campaign.tenantId, status: 'scheduled' },
        data: { status: 'draft', scheduledAt: null },
      })
      if (n.count === 0) throw new AppError('CAMPAIGN_NOT_SCHEDULED', 'This campaign is not scheduled (it may already be sending)', 409)
      await audit({
        category: 'identity', action: 'campaign.schedule_cancel', entity: 'Campaign', entityId: campaign.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: campaign.tenantId,
        metadata: { scheduledAt: campaign.scheduledAt?.toISOString() ?? null },
      })
      return { id: campaign.id, status: 'draft', scheduledAt: null }
    },
  )

  // GET /crm/campaigns/audience — how many people a campaign would reach, so
  // the operator sees the number before pressing send rather than after.
  // Previewed for the ACTIVE company, the one a new campaign is created in.
  fastify.get<{ Querystring: { conceptIds?: string; segment?: string; channel?: string } }>(
    '/campaigns/audience',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const own = await scopeTenantWhere(req, 'create')
      if (typeof own.tenantId !== 'string') throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
      const conceptIds = [...new Set((req.query.conceptIds ?? '').split(',').filter(Boolean))]
      for (const id of conceptIds) await assertConceptOwned(req, id, 'create')
      const segment = req.query.segment || null
      if (segment && !isCampaignSegment(segment)) throw new NotFoundError('Segment', segment)
      const companyConcepts = await companyConceptIds(own.tenantId)
      const where = await campaignAudienceWhere({ tenantId: own.tenantId, companyConcepts, conceptIds, segment, channel: req.query.channel ?? null })
      const base = segment === WAITLIST_AUDIENCE ? waitlistMemberWhere() : companyAudience(companyConcepts, conceptIds)
      const [total, optedOut] = await Promise.all([
        prisma.customer.count({ where }),
        prisma.customer.count({
          where: { AND: [{ deletedAt: null, marketingOptOutAt: { not: null } }, base] },
        }),
      ])
      return { total, optedOut }
    },
  )

  // GET /crm/campaigns — this company's campaigns only.
  fastify.get('/campaigns', { preHandler: requireAuth(...MARKETING_TEAM) }, async (req) => {
    const rows = await prisma.campaign.findMany({
      where: await scopeTenantWhere(req, 'read'),
      include: { segment: { select: { filters: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(({ segment, ...c }) => {
      const slug = campaignSegmentOf(segment)
      return { ...c, segment: slug ? { slug, name: segmentName(slug) } : null }
    })
  })

  // GET /crm/behavioral-segments — every segment, computed per company, for
  // the companies in view (portfolio mode sums them).
  fastify.get(
    '/behavioral-segments',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const segments = await companySegments(tenantIdsOf(await scopeTenantWhere(req, 'read')))
      return segments.sort((x, y) => y.memberCount - x.memberCount || x.name.localeCompare(y.name))
    },
  )

  // GET /crm/behavioral-segments/:slug/members — members at the companies in view.
  fastify.get<{ Params: { slug: string }; Querystring: { limit?: string } }>(
    '/behavioral-segments/:slug/members',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '200', 10), 500)
      if (!isSegmentSlug(req.params.slug)) throw new NotFoundError('Segment', req.params.slug)
      const rows = await getSegmentsWithMembers(req.params.slug, tenantIdsOf(await scopeTenantWhere(req, 'read')), limit)
      // Spend and last order at the brands in view only (W3A-RV-02).
      const stats = new Map((await companyCustomerStats(await conceptIdsInScope(req, 'read'), [...new Set(rows.map((r) => r.customerId))]))
        .map((s) => [s.id, s]))
      return rows.map((r) => ({
        ...r,
        customer: { ...r.customer, totalSpentCents: stats.get(r.customerId)?.spent ?? 0, lastOrderAt: stats.get(r.customerId)?.lastAt ?? null },
      }))
    },
  )

  // POST /crm/behavioral-segments/compute — recompute now, for the companies
  // the operator can write to.
  fastify.post(
    '/behavioral-segments/compute',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req, reply) => {
      const tenantIds = tenantIdsOf(await scopeTenantWhere(req, 'write'))
      // Fire and forget — client polls /behavioral-segments for updated counts
      setImmediate(async () => {
        try {
          await computeAllSegments(tenantIds)
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
        tenantId: req.staffUser?.tenantId ?? null, // a test company never messages a customer
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
        tenantId: req.staffUser?.tenantId ?? null, // a test company never messages a customer
      }).catch((err) => console.error(`[crm/chat] fan-out failed for conv=${conv.id}:`, (err as Error).message))

      return reply.status(201).send(message)
    },
  )

  // ════════════════════════════════════════════════════════════════════════
  // Naughty list — strikes + bans
  // ════════════════════════════════════════════════════════════════════════

  // GET /crm/naughty-list — operator inbox. Customers of THIS company with
  // strikes or a ban ANYWHERE on servd (owner, 2026-10-15: strikes and bans are
  // the customer's servd-wide standing), sorted by severity. The count and the
  // ban are servd-wide; another company's incidents are shown only as
  // "Another servd kitchen" (no reason, no order / reservation, no staff), and
  // its ban id not at all. Legacy NULL rows are attributed through their
  // source order / reservation or the staff member (crm/customerScope.ts).
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
            ] },
          ],
          ...(bannedOnly && { bannedAt: { not: null } }),
        },
        select: {
          id: true, name: true, email: true, phone: true,
          strikeCount: true, bannedAt: true,
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
          select: { id: true, customerId: true, bannedById: true, tenantId: true, bannedAt: true, liftedAt: true, expiresAt: true },
        }),
      ]) : [[], []]
      const [strikes, bc] = await Promise.all([strikesForView(strikeRows, scope), banCompanies(banRows)])
      // The servd-wide active ban per customer; the one this company raised wins.
      const activeBan = new Map<string, { bannedAt: Date; id: string; here: boolean }>()
      for (const b of banRows) {
        if (!b.customerId) continue
        if (b.liftedAt || (b.expiresAt && b.expiresAt <= now)) continue
        const here = inCompanies(bc.get(b.id), scope, true)
        const cur = activeBan.get(b.customerId)
        if (cur && (cur.here || !here)) continue
        activeBan.set(b.customerId, { bannedAt: b.bannedAt, id: b.id, here })
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
          // The servd-wide ban; its id only when this company raised it.
          const ban = activeBan.get(c.id)
          const bannedAt = ban?.bannedAt ?? null
          return {
            customer: { ...c, bannedAt, strikeCount: active.reduce((n, st) => n + st.severity, 0) },
            activeBanId: ban?.here ? ban.id : null,
            banRaisedHere: ban?.here ?? false,
            activeStrikes: active.length,
            totalStrikes:  list.length,
            strikes: list.slice(0, 10).map(({ customerId: _c, ...st }) => st),    // most recent 10 for the row
            _keep: list.length > 0 || !!bannedAt,
          }
        })
        .filter((r) => r._keep && (!bannedOnly || r.customer.bannedAt))
        .map(({ _keep: _k, ...r }) => r)
    },
  )

  // POST /crm/strikes — manually record a strike (operator's call).
  // Used when something happens IRL that the system can't auto-detect:
  // verbal abuse to staff, dine-and-dash, etc. Only against a customer of
  // the ACTIVE company; the strike is stamped with it (tenantId, the company
  // whose incident it is) and counts toward the customer's servd-wide three
  // strikes. 'cod_unpaid' is no longer a manual kind (old rows stay readable).
  fastify.post(
    '/strikes',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        customerId: z.string().uuid(),
        kind:       z.enum(['reservation_no_show', 'cod_refused', 'chargeback', 'other']),
        severity:   z.number().int().min(1).max(3).default(1),
        reason:     z.string().max(500),
      }).parse(req.body)

      await findCustomerInScope(req, body.customerId, 'create')
      const tenantId = activeTenantId(req, 'a strike belongs to one company')
      const { recordStrike } = await import('../../lib/strikes.js')
      const result = await recordStrike({
        customerId:   body.customerId,
        kind:         body.kind,
        severity:     body.severity,
        reason:       body.reason,
        recordedById: req.staffUser!.id,
        tenantId,
      })
      if (!result.recorded) throw new AppError('STRIKE_NOT_RECORDED', 'The strike could not be recorded — try again.', 500)
      // The servd-wide standing: the account's active weight and its ban.
      const { activeStrikeWeight } = await import('../../lib/strikes.js')
      const strikeCount = await activeStrikeWeight(prisma, body.customerId)
      const ban = (await bansInScope([body.customerId], [tenantId])).get(body.customerId) ?? null
      return reply.status(201).send({ ok: true, banId: result.banId ?? null, customer: { strikeCount, bannedAt: ban?.bannedAt ?? null } })
    },
  )

  // POST /crm/strikes/:id/reverse — manager forgives a strike. If reversing
  // drops the customer's servd-wide weight below the threshold, the auto-ban is
  // lifted. Only a strike this company recorded (404 otherwise).
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/strikes/:id/reverse',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({ reason: z.string().max(500) }).parse(req.body)
      const strike = await prisma.customerStrike.findUnique({
        where: { id: req.params.id },
        select: { id: true, customerId: true, sourceType: true, sourceId: true, recordedById: true, tenantId: true },
      })
      if (!strike) throw new NotFoundError('Strike', req.params.id)
      const t = await scopeTenantWhere(req, 'write')
      const scope = tenantIdsOf(t)
      let ok: boolean
      if (strike.tenantId) {
        ok = scope.includes(strike.tenantId)
      } else {
        const customerOk = !!(await prisma.customer.findFirst({ where: { id: strike.customerId, ...customerOfCompanies(t) }, select: { id: true } }))
        const sc = await strikeCompanies([strike])
        ok = customerOk && inCompanies(sc.get(strike.id), scope, customerOk)
      }
      if (!ok) throw new NotFoundError('Strike', req.params.id)
      const { reverseStrike } = await import('../../lib/strikes.js')
      const result = await reverseStrike(req.params.id, req.staffUser!.id, body.reason)
      return result
    },
  )

  // GET /crm/bans — every ban THIS company raised, active + historical, plus
  // the ACTIVE bans another company raised on this company's customers (a
  // block is servd-wide, owner 2026-10-15) — those anonymised: no id, no
  // reason, no staff, no fingerprints, labelled "Another servd kitchen".
  fastify.get<{ Querystring: { activeOnly?: string } }>(
    '/bans',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const now = new Date()
      const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true'
      const t = await scopeTenantWhere(req, 'read')

      // Candidates: this company's bans (tenantId), plus legacy NULL rows on
      // this company's customers or raised by this company's staff.
      const staff = await prisma.user.findMany({ where: userOfCompanies(t), select: { id: true } })
      const bans = await prisma.customerBan.findMany({
        where: {
          ...(activeOnly && {
            liftedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          }),
          AND: [{ OR: [
            t,
            { tenantId: null, customer: customerOfCompanies(t) },
            { tenantId: null, customerId: null, bannedById: { in: staff.map((u) => u.id) } },
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
      const own = bans.filter((b) => inCompanies(bc.get(b.id), scope, true))
        .map((b) => ({ ...b, raisedHere: true, otherKitchen: false }))
      // Active blocks raised elsewhere on this company's customers.
      const ownIds = new Set(own.map((b) => b.id))
      const elsewhere = await prisma.customerBan.findMany({
        where: {
          id: { notIn: [...ownIds] },
          liftedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          customer: customerOfCompanies(t),
        },
        include: { customer: { select: { id: true, name: true, email: true, phone: true } } },
        orderBy: { bannedAt: 'desc' },
        take: 200,
      })
      const others = elsewhere.map((b) => ({
            id: null, customerId: b.customerId, customer: b.customer, email: null, phone: null,
            ipAddresses: [], deviceFingerprints: [], reason: `Blocked by ${OTHER_KITCHEN.toLowerCase()}`,
            tenantId: null, bannedById: null, bannedAt: b.bannedAt, liftedAt: null, liftedById: null,
            liftReason: null, expiresAt: b.expiresAt, raisedHere: false, otherKitchen: true,
          }))
      return [...own, ...others]
        .sort((x, y) => y.bannedAt.getTime() - x.bannedAt.getTime())
        .slice(0, 200)
    },
  )

  /**
   * The ban, when the caller may decide it — else 404. Bans are servd-wide
   * (owner, 2026-10-15) but only a manager of the company that RAISED it (the
   * CEO included, through their membership of it) may lift it or release a
   * contact. A ban with a
   * company column was raised by that company; a legacy NULL ban is attributed
   * the old way (and only the CEO may change it: liftBanTx / releaseBanContactTx
   * answer 403 LEGACY_BAN_ADMIN_ONLY to anyone else). Another company — even
   * one that serves the customer — gets 404: it sees the block only anonymised.
   */
  async function findBanInScope(req: FastifyRequest, id: string, mode: 'read' | 'write') {
    const ban = await prisma.customerBan.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true, email: true, phone: true } } },
    })
    if (!ban) throw new NotFoundError('Ban', id)
    const t = await scopeTenantWhere(req, mode)
    const scope = tenantIdsOf(t)
    if (ban.tenantId) {
      if (!scope.includes(ban.tenantId)) throw new NotFoundError('Ban', id)
      return ban
    }
    const customerOk = ban.customerId
      ? !!(await prisma.customer.findFirst({ where: { id: ban.customerId, ...customerOfCompanies(t) }, select: { id: true } }))
      : true
    const bc = await banCompanies([ban])
    if (!customerOk || !inCompanies(bc.get(ban.id), scope, customerOk)) throw new NotFoundError('Ban', id)
    return ban
  }

  // POST /crm/bans/:id/lift — lift a ban (forgive the customer, or grant an
  // appeal). Requires a reason for the audit trail. The block is servd-wide;
  // a manager of the company that raised it decides (404 to anyone else); a
  // legacy NULL-company ban → CEO (role admin) only (403). The strikes stay
  // (owner Q6). Linked open appeals resolve; the customer is told.
  // The module gate opens this path to 'complaints' holders too (lib/moduleAccess.ts).
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/bans/:id/lift',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({ reason: z.string().min(1).max(500) }).parse(req.body)
      const ban = await findBanInScope(req, req.params.id, 'write')
      const wasActive = !ban.liftedAt
      const { liftBanTx } = await import('../../lib/strikes.js')
      await prisma.$transaction((tx) => liftBanTx(tx, {
        banId: ban.id, actorId: req.staffUser!.id, reason: body.reason, actorRole: req.staffUser!.role,
      }))
      const updated = await prisma.customerBan.findUniqueOrThrow({ where: { id: ban.id } })
      if (wasActive) {
        await audit({
          category: 'identity', action: 'customer_ban.lift', entity: 'CustomerBan', entityId: ban.id,
          userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: ban.tenantId ?? req.staffUser!.tenantId ?? null,
          metadata: { reason: body.reason, customerId: ban.customerId, auto: ban.bannedById === null },
        })
        notifyBanLifted(ban).catch((err) => console.error(`[crm/bans] lift notice failed for ban ${ban.id}:`, (err as Error).message))
      }
      return updated
    },
  )

  /** Tell the customer the block on their servd account is lifted (after commit; best effort). */
  async function notifyBanLifted(ban: { tenantId: string | null; phone: string | null; email: string | null; customer: { phone: string | null; email: string | null; name: string | null } | null }) {
    const text = 'Good news: the block on your servd account has been lifted. You can order and book again.'
    const scope = customerScope(ban.tenantId)
    const phone = ban.customer?.phone ?? ban.phone
    const email = ban.customer?.email ?? ban.email
    if (phone) await sendPhoneMessage(phone, text, 'ban.lifted', scope)
    if (email) await sendEmail(email, 'Your block has been lifted', `<p>${escapeHtml(text)}</p>`, 'ban.lifted', scope)
  }

  // POST /crm/bans/:id/release-contact — release ONE contact from a ban
  // (owner Q7: a recycled phone number). Clears it on the ban AND on the banned
  // customer's account, so the next sign-in with it is a fresh account. The
  // ban stays in force on the old account. MANAGERS (the module gate also
  // opens it to 'complaints' holders); this company's ban only (404); audited.
  fastify.post<{ Params: { id: string }; Body: { contact: 'phone' | 'email'; reason: string } }>(
    '/bans/:id/release-contact',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        contact: z.enum(['phone', 'email']),
        reason:  z.string().trim().min(5).max(300),
      }).parse(req.body)
      const ban = await findBanInScope(req, req.params.id, 'write')
      const { releaseBanContactTx } = await import('../../lib/strikes.js')
      const { released } = await prisma.$transaction((tx) => releaseBanContactTx(tx, {
        banId: ban.id, contact: body.contact, actorId: req.staffUser!.id, reason: body.reason, actorRole: req.staffUser!.role,
      }))
      await audit({
        category: 'identity', action: 'customer_ban.release_contact', entity: 'CustomerBan', entityId: ban.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: ban.tenantId ?? req.staffUser!.tenantId ?? null,
        // Never the contact itself in the trail — only which kind was released.
        metadata: { contact: body.contact, reason: body.reason, customerId: ban.customerId, hadValue: !!released },
      })
      return prisma.customerBan.findUniqueOrThrow({ where: { id: ban.id } })
    },
  )

  // POST /crm/bans — operator-initiated ban: the CRM "Block" button, and the
  // naughty list. The ONE way to block a customer. Servd-wide (owner,
  // 2026-10-15): it applies at every brand of every company; lift it with
  // /crm/bans/:id/lift. Only a customer of the ACTIVE company; the ban is
  // stamped with that company (tenantId = the raising company).
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
      const known = customerId ? await findCustomerInScope(req, customerId, 'create') : null
      const tenantId = activeTenantId(req, 'a block belongs to one company')
      // Blocking twice returns this company's ban already in force. Another
      // company's block does not stop this one: each raising company owns its
      // own decision, and the account stays blocked servd-wide until every
      // active block on it is lifted.
      if (known) {
        const existing = (await bansInScope([known.id], [tenantId])).get(known.id)
        if (existing?.id && existing.raisedHere) return reply.status(200).send(await prisma.customerBan.findUnique({ where: { id: existing.id } }))
      }

      const ban = await prisma.customerBan.create({
        data: {
          tenantId,
          customerId,
          // The fingerprints come from the customer record when the body names
          // only the customer. A ban with no email or phone never matched the
          // signup / reservation gates, so "block" left those doors open.
          email:      (body.email ?? known?.email)?.toLowerCase() ?? null,
          phone:      body.phone ?? known?.phone ?? null,
          reason:     body.reason,
          bannedById: req.staffUser!.id,
          expiresAt:  body.expiresAt ? new Date(body.expiresAt) : null,
        },
      })
      if (customerId) {
        const { syncCustomerBanMirror } = await import('../../lib/strikes.js')
        await syncCustomerBanMirror(prisma, customerId)
      }
      return reply.status(201).send(ban)
    },
  )
}

