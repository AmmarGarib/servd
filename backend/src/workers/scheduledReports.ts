// Scheduled reports cron consumer.
// Tick every minute, find ScheduledReport rows whose `cron` matches the
// current minute, run the appropriate report, email it to recipients.
//
// We use node-cron only as a tick driver — actual schedule matching happens
// against each ScheduledReport.cron expression so we don't have to reload
// schedules from DB on each operator change.

import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { sendEmail } from '../lib/notify.js'
import { shiftOfCompany } from '../lib/tenantScope.js'
import { getZReport } from '../modules/pos/service.js'
import { salesTotals, topItems, salesByChannel, type SalesQuery } from '../modules/reports/service.js'
import { fmtPktDate, parsePktStartOfDay, parsePktEndOfDay } from '../modules/accounting/dates.js'

type ReportType = 'sales_daily' | 'shift_summary' | 'low_stock' | 'food_cost' | 'ap_aging' | 'menu_engineering'

const RUNNING = new Set<string>()  // dedupe concurrent ticks for the same row

export function startScheduledReportsWorker(): void {
  // Tick at the top of every minute. node-cron handles scheduling at the tick
  // level; per-report cron matching uses a tiny matcher below.
  cron.schedule('* * * * *', () => { void tick() })
  console.log('[scheduledReports] worker started — ticking every minute')
}

async function tick(): Promise<void> {
  const now = new Date()
  const reports = await prisma.scheduledReport.findMany({
    where: { isActive: true, deletedAt: null },
  })
  for (const r of reports) {
    if (!matchesCron(r.cron, now)) continue
    if (RUNNING.has(r.id)) continue
    RUNNING.add(r.id)
    // Every report runs for ONE company: the brand's, or for "all brands"
    // schedules the company that owns the schedule. A schedule with no
    // company at all (pre-migration row) is skipped rather than emailed
    // org-wide.
    if (!r.tenantId) { console.warn(`[scheduledReports] ${r.id} has no company — skipped`); continue }
    void run(r.id, r.reportType as ReportType, r.recipients, r.conceptId, r.tenantId, r.name, r.lastRunAt)
      .catch((err) => console.warn(`[scheduledReports] ${r.id} failed:`, (err as Error).message))
      .finally(() => RUNNING.delete(r.id))
  }
}

async function run(
  id: string,
  reportType: ReportType,
  recipients: string[],
  conceptId: string | null,
  tenantId: string,
  name: string,
  lastRunAt: Date | null,
): Promise<void> {
  let html = ''
  let subject = `[servd] ${name}`
  let send = true
  try {
    if (reportType === 'sales_daily') {
      ({ subject, html } = await buildDailySalesReport(conceptId, tenantId))
    } else if (reportType === 'shift_summary') {
      const report = await buildShiftSummaryReport(tenantId, lastRunAt)
      if (report) ({ subject, html } = report)
      else send = false                                    // no drawer closed since the last run
    } else if (reportType === 'low_stock') {
      ({ subject, html } = await buildLowStockReport(tenantId))
    } else if (reportType === 'ap_aging') {
      ({ subject, html } = await buildApAgingReport(tenantId))
    } else {
      // Stub for food_cost / menu_engineering — wire to real computers once
      // their report endpoints stabilise.
      html = `<p>Report ${reportType} is queued but not yet implemented.</p>`
    }
    if (send) await Promise.all(recipients.map((to) => sendEmail(to, subject, html)))
    await prisma.scheduledReport.update({
      where: { id },
      data: { lastRunAt: new Date(), lastStatus: send ? 'success' : 'success: nothing to send' },
    })
  } catch (err) {
    await prisma.scheduledReport.update({
      where: { id },
      data: { lastRunAt: new Date(), lastStatus: `failed: ${(err as Error).message.slice(0, 200)}` },
    }).catch(() => {})
    throw err
  }
}

// ─── Cron matcher ────────────────────────────────────────────────────────────
// Supports the standard 5-field cron: `minute hour dayOfMonth month dayOfWeek`.
// Each field can be `*`, a number, a comma list, or a step expression `*/N`.

function matchesCron(expr: string, d: Date): boolean {
  const parts = expr.split(/\s+/)
  if (parts.length !== 5) return false
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string]
  return (
    matchField(m,   d.getMinutes(),     0, 59) &&
    matchField(h,   d.getHours(),       0, 23) &&
    matchField(dom, d.getDate(),        1, 31) &&
    matchField(mon, d.getMonth() + 1,   1, 12) &&
    matchField(dow, d.getDay(),         0, 6)
  )
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10)
      if (step > 0 && (value - min) % step === 0) return true
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number) as [number, number]
      if (value >= a && value <= b) return true
    } else {
      if (parseInt(part, 10) === value) return true
    }
  }
  return false
}

