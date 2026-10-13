// Gift-card expiry — the daily sweep (finance gaps #7, 2026-10-13).
//
// The redeem engine refuses a card from the instant its expiresAt passes, but
// it could never RECORD that: its status write ran inside the redeem's
// transaction and the throw right after rolled it back, so expired cards read
// 'active' in the register forever. This sweep records it: at 00:10 PKT, for
// every active company, each active card whose expiresAt has passed becomes
// 'expired' with expiredAt, under its row lock (giftCards/books.ts
// expireDueGiftCards). node-cron only, no Redis.
//
// No entry is posted: the unspent value stays owed in 2080 until the owner
// decides breakage (pending owner decision G10) — the seam is marked in
// expireDueGiftCards.

import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { expireDueGiftCards } from '../modules/giftCards/books.js'

let running = false

/** One pass over every active company. Returns how many cards were marked expired. */
export async function runGiftCardExpiryOnce(now: Date = new Date()): Promise<number> {
  if (running) return 0
  running = true
  let expired = 0
  try {
    const companies = await prisma.tenant.findMany({ where: { isActive: true, deletedAt: null }, select: { id: true } })
    for (const c of companies) {
      try {
        expired += await expireDueGiftCards(c.id, now, prisma)
      } catch (err) {
        console.error(`[giftCardExpiry] company ${c.id} failed:`, (err as Error).message)
      }
    }
    if (expired > 0) console.info(`[giftCardExpiry] ${expired} gift card(s) marked expired`)
    return expired
  } finally {
    running = false
  }
}

export function startGiftCardExpiryWorker(): { stop: () => void } {
  const job = cron.schedule('10 0 * * *', () => {
    runGiftCardExpiryOnce().catch((err) => console.error('[giftCardExpiry] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[giftCardExpiry] worker started — daily 00:10 PKT')
  return { stop: () => job.stop() }
}
