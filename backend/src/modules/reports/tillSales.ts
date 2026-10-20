// The till's Sales report (owner, 2026-10-20: "Add option in the POS for Sale
// report … categorize the report by Menu item sales, Payment method,
// Discounted sales, No charge sales, Keenu sales or any other filter").
//
// GET /reports/till-sales?view=…&dateFrom&dateTo&conceptId[&format=csv|xlsx|pdf]
// One table per view, built on THE sales engine (reports/service.ts — the
// same figures as Reports): headline `salesTotals`, items `topItems`, payment
// method `salesByTender`, Keenu / servd `salesBySettlement`; the order lists
// (discounted, No Charge) and the waiter / order-type splits read the same
// sold orders (`soldOrderWhere`). Company scope and the brand id come from the
// route's salesQuery (foreign brand 404). Money only to FINANCIALS_VIEWERS;
// the other report readers get counts.

import { prisma } from '../../lib/prisma.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { salesTotals, salesBySettlement, salesByTender, topItems, soldOrderWhere, type SalesQuery } from './service.js'

export const TILL_SALES_VIEWS = ['items', 'tenders', 'settlement', 'discounts', 'no_charge', 'waiters', 'order_type'] as const
export type TillSalesView = (typeof TILL_SALES_VIEWS)[number]

export interface TillSalesColumn { key: string; label: string; type?: 'pkr' | 'number' | 'text' }
export interface TillSales {
  view: TillSalesView
  title: string
  summary: { orders: number; gross: number | null; discount: number | null; comps: number | null; tax: number | null; net: number | null }
  columns: TillSalesColumn[]
  rows: Array<Record<string, string | number | null>>
  totals: Record<string, string | number | null> | null
  note: string | null
}

const TITLES: Record<TillSalesView, string> = {
  items: 'Sales by menu item', tenders: 'Sales by payment method', settlement: 'Sales by settlement (Keenu / servd)',
  discounts: 'Discounted sales', no_charge: 'No Charge sales', waiters: 'Sales by waiter', order_type: 'Sales by order type',
}
const SETTLEMENT_LABEL: Record<string, string> = { keenu: 'Pushed to Keenu', servd: 'Closed in servd', none: 'Online / other' }
const FULFILMENT_LABEL: Record<string, string> = { dine_in: 'Dine in', takeout: 'Takeaway', delivery: 'Delivery' }

const pktTime = (d: Date | null) => d ? new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : ''
const sum = (rows: Array<Record<string, string | number | null>>, k: string) => rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0)

