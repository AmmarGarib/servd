// The till's Reports (owner, 2026-10-22) — contract: ./TILL_REPORTS.md.
//
// ONE engine: every sales figure reads THE sales definition in ./service.ts —
// the sold orders (`soldOrderWhere`, the till's filters ANDed in through
// `SalesQuery.extra`), the per-user headline figures from `salesTotals`, the
// refunds the way `salesByTender` reads them. Nothing here defines "a sale"
// again, and nothing here writes: it is read only.
//
// Company separation: the route resolves every conceptId with
// assertConceptOwned(req, id, 'read') before anything reaches this file, and
// passes the read scope (`company`) in the SalesQuery, so every order / payment
// query below is inside the caller's companies. Stock and on-account reads take
// the companies OF THOSE BRANDS (`tenantIds`), never a client id.
//
// Money cells are null for callers outside FINANCIALS_VIEWERS (the same rule
// as /reports/till-sales); counts and quantities stay.

import type { Prisma, PaymentMethod, OrderStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { tenderLabel } from '../../lib/tenders.js'
import { sumCents } from '../../lib/money.js'
import { fmtPktDate } from '../accounting/dates.js'
import { cityLedgerReport } from '../receivables/cityLedgerReport.js'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABEL } from '../receivables/cityLedger.js'
import { allocateTaxCents, tenderOfPayments } from '../../lib/pricing.js'
import { salesTotals, salesByTender, salesBySettlement, soldOrderWhere, orderScope, SOLD_STATUSES, type SalesQuery } from './service.js'
import type { ReportColumn, ReportRow, ReportTable } from '../../lib/reportExport.js'

// ─── Catalog ─────────────────────────────────────────────────────────────────

export const FILTER_KEYS = ['users', 'waiters', 'orderTypes', 'categories', 'subCategories', 'menuItems', 'sources', 'terminals', 'paymentMethods', 'paymentType', 'orderBy', 'settleBy', 'q', 'items', 'sessions', 'clAccountTypes', 'clAccounts', 'locationIds'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]
export const OPTION_KEYS = ['orderType', 'session', 'category', 'subCategory', 'menuItem', 'tax', 'extraCharge', 'discount', 'payment', 'businessSource', 'waiterWise', 'userWise', 'taxableValue', 'includeNoCharge', 'vouchers', 'showCurrency', 'detail', 'ignoreZero'] as const
export type OptionKey = (typeof OPTION_KEYS)[number]
export const GROUP_BY_KEYS = ['payment_method', 'payment_type', 'order_by', 'settle_by', 'terminal', 'order_type'] as const
export type GroupByKey = (typeof GROUP_BY_KEYS)[number]

export const ORDER_TYPES = ['dine_in', 'takeout', 'delivery', 'no_charge'] as const
export type OrderTypeKey = (typeof ORDER_TYPES)[number]
export const SOURCES = ['servd', 'pos', 'cart', 'manual'] as const
export const PAYMENT_METHODS = ['cash', 'card', 'raast', 'on_account', 'comp', 'keenu_qr'] as const
export const PAYMENT_TYPES = ['sale', 'refund'] as const

const ORDER_TYPE_LABEL: Record<OrderTypeKey, string> = { dine_in: 'Dine In', takeout: 'Takeaway', delivery: 'Delivery', no_charge: 'No Charge' }
const SOURCE_LABEL: Record<string, string> = { servd: 'servd online', pos: 'Till (POS)', cart: 'Storefront cart', manual: 'Manual / till delivery' }
const GROUP_BY_LABEL: Record<GroupByKey, string> = {
  payment_method: 'Payment method', payment_type: 'Payment type', order_by: 'Order by', settle_by: 'Settle by', terminal: 'Terminal', order_type: 'Order type',
}

export const TILL_REPORT_IDS = [
  'menu_item_sales_summary', 'sales_detail', 'cashier_sales_detail', 'no_charge_item_detail', 'no_charge_item_summary',
  'payment_summary', 'city_ledger_detail', 'stock_transfer_summary', 'stock_ledger', 'closing_stock',
  // Back office (owner, 2026-10-22). Payment Summary and City Ledger Detail are listed in this group too (one id each).
  'settlement_detail', 'settlement_summary', 'payment_detail', 'discount_detail', 'tax_collection', 'tax_analysis',
  'city_ledger_summary', 'fiscal', 'category_tax_collection', 'driver_efficiency', 'driver_deliveries',
] as const
export type TillReportId = (typeof TILL_REPORT_IDS)[number]

export interface TillReportDef {
  id: TillReportId
  title: string
  filters: FilterKey[]
  options: OptionKey[]
  groupBy: GroupByKey[] | null
  printable: boolean
}

const SALES_FILTERS: FilterKey[] = ['users', 'waiters', 'orderTypes', 'sessions', 'categories', 'subCategories', 'menuItems', 'sources', 'terminals', 'paymentMethods']
const SETTLEMENT_FILTERS: FilterKey[] = ['paymentType', 'paymentMethods', 'orderBy', 'settleBy', 'terminals', 'orderTypes', 'sessions', 'q']

export const TILL_REPORTS: Record<TillReportId, TillReportDef> = {
  menu_item_sales_summary: { id: 'menu_item_sales_summary', title: 'Menu Item Sales Summary', filters: SALES_FILTERS, options: [], groupBy: null, printable: false },
  sales_detail: { id: 'sales_detail', title: 'Sales Detail', filters: [...SALES_FILTERS, 'q'], options: [], groupBy: null, printable: false },
  cashier_sales_detail: {
    id: 'cashier_sales_detail', title: 'Cashier Sales Detail', filters: ['users', 'waiters', 'orderTypes', 'sessions', 'sources', 'terminals', 'paymentMethods'],
    options: ['orderType', 'session', 'category', 'subCategory', 'menuItem', 'tax', 'extraCharge', 'discount', 'payment', 'businessSource', 'waiterWise', 'userWise', 'taxableValue', 'includeNoCharge', 'vouchers'],
    groupBy: null, printable: true,
  },
  no_charge_item_detail: { id: 'no_charge_item_detail', title: 'No Charge Menu Item Sales Detail', filters: ['users', 'waiters', 'sessions', 'categories', 'subCategories', 'menuItems', 'sources', 'terminals', 'q'], options: [], groupBy: null, printable: false },
  no_charge_item_summary: { id: 'no_charge_item_summary', title: 'No Charge Menu Item Sales Summary', filters: ['users', 'waiters', 'sessions', 'categories', 'subCategories', 'menuItems', 'sources', 'terminals'], options: [], groupBy: null, printable: false },
  payment_summary: {
    id: 'payment_summary', title: 'Payment Summary', filters: ['paymentMethods', 'paymentType', 'orderBy', 'settleBy', 'terminals', 'orderTypes', 'sessions', 'sources'],
    options: ['showCurrency', 'detail'], groupBy: [...GROUP_BY_KEYS], printable: false,
  },
  city_ledger_detail: { id: 'city_ledger_detail', title: 'City Ledger Detail', filters: ['clAccountTypes', 'clAccounts', 'q'], options: ['ignoreZero'], groupBy: null, printable: false },
  stock_transfer_summary: { id: 'stock_transfer_summary', title: 'Stock Transfer Summary', filters: ['items'], options: [], groupBy: null, printable: false },
  stock_ledger: { id: 'stock_ledger', title: 'Stock Ledger', filters: ['items'], options: [], groupBy: null, printable: false },
  closing_stock: { id: 'closing_stock', title: 'Closing Stock', filters: ['items'], options: [], groupBy: null, printable: false },
  settlement_detail: { id: 'settlement_detail', title: 'Settlement Detail', filters: SETTLEMENT_FILTERS, options: ['showCurrency', 'includeNoCharge'], groupBy: null, printable: false },
  settlement_summary: { id: 'settlement_summary', title: 'Settlement Summary', filters: SETTLEMENT_FILTERS.filter((k) => k !== 'q'), options: ['showCurrency', 'includeNoCharge'], groupBy: null, printable: false },
  payment_detail: { id: 'payment_detail', title: 'Payment Detail', filters: ['paymentMethods', 'paymentType', 'orderBy', 'settleBy', 'terminals', 'orderTypes', 'sessions', 'sources', 'q'], options: ['showCurrency'], groupBy: null, printable: false },
  discount_detail: { id: 'discount_detail', title: 'Discount Detail', filters: ['users', 'waiters', 'orderTypes', 'sessions', 'sources', 'terminals', 'q'], options: ['showCurrency'], groupBy: null, printable: false },
  tax_collection: { id: 'tax_collection', title: 'Tax Collection', filters: ['orderTypes', 'sessions', 'sources', 'terminals'], options: ['showCurrency', 'includeNoCharge'], groupBy: null, printable: false },
  tax_analysis: { id: 'tax_analysis', title: 'Tax Analysis', filters: ['orderTypes', 'sessions', 'sources', 'terminals'], options: ['showCurrency', 'includeNoCharge'], groupBy: null, printable: false },
  city_ledger_summary: { id: 'city_ledger_summary', title: 'City Ledger Summary', filters: ['clAccountTypes', 'clAccounts', 'q'], options: ['ignoreZero', 'showCurrency'], groupBy: null, printable: false },
  fiscal: { id: 'fiscal', title: 'Fiscal', filters: ['q'], options: [], groupBy: null, printable: false },
  category_tax_collection: { id: 'category_tax_collection', title: 'Category Wise Tax Collection', filters: ['categories', 'subCategories', 'orderTypes', 'sessions', 'sources', 'terminals'], options: ['subCategory', 'showCurrency', 'includeNoCharge'], groupBy: null, printable: false },
  driver_efficiency: { id: 'driver_efficiency', title: 'Driver Efficiency', filters: [], options: [], groupBy: null, printable: false },
  driver_deliveries: { id: 'driver_deliveries', title: 'Driver Deliveries', filters: ['q'], options: ['showCurrency'], groupBy: null, printable: false },
}

// Outlet filter (owner, 2026-10-26): every report that narrows ORDERS (it lists the order-type or business-source
// filter) can also be narrowed to chosen outlets (Order.locationId). Done once here so a new report cannot forget it.
for (const def of Object.values(TILL_REPORTS)) {
  if ((def.filters.includes('orderTypes') || def.filters.includes('sources')) && !def.filters.includes('locationIds')) def.filters.push('locationIds')
}

