// Scheduled storefront publishing (content module, decision 41).
//
// Every minute, publish each SiteLayout the CEO approved with a publishAt that
// has now passed. The public read (GET /site-layouts/:slug and /popups/live)
// publishes a due row lazily as well, so a page never waits on this worker;
// both go through publishDueLayouts(), whose conditional update makes a row
// publish exactly once however many processes race on it.

import { publishDueLayouts } from '../modules/siteLayouts/service.js'

const RUN_EVERY_MS = 60_000

/** One sweep. Throws on failure (the scheduler tick records it). */
export async function runSitePublishSweep(): Promise<number> {
  const n = await publishDueLayouts()
  if (n > 0) console.info(`[sitePublish] published ${n} scheduled page(s)`)
  return n
}

export function startSitePublishWorker(): NodeJS.Timeout {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await runSitePublishSweep()
    } catch (err) {
      console.warn('[sitePublish] sweep failed:', (err as Error).message)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => { void tick() }, RUN_EVERY_MS)
  timer.unref()
  void tick()
  return timer
}
