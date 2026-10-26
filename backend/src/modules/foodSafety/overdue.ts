// Food safety — overdue bell reminders and the inspector printout (owner,
// 2026-10-26, B7a: "Overdue bell reminders and a PDF printout").
//
// Overdue = the rules the page already shows: a unit with no reading in the last
// 24 h (the page's "checked today"), a cleaning task past its frequency window
// (the summary's `due`). ONE bell notice per occurrence — keyed on the last
// reading / last clean (or the unit's / task's creation), so it fires once until
// somebody logs it again. Recipients: the company's kitchen managers (head chef,
// F&B manager, managers) holding the food_safety module. Bell only.

import { serviceClient as prisma } from '../../lib/prisma.js'
import { notifyStaffMany, type NotifyInput } from '../../lib/staffNotify.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import type { ReportTable } from '../../lib/reportExport.js'

const DAY = 86_400_000
const WINDOW_MS = { daily: DAY, weekly: 7 * DAY, monthly: 30 * DAY } as const
export const OVERDUE_RECIPIENT_ROLES = ['manager', 'management', 'boh_management', 'fnb_manager'] as const

async function recipients(tenantId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      role: { in: [...OVERDUE_RECIPIENT_ROLES] }, isActive: true, accountStatus: 'active', deletedAt: null,
      OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
    },
    select: { id: true, role: true, moduleAllow: true, moduleDeny: true },
  })
  const out: string[] = []
  for (const u of users) {
    if ((await effectiveModulesForUser({ role: u.role, moduleAllow: u.moduleAllow, moduleDeny: u.moduleDeny })).has('food_safety')) out.push(u.id)
  }
  return out
}

/** One company's pass; returns notices created. */
export async function runFoodSafetyOverdueForCompany(tenantId: string, now: Date = new Date()): Promise<number> {
  const [units, tasks] = await Promise.all([
    prisma.foodSafetyUnit.findMany({ where: { tenantId, isActive: true }, include: { logs: { orderBy: { takenAt: 'desc' }, take: 1, select: { takenAt: true } } } }),
    prisma.cleaningTask.findMany({ where: { tenantId, isActive: true }, include: { logs: { orderBy: { doneAt: 'desc' }, take: 1, select: { doneAt: true } } } }),
  ])
  const people = await recipients(tenantId)
  if (people.length === 0) return 0
  const rows: NotifyInput[] = []
  for (const u of units) {
    const since = u.logs[0]?.takenAt ?? u.createdAt
    if (now.getTime() - since.getTime() < DAY) continue
    for (const userId of people) {
      rows.push({
        userId, tenantId, kind: 'food_safety.overdue', severity: 'warning',
        title: `Temperature check overdue: ${u.name}`,
        body: u.logs[0] ? `Last reading ${u.logs[0].takenAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.` : 'No reading has been recorded yet.',
        link: '/food-safety', entityType: 'FoodSafetyUnit', entityId: u.id,
        dedupeKey: `fs.unit:${u.id}:${since.getTime()}`,
      })
    }
  }
  for (const t of tasks) {
    const since = t.logs[0]?.doneAt ?? t.createdAt
    const window = WINDOW_MS[t.frequency as keyof typeof WINDOW_MS] ?? WINDOW_MS.daily
    if (now.getTime() - since.getTime() < window) continue
    for (const userId of people) {
      rows.push({
        userId, tenantId, kind: 'food_safety.overdue', severity: 'warning',
        title: `Cleaning task overdue: ${t.name}`,
        body: `${t.frequency} task${t.area ? ` (${t.area})` : ''}${t.logs[0] ? `, last done ${t.logs[0].doneAt.toISOString().slice(0, 10)}` : ', never recorded'}.`,
        link: '/food-safety', entityType: 'CleaningTask', entityId: t.id,
        dedupeKey: `fs.clean:${t.id}:${since.getTime()}`,
      })
    }
  }
  return rows.length ? notifyStaffMany(rows) : 0
}

export async function runFoodSafetyOverdueOnce(now: Date = new Date()): Promise<number> {
  const companies = await prisma.tenant.findMany({ where: { deletedAt: null }, select: { id: true } })
  let n = 0
  for (const { id } of companies) {
    try { n += await runFoodSafetyOverdueForCompany(id, now) } catch (err) { console.error(`[food-safety-overdue] company ${id}:`, (err as Error).message) }
  }
  return n
}

// ─── Inspector printout ──────────────────────────────────────────────────────

const pkt = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')

/**
 * Temperature logs and cleaning logs for the companies in `tenantIds`, optionally
 * one location (units / tasks at it), over [from, to]. One table, a section per
 * kind of record.
 */
export async function inspectorTable(tenantIds: string[], opts: { from: Date; to: Date; locationId?: string | null }): Promise<ReportTable> {
  const locWhere = opts.locationId ? { locationId: opts.locationId } : {}
  const [temps, cleans] = await Promise.all([
    prisma.temperatureLog.findMany({
      where: { tenantId: { in: tenantIds }, takenAt: { gte: opts.from, lte: opts.to }, unit: locWhere },
      include: { unit: { select: { name: true, minC: true, maxC: true } } }, orderBy: { takenAt: 'asc' }, take: 5000,
    }),
    prisma.cleaningLog.findMany({
      where: { tenantId: { in: tenantIds }, doneAt: { gte: opts.from, lte: opts.to }, task: locWhere },
      include: { task: { select: { name: true, area: true, frequency: true } } }, orderBy: { doneAt: 'asc' }, take: 5000,
    }),
  ])
  const staff = await prisma.user.findMany({
    where: { id: { in: [...new Set([...temps.map((t) => t.takenById), ...cleans.map((c) => c.doneById)].filter((x): x is string => !!x))] } },
    select: { id: true, name: true },
  })
  const who = new Map(staff.map((u) => [u.id, u.name]))
  const rows = [
    ...temps.map((t) => ({
      Section: 'Temperature logs', When: pkt(t.takenAt), Item: t.unit.name,
      'Limit / frequency': `${t.unit.minC ?? '—'} to ${t.unit.maxC ?? '—'} °C`, Result: `${t.readingC} °C`,
      Status: t.withinRange ? 'In range' : 'OUT OF RANGE', 'Corrective action / note': [t.correctiveAction, t.note].filter(Boolean).join(' — '),
      'Recorded by': t.takenById ? who.get(t.takenById) ?? '' : '',
    })),
    ...cleans.map((c) => ({
      Section: 'Cleaning tasks', When: pkt(c.doneAt), Item: c.task.name,
      'Limit / frequency': `${c.task.frequency}${c.task.area ? ` · ${c.task.area}` : ''}`, Result: 'Done',
      Status: 'Done', 'Corrective action / note': c.note ?? '', 'Recorded by': c.doneById ? who.get(c.doneById) ?? '' : '',
    })),
  ]
  return {
    title: 'Food safety record for inspection',
    period: `${opts.from.toISOString().slice(0, 10)} to ${opts.to.toISOString().slice(0, 10)}`,
    sectionKey: 'Section',
    hide: ['Section'],
    rows,
  }
}
