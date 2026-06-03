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
    void run(r.id, r.reportType as ReportType, r.recipients, r.conceptId, r.name)
      .catch((err) => console.warn(`[scheduledReports] ${r.id} failed:`, (err as Error).message))
      .finally(() => RUNNING.delete(r.id))
  }
}

async function run(
  id: string,
  reportType: ReportType,
  recipients: string[],
  conceptId: string | null,
  name: string,
): Promise<void> {
  let html = ''
  let subject = `[servd] ${name}`
  try {
    if (reportType === 'sales_daily') {
      ({ subject, html } = await buildDailySalesReport(conceptId))
    } else if (reportType === 'low_stock') {
      ({ subject, html } = await buildLowStockReport(conceptId))
    } else if (reportType === 'ap_aging') {
      ({ subject, html } = await buildApAgingReport())
    } else {
      // Stub for shift_summary / food_cost / menu_engineering — wire to real
      // computers once their report endpoints stabilise.
      html = `<p>Report ${reportType} is queued but not yet implemented.</p>`
    }
    await Promise.all(recipients.map((to) => sendEmail(to, subject, html)))
    await prisma.scheduledReport.update({
      where: { id },
      data: { lastRunAt: new Date(), lastStatus: 'success' },
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

async function buildDailySalesReport(conceptId: string | null): Promise<{ subject: string; html: string }> {
  const now = new Date()
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  const start = new Date(yesterday); start.setHours(0, 0, 0, 0)
  const end   = new Date(yesterday); end.setHours(23, 59, 59, 999)

  const orders = await prisma.order.findMany({
    where: {
      placedAt: { gte: start, lte: end },
      status:   { notIn: ['cancelled', 'rejected'] },
      deletedAt: null,
      ...(conceptId && { conceptId }),
    },
    select: { totalCents: true, discountCents: true, taxCents: true, source: true },
  })

  const gross    = orders.reduce((s, o) => s + o.totalCents, 0)
  const discount = orders.reduce((s, o) => s + (o.discountCents ?? 0), 0)
  const tax      = orders.reduce((s, o) => s + (o.taxCents ?? 0), 0)

  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
  const dateLabel = yesterday.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

  return {
    subject: `Daily sales — ${dateLabel}`,
    html: `
      <h2>Daily sales — ${dateLabel}</h2>
      <p><strong>${orders.length}</strong> orders</p>
      <ul>
        <li>Gross: ${fmt(gross)}</li>
        <li>Discounts: ${fmt(discount)}</li>
        <li>Tax: ${fmt(tax)}</li>
        <li><strong>Net: ${fmt(gross - discount)}</strong></li>
      </ul>`,
  }
}

async function buildLowStockReport(conceptId: string | null): Promise<{ subject: string; html: string }> {
  const items = await prisma.inventoryItem.findMany({
    where: {
      deletedAt: null,
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

async function buildApAgingReport(): Promise<{ subject: string; html: string }> {
  const bills = await prisma.supplierBill.findMany({
    where: { status: { not: 'void' } },
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
