// Marketing "published vs slipped" Monday bell (owner, 2026-11-03). Logic: modules/marketingBoard/weekly.ts.
// Daily check at 09:40 PKT, but the per-company week marker makes it ONE notice a week (last week's figures):
// Monday 09:40, caught up the next morning if the box was down. Bell only; idempotent (marker + dedupeKey).
import cron from 'node-cron'
import { runMarketingWeeklyOnce } from '../modules/marketingBoard/weekly.js'

export function startMarketingWeeklyWorker(): { stop: () => void } {
  const job = cron.schedule('40 9 * * *', () => {
    runMarketingWeeklyOnce().catch((err) => console.error('[marketing-weekly] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[marketing-weekly] worker started — weekly published-vs-slipped notice (first run each week, normally Monday 09:40 PKT)')
  return { stop: () => job.stop() }
}
