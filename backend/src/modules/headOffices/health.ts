// Head office (D1) — the public /health line `headOffice: off | ok | warn`
// (spec §4.9). Public /health rule (CLAUDE.md): counts and where to look only,
// never an amount or a company / head-office name.
//
//   off   no head office has recharge switched on (today's state — nothing to watch)
//   warn  an open 'intercompany_mismatch' flag in a head office, or a head office
//         with recharge on whose LAST month is still not ready after day 10 (PKT)
//         of this month
//   ok    otherwise
//
// The orchestrator wires it: `checks.headOffice = h.status; if (h.detail)
// details.headOffice = h.detail`.

import { serviceClient } from '../../lib/prisma.js'
import { fmtPktDate } from '../accounting/dates.js'
import { addMonths, monthOf } from '../intercompany/fleet.js'
import { monthReadiness } from './runs.js'

export interface HeadOfficeHealth {
  status: 'off' | 'ok' | 'warn'
  /** Counts only, for details.headOffice (null when there is nothing to say). */
  detail: string | null
  counts: { rechargeOn: number; lastMonthNotReady: number; openMismatchFlags: number }
}

/** The day after which a head office's last month must be ready. */
export const HEALTH_READY_BY_DAY = 10

export async function headOfficeHealth(now: Date = new Date()): Promise<HeadOfficeHealth> {
  const on = await serviceClient.headOfficeBooks.findMany({
    where: { rechargeEnabled: true, tenant: { kind: 'head_office', isActive: true, deletedAt: null } },
    select: { tenantId: true, rechargeFromPeriod: true },
  })
  if (on.length === 0) return { status: 'off', detail: null, counts: { rechargeOn: 0, lastMonthNotReady: 0, openMismatchFlags: 0 } }

  const lastMonth = addMonths(monthOf(now), -1)
  const day = Number(fmtPktDate(now).slice(8, 10))
  let lastMonthNotReady = 0
  if (day > HEALTH_READY_BY_DAY) {
    for (const b of on) {
      if (!b.rechargeFromPeriod || lastMonth < b.rechargeFromPeriod) continue
      try {
        if (!(await monthReadiness(serviceClient, b.tenantId, lastMonth)).ready) lastMonthNotReady += 1
      } catch {
        lastMonthNotReady += 1
      }
    }
  }
  const hoIds = (await serviceClient.tenant.findMany({ where: { kind: 'head_office' }, select: { id: true } })).map((t) => t.id)
  const openMismatchFlags = hoIds.length
    ? await serviceClient.exceptionFlag.count({ where: { kind: 'intercompany_mismatch', tenantId: { in: hoIds }, status: { in: ['open', 'acknowledged'] } } })
    : 0
  const counts = { rechargeOn: on.length, lastMonthNotReady, openMismatchFlags }
  const parts: string[] = []
  if (lastMonthNotReady) parts.push(`${lastMonthNotReady} head office(s) with last month not recharged after day ${HEALTH_READY_BY_DAY}`)
  if (openMismatchFlags) parts.push(`${openMismatchFlags} open head-office pair mismatch flag(s)`)
  if (parts.length === 0) return { status: 'ok', detail: null, counts }
  return { status: 'warn', detail: `${parts.join('; ')} — Accounting → Inter-company → Head office`, counts }
}
