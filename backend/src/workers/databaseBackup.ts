// The weekly database backup FILE (owner S13, 2026-10-26): Sunday 03:00 PKT.
// Logic: modules/backups/service.ts (no passphrase → nothing made, the CEO is
// told; never on the practice copy).
import cron from 'node-cron'
import { runWeeklyBackup } from '../modules/backups/service.js'

export function startDatabaseBackupWorker(): { stop: () => void } {
  const job = cron.schedule('0 3 * * 0', () => {
    runWeeklyBackup().catch((err) => console.error('[backup] weekly run failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[backup] worker started — weekly, Sunday 03:00 PKT')
  return { stop: () => job.stop() }
}
