// Inter-company nightly worker (H30) — 03:40 PKT.
//
//   1. Shared-fleet recharge: every ended month (the last
//      FLEET_AUTO_MONTHS_BACK) of every fleet agreement with a rate above
//      zero, not charged yet, is charged between the two companies
//      (modules/intercompany/fleet.ts chargeFleetMonth — idempotent; a refusal
//      raises posting_failed 'ic.fleet_charge' and the sweep moves on).
//   2. Pair check: a company pair whose two books disagree (one company's
//      'Due to' ≠ the other's 'Due from') raises ONE open
//      'intercompany_mismatch' flag in each company until it is resolved.
//
// node-cron only, no Redis; serviceClient (no RLS context); a running guard
// stops two passes overlapping. Nothing is charged until the CEO sets a rate,
// so starting the worker books nothing by itself.

import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { flagException } from '../lib/exceptions.js'
import { runFleetChargesOnce } from '../modules/intercompany/fleet.js'
import { IC_CONTROLLED_BY, pairBalances, pairKey } from '../modules/intercompany/accounts.js'

export { runFleetChargesOnce }

/** Raise (once per company and pair) an open intercompany_mismatch flag where the two books disagree. */
export async function flagPairMismatches(): Promise<number> {
  const accounts = await prisma.account.findMany({
    where: { controlledBy: IC_CONTROLLED_BY, tenantId: { not: null }, counterpartyTenantId: { not: null } },
    select: { tenantId: true, counterpartyTenantId: true },
  })
  const pairs = new Map<string, [string, string]>()
  for (const a of accounts) pairs.set(pairKey(a.tenantId!, a.counterpartyTenantId!), [a.tenantId!, a.counterpartyTenantId!])
  let raised = 0
  for (const [key, [a, b]] of pairs) {
    const bal = await pairBalances(prisma, a, b)
    if (bal.mismatchCents === 0) continue
    const names = await prisma.tenant.findMany({ where: { id: { in: [a, b] } }, select: { id: true, name: true } })
    const nameOf = (t: string) => names.find((n) => n.id === t)?.name ?? 'company'
    for (const self of [a, b]) {
      const open = await prisma.exceptionFlag.findFirst({
        where: { kind: 'intercompany_mismatch', tenantId: self, entityType: 'CompanyPair', entityId: key, status: { in: ['open', 'acknowledged'] } },
        select: { id: true },
      })
      if (open) continue
      const other = self === a ? b : a
      await flagException({
        tenantId: self,
        kind: 'intercompany_mismatch',
        severity: 'high',
        title: `Inter-company balance with ${nameOf(other)} does not agree`,
        description: `${nameOf(a)} and ${nameOf(b)} disagree on what they owe each other by ${(bal.mismatchCents / 100).toLocaleString('en-PK', { minimumFractionDigits: 2 })} PKR. `
          + 'Every inter-company posting moves both books, so one book holds an entry the other does not — look for a hand entry or a one-sided reversal (Accounting → Inter-company → Balances).',
        entityType: 'CompanyPair',
        entityId: key,
        amountCents: bal.mismatchCents,
        metadata: { ...bal, a, b },
      })
      raised += 1
    }
  }
  return raised
}

/** One full pass (fleet charges, then the pair check). */
export async function runIntercompanyNightlyOnce(now: Date = new Date()): Promise<void> {
  await runFleetChargesOnce(now)
  try {
    await flagPairMismatches()
  } catch (err) {
    console.error('[intercompanyFleet] pair check failed:', (err as Error).message)
  }
}

export function startIntercompanyFleetWorker(): void {
  cron.schedule('40 3 * * *', () => {
    runIntercompanyNightlyOnce().catch((err) => console.error('[intercompanyFleet] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[intercompanyFleet] worker started — daily 03:40 PKT (shared-fleet charges, pair check)')
}
