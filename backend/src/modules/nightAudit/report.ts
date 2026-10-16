// The daily audit report — one SALES day of one company (owner, 2026-10-16:
// night run = "Lock day + report"). Snapshotted on the NightAuditDay row at
// the run; `closing` is added when the day closes. Stored order figures only
// (never concept.taxRate). Sales-only by construction: purchases, petty cash,
// payroll and the rest of the books are not in it. Shape: ./README.md §6.

import type { Prisma, PrismaClient } from '@prisma/client'
import { parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import { shiftOfCompany } from '../../lib/tenantScope.js'
import { closedShiftsOfBusinessDays } from '../../lib/businessDay.js'
import { toCents } from '../../lib/money.js'
import { drawerExpectation } from '../../lib/drawer.js'
import { cardDayGrossTx, cardSettlementSettings, dayNum } from '../reconciliation/cardPayouts.js'
import type { CloseProblem } from './types.js'

type Db = PrismaClient | Prisma.TransactionClient

export interface DailyReport {
  version: 1
  tenantId: string
  companyName: string
  day: string
  generatedAt: string
  generatedById: string | null
  sales: {
    orders: number; grossCents: number; discountCents: number; netSalesCents: number; taxCents: number
    serviceChargeCents: number; deliveryFeeCents: number; tipCents: number; totalCents: number
    byBrand: Array<{ conceptId: string; name: string; orders: number; netSalesCents: number; taxCents: number; totalCents: number }>
    byChannel: Array<{ source: string; orders: number; totalCents: number }>
    byFulfilment: Array<{ type: string; orders: number; totalCents: number }>
  }
  tenders: Array<{ method: string; count: number; paidCents: number; refundedCents: number; pendingCents: number }>
  cash: {
    shifts: Array<{
      shiftId: string; cashier: string; location: string | null; openedAt: string; closedAt: string | null
      openingFloatCents: number; expectedCents: number; countedCents: number | null; varianceCents: number | null
      depositDropCents: number; varianceFlag: 'open' | 'acknowledged' | 'resolved' | null
    }>
    payoutsCents: number; dropsCents: number; totalVarianceCents: number
  }
  voids: {
    itemVoids: number; itemVoidCents: number; orderCancels: number; orderCancelCents: number; comps: number; compCents: number
    byApprover: Array<{ userId: string; name: string; count: number; cents: number }>
  }
  discounts: { totalCents: number; promoCents: number; manualCents: number; loyaltyRedeemedCents: number; byReason: Array<{ reason: string; cents: number }> }
  refunds: { count: number; cents: number; byMethod: Array<{ method: string; cents: number }> }
  preBills: { printed: number; orphaned: number; finalLower: number }
  cod: { delivered: number; collectedCents: number; pendingCents: number }
  raast: { byStatus: Array<{ status: string; count: number; cents: number }> }
  card: { grossCents: number; byUnit: Array<{ unit: string; cents: number; settled: boolean }> }
  exceptions: Array<{ kind: string; count: number; cents: number }>
  checks: { night: CloseProblem[]; settlement: CloseProblem[] }
  closing?: { at: string; card: { settledCents: number; feeCents: number }; bank: { unmatchedLines: number }; raast: { matched: number; open: number } }
  previousRuns?: unknown[]
}

function bump<K>(m: Map<K, { count: number; cents: number }>, k: K, cents: number) {
  const v = m.get(k) ?? { count: 0, cents: 0 }
  v.count += 1
  v.cents += cents
  m.set(k, v)
}

/** Build the report of `day` for `tenantId` (read only). */
export async function buildDailyReport(db: Db, tenantId: string, day: string, opts: {
  generatedById?: string | null
  checks?: { night?: CloseProblem[]; settlement?: CloseProblem[] }
} = {}): Promise<DailyReport> {
  const from = parsePktStartOfDay(day)
  const to = parsePktEndOfDay(day)
  const at = { gte: from, lte: to }
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })

  // ── Sales: orders completed (or refunded) on the day ──
  const orders = await db.order.findMany({
    where: { concept: { tenantId }, deletedAt: null, status: { in: ['completed', 'refunded'] }, completedAt: at },
    select: {
      id: true, conceptId: true, source: true, fulfilmentType: true, totalCents: true, discountCents: true, promoDiscountCents: true,
      taxCents: true, serviceChargeCents: true, tipCents: true, deliveryFeeCents: true,
      concept: { select: { name: true } },
    },
  })
  const brand = new Map<string, { conceptId: string; name: string; orders: number; netSalesCents: number; taxCents: number; totalCents: number }>()
  const channel = new Map<string, { count: number; cents: number }>()
  const fulfil = new Map<string, { count: number; cents: number }>()
  let gross = 0, disc = 0, promo = 0, net = 0, tax = 0, svc = 0, fee = 0, tip = 0, total = 0
  for (const o of orders) {
    const n = o.totalCents - o.taxCents - o.serviceChargeCents - o.tipCents - o.deliveryFeeCents
    net += n; tax += o.taxCents; svc += o.serviceChargeCents; tip += o.tipCents; fee += o.deliveryFeeCents; total += o.totalCents
    disc += o.discountCents; promo += o.promoDiscountCents; gross += n + o.discountCents
    const b = brand.get(o.conceptId) ?? { conceptId: o.conceptId, name: o.concept.name, orders: 0, netSalesCents: 0, taxCents: 0, totalCents: 0 }
    b.orders += 1; b.netSalesCents += n; b.taxCents += o.taxCents; b.totalCents += o.totalCents
    brand.set(o.conceptId, b)
    bump(channel, o.source, o.totalCents)
    bump(fulfil, o.fulfilmentType, o.totalCents)
  }

  // ── Tenders: payment rows of the day (processed, else created) ──
  const payments = await db.payment.findMany({
    where: { order: { concept: { tenantId } }, OR: [{ processedAt: at }, { processedAt: null, createdAt: at }] },
    select: { method: true, status: true, amountCents: true, order: { select: { source: true, status: true } } },
  })
  const tenders = new Map<string, { method: string; count: number; paidCents: number; refundedCents: number; pendingCents: number }>()
  const refundsBy = new Map<string, { count: number; cents: number }>()
  let comps = 0, compCents = 0
  for (const p of payments) {
    const t = tenders.get(p.method) ?? { method: p.method, count: 0, paidCents: 0, refundedCents: 0, pendingCents: 0 }
    t.count += 1
    if (p.status === 'paid' && p.amountCents > 0) t.paidCents += p.amountCents
    else if (p.status === 'refunded' && p.amountCents < 0) { t.refundedCents += -p.amountCents; bump(refundsBy, p.method, -p.amountCents) }
    else if (p.status === 'pending') t.pendingCents += p.amountCents
    tenders.set(p.method, t)
    if (p.method === 'comp' && p.status === 'paid') { comps += 1; compCents += p.amountCents }
  }

  // ── Cash: tills closed on the day — by BUSINESS day, so a till closing
  // before 05:00 PKT is on the day it opened (lib/businessDay.ts) — or opened
  // on the day and still open ──
  const closedIds = (await closedShiftsOfBusinessDays(db, tenantId, from, to)).map((s) => s.id)
  const shifts = await db.shift.findMany({
    where: { AND: [shiftOfCompany({ tenantId: { in: [tenantId] } }), { OR: [{ id: { in: closedIds } }, { closedAt: null, openedAt: at }] }] },
    select: {
      id: true, openedAt: true, closedAt: true, openingFloatCents: true, closingFloatCents: true,
      user: { select: { name: true } }, location: { select: { name: true } },
      cashMovements: { select: { type: true, amountCents: true } },
    },
    orderBy: { openedAt: 'asc' },
  })
  const shiftIds = shifts.map((s) => s.id)
  // Each drop's share per shift (one bag may cover several tills).
  const { bankedByShift } = await import('../accounting/depositPosting.js')
  const banked = await bankedByShift(db, tenantId, shiftIds)
  const varFlags = shiftIds.length ? await db.exceptionFlag.findMany({
    where: { tenantId, kind: 'cash_variance', entityType: 'Shift', entityId: { in: shiftIds } },
    select: { entityId: true, status: true },
  }) : []
  let payouts = 0, cashDrops = 0, totalVar = 0
  const cashShifts: DailyReport['cash']['shifts'] = []
  for (const s of shifts) {
    const exp = await drawerExpectation(s.id).catch(() => null)
    const expected = exp?.expectedCents ?? 0
    const counted = s.closingFloatCents ?? null
    const variance = counted == null ? null : counted - expected
    if (variance) totalVar += variance
    for (const m of s.cashMovements) {
      if (m.type === 'payout') payouts += m.amountCents
      if (m.type === 'drop') cashDrops += m.amountCents
    }
    const flag = varFlags.find((f) => f.entityId === s.id)
    cashShifts.push({
      shiftId: s.id, cashier: s.user.name, location: s.location?.name ?? null,
      openedAt: s.openedAt.toISOString(), closedAt: s.closedAt?.toISOString() ?? null,
      openingFloatCents: s.openingFloatCents, expectedCents: expected, countedCents: counted, varianceCents: variance,
      depositDropCents: banked.get(s.id) ?? 0,
      varianceFlag: (flag?.status as 'open' | 'acknowledged' | 'resolved' | undefined) ?? null,
    })
  }

  // ── Voids, cancels ──
  const voided = await db.orderItem.findMany({
    where: { voidedAt: at, order: { concept: { tenantId } } },
    select: { quantity: true, unitPriceCents: true },
  })
  const cancelled = await db.order.findMany({
    where: { concept: { tenantId }, status: { in: ['cancelled', 'rejected'] }, cancelledAt: at },
    select: { totalCents: true },
  })
  const voidAudits = await db.auditLog.findMany({
    where: { tenantId, action: { in: ['order_item_void', 'order.cancel', 'order.reject'] }, createdAt: at },
    select: { metadata: true },
  })
  const approvers = new Map<string, { count: number; cents: number }>()
  for (const a of voidAudits) {
    const m = (a.metadata ?? {}) as Record<string, unknown>
    const id = typeof m['approverId'] === 'string' ? m['approverId'] : null
    const cents = typeof m['amountCents'] === 'number' ? m['amountCents'] : typeof m['lineCents'] === 'number' ? m['lineCents'] : 0
    if (id) bump(approvers, id, cents)
  }
  const approverNames = approvers.size ? new Map((await db.user.findMany({ where: { id: { in: [...approvers.keys()] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name])) : new Map<string, string>()

  // ── Pre-bills ──
  const preBills = await db.preBill.findMany({
    where: { tenantId, printedAt: at },
    select: { status: true, totalCents: true, finalTotalCents: true, order: { select: { status: true } } },
  })

  // ── COD (non-till cash on orders completed on the day) ──
  const cod = await db.payment.findMany({
    where: { method: 'cash', amountCents: { gt: 0 }, order: { concept: { tenantId }, source: { not: 'pos' }, status: 'completed', completedAt: at } },
    select: { status: true, amountCents: true, orderId: true },
  })

  // ── Raast receipts of the day ──
  const raast = await db.raastReceipt.groupBy({
    by: ['status'],
    where: { tenantId, OR: [{ confirmedAt: at }, { confirmedAt: null, createdAt: at }] },
    _count: { _all: true },
    _sum: { amountCents: true },
  })

  // ── Card money of the day by payout unit ──
  const s = await cardSettlementSettings(db, tenantId)
  const n = dayNum(day)
  const grossCard = await cardDayGrossTx(db, tenantId, { ...s, startDay: day }, n, n)
  const settledUnits = new Set((await db.cardSettlementDay.findMany({ where: { tenantId, day }, select: { unit: true } })).map((r) => r.unit))
  const byUnit = [...grossCard.entries()].map(([unit, m]) => ({ unit, cents: m.get(n) ?? 0, settled: settledUnits.has(unit) })).filter((u) => u.cents !== 0)

  // ── Exceptions raised on the day (incl. the CEO's back-dated changes) ──
  const flags = await db.exceptionFlag.groupBy({
    by: ['kind'],
    where: { tenantId, createdAt: at },
    _count: { _all: true },
    _sum: { amountCents: true },
  })

  const sortDesc = <T extends { cents: number }>(a: T[]) => a.sort((x, y) => y.cents - x.cents)
  return {
    version: 1,
    tenantId,
    companyName: tenant?.name ?? '',
    day,
    generatedAt: new Date().toISOString(),
    generatedById: opts.generatedById ?? null,
    sales: {
      orders: orders.length, grossCents: gross, discountCents: disc, netSalesCents: net, taxCents: tax,
      serviceChargeCents: svc, deliveryFeeCents: fee, tipCents: tip, totalCents: total,
      byBrand: [...brand.values()].sort((a, b) => b.totalCents - a.totalCents),
      byChannel: [...channel.entries()].map(([source, v]) => ({ source, orders: v.count, totalCents: v.cents })),
      byFulfilment: [...fulfil.entries()].map(([type, v]) => ({ type, orders: v.count, totalCents: v.cents })),
    },
    tenders: [...tenders.values()],
    cash: { shifts: cashShifts, payoutsCents: payouts, dropsCents: cashDrops, totalVarianceCents: totalVar },
    voids: {
      itemVoids: voided.length, itemVoidCents: voided.reduce((t, i) => t + i.quantity * i.unitPriceCents, 0),
      orderCancels: cancelled.length, orderCancelCents: cancelled.reduce((t, o) => t + o.totalCents, 0),
      comps, compCents,
      byApprover: [...approvers.entries()].map(([userId, v]) => ({ userId, name: approverNames.get(userId) ?? '', count: v.count, cents: v.cents })),
    },
    discounts: { totalCents: disc, promoCents: promo, manualCents: Math.max(0, disc - promo), loyaltyRedeemedCents: 0, byReason: [] },
    refunds: {
      count: [...refundsBy.values()].reduce((t, v) => t + v.count, 0),
      cents: [...refundsBy.values()].reduce((t, v) => t + v.cents, 0),
      byMethod: sortDesc([...refundsBy.entries()].map(([method, v]) => ({ method, cents: v.cents }))),
    },
    preBills: {
      printed: preBills.length,
      orphaned: preBills.filter((p) => p.order && (p.order.status === 'cancelled' || p.order.status === 'rejected')).length,
      finalLower: preBills.filter((p) => p.finalTotalCents != null && p.finalTotalCents < p.totalCents).length,
    },
    cod: {
      delivered: new Set(cod.map((p) => p.orderId)).size,
      collectedCents: cod.filter((p) => p.status === 'paid').reduce((t, p) => t + p.amountCents, 0),
      pendingCents: cod.filter((p) => p.status === 'pending').reduce((t, p) => t + p.amountCents, 0),
    },
    raast: { byStatus: raast.map((r) => ({ status: r.status, count: r._count._all, cents: r._sum.amountCents ?? 0 })) },
    card: { grossCents: byUnit.reduce((t, u) => t + u.cents, 0), byUnit },
    exceptions: flags.map((f) => ({ kind: f.kind, count: f._count._all, cents: Math.abs(toCents(f._sum.amountCents ?? 0)) })),
    checks: { night: opts.checks?.night ?? [], settlement: opts.checks?.settlement ?? [] },
  }
}
