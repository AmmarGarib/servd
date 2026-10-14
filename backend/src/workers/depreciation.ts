// The fixed-asset worker — AUTOMATIC monthly depreciation (owner, 2026-10-13:
// there is no switch). Daily at 03:20 PKT, per company (deletedAt null), on
// serviceClient:
//
//   1. ensureAssetClasses + reclassLegacyAccumulated (H27, runs once in effect);
//   2. chargeThrough the last completed PKT month — the ONE depreciation path
//      (fixedAssets/service.ts); a closed month posts late into the open month
//      with a note; a refused asset is flagged (depreciation_failed +
//      posting_failed) and the others still charge;
//   3. releasePrepaidThrough the same month (accounting/prepaidReleases.ts);
//   4. de-duplicated flags in the company's inbox: capex_uncapitalised,
//      capex_advance_overdue, capex_orphan_advance, capex_prepaid_unscheduled
//      (legacy rows only) and fixed_asset_gl_mismatch (CURRENT balances only);
//   5. FixedAssetRun rows: 'depreciation' (written by chargeThrough),
//      'prepaid_release' and 'checks'.
//
// Daily, not monthly: a month that could not post (the books closed through
// today, a deactivated account) is retried every night until it does, and a
// run is idempotent — the second run of a month posts nothing.

import cron from 'node-cron'
import { serviceClient } from '../lib/prisma.js'
import { flagException, type ExceptionKind } from '../lib/exceptions.js'
import { ensureAssetClasses, getFixedAssetPolicy } from '../modules/fixedAssets/classes.js'
import { chargeThrough, reclassLegacyAccumulated } from '../modules/fixedAssets/service.js'
import { lastCompletedPeriodPkt } from '../modules/fixedAssets/schedule.js'
import { fixedAssetTieOut, advancesReport } from '../modules/fixedAssets/reports.js'
import { releasePrepaidThrough, unscheduledCapexPrepaids } from '../modules/accounting/prepaidReleases.js'
import { findOrphanAdvances } from '../modules/financePlanning/capexPosting.js'

let running = false

