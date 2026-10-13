// Gift-card expiry — the daily sweep (finance gaps #7, 2026-10-13; breakage,
// wave B H11).
//
// The redeem engine refuses a card from the instant its expiresAt passes, but
// it could never RECORD that: its status write ran inside the redeem's
// transaction and the throw right after rolled it back, so expired cards read
// 'active' in the register forever. This sweep records it: at 00:10 PKT, for
// every active company, each active card whose expiresAt has passed becomes
// 'expired' with expiredAt, under its row lock — and the sweep POSTS BREAKAGE
// for it in the same transaction (giftCards/books.ts expireOneGiftCard):
// 'giftcard.expire:<card>' Dr 2080 / Cr 4200 Gift Card Breakage for a sold
// card, Cr 6060 for a promotional one, in the card's company. Breakage held at
// an earlier expiry (the card's sale not in the books, or a refused posting)
// is retried on every run; each card is processed once per run. node-cron
// only, no Redis.

import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { expireDueGiftCards } from '../modules/giftCards/books.js'

let running = false

/**
 * One pass over every active company. Returns how many cards were marked
 * expired (breakage booked and held is logged per run).
 */
export async function runGiftCardExpiryOnce(now: Date = new Date()): Promise<number> {
  if (running) return 0
  running = true
  let expired = 0
  let breakageCount = 0
  let breakageCents = 0
  let held = 0
  let failed = 0
  try {
    const companies = await prisma.tenant.findMany({ where: { isActive: true, deletedAt: null }, select: { id: true } })
    for (const c of companies) {
      try {
        const r = await expireDueGiftCards(c.id, now, prisma)
        expired += r.expired
        breakageCount += r.breakageCount
        breakageCents += r.breakageCents
        held += r.held
        failed += r.failed
      } catch (err) {
        console.error(`[giftCardExpiry] company ${c.id} failed:`, (err as Error).message)
      }
    }
    if (expired + breakageCount + held + failed > 0) {
      console.info(`[giftCardExpiry] ${expired} gift card(s) marked expired; breakage booked on ${breakageCount} (PKR ${(breakageCents / 100).toFixed(2)}); ${held} held; ${failed} failed`)
    }
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