export function tillCatalog() {
  return {
    groups: [
      { key: 'recommended', title: 'Recommended reports', reportIds: ['menu_item_sales_summary', 'sales_detail', 'cashier_sales_detail', 'payment_summary'] },
      { key: 'menu_item', title: 'Menu item sales report', reportIds: ['menu_item_sales_summary'] },
      { key: 'sales', title: 'Sales report', reportIds: ['sales_detail', 'cashier_sales_detail', 'payment_summary', 'city_ledger_detail'] },
      { key: 'no_charge', title: 'No charge report', reportIds: ['no_charge_item_detail', 'no_charge_item_summary'] },
      { key: 'stock', title: 'Stock report', reportIds: ['stock_transfer_summary', 'stock_ledger', 'closing_stock'] },
      {
        key: 'back_office', title: 'Back office report',
        reportIds: ['settlement_detail', 'settlement_summary', 'payment_detail', 'payment_summary', 'discount_detail', 'tax_collection', 'tax_analysis',
          'city_ledger_detail', 'city_ledger_summary', 'fiscal', 'category_tax_collection', 'driver_efficiency', 'driver_deliveries'],
      },
    ],
    reports: TILL_REPORT_IDS.map((id) => TILL_REPORTS[id]),
  }
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

export type Cell = string | number | null
export interface TillColumn { key: string; label: string; type: 'text' | 'number' | 'cents' }
export interface TillSection { title: string | null; columns: TillColumn[]; rows: Array<Record<string, Cell>>; totals: Record<string, Cell> | null }
export interface TillReport { id: TillReportId; title: string; period: string; outlets: string[]; sections: TillSection[]; notes: string[]; printedBy?: string; printedAt?: string }

export interface TillFilters {
  users?: string[]; waiters?: string[]; orderTypes?: OrderTypeKey[]; categories?: string[]; subCategories?: string[]; menuItems?: string[]; sessions?: string[]
  sources?: string[]; terminals?: string[]; paymentMethods?: string[]; paymentType?: Array<'sale' | 'refund'>
  orderBy?: string[]; settleBy?: string[]; q?: string; items?: string[]
  /** Outlets (Location ids of the brands' companies — the route has already checked them): Order.locationId. */
  locationIds?: string[]
  /** City Ledger: account types, and the accounts (null = all accounts — the report still needs the field sent). */
  clAccountTypes?: string[]; clAccounts?: string[] | null
}

export interface TillReportInput {
  /** company = the caller's read scope; conceptIds = the brands, each already owned; from / to = Karachi days. */
  sq: SalesQuery
  conceptIds: string[]
  /** The companies of those brands (stock, on-account clients, drawers). */
  tenantIds: string[]
  outlets: string[]
  filters: TillFilters
  groupBy: GroupByKey
  opts: Set<OptionKey>
  money: boolean
}

const MAX_ORDERS = 20_000
const col = (key: string, label: string, type: TillColumn['type'] = 'text'): TillColumn => ({ key, label, type })
const pktStamp = (d: Date | null) => d ? new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : ''
const has = <T>(a: T[] | undefined): a is T[] => !!a && a.length > 0
const byLabel = (a: string, b: string) => a.localeCompare(b)

/** Null every cents cell for a volume-only reader. */
function maskSection(s: TillSection, money: boolean): TillSection {
  if (money) return s
  const cents = new Set(s.columns.filter((c) => c.type === 'cents').map((c) => c.key))
  const strip = (r: Record<string, Cell>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cents.has(k) ? null : v]))
  return { ...s, rows: s.rows.map(strip), totals: s.totals ? strip(s.totals) : null }
}
function sumKey(rows: Array<Record<string, Cell>>, k: string): number {
  return rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0)
}

// ─── No Charge: a paid comp covering the bill (pos/orderSummary.ts rule) ─────

/** The sold orders in scope (filters NOT applied) that are No Charge. */
async function noChargeOrderIds(sq: SalesQuery): Promise<string[]> {
  const base = { ...sq, extra: null }
  const comps = await prisma.payment.groupBy({
    by: ['orderId'], where: { method: 'comp', status: 'paid', order: soldOrderWhere(base) }, _sum: { amountCents: true },
  })
  if (comps.length === 0) return []
  const totals = new Map((await prisma.order.findMany({ where: { id: { in: comps.map((c) => c.orderId) } }, select: { id: true, totalCents: true } })).map((o) => [o.id, o.totalCents]))
  return comps.filter((c) => (c._sum.amountCents ?? 0) > 0 && (c._sum.amountCents ?? 0) >= (totals.get(c.orderId) ?? Infinity)).map((c) => c.orderId)
}

type NcMode = 'any' | 'exclude' | 'only'

/**
 * The till's order filters as one Prisma fragment (SalesQuery.extra). Line
 * filters (categories / menu items) keep an order that has at least one live
 * line in them; item reports narrow the lines again themselves.
 */
