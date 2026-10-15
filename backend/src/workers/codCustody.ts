// COD custody — the every-30-minutes flags (H5, Delivery & customers).
//
// Only for companies whose code-only delivery switch is ON
// (lib/deliveryRules.ts — a `delivery.codeOnlyAt:<tenantId>` Setting row);
// a company with the switch off sees no change. Per switched-on company, on
// serviceClient:
//
//   cod_cash_overdue         one flag per delivered cash-on-delivery payment
//                            a rider carried that is COD_PAY_IN_HOURS past its
//                            drop-off (lib/cod.ts codStatusOf → 'overdue') and
//                            not booked to the rider (codRiderDebtAt null).
//                            Severity medium, amount = the payment.
//   delivery_on_road_overdue one flag per delivery picked up more than
//                            ON_ROAD_OVERDUE_HOURS ago and neither delivered,
//                            returned nor cancelled.
//
// Pickup / at-counter cash is NEVER flagged (codStatusOf 'at_counter'). Each
// payment / order is flagged ONCE: a flag of that kind on that entity in ANY
// status (open, acknowledged or resolved) stops another — a person who
// resolved it is not paged again every 30 minutes. Each company's pass holds
// a transaction-scoped advisory lock, so two API processes never flag the
// same row twice (the flags are written on their own connection and are
// committed before the lock is released). Nothing posts from here.

import { serviceClient as prisma } from '../lib/prisma.js'
import { flagException } from '../lib/exceptions.js'
import { DELIVERY_CODE_ONLY_SETTING } from '../lib/deliveryRules.js'
import { COD_PAY_IN_HOURS, codDueWhere, codStatusOf, codHoursSince } from '../lib/cod.js'
import { orderRefOf } from '../lib/orderRef.js'
import type { Prisma } from '@prisma/client'

export const COD_CUSTODY_INTERVAL_MS = 30 * 60_000
const FIRST_TICK_MS = 90_000
/** A delivery out with the rider longer than this is flagged. */
export const ON_ROAD_OVERDUE_HOURS = 3

let running = false
let timer: NodeJS.Timeout | null = null

/** The companies whose code-only delivery switch is on. */
export async function codeOnlyCompanyIds(): Promise<string[]> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: `${DELIVERY_CODE_ONLY_SETTING}:` } },
    select: { key: true },
  })
  const ids = rows.map((r) => r.key.slice(DELIVERY_CODE_ONLY_SETTING.length + 1)).filter((id) => id.length > 0)
  if (ids.length === 0) return []
  // Only live companies.
  const live = await prisma.tenant.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } })
  return live.map((t) => t.id)
}

