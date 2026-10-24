// On-account clients — the daily flags (corporate clients on account). The
// orchestrator starts it in index.ts under ENABLE_WORKERS. node-cron only, no
// Redis. At 09:20 PKT, for every active company that has at least one client
// (a company with no clients does nothing, so this is invisible until
// on-account is used):
//
//   on_account_overdue   ONE open flag per client statement or invoice whose
//                        Karachi due day + the client's grace days is before
//                        today's Karachi day and that still owes money.
//                        Severity 'high' once it is more than 30 days past its
//                        due day, else 'medium'. Refreshed (amount, severity)
//                        each day; resolved once its balance is ≤ 0 (or it is
//                        voided).
//   on_account_unbilled  ONE open flag per client with charges whose sale is
//                        BOOKED (onAccount.ts isChargeBookedTx) that are older
//                        than 35 days and still on no statement. Resolved once
//                        none are left.
//
// Every flag carries the DOCUMENT's company (the invoice's / the client's),
// and every query is filtered on that company. Test companies are not
// skipped: these are their own books. Nothing here posts to the ledger.

import cron from 'node-cron'
import type { Prisma, PrismaClient } from '@prisma/client'
import { serviceClient as prisma } from '../lib/prisma.js'
import { karachiDay } from '../connectors/util.js'
import { LIVE_KINDS, balanceOf } from '../modules/receivables/ledger.js'
import { isChargeBookedTx } from '../modules/receivables/onAccount.js'
import { chargeOwedCents } from '../modules/receivables/cityLedger.js'

type Db = PrismaClient | Prisma.TransactionClient

export const OVERDUE_KIND = 'on_account_overdue'
export const UNBILLED_KIND = 'on_account_unbilled'
/** Booked charges older than this many days and still unbilled are flagged. */
export const UNBILLED_AFTER_DAYS = 35
/** An overdue bill more than this many days past its due day is flagged 'high'. */
export const HIGH_AFTER_DAYS = 30

const DAY = 86_400_000
const OPEN = ['open', 'acknowledged'] as const
const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK')}`
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY)

interface FlagInput {
  tenantId: string
  kind: typeof OVERDUE_KIND | typeof UNBILLED_KIND
  severity: 'medium' | 'high'
  entityType: 'ReceivableInvoice' | 'CustomerAccount'
  entityId: string
  title: string
  description: string
  conceptId: string | null
  amountCents: number
  metadata: Record<string, unknown>
}

/** Raise the one open flag on an entity, or refresh it (never a second). */
async function raiseFlag(db: Db, f: FlagInput): Promise<boolean> {
  const open = await db.exceptionFlag.findFirst({
    where: { tenantId: f.tenantId, kind: f.kind, entityType: f.entityType, entityId: f.entityId, status: { in: [...OPEN] } },
    select: { id: true },
  })
  const data = {
    severity: f.severity,
    title: f.title.slice(0, 200),
    description: f.description.slice(0, 2000),
    conceptId: f.conceptId,
    amountCents: f.amountCents,
    metadata: f.metadata as Prisma.InputJsonObject,
  }
  if (open) {
    await db.exceptionFlag.update({ where: { id: open.id }, data })
    return false
  }
  await db.exceptionFlag.create({ data: { tenantId: f.tenantId, kind: f.kind, entityType: f.entityType, entityId: f.entityId, ...data } })
  return true
}

async function resolveFlags(db: Db, tenantId: string, kind: string, entityType: string, entityIds: string[], resolution: string): Promise<number> {
  if (entityIds.length === 0) return 0
  const r = await db.exceptionFlag.updateMany({
    where: { tenantId, kind, entityType, entityId: { in: entityIds }, status: { in: [...OPEN] } },
    data: { status: 'resolved', resolvedAt: new Date(), resolution: resolution.slice(0, 500) },
  })
  return r.count
}

export interface OnAccountDailyResult {
  overdueFlagged: number
  overdueResolved: number
  unbilledFlagged: number
  unbilledResolved: number
}