async function orderFilter(sq: SalesQuery, f: TillFilters, applies: FilterKey[], nc: NcMode, ncIds?: string[]): Promise<Prisma.OrderWhereInput | null> {
  const on = (k: FilterKey) => applies.includes(k)
  const and: Prisma.OrderWhereInput[] = []
  if (on('users') && has(f.users)) and.push({ posStaffId: { in: f.users } })
  if (on('orderBy') && has(f.orderBy)) and.push({ posStaffId: { in: f.orderBy } })
  if (on('settleBy') && has(f.settleBy)) and.push({ payments: { some: { status: 'paid', shift: { userId: { in: f.settleBy } } } } })
  if (on('paymentType') && has(f.paymentType) && !f.paymentType.includes('sale')) and.push({ payments: { some: { status: 'refunded', amountCents: { lt: 0 } } } })
  if (on('waiters') && has(f.waiters)) and.push({ waiterEmployeeId: { in: f.waiters } })
  if (on('locationIds') && has(f.locationIds)) and.push({ locationId: { in: f.locationIds } })
  if (on('sources') && has(f.sources)) and.push({ source: { in: f.sources as never } })
  if (on('terminals') && has(f.terminals)) and.push({ OR: [{ shiftId: { in: f.terminals } }, { payments: { some: { shiftId: { in: f.terminals } } } }] })
  if (on('paymentMethods') && has(f.paymentMethods)) and.push({ payments: { some: { status: 'paid', method: { in: f.paymentMethods as PaymentMethod[] } } } })
  // A main category takes in its sub-categories (2026-10-22).
  if (on('categories') && has(f.categories)) and.push({ items: { some: { status: { not: 'voided' }, menuItem: { OR: [{ categoryId: { in: f.categories } }, { category: { parentId: { in: f.categories } } }] } } } })
  if (on('subCategories') && has(f.subCategories)) and.push({ items: { some: { status: { not: 'voided' }, menuItem: { categoryId: { in: f.subCategories } } } } })
  if (on('sessions') && has(f.sessions)) and.push({ id: { in: await orderIdsInSessions(sq, f.sessions) } })
  if (on('menuItems') && has(f.menuItems)) and.push({ items: { some: { status: { not: 'voided' }, menuItemId: { in: f.menuItems } } } })
  if (on('q') && f.q) {
    const q = f.q.trim()
    and.push({
      OR: [
        { id: { endsWith: q.toLowerCase() } },
        { customerName: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { taxInvoices: { some: { invoiceNumber: { contains: q, mode: 'insensitive' } } } },
        { fiscalDocuments: { some: { kind: 'sale', fiscalNumber: { contains: q, mode: 'insensitive' } } } },
      ],
    })
  }
  const types = on('orderTypes') && has(f.orderTypes) ? f.orderTypes : null
  if (types || nc !== 'any') {
    const ids = ncIds ?? await noChargeOrderIds(sq)
    if (nc === 'only') and.push({ id: { in: ids } })
    if (nc === 'exclude') and.push({ id: { notIn: ids } })
    if (types) {
      const fts = types.filter((t) => t !== 'no_charge') as Array<'dine_in' | 'takeout' | 'delivery'>
      const alts: Prisma.OrderWhereInput[] = []
      if (types.includes('no_charge')) alts.push({ id: { in: ids } })
      if (fts.length) alts.push({ fulfilmentType: { in: fts }, id: { notIn: ids } })
      and.push({ OR: alts })
    }
  }
  return and.length ? { AND: and } : null
}

// ─── The sold orders, with what the reports show ────────────────────────────

const ORDER_SELECT = {
  id: true, placedAt: true, completedAt: true, status: true, fulfilmentType: true, source: true, conceptId: true,
  totalCents: true, discountCents: true, promoDiscountCents: true, taxCents: true, taxRatePct: true, serviceChargeCents: true,
  deliveryFeeCents: true, deliveryFeeTaxCents: true, tipCents: true, walletAmountCents: true,
  customerName: true, posStaffId: true, waiterEmployeeId: true,
  table: { select: { label: true } },
  customer: { select: { name: true } },
  posStaff: { select: { name: true } },
  waiter: { select: { fullName: true } },
  items: {
    where: { status: { not: 'voided' as const } },
    select: { id: true, name: true, quantity: true, unitPriceCents: true, menuItemId: true, menuItem: { select: { categoryId: true, category: { select: { name: true, parentId: true, parent: { select: { name: true } } } } } } },
  },
  payments: { where: { status: 'paid' as const, method: { not: 'split' as const } }, select: { method: true, amountCents: true, gatewayMeta: true, shift: { select: { user: { select: { name: true } } } } } },
  giftCardRedemptions: { where: { amountCents: { gt: 0 } }, select: { amountCents: true } },
  promoCode: { select: { code: true } },
  settlementChannel: true,
  taxInvoices: { where: { type: 'invoice' as const }, select: { invoiceNumber: true }, take: 1 },
  fiscalDocuments: { where: { kind: 'sale' as const, fiscalNumber: { not: null } }, select: { fiscalNumber: true }, take: 1 },
} satisfies Prisma.OrderSelect
type SoldOrder = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>

async function loadOrders(sq: SalesQuery, notes: string[]): Promise<SoldOrder[]> {
  const rows = await prisma.order.findMany({ where: soldOrderWhere(sq), select: ORDER_SELECT, orderBy: [{ completedAt: 'asc' }, { placedAt: 'asc' }], take: MAX_ORDERS + 1 })
  if (rows.length > MAX_ORDERS) { notes.push(`Only the first ${MAX_ORDERS.toLocaleString('en')} orders are listed — narrow the dates or filters.`); rows.length = MAX_ORDERS }
  return rows
}

interface Line { orderId: string; itemKey: string; menuItemId: string | null; categoryId: string | null; parentCategoryId: string | null; name: string; category: string; subCategory: string; qty: number; gross: number; discount: number; tax: number }

/**
 * An order's live lines with the bill's discount and GST shared across them
 * by value (the delivery fee's GST stays with the fee). Gross = menu price ×
 * quantity, as topItems values it. Shares use lib/pricing.ts allocateTaxCents
 * (largest remainder), so a bill's lines add up to its discount and GST exactly.
 */
function linesOf(o: SoldOrder): Line[] {
  const gross = o.items.map((i) => i.unitPriceCents * i.quantity)
  const total = gross.reduce((s, g) => s + g, 0)
  const discounts = total > 0 ? allocateTaxCents(gross, o.discountCents + o.promoDiscountCents) : gross.map(() => 0)
  const taxes = total > 0 ? allocateTaxCents(gross.map((g, n) => g - discounts[n]!), Math.max(0, o.taxCents - o.deliveryFeeTaxCents)) : gross.map(() => 0)
  return o.items.map((i, n) => {
    const d = discounts[n]!, t = taxes[n]!
    return {
      orderId: o.id, itemKey: i.menuItemId ?? `name:${i.name}`, menuItemId: i.menuItemId, categoryId: i.menuItem?.categoryId ?? null,
      parentCategoryId: i.menuItem?.category?.parentId ?? null,
      // Category = the main category; Sub category = the item's own when it sits under one (2026-10-22).
      name: i.name, category: i.menuItem?.category?.parent?.name ?? i.menuItem?.category?.name ?? 'Uncategorised',
      subCategory: i.menuItem?.category?.parent ? i.menuItem.category.name : NO_SUB,
      qty: i.quantity, gross: gross[n]!, discount: d, tax: t,
    }
  })
}
function lineFilter(f: TillFilters, applies: FilterKey[]) {
  const cats = applies.includes('categories') && has(f.categories) ? new Set(f.categories) : null
  const subs = applies.includes('subCategories') && has(f.subCategories) ? new Set(f.subCategories) : null
  const items = applies.includes('menuItems') && has(f.menuItems) ? new Set(f.menuItems) : null
  return (l: Line) => (!cats || (l.categoryId != null && cats.has(l.categoryId)) || (l.parentCategoryId != null && cats.has(l.parentCategoryId)))
    && (!subs || (l.categoryId != null && subs.has(l.categoryId)))
    && (!items || (l.menuItemId != null && items.has(l.menuItemId)))
}

const NO_SUB = '—'

// ─── Sessions (2026-10-22): named times of day per brand (menu/routes.ts) ────

export const NO_SESSION = 'No session'
type SessionOf = (conceptId: string, at: Date) => { id: string; name: string } | null
/** Minute of the Karachi day (UTC+5, no DST). */
const pktMinute = (d: Date) => ((Math.floor(d.getTime() / 60_000) + 300) % 1440 + 1440) % 1440
const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
/** The session a sale falls into, by the Karachi time it was placed; the brands' ACTIVE sessions (they never overlap). */
export async function sessionResolver(conceptIds: string[]): Promise<SessionOf> {
  const rows = await prisma.menuSession.findMany({ where: { conceptId: { in: conceptIds }, isActive: true }, select: { id: true, conceptId: true, name: true, startTime: true, endTime: true } })
  const by = new Map<string, typeof rows>()
  for (const r of rows) by.set(r.conceptId, [...(by.get(r.conceptId) ?? []), r])
  return (conceptId, at) => {
    const m = pktMinute(at)
    const hit = (by.get(conceptId) ?? []).find((r) => {
      const a = hm(r.startTime), b = hm(r.endTime)
      return a < b ? m >= a && m < b : m >= a || m < b
    })
    return hit ? { id: hit.id, name: hit.name } : null
  }
}
/** The sold orders in scope (no other filter) placed inside one of the given sessions. */
async function orderIdsInSessions(sq: SalesQuery, sessionIds: string[]): Promise<string[]> {
  const conceptIds = sq.conceptIds ?? (sq.conceptId ? [sq.conceptId] : [])
  const of = await sessionResolver(conceptIds)
  const want = new Set(sessionIds)
  // Sold in the window, or placed in it (the Cashier Sales report counts running bills too).
  const rows = await prisma.order.findMany({ where: { OR: [soldOrderWhere({ ...sq, extra: null }), { AND: [orderScope({ ...sq, extra: null }), { placedAt: { gte: sq.from, lte: sq.to } }] }] }, select: { id: true, conceptId: true, placedAt: true } })
  return rows.filter((o) => { const s = of(o.conceptId, o.placedAt); return !!s && want.has(s.id) }).map((o) => o.id)
}

const receiptNoOf = (o: SoldOrder) => o.fiscalDocuments[0]?.fiscalNumber ?? o.taxInvoices[0]?.invoiceNumber ?? ''
const guestOf = (o: SoldOrder) => o.customer?.name ?? o.customerName ?? ''
const compOf = (o: SoldOrder) => o.payments.filter((p) => p.method === 'comp').reduce((s, p) => s + p.amountCents, 0)
const typeOf = (o: SoldOrder): OrderTypeKey => { const c = compOf(o); return c > 0 && c >= o.totalCents ? 'no_charge' : (o.fulfilmentType as OrderTypeKey) }

// ─── Reports ─────────────────────────────────────────────────────────────────

export async function runTillReport(id: TillReportId, input: TillReportInput): Promise<TillReport> {
  const def = TILL_REPORTS[id]
  const notes: string[] = []
  let sections: TillSection[]
  switch (id) {
    case 'menu_item_sales_summary': sections = await menuItemSummary(input, def, notes); break
    case 'sales_detail': sections = await salesDetail(input, def, notes); break
    case 'cashier_sales_detail': sections = await cashierDetail(input, def, notes); break
    case 'no_charge_item_detail': sections = await noChargeItems(input, def, notes, 'detail'); break
    case 'no_charge_item_summary': sections = await noChargeItems(input, def, notes, 'summary'); break
    case 'payment_summary': sections = await paymentSummary(input, def, notes); break
    case 'payment_detail': sections = await paymentDetail(input, def, notes); break
    case 'city_ledger_detail': sections = await cityLedgerDetail(input, notes); break
    case 'city_ledger_summary': sections = await cityLedger(input, notes); break
    case 'settlement_detail': sections = await settlementDetail(input, def, notes); break
    case 'settlement_summary': sections = await settlementSummary(input, def, notes); break
    case 'discount_detail': sections = await discountDetail(input, def, notes); break
    case 'tax_collection': sections = await taxCollection(input, def, notes); break
    case 'tax_analysis': sections = await taxAnalysis(input, def, notes); break
    case 'category_tax_collection': sections = await categoryTax(input, def, notes); break
    case 'fiscal': sections = await fiscalDocs(input, notes); break
    case 'driver_efficiency': sections = await drivers(input, notes, 'efficiency'); break
    case 'driver_deliveries': sections = await drivers(input, notes, 'deliveries'); break
    case 'stock_transfer_summary': sections = await stockTransfers(input, notes); break
    case 'stock_ledger': sections = await stockLedger(input, notes); break
    case 'closing_stock': sections = await closingStock(input, notes); break
  }
  if (input.opts.has('showCurrency') && def.options.includes('showCurrency')) {
    // "Show currency": money column labels carry PKR (the cells stay paisa numbers, type 'cents').
    sections = sections.map((sec) => ({ ...sec, columns: sec.columns.map((c) => (c.type === 'cents' && !/PKR/.test(c.label) ? { ...c, label: `${c.label} (PKR)` } : c)) }))
  }
  return {
    // The printout's own heading (owner, 2026-10-22); the list keeps the report's name.
    id, title: id === 'cashier_sales_detail' ? 'Cashier Sales Report' : def.title, period: `${fmtPktDate(input.sq.from)} to ${fmtPktDate(input.sq.to)}`, outlets: input.outlets,
    sections: sections.map((s) => maskSection(s, input.money)), notes,
  }
}

/** No Charge orders stay out of a report that offers "Include no charge" until it is ticked. */
const ncModeOf = (input: TillReportInput, def: TillReportDef): NcMode =>
  def.options.includes('includeNoCharge') && !input.opts.has('includeNoCharge') ? 'exclude' : 'any'

async function scopedQuery(input: TillReportInput, def: TillReportDef, nc: NcMode, ncIds?: string[]): Promise<SalesQuery> {
  const extra = await orderFilter(input.sq, input.filters, def.filters, nc, ncIds)
  return { ...input.sq, extra }
}

async function menuItemSummary(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const orders = await loadOrders(await scopedQuery(input, def, 'any'), notes)
  const keep = lineFilter(input.filters, def.filters)
  const by = new Map<string, { category: string; subCategory: string; item: string; qty: number; gross: number; discount: number; tax: number }>()
  for (const o of orders) for (const l of linesOf(o)) {
    if (!keep(l)) continue
    const k = `${l.category}\u0000${l.subCategory}\u0000${l.itemKey}`
    const s = by.get(k) ?? { category: l.category, subCategory: l.subCategory, item: l.name, qty: 0, gross: 0, discount: 0, tax: 0 }
    s.qty += l.qty; s.gross += l.gross; s.discount += l.discount; s.tax += l.tax
    by.set(k, s)
  }
  const columns = [col('item', 'Menu item'), col('subCategory', 'Sub category'), col('qty', 'Qty', 'number'), col('grossCents', 'Gross', 'cents'), col('discountCents', 'Discount', 'cents'), col('netCents', 'Net', 'cents'), col('taxCents', 'Tax', 'cents')]
  const cats = new Map<string, Array<Record<string, Cell>>>()
  for (const s of [...by.values()].sort((a, b) => byLabel(a.category, b.category) || byLabel(a.subCategory, b.subCategory) || b.qty - a.qty || byLabel(a.item, b.item))) {
    const rows = cats.get(s.category) ?? []
    rows.push({ item: s.item, subCategory: s.subCategory, qty: s.qty, grossCents: s.gross, discountCents: s.discount, netCents: s.gross - s.discount, taxCents: s.tax })
    cats.set(s.category, rows)
  }
  const tot = (rows: Array<Record<string, Cell>>, label: string): Record<string, Cell> => ({
    item: label, qty: sumKey(rows, 'qty'), grossCents: sumKey(rows, 'grossCents'), discountCents: sumKey(rows, 'discountCents'), netCents: sumKey(rows, 'netCents'), taxCents: sumKey(rows, 'taxCents'),
  })
  const sections: TillSection[] = [...cats].map(([category, rows]) => ({ title: category, columns, rows, totals: tot(rows, 'TOTAL') }))
  const all = [...cats.values()].flat()
  sections.push({
    title: 'All categories',
    columns: [col('category', 'Category'), ...columns.slice(2)],
    rows: [...cats].map(([category, rows]) => { const t = tot(rows, category); return { category, qty: t.qty, grossCents: t.grossCents, discountCents: t.discountCents, netCents: t.netCents, taxCents: t.taxCents } }),
    totals: (() => { const t = tot(all, 'TOTAL'); return { category: 'TOTAL', qty: t.qty, grossCents: t.grossCents, discountCents: t.discountCents, netCents: t.netCents, taxCents: t.taxCents } })(),
  })
  notes.push('Gross = menu price × quantity (voided lines left out). Each bill’s discount and GST are shared across its lines by value; Net = Gross − Discount, before GST.')
  return sections
}

async function salesDetail(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const orders = await loadOrders(await scopedQuery(input, def, 'any'), notes)
  const sessionOf = await sessionResolver(input.conceptIds)
  const rows = orders.map((o) => {
    const lines = linesOf(o)
    const methods = [...new Set(o.payments.map((p) => tenderLabel(p.method)))]
    if (o.walletAmountCents > 0) methods.push(tenderLabel('wallet'))
    return {
      orderNo: orderRefOf(o.id), dateTime: pktStamp(o.completedAt ?? o.placedAt), session: sessionOf(o.conceptId, o.placedAt)?.name ?? NO_SESSION, receiptNo: receiptNoOf(o), orderType: ORDER_TYPE_LABEL[typeOf(o)],
      table: o.table?.label ?? '', guest: guestOf(o), user: o.posStaff?.name ?? '', waiter: o.waiter?.fullName ?? '',
      items: lines.reduce((s, l) => s + l.qty, 0),
      grossCents: lines.reduce((s, l) => s + l.gross, 0), discountCents: o.discountCents + o.promoDiscountCents,
      serviceChargeCents: o.serviceChargeCents, deliveryFeeCents: o.deliveryFeeCents, taxCents: o.taxCents, totalCents: o.totalCents + o.walletAmountCents,
      payments: methods.join(', '),
    } as Record<string, Cell>
  })
  const money = ['grossCents', 'discountCents', 'serviceChargeCents', 'deliveryFeeCents', 'taxCents', 'totalCents']
  const totals: Record<string, Cell> = { orderNo: 'TOTAL', dateTime: `${rows.length} orders`, items: sumKey(rows, 'items'), ...Object.fromEntries(money.map((k) => [k, sumKey(rows, k)])) }
  notes.push('Gross = menu price × quantity; Total = the bill as charged (incl. GST, service charge, delivery fee and tip), before any later refund.')
  return [{
    title: null,
    columns: [
      col('orderNo', 'Order No'), col('dateTime', 'Date / time'), col('session', 'Session'), col('receiptNo', 'Receipt No'), col('orderType', 'Order type'), col('table', 'R/T No'),
      col('guest', 'Guest'), col('user', 'User'), col('waiter', 'Waiter'), col('items', 'Items', 'number'), col('grossCents', 'Gross', 'cents'),
      col('discountCents', 'Discount', 'cents'), col('serviceChargeCents', 'Service charge', 'cents'), col('deliveryFeeCents', 'Delivery fee', 'cents'),
      col('taxCents', 'Tax', 'cents'), col('totalCents', 'Total', 'cents'), col('payments', 'Payment methods'),
    ],
    rows, totals,
  }]
}

// ─── Cashier Sales Report (owner, 2026-10-22: "This is how i want cashier Sales details report, same line of
// items and it should fetch all the data as per requirement and accurate") ───────────────────────────────────
//
// The owner's printout, line for line — Receipt Summary, Sales Summary, Category Summary, Payment Summary.
// The bills are every bill PLACED in the period (Karachi days) — running ones too, so "Balance" shows what is
// still to be settled; a cancelled, rejected or credit-noted bill is a void receipt and counts nowhere else.
//   Total Sales      = Σ bill as charged (Order.totalCents + wallet + gift card: GST, extra charges and tip in)
//   Tip / Tax / Discount / Extra charge (service charge + delivery fee) = the stored order figures; Round off 0
//   Net Sales        = Total Sales − Tax − Extra charge − Round off − Tip      Total Amount = Net Sales + Discount
//   Settled          = money received on those bills (paid tenders, wallet, gift card)   Balance = Total − Settled
//   Sales per pax / receipt = Net Sales ÷ #Pax / #Receipts      Category Summary = Net Sales shared across the
//   bills' live lines by value (lib/pricing.ts allocateTaxCents), per main category, with the items' quantity.
// Ticked options add their breakdowns after the four sections (the 22 Oct options).

const CASHIER_VOID: OrderStatus[] = ['cancelled', 'rejected', 'refunded']
const kv = (label: string, value: Cell): Record<string, Cell> => ({ line: label, value })
const KV_COLUMNS = [col('line', ''), col('value', '', 'number')]
const KV_MONEY = [col('line', ''), col('value', '', 'cents')]

async function cashierDetail(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const o = input.opts
  const ncIds = await noChargeOrderIds(input.sq)
  const extra = await orderFilter(input.sq, input.filters, def.filters, o.has('includeNoCharge') ? 'any' : 'exclude', ncIds)
  const scope: Prisma.OrderWhereInput = { AND: [orderScope({ ...input.sq, extra }), { placedAt: { gte: input.sq.from, lte: input.sq.to } }] }
  const [bills, voids] = await Promise.all([
    prisma.order.findMany({
      where: { AND: [scope, { status: { notIn: CASHIER_VOID } }] }, take: MAX_ORDERS + 1, orderBy: { placedAt: 'asc' },
      select: { ...ORDER_SELECT, partySize: true },
    }),
    prisma.order.count({ where: { AND: [scope, { status: { in: CASHIER_VOID } }] } }),
  ])
  if (bills.length > MAX_ORDERS) { notes.push(`Only the first ${MAX_ORDERS.toLocaleString('en')} bills are counted — narrow the dates or filters.`); bills.length = MAX_ORDERS }

  const giftOf = (x: SoldOrder) => x.giftCardRedemptions.reduce((s, g) => s + g.amountCents, 0)
  const sum = (f: (x: (typeof bills)[number]) => number) => bills.reduce((s, x) => s + f(x), 0)
  const totalSales = sum((x) => x.totalCents + x.walletAmountCents + giftOf(x))
  const tip = sum((x) => x.tipCents)
  const tax = sum((x) => x.taxCents)
  const discount = sum((x) => x.discountCents + x.promoDiscountCents)
  const extraCharge = sum((x) => x.serviceChargeCents + x.deliveryFeeCents)
  const roundOff = 0
  const netSales = totalSales - tax - extraCharge - roundOff - tip
  const totalAmount = netSales + discount
  // Money received: paid tenders (No Charge comps only when ticked in), wallet and gift card.
  type Pay = { label: string; amount: number }
  const pays: Pay[] = []
  for (const x of bills) {
    for (const p of x.payments) if (p.amountCents > 0 && (p.method !== 'comp' || o.has('includeNoCharge'))) pays.push({ label: p.method === 'comp' ? 'No Charge' : tenderLabel(p.method), amount: p.amountCents })
    if (x.walletAmountCents > 0) pays.push({ label: tenderLabel('wallet'), amount: x.walletAmountCents })
    if (giftOf(x) > 0) pays.push({ label: tenderLabel('gift_card'), amount: giftOf(x) })
  }
  const settled = pays.reduce((s, p) => s + p.amount, 0)
  const pax = sum((x) => x.partySize ?? 0)
  const receipts = bills.length
  // Sales per pax / receipt in rupees (2 decimals, like the printout); money only for financial readers.
  const per = (n: number): Cell => (!input.money ? null : n > 0 ? Math.round(netSales / n) / 100 : 0)

  // Category Summary: Net Sales shared across the live lines by value, per main category.
  const lines = bills.flatMap(linesOf)
  const shares = lines.length ? allocateTaxCents(lines.map((l) => Math.max(0, l.gross)), Math.max(0, netSales)) : []
  const cats = new Map<string, { qty: number; amount: number }>()
  lines.forEach((l, n) => { const c = cats.get(l.category) ?? { qty: 0, amount: 0 }; c.qty += l.qty; c.amount += shares[n] ?? 0; cats.set(l.category, c) })
  const payBy = new Map<string, { count: number; amount: number }>()
  for (const p of pays) { const s = payBy.get(p.label) ?? { count: 0, amount: 0 }; s.count++; s.amount += p.amount; payBy.set(p.label, s) }

  const sections: TillSection[] = [
    {
      title: 'Receipt Summary', columns: KV_COLUMNS, totals: null,
      rows: [kv('#Pax', pax), kv('#Payments', pays.length), kv('#Receipts', receipts), kv('Sales Per Pax', per(pax)), kv('Sales Per Receipt', per(receipts)), kv('#Void Receipts', voids)],
    },
    {
      title: 'Sales Summary', columns: KV_MONEY, totals: null,
      rows: [
        kv('Discount', discount), kv('Extra charge', extraCharge), kv('Round Off', roundOff), kv('Tax', tax), kv('Tip', tip),
        kv('Total Amount', totalAmount), kv('Net Sales', netSales), kv('Total Sales:', totalSales),
        kv('Total Sales without Tip', totalSales - tip), kv('Balance', totalSales - settled), kv('Settled', settled),
      ],
    },
    {
      title: 'Category Summary', columns: [col('category', ''), col('qty', '', 'number'), col('amountCents', '', 'cents')],
      rows: [...cats].sort((a, b) => byLabel(a[0], b[0])).map(([category, c]) => ({ category, qty: c.qty, amountCents: c.amount })),
      totals: { category: 'Total', qty: [...cats.values()].reduce((s, c) => s + c.qty, 0), amountCents: [...cats.values()].reduce((s, c) => s + c.amount, 0) },
    },
    {
      title: 'Payment Summary', columns: [col('method', ''), col('count', '', 'number'), col('amountCents', '', 'cents')],
      rows: [...payBy].sort((a, b) => byLabel(a[0], b[0])).map(([method, s]) => ({ method, count: s.count, amountCents: s.amount })),
      totals: { method: 'Total', count: pays.length, amountCents: settled },
    },
  ]

  // The ticked options (22 Oct) add their breakdowns below.
  const asOrders = bills as SoldOrder[]
  const breakdown = (title: string, keyOf: (x: SoldOrder) => string, amount: (x: SoldOrder) => number = (x) => x.totalCents + x.walletAmountCents + giftOf(x)) => {
    const g = new Map<string, { count: number; amount: number }>()
    for (const x of asOrders) { const k = keyOf(x); const s = g.get(k) ?? { count: 0, amount: 0 }; s.count++; s.amount += amount(x); g.set(k, s) }
    const rows = [...g].sort((a, b) => byLabel(a[0], b[0])).map(([line, s]) => ({ line, count: s.count, amountCents: s.amount }))
    sections.push({ title, columns: [col('line', ''), col('count', 'Count', 'number'), col('amountCents', 'Amount', 'cents')], rows, totals: { line: 'Total', count: sumKey(rows, 'count'), amountCents: sumKey(rows, 'amountCents') } })
  }
  const lineBreakdown = (title: string, keyOf: (l: Line) => string) => {
    const g = new Map<string, { qty: number; amount: number }>()
    lines.forEach((l, n) => { const k = keyOf(l); const s = g.get(k) ?? { qty: 0, amount: 0 }; s.qty += l.qty; s.amount += shares[n] ?? 0; g.set(k, s) })
    const rows = [...g].sort((a, b) => byLabel(a[0], b[0])).map(([line, s]) => ({ line, count: s.qty, amountCents: s.amount }))
    sections.push({ title, columns: [col('line', ''), col('count', 'Qty', 'number'), col('amountCents', 'Net sales', 'cents')], rows, totals: { line: 'Total', count: sumKey(rows, 'count'), amountCents: sumKey(rows, 'amountCents') } })
  }
  if (o.has('orderType')) breakdown('Order Type Summary', (x) => ORDER_TYPE_LABEL[typeOf(x)])
  if (o.has('session')) { const sessionOf = await sessionResolver(input.conceptIds); breakdown('Session Summary', (x) => sessionOf(x.conceptId, x.placedAt)?.name ?? NO_SESSION) }
  if (o.has('subCategory')) lineBreakdown('Sub Category Summary', (l) => (l.subCategory === NO_SUB ? `${l.category} (no sub category)` : `${l.category} › ${l.subCategory}`))
  if (o.has('menuItem')) lineBreakdown('Menu Item Summary', (l) => l.name)
  if (o.has('tax')) breakdown('Tax Summary', (x) => (x.taxRatePct != null ? `GST @ ${x.taxRatePct}%` : 'GST'), (x) => x.taxCents)
  if (o.has('taxableValue')) sections.push({ title: 'Taxable Value', columns: KV_MONEY, totals: null, rows: [kv('Sales ex-GST, ex-tip', totalSales - tax - tip)] })
  if (o.has('extraCharge')) sections.push({ title: 'Extra Charges', columns: KV_MONEY, totals: null, rows: [kv('Service charge', sum((x) => x.serviceChargeCents)), kv('Delivery fee', sum((x) => x.deliveryFeeCents))] })
  if (o.has('discount')) sections.push({ title: 'Discount Summary', columns: KV_MONEY, totals: null, rows: [kv('Discount', sum((x) => x.discountCents)), kv('Promo code', sum((x) => x.promoDiscountCents))] })
  if (o.has('payment')) breakdown('Bills by Payment', (x) => [...new Set(x.payments.map((p) => tenderLabel(p.method)))].join(' + ') || 'Not settled')
  if (o.has('businessSource')) breakdown('Business Source Summary', (x) => SOURCE_LABEL[x.source] ?? x.source)
  if (o.has('waiterWise')) breakdown('Waiter Wise Sales', (x) => x.waiter?.fullName ?? 'No waiter')
  if (o.has('userWise')) breakdown('User Wise Sales', (x) => x.posStaff?.name ?? (x.posStaffId ? 'Unknown user' : 'No user (online)'))
  if (o.has('vouchers')) {
    const rows = (await drawerMovements(input)).map((m) => ({ line: `${m.kind === 'expense' ? 'Expense' : 'Income'} · ${m.when} ${m.reason}`.trim(), count: 1, amountCents: m.amountCents }))
    sections.push({ title: 'Expense / Income Vouchers', columns: [col('line', ''), col('count', 'Count', 'number'), col('amountCents', 'Amount', 'cents')], rows, totals: { line: 'Total', count: rows.length, amountCents: sumKey(rows, 'amountCents') } })
  }
  notes.push('Bills placed in the period (running ones too, so Balance = what is still to be settled). A cancelled, rejected or credit-noted bill is a void receipt. Total Sales = the bills as charged (GST, extra charges and tip in); Net Sales = Total Sales − Tax − Extra charge − Round off − Tip; Total Amount = Net Sales + Discount. Sales per pax / receipt use Net Sales.')
  if (!o.has('includeNoCharge')) notes.push('No Charge bills are left out (tick “Include No Charge” to count them).')
  return sections
}

interface DrawerMovement { userId: string; kind: 'expense' | 'income'; reason: string; when: string; amountCents: number }
/** Payouts / pay-ins of the brands' companies' drawers in the period (terminals filter applies). */
async function drawerMovements(input: TillReportInput): Promise<DrawerMovement[]> {
  const f = input.filters
  const rows = await prisma.cashMovement.findMany({
    where: {
      type: { in: ['payout', 'payin'] }, recordedAt: { gte: input.sq.from, lte: input.sq.to },
      shift: { tenantId: { in: input.tenantIds }, ...(has(f.terminals) && { id: { in: f.terminals } }), ...(has(f.users) && { userId: { in: f.users } }), ...(has(f.locationIds) && { locationId: { in: f.locationIds } }) },
    },
    select: { type: true, reason: true, amountCents: true, recordedAt: true, shift: { select: { userId: true } } },
    orderBy: { recordedAt: 'asc' },
  })
  return rows.map((m) => ({ userId: m.shift.userId, kind: m.type === 'payout' ? 'expense' : 'income', reason: m.reason, when: pktStamp(m.recordedAt), amountCents: m.amountCents }))
}

// ─── No Charge items ─────────────────────────────────────────────────────────

async function noChargeItems(input: TillReportInput, def: TillReportDef, notes: string[], mode: 'detail' | 'summary'): Promise<TillSection[]> {
  const orders = await loadOrders(await scopedQuery(input, def, 'only'), notes)
  const keep = lineFilter(input.filters, def.filters)
  notes.push('No Charge = a paid comp covering the whole bill. Value = menu price × quantity.')
  if (mode === 'summary') {
    const by = new Map<string, { item: string; category: string; qty: number; value: number }>()
    for (const o of orders) for (const l of linesOf(o)) {
      if (!keep(l)) continue
      const s = by.get(l.itemKey) ?? { item: l.name, category: l.category, qty: 0, value: 0 }
      s.qty += l.qty; s.value += l.gross; by.set(l.itemKey, s)
    }
    const rows = [...by.values()].sort((a, b) => b.qty - a.qty || byLabel(a.item, b.item)).map((s) => ({ item: s.item, category: s.category, qty: s.qty, valueCents: s.value }))
    return [{ title: null, columns: [col('item', 'Menu item'), col('category', 'Category'), col('qty', 'Qty', 'number'), col('valueCents', 'Value', 'cents')], rows, totals: { item: 'TOTAL', category: null, qty: sumKey(rows, 'qty'), valueCents: sumKey(rows, 'valueCents') } }]
  }
  const approverIds = [...new Set(orders.flatMap((o) => o.payments).map((p) => (p.gatewayMeta as { comp?: { approverId?: string } } | null)?.comp?.approverId).filter((x): x is string => !!x))]
  const approvers = new Map((await prisma.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
  const rows: Array<Record<string, Cell>> = []
  for (const o of orders) {
    const comp = (o.payments.find((p) => p.method === 'comp')?.gatewayMeta as { comp?: { reason?: string; approverId?: string } } | null)?.comp ?? {}
    for (const l of linesOf(o)) {
      if (!keep(l)) continue
      rows.push({
        orderNo: orderRefOf(o.id), time: pktStamp(o.completedAt ?? o.placedAt), guest: guestOf(o), item: l.name, qty: l.qty, valueCents: l.gross,
        reason: comp.reason ?? '', approvedBy: comp.approverId ? approvers.get(comp.approverId) ?? '' : '',
      })
    }
  }
  return [{
    title: null,
    columns: [col('orderNo', 'Order No'), col('time', 'Time'), col('guest', 'Guest'), col('item', 'Menu item'), col('qty', 'Qty', 'number'), col('valueCents', 'Value', 'cents'), col('reason', 'Reason'), col('approvedBy', 'Approved by')],
    rows, totals: { orderNo: 'TOTAL', time: `${new Set(rows.map((r) => r.orderNo)).size} orders`, qty: sumKey(rows, 'qty'), valueCents: sumKey(rows, 'valueCents') },
  }]
}

// ─── Payment Summary ─────────────────────────────────────────────────────────

async function loadPayments(input: TillReportInput, def: TillReportDef) {
  const f = input.filters
  // Order-level filters (order type, source, search) narrow the orders; payment-level ones the payments.
  const sq = await scopedQuery(input, { ...def, filters: def.filters.filter((k) => k === 'orderTypes' || k === 'sources' || k === 'q' || k === 'locationIds') }, 'any')
  const types = has(f.paymentType) ? f.paymentType : ['sale', 'refund']
  const payWhere: Prisma.PaymentWhereInput = {
    method: has(f.paymentMethods) ? { in: f.paymentMethods as PaymentMethod[] } : { not: 'split' },
    ...(has(f.terminals) && { shiftId: { in: f.terminals } }),
    ...(has(f.settleBy) && { shift: { userId: { in: f.settleBy } } }),
  }
  const orderBy: Prisma.OrderWhereInput = has(f.orderBy) ? { posStaffId: { in: f.orderBy } } : {}
  const or: Prisma.PaymentWhereInput[] = []
  // Sales: the money taken on the period's sold orders (salesByTender's rule).
  if (types.includes('sale')) or.push({ status: 'paid', amountCents: { gt: 0 }, order: { AND: [soldOrderWhere(sq), orderBy] } })
  // Refunds: money handed back in the period, on sold orders (salesByTender's refund rule).
  if (types.includes('refund')) {
    or.push({
      status: 'refunded', amountCents: { lt: 0 }, order: { AND: [orderScope(sq), { status: { in: SOLD_STATUSES } }, orderBy] },
      OR: [{ processedAt: { gte: sq.from, lte: sq.to } }, { processedAt: null, createdAt: { gte: sq.from, lte: sq.to } }],
    })
  }
  const pays = await prisma.payment.findMany({
    where: { AND: [payWhere, { OR: or }] },
    select: {
      id: true, method: true, amountCents: true, status: true, processedAt: true, createdAt: true,
      shift: { select: { id: true, openedAt: true, user: { select: { id: true, name: true } } } },
      order: { select: { id: true, totalCents: true, fulfilmentType: true, posStaff: { select: { name: true } }, payments: { where: { method: 'comp', status: 'paid' }, select: { amountCents: true } } } },
    },
    orderBy: [{ processedAt: 'asc' }, { createdAt: 'asc' }],
    take: MAX_ORDERS * 2,
  })
  return pays
}
type LoadedPayment = Awaited<ReturnType<typeof loadPayments>>[number]
const termLabel = (s: { openedAt: Date; user: { name: string } } | null) => s ? `${s.user.name} · ${pktStamp(s.openedAt)}` : 'No drawer'
const PAYMENT_NOTE = 'Sales = money taken on the period’s sold orders; refunds = money handed back in the period (negative). Settle by = the owner of the drawer the payment went into. Comp is the No Charge value, not money.'
const PAYMENT_DETAIL_COLUMNS = [col('orderNo', 'Order No'), col('time', 'Time'), col('method', 'Method'), col('type', 'Type'), col('amountCents', 'Amount', 'cents'), col('orderBy', 'Order by'), col('settleBy', 'Settle by'), col('terminal', 'Terminal')]
const paymentDetailRow = (p: LoadedPayment): Record<string, Cell> => ({
  orderNo: orderRefOf(p.order.id), time: pktStamp(p.processedAt ?? p.createdAt), method: tenderLabel(p.method), type: p.status === 'refunded' ? 'Refund' : 'Sale',
  amountCents: p.amountCents, orderBy: p.order.posStaff?.name ?? '', settleBy: p.shift?.user.name ?? '', terminal: termLabel(p.shift),
})

async function paymentDetail(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const rows = (await loadPayments(input, def)).map(paymentDetailRow)
  notes.push(PAYMENT_NOTE)
  return [{ title: null, columns: PAYMENT_DETAIL_COLUMNS, rows, totals: { orderNo: 'TOTAL', time: `${rows.length} payments`, amountCents: sumKey(rows, 'amountCents') } }]
}

async function paymentSummary(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const pays = await loadPayments(input, def)
  const typeOfOrder = (o: { totalCents: number; fulfilmentType: string; payments: Array<{ amountCents: number }> }): OrderTypeKey => {
    const c = o.payments.reduce((s, p) => s + p.amountCents, 0)
    return c > 0 && c >= o.totalCents ? 'no_charge' : (o.fulfilmentType as OrderTypeKey)
  }
  const keyOf = (p: LoadedPayment): string => {
    switch (input.groupBy) {
      case 'payment_method': return tenderLabel(p.method)
      case 'payment_type': return p.status === 'refunded' ? 'Refund' : 'Sale'
      case 'order_by': return p.order.posStaff?.name ?? 'No user (online)'
      case 'settle_by': return p.shift?.user.name ?? 'No drawer'
      case 'terminal': return termLabel(p.shift)
      case 'order_type': return ORDER_TYPE_LABEL[typeOfOrder(p.order)]
    }
  }
  const groups = new Map<string, typeof pays>()
  for (const p of pays) { const k = keyOf(p); const g = groups.get(k); if (g) g.push(p); else groups.set(k, [p]) }
  const ordered = [...groups].sort((a, b) => byLabel(a[0], b[0]))
  const amountLabel = 'Amount'
  const rows = ordered.map(([group, list]) => ({ group, count: list.length, amountCents: list.reduce((s, p) => s + p.amountCents, 0) }))
  const sections: TillSection[] = [{
    title: null,
    columns: [col('group', GROUP_BY_LABEL[input.groupBy]), col('count', 'Count', 'number'), col('amountCents', amountLabel, 'cents')],
    rows, totals: { group: 'TOTAL', count: sumKey(rows, 'count'), amountCents: sumKey(rows, 'amountCents') },
  }]
  if (input.opts.has('detail')) {
    for (const [group, list] of ordered) {
      const drows = list.map(paymentDetailRow)
      sections.push({ title: group, columns: PAYMENT_DETAIL_COLUMNS, rows: drows, totals: { orderNo: 'TOTAL', amountCents: sumKey(drows, 'amountCents') } })
    }
  }
  notes.push(PAYMENT_NOTE)
  return sections
}

// ─── City ledger (on-account clients) ────────────────────────────────────────
//
// Owner, 2026-10-24 (the City Ledger Summary screenshot): POS bills closed on a
// City Ledger account only — receivables/cityLedgerReport.ts is the ONE reader
// (account figures from the client's history; bills as at the end of `to`).
// Account-wide: a client's balance covers every brand of its company, so the
// outlet picked only decides which companies' accounts are listed.

async function ledgerAccounts(input: TillReportInput) {
  return cityLedgerReport({
    tenantIds: input.tenantIds,
    accountIds: input.filters.clAccounts ?? null,
    accountTypes: has(input.filters.clAccountTypes) ? input.filters.clAccountTypes : null,
    q: input.filters.q ?? null,
    from: input.sq.from, to: input.sq.to,
    ignoreZero: input.opts.has('ignoreZero'),
  })
}

const CL_NOTE = 'POS bills closed on a City Ledger account only. Opening / closing = what the account owed at the start / end of the period; '
  + 'payments = City Ledger settlements and statement payments (net of reversals); adjustments = refunds and approved write-offs. '
  + 'Bill figures are as at the end of the period; a statement’s payments are shown against its bills oldest first.'

/** City Ledger Detail: one section per account — its transactions in the period with the running balance, opening and closing. */
async function cityLedgerDetail(input: TillReportInput, notes: string[]): Promise<TillSection[]> {
  const accounts = await ledgerAccounts(input)
  const columns = [col('date', 'Date'), col('type', 'Type'), col('reference', 'Reference'), col('voucher', 'Voucher'), col('debitCents', 'Debit', 'cents'), col('creditCents', 'Credit', 'cents'), col('balanceCents', 'Balance', 'cents'), col('createdBy', 'By'), col('status', 'Status')]
  const TYPE: Record<string, string> = { bill: 'Credit bill', refund: 'Refund', settlement: 'Settlement', settlement_reversed: 'Settlement reversed', pay_back: 'Paid back', pay_back_reversed: 'Pay-back reversed', statement_payment: 'Statement payment', statement_payment_reversed: 'Payment reversed', write_off: 'Write-off' }
  const sections: TillSection[] = []
  for (const a of accounts) {
    const rows: Array<Record<string, Cell>> = [{ date: '', type: 'Opening balance', reference: '', voucher: '', debitCents: null, creditCents: null, balanceCents: a.openingCents, createdBy: '', status: '' }]
    for (const r of a.rows) {
      rows.push({ date: pktStamp(r.at), type: TYPE[r.type] ?? r.type, reference: r.reference, voucher: r.voucher ?? '', debitCents: r.debitCents || null, creditCents: r.creditCents || null, balanceCents: r.balanceCents, createdBy: r.createdBy ?? '', status: r.status })
    }
    sections.push({
      title: `${a.account.number} · ${a.account.legalName} (${a.accountTypeLabel})`, columns, rows,
      totals: { date: 'TOTAL', type: 'Closing balance', debitCents: a.newBillsCents, creditCents: a.paymentsCents + a.adjustmentsCents, balanceCents: a.closingCents },
    })
  }
  notes.push(CL_NOTE)
  return sections.length ? sections : [{ title: null, columns, rows: [], totals: null }]
}

/** City Ledger Summary: account-wise totals, then every bill grouped by account. */
async function cityLedger(input: TillReportInput, notes: string[]): Promise<TillSection[]> {
  const accounts = await ledgerAccounts(input)
  const accRows: Array<Record<string, Cell>> = accounts.map((a) => ({
    code: a.account.number, name: a.account.legalName, type: a.accountTypeLabel,
    openingCents: a.openingCents, newBillsCents: a.newBillsCents, paymentsCents: a.paymentsCents, adjustmentsCents: a.adjustmentsCents,
    closingCents: a.closingCents, limitCents: a.creditLimitCents, availableCents: a.availableCents,
  }))
  const billRows: Array<Record<string, Cell>> = []
  for (const a of accounts) {
    for (const b of a.bills) {
      billRows.push({
        code: a.account.number, name: a.account.legalName, billNo: b.billNo, outlet: b.outlet, terminal: b.terminal, billAt: pktStamp(b.billAt),
        guest: b.guest, originalCents: b.originalCents, discountCents: b.discountCents, taxCents: b.taxCents, netCents: b.netCents,
        settledCents: b.settledCents + b.refundedCents, outstandingCents: b.outstandingCents, status: b.status, dueDate: b.dueDate,
        lastSettlement: b.lastSettlementAt ? pktStamp(b.lastSettlementAt) : '',
      })
    }
  }
  notes.push(CL_NOTE, 'Settled on a bill includes its refunds.')
  return [
    {
      title: 'Accounts',
      columns: [col('code', 'Account code'), col('name', 'Account name'), col('type', 'Type'), col('openingCents', 'Opening outstanding', 'cents'), col('newBillsCents', 'New credit bills', 'cents'),
        col('paymentsCents', 'Payments', 'cents'), col('adjustmentsCents', 'Adjustments', 'cents'), col('closingCents', 'Closing outstanding', 'cents'), col('limitCents', 'Credit limit', 'cents'), col('availableCents', 'Available credit', 'cents')],
      rows: accRows,
      totals: accRows.length ? { code: 'TOTAL', openingCents: sumKey(accRows, 'openingCents'), newBillsCents: sumKey(accRows, 'newBillsCents'), paymentsCents: sumKey(accRows, 'paymentsCents'), adjustmentsCents: sumKey(accRows, 'adjustmentsCents'), closingCents: sumKey(accRows, 'closingCents') } : null,
    },
    {
      title: 'Bills',
      columns: [col('code', 'Account code'), col('name', 'Account name'), col('billNo', 'POS bill no.'), col('outlet', 'Outlet'), col('terminal', 'Terminal'), col('billAt', 'Bill date & time'), col('guest', 'Guest / reference'),
        col('originalCents', 'Original amount', 'cents'), col('discountCents', 'Discounts', 'cents'), col('taxCents', 'Taxes', 'cents'), col('netCents', 'Net bill', 'cents'),
        col('settledCents', 'Settled', 'cents'), col('outstandingCents', 'Outstanding', 'cents'), col('status', 'Status'), col('dueDate', 'Due date'), col('lastSettlement', 'Last settlement')],
      rows: billRows,
      totals: billRows.length ? { code: 'TOTAL', netCents: sumKey(billRows, 'netCents'), settledCents: sumKey(billRows, 'settledCents'), outstandingCents: sumKey(billRows, 'outstandingCents') } : null,
    },
  ]
}

// ─── Stock ───────────────────────────────────────────────────────────────────

/** The selected brands' outlets: their ConceptLocation rows, inside the brands' companies. */
async function brandLocationIds(input: TillReportInput): Promise<string[]> {
  const rows = await prisma.conceptLocation.findMany({
    where: { conceptId: { in: input.conceptIds }, location: { tenantId: { in: input.tenantIds }, deletedAt: null } },
    select: { locationId: true },
  })
  return [...new Set(rows.map((r) => r.locationId))]
}

async function stockTransfers(input: TillReportInput, notes: string[]): Promise<TillSection[]> {
  const locs = await brandLocationIds(input)
  const f = input.filters
  const rows = await prisma.stockTransfer.findMany({
    where: {
      requestedAt: { gte: input.sq.from, lte: input.sq.to },
      OR: [{ fromLocationId: { in: locs } }, { toLocationId: { in: locs } }],
      // Both ends must sit in a company of the selected brands.
      fromLocation: { tenantId: { in: input.tenantIds } }, toLocation: { tenantId: { in: input.tenantIds } },
      ...(has(f.items) && { inventoryItemId: { in: f.items } }),
    },
    select: {
      requestedAt: true, quantity: true, receivedQuantity: true, unit: true, status: true,
      fromLocation: { select: { name: true } }, toLocation: { select: { name: true } }, inventoryItem: { select: { name: true, unitCostCents: true } },
    },
    orderBy: { requestedAt: 'asc' },
    take: MAX_ORDERS,
  })
  const out = rows.map((t) => {
    const qty = t.receivedQuantity ?? t.quantity
    return {
      date: pktStamp(t.requestedAt), from: t.fromLocation.name, to: t.toLocation.name, item: t.inventoryItem.name, qty, unit: t.unit,
      valueCents: t.inventoryItem.unitCostCents != null ? Math.round(qty * t.inventoryItem.unitCostCents) : null, status: t.status,
    }
  })
  notes.push('Transfers to or from the selected brands’ outlets, by request date. Qty = received quantity once received. Value = qty × the item’s current FIFO head cost (an estimate — transfers do not move lots yet).')
  return [{
    title: null,
    columns: [col('date', 'Date'), col('from', 'From'), col('to', 'To'), col('item', 'Item'), col('qty', 'Qty', 'number'), col('unit', 'Unit'), col('valueCents', 'Value', 'cents'), col('status', 'Status')],
    rows: out, totals: { date: 'TOTAL', from: `${out.length} transfers`, valueCents: sumKey(out, 'valueCents') },
  }]
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

async function stockItems(input: TillReportInput) {
  return prisma.inventoryItem.findMany({
    where: { tenantId: { in: input.tenantIds }, deletedAt: null, ...(has(input.filters.items) && { id: { in: input.filters.items } }) },
    select: { id: true, name: true, unit: true, category: true },
    orderBy: { name: 'asc' },
  })
}
const STOCK_NOTE = 'Stock is the company total of the selected brands’ companies (every outlet’s lots together; the food-cost report’s weekly variance shows one outlet).'

async function stockLedger(input: TillReportInput, notes: string[]): Promise<TillSection[]> {
  const items = await stockItems(input)
  const ids = items.map((i) => i.id)
  const base = { tenantId: { in: input.tenantIds }, inventoryItemId: { in: ids } }
  const [opening, ins, outs] = await Promise.all([
    prisma.stockMovement.groupBy({ by: ['inventoryItemId'], where: { ...base, occurredAt: { lt: input.sq.from } }, _sum: { qty: true, valueCents: true } }),
    prisma.stockMovement.groupBy({ by: ['inventoryItemId'], where: { ...base, occurredAt: { gte: input.sq.from, lte: input.sq.to }, qty: { gt: 0 } }, _sum: { qty: true, valueCents: true } }),
    prisma.stockMovement.groupBy({ by: ['inventoryItemId'], where: { ...base, occurredAt: { gte: input.sq.from, lte: input.sq.to }, qty: { lt: 0 } }, _sum: { qty: true, valueCents: true } }),
  ])
  const m = (g: typeof opening) => new Map(g.map((x) => [x.inventoryItemId, { qty: x._sum.qty ?? 0, value: sumCents(x._sum.valueCents) }]))
  const [o, i, x] = [m(opening), m(ins), m(outs)]
  const zero = { qty: 0, value: 0 }
  const rows = items.map((it) => {
    const a = o.get(it.id) ?? zero, b = i.get(it.id) ?? zero, c = x.get(it.id) ?? zero
    return {
      item: it.name, unit: it.unit, openingQty: round3(a.qty), inQty: round3(b.qty), outQty: round3(-c.qty), closingQty: round3(a.qty + b.qty + c.qty),
      openingCents: a.value, inCents: b.value, outCents: -c.value, closingCents: a.value + b.value + c.value,
    }
  }).filter((r) => r.openingQty !== 0 || r.inQty !== 0 || r.outQty !== 0 || r.closingQty !== 0 || r.closingCents !== 0)
  notes.push(STOCK_NOTE, 'From the stock movements (lib/stockLedger.ts): In = every movement adding stock, Out = every movement taking it.')
  return [{
    title: null,
    columns: [
      col('item', 'Item'), col('unit', 'Unit'), col('openingQty', 'Opening qty', 'number'), col('inQty', 'In qty', 'number'), col('outQty', 'Out qty', 'number'), col('closingQty', 'Closing qty', 'number'),
      col('openingCents', 'Opening value', 'cents'), col('inCents', 'In value', 'cents'), col('outCents', 'Out value', 'cents'), col('closingCents', 'Closing value', 'cents'),
    ],
    rows, totals: { item: 'TOTAL', openingCents: sumKey(rows, 'openingCents'), inCents: sumKey(rows, 'inCents'), outCents: sumKey(rows, 'outCents'), closingCents: sumKey(rows, 'closingCents') },
  }]
}

async function closingStock(input: TillReportInput, notes: string[]): Promise<TillSection[]> {
  const items = await stockItems(input)
  const g = await prisma.stockMovement.groupBy({
    by: ['inventoryItemId'], where: { tenantId: { in: input.tenantIds }, inventoryItemId: { in: items.map((i) => i.id) }, occurredAt: { lte: input.sq.to } }, _sum: { qty: true, valueCents: true },
  })
  const by = new Map(g.map((x) => [x.inventoryItemId, { qty: x._sum.qty ?? 0, value: sumCents(x._sum.valueCents) }]))
  const rows = items.map((it) => {
    const s = by.get(it.id) ?? { qty: 0, value: 0 }
    const qty = round3(s.qty)
    return { item: it.name, category: it.category ?? '', unit: it.unit, qty, valueCents: s.value, avgCostCents: qty > 0 ? Math.round(s.value / qty) : null }
  }).filter((r) => r.qty !== 0 || r.valueCents !== 0)
  notes.push(STOCK_NOTE, `Closing = the FIFO lots as at the end of ${fmtPktDate(input.sq.to)} (Σ lot movements up to then), valued at the price paid.`)
  return [{
    title: null,
    columns: [col('item', 'Item'), col('category', 'Category'), col('unit', 'Unit'), col('qty', 'Qty', 'number'), col('valueCents', 'Value', 'cents'), col('avgCostCents', 'Avg cost / unit', 'cents')],
    rows, totals: { item: 'TOTAL', valueCents: sumKey(rows, 'valueCents') },
  }]
}

// ─── Back office: settlement, discounts, tax, fiscal, drivers ───────────────

const CHANNEL_LABEL: Record<string, string> = { keenu: 'Pushed to Keenu', servd: 'Closed in servd', none: 'Online / other' }
const TENDER_COLS = ['cash', 'card', 'raast', 'on_account', 'comp', 'keenu_qr'] as const

async function settlementDetail(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const orders = await loadOrders(await scopedQuery(input, def, ncModeOf(input, def)), notes)
  const used = new Set<string>()
  const rows = orders.map((o) => {
    const by: Record<string, number> = {}
    for (const p of o.payments) { by[p.method] = (by[p.method] ?? 0) + p.amountCents; used.add(p.method) }
    const wallet = o.walletAmountCents, card = o.giftCardRedemptions.reduce((s, g) => s + g.amountCents, 0)
    if (wallet) used.add('wallet')
    if (card) used.add('gift_card')
    return {
      orderNo: orderRefOf(o.id), time: pktStamp(o.completedAt ?? o.placedAt), receiptNo: receiptNoOf(o), orderType: ORDER_TYPE_LABEL[typeOf(o)],
      orderBy: o.posStaff?.name ?? '', settleBy: [...new Set(o.payments.map((p) => p.shift?.user.name).filter(Boolean))].join(', '),
      channel: CHANNEL_LABEL[o.settlementChannel ?? 'none'], totalCents: o.totalCents + wallet + card,
      ...Object.fromEntries(TENDER_COLS.map((m) => [`${m}Cents`, by[m] ?? 0])), walletCents: wallet, gift_cardCents: card,
    } as Record<string, Cell>
  })
  const tenderCols = [...TENDER_COLS, 'wallet', 'gift_card'].filter((m) => used.has(m)).map((m) => col(`${m}Cents`, tenderLabel(m), 'cents'))
  const columns = [
    col('orderNo', 'Order No'), col('time', 'Time'), col('receiptNo', 'Receipt No'), col('orderType', 'Order type'), col('orderBy', 'Order by'), col('settleBy', 'Settle by'),
    col('channel', 'Closed by'), col('totalCents', 'Bill total', 'cents'), ...tenderCols,
  ]
  const keep = new Set(columns.map((c) => c.key))
  const trimmed = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))))
  notes.push('One row per sold bill: how it was settled — each tender’s amount, and whether it was pushed to Keenu or closed in servd. Bill total includes wallet and gift-card value.')
  return [{
    title: null, columns, rows: trimmed,
    totals: { orderNo: 'TOTAL', time: `${rows.length} bills`, totalCents: sumKey(rows, 'totalCents'), ...Object.fromEntries(tenderCols.map((c) => [c.key, sumKey(rows, c.key)])) },
  }]
}

