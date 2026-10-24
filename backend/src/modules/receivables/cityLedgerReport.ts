// City Ledger reports' figures (owner, 2026-10-24) — read by the till's
// Reports (reports/tillReports.ts: City Ledger Summary / Detail). POS bills
// charged to City Ledger (on-account) clients ONLY: CustomerAccountCharge rows
// (a till bill closed on account), what was paid on them (City Ledger
// settlements, the client's statement payments), refunds and write-offs. No
// other receivable (a back-office invoice, a manual journal) is ever read.
//
// Account figures over [from, to] come from the client's history
// (cityLedger.ts clientHistory — the ONE running balance):
//   opening     = balance of every row before `from`
//   newBills    = bills charged in the window
//   payments    = settlements + statement payments in the window, net of the
//                 reversals in the window
//   adjustments = refunds + approved write-offs in the window
//   closing     = opening + newBills − payments − adjustments
//               = the balance at the end of `to` (tested against exposure
//                 when `to` is today)
//
// Bill figures are AS AT the end of `to`: refunds applied by then, City Ledger
// allocations of settlements received by then and not reversed by then, and —
// for a bill on a statement — the statement's payments, withholding and
// write-offs by then applied to its bills oldest first (a statement is paid as
// a whole, so this is how its money is shown per bill). A bill is listed when
// it was charged in the window or still has something owed / owing back at
// `to`; `ignoreZero` drops bills owing nothing and accounts closing at zero.

import type { CustomerAccount, CustomerAccountCharge } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { toCents } from '../../lib/money.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { karachiDay } from '../../connectors/util.js'
import { ACCOUNT_TYPE_LABEL, billDueDay, clientHistory, type AccountType, type HistoryRow } from './cityLedger.js'

export interface CityLedgerQuery {
  tenantIds: string[]
  /** null = every account of those companies. */
  accountIds: string[] | null
  accountTypes: string[] | null
  q?: string | null
  from: Date
  to: Date
  ignoreZero: boolean
}

export type BillReportStatus = 'Open' | 'Partially settled' | 'Fully settled' | 'Overdue' | 'Cancelled / refunded'

export interface BillReportRow {
  chargeId: string
  orderId: string
  billNo: string
  outlet: string
  terminal: string
  billAt: Date
  guest: string
  originalCents: number
  discountCents: number
  taxCents: number
  netCents: number
  refundedCents: number
  settledCents: number
  outstandingCents: number
  status: BillReportStatus
  dueDate: string
  lastSettlementAt: Date | null
  statementNumber: string | null
}

export interface AccountReport {
  account: Pick<CustomerAccount, 'id' | 'tenantId' | 'number' | 'legalName' | 'accountType' | 'status'>
  accountTypeLabel: string
  creditLimitCents: number
  openingCents: number
  newBillsCents: number
  paymentsCents: number
  adjustmentsCents: number
  closingCents: number
  availableCents: number
  /** History rows inside the window (running balance from the account's first row). */
  rows: HistoryRow[]
  bills: BillReportRow[]
}

const PAYMENT_TYPES = new Set(['settlement', 'settlement_reversed', 'pay_back', 'pay_back_reversed', 'statement_payment', 'statement_payment_reversed'])
const ADJUSTMENT_TYPES = new Set(['refund', 'write_off'])

export async function cityLedgerReport(q: CityLedgerQuery): Promise<AccountReport[]> {
  const search = q.q?.trim()
  const accounts = await prisma.customerAccount.findMany({
    where: {
      tenantId: { in: q.tenantIds },
      status: { not: 'pending' },
      ...(q.accountIds && { id: { in: q.accountIds } }),
      ...(q.accountTypes && { accountType: { in: q.accountTypes } }),
      ...(search && { OR: [{ legalName: { contains: search, mode: 'insensitive' } }, { tradeName: { contains: search, mode: 'insensitive' } }, { number: { contains: search, mode: 'insensitive' } }] }),
    },
    orderBy: { legalName: 'asc' },
  })
  const out: AccountReport[] = []
  for (const a of accounts) {
    const history = await clientHistory(prisma, a)
    let opening = 0
    let newBills = 0
    let payments = 0
    let adjustments = 0
    const rows: HistoryRow[] = []
    for (const r of history) {
      if (r.at < q.from) { opening = r.balanceCents; continue }
      if (r.at > q.to) break
      rows.push(r)
      if (r.type === 'bill') newBills += r.debitCents
      else if (PAYMENT_TYPES.has(r.type)) payments += r.creditCents - r.debitCents
      else if (ADJUSTMENT_TYPES.has(r.type)) adjustments += r.creditCents - r.debitCents
    }
    const closing = opening + newBills - payments - adjustments
    const bills = await billsAsAt(a, q.from, q.to)
    const shownBills = q.ignoreZero ? bills.filter((b) => b.outstandingCents !== 0) : bills
    if (q.ignoreZero && closing === 0 && shownBills.length === 0) continue
    const limit = toCents(a.creditLimitCents)
    out.push({
      account: { id: a.id, tenantId: a.tenantId, number: a.number, legalName: a.legalName, accountType: a.accountType, status: a.status },
      accountTypeLabel: ACCOUNT_TYPE_LABEL[a.accountType as AccountType] ?? a.accountType,
      creditLimitCents: limit,
      openingCents: opening, newBillsCents: newBills, paymentsCents: payments, adjustmentsCents: adjustments, closingCents: closing,
      availableCents: a.status === 'active' ? Math.max(0, limit - Math.max(0, closing)) : 0,
      rows, bills: shownBills,
    })
  }
  return out
}

