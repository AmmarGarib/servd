// Test company (owner, 2026-10-14) — THE one predicate.
//
// A test company (`Tenant.isTest`) is for trying things out: fiscal reporting
// is off, it is left out of "All companies" totals, it never messages
// customers or outside parties, and its brands are never advertised. Its own
// books work normally. Every check of "is this a test company?" goes through
// this file — never read `tenant.isTest` ad hoc in a route.
//
// Cache: one in-process set of test-company ids, refreshed every 30 s and
// dropped at once by `invalidateTestTenants()` (the toggle / create routes
// call it). A DB error is logged and treated as "no test companies" for at
// most 5 s — blocking real customers' messages on a DB blip is worse than a
// test company slipping a message through in that window; the cache usually
// answers.

import type { PrismaClient, Prisma } from '@prisma/client'
import { serviceClient } from './prisma.js'

type Db = PrismaClient | Prisma.TransactionClient

const TTL_MS = 30_000
const ERROR_TTL_MS = 5_000

let cached: { ids: Set<string>; expiresAt: number } | null = null
let inflight: Promise<Set<string>> | null = null
// Bumped by invalidateTestTenants() so a load that started before the
// invalidation never re-caches the stale answer.
let generation = 0

async function load(db: Db): Promise<Set<string>> {
  const rows = await db.tenant.findMany({ where: { isTest: true }, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

async function cachedIds(): Promise<Set<string>> {
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.ids
  if (inflight) return inflight
  const gen = generation
  const p = (async () => {
    try {
      const ids = await load(serviceClient)
      if (gen === generation) cached = { ids, expiresAt: Date.now() + TTL_MS }
      return ids
    } catch (err) {
      console.warn('[test-company] could not read test companies; treating as none for 5 s', err)
      const ids = new Set<string>()
      if (gen === generation) cached = { ids, expiresAt: Date.now() + ERROR_TTL_MS }
      return ids
    } finally {
      // Unchanged generation → `inflight` is still this load.
      if (gen === generation) inflight = null
    }
  })()
  inflight = p
  return p
}

/**
 * Ids of every test company. Without `db` it answers from the 30 s cache
 * (read across all companies on the service client). With `db` (e.g. a
 * transaction) it reads fresh through that client and does not touch the
 * cache. Callers must not mutate the returned set.
 */
export async function testTenantIds(db?: Db): Promise<Set<string>> {
  if (db) {
    try {
      return await load(db)
    } catch (err) {
      console.warn('[test-company] could not read test companies', err)
      return new Set<string>()
    }
  }
  return cachedIds()
}

/** True when `tenantId` is a test company. Null / unknown → false. */
export async function isTestTenant(tenantId: string | null | undefined, db?: Db): Promise<boolean> {
  if (!tenantId) return false
  if (db) {
    try {
      const row = await db.tenant.findUnique({ where: { id: tenantId }, select: { isTest: true } })
      return row?.isTest === true
    } catch (err) {
      console.warn('[test-company] could not read company test flag', err)
      return false
    }
  }
  return (await cachedIds()).has(tenantId)
}

/** Drop the cache — call after any write to `Tenant.isTest`. */
export function invalidateTestTenants(): void {
  cached = null
  inflight = null
  generation++
}

/**
 * Spread into an `Order` where-clause to leave out orders of test companies
 * (fr-4): customers are platform-wide, so a real customer's test order must
 * never move their shared rollups (firstOrderAt, lastOrderAt,
 * totalSpentCents) or the cross-company first / second order triggers
 * (welcome, referral payout, second-order nudge). A NOT, so a legacy brand
 * with no company still counts exactly as before.
 */
export function realCompanyOrderWhere(): { concept: { NOT: { tenant: { isTest: true } } } } {
  return { concept: { NOT: { tenant: { isTest: true } } } }
}
