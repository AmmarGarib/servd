// Use-by bell (owner B6, 2026-10-26: "Use-by date on deliveries of perishable items, plus an expiring-soon list and
// bell notice"). Daily 07:10 PKT, per company:
//   • stage 'soon'    — open lots whose use-by is today or tomorrow, not yet announced;
//   • stage 'expired' — open lots past their use-by, not yet announced.
// Each lot is announced ONCE per stage (StockLot.useByWarnedAt / expiredWarnedAt, claimed through
// lib/stockLedger.ts markUseByNotifiedTx). One bell notice per (outlet, stage, day) to the company's kitchen managers
// (head chef, managers, F&B manager) who hold the inventory module, linking to the expiring list. The claim and the
// notices are ONE worker-owned transaction (lib/staffNotify.ts insertStaffNotificationsTx), so a failure retries the
// claim on the next run; the sockets are pinged after the commit. Posts nothing, writes no stock.
import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { emitCreated, insertStaffNotificationsTx, type CreatedNotification, type NotifyInput } from '../lib/staffNotify.js'
import { effectiveModulesForUser } from '../lib/moduleAccess.js'
import { markUseByNotifiedTx } from '../lib/stockLedger.js'
import { addDays, karachiDay } from '../lib/useBy.js'
import { expiringLots, type ExpiringLot } from '../modules/inventory/expiring.js'

export const EXPIRY_RECIPIENT_ROLES = ['boh_management', 'manager', 'management', 'fnb_manager'] as const

export function startStockExpiryWorker(): { stop: () => void } {
  const job = cron.schedule('10 7 * * *', () => {
    runStockExpiryOnce().catch((err) => console.error('[stock-expiry] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[stock-expiry] worker started — daily 07:10 PKT')
  return { stop: () => job.stop() }
}

/** The company's kitchen managers who hold the inventory module. */
export async function expiryRecipients(tenantId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      role: { in: [...EXPIRY_RECIPIENT_ROLES] }, isActive: true, accountStatus: 'active', deletedAt: null,
      OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
    },
    select: { id: true, role: true, moduleAllow: true, moduleDeny: true },
  })
  const out: string[] = []
  for (const u of users) {
    if ((await effectiveModulesForUser({ role: u.role, moduleAllow: u.moduleAllow, moduleDeny: u.moduleDeny })).has('inventory')) out.push(u.id)
  }
  return out
}

function listNames(lots: ExpiringLot[]): string {
  const names = [...new Set(lots.map((l) => l.name))]
  return names.length <= 5 ? names.join(', ') : `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`
}

/** One company's pass. Returns the notices created and the lots claimed per stage. */
export async function runStockExpiryForCompany(tenantId: string, now: Date = new Date()): Promise<{ notices: number; soon: number; expired: number }> {
  const today = karachiDay(now)
  const tomorrow = addDays(today, 1)
  const lots = await expiringLots(prisma, [tenantId], { untilDay: tomorrow, today })
  const soon = lots.filter((l) => l.daysLeft >= 0 && !l.useByWarnedAt)
  const expired = lots.filter((l) => l.daysLeft < 0 && !l.expiredWarnedAt)
  if (soon.length === 0 && expired.length === 0) return { notices: 0, soon: 0, expired: 0 }
  const people = await expiryRecipients(tenantId)
  // Nobody to tell: the lots stay unclaimed (a manager added later is told on the next run).
  if (people.length === 0) return { notices: 0, soon: 0, expired: 0 }

  let created: CreatedNotification[] = []
  let claimedSoon = 0
  let claimedExpired = 0
  await prisma.$transaction(async (tx) => {
    const rows: NotifyInput[] = []
    for (const [stage, group] of [['soon', soon], ['expired', expired]] as const) {
      const claimed = new Set(await markUseByNotifiedTx(tx, { tenantId, lotIds: group.map((l) => l.lotId), stage, at: now }))
      const mine = group.filter((l) => claimed.has(l.lotId))
      if (stage === 'soon') claimedSoon = mine.length
      else claimedExpired = mine.length
      const bySite = new Map<string, ExpiringLot[]>()
      for (const l of mine) bySite.set(l.locationId ?? '', [...(bySite.get(l.locationId ?? '') ?? []), l])
      for (const [site, siteLots] of bySite) {
        const where = siteLots[0]!.locationName ? ` at ${siteLots[0]!.locationName}` : ''
        const title = stage === 'soon'
          ? `${siteLots.length} stock lot${siteLots.length === 1 ? '' : 's'} to use by tomorrow${where}`
          : `${siteLots.length} stock lot${siteLots.length === 1 ? ' is' : 's are'} past the use-by date${where}`
        const body = stage === 'soon'
          ? `Use first: ${listNames(siteLots)}.`
          : `Expired: ${listNames(siteLots)}. Log them as waste (reason: expired) if they cannot be used.`
        const link = `/inventory?tab=expiring${site ? `&locationId=${site}` : ''}`
        for (const userId of people) {
          rows.push({
            userId, tenantId, kind: 'stock.expiring', severity: stage === 'soon' ? 'warning' : 'critical',
            title, body, link, entityType: 'Location', entityId: site || null,
            dedupeKey: `stock.useby:${stage}:${site || 'none'}:${today}`,
          })
        }
      }
    }
    created = rows.length ? await insertStaffNotificationsTx(tx, rows) : []
  })
  emitCreated(created)
  return { notices: created.length, soon: claimedSoon, expired: claimedExpired }
}

export async function runStockExpiryOnce(now: Date = new Date()): Promise<number> {
  const companies = await prisma.tenant.findMany({ where: { deletedAt: null, kind: 'company' }, select: { id: true } })
  let n = 0
  for (const { id } of companies) {
    try { n += (await runStockExpiryForCompany(id, now)).notices } catch (err) { console.error(`[stock-expiry] company ${id}:`, (err as Error).message) }
  }
  return n
}