/** Settlement Summary = THE engine's tender split (salesByTender) and channel split (salesBySettlement), with the till's filters. */
async function settlementSummary(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const sq = await scopedQuery(input, def, ncModeOf(input, def))
  const [t, ch] = await Promise.all([salesByTender(sq), salesBySettlement({ ...sq, settlement: 'all' })])
  const tRows: Array<Record<string, Cell>> = t.tenders.map((x) => ({ tender: x.label, orders: x.orders, payments: x.payments, amountCents: x.amountCents }))
  const tenderTotal = { tender: 'TOTAL', orders: null, payments: sumKey(tRows, 'payments'), amountCents: t.totalCents }
  if (t.comp.orders > 0) tRows.push({ tender: 'No Charge (comp)', orders: t.comp.orders, payments: null, amountCents: t.comp.amountCents })
  for (const r of t.refunds) tRows.push({ tender: `Refunds — ${r.label}`, orders: null, payments: r.count, amountCents: -r.amountCents })
  const cRows = ch.rows.map((x) => ({ channel: CHANNEL_LABEL[x.settlement] ?? x.settlement, orders: x.orders, grossCents: x.gross, taxCents: x.tax, netCents: x.net }))
  notes.push('Tenders: money taken on the period’s sold orders (comp and refunds listed apart, outside the total). Channels: the sales engine’s split by how the bill was closed.')
  return [
    { title: 'By tender', columns: [col('tender', 'Tender'), col('orders', 'Orders', 'number'), col('payments', 'Payments', 'number'), col('amountCents', 'Amount', 'cents')], rows: tRows, totals: tenderTotal },
    {
      title: 'By channel', columns: [col('channel', 'Closed by'), col('orders', 'Orders', 'number'), col('grossCents', 'Sales incl. GST', 'cents'), col('taxCents', 'GST', 'cents'), col('netCents', 'Net ex-GST', 'cents')],
      rows: cRows, totals: { channel: 'TOTAL', orders: ch.combined.orders, grossCents: ch.combined.gross, taxCents: ch.combined.tax, netCents: ch.combined.net },
    },
  ]
}

