// Loyalty points expiration worker.
//
// Points older than the company's loyalty.expiry_months (admin → Loyalty; it
// used to be a hardcoded 365 days here, so the setting did nothing) that
// haven't been redeemed are reclaimed: a
// "expire" loyalty transaction is recorded and the breakage liability is
// derecognised back to Marketing. Runs once daily.
//
// Algorithm (per loyalty account):
//   1. Sum lifetime earned and lifetime burned points from transactions older
//      than the cutoff.
//   2. Compute "stale" pool = max(0, oldEarn − oldRedeem − alreadyExpired).
//   3. Cap by current balance (we never expire more than the customer holds).
//   4. If stale > 0, decrement balance, post an "expire" tx, and post the JE.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { postLoyaltyExpire } from '../modules/accounting/loyaltyPosting.js'
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

async function runExpirationSweep(): Promise<void> {
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

      // Sum stale earn / redeem / already-expired
      const grouped = await prisma.loyaltyTransaction.groupBy({
        by: ['type'],
        _sum: { pointsDelta: true },
        where: { loyaltyAccountId: account.id, createdAt: { lt: cutoff } },
      })
      let oldEarn = 0, oldRedeem = 0, oldExpired = 0
      for (const g of grouped) {
        const sum = g._sum.pointsDelta ?? 0
        if (g.type === 'earn')         oldEarn    += sum
        else if (g.type === 'redeem')  oldRedeem  += sum   // already negative
        else if (g.type === 'expire')  oldExpired += sum   // already negative
      }
      // oldRedeem and oldExpired are non-positive; convert to positive consumption
      const consumed = -oldRedeem + -oldExpired
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
