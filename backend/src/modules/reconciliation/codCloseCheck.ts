// The period-close check for cash on delivery (H5; owner decision
// DLV-COD-close, 2026-10-15: "Month closing require CEO/Finance approval if
// any amount is pending anywhere, no proceeding further until approval is
// obtained").
//
// key 'cod_with_rider', severity BLOCK, overridable — only the CEO closes
// over it, with acknowledge { keys, reason ≥ 10 } (the one close-override
// mechanism in accounting/routes.ts; recorded on PeriodLock.overrides and
// flagged 'period_close_override'). It runs for EVERY company — a
// switched-on (code-only) company and any other company that has COD money
// pending — and reads only ctx.tenantId's rows.
//
// It counts every COD payment (lib/cod.ts codDueWhere: cash, still pending,
// amount > 0, a completed non-till order) whose order completed on or before
// the close date and that is still not paid into a drawer: with the rider,
// overdue, booked as owed by the rider (1351 — booked, but the cash is still
// out) or a pickup's cash not yet at the counter. The detail splits them by
// status; the link is Finance → Reconciliation → Cash on delivery while the
// company's code-only switch is on, else the till's pay-in list (codPendingLink).
// The orchestrator adds codCloseCheck to CLOSE_CHECKS (accounting/closeChecks.ts).

import type { Prisma } from '@prisma/client'
import type { CloseCheck, CloseCheckDb } from '../accounting/closeCheckTypes.js'
import { fmtPktDate } from '../accounting/dates.js'
import { codDueWhere, codStatusOf, type CodStatus } from '../../lib/cod.js'
import { toCents } from '../../lib/money.js'
import { codeOnlyDelivery } from '../../lib/deliveryRules.js'

/** accounting/codPosting.ts's keys (COD_DEBT_SOURCE / COD_TRANSFER_SOURCE_REF) — kept literal here so this check never imports the posting module (pos/service). */
const COD_DEBT_REF = (paymentId: string) => `cod.rider_debt:${paymentId}`
const COD_TRANSFER_REF = (paymentId: string) => `cod:${paymentId}`

/**
 * Of `rows` (COD payments of `tenantId`'s orders), the ids whose rider debt
 * finance has booked AND that booking is still live — the markers
 * accounting/codPosting.ts bookCodRiderDebt writes:
 *   • own rider: Payment.codRiderDebtEntryId → the entry
 *     'cod.rider_debt:<paymentId>' in the order's company, not reversed
 *     (deadEntryIds: no '.reversal' / '.void' of it);
 *   • fleet rider: Payment.codRiderDebtTransferId → the inter-company transfer
 *     sourceRef 'cod:<paymentId>' with this company as the creditor, status
 *     'posted' (not reversed).
 * codRiderDebtAt alone (a claim with no entry / transfer) is NOT booked.
 * Used by the night audit's cod_pending only (owner, 2026-10-17): the month
 * close (cod_with_rider) still blocks on every pending COD.
 */
export async function codBookedDebtIds(
  db: CloseCheckDb,
  tenantId: string,
  rows: Array<{ id: string; codRiderDebtAt: Date | null; codRiderDebtEntryId: string | null; codRiderDebtTransferId: string | null }>,
): Promise<Set<string>> {
  const booked = new Set<string>()
  const claimed = rows.filter((r) => r.codRiderDebtAt)
  const entryIds = claimed.map((r) => r.codRiderDebtEntryId).filter((x): x is string => !!x)
  if (entryIds.length > 0) {
    const entries = await db.journalEntry.findMany({
      where: { id: { in: entryIds }, tenantId },
      select: { id: true, reference: true, description: true },
    })
    // Loaded lazily: service.ts reaches accounting/closeChecks.ts, which imports this file.
    const { deadEntryIds } = await import('./service.js')
    const dead = await deadEntryIds(db, tenantId, entries)
    const live = new Map(entries.filter((e) => !dead.has(e.id)).map((e) => [e.id, e.reference]))
    for (const r of claimed) {
      if (r.codRiderDebtEntryId && live.get(r.codRiderDebtEntryId) === COD_DEBT_REF(r.id)) booked.add(r.id)
    }
  }
  const transferIds = claimed.map((r) => r.codRiderDebtTransferId).filter((x): x is string => !!x)
  if (transferIds.length > 0) {
    const transfers = await db.intercompanyTransfer.findMany({
      where: { id: { in: transferIds }, counterpartyTenantId: tenantId, source: 'cod', status: 'posted' },
      select: { id: true, sourceRef: true },
    })
    const live = new Map(transfers.map((t) => [t.id, t.sourceRef]))
    for (const r of claimed) {
      if (r.codRiderDebtTransferId && live.get(r.codRiderDebtTransferId) === COD_TRANSFER_REF(r.id)) booked.add(r.id)
    }
  }
  return booked
}