async function discountDetail(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const sq = await scopedQuery(input, def, 'any')
  const orders = await loadOrders({ ...sq, extra: { AND: [...(sq.extra ? [sq.extra] : []), { OR: [{ discountCents: { gt: 0 } }, { promoDiscountCents: { gt: 0 } }] }] } }, notes)
  // A discount above the cashier's cap raises an exception flag carrying the reason the cashier typed (pos/service.ts).
  const flags = orders.length ? await prisma.exceptionFlag.findMany({
    where: { kind: 'discount_above_cap', entityType: 'Order', entityId: { in: orders.map((o) => o.id) }, tenantId: { in: input.tenantIds } },
    select: { entityId: true, metadata: true },
  }) : []
  const reasons = new Map(flags.map((f) => [f.entityId!, (f.metadata as { reason?: string } | null)?.reason ?? '']))
  const rows = orders.map((o) => {
    const gross = linesOf(o).reduce((s, l) => s + l.gross, 0)
    return {
      orderNo: orderRefOf(o.id), time: pktStamp(o.completedAt ?? o.placedAt), orderType: ORDER_TYPE_LABEL[typeOf(o)], table: o.table?.label ?? '',
      user: o.posStaff?.name ?? '', waiter: o.waiter?.fullName ?? '', grossCents: gross, discountCents: o.discountCents, promoCents: o.promoDiscountCents,
      promoCode: o.promoCode?.code ?? '', pct: gross > 0 ? Math.round(((o.discountCents + o.promoDiscountCents) / gross) * 1000) / 10 : null,
      reason: reasons.get(o.id) ?? '', billCents: o.totalCents,
    } as Record<string, Cell>
  })
  notes.push('Discount % is of the menu-price value. A reason is shown where the discount was above the cashier’s cap (the till records it on the review flag); servd does not store an approver per discount.')
  return [{
    title: null,
    columns: [
      col('orderNo', 'Order No'), col('time', 'Time'), col('orderType', 'Order type'), col('table', 'R/T No'), col('user', 'User'), col('waiter', 'Waiter'),
      col('grossCents', 'Gross', 'cents'), col('discountCents', 'Discount', 'cents'), col('promoCents', 'Promo discount', 'cents'), col('promoCode', 'Promo code'),
      col('pct', 'Discount %', 'number'), col('reason', 'Reason'), col('billCents', 'Bill', 'cents'),
    ],
    rows, totals: { orderNo: 'TOTAL', time: `${rows.length} orders`, grossCents: sumKey(rows, 'grossCents'), discountCents: sumKey(rows, 'discountCents'), promoCents: sumKey(rows, 'promoCents'), billCents: sumKey(rows, 'billCents') },
  }]
}

