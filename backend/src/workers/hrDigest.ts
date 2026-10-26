// HR weekly expiry digest (once a week, Monday 09:00 PKT) and waiting-request reminders
// (daily 10:05 PKT) — owner, 2026-10-26, B5a. Logic: modules/hr/expiryDigest.ts.
// Bell only; node-cron; idempotent (per-company week marker + notice dedupeKeys).
import cron from 'node-cron'
import { runHrDigestOnce, runHrRequestRemindersOnce } from '../modules/hr/expiryDigest.js'

export function startHrDigestWorker(): { stop: () => void } {
  // Daily check, but the per-company week marker makes it ONE digest a week: Monday 09:00, caught up the next morning if the box was down.
  const weekly = cron.schedule('0 9 * * *', () => {
    runHrDigestOnce().catch((err) => console.error('[hr-digest] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  const daily = cron.schedule('5 10 * * *', () => {
    runHrRequestRemindersOnce().catch((err) => console.error('[hr-reminders] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[hr-digest] worker started — weekly digest (first run each week, normally Monday 09:00 PKT), daily 10:05 PKT reminders')
  return { stop: () => { weekly.stop(); daily.stop() } }
}
