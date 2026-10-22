// Loyalty points expiration worker.
//
// Points older than the company's loyalty.expiry_months (admin → Loyalty; it
// used to be a hardcoded 365 days here, so the setting did nothing) that
// haven't been redeemed are reclaimed: a
// "expire" loyalty transaction is recorded and the breakage liability is
// derecognised back to Marketing. Runs once daily.
//
// Algorithm (per loyalty account), first in, first out — points spent come out
// of the OLDEST points (finance sim MI-3, 2026-10-16: redemptions after the
// cutoff were ignored, so a customer who earned in September and redeemed in
// October lost those October points too when September's expired):
//   1. oldEarn = points earned before the cutoff and not clawed back (an earn
//      a refund reversed carries reversedAt and was never available).
//   2. consumed = every redemption still standing (a redemption given back on
//      a cancel / refund carries reversedAt) plus everything already expired —
//      at ANY date: under FIFO each of them used the oldest points first.
//   3. stale = max(0, oldEarn − consumed), capped by the current balance (we
//      never expire more than the customer holds).
//   4. If stale > 0, decrement balance, post an "expire" tx, and post the JE.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { postLoyaltyExpire } from '../modules/accounting/loyaltyPosting.js'
import { isLoyaltyPaused } from '../lib/loyaltyPause.js'
import { loadLoyaltySettings } from '../lib/loyaltySettings.js'
const QUEUE_NAME = 'loyalty-expiration'
const RUN_EVERY_MS = 24 * 60 * 60 * 1000  // daily

export function startLoyaltyExpirationWorker() {
  try {
    const queue = new Queue(QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: { removeOnComplete: { count: 90 }, removeOnFail: { count: 90 } },
    })

    void queue.add('scan', {}, {
      repeat: { every: RUN_EVERY_MS },
      jobId: 'loyalty-expiration-recurring',
    }).catch((err: Error) => console.warn('[loyaltyExpiration] schedule failed:', err.message))

    const worker = new Worker(QUEUE_NAME, runExpirationSweep, { connection: redis, concurrency: 1 })

    worker.on('failed', (job, err) => {
      console.error(`[loyaltyExpiration] job ${job?.id} failed:`, err.message)
    })

    return worker
  } catch (err) {
    console.warn('[loyaltyExpiration] worker disabled:', (err as Error).message)
    return null
  }
}

export async function runExpirationSweep(): Promise<void> {
  // Loyalty paused servd-wide (lib/loyaltyPause.ts): balances are frozen, nothing expires off 2060.
  if (await isLoyaltyPaused()) return
  const accounts = await prisma.loyaltyAccount.findMany({
    where: { pointsBalance: { gt: 0 } },
    select: { id: true, tenantId: true, customerId: true, pointsBalance: true },
  })

  for (const account of accounts) {
    try {
      // The account's company — accounts are per company (ONL-04), and that
      // company's books carry the liability the expiry releases — decides how
      // long points live. 0 = never expire.
      const months = (await loadLoyaltySettings(account.tenantId))['loyalty.expiry_months']
      if (!months || months <= 0) continue
      const cutoff = new Date()
      cutoff.setMonth(cutoff.getMonth() - months)

      // FIFO: earns before the cutoff (not clawed back) vs everything spent or
      // expired so far, whenever it happened.
      const [earned, spent] = await Promise.all([
        prisma.loyaltyTransaction.aggregate({
          _sum: { pointsDelta: true },
          where: { loyaltyAccountId: account.id, type: 'earn', reversedAt: null, createdAt: { lt: cutoff } },
        }),
        prisma.loyaltyTransaction.aggregate({
          _sum: { pointsDelta: true },
          where: {
            loyaltyAccountId: account.id,
            OR: [{ type: 'redeem', reversedAt: null }, { type: 'expire' }],
          },
        }),
      ])
      const oldEarn = earned._sum.pointsDelta ?? 0
      // Redemptions and expiries are stored negative.
      const consumed = -(spent._sum.pointsDelta ?? 0)
      const stalePool = Math.max(0, oldEarn - consumed)
      const toExpire = Math.min(stalePool, account.pointsBalance)
      if (toExpire <= 0) continue

      // Atomic decrement guards against concurrent redemption
      const updated = await prisma.loyaltyAccount.updateMany({
        where: { id: account.id, pointsBalance: { gte: toExpire } },
        data: { pointsBalance: { decrement: toExpire } },
      })
      if (updated.count === 0) continue

      const tx = await prisma.loyaltyTransaction.create({
        data: {
          loyaltyAccountId: account.id,
          type: 'expire',
          pointsDelta: -toExpire,
          description: `${toExpire} pts expired (older than ${months} months)`,
        },
      })
      await postLoyaltyExpire(tx.id)
    } catch (err) {
      console.error(`[loyaltyExpiration] account ${account.id} failed:`, (err as Error).message)
    }
  }
}
