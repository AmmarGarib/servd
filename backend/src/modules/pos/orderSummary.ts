// Order Summary list (owner, 2026-10-22: "This is how order summary should
// look like for settled, Running and Void orders"). One brand, one Karachi
// calendar day: every order with its order no., time, receipt no., table,
// order type, guest, who rang it, waiter, status and amount, plus the count
// per tab. READ ONLY — every action on the screen (recall, reprint receipt /
// KOT, void, split, change owner) calls the module's EXISTING route; nothing
// here moves money.
//
//   status   running  = received | confirmed | preparing | ready
//            settled  = completed
//            voided   = cancelled | rejected | refunded (a credit-noted bill)
//   type     No Charge when a paid comp covers the bill, else the
//            fulfilment type (dine_in | takeout | delivery)
//   receipt  the fiscal number once filed, else the servd tax invoice number
//            (pos/receipt.ts uses the same order: fiscal ?? invoice)
//
// Company separation: the brand must be in the caller's companies (read
// scope); another company's brand is 404.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { OrderStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, CASHIERS } from '../auth/middleware.js'
import { assertConceptOwned } from '../../lib/tenantScope.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { exportFormatOf, sendReportFor } from '../../lib/reportExport.js'

export const SUMMARY_TABS = ['all', 'running', 'settled', 'voided'] as const
export type SummaryTab = (typeof SUMMARY_TABS)[number]
const STATUSES: Record<Exclude<SummaryTab, 'all'>, OrderStatus[]> = {
  running: ['received', 'confirmed', 'preparing', 'ready'],
  settled: ['completed'],
  voided: ['cancelled', 'rejected', 'refunded'],
}
const tabOf = (s: OrderStatus): Exclude<SummaryTab, 'all'> =>
  STATUSES.running.includes(s) ? 'running' : s === 'completed' ? 'settled' : 'voided'

export const SUMMARY_TYPES = ['dine_in', 'takeout', 'delivery', 'no_charge'] as const
export type SummaryType = (typeof SUMMARY_TYPES)[number]
const TYPE_LABEL: Record<SummaryType, string> = { dine_in: 'Dine In', takeout: 'Takeaway', delivery: 'Delivery', no_charge: 'No Charge' }
const STATUS_LABEL: Record<Exclude<SummaryTab, 'all'>, string> = { running: 'Running', settled: 'Settled', voided: 'Voided' }

/** [start, end) of a Karachi calendar day (UTC+5, no DST). */
export function pktDayWindow(day: string): { gte: Date; lt: Date } {
  const start = new Date(`${day}T00:00:00.000+05:00`)
  return { gte: start, lt: new Date(start.getTime() + 86_400_000) }
}
const pktTime = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Karachi' })

export interface SummaryRow {
  id: string
  orderNo: string
  placedAt: string
  time: string
  receiptNo: string | null
  table: string | null
  type: SummaryType
  guest: string | null
  user: string | null
  waiter: string | null
  waiterEmployeeId: string | null
  status: Exclude<SummaryTab, 'all'>
  orderStatus: OrderStatus
  amountCents: number
  compCents: number
  settlementChannel: string | null
}

