// Food safety overdue reminders (owner, 2026-10-26, B7a): hourly, per company,
// ONE bell notice per overdue occurrence to the company's kitchen managers.
// Logic and rules: modules/foodSafety/overdue.ts. node-cron; posts nothing.
import cron from 'node-cron'
import { runFoodSafetyOverdueOnce } from '../modules/foodSafety/overdue.js'

export function startFoodSafetyOverdueWorker(): { stop: () => void } {
  const job = cron.schedule('20 * * * *', () => {
    runFoodSafetyOverdueOnce().catch((err) => console.error('[food-safety-overdue] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[food-safety-overdue] worker started — hourly')
  return { stop: () => job.stop() }
}
