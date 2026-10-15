// Customer segments — THE one system (CustomerSegment + memberships).
//
// There used to be three: saved filters (Segment, POST /crm/segments), these
// materialised behavioural segments, and eight "smart segments" counted live
// on every request (GET /crm/smart-segments). They disagreed on what a lapsed
// customer or a VIP is, only the first could be messaged, and these were
// computed across every company's orders. Now:
//
//   - every segment is computed PER COMPANY, from completed orders at that
//     company's brands only. A company's segment rows carry the company in
//     the slug (`<base>.<tenantId>`, the per-company key convention the
//     loyalty settings use) because CustomerSegment has no tenantId column
//     yet; see the report for the column that retires the suffix;
//   - the definitions follow owner decision 16:
//       lapsed = no order in 60 days, with at least one earlier order;
//       vip    = PKR 50,000 lifetime spend (at the company);
//   - the automatic win-back message targets the lapsed segment, and a
//     campaign targets any segment here (crm/routes.ts).
//
// computeAllSegments() runs nightly (workers/segmentComputation.ts) and on
// demand (POST /crm/behavioral-segments/compute). Safe to re-run: each
// company's memberships are replaced wholesale.

import { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'

interface Ctx { tenantId: string; conceptIds: string[] }

interface SegmentDef {
  slug: string
  name: string
  description: string
  color: string
  emoji: string
  compute: (ctx: Ctx) => Promise<string[]>
}

const DAY = 86_400_000
export const VIP_SPEND_CENTS = 5_000_000       // PKR 50,000 (decision 16)
export const LAPSED_DAYS = 60                  // decision 16

type Stat = { id: string; n: number; spent: number; first: Date | null; last: Date | null }

/** Completed-order stats per customer at the company's brands. */
async function stats(ctx: Ctx): Promise<Stat[]> {
  if (ctx.conceptIds.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ id: string; n: number; spent: bigint; first_at: Date | null; last_at: Date | null }>>`
    SELECT o."customerId" AS id, COUNT(*)::int AS n, COALESCE(SUM(o."totalCents"), 0)::bigint AS spent,
           MIN(COALESCE(o."completedAt", o."placedAt")) AS first_at,
           MAX(COALESCE(o."completedAt", o."placedAt")) AS last_at
    FROM orders o
    JOIN customers c ON c.id = o."customerId" AND c."deletedAt" IS NULL
    WHERE o."deletedAt" IS NULL AND o.status = 'completed'
      AND o."conceptId" = ANY(${ctx.conceptIds}::text[])
    GROUP BY o."customerId"`
  return rows.map((r) => ({ id: r.id, n: Number(r.n), spent: Number(r.spent), first: r.first_at, last: r.last_at }))
}

/** Customer ids from a raw query over this company's completed orders. */
async function ids(q: Prisma.Sql): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(q)
  return rows.map((r) => r.id)
}

const COMPANY_ORDERS = (ctx: Ctx) => Prisma.sql`
  o."deletedAt" IS NULL AND o.status = 'completed' AND o."customerId" IS NOT NULL
  AND o."conceptId" = ANY(${ctx.conceptIds}::text[])`

