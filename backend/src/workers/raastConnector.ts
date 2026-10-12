// Raast QR worker (spec §6.10). The orchestrator starts it in index.ts under
// ENABLE_WORKERS. node-cron only — no Redis: Raast intake and matching never
// depend on it. Every step is a conditional claim, so two processes (or a
// tick overlapping the webhook's fast path) never double-apply.
//
//   */30 s   process received bank SMS (backstop), unstick 'processing',
//            expire awaiting intents
//   */10 min raast_unconfirmed + raast_sms_unmatched flags (SMS-on companies)
//   03:15 PKT daily — SMS text retention (90 days; unparsed 30)

import cron from 'node-cron'
import { runRaastTick, runRaastEscalations, runRaastRetention } from '../connectors/raast/sweeper.js'

let ticking = false
let escalating = false

export async function runRaastTickOnce(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const s = await runRaastTick()
    if (s.processed || s.reset || s.expired) console.info(`[raast] processed=${s.processed} reset=${s.reset} expired=${s.expired}`)
  } catch (err) {
    console.error('[raast] tick failed:', (err as Error).message)
  } finally {
    ticking = false
  }
}

export async function runRaastEscalationsOnce(): Promise<void> {
  if (escalating) return
  escalating = true
  try {
    const s = await runRaastEscalations()
    if (s.unconfirmed || s.unmatched) console.info(`[raast] flags unconfirmed=${s.unconfirmed} unmatched=${s.unmatched}`)
  } catch (err) {
    console.error('[raast] escalations failed:', (err as Error).message)
  } finally {
    escalating = false
  }
}

export function startRaastConnectorWorker(): { stop: () => void } {
  const tick = cron.schedule('*/30 * * * * *', () => { void runRaastTickOnce() })
  const esc = cron.schedule('*/10 * * * *', () => { void runRaastEscalationsOnce() })
  const ret = cron.schedule('15 3 * * *', () => {
    runRaastRetention().catch((err) => console.error('[raast] retention failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[raast] worker started')
  return { stop: () => { tick.stop(); esc.stop(); ret.stop() } }
}
