// A sign-in lasts one shift (owner B1, 2026-10-26). Every 5 minutes: drawers
// closed in the last hour by ANY path end their cashier's sessions (the close
// route does it at once; this is the backstop). Sessions past their shift end
// need nothing here — their tokens expire at the end (auth/sessionEnd.ts).
import cron from 'node-cron'
import { sweepClosedDrawerSessions } from '../modules/auth/sessionEnd.js'

export function startShiftSessionWorker(): { stop: () => void } {
  let busy = false
  const job = cron.schedule('*/5 * * * *', () => {
    if (busy) return
    busy = true
    sweepClosedDrawerSessions()
      .catch((err) => console.error('[shift-sessions] sweep failed:', (err as Error).message))
      .finally(() => { busy = false })
  })
  console.info('[shift-sessions] worker started — every 5 min')
  return { stop: () => job.stop() }
}
