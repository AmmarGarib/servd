// Shift corrections — the stale-apply sweep (shiftCorrections/service.ts
// sweepStaleApplies). A set the CEO approved whose apply died mid-way (deploy,
// crash) stays 'approved' with nothing running it; every 5 minutes (and once
// at boot, index.ts) a set with no progress for 5 minutes is moved to
// 'failed' with an APPLY_INTERRUPTED error so the CEO's Retry finishes it.
// node-cron only, no Redis. Started in index.ts under ENABLE_WORKERS.

import cron from 'node-cron'
import { sweepStaleApplies } from '../modules/shiftCorrections/service.js'

let running = false

export async function runShiftCorrectionSweepOnce(): Promise<string[]> {
  if (running) return []
  running = true
  try {
    const moved = await sweepStaleApplies()
    if (moved.length > 0) console.warn(`[shiftCorrectionSweep] ${moved.length} interrupted correction(s) moved to failed: ${moved.join(', ')}`)
    return moved
  } finally {
    running = false
  }
}

export function startShiftCorrectionSweepWorker(): { stop: () => void } {
  const job = cron.schedule('*/5 * * * *', () => {
    runShiftCorrectionSweepOnce().catch((err) => console.error('[shiftCorrectionSweep] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[shiftCorrectionSweep] worker started — every 5 minutes')
  return { stop: () => job.stop() }
}