const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`

/** Entity ids of `kind` that already carry a flag in this company (any status). */
async function alreadyFlagged(tenantId: string, kind: string, entityType: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await prisma.exceptionFlag.findMany({
    where: { tenantId, kind, entityType, entityId: { in: ids } },
    select: { entityId: true },
  })
  return new Set(rows.map((r) => r.entityId!).filter(Boolean))
}

async function runCompany(tenantId: string, now: Date): Promise<{ codOverdue: number; onRoad: number }> {
  let codOverdue = 0
  let onRoad = 0

  // ── Overdue COD cash (rider carried it, not paid in, not booked to the rider) ──
  const cutoff = new Date(now.getTime() - COD_PAY_IN_HOURS * 3_600_000)
  const base = codDueWhere({ tenantId })
  const due = await prisma.payment.findMany({
    where: {
      ...base,
      codRiderDebtAt: null,
      order: {
        ...(base.order as Prisma.OrderWhereInput),
        fulfilmentType: 'delivery',
        riderId: { not: null },
        // Narrow in SQL; codStatusOf below is the rule.
        OR: [
          { deliveredAt: { lte: cutoff } },
          { deliveredAt: null, completedAt: { lte: cutoff } },
          { deliveredAt: null, completedAt: null },
        ],
      },
    },
    select: {
      id: true, amountCents: true, createdAt: true, codRiderDebtAt: true,
      order: {
        select: {
          id: true, conceptId: true, fulfilmentType: true, riderId: true, deliveredAt: true, completedAt: true,
          concept: { select: { tenantId: true } },
          rider: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 1000,
  })
  const overdue = due.filter((p) => p.order.concept.tenantId === tenantId && codStatusOf(p, p.order, now) === 'overdue')
  const seenPay = await alreadyFlagged(tenantId, 'cod_cash_overdue', 'Payment', overdue.map((p) => p.id))
  for (const p of overdue) {
    if (seenPay.has(p.id)) continue
    const hours = codHoursSince(p, p.order, now)
    const rider = p.order.rider?.name ?? 'the rider'
    const r = await flagException({
      tenantId,
      conceptId: p.order.conceptId,
      kind: 'cod_cash_overdue',
      severity: 'medium',
      title: `Cash on delivery not paid in: order ${orderRefOf(p.order.id)} (${rider})`.slice(0, 200),
      description: `${rider} delivered order ${orderRefOf(p.order.id)} ${hours} h ago and the ${pkr(p.amountCents)} cash `
        + `has not been paid into a drawer (limit ${COD_PAY_IN_HOURS} h). Take it in on the till (Rider cash), `
        + 'or book it as owed by the rider on Finance → Reconciliation → Cash on delivery.',
      entityType: 'Payment',
      entityId: p.id,
      amountCents: p.amountCents,
      metadata: { orderId: p.order.id, riderId: p.order.riderId, hoursSince: hours, payInHours: COD_PAY_IN_HOURS },
    })
    if (r) codOverdue++
  }

  // ── Deliveries on the road too long ──
  const roadCutoff = new Date(now.getTime() - ON_ROAD_OVERDUE_HOURS * 3_600_000)
  const onRoadRows = await prisma.order.findMany({
    where: {
      concept: { tenantId },
      fulfilmentType: 'delivery',
      pickedUpAt: { lte: roadCutoff },
      deliveredAt: null,
      returnedAt: null,
      status: { notIn: ['completed', 'cancelled', 'rejected', 'refunded'] },
    },
    select: { id: true, conceptId: true, riderId: true, pickedUpAt: true, totalCents: true, rider: { select: { name: true } } },
    orderBy: { pickedUpAt: 'asc' },
    take: 500,
  })
  const seenOrder = await alreadyFlagged(tenantId, 'delivery_on_road_overdue', 'Order', onRoadRows.map((o) => o.id))
  for (const o of onRoadRows) {
    if (seenOrder.has(o.id)) continue
    const hours = Math.floor(((now.getTime() - o.pickedUpAt!.getTime()) / 3_600_000) * 10) / 10
    const rider = o.rider?.name ?? 'the rider'
    const r = await flagException({
      tenantId,
      conceptId: o.conceptId,
      kind: 'delivery_on_road_overdue',
      severity: 'medium',
      title: `Delivery ${orderRefOf(o.id)} on the road ${hours} h (${rider})`.slice(0, 200),
      description: `${rider} picked up order ${orderRefOf(o.id)} ${hours} h ago and it is neither delivered nor returned. `
        + 'Call the rider and the customer; use Emergency overrides if the food came back.',
      entityType: 'Order',
      entityId: o.id,
      metadata: { orderId: o.id, riderId: o.riderId, pickedUpAt: o.pickedUpAt!.toISOString(), hoursOnRoad: hours, totalCents: o.totalCents },
    })
    if (r) onRoad++
  }
  return { codOverdue, onRoad }
}

/**
 * One pass over every switched-on company. Returns the flags raised. `now`
 * is injectable for tests.
 */
export async function runCodCustodyOnce(now: Date = new Date()): Promise<{ companies: number; codOverdue: number; onRoad: number }> {
  if (running) return { companies: 0, codOverdue: 0, onRoad: 0 }
  running = true
  const out = { companies: 0, codOverdue: 0, onRoad: 0 }
  try {
    const companies = await codeOnlyCompanyIds()
    for (const tenantId of companies) {
      try {
        // One pass per company at a time across processes (see the header).
        const r = await prisma.$transaction(async (tx) => {
          const got = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${`codCustody:${tenantId}`})) AS ok`
          if (!got[0]?.ok) return null
          return runCompany(tenantId, now)
        }, { timeout: 120_000, maxWait: 10_000 })
        if (!r) continue
        out.companies++
        out.codOverdue += r.codOverdue
        out.onRoad += r.onRoad
      } catch (err) {
        console.error(`[codCustody] company ${tenantId} failed:`, (err as Error).message)
      }
    }
    if (out.codOverdue || out.onRoad) {
      console.info(`[codCustody] ${out.codOverdue} overdue COD / ${out.onRoad} on-road flag(s) raised`)
    }
    return out
  } finally {
    running = false
  }
}

/** Every 30 minutes (setInterval, unref), first tick after 90 s. Never posts. */
export function startCodCustodyWorker(): { stop: () => void } {
  if (!timer) {
    const tick = () => { runCodCustodyOnce().catch((err) => console.error('[codCustody] failed:', (err as Error).message)) }
    const first = setTimeout(tick, FIRST_TICK_MS)
    first.unref()
    timer = setInterval(tick, COD_CUSTODY_INTERVAL_MS)
    timer.unref()
    console.info('[codCustody] worker started — every 30 min (overdue COD cash and on-road deliveries, code-only companies only)')
  }
  return {
    stop: () => { if (timer) { clearInterval(timer); timer = null } },
  }
}