const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const STATUS_WORDS: Record<CodStatus, string> = {
  with_rider: 'with the rider',
  overdue: 'overdue with the rider',
  rider_owes: 'booked as owed by the rider',
  at_counter: 'pickup cash not at the counter',
}

/**
 * COD payments of the company (codDueWhere) on orders completed — else placed
 * — in [from, to] (from null = no lower bound) that are not paid into a drawer
 * yet. The month check (to = the lock) and the night audit's cod_pending (one
 * sales day) share it.
 */
export async function codPendingRows(db: CloseCheckDb, tenantId: string, from: Date | null, to: Date) {
  const base = codDueWhere({ tenantId })
  const at = { ...(from ? { gte: from } : {}), lte: to }
  return db.payment.findMany({
    where: {
      ...base,
      order: {
        ...(base.order as Prisma.OrderWhereInput),
        OR: [
          { completedAt: at },
          { completedAt: null, placedAt: at },
        ],
      },
    },
    select: {
      id: true, amountCents: true, createdAt: true,
      codRiderDebtAt: true, codRiderDebtEntryId: true, codRiderDebtTransferId: true,
      order: { select: { fulfilmentType: true, riderId: true, deliveredAt: true, completedAt: true } },
    },
  })
}

/**
 * Where a COD block sends finance. Reconciliation → Cash on delivery lists
 * (and books) a company's rows only while its code-only delivery switch is on
 * (codRoutes.ts) — the tab is hidden otherwise — so while it is off the link
 * is the till's own pay-in list (Till → Rider cash-on-delivery, GET
 * /pos/cod-due, no switch). Used by this check and the night audit's
 * cod_pending.
 */
export async function codPendingLink(db: CloseCheckDb, tenantId: string): Promise<{ link: string; where: string }> {
  return (await codeOnlyDelivery(db, tenantId))
    ? { link: '/reconciliation?tab=cod', where: 'Take the cash in on the till or settle it on Finance → Reconciliation → Cash on delivery.' }
    : { link: '/pos/shift', where: 'Take the cash in on the till (Till → Rider cash-on-delivery).' }
}

export const codCloseCheck: CloseCheck = {
  key: 'cod_with_rider',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const rows = await codPendingRows(ctx.db, ctx.tenantId, null, ctx.newLock)
    if (rows.length === 0) return null
    // Status at the period end (overdue = past the pay-in time by then).
    const by = new Map<CodStatus, { n: number; cents: number }>()
    let cents = 0
    for (const p of rows) {
      const st = codStatusOf(p, p.order, ctx.newLock)
      const s = by.get(st) ?? { n: 0, cents: 0 }
      s.n++; s.cents += toCents(p.amountCents)
      by.set(st, s)
      cents += toCents(p.amountCents)
    }
    const parts = (['overdue', 'with_rider', 'rider_owes', 'at_counter'] as CodStatus[])
      .filter((k) => by.has(k))
      .map((k) => `${by.get(k)!.n} ${STATUS_WORDS[k]} (${pkr(by.get(k)!.cents)})`)
    const go = await codPendingLink(ctx.db, ctx.tenantId)
    return {
      key: 'cod_with_rider',
      severity: 'block',
      title: 'Cash on delivery still pending',
      detail: `${plural(rows.length, 'cash-on-delivery payment')}, ${pkr(cents)}, on orders completed up to ${fmtPktDate(ctx.newLock)} `
        + `${rows.length === 1 ? 'has' : 'have'} not been paid into a drawer: ${parts.join('; ')}. `
        + `${go.where} `
        + 'Only the CEO can close over this, with a reason.',
      count: rows.length,
      cents,
      link: go.link,
      overridable: true,
    }
  },
}
