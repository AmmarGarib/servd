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

export async function recordStrike(args: RecordStrikeArgs): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + STRIKE_TTL_DAYS * 86_400_000)
    await defaultPrisma.customerStrike.create({
      data: {
        customerId:    args.customerId,
        kind:          args.kind,
        sourceType:    args.sourceType ?? null,
        sourceId:      args.sourceId   ?? null,
        severity:      args.severity   ?? 1,
        reason:        args.reason     ?? null,
        expiresAt,
        recordedById:  args.recordedById ?? null,
      },
    })
    await maybePromoteToBan(args.customerId)
  } catch (err) {
    console.error(`[strikes] recordStrike failed for ${args.customerId}:`, (err as Error).message)
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
