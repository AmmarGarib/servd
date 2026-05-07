import { processCoursePacingTick } from '../modules/orders/service.js'

const TICK_INTERVAL_MS = 30_000  // every 30 seconds

let timer: NodeJS.Timeout | null = null

export function startCoursePacingWorker() {
  if (timer) return
  console.log('[course-pacing] worker started — ticking every 30s')
  timer = setInterval(() => {
    processCoursePacingTick().then((n) => {
      if (n > 0) console.log(`[course-pacing] auto-fired ${n} items`)
    }).catch((err) => {
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