// ─── Report builders ─────────────────────────────────────────────────────────

/**
 * The daily sales email — the ONE daily sales sender. (A second one, the
 * dailyDigest worker, mailed every company's orders blended into one email
 * to an env-var address; it is gone, and its top items and channel breakdown
 * live here now.) Yesterday in PKT, for one brand or every brand of one
 * company, from the same sales-register functions as /reports/sales — so the
 * email matches the dashboard: completed orders; "sales" is what customers
 * paid, incl. GST and service charge, after discounts. (Both old emails
 * showed "Net = total − discount", taking the discount off twice.)
 */
export async function buildDailySalesReport(conceptId: string | null, tenantId: string, now = new Date()): Promise<{ subject: string; html: string }> {
  const pktToday = fmtPktDate(now)
  const day = new Date(new Date(`${pktToday}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10)
  const q: SalesQuery = {
    company: { tenantId },
    // One brand, or every brand of this company — never another company's.
    conceptId,
    from: parsePktStartOfDay(day),
    to: parsePktEndOfDay(day),
  }
  const [totals, top, channels] = await Promise.all([salesTotals(q), topItems(q, 5), salesByChannel(q)])

  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!))
  const dateLabel = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })

  const topRows = top.length === 0
    ? '<tr><td colspan="3">No items sold.</td></tr>'
    : top.map((t) => `<tr><td>#${t.rank}</td><td>${esc(t.name)}</td><td>${t.quantity}×</td></tr>`).join('')
  const channelRows = channels.length === 0
    ? '<tr><td colspan="3">No orders.</td></tr>'
    : channels.map((c) => `<tr><td>${esc(c.source)}</td><td>${c.orders} orders</td><td>${fmt(c.gross)}</td></tr>`).join('')

  return {
    subject: `Daily sales — ${dateLabel}`,
    html: `
      <h2>Daily sales — ${dateLabel}</h2>
      <p><strong>${totals.orders}</strong> completed orders</p>
      <ul>
        <li><strong>Sales: ${fmt(totals.gross)}</strong> <small>(what customers paid, incl. GST and service charge, after discounts)</small></li>
        <li>Discounts given: ${fmt(totals.discount)}</li>
        <li>Sales tax on these orders: ${fmt(totals.tax)}</li>
      </ul>
      <h3>Top items</h3>
      <table cellpadding="6" border="1" style="border-collapse:collapse">${topRows}</table>
      <h3>By channel</h3>
      <table cellpadding="6" border="1" style="border-collapse:collapse">${channelRows}</table>
      <p><small>Sales-register figures. The books (P&amp;L, sales-tax return) are in Accounting.</small></p>`,
  }
}

/**
 * One-time carry-over from the retired dailyDigest worker: when the box still
 * has DIGEST_EMAIL (or, as the digest fell back to, SMTP_FROM) set, give every
 * company a "Daily sales" schedule to that address at the digest's old time
 * (00:05). Skipped for a company that already has — or ever had, even if
 * since deleted — a sales_daily schedule, so an operator's own schedule or
 * deletion is never overridden. Returns the companies it created one for.
 */
export async function carryOverDigestRecipient(): Promise<string[]> {
  const recipient = (process.env['DIGEST_EMAIL'] ?? process.env['SMTP_FROM'] ?? '').trim()
  // SMTP_FROM may be "Name <addr>" — take the address.
  const address = recipient.match(/<([^>]+)>/)?.[1] ?? recipient
  if (!address || !address.includes('@')) return []
  const companies = await prisma.tenant.findMany({ where: { isActive: true, deletedAt: null }, select: { id: true, slug: true } })
  const created: string[] = []
  for (const c of companies) {
    const existing = await prisma.scheduledReport.findFirst({ where: { tenantId: c.id, reportType: 'sales_daily' }, select: { id: true } })
    if (existing) continue
    await prisma.scheduledReport.create({
      data: {
        tenantId: c.id, name: 'Daily sales', reportType: 'sales_daily', cron: '5 0 * * *',
        recipients: [address], conceptId: null,
        notes: 'Carried over from the retired daily digest (DIGEST_EMAIL). Edit or delete here.',
      },
    })
    created.push(c.slug)
  }
  return created
}

/**
 * The end-of-shift summary IS the Z-report (pos/service.ts getZReport) — the
 * same figures the cashier counted against and the ledger posted. One section
 * per drawer of this company closed since the schedule last ran (the last 24
 * hours on a first run). Drawers belong to a company, not a brand, so a
 * schedule's brand filter does not apply. Null when nothing closed.
 */
export async function buildShiftSummaryReport(tenantId: string, since: Date | null): Promise<{ subject: string; html: string } | null> {
  const from = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000)
  const shifts = await prisma.shift.findMany({
    where: { status: 'closed', closedAt: { gt: from }, ...shiftOfCompany({ tenantId }) },
    select: { id: true },
    orderBy: { closedAt: 'asc' },
    take: 100,
  })
  if (shifts.length === 0) return null

  const fmt = (c: number | null) => c === null ? '—' : `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
  const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!))
  const sections: string[] = []
  let unbalanced = 0
  for (const s of shifts) {
    const z = await getZReport(s.id)
    if (!z.isBalanced) unbalanced++
    const closed = z.closedAt ? new Date(z.closedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
    sections.push(`
      <h3>${esc(z.staffName)} — closed ${closed}</h3>
      <table cellpadding="6" border="1" style="border-collapse:collapse">
        <tr><td>Orders</td><td>${z.ordersCount}</td></tr>
        <tr><td>Gross (cash + card)</td><td>${fmt(z.grossCents)}</td></tr>
        <tr><td>Refunds</td><td>${fmt(z.refundsCents)}</td></tr>
        <tr><td>Comps</td><td>${fmt(z.compCents)}</td></tr>
        <tr><td>Discounts</td><td>${fmt(z.discountCents)}</td></tr>
        <tr><td>Tax</td><td>${fmt(z.taxCents)}</td></tr>
        <tr><td>Opening float</td><td>${fmt(z.openingFloatCents)}</td></tr>
        <tr><td>Drops / pay-outs</td><td>${fmt(z.cashMovements.drops)} / ${fmt(z.cashMovements.payouts)}</td></tr>
        <tr><td>Adds / pay-ins</td><td>${fmt(z.cashMovements.adds)} / ${fmt(z.cashMovements.payins)}</td></tr>
        <tr><td><strong>Expected cash</strong></td><td><strong>${fmt(z.expectedCashCents)}</strong></td></tr>
        <tr><td>Counted</td><td>${fmt(z.closingFloatCents)}</td></tr>
        <tr><td><strong>Variance</strong></td><td><strong>${fmt(z.varianceCents)}</strong> ${z.isBalanced ? '(within tolerance)' : `(outside the ${fmt(z.varianceLimitCents)} tolerance)`}</td></tr>
      </table>`)
  }
  return {
    subject: `[servd] ${shifts.length} shift(s) closed${unbalanced > 0 ? ` — ${unbalanced} outside tolerance` : ''}`,
    html: `<h2>Shift summary</h2>${sections.join('')}`,
  }
}

async function buildLowStockReport(tenantId: string): Promise<{ subject: string; html: string }> {
  const items = await prisma.inventoryItem.findMany({
    where: {
      deletedAt: null,
      tenantId,
      currentStock: { lte: prisma.inventoryItem.fields.parLevel },
    },
    select: { name: true, currentStock: true, parLevel: true, unit: true },
    take: 50,
  })

  if (items.length === 0) {
    return { subject: '[servd] All inventory above par', html: `<p>No items below par. Nice.</p>` }
  }

  return {
    subject: `[servd] ${items.length} item(s) below par`,
    html: `
      <h2>Low stock alert</h2>
      <table cellpadding="6" border="1" style="border-collapse:collapse">
        <tr><th>Item</th><th>On hand</th><th>Par</th><th>Unit</th></tr>
        ${items.map((i) => `<tr><td>${i.name}</td><td>${i.currentStock}</td><td>${i.parLevel}</td><td>${i.unit}</td></tr>`).join('')}
      </table>`,
  }
}

async function buildApAgingReport(tenantId: string): Promise<{ subject: string; html: string }> {
  const bills = await prisma.supplierBill.findMany({
    where: { status: { not: 'void' }, supplier: { tenantId } },
    include: { supplier: { select: { name: true } }, applications: true },
  })
  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
  const open = bills
    .map((b) => {
      const paid = b.applications.reduce((s, a) => s + a.amountAppliedCents, 0)
      const due = b.totalCents - paid
      const ageDays = Math.floor((Date.now() - new Date(b.billDate).getTime()) / 86_400_000)
      return { supplier: b.supplier.name, billNumber: b.billNumber, due, ageDays }
    })
    .filter((b) => b.due > 0)
    .sort((a, b) => b.ageDays - a.ageDays)

  return {
    subject: `[servd] AP aging — ${open.length} open bill(s)`,
    html: `
      <h2>AP aging</h2>
      <table cellpadding="6" border="1" style="border-collapse:collapse">
        <tr><th>Supplier</th><th>Bill</th><th>Days</th><th>Due</th></tr>
        ${open.map((b) => `<tr><td>${b.supplier}</td><td>${b.billNumber}</td><td>${b.ageDays}</td><td>${fmt(b.due)}</td></tr>`).join('')}
      </table>`,
  }
}
