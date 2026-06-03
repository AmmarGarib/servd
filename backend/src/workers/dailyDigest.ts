import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { sendEmail } from '../lib/notify.js'

async function runDailyDigest() {
  const now  = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const start = new Date(yesterday); start.setHours(0, 0, 0, 0)
  const end   = new Date(yesterday); end.setHours(23, 59, 59, 999)
  const dateLabel = yesterday.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

  const orders = await prisma.order.findMany({
    where: {
      placedAt:  { gte: start, lte: end },
      status:    { notIn: ['cancelled', 'rejected'] },
      deletedAt: null,
    },
    select: {
      totalCents: true,
      discountCents: true,
      source: true,
      items: { select: { name: true, quantity: true } },
    },
  })

  if (orders.length === 0) {
    console.log('[dailyDigest] no orders yesterday, skipping email')
    return
  }

  const grossCents   = orders.reduce((s, o) => s + o.totalCents, 0)
  const discCents    = orders.reduce((s, o) => s + (o.discountCents ?? 0), 0)
  const netCents     = grossCents - discCents
  const fmt = (c: number) => `Rs. ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

  // Top items by quantity sold
  const itemMap = new Map<string, number>()
  for (const o of orders) {
    for (const i of o.items) {
      itemMap.set(i.name, (itemMap.get(i.name) ?? 0) + i.quantity)
    }
  }
  const topItems = [...itemMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  // Channel breakdown
  const byChannel = new Map<string, number>()
  for (const o of orders) {
    byChannel.set(o.source, (byChannel.get(o.source) ?? 0) + 1)
  }

  const channelRows = [...byChannel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ch, cnt]) => `<tr><td style="padding:4px 12px 4px 0;color:#888;text-transform:capitalize">${ch}</td><td style="padding:4px 0;font-weight:600">${cnt} orders</td></tr>`)
    .join('')

  const topItemRows = topItems
    .map(([name, qty], i) => `<tr><td style="padding:4px 12px 4px 0;color:#888">#${i + 1}</td><td style="padding:4px 0;font-weight:600">${name}</td><td style="padding:4px 0 4px 16px;color:#888;text-align:right">${qty}×</td></tr>`)
    .join('')

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:32px 16px">
  <div style="background:#00D4B1;border-radius:12px;padding:24px;color:#000;margin-bottom:24px">
    <p style="margin:0 0 4px;font-size:12px;font-weight:700;opacity:0.6;text-transform:uppercase;letter-spacing:0.1em">Daily Digest</p>
    <h1 style="margin:0;font-size:28px;font-weight:900">${dateLabel}</h1>
  </div>

  <table width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px">
    <tr>
      <td style="background:#f5f5f5;border-radius:10px;padding:16px 20px;width:33%">
        <p style="margin:0 0 4px;font-size:11px;color:#888;font-weight:700;text-transform:uppercase">Orders</p>
        <p style="margin:0;font-size:26px;font-weight:900">${orders.length}</p>
      </td>
      <td width="12"></td>
      <td style="background:#f5f5f5;border-radius:10px;padding:16px 20px;width:33%">
        <p style="margin:0 0 4px;font-size:11px;color:#888;font-weight:700;text-transform:uppercase">Gross Revenue</p>
        <p style="margin:0;font-size:26px;font-weight:900">${fmt(grossCents)}</p>
      </td>
      <td width="12"></td>
      <td style="background:#f5f5f5;border-radius:10px;padding:16px 20px;width:33%">
        <p style="margin:0 0 4px;font-size:11px;color:#888;font-weight:700;text-transform:uppercase">Net Revenue</p>
        <p style="margin:0;font-size:26px;font-weight:900">${fmt(netCents)}</p>
        ${discCents > 0 ? `<p style="margin:4px 0 0;font-size:11px;color:#e74c3c">−${fmt(discCents)} discounts</p>` : ''}
      </td>
    </tr>
  </table>

  <h3 style="margin:0 0 12px;font-size:14px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.05em">Top Items</h3>
  <table width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px">
    ${topItemRows}
  </table>

  <h3 style="margin:0 0 12px;font-size:14px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.05em">By Channel</h3>
  <table width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:32px">
    ${channelRows}
  </table>

  <p style="color:#bbb;font-size:11px;text-align:center">servd · daily digest · ${now.toISOString()}</p>
</body>
</html>`

  const recipient = process.env['DIGEST_EMAIL'] ?? process.env['SMTP_FROM'] ?? ''
  if (!recipient) {
    console.log('[dailyDigest] no DIGEST_EMAIL configured, printing summary:',
      `${dateLabel}: ${orders.length} orders · ${fmt(grossCents)} gross`)
    return
  }

  try {
    await sendEmail(recipient, `servd Daily Digest — ${dateLabel}`, html)
    console.log(`[dailyDigest] sent to ${recipient}`)
  } catch (err) {
    console.error('[dailyDigest] email send failed:', (err as Error).message)
  }
}

export function startDailyDigestWorker() {
  // Fire at 00:05 every day (5 min after midnight to catch stragglers)
  cron.schedule('5 0 * * *', () => {
    void runDailyDigest().catch((err: Error) =>
      console.error('[dailyDigest] error:', err.message))
  })
  console.log('[dailyDigest] worker scheduled (00:05 daily)')
}
