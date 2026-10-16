// The month close's night-audit check (owner, 2026-10-16: "Or Month close").
// key 'night_audit_days', a block the CEO may close over (acknowledge with a
// reason on POST /accounting/period-close). It covers the company's active
// SALES days (./activity.ts) from max(the day after the previous lock, the
// company's night-audit start day) to the new lock that are not 'closed' —
// split into open (never run / reopened) and awaiting settlement (audited).
// Before the company's night audit starts (Tenant.nightAuditStartDay null) it
// is a warning only. Reads only ctx.tenantId's rows.

import type { CloseCheck } from '../accounting/closeCheckTypes.js'
import { fmtPktDate } from '../accounting/dates.js'
import { activityDaysBetween } from './activity.js'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const nightAuditCloseCheck: CloseCheck = {
  key: 'night_audit_days',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const t = await ctx.db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { nightAuditStartDay: true } })
    const lockDay = fmtPktDate(ctx.newLock)
    if (!t?.nightAuditStartDay) {
      return {
        key: 'night_audit_days',
        severity: 'warn',
        title: 'Night audit not started',
        detail: 'Night audit has not started for this company, so its sales days are not locked or settled day by day. '
          + 'Run the first night audit on Finance → Night audit (or the CEO sets the start day).',
        count: 0,
        link: '/finance/night-audit',
        overridable: false,
      }
    }
    const afterPrev = ctx.prevLock ? fmtPktDate(new Date(ctx.prevLock.getTime() + 1)) : null
    const fromDay = afterPrev && afterPrev > t.nightAuditStartDay ? afterPrev : t.nightAuditStartDay
    if (fromDay > lockDay) return null
    const days = await activityDaysBetween(ctx.db, ctx.tenantId, fromDay, lockDay)
    if (days.length === 0) return null
    const rows = await ctx.db.nightAuditDay.findMany({
      where: { tenantId: ctx.tenantId, businessDate: { in: days } },
      select: { businessDate: true, status: true },
    })
    const statusOf = new Map(rows.map((r) => [r.businessDate, r.status]))
    const open = days.filter((d) => (statusOf.get(d) ?? 'open') === 'open')
    const awaiting = days.filter((d) => statusOf.get(d) === 'audited')
    const n = open.length + awaiting.length
    if (n === 0) return null
    const parts = [
      open.length ? `${plural(open.length, 'day')} not night-audited (${open.slice(0, 5).join(', ')}${open.length > 5 ? ', …' : ''})` : null,
      awaiting.length ? `${plural(awaiting.length, 'day')} awaiting settlement (${awaiting.slice(0, 5).join(', ')}${awaiting.length > 5 ? ', …' : ''})` : null,
    ].filter(Boolean)
    return {
      key: 'night_audit_days',
      severity: 'block',
      title: 'Sales days not closed',
      detail: `${plural(n, 'sales day')} from ${fromDay} to ${lockDay} ${n === 1 ? 'is' : 'are'} not closed: ${parts.join('; ')}. `
        + 'Run the night audit and settle each day on Finance → Night audit, or the CEO closes the month over it.',
      count: n,
      months: [...new Set([...open, ...awaiting].map((d) => d.slice(0, 7)))].sort(),
      link: '/finance/night-audit',
      overridable: true,
    }
  },
}