export const SEGMENT_DEFS: SegmentDef[] = [
  // ── Lifecycle and value (decision 16) ──────────────────────────────────────
  {
    slug: 'vip', name: 'VIP', description: 'PKR 50,000+ lifetime spend', color: '#f59e0b', emoji: '👑',
    async compute(ctx) { return (await stats(ctx)).filter((s) => s.spent >= VIP_SPEND_CENTS).map((s) => s.id) },
  },
  {
    slug: 'lapsed', name: 'Lapsed', description: 'No order in 60 days (ordered before) — the win-back audience', color: '#ef4444', emoji: '💤',
    async compute(ctx) {
      const cutoff = Date.now() - LAPSED_DAYS * DAY
      return (await stats(ctx)).filter((s) => s.n >= 1 && !!s.last && s.last.getTime() < cutoff).map((s) => s.id)
    },
  },
  {
    slug: 'new', name: 'New', description: 'First order in the last 30 days', color: '#3b82f6', emoji: '🌱',
    async compute(ctx) {
      const since = Date.now() - 30 * DAY
      return (await stats(ctx)).filter((s) => !!s.first && s.first.getTime() >= since).map((s) => s.id)
    },
  },
  {
    slug: 'one-time', name: 'One-time buyers', description: 'Exactly one order', color: '#94a3b8', emoji: '1️⃣',
    async compute(ctx) { return (await stats(ctx)).filter((s) => s.n === 1).map((s) => s.id) },
  },
  {
    slug: 'repeat', name: 'Repeat buyers', description: 'Two or more orders', color: '#22c55e', emoji: '🔁',
    async compute(ctx) { return (await stats(ctx)).filter((s) => s.n >= 2).map((s) => s.id) },
  },
  {
    slug: 'frequent', name: 'Frequent buyers', description: 'Three or more orders', color: '#a855f7', emoji: '⭐',
    async compute(ctx) { return (await stats(ctx)).filter((s) => s.n >= 3).map((s) => s.id) },
  },
  {
    slug: 'zero', name: 'Zero orders', description: 'Signed up or booked here, never ordered', color: '#64748b', emoji: '○',
    async compute(ctx) {
      if (ctx.conceptIds.length === 0) return []
      const rows = await prisma.customer.findMany({
        where: {
          deletedAt: null,
          AND: [
            { OR: [
              { preferredConceptId: { in: ctx.conceptIds } },
              { reservations: { some: { conceptId: { in: ctx.conceptIds } } } },
              { orders: { some: { conceptId: { in: ctx.conceptIds }, deletedAt: null } } },
            ] },
            { orders: { none: { conceptId: { in: ctx.conceptIds }, status: 'completed', deletedAt: null } } },
          ],
        },
        select: { id: true },
      })
      return rows.map((r) => r.id)
    },
  },
  {
    slug: 'cart-abandoner', name: 'Cart abandoners', description: 'Left a cart in the last 14 days', color: '#f97316', emoji: '🛒',
    async compute(ctx) {
      if (ctx.conceptIds.length === 0) return []
      const rows = await prisma.abandonedCart.findMany({
        where: { conceptId: { in: ctx.conceptIds }, customerId: { not: null }, recoveredAt: null, abandonedAt: { gte: new Date(Date.now() - 14 * DAY) } },
        select: { customerId: true },
      })
      return rows.map((r) => r.customerId!)
    },
  },
  // ── Behaviour ──────────────────────────────────────────────────────────────
  {
    slug: 'weekend-warrior', name: 'Weekend warriors', description: '70%+ of orders Fri–Sun (3+ orders)', color: '#6366f1', emoji: '🎉',
    compute: (ctx) => ids(Prisma.sql`
      SELECT o."customerId" AS id FROM orders o WHERE ${COMPANY_ORDERS(ctx)}
      GROUP BY o."customerId"
      HAVING COUNT(*) >= 3
         AND SUM(CASE WHEN EXTRACT(dow FROM o."placedAt" AT TIME ZONE 'Asia/Karachi') IN (0,5,6) THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.70`),
  },
  {
    slug: 'lunch-regular', name: 'Lunch regulars', description: '60%+ of orders 11:00–14:59 (3+ orders)', color: '#eab308', emoji: '🥪',
    compute: (ctx) => ids(Prisma.sql`
      SELECT o."customerId" AS id FROM orders o WHERE ${COMPANY_ORDERS(ctx)}
      GROUP BY o."customerId"
      HAVING COUNT(*) >= 3
         AND SUM(CASE WHEN EXTRACT(hour FROM o."placedAt" AT TIME ZONE 'Asia/Karachi') BETWEEN 11 AND 14 THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.60`),
  },
  {
    slug: 'late-night', name: 'Late night', description: '40%+ of orders 22:00–01:59 (3+ orders)', color: '#1e293b', emoji: '🌙',
    compute: (ctx) => ids(Prisma.sql`
      SELECT o."customerId" AS id FROM orders o WHERE ${COMPANY_ORDERS(ctx)}
      GROUP BY o."customerId"
      HAVING COUNT(*) >= 3
         AND SUM(CASE WHEN EXTRACT(hour FROM o."placedAt" AT TIME ZONE 'Asia/Karachi') >= 22
                       OR EXTRACT(hour FROM o."placedAt" AT TIME ZONE 'Asia/Karachi') < 2 THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.40`),
  },
  {
    slug: 'promo-hunter', name: 'Promo hunters', description: 'Over half of orders discounted (4+ orders)', color: '#ec4899', emoji: '🏷',
    compute: (ctx) => ids(Prisma.sql`
      SELECT o."customerId" AS id FROM orders o WHERE ${COMPANY_ORDERS(ctx)}
      GROUP BY o."customerId"
      HAVING COUNT(*) >= 4
         AND SUM(CASE WHEN o."discountCents" > 0 OR o."promoDiscountCents" > 0 THEN 1 ELSE 0 END)::float / COUNT(*) > 0.50`),
  },
  {
    slug: 'loyal-regular', name: 'Loyal regulars', description: 'Ordered in 4+ different weeks of the last 6', color: '#14b8a6', emoji: '🤝',
    compute: (ctx) => ids(Prisma.sql`
      SELECT o."customerId" AS id FROM orders o WHERE ${COMPANY_ORDERS(ctx)}
        AND o."placedAt" >= NOW() - INTERVAL '42 days'
      GROUP BY o."customerId"
      HAVING COUNT(DISTINCT DATE_TRUNC('week', o."placedAt")) >= 4`),
  },
  {
    slug: 'multi-brand', name: 'Multi-brand', description: '5+ orders across 2+ of the company’s brands', color: '#0ea5e9', emoji: '🔀',
    compute: (ctx) => ids(Prisma.sql`
      SELECT o."customerId" AS id FROM orders o WHERE ${COMPANY_ORDERS(ctx)}
      GROUP BY o."customerId"
      HAVING COUNT(*) >= 5 AND COUNT(DISTINCT o."conceptId") >= 2`),
  },
  {
    slug: 'brand-loyalist', name: 'Brand loyalists', description: '80%+ of 5+ orders at one brand', color: '#8b5cf6', emoji: '💜',
    compute: (ctx) => ids(Prisma.sql`
      SELECT id FROM (
        SELECT "customerId" AS id, SUM(cnt) AS total, MAX(cnt) AS maxcnt FROM (
          SELECT o."customerId", o."conceptId", COUNT(*) AS cnt FROM orders o WHERE ${COMPANY_ORDERS(ctx)}
          GROUP BY o."customerId", o."conceptId"
        ) per_brand GROUP BY "customerId"
      ) agg WHERE total >= 5 AND maxcnt::float / total >= 0.80`),
  },
  {
    slug: 'premium', name: 'Premium', description: 'PKR 5,000+ average, never discounted (3+ orders)', color: '#d97706', emoji: '💎',
    compute: (ctx) => ids(Prisma.sql`
      SELECT o."customerId" AS id FROM orders o WHERE ${COMPANY_ORDERS(ctx)}
      GROUP BY o."customerId"
      HAVING COUNT(*) >= 3 AND AVG(o."totalCents") >= 500000
         AND SUM(CASE WHEN o."discountCents" > 0 OR o."promoDiscountCents" > 0 THEN 1 ELSE 0 END) = 0`),
  },
  {
    slug: 'group-orderer', name: 'Group orderers', description: 'Joined a submitted group order', color: '#10b981', emoji: '👥',
    compute: (ctx) => ids(Prisma.sql`
      SELECT DISTINCT m."customerId" AS id
      FROM group_order_members m JOIN group_orders g ON g.id = m."groupOrderId"
      WHERE m."customerId" IS NOT NULL AND g."orderId" IS NOT NULL
        AND g."conceptId" = ANY(${ctx.conceptIds}::text[])`),
  },
  {
    slug: 'impulse-buyer', name: 'Impulse buyers', description: 'Ordered within an hour of first viewing a brand', color: '#f43f5e', emoji: '⚡',
    compute: (ctx) => ids(Prisma.sql`
      SELECT DISTINCT e1."customerId" AS id
      FROM analytics_events e1
      JOIN analytics_events e2
        ON e2."sessionId" = e1."sessionId" AND e2.event = 'order_placed'
       AND e2."createdAt" BETWEEN e1."createdAt" AND e1."createdAt" + INTERVAL '1 hour'
      WHERE e1.event = 'concept_view' AND e1."customerId" IS NOT NULL
        AND e1."conceptId" = ANY(${ctx.conceptIds}::text[])`),
  },
]

