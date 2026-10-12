// Card-machine reconciler (spec §9.2). W4 starts it under ENABLE_WORKERS.
//
// Every 10 s, per company with charges in flight:
//   - sent / pending rows older than 10 s, past-expiry rows, cancel_requested,
//     and unknown / unverified / manual_resolved rows younger than 24 h →
//     getChargeStatus → applyChargeState (the same state machine as the
//     cashier's poll and the webhook);
//   - approved with no payment, older than 5 s → recordApprovedCharge;
//   - void_pending due → reverseCharge;
//   - unknown older than 24 h → needs_attention + terminal_unreconciled.
// No Redis: the terminal flow never depends on it.

import cron from 'node-cron'
import { reconcileTerminal } from '../connectors/terminal/service.js'

let running = false

export async function runTerminalReconcile(): Promise<void> {
  if (running) return
  running = true
  try {
    const s = await reconcileTerminal()
    if (s.recorded || s.reversed || s.escalated) {
      console.info(`[terminal-reconciler] polled=${s.polled} recorded=${s.recorded} reversed=${s.reversed} escalated=${s.escalated}`)
    }
  } catch (err) {
    console.error('[terminal-reconciler] tick failed:', (err as Error).message)
  } finally {
    running = false
  }
}

export function startTerminalConnectorWorker(): { stop: () => void } {
  const task = cron.schedule('*/10 * * * * *', () => { void runTerminalReconcile() })
  console.info('[terminal-reconciler] started')
  return { stop: () => { task.stop() } }
}
