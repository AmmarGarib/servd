// Compensation tickets (owner, 2026-10-27) — every minute under ENABLE_WORKERS,
// per company: make the missing tickets from the committed void / comp /
// refund audit rows and the discount / price-override review flags
// (modules/complaints/compensation.ts holds the rules; a ticket is made once,
// compSourceRef unique). Posts nothing, notifies nobody — a ticket goes through.

import { syncCompensationTickets } from '../modules/complaints/compensation.js'

export const COMPENSATION_TICKETS_INTERVAL_MS = 60_000
const FIRST_TICK_MS = 50_000

let timer: NodeJS.Timeout | null = null
let running = false

export async function runCompensationTicketsOnce(): Promise<number> {
  if (running) return 0
  running = true
  try {
    return await syncCompensationTickets()
  } catch (err) {
    console.error('[compensationTickets] run failed:', (err as Error).message)
    return 0
  } finally {
    running = false
  }
}

export function startCompensationTicketsWorker(): { stop: () => void } {
  if (!timer) {
    const tick = () => { void runCompensationTicketsOnce() }
    const first = setTimeout(tick, FIRST_TICK_MS)
    first.unref()
    timer = setInterval(tick, COMPENSATION_TICKETS_INTERVAL_MS)
    timer.unref()
  }
  return { stop: () => { if (timer) clearInterval(timer); timer = null } }
}