/** One company's pass. Reads and writes that company's rows only. */
export async function runOnAccountDailyForTenant(tenantId: string, now: Date = new Date(), db: Db = prisma): Promise<OnAccountDailyResult> {
  const out: OnAccountDailyResult = { overdueFlagged: 0, overdueResolved: 0, unbilledFlagged: 0, unbilledResolved: 0 }
  const today = karachiDay(now)
  const accounts = await db.customerAccount.findMany({
    where: { tenantId },
    select: { id: true, number: true, legalName: true, overdueGraceDays: true },
  })
  if (accounts.length === 0) return out
  const accountById = new Map(accounts.map((a) => [a.id, a]))

  // ── Overdue statements and invoices ────────────────────────────────────────
  const bills = await db.receivableInvoice.findMany({
    where: { tenantId, customerAccountId: { in: accounts.map((a) => a.id) }, kind: { in: [...LIVE_KINDS] } },
    select: {
      id: true, number: true, kind: true, status: true, dueDate: true, conceptId: true, customerAccountId: true,
      amountCents: true, taxCents: true, paidCents: true, creditedCents: true, whtCents: true, writtenOffCents: true,
    },
  })
  const settled: string[] = []
  for (const b of bills) {
    const balance = balanceOf(b)
    if (b.status === 'void' || balance <= 0) { settled.push(b.id); continue }
    const acct = accountById.get(b.customerAccountId!)
    if (!acct) continue
    const due = karachiDay(b.dueDate)
    if (!(addDays(due, acct.overdueGraceDays) < today)) continue
    const daysLate = daysBetween(due, today)
    const what = b.kind === 'statement' ? 'Statement' : 'Invoice'
    if (await raiseFlag(db, {
      tenantId, kind: OVERDUE_KIND, severity: daysLate > HIGH_AFTER_DAYS ? 'high' : 'medium',
      entityType: 'ReceivableInvoice', entityId: b.id,
      title: `${what} ${b.number} — ${acct.legalName} is ${daysLate} day${daysLate === 1 ? '' : 's'} overdue`,
      description: `${acct.legalName} (${acct.number}) still owes ${pkr(balance)} on ${what.toLowerCase()} ${b.number}, due ${due} `
        + `(${acct.overdueGraceDays} grace day${acct.overdueGraceDays === 1 ? '' : 's'}). The till refuses this client's charges until it is settled.`,
      conceptId: b.conceptId, amountCents: balance,
      metadata: { invoiceId: b.id, number: b.number, kind: b.kind, accountId: acct.id, dueDate: due, daysLate, graceDays: acct.overdueGraceDays },
    })) out.overdueFlagged++
  }
  out.overdueResolved = await resolveFlags(db, tenantId, OVERDUE_KIND, 'ReceivableInvoice', settled, 'Settled — nothing is owed on it any more')

  // ── Booked charges not on a statement for too long ─────────────────────────
  const cutoff = new Date(now.getTime() - UNBILLED_AFTER_DAYS * DAY)
  const old = await db.customerAccountCharge.findMany({
    where: { tenantId, statementInvoiceId: null, chargedAt: { lt: cutoff } },
    select: { tenantId: true, accountId: true, orderId: true, paymentId: true, amountCents: true, refundedCents: true, settledCents: true, chargedAt: true },
    orderBy: { chargedAt: 'asc' },
  })
  const late = new Map<string, { cents: number; count: number; oldest: Date }>()
  for (const c of old) {
    const net = chargeOwedCents(c) // net of City Ledger settlements
    if (net <= 0 || !(await isChargeBookedTx(db, c))) continue
    const cur = late.get(c.accountId) ?? { cents: 0, count: 0, oldest: c.chargedAt }
    cur.cents += net
    cur.count++
    if (c.chargedAt < cur.oldest) cur.oldest = c.chargedAt
    late.set(c.accountId, cur)
  }
  for (const [accountId, l] of late) {
    const acct = accountById.get(accountId)
    if (!acct) continue
    if (await raiseFlag(db, {
      tenantId, kind: UNBILLED_KIND, severity: 'medium', entityType: 'CustomerAccount', entityId: accountId,
      title: `${acct.legalName}: ${l.count} charge${l.count === 1 ? '' : 's'} not billed after ${UNBILLED_AFTER_DAYS} days`,
      description: `${acct.legalName} (${acct.number}) has ${pkr(l.cents)} of booked on-account charges, the oldest from ${karachiDay(l.oldest)}, `
        + 'on no statement yet. Issue the client\'s statement.',
      conceptId: null, amountCents: l.cents,
      metadata: { accountId, count: l.count, oldest: karachiDay(l.oldest), afterDays: UNBILLED_AFTER_DAYS },
    })) out.unbilledFlagged++
  }
  out.unbilledResolved = await resolveFlags(
    db, tenantId, UNBILLED_KIND, 'CustomerAccount', accounts.map((a) => a.id).filter((id) => !late.has(id)),
    'Every booked charge older than 35 days is on a statement',
  )
  return out
}

let running = false

/** One pass over every active company that has a client. Returns the totals. */
export async function runOnAccountDailyOnce(now: Date = new Date()): Promise<OnAccountDailyResult> {
  const total: OnAccountDailyResult = { overdueFlagged: 0, overdueResolved: 0, unbilledFlagged: 0, unbilledResolved: 0 }
  if (running) return total
  running = true
  try {
    const companies = await prisma.tenant.findMany({
      where: { isActive: true, deletedAt: null, id: { in: (await prisma.customerAccount.findMany({ distinct: ['tenantId'], select: { tenantId: true } })).map((r) => r.tenantId) } },
      select: { id: true },
    })
    for (const c of companies) {
      try {
        const r = await runOnAccountDailyForTenant(c.id, now)
        total.overdueFlagged += r.overdueFlagged
        total.overdueResolved += r.overdueResolved
        total.unbilledFlagged += r.unbilledFlagged
        total.unbilledResolved += r.unbilledResolved
      } catch (err) {
        console.error(`[onAccountDaily] company ${c.id} failed:`, (err as Error).message)
      }
    }
    if (total.overdueFlagged + total.unbilledFlagged > 0) {
      console.info(`[onAccountDaily] ${total.overdueFlagged} overdue bill(s), ${total.unbilledFlagged} client(s) with unbilled charges flagged`)
    }
    return total
  } finally {
    running = false
  }
}

export function startOnAccountDailyWorker(): { stop: () => void } {
  const job = cron.schedule('20 9 * * *', () => {
    runOnAccountDailyOnce().catch((err) => console.error('[onAccountDaily] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[onAccountDaily] worker started — daily 09:20 PKT')
  return { stop: () => job.stop() }
}
