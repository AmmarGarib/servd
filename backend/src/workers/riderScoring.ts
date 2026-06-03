// Per-rider scoring — lost-package rate, OTP-fail rate, route variance.
// Runs nightly. Flags any rider exceeding the configured tolerance over a
// rolling window so dispatch can review.

import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { flagException } from '../lib/exceptions.js'

const WINDOW_DAYS = 14
const OTP_FAIL_THRESHOLD = 3        // ≥ 3 OTP-fail orders in window = flag
const LOST_PCT_THRESHOLD = 0.05     // ≥ 5% lost-package rate = flag

export function startRiderScoringWorker(): void {
  // 02:30 nightly — runs after the shrinkage trend at 02:00
  cron.schedule('30 2 * * *', () => { void runOnce().catch((err) => console.warn('[rider-scoring]', (err as Error).message)) })
  console.log('[riderScoring] worker scheduled — nightly at 02:30')
}

export async function runOnce(): Promise<{ checked: number; flagged: number }> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000)

  const riders = await prisma.rider.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  })

  let flagged = 0
  for (const rider of riders) {
    const total = await prisma.order.count({
      where: { riderId: rider.id, completedAt: { gte: since } },
    })
    if (total < 5) continue        // not enough orders to score reliably

    const otpFailedOrders = await prisma.order.count({
      where: { riderId: rider.id, deliveryOtpAttempts: { gte: 3 }, completedAt: { gte: since } },
    })

    const cancelled = await prisma.order.count({
      where: { riderId: rider.id, status: 'cancelled', updatedAt: { gte: since } },
    })

    const lostRate = total > 0 ? (cancelled + otpFailedOrders) / total : 0

    // Skip if no signal
    if (otpFailedOrders < OTP_FAIL_THRESHOLD && lostRate < LOST_PCT_THRESHOLD) continue

    // Don't double-flag in the same window
    const existing = await prisma.exceptionFlag.findFirst({
      where: {
        kind: 'lost_package', status: 'open',
        entityType: 'User', entityId: rider.id,
        createdAt: { gte: since },
      },
      select: { id: true },
    })
    if (existing) continue

    await flagException({
      kind: 'lost_package',
      severity: lostRate >= 0.10 ? 'high' : 'medium',
      title: `Rider ${rider.name}: ${(lostRate * 100).toFixed(1)}% problem rate (${WINDOW_DAYS}d)`,
      description: `Out of ${total} delivery orders, ${otpFailedOrders} hit 3+ OTP failures and ${cancelled} were cancelled. Lost/disputed rate: ${(lostRate * 100).toFixed(1)}%. Pull dispatch + GPS logs before next shift.`,
      entityType: 'User',
      entityId: rider.id,
      actorId: rider.id,
      metadata: { totalOrders: total, otpFailedOrders, cancelled, lostRate, windowDays: WINDOW_DAYS },
    })
    flagged++
  }

  console.log(`[riderScoring] checked ${riders.length} riders, flagged ${flagged}`)
  return { checked: riders.length, flagged }
}