export const SEGMENT_SLUGS = SEGMENT_DEFS.map((d) => d.slug)
export const isSegmentSlug = (slug: string): boolean => SEGMENT_SLUGS.includes(slug)

/** The CustomerSegment slug holding segment `base` for one company. */
export const companySegmentSlug = (base: string, tenantId: string): string => `${base}.${tenantId}`

/** Split a company segment slug back into its segment and company. */
export function parseCompanySegmentSlug(slug: string): { base: string; tenantId: string } | null {
  const i = slug.indexOf('.')
  if (i <= 0) return null
  const base = slug.slice(0, i)
  return isSegmentSlug(base) ? { base, tenantId: slug.slice(i + 1) } : null
}

async function companyConcepts(tenantId: string): Promise<string[]> {
  const rows = await prisma.concept.findMany({ where: { tenantId, deletedAt: null }, select: { id: true } })
  return rows.map((r) => r.id)
}

/** Create any of the company's segment rows that are missing (names kept in step with the definitions). */
export async function ensureCompanySegments(tenantId: string): Promise<void> {
  for (const d of SEGMENT_DEFS) {
    const slug = companySegmentSlug(d.slug, tenantId)
    await prisma.customerSegment.upsert({
      where: { slug },
      create: { slug, name: d.name, description: d.description, color: d.color, emoji: d.emoji },
      update: { name: d.name, description: d.description, color: d.color, emoji: d.emoji },
    })
  }
}

