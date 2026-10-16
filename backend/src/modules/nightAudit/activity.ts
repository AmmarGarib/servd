// Which days had SALES activity (owner, 2026-10-16: the night audit is for the
// sales module only). A day is active when the company had, that Karachi day:
//   • an order placed, completed or scheduled (through its brand's company);
//   • a till opened or closed (Shift.tenantId, else its location's, else —
//     no location — its cashier's company: tenantScope.shiftOfCompany);
//   • a payment created (through its order's brand).
// Nothing else: deposit drops, card-machine charges and Raast receipts always
// come with one of those; journal entries, supplier bills, payroll and
// depreciation never make a day active (so a head office has none).

import type { PrismaClient, Prisma } from '@prisma/client'
import { parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'

type Db = PrismaClient | Prisma.TransactionClient

/** The distinct active SALES days 'YYYY-MM-DD' in [fromDay, toDay] (inclusive), sorted. */
export async function activityDaysBetween(db: Db, tenantId: string, fromDay: string, toDay: string): Promise<string[]> {
  if (fromDay > toDay) return []
  const from = parsePktStartOfDay(fromDay)
  const to = parsePktEndOfDay(toDay)
  const rows = await db.$queryRaw<Array<{ day: string }>>`
    WITH ts AS (
      SELECT o."placedAt" AS t FROM orders o JOIN concepts c ON c.id = o."conceptId"
       WHERE c."tenantId" = ${tenantId} AND o."placedAt" BETWEEN ${from} AND ${to}
      UNION ALL
      SELECT o."completedAt" FROM orders o JOIN concepts c ON c.id = o."conceptId"
       WHERE c."tenantId" = ${tenantId} AND o."completedAt" BETWEEN ${from} AND ${to}
      UNION ALL
      SELECT o."scheduledFor" FROM orders o JOIN concepts c ON c.id = o."conceptId"
       WHERE c."tenantId" = ${tenantId} AND o."scheduledFor" BETWEEN ${from} AND ${to}
      UNION ALL
      SELECT p."createdAt" FROM payments p JOIN orders o ON o.id = p."orderId" JOIN concepts c ON c.id = o."conceptId"
       WHERE c."tenantId" = ${tenantId} AND p."createdAt" BETWEEN ${from} AND ${to}
      UNION ALL
      SELECT x.t FROM (
        SELECT s."openedAt" AS t, s."tenantId", s."locationId", s."userId" FROM shifts s WHERE s."openedAt" BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT s."closedAt", s."tenantId", s."locationId", s."userId" FROM shifts s WHERE s."closedAt" BETWEEN ${from} AND ${to}
      ) x
      LEFT JOIN locations l ON l.id = x."locationId"
      LEFT JOIN users u ON u.id = x."userId"
       WHERE x."tenantId" = ${tenantId}
          OR (x."tenantId" IS NULL AND l."tenantId" = ${tenantId})
          OR (x."tenantId" IS NULL AND x."locationId" IS NULL AND u."tenantId" = ${tenantId})
    )
    SELECT DISTINCT to_char((t AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD') AS day
      FROM ts WHERE t IS NOT NULL ORDER BY day`
  return rows.map((r) => r.day)
}

/** Did the company have SALES activity on `day`? */
export async function isActiveDay(db: Db, tenantId: string, day: string): Promise<boolean> {
  return (await activityDaysBetween(db, tenantId, day, day)).length > 0
}