/** The client's bills as at the end of `to` (see the header). */
async function billsAsAt(a: CustomerAccount, from: Date, to: Date): Promise<BillReportRow[]> {
  const t = a.tenantId
  const charges = await prisma.customerAccountCharge.findMany({ where: { tenantId: t, accountId: a.id, chargedAt: { lte: to } }, orderBy: [{ chargedAt: 'asc' }, { id: 'asc' }] })
  if (charges.length === 0) return []
  const orderIds = charges.map((c) => c.orderId)
  const statementIds = [...new Set(charges.map((c) => c.statementInvoiceId).filter((x): x is string => !!x))]
  const [orders, refundRows, allocations, statements, stPayments, writeOffs] = await Promise.all([
    prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, totalCents: true, discountCents: true, promoDiscountCents: true, taxCents: true, customerName: true, conceptId: true },
    }),
    prisma.payment.findMany({ where: { orderId: { in: orderIds }, status: 'refunded' }, select: { orderId: true, createdAt: true, gatewayMeta: true } }),
    prisma.cityLedgerAllocation.findMany({ where: { tenantId: t, chargeId: { in: charges.map((c) => c.id) } }, include: { settlement: { select: { receivedAt: true, reversedAt: true, direction: true } } } }),
    statementIds.length ? prisma.receivableInvoice.findMany({ where: { id: { in: statementIds }, tenantId: t }, select: { id: true, number: true, dueDate: true } }) : [],
    statementIds.length ? prisma.receivablePayment.findMany({ where: { tenantId: t, invoiceId: { in: statementIds } }, select: { invoiceId: true, amountCents: true, receivedAt: true, reversedAt: true } }) : [],
    statementIds.length ? prisma.receivableWriteOff.findMany({ where: { tenantId: t, invoiceId: { in: statementIds }, status: 'approved' }, select: { invoiceId: true, amountCents: true, recoveredCents: true, decidedAt: true } }) : [],
  ])
  const shiftIds = [...new Set(charges.map((c) => c.shiftId).filter((x): x is string => !!x))]
  const [concepts, shifts] = await Promise.all([
    prisma.concept.findMany({ where: { id: { in: [...new Set(charges.map((c) => c.conceptId))] } }, select: { id: true, name: true } }),
    shiftIds.length ? prisma.shift.findMany({ where: { id: { in: shiftIds } }, select: { id: true, openedAt: true, user: { select: { name: true } } } }) : [],
  ])
  const brandOf = new Map(concepts.map((x) => [x.id, x.name]))
  const drawerOf = new Map(shifts.map((x) => [x.id, x.user.name]))
  const orderOf = new Map(orders.map((o) => [o.id, o]))
  const stOf = new Map(statements.map((s) => [s.id, s]))
  const liveAt = (at: Date, reversedAt: Date | null) => at <= to && (!reversedAt || reversedAt > to)

  // Refunds applied by `to`, per order.
  const refundedAt = new Map<string, number>()
  for (const r of refundRows) {
    const m = (r.gatewayMeta && typeof r.gatewayMeta === 'object' && !Array.isArray(r.gatewayMeta)) ? (r.gatewayMeta as Record<string, unknown>)['onAccountApplied'] as { cents?: number; at?: string } | undefined : undefined
    if (!m?.cents) continue
    if ((m.at ? new Date(m.at) : r.createdAt) <= to) refundedAt.set(r.orderId, (refundedAt.get(r.orderId) ?? 0) + m.cents)
  }
  // Direct (City Ledger) settlement per bill by `to`, and its last date.
  const settledAt = new Map<string, { cents: number; last: Date | null }>()
  for (const al of allocations) {
    if (!liveAt(al.settlement.receivedAt, al.settlement.reversedAt)) continue
    const cur = settledAt.get(al.chargeId) ?? { cents: 0, last: null }
    cur.cents += al.settlement.direction === 'out' ? -al.amountCents : al.amountCents
    if (!cur.last || al.settlement.receivedAt > cur.last) cur.last = al.settlement.receivedAt
    settledAt.set(al.chargeId, cur)
  }
  // Each statement's money by `to` (payments + withholding, net of money handed back; approved write-offs net of recoveries).
  const stPaid = new Map<string, { cents: number; last: Date | null }>()
  for (const p of stPayments) {
    if (!liveAt(p.receivedAt, p.reversedAt)) continue
    const cur = stPaid.get(p.invoiceId) ?? { cents: 0, last: null }
    cur.cents += toCents(p.amountCents)
    if (toCents(p.amountCents) > 0 && (!cur.last || p.receivedAt > cur.last)) cur.last = p.receivedAt
    stPaid.set(p.invoiceId, cur)
  }
  for (const w of writeOffs) {
    if (!w.decidedAt || w.decidedAt > to) continue
    const cur = stPaid.get(w.invoiceId) ?? { cents: 0, last: null }
    // A recovery is also a payment above, so the write-off counts net of it (as the statement's balance does).
    cur.cents += toCents(w.amountCents) - toCents(w.recoveredCents)
    stPaid.set(w.invoiceId, cur)
  }
  // Statement money applied to its bills oldest first.
  const stShare = new Map<string, number>()
  const remaining = new Map([...stPaid].map(([k, v]) => [k, v.cents]))
  const base = (c: CustomerAccountCharge) => c.amountCents - (refundedAt.get(c.orderId) ?? 0) - (settledAt.get(c.id)?.cents ?? 0)
  for (const c of charges) {
    if (!c.statementInvoiceId) continue
    const left = remaining.get(c.statementInvoiceId) ?? 0
    const take = Math.max(0, Math.min(left, base(c)))
    stShare.set(c.id, take)
    remaining.set(c.statementInvoiceId, left - take)
  }

  const toDay = karachiDay(to)
  const rows: BillReportRow[] = []
  for (const c of charges) {
    const o = orderOf.get(c.orderId)
    const refunded = refundedAt.get(c.orderId) ?? 0
    const direct = settledAt.get(c.id)
    const st = c.statementInvoiceId ? stOf.get(c.statementInvoiceId) : undefined
    const share = stShare.get(c.id) ?? 0
    const settled = (direct?.cents ?? 0) + share
    const outstanding = c.amountCents - refunded - settled
    if (c.chargedAt < from && outstanding === 0) continue
    const dueDate = st ? karachiDay(st.dueDate) : billDueDay(c.chargedAt, a.termsDays)
    const lastSt = st && share > 0 ? stPaid.get(st.id)?.last ?? null : null
    const last = [direct?.last ?? null, lastSt].filter((x): x is Date => !!x).sort((x, y) => y.getTime() - x.getTime())[0] ?? null
    const status: BillReportStatus = refunded >= c.amountCents ? 'Cancelled / refunded'
      : outstanding <= 0 ? 'Fully settled'
      : dueDate < toDay ? 'Overdue'
      : settled > 0 ? 'Partially settled' : 'Open'
    const discount = (o?.discountCents ?? 0) + (o?.promoDiscountCents ?? 0)
    const tax = o?.taxCents ?? c.taxCents
    rows.push({
      chargeId: c.id, orderId: c.orderId, billNo: orderRefOf(c.orderId),
      outlet: brandOf.get(c.conceptId) ?? '', terminal: c.shiftId ? drawerOf.get(c.shiftId) ?? '' : '',
      billAt: c.chargedAt, guest: c.reference ?? o?.customerName ?? '',
      originalCents: c.amountCents - tax + discount, discountCents: discount, taxCents: tax, netCents: c.amountCents,
      refundedCents: refunded, settledCents: settled, outstandingCents: outstanding, status, dueDate,
      lastSettlementAt: last, statementNumber: st?.number ?? null,
    })
  }
  return rows
}