/** Compute every segment for one company, replacing its memberships. */
export async function computeCompanySegments(tenantId: string): Promise<{ slug: string; count: number }[]> {
  await ensureCompanySegments(tenantId)
  const ctx: Ctx = { tenantId, conceptIds: await companyConcepts(tenantId) }
  const results: { slug: string; count: number }[] = []
  for (const def of SEGMENT_DEFS) {
    const slug = companySegmentSlug(def.slug, tenantId)
    try {
      const unique = [...new Set(await def.compute(ctx))]
      await prisma.$transaction([
        prisma.customerSegmentMembership.deleteMany({ where: { segment: { slug } } }),
        ...(unique.length > 0
          ? [prisma.$executeRaw`
              INSERT INTO customer_segment_memberships ("customerId", "segmentId", "joinedAt")
              SELECT unnest(${unique}::text[]), id, NOW() FROM customer_segments WHERE slug = ${slug}
              ON CONFLICT DO NOTHING`]
          : []),
        prisma.customerSegment.update({ where: { slug }, data: { memberCount: unique.length, lastComputedAt: new Date() } }),
      ])
      results.push({ slug: def.slug, count: unique.length })
    } catch (err) {
      console.error(`[segments] ${tenantId} ${def.slug} failed:`, (err as Error).message)
      results.push({ slug: def.slug, count: -1 })
    }
  }
  return results
}

/** Every company, every segment. */
export async function computeAllSegments(tenantIds?: string[]): Promise<{ tenantId: string; slug: string; count: number }[]> {
  const companies = tenantIds ?? (await prisma.tenant.findMany({ where: { kind: 'company' }, select: { id: true } })).map((t) => t.id)
  const out: { tenantId: string; slug: string; count: number }[] = []
  for (const tenantId of companies) {
    for (const r of await computeCompanySegments(tenantId)) out.push({ tenantId, ...r })
  }
  return out
}

/** Members of segment `base` at these companies (ids only). */
export async function segmentMemberIds(base: string, tenantIds: string[]): Promise<string[]> {
  if (!isSegmentSlug(base) || tenantIds.length === 0) return []
  const rows = await prisma.customerSegmentMembership.findMany({
    where: { segment: { slug: { in: tenantIds.map((t) => companySegmentSlug(base, t)) } } },
    select: { customerId: true },
  })
  return [...new Set(rows.map((r) => r.customerId))]
}

/** Segment rows of these companies, merged per segment (portfolio view sums counts). */
export async function companySegments(tenantIds: string[]) {
  const rows = tenantIds.length === 0 ? [] : await prisma.customerSegment.findMany({
    where: { slug: { in: tenantIds.flatMap((t) => SEGMENT_SLUGS.map((b) => companySegmentSlug(b, t))) } },
    select: { id: true, slug: true, memberCount: true, lastComputedAt: true },
  })
  return SEGMENT_DEFS.map((d) => {
    const mine = rows.filter((r) => parseCompanySegmentSlug(r.slug)?.base === d.slug)
    const computed = mine.map((r) => r.lastComputedAt).filter((x): x is Date => !!x)
    return {
      id: d.slug,
      slug: d.slug,
      name: d.name,
      description: d.description,
      color: d.color,
      emoji: d.emoji,
      memberCount: mine.reduce((n, r) => n + r.memberCount, 0),
      lastComputedAt: computed.length ? new Date(Math.min(...computed.map((x) => x.getTime()))) : null,
    }
  })
}

/**
 * Members of one segment at these companies, with the customer card the admin
 * lists. The customer's own rollups (totalSpentCents, lastOrderAt) and the
 * servd-wide wallet are global across companies, so they are NOT selected
 * here — the route fills spend / last order from the companies' own brands
 * (crm/routes.ts companyCustomerStats, W3A-RV-02).
 */
export async function getSegmentsWithMembers(base: string, tenantIds: string[], limit = 200) {
  if (!isSegmentSlug(base) || tenantIds.length === 0) return []
  return prisma.customerSegmentMembership.findMany({
    where: { segment: { slug: { in: tenantIds.map((t) => companySegmentSlug(base, t)) } }, customer: { deletedAt: null } },
    take: limit,
    include: {
      customer: {
        select: { id: true, name: true, phone: true, email: true, marketingOptOutAt: true },
      },
    },
    orderBy: { joinedAt: 'desc' },
  })
}