export async function orderSummary(conceptId: string, day: string): Promise<SummaryRow[]> {
  const orders = await prisma.order.findMany({
    where: { conceptId, deletedAt: null, placedAt: pktDayWindow(day) },
    orderBy: { placedAt: 'desc' },
    take: 2000,
    select: {
      id: true, placedAt: true, status: true, fulfilmentType: true, totalCents: true, customerName: true, settlementChannel: true,
      waiterEmployeeId: true,
      table: { select: { label: true } },
      customer: { select: { name: true } },
      posStaff: { select: { name: true } },
      waiter: { select: { fullName: true } },
      payments: { where: { method: 'comp', status: 'paid' }, select: { amountCents: true } },
      taxInvoices: { where: { type: 'invoice' }, select: { invoiceNumber: true }, take: 1 },
      fiscalDocuments: { where: { kind: 'sale', fiscalNumber: { not: null } }, select: { fiscalNumber: true }, take: 1 },
    },
  })
  return orders.map((o) => {
    const compCents = o.payments.reduce((s, p) => s + p.amountCents, 0)
    const type: SummaryType = compCents > 0 && compCents >= o.totalCents ? 'no_charge' : (o.fulfilmentType as SummaryType)
    return {
      id: o.id,
      orderNo: orderRefOf(o.id),
      placedAt: o.placedAt.toISOString(),
      time: pktTime(o.placedAt),
      receiptNo: o.fiscalDocuments[0]?.fiscalNumber ?? o.taxInvoices[0]?.invoiceNumber ?? null,
      table: o.table?.label ?? null,
      type,
      guest: o.customer?.name ?? o.customerName ?? null,
      user: o.posStaff?.name ?? null,
      waiter: o.waiter?.fullName ?? null,
      waiterEmployeeId: o.waiterEmployeeId,
      status: tabOf(o.status),
      orderStatus: o.status,
      amountCents: o.totalCents,
      compCents,
      settlementChannel: o.settlementChannel,
    }
  })
}

export function filterSummary(rows: SummaryRow[], f: { tab: SummaryTab; type: SummaryType | 'all'; q?: string }) {
  const q = f.q?.trim().toLowerCase()
  const byTypeAndText = rows.filter((r) => (f.type === 'all' || r.type === f.type)
    && (!q || [r.orderNo, r.receiptNo, r.guest, r.table, r.user, r.waiter].some((v) => v?.toLowerCase().includes(q))))
  const counts = { all: byTypeAndText.length, running: 0, settled: 0, voided: 0 }
  for (const r of byTypeAndText) counts[r.status]++
  return { counts, rows: f.tab === 'all' ? byTypeAndText : byTypeAndText.filter((r) => r.status === f.tab) }
}

export async function orderSummaryRoutes(fastify: FastifyInstance) {
  // GET /pos/orders/summary?conceptId&date=YYYY-MM-DD&tab&type&q[&format=pdf|xlsx|csv]
  fastify.get('/orders/summary', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const qs = z.object({
      conceptId: z.string().uuid(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      tab: z.enum(SUMMARY_TABS).default('all'),
      type: z.enum([...SUMMARY_TYPES, 'all'] as const).default('all'),
      q: z.string().max(80).optional(),
      format: z.string().optional(),
    }).parse(req.query)
    const concept = await assertConceptOwned(req, qs.conceptId, 'read')
    const all = await orderSummary(concept.id, qs.date)
    const { counts, rows } = filterSummary(all, qs)
    const format = exportFormatOf(qs.format)
    if (format) {
      const brand = await prisma.concept.findUnique({ where: { id: concept.id }, select: { name: true } })
      return sendReportFor(req, reply, format, { base: 'order-summary', suffix: qs.date }, {
        title: `Order Summary — ${brand?.name ?? ''}`,
        period: qs.date,
        columns: [
          { key: 'orderNo', label: 'Order' }, { key: 'time', label: 'Time' }, { key: 'receiptNo', label: 'Receipt No' },
          { key: 'table', label: 'R/T No' }, { key: 'type', label: 'Order Type' }, { key: 'guest', label: 'Guest Name' },
          { key: 'user', label: 'User' }, { key: 'status', label: 'Status' }, { key: 'amountCents', label: 'Amount', type: 'cents' },
        ],
        rows: rows.map((r) => ({
          orderNo: r.orderNo, time: r.time, receiptNo: r.receiptNo ?? '', table: r.table ?? '', type: TYPE_LABEL[r.type],
          guest: r.guest ?? '', user: r.user ?? '', status: STATUS_LABEL[r.status], amountCents: r.type === 'no_charge' ? r.compCents : r.amountCents,
        })),
      })
    }
    return { date: qs.date, counts, rows }
  })
}

