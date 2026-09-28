import { processCoursePacingTick } from '../modules/orders/service.js'

const TICK_INTERVAL_MS = 30_000  // every 30 seconds

let timer: NodeJS.Timeout | null = null

/** One pacing tick. Throws on failure (callers log / record it). */
export async function runCoursePacingTick(): Promise<number> {
  const n = await processCoursePacingTick()
  if (n > 0) console.log(`[course-pacing] auto-fired ${n} items`)
  return n
}

export function startCoursePacingWorker() {
  if (timer) return
  console.log('[course-pacing] worker started — ticking every 30s')
  timer = setInterval(() => {
    runCoursePacingTick().catch((err) => {
      console.error('[course-pacing] tick failed:', (err as Error).message)
    })
  }, TICK_INTERVAL_MS)
}

export function stopCoursePacingWorker() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
