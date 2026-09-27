// The HR daily sweep, for every company. Everything here is idempotent and
// also runs lazily where it is read; the sweep makes it happen on time even on
// a day nobody opens HR:
//   • approved effects that have come due (salary revisions, transfers, …)
//   • days punched in and never out become missing punches
//   • leavers' logins are switched off once their last working day has passed
//
// Wire it as a nightly worker (workers/ belongs to another batch — see the
// report): cron.schedule('15 0 * * *', () => void runHrDaily()) — 00:15 is
// after midnight in Karachi when the server runs on PKT; on UTC use
// '15 19 * * *'.

import { serviceClient as prisma } from '../../lib/prisma.js'
import { applyDueEffects } from './service.js'
import { flagMissingPunches } from './attendance.js'
import { deactivateLeftLogins } from './separations.js'

export async function runHrDaily(now = new Date()) {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true, deletedAt: null }, select: { id: true } })
  const out: Array<{ tenantId: string; effects: number; missingPunches: number; loginsOff: number; error?: string }> = []
  for (const t of tenants) {
    try {
      const effects = await applyDueEffects(t.id, now)
      const missingPunches = await flagMissingPunches(t.id, now)
      const loginsOff = await deactivateLeftLogins(t.id, now)
      out.push({ tenantId: t.id, effects, missingPunches, loginsOff })
    } catch (err) {
      // One company's failure must not stop the others.
      out.push({ tenantId: t.id, effects: 0, missingPunches: 0, loginsOff: 0, error: (err as Error).message })
    }
  }
  return out
}
