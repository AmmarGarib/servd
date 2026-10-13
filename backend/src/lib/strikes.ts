// Customer strike + ban engine.
//
// Three-strike accountability system. Every offense (no-show, cash-unpaid,
// refused-at-door) writes a CustomerStrike. When ACTIVE strikes hit 3 (sum
// of severities), the system auto-creates a CustomerBan that locks out the
// customer's email + phone + every IP we've seen them on. Strikes naturally
// decay after 12 months so a single bad week doesn't haunt them forever.
//
// "Active" strikes = not reversed, not expired.
//
// `recordStrike` is fire-and-forget safe: never let a strike write break
// the upstream flow (reservation seating, order delivery). On any internal
// error, log and return without throwing.

import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from './prisma.js'

const STRIKE_TTL_DAYS = 365
const BAN_THRESHOLD = 3      // sum of severities of ACTIVE strikes that triggers a ban

export type StrikeKind =
  | 'reservation_no_show'
  | 'cod_unpaid'
  | 'cod_refused'
  | 'chargeback'
  | 'other'

interface RecordStrikeArgs {
  customerId: string
  kind: StrikeKind
  sourceType?: 'reservation' | 'order'
  sourceId?: string
  severity?: number
  reason?: string
  recordedById?: string | null
}

/**
 * Record a strike. ONE strike per incident: a strike that names its source
 * (sourceType + sourceId) is written at most once per (customer, kind,
 * source) — reversed ones included, so a forgiven incident reported again
 * stays forgiven. Two reports of the same unpaid order used to write two
 * strikes, and two of severity 2 banned the customer. The check and the
 * insert run under a transaction-scoped advisory lock on the incident, so two
 * racing reports cannot both insert.
 */