/** The tax class a bill was charged at: lib/pricing.ts tenderOfPayments over its money tenders (comp left out). */
function taxClassOf(o: SoldOrder): 'cash' | 'card' {
  const methods: string[] = o.payments.filter((p) => p.method !== 'comp').map((p) => p.method)
  if (o.walletAmountCents > 0) methods.push('wallet')
  return tenderOfPayments(methods)
}
/** Value ex-GST and ex-tip (the taxable value of the bill as charged). */
const taxableOf = (o: SoldOrder) => o.totalCents + o.walletAmountCents + o.giftCardRedemptions.reduce((s, g) => s + g.amountCents, 0) - o.taxCents - o.tipCents

async function taxCollection(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const orders = await loadOrders(await scopedQuery(input, def, ncModeOf(input, def)), notes)
  const brands = new Map((await prisma.concept.findMany({ where: { id: { in: input.conceptIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]))
  const by = new Map<string, Record<string, Cell> & { cashOrders: number; cashTaxableCents: number; cashTaxCents: number; cardOrders: number; cardTaxableCents: number; cardTaxCents: number }>()
  for (const o of orders) {
    const day = fmtPktDate(o.completedAt ?? o.placedAt)
    const k = `${day}\u0000${o.conceptId}`
    const s = by.get(k) ?? { date: day, brand: brands.get(o.conceptId) ?? '', cashOrders: 0, cashTaxableCents: 0, cashTaxCents: 0, cardOrders: 0, cardTaxableCents: 0, cardTaxCents: 0 }
    const c = taxClassOf(o)
    s[`${c}Orders`] += 1; s[`${c}TaxableCents`] += taxableOf(o); s[`${c}TaxCents`] += o.taxCents
    by.set(k, s)
  }
  const rows = [...by.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.brand).localeCompare(String(b.brand)))
    .map((r) => ({ ...r, totalTaxCents: r.cashTaxCents + r.cardTaxCents }))
  const keys = ['cashOrders', 'cashTaxableCents', 'cashTaxCents', 'cardOrders', 'cardTaxableCents', 'cardTaxCents', 'totalTaxCents']
  notes.push('GST as charged on each bill (Order.taxCents, incl. the delivery fee’s GST). Cash rate = bills settled in cash or a mix; card / Raast rate = bills settled wholly by card, Raast or wallet (lib/pricing.ts). Taxable = the bill ex-GST and ex-tip. Refunds are not netted here.')
  return [{
    title: null,
    columns: [
      col('date', 'Date'), col('brand', 'Brand'), col('cashOrders', 'Cash-rate bills', 'number'), col('cashTaxableCents', 'Cash-rate taxable', 'cents'), col('cashTaxCents', 'GST at cash rate', 'cents'),
      col('cardOrders', 'Card/Raast bills', 'number'), col('cardTaxableCents', 'Card/Raast taxable', 'cents'), col('cardTaxCents', 'GST at card/Raast rate', 'cents'), col('totalTaxCents', 'Total GST', 'cents'),
    ],
    rows, totals: { date: 'TOTAL', ...Object.fromEntries(keys.map((k) => [k, sumKey(rows, k)])) },
  }]
}

async function taxAnalysis(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const orders = await loadOrders(await scopedQuery(input, def, ncModeOf(input, def)), notes)
  const by = new Map<string, { rate: string; orders: number; taxable: number; tax: number; total: number }>()
  for (const o of orders) {
    const rate = o.taxRatePct != null ? `${o.taxRatePct}%` : o.taxCents > 0 ? 'Not recorded' : '0%'
    const s = by.get(rate) ?? { rate, orders: 0, taxable: 0, tax: 0, total: 0 }
    s.orders++; s.taxable += taxableOf(o); s.tax += o.taxCents; s.total += taxableOf(o) + o.taxCents
    by.set(rate, s)
  }
  const rows = [...by.values()].sort((a, b) => byLabel(a.rate, b.rate)).map((s) => ({ rate: s.rate, orders: s.orders, taxableCents: s.taxable, taxCents: s.tax, totalCents: s.total }))
  notes.push('By the GST rate stored on each bill (Order.taxRatePct). Taxable = the bill ex-GST and ex-tip; Total = taxable + GST.')
  return [{
    title: null,
    columns: [col('rate', 'GST rate'), col('orders', 'Bills', 'number'), col('taxableCents', 'Taxable value', 'cents'), col('taxCents', 'GST', 'cents'), col('totalCents', 'Total', 'cents')],
    rows, totals: { rate: 'TOTAL', orders: sumKey(rows, 'orders'), taxableCents: sumKey(rows, 'taxableCents'), taxCents: sumKey(rows, 'taxCents'), totalCents: sumKey(rows, 'totalCents') },
  }]
}

async function categoryTax(input: TillReportInput, def: TillReportDef, notes: string[]): Promise<TillSection[]> {
  const orders = await loadOrders(await scopedQuery(input, def, ncModeOf(input, def)), notes)
  const keep = lineFilter(input.filters, def.filters)
  // "Sub category" ticked (2026-10-22): one row per main category › sub category.
  const bySub = input.opts.has('subCategory')
  const by = new Map<string, { category: string; subCategory: string; qty: number; gross: number; discount: number; tax: number }>()
  for (const o of orders) for (const l of linesOf(o)) {
    if (!keep(l)) continue
    const k = bySub ? `${l.category}\u0000${l.subCategory}` : l.category
    const s = by.get(k) ?? { category: l.category, subCategory: bySub ? l.subCategory : '', qty: 0, gross: 0, discount: 0, tax: 0 }
    s.qty += l.qty; s.gross += l.gross; s.discount += l.discount; s.tax += l.tax
    by.set(k, s)
  }
  const rows = [...by.values()].sort((a, b) => byLabel(a.category, b.category) || byLabel(a.subCategory, b.subCategory))
    .map((s) => ({ category: s.category, ...(bySub && { subCategory: s.subCategory }), qty: s.qty, grossCents: s.gross, discountCents: s.discount, taxableCents: s.gross - s.discount, taxCents: s.tax }))
  notes.push('Each bill’s GST (less the delivery fee’s GST) is shared across its lines by value after discount (lib/pricing.ts allocateTaxCents), then summed per category.')
  return [{
    title: null,
    columns: [col('category', 'Category'), ...(bySub ? [col('subCategory', 'Sub category')] : []), col('qty', 'Qty', 'number'), col('grossCents', 'Gross', 'cents'), col('discountCents', 'Discount', 'cents'), col('taxableCents', 'Taxable value', 'cents'), col('taxCents', 'GST', 'cents')],
    rows, totals: { category: 'TOTAL', ...Object.fromEntries(['qty', 'grossCents', 'discountCents', 'taxableCents', 'taxCents'].map((k) => [k, sumKey(rows, k)])) },
  }]
}

async function fiscalDocs(input: TillReportInput, notes: string[]): Promise<TillSection[]> {
  const q = input.filters.q?.trim()
  const docs = await prisma.fiscalDocument.findMany({
    where: {
      tenantId: { in: input.tenantIds }, conceptId: { in: input.conceptIds }, createdAt: { gte: input.sq.from, lte: input.sq.to },
      ...(q && { OR: [{ fiscalNumber: { contains: q, mode: 'insensitive' } }, { orderId: { endsWith: q.toLowerCase() } }] }),
    },
    select: { orderId: true, kind: true, status: true, statusReason: true, fiscalNumber: true, authority: true, amountCents: true, createdAt: true, filedAt: true, isTest: true, order: { select: { settlementChannel: true } } },
    orderBy: { createdAt: 'asc' },
    take: MAX_ORDERS,
  })
  const rows = docs.map((d) => ({
    date: pktStamp(d.createdAt), orderNo: orderRefOf(d.orderId), kind: d.kind === 'sale' ? 'Sale' : 'Refund', channel: CHANNEL_LABEL[d.order.settlementChannel ?? 'none'],
    status: d.status, reason: d.statusReason ?? '', fiscalNumber: d.fiscalNumber ?? '', authority: (d.authority ?? '').toUpperCase(),
    filedAt: pktStamp(d.filedAt), test: d.isTest ? 'Test' : '', amountCents: d.amountCents,
  }))
  notes.push('Fiscal documents created in the period. With SRB direct (servd files itself) bills closed in servd are filed automatically like any other; under a fiscal POS driver — and for rows from before the switch — they are manual_required / servd_channel, filed by hand on the SRB / FBR portal.')
  return [{
    title: null,
    columns: [
      col('date', 'Date'), col('orderNo', 'Order No'), col('kind', 'Kind'), col('channel', 'Closed by'), col('status', 'Status'), col('reason', 'Reason'),
      col('fiscalNumber', 'Fiscal number'), col('authority', 'Authority'), col('filedAt', 'Filed'), col('test', 'Test'), col('amountCents', 'Amount', 'cents'),
    ],
    rows, totals: { date: 'TOTAL', orderNo: `${rows.length} documents`, amountCents: sumKey(rows, 'amountCents') },
  }]
}

const minutesBetween = (a: Date | null, b: Date | null) => (a && b && b.getTime() >= a.getTime() ? (b.getTime() - a.getTime()) / 60_000 : null)
const avg = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x != null && x <= 600); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null }