export async function tillSales(q: SalesQuery, view: TillSalesView, money: boolean): Promise<TillSales> {
  const t = await salesTotals(q)
  const summary = money
    ? { orders: t.orders, gross: t.gross, discount: t.discount, comps: t.comps, tax: t.tax, net: t.net }
    : { orders: t.orders, gross: null, discount: null, comps: null, tax: null, net: null }
  const out = (columns: TillSalesColumn[], rows: TillSales['rows'], totals: TillSales['totals'], note: string | null = null): TillSales => {
    const cols = money ? columns : columns.filter((c) => c.type !== 'pkr')
    const strip = (r: Record<string, string | number | null>) => money ? r : Object.fromEntries(Object.entries(r).filter(([k]) => cols.some((c) => c.key === k)))
    return { view, title: TITLES[view], summary, columns: cols, rows: rows.map(strip), totals: totals ? strip(totals) : null, note }
  }

  switch (view) {
    case 'items': {
      const items = await topItems(q, 2000)
      const rows = items.map((i) => ({ item: i.name, quantity: i.quantity, salesCents: i.revenueCents }))
      return out(
        [{ key: 'item', label: 'Menu item' }, { key: 'quantity', label: 'Qty', type: 'number' }, { key: 'salesCents', label: 'Sales (menu price)', type: 'pkr' }],
        rows, { item: 'TOTAL', quantity: sum(rows, 'quantity'), salesCents: sum(rows, 'salesCents') },
        'Menu price × quantity, before discounts and GST; voided lines are left out.')
    }
    case 'tenders': {
      const r = await salesByTender(q)
      const rows: TillSales['rows'] = r.tenders.map((x) => ({ method: x.label, orders: x.orders, payments: x.payments, amountCents: x.amountCents }))
      if (r.comp.orders > 0) rows.push({ method: 'No Charge (comp)', orders: r.comp.orders, payments: null, amountCents: r.comp.amountCents })
      return out(
        [{ key: 'method', label: 'Payment method' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'payments', label: 'Payments', type: 'number' }, { key: 'amountCents', label: 'Amount', type: 'pkr' }],
        rows, { method: 'TOTAL (money tenders)', orders: null, payments: null, amountCents: r.totalCents })
    }
    case 'settlement': {
      const r = await salesBySettlement({ ...q, settlement: 'all' })
      const rows = r.rows.map((x) => ({ settlement: SETTLEMENT_LABEL[x.settlement] ?? x.settlement, orders: x.orders, grossCents: x.gross, taxCents: x.tax, netCents: x.net }))
      return out(
        [{ key: 'settlement', label: 'Closed by' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'grossCents', label: 'Sales incl. GST', type: 'pkr' }, { key: 'taxCents', label: 'GST', type: 'pkr' }, { key: 'netCents', label: 'Net ex-GST', type: 'pkr' }],
        rows, { settlement: 'TOTAL', orders: r.combined.orders, grossCents: r.combined.gross, taxCents: r.combined.tax, netCents: r.combined.net })
    }
    case 'discounts': {
      const orders = await prisma.order.findMany({
        where: { AND: [soldOrderWhere(q), { discountCents: { gt: 0 } }] },
        select: { id: true, completedAt: true, placedAt: true, totalCents: true, discountCents: true, table: { select: { label: true } }, waiter: { select: { fullName: true } } },
        orderBy: { completedAt: 'asc' }, take: 2000,
      })
      const rows = orders.map((o) => ({
        time: pktTime(o.completedAt ?? o.placedAt), order: orderRefOf(o.id), table: o.table?.label ?? '', waiter: o.waiter?.fullName ?? '',
        discountCents: o.discountCents, billCents: o.totalCents,
      }))
      return out(
        [{ key: 'time', label: 'Time' }, { key: 'order', label: 'Order' }, { key: 'table', label: 'Table' }, { key: 'waiter', label: 'Waiter' }, { key: 'discountCents', label: 'Discount', type: 'pkr' }, { key: 'billCents', label: 'Bill', type: 'pkr' }],
        rows, { time: 'TOTAL', order: `${rows.length} orders`, table: null, waiter: null, discountCents: sum(rows, 'discountCents'), billCents: sum(rows, 'billCents') })
    }
    case 'no_charge': {
      const pays = await prisma.payment.findMany({
        where: { method: 'comp', status: 'paid', order: soldOrderWhere(q) },
        select: { amountCents: true, gatewayMeta: true, processedAt: true, order: { select: { id: true, table: { select: { label: true } } } } },
        orderBy: { processedAt: 'asc' }, take: 2000,
      })
      const approverIds = [...new Set(pays.map((p) => ((p.gatewayMeta as { comp?: { approverId?: string } } | null)?.comp?.approverId)).filter((x): x is string => !!x))]
      const names = new Map((await prisma.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
      const rows = pays.map((p) => {
        const c = (p.gatewayMeta as { comp?: { kind?: string; reason?: string; approverId?: string } } | null)?.comp ?? {}
        return {
          time: pktTime(p.processedAt), order: orderRefOf(p.order.id), table: p.order.table?.label ?? '',
          kind: c.kind === 'staff_meal' ? 'Staff meal' : 'No Charge', reason: c.reason ?? '', approvedBy: c.approverId ? (names.get(c.approverId) ?? '') : '',
          amountCents: p.amountCents,
        }
      })
      return out(
        [{ key: 'time', label: 'Time' }, { key: 'order', label: 'Order' }, { key: 'table', label: 'Table' }, { key: 'kind', label: 'Kind' }, { key: 'reason', label: 'Reason' }, { key: 'approvedBy', label: 'Approved by' }, { key: 'amountCents', label: 'Value', type: 'pkr' }],
        rows, { time: 'TOTAL', order: `${rows.length}`, table: null, kind: null, reason: null, approvedBy: null, amountCents: sum(rows, 'amountCents') })
    }
    case 'waiters':
    case 'order_type': {
      type Group = { key: string | null; orders: number; totalCents: number; discountCents: number }
      let groups: Group[]
      let label: (k: string | null) => string
      if (view === 'waiters') {
        const g = await prisma.order.groupBy({ by: ['waiterEmployeeId'], where: soldOrderWhere(q), _count: { _all: true }, _sum: { totalCents: true, discountCents: true } })
        groups = g.map((x) => ({ key: x.waiterEmployeeId, orders: x._count._all, totalCents: x._sum.totalCents ?? 0, discountCents: x._sum.discountCents ?? 0 }))
        const ids = groups.map((x) => x.key).filter((x): x is string => !!x)
        const emps = new Map((await prisma.hrEmployee.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, employeeCode: true } })).map((e) => [e.id, `${e.fullName} (${e.employeeCode})`]))
        label = (k) => (k ? emps.get(k) ?? 'Unknown' : 'No waiter')
      } else {
        const g = await prisma.order.groupBy({ by: ['fulfilmentType'], where: soldOrderWhere(q), _count: { _all: true }, _sum: { totalCents: true, discountCents: true } })
        groups = g.map((x) => ({ key: x.fulfilmentType, orders: x._count._all, totalCents: x._sum.totalCents ?? 0, discountCents: x._sum.discountCents ?? 0 }))
        label = (k) => (k ? FULFILMENT_LABEL[k] ?? k : '—')
      }
      const rows = groups.map((g) => ({ group: label(g.key), orders: g.orders, discountCents: g.discountCents, salesCents: g.totalCents }))
        .sort((a, b) => b.salesCents - a.salesCents)
      return out(
        [{ key: 'group', label: view === 'waiters' ? 'Waiter' : 'Order type' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'discountCents', label: 'Discounts', type: 'pkr' }, { key: 'salesCents', label: 'Bills (incl. GST)', type: 'pkr' }],
        rows, { group: 'TOTAL', orders: sum(rows, 'orders'), discountCents: sum(rows, 'discountCents'), salesCents: sum(rows, 'salesCents') },
        'Bills as charged, before any later refund.')
    }
  }
}
