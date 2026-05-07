// Behavioral segment computation engine.
// Each segment defines a SQL query that returns customer IDs matching the rule.
// computeAllSegments() runs all segments, atomically replaces memberships,
// and updates the memberCount on each CustomerSegment row.
// Safe to run multiple times (idempotent via full replace).

import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'

interface SegmentDef {
  slug: string
  compute: () => Promise<string[]>
}

// PKT = UTC+5. Use AT TIME ZONE 'Asia/Karachi' for hour-based rules.
// Cancelled/rejected orders don't count as real engagement.
const SETTLED = Prisma.raw(`status NOT IN ('cancelled', 'rejected', 'refunded')`)

const SEGMENT_DEFS: SegmentDef[] = [
  {
    slug: 'weekend-warrior',
    async compute() {
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT "customerId"
        FROM orders
        WHERE ${SETTLED} AND "customerId" IS NOT NULL
        GROUP BY "customerId"
        HAVING COUNT(*) >= 3
           AND SUM(CASE WHEN EXTRACT(dow FROM "placedAt") IN (0,5,6) THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.70
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'lunch-regular',
    async compute() {
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT "customerId"
        FROM orders
        WHERE ${SETTLED} AND "customerId" IS NOT NULL
        GROUP BY "customerId"
        HAVING COUNT(*) >= 3
           AND SUM(CASE WHEN EXTRACT(hour FROM "placedAt" AT TIME ZONE 'Asia/Karachi') BETWEEN 11 AND 14 THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.60
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'late-night',
    async compute() {
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT "customerId"
        FROM orders
        WHERE ${SETTLED} AND "customerId" IS NOT NULL
        GROUP BY "customerId"
        HAVING COUNT(*) >= 3
           AND SUM(CASE WHEN EXTRACT(hour FROM "placedAt" AT TIME ZONE 'Asia/Karachi') >= 22
                         OR EXTRACT(hour FROM "placedAt" AT TIME ZONE 'Asia/Karachi') < 2
                        THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.40
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'promo-hunter',
    async compute() {
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT "customerId"
        FROM orders
        WHERE ${SETTLED} AND "customerId" IS NOT NULL
        GROUP BY "customerId"
        HAVING COUNT(*) >= 4
           AND SUM(CASE WHEN "discountCents" > 0 OR "promoDiscountCents" > 0 THEN 1 ELSE 0 END)::float / COUNT(*) > 0.50
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'high-value',
    async compute() {
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        WITH spend AS (
          SELECT "customerId", SUM("totalCents") AS s90
          FROM orders
          WHERE ${SETTLED} AND "customerId" IS NOT NULL
            AND "placedAt" >= NOW() - INTERVAL '90 days'
          GROUP BY "customerId"
          HAVING COUNT(*) >= 3
        ),
        threshold AS (
          SELECT PERCENTILE_CONT(0.85) WITHIN GROUP (ORDER BY s90) AS p85 FROM spend
        )
        SELECT s."customerId" FROM spend s, threshold t WHERE s.s90 >= t.p85
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'lapsed-30',
    async compute() {
      type Row = { id: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT c.id
        FROM customers c
        WHERE c."lastOrderAt" < NOW() - INTERVAL '30 days'
          AND c."lastOrderAt" > NOW() - INTERVAL '90 days'
          AND c."deletedAt" IS NULL
          AND (
            SELECT COUNT(*) FROM orders o
            WHERE o."customerId" = c.id AND ${SETTLED}
          ) >= 2
      `
      return rows.map((r) => r.id)
    },
  },
  {
    slug: 'lapsed-60',
    async compute() {
      type Row = { id: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT c.id
        FROM customers c
        WHERE c."lastOrderAt" < NOW() - INTERVAL '60 days'
          AND c."deletedAt" IS NULL
          AND (
            SELECT COUNT(*) FROM orders o
            WHERE o."customerId" = c.id AND ${SETTLED}
          ) >= 3
      `
      return rows.map((r) => r.id)
    },
  },
  {
    slug: 'new-this-month',
    async compute() {
      const rows = await prisma.customer.findMany({
        where: { firstOrderAt: { gte: new Date(Date.now() - 30 * 864e5) }, deletedAt: null },
        select: { id: true },
      })
      return rows.map((r) => r.id)
    },
  },
  {
    slug: 'loyal-regular',
    async compute() {
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT "customerId"
        FROM orders
        WHERE ${SETTLED} AND "customerId" IS NOT NULL
          AND "placedAt" >= NOW() - INTERVAL '42 days'
        GROUP BY "customerId"
        HAVING COUNT(DISTINCT DATE_TRUNC('week', "placedAt")) >= 4
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'multi-brand',
    async compute() {
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT "customerId"
        FROM orders
        WHERE ${SETTLED} AND "customerId" IS NOT NULL
        GROUP BY "customerId"
        HAVING COUNT(*) >= 5 AND COUNT(DISTINCT "conceptId") >= 3
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'brand-loyalist',
    async compute() {
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT "customerId"
        FROM (
          SELECT "customerId",
                 SUM(cnt)  AS total,
                 MAX(cnt)  AS maxcnt
          FROM (
            SELECT "customerId", "conceptId", COUNT(*) AS cnt
            FROM orders
            WHERE ${SETTLED} AND "customerId" IS NOT NULL
            GROUP BY "customerId", "conceptId"
          ) sub
          GROUP BY "customerId"
        ) agg
        WHERE total >= 5 AND maxcnt::float / total >= 0.80
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'premium',
    async compute() {
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT "customerId"
        FROM orders
        WHERE ${SETTLED} AND "customerId" IS NOT NULL
        GROUP BY "customerId"
        HAVING COUNT(*) >= 3
           AND AVG("totalCents") >= 500000
           AND SUM(CASE WHEN "discountCents" > 0 OR "promoDiscountCents" > 0 THEN 1 ELSE 0 END) = 0
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'cart-abandoner',
    async compute() {
      // Customers who triggered checkout_started in last 14 days with no order_placed in same session
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT DISTINCT e."customerId"
        FROM analytics_events e
        WHERE e.event = 'checkout_started'
          AND e."customerId" IS NOT NULL
          AND e."createdAt" >= NOW() - INTERVAL '14 days'
          AND NOT EXISTS (
            SELECT 1 FROM analytics_events e2
            WHERE e2."sessionId" = e."sessionId"
              AND e2.event = 'order_placed'
          )
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'group-orderer',
    async compute() {
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT DISTINCT "customerId"
        FROM orders
        WHERE source = 'servd'
          AND "customerId" IS NOT NULL
          AND raw_payload IS NOT NULL
          AND raw_payload->>'isGroupOrder' = 'true'
      `
      return rows.map((r) => r.customerId)
    },
  },
  {
    slug: 'impulse-buyer',
    async compute() {
      // Viewed a concept AND placed an order within 1 hour in the same session
      type Row = { customerId: string }
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT DISTINCT e1."customerId"
        FROM analytics_events e1
        JOIN analytics_events e2
          ON e2."sessionId" = e1."sessionId"
         AND e2.event = 'order_placed'
         AND e2."createdAt" BETWEEN e1."createdAt" AND e1."createdAt" + INTERVAL '1 hour'
        WHERE e1.event = 'concept_view'
          AND e1."customerId" IS NOT NULL
      `
      return rows.map((r) => r.customerId)
    },
  },
]

export async function computeAllSegments(): Promise<{ slug: string; count: number }[]> {
  const results: { slug: string; count: number }[] = []

  for (const def of SEGMENT_DEFS) {
    try {
      const customerIds = await def.compute()
      const uniqueIds = [...new Set(customerIds)]

      // Atomically replace memberships: delete old, insert new
      await prisma.$transaction([
        prisma.customerSegmentMembership.deleteMany({
          where: { segment: { slug: def.slug } },
        }),
        ...(uniqueIds.length > 0
          ? [
              prisma.$executeRaw`
                INSERT INTO customer_segment_memberships ("customerId", "segmentId", "joinedAt")
                SELECT unnest(${uniqueIds}::text[]), id, NOW()
                FROM customer_segments WHERE slug = ${def.slug}
                ON CONFLICT DO NOTHING
              `,
            ]
          : []),
        prisma.customerSegment.update({
          where: { slug: def.slug },
          data: { memberCount: uniqueIds.length, lastComputedAt: new Date() },
        }),
      ])

      results.push({ slug: def.slug, count: uniqueIds.length })
    } catch (err) {
      console.error(`[segments] Failed to compute ${def.slug}:`, (err as Error).message)
      results.push({ slug: def.slug, count: -1 })
    }
  }

  return results
}

export async function getSegmentsWithMembers(slug: string, limit = 200) {
  return prisma.customerSegmentMembership.findMany({
    where: { segment: { slug } },
    take: limit,
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          totalSpentCents: true,
          lastOrderAt: true,
          walletBalance: true,
          marketingOptIn: true,
        },
      },
    },
    orderBy: { joinedAt: 'desc' },
  })
}