export function startDepreciationWorker(): void {
  cron.schedule('20 3 * * *', () => {
    void runDepreciationOnce().catch((err) => console.error('[depreciation] run failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.log('[depreciation] worker scheduled — daily at 03:20 PKT')
}

/**
 * One pass over every company. Returns what each company's depreciation run
 * charged (asset-months) and how many assets failed. A second call while one
 * is running in this process returns [] at once.
 */
export async function runDepreciationOnce(now: Date = new Date()): Promise<Array<{ tenantId: string; charged: number; failed: number }>> {
  if (running) return []
  running = true
  try {
    const tenants = await serviceClient.tenant.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } })
    const out: Array<{ tenantId: string; charged: number; failed: number }> = []
    for (const t of tenants) {
      try {
        out.push(await runForTenant(t.id, now))
      } catch (err) {
        console.error(`[depreciation] company ${t.id}:`, (err as Error).message)
        out.push({ tenantId: t.id, charged: 0, failed: 1 })
      }
    }
    const charged = out.reduce((s, r) => s + r.charged, 0)
    const failed = out.reduce((s, r) => s + r.failed, 0)
    console.log(`[depreciation] ${tenants.length} companies: ${charged} asset-months charged, ${failed} failed`)
    return out
  } finally {
    running = false
  }
}

/** Raise a flag unless the same kind is already open for the same thing (the shrinkageTrend pattern). */
async function flagOnce(input: {
  tenantId: string; kind: ExceptionKind; severity: 'low' | 'medium' | 'high'; title: string; description: string
  entityType: string; entityId: string; amountCents?: number | null; metadata?: Record<string, unknown>
}): Promise<boolean> {
  const open = await serviceClient.exceptionFlag.findFirst({
    where: { tenantId: input.tenantId, kind: input.kind, entityType: input.entityType, entityId: input.entityId, status: { in: ['open', 'acknowledged'] } },
    select: { id: true },
  })
  if (open) return false
  return !!(await flagException(input))
}

const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`

/** The checks of one company: flags raised (de-duplicated). */
async function runChecks(tenantId: string, now: Date): Promise<{ raised: number; problems: string[] }> {
  let raised = 0
  const problems: string[] = []
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn() } catch (err) { problems.push(`${name}: ${(err as Error).message}`.slice(0, 300)) }
  }
  const policy = await getFixedAssetPolicy(tenantId)

  await step('advances', async () => {
    const { rows } = await advancesReport(serviceClient, [tenantId], now)
    for (const r of rows) {
      if (!r['lineId']) continue
      const flags = String(r['flags'] ?? '')
      const held = Number(r['heldCents'] ?? 0)
      const label = `${r['projectName']}: ${r['item']}`
      if (flags.includes('delivered_uncapitalised') && Number(r['deliveredDays'] ?? 0) > policy.capexUncapitalisedAlertDays) {
        if (await flagOnce({
          tenantId, kind: 'capex_uncapitalised', severity: 'medium', entityType: 'CapexLine', entityId: String(r['lineId']), amountCents: held,
          title: `Delivered but not on the register — ${label}`.slice(0, 200),
          description: `${label} was delivered ${r['deliveredDays']} days ago and ${pkr(held)} of advances still sit on 1340. `
            + 'Prepare it for the register (Finance → Project tracker → Capitalise) so its depreciation starts.',
          metadata: { deliveredDays: r['deliveredDays'], heldCents: held },
        })) raised++
      }
      if (flags.includes('overdue_delivery')) {
        if (await flagOnce({
          tenantId, kind: 'capex_advance_overdue', severity: 'medium', entityType: 'CapexLine', entityId: String(r['lineId']), amountCents: held,
          title: `Advance overdue for delivery — ${label}`.slice(0, 200),
          description: `${pkr(held)} was advanced for ${label}, expected on ${r['expectedDeliveryDate']} — more than ${policy.capexAdvanceOverdueDays} days ago and not delivered. Chase the supplier or recover the advance.`,
          metadata: { expectedDeliveryDate: r['expectedDeliveryDate'], heldCents: held },
        })) raised++
      }
    }
  })

  await step('orphans', async () => {
    for (const o of await findOrphanAdvances([tenantId], serviceClient)) {
      if (await flagOnce({
        tenantId, kind: 'capex_orphan_advance', severity: 'high', entityType: 'CapexPayment', entityId: o.paymentId, amountCents: o.amountCents,
        title: 'A CapEx payment is on the books with no live line',
        description: `${pkr(o.amountCents)} posted for a CapEx payment whose ${o.reason === 'project_deleted' ? 'project was deleted' : 'record was deleted'} is still on account ${o.debitCode ?? '?'}. Reverse it (Finance → Project tracker → Orphans) or restore the record.`,
        metadata: { entryId: o.entryId, reason: o.reason, debitCode: o.debitCode },
      })) raised++
    }
  })

  await step('prepaid', async () => {
    for (const p of await unscheduledCapexPrepaids(tenantId, serviceClient)) {
      if (await flagOnce({
        tenantId, kind: 'capex_prepaid_unscheduled', severity: 'medium', entityType: 'CapexPayment', entityId: p.paymentId, amountCents: p.heldCents,
        title: `Prepayment with no months — ${p.label}`.slice(0, 200),
        description: `${pkr(p.heldCents)} paid in advance for ${p.label} sits on 1310 with no months given, so it is never released to rent. Add the months it covers on the payment.`,
        metadata: { heldCents: p.heldCents },
      })) raised++
    }
  })

  await step('tie-out', async () => {
    const [t] = await fixedAssetTieOut(serviceClient, [tenantId])
    if (!t || t.ok) return
    const off = t.byClass.filter((c) => c.costDiffCents !== 0 || c.accumDiffCents !== 0)
    const lines = [
      ...off.map((c) => `${c.label}: cost ${pkr(c.costDiffCents)}, accumulated ${pkr(c.accumDiffCents)}`),
      ...(t.legacy1590DiffCents !== 0 ? [`legacy 1590: ${pkr(t.legacy1590DiffCents)}`] : []),
    ]
    if (await flagOnce({
      tenantId, kind: 'fixed_asset_gl_mismatch', severity: 'high', entityType: 'Tenant', entityId: tenantId,
      title: 'The fixed-asset register and the ledger disagree',
      description: `Ledger minus register — ${lines.join('; ')}. Someone posted to a register account outside the register, or a posting is missing. See Accounting → Fixed assets → Reports → Tie-out.`.slice(0, 2000),
      metadata: { byClass: off, legacy1590DiffCents: t.legacy1590DiffCents },
    })) raised++
  })

  return { raised, problems }
}

/** One company's nightly pass (exported for the tests and the orchestrator). */
export async function runForTenant(tenantId: string, now: Date = new Date()): Promise<{ tenantId: string; charged: number; failed: number }> {
  const through = lastCompletedPeriodPkt(now)

  // 1. Classes, and the one-off move of legacy accumulated depreciation.
  try {
    await ensureAssetClasses(tenantId)
    await reclassLegacyAccumulated(tenantId)
  } catch (err) {
    console.error(`[depreciation] ${tenantId} classes / reclass:`, (err as Error).message)
  }

  // 2. Depreciation — always (no switch). chargeThrough writes its own run row.
  let charged = 0
  let failed = 0
  try {
    const r = await chargeThrough(tenantId, through, { postedBy: 'system' })
    charged = r.chargedCount
    failed = r.failedCount
  } catch (err) {
    failed = 1
    const message = (err as Error).message ?? String(err)
    await serviceClient.fixedAssetRun.create({
      data: { tenantId, kind: 'depreciation', throughPeriod: through, triggeredBy: 'worker', finishedAt: new Date(), failedCount: 1, error: message.slice(0, 1000) },
    }).catch(() => {})
    await flagOnce({
      tenantId, kind: 'depreciation_failed', severity: 'high', entityType: 'FixedAssetRun', entityId: `${tenantId}:${through}`,
      title: `The depreciation run for ${through} did not run`,
      description: `The automatic depreciation through ${through} stopped: ${message.slice(0, 300)}. It is retried every night; "Charge now" on the register runs it at once.`,
      metadata: { throughPeriod: through, reason: message.slice(0, 500) },
    })
  }

  // 3. Prepaid releases (rent advances, OpEx prepayments) for the same month.
  const prepaidRun = await serviceClient.fixedAssetRun.create({
    data: { tenantId, kind: 'prepaid_release', throughPeriod: through, triggeredBy: 'worker' }, select: { id: true },
  })
  try {
    const r = await releasePrepaidThrough(tenantId, through, { postedBy: 'system' })
    await serviceClient.fixedAssetRun.update({ where: { id: prepaidRun.id }, data: { chargedCount: r.released, chargedCents: r.cents, finishedAt: new Date() } })
  } catch (err) {
    await serviceClient.fixedAssetRun.update({
      where: { id: prepaidRun.id }, data: { failedCount: 1, finishedAt: new Date(), error: ((err as Error).message ?? '').slice(0, 1000) },
    }).catch(() => {})
  }

  // 4. Checks and flags.
  const checksRun = await serviceClient.fixedAssetRun.create({
    data: { tenantId, kind: 'checks', throughPeriod: through, triggeredBy: 'worker' }, select: { id: true },
  })
  const checks = await runChecks(tenantId, now)
  await serviceClient.fixedAssetRun.update({
    where: { id: checksRun.id },
    data: {
      chargedCount: checks.raised, failedCount: checks.problems.length, finishedAt: new Date(),
      error: checks.problems.length > 0 ? checks.problems.join(' | ').slice(0, 1000) : null,
    },
  })

  return { tenantId, charged, failed }
}