/** Own-fleet riders: the sold delivery orders of the selected brands that a rider carried (Order.riderId + its timestamps). */
async function drivers(input: TillReportInput, notes: string[], mode: 'efficiency' | 'deliveries'): Promise<TillSection[]> {
  const q = input.filters.q?.trim()
  const orders = await prisma.order.findMany({
    where: {
      AND: [soldOrderWhere(input.sq), { riderId: { not: null } },
        ...(q && mode === 'deliveries' ? [{ OR: [{ id: { endsWith: q.toLowerCase() } }, { rider: { name: { contains: q, mode: 'insensitive' as const } } }] }] : [])],
    },
    select: { id: true, riderId: true, totalCents: true, placedAt: true, riderAssignedAt: true, riderAcceptedAt: true, pickedUpAt: true, deliveredAt: true, completedAt: true, deliveryOtpVerifiedAt: true, rider: { select: { name: true } } },
    orderBy: { placedAt: 'asc' },
    take: MAX_ORDERS,
  })
  const doneAt = (o: (typeof orders)[number]) => o.deliveredAt ?? o.deliveryOtpVerifiedAt ?? o.completedAt
  if (mode === 'deliveries') {
    const rows = orders.map((o) => ({
      orderNo: orderRefOf(o.id), rider: o.rider?.name ?? '', placed: pktStamp(o.placedAt), assigned: pktStamp(o.riderAssignedAt), pickedUp: pktStamp(o.pickedUpAt), delivered: pktStamp(doneAt(o)),
      toPickupMin: minutesBetween(o.riderAssignedAt, o.pickedUpAt) != null ? Math.round(minutesBetween(o.riderAssignedAt, o.pickedUpAt)! * 10) / 10 : null,
      onRoadMin: minutesBetween(o.pickedUpAt, doneAt(o)) != null ? Math.round(minutesBetween(o.pickedUpAt, doneAt(o))! * 10) / 10 : null,
      totalMin: minutesBetween(o.placedAt, doneAt(o)) != null ? Math.round(minutesBetween(o.placedAt, doneAt(o))! * 10) / 10 : null,
      billCents: o.totalCents,
    }))
    notes.push('Minutes: assigned → picked up, picked up → delivered, and placed → delivered (the hand-over code time when there is one).')
    return [{
      title: null,
      columns: [
        col('orderNo', 'Order No'), col('rider', 'Rider'), col('placed', 'Placed'), col('assigned', 'Assigned'), col('pickedUp', 'Picked up'), col('delivered', 'Delivered'),
        col('toPickupMin', 'To pick-up (min)', 'number'), col('onRoadMin', 'On the road (min)', 'number'), col('totalMin', 'Total (min)', 'number'), col('billCents', 'Bill', 'cents'),
      ],
      rows, totals: { orderNo: 'TOTAL', rider: `${rows.length} deliveries`, billCents: sumKey(rows, 'billCents') },
    }]
  }
  // Offers a rider turned down or let time out, on these brands' orders in the period (RiderJobEvent, the order's company).
  const events = await prisma.riderJobEvent.groupBy({
    by: ['riderId', 'type'],
    where: { tenantId: { in: input.tenantIds }, type: { in: ['offered', 'declined', 'timed_out'] }, createdAt: { gte: input.sq.from, lte: input.sq.to }, order: { conceptId: { in: input.conceptIds } } },
    _count: { _all: true },
  })
  const riderIds = [...new Set([...orders.map((o) => o.riderId!), ...events.map((e) => e.riderId)])]
  const names = new Map((await prisma.rider.findMany({ where: { id: { in: riderIds } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]))
  const ev = (rid: string, t: string) => events.find((e) => e.riderId === rid && e.type === t)?._count._all ?? 0
  const rows = riderIds.map((rid) => {
    const mine = orders.filter((o) => o.riderId === rid)
    return {
      rider: names.get(rid) ?? 'Unknown rider', deliveries: mine.length, offers: ev(rid, 'offered'), declined: ev(rid, 'declined'), timedOut: ev(rid, 'timed_out'),
      avgAcceptMin: avg(mine.map((o) => minutesBetween(o.riderAssignedAt, o.riderAcceptedAt))),
      avgToPickupMin: avg(mine.map((o) => minutesBetween(o.riderAssignedAt, o.pickedUpAt))),
      avgOnRoadMin: avg(mine.map((o) => minutesBetween(o.pickedUpAt, doneAt(o)))),
      avgTotalMin: avg(mine.map((o) => minutesBetween(o.placedAt, doneAt(o)))),
      billsCents: mine.reduce((s, o) => s + o.totalCents, 0),
    }
  }).sort((a, b) => b.deliveries - a.deliveries || byLabel(a.rider, b.rider))
  notes.push('Per rider: deliveries of the selected brands’ sold orders, offers / declines / time-outs (rider job events), and average minutes (assigned → accepted, → picked up, picked up → delivered, placed → delivered). Times over 10 hours are left out.')
  return [{
    title: null,
    columns: [
      col('rider', 'Rider'), col('deliveries', 'Deliveries', 'number'), col('offers', 'Offers', 'number'), col('declined', 'Declined', 'number'), col('timedOut', 'Timed out', 'number'),
      col('avgAcceptMin', 'Avg to accept (min)', 'number'), col('avgToPickupMin', 'Avg to pick-up (min)', 'number'), col('avgOnRoadMin', 'Avg on the road (min)', 'number'),
      col('avgTotalMin', 'Avg total (min)', 'number'), col('billsCents', 'Bills delivered', 'cents'),
    ],
    rows, totals: { rider: 'TOTAL', deliveries: sumKey(rows, 'deliveries'), offers: sumKey(rows, 'offers'), declined: sumKey(rows, 'declined'), timedOut: sumKey(rows, 'timedOut'), billsCents: sumKey(rows, 'billsCents') },
  }]
}

// ─── Export ──────────────────────────────────────────────────────────────────

/** A report as ONE ReportTable: one section = its table; several = a `Section` column over the union of columns. */
export function tillReportTable(r: TillReport): ReportTable {
  const typeOf = (c: TillColumn): ReportColumn['type'] => c.type
  const notes = r.notes.length ? r.notes : undefined
  const period = `${r.period}${r.outlets.length ? ` — ${r.outlets.join(', ')}` : ''}`
  const totalRow = (s: TillSection): ReportRow | null => {
    if (!s.totals) return null
    const first = s.columns[0]!.key
    return { ...s.totals, [first]: s.totals[first] ?? 'TOTAL' }
  }
  const isTotal = (row: ReportRow) => Object.values(row).some((v) => v === 'TOTAL')
  if (r.sections.length === 1) {
    const s = r.sections[0]!
    const t = totalRow(s)
    return { title: r.title, period, columns: s.columns.map((c) => ({ key: c.key, label: c.label, type: typeOf(c) })), rows: [...s.rows, ...(t ? [t] : [])], isTotal, notes }
  }
  const columns: ReportColumn[] = [{ key: '_section', label: 'Section', type: 'text' }]
  for (const s of r.sections) for (const c of s.columns) if (!columns.some((x) => x.key === c.key)) columns.push({ key: c.key, label: c.label, type: typeOf(c) })
  const rows: ReportRow[] = []
  for (const s of r.sections) {
    const title = s.title ?? r.title
    for (const row of s.rows) rows.push({ _section: title, ...row })
    const t = totalRow(s)
    if (t) rows.push({ _section: title, ...t })
  }
  // PDF: each section with its own columns, in line and centred (owner, 2026-10-24).
  const columnsBySection: Record<string, ReportColumn[]> = {}
  for (const s of r.sections) columnsBySection[s.title ?? r.title] = s.columns.map((c) => ({ key: c.key, label: c.label, type: typeOf(c) }))
  return { title: r.title, period, columns, rows, sectionKey: '_section', columnsBySection, isTotal, notes }
}

/** Shared by the route's lookups. */
export const STATIC_LOOKUPS = {
  clAccountTypes: ACCOUNT_TYPES.map((id) => ({ id, label: ACCOUNT_TYPE_LABEL[id] })),
  sources: SOURCES.map((id) => ({ id, label: SOURCE_LABEL[id]! })),
  paymentMethods: PAYMENT_METHODS.map((id) => ({ id, label: tenderLabel(id) })),
  orderTypes: ORDER_TYPES.map((id) => ({ id, label: ORDER_TYPE_LABEL[id] })),
}
export const terminalLabel = (s: { openedAt: Date; user: { name: string } }) => `${s.user.name} · ${pktStamp(s.openedAt)}`