export async function recordStrike(args: RecordStrikeArgs): Promise<{ recorded: boolean; duplicate: boolean }> {
  try {
    const expiresAt = new Date(Date.now() + STRIKE_TTL_DAYS * 86_400_000)
    const data = {
      customerId:    args.customerId,
      kind:          args.kind,
      sourceType:    args.sourceType ?? null,
      sourceId:      args.sourceId   ?? null,
      severity:      args.severity   ?? 1,
      reason:        args.reason     ?? null,
      expiresAt,
      recordedById:  args.recordedById ?? null,
    }
    let duplicate = false
    if (args.sourceType && args.sourceId) {
      const key = `strike:${args.customerId}:${args.kind}:${args.sourceType}:${args.sourceId}`
      duplicate = await defaultPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`
        const existing = await tx.customerStrike.findFirst({
          where: { customerId: args.customerId, kind: args.kind, sourceType: args.sourceType!, sourceId: args.sourceId! },
          select: { id: true },
        })
        if (existing) return true
        await tx.customerStrike.create({ data })
        return false
      })
    } else {
      await defaultPrisma.customerStrike.create({ data })
    }
    if (duplicate) return { recorded: false, duplicate: true }
    await maybePromoteToBan(args.customerId)
    return { recorded: true, duplicate: false }
  } catch (err) {
    console.error(`[strikes] recordStrike failed for ${args.customerId}:`, (err as Error).message)
    return { recorded: false, duplicate: false }
  }
}

// Recalculate active-strike count and promote the customer to a ban if
// they crossed the threshold. Always re-syncs the denormalized
// Customer.strikeCount + bannedAt for fast UI checks.
export async function maybePromoteToBan(customerId: string, tx: PrismaClient = defaultPrisma): Promise<void> {
  const now = new Date()
  const active = await tx.customerStrike.findMany({
    where: {
      customerId,
      reversedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { severity: true },
  })
  const activeWeight = active.reduce((s, r) => s + r.severity, 0)

  // Always sync the denormalized counter.
  await tx.customer.update({
    where: { id: customerId },
    data:  { strikeCount: activeWeight },
  })

  if (activeWeight < BAN_THRESHOLD) return

  // Already banned? Don't double-create.
  const existing = await tx.customerBan.findFirst({
    where: { customerId, liftedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true },
  })
  if (existing) return

  // Pull the customer's identifiers + every IP we've seen them clock in /
  // place an order from. ClockLog isn't customer-side; we use ip from order
  // creation if we ever start tracking it. For MVP we capture email + phone
  // (we can backfill IPs as we add the capture point).
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { email: true, phone: true },
  })
  if (!customer) return

  await tx.customerBan.create({
    data: {
      customerId,
      email:       customer.email ?? null,
      phone:       customer.phone ?? null,
      reason:      `Auto-banned: ${activeWeight} active strikes (3-strike threshold)`,
      bannedById:  null,
    },
  })

  await tx.customer.update({
    where: { id: customerId },
    data:  { bannedAt: now, isBlacklisted: true, blacklistReason: '3 strikes — auto-banned' },
  })
}

// Reverse a strike (manager forgives it). De-counts toward the threshold,
// but leaves an audit trail. If the customer is currently banned and
// reversing this strike drops them below threshold, the ban is auto-lifted.
export async function reverseStrike(
  strikeId: string,
  reversedById: string,
  reversalReason: string,
): Promise<{ unbanned: boolean }> {
  const strike = await defaultPrisma.customerStrike.findUnique({
    where: { id: strikeId },
    select: { id: true, customerId: true, reversedAt: true },
  })
  if (!strike) throw new Error('Strike not found')
  if (strike.reversedAt) return { unbanned: false }

  await defaultPrisma.customerStrike.update({
    where: { id: strikeId },
    data:  { reversedAt: new Date(), reversedById, reversalReason },
  })

  // Recompute. If we drop below threshold, lift any active auto-ban.
  const now = new Date()
  const active = await defaultPrisma.customerStrike.findMany({
    where: {
      customerId: strike.customerId,
      reversedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { severity: true },
  })
  const activeWeight = active.reduce((s, r) => s + r.severity, 0)
  await defaultPrisma.customer.update({
    where: { id: strike.customerId },
    data:  { strikeCount: activeWeight },
  })

  let unbanned = false
  if (activeWeight < BAN_THRESHOLD) {
    const ban = await defaultPrisma.customerBan.findFirst({
      where: { customerId: strike.customerId, liftedAt: null, bannedById: null }, // only lift AUTO bans
      select: { id: true },
    })
    if (ban) {
      await defaultPrisma.customerBan.update({
        where: { id: ban.id },
        data:  { liftedAt: now, liftedById: reversedById, liftReason: 'Strike reversed → below threshold' },
      })
      await defaultPrisma.customer.update({
        where: { id: strike.customerId },
        data:  { bannedAt: null, isBlacklisted: false, blacklistReason: null },
      })
      unbanned = true
    }
  }

  return { unbanned }
}

// ─── Per-company ban checks (owner decision 15) ──────────────────────────────
//
// ONE blocking mechanism: CustomerBan. The CRM "block" button raises a ban and
// "unblock" lifts it (crm/routes.ts); Customer.isBlacklisted is only a synced
// flag and is not read. A ban applies only at the brands of the company that
// raised it. CustomerBan has no company column yet, so the company is
// attributed the way the naughty list does it (crm/customerScope.banCompanies:
// the staff member who raised it, or the strikes behind an auto-ban). A ban
// that cannot be attributed (legacy rows) applies everywhere — the
// conservative reading. When `tenantId` lands on CustomerBan, banAppliesAt
// becomes a plain column comparison.

type BanMatch = { customerId?: string | null; email?: string | null; phone?: string | null }

function activeBanWhere(m: BanMatch, now: Date) {
  const or: Array<Record<string, unknown>> = []
  if (m.customerId) or.push({ customerId: m.customerId })
  if (m.email)      or.push({ email: m.email.toLowerCase() })
  if (m.phone)      or.push({ phone: m.phone })
  if (or.length === 0) return null
  return { AND: [{ OR: or }, { liftedAt: null }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }] }
}

/** This company's active ban matching the customer, their email or phone — or null. */
export async function activeBanAtCompany(args: BanMatch & { tenantId: string | null }): Promise<{ id: string; reason: string; bannedAt: Date; ipAddresses: string[] } | null> {
  const where = activeBanWhere(args, new Date())
  if (!where) return null
  const bans = await defaultPrisma.customerBan.findMany({
    where,
    select: { id: true, customerId: true, bannedById: true, reason: true, bannedAt: true, ipAddresses: true },
    orderBy: { bannedAt: 'desc' },
  })
  if (bans.length === 0) return null
  if (!args.tenantId) return bans[0]!
  const { banCompanies } = await import('../modules/crm/customerScope.js')
  const companies = await banCompanies(bans)
  return bans.find((b) => {
    const c = companies.get(b.id)
    return c === null || (c !== undefined && c.has(args.tenantId!))
  }) ?? null
}

/**
 * Refuse an order/booking at a brand of `tenantId` when that company has an
 * active ban on this customer. Records the IP on the ban as a forensic signal.
 */
export async function assertNotBannedAtCompany(args: BanMatch & {
  tenantId: string | null
  ip?: string | null
  intent?: 'order' | 'reservation' | 'signup'
}): Promise<void> {
  const ban = await activeBanAtCompany(args)
  if (!ban) return
  if (args.ip && !ban.ipAddresses.includes(args.ip)) {
    await defaultPrisma.customerBan.update({ where: { id: ban.id }, data: { ipAddresses: { push: args.ip } } }).catch(() => {})
  }
  const verb = args.intent === 'reservation' ? 'book' : args.intent === 'signup' ? 'sign up' : 'order'
  const { AppError } = await import('./errors.js')
  throw new AppError('BANNED', `This account can't ${verb} here. If you think this is a mistake, contact the venue directly.`, 403)
}

/** Customers with an active ban that applies at `tenantId` (for marketing reach). */
export async function bannedCustomerIdsAtCompany(tenantId: string): Promise<string[]> {
  const now = new Date()
  const bans = await defaultPrisma.customerBan.findMany({
    where: { customerId: { not: null }, liftedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true, customerId: true, bannedById: true },
  })
  if (bans.length === 0) return []
  const { banCompanies } = await import('../modules/crm/customerScope.js')
  const companies = await banCompanies(bans)
  const out = new Set<string>()
  for (const b of bans) {
    const c = companies.get(b.id)
    if (c === null || c?.has(tenantId)) out.add(b.customerId!)
  }
  return [...out]
}
