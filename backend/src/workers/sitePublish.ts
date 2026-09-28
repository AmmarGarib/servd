// Scheduled storefront publishing (content module, decision 41).
//
// Every minute, publish each SiteLayout the CEO approved with a publishAt that
// has now passed. The public read (GET /site-layouts/:slug and /popups/live)
// publishes a due row lazily as well, so a page never waits on this worker;
// both go through publishDueLayouts(), whose conditional update makes a row
// publish exactly once however many processes race on it.

import { publishDueLayouts } from '../modules/siteLayouts/service.js'

const RUN_EVERY_MS = 60_000

export function startSitePublishWorker(): NodeJS.Timeout {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const n = await publishDueLayouts()
      if (n > 0) console.info(`[sitePublish] published ${n} scheduled page(s)`)
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
