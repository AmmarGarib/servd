// HR weekly expiry digest + waiting-request reminders (owner, 2026-10-26, B5a:
// "Weekly bell digest to HR and the department head; reminder after 2 days on
// any waiting request").
//
// Reuses the HR "Lifecycle & Dues" report (reports.ts buildReport) — never a
// second reading of probation / contract / CNIC dates. Per company, in that
// company's RLS context:
//   - HR logins (role hr holding staff_hr) of the company get the whole
//     company's list;
//   - each head of department (same rule as routes.ts hodDepartmentOf: an
//     active employee with a department and >= 1 active / on-leave direct
//     report, with a login) gets their department's items.
// ONE bell notice per recipient per ISO week (dedupeKey + a Setting marker per
// company). Bell only — no push, so no sandbox gate is needed.
//
// Reminders: an hr_request waiting on the same step for >= 2 days (since the
// record last changed) tells whoever must act next (approverIdsFor), again
// every further 2 days, at most 3 reminders per record per step. Idempotent
// through the dedupeKey (record + step + reminder number).

import { serviceClient as prisma } from '../../lib/prisma.js'
import { runWithRlsContext } from '../../lib/rlsContext.js'
import { notifyStaffMany, type NotifyInput } from '../../lib/staffNotify.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { approverIdsFor } from '../../lib/approvalRights.js'
import { buildReport } from './reports.js'
import { pktToday } from './logic.js'

const DAY = 86_400_000
export const REMINDER_AFTER_DAYS = 2
export const MAX_REMINDERS = 3
const PROBATION_DAYS = 30
const CONTRACT_DAYS = 30
const CNIC_DAYS = 90

export interface DigestItem { code: string; name: string; kind: 'probation' | 'contract' | 'cnic'; days: number; label: string }

/** ISO week id of the Karachi date, e.g. 2026-W44. */
export function isoWeekOf(now: Date): string {
  const d = pktToday(now)
  const t = new Date(d)
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const y = t.getUTCFullYear()
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7)
  return `${y}-W${String(w).padStart(2, '0')}`
}

async function expiringItems(tenantId: string): Promise<Array<DigestItem & { departmentId: string | null }>> {
  const table = await runWithRlsContext({ tenantIds: [tenantId], customerId: null, staffUserId: null }, () => buildReport('lifecycle_dues', [tenantId], tenantId, {}))
  const emps = await prisma.hrEmployee.findMany({ where: { tenantId, status: { in: ['active', 'on_leave'] } }, select: { employeeCode: true, departmentId: true } })
  const deptOf = new Map(emps.map((e) => [e.employeeCode, e.departmentId]))
  const out: Array<DigestItem & { departmentId: string | null }> = []
  // Columns: Emp ID, Full Name, Department, DOJ, Employment Type, Due date, Days Remaining, Review Status, CNIC Expiry, CNIC Days, CNIC Alert
  for (const r of table.rows) {
    const code = String(r[0]); const name = String(r[1]); const type = String(r[4] ?? '')
    const days = r[6] as number | null; const cnicDays = r[9] as number | null
    const departmentId = deptOf.get(code) ?? null
    if (days != null && type === 'On Probation' && days <= PROBATION_DAYS) {
      out.push({ code, name, kind: 'probation', days, label: days <= 0 ? 'probation review overdue' : `probation ends in ${days}d`, departmentId })
    } else if (days != null && type === 'Contract' && days <= CONTRACT_DAYS) {
      out.push({ code, name, kind: 'contract', days, label: days <= 0 ? 'contract ended' : `contract ends in ${days}d`, departmentId })
    }
    if (cnicDays != null && cnicDays <= CNIC_DAYS) {
      out.push({ code, name, kind: 'cnic', days: cnicDays, label: cnicDays <= 0 ? 'CNIC expired' : `CNIC expires in ${cnicDays}d`, departmentId })
    }
  }
  return out.sort((a, b) => a.days - b.days)
}

function compose(items: DigestItem[]): { title: string; body: string } {
  const n = (k: DigestItem['kind']) => items.filter((i) => i.kind === k).length
  const parts = [
    n('probation') ? `${n('probation')} probation` : '',
    n('contract') ? `${n('contract')} contract` : '',
    n('cnic') ? `${n('cnic')} CNIC` : '',
  ].filter(Boolean)
  const shown = items.slice(0, 6).map((i) => `${i.name} (${i.label})`).join('; ')
  const more = items.length > 6 ? `; +${items.length - 6} more` : ''
  return { title: `HR weekly: ${parts.join(', ')} to review`, body: `${shown}${more}` }
}

/** HR logins of the company holding staff_hr. */
async function hrRecipients(tenantId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      role: 'hr', isActive: true, accountStatus: 'active', deletedAt: null,
      OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
    },
    select: { id: true, role: true, moduleAllow: true, moduleDeny: true },
  })
  const out: string[] = []
  for (const u of users) {
    if ((await effectiveModulesForUser({ role: u.role, moduleAllow: u.moduleAllow, moduleDeny: u.moduleDeny })).has('staff_hr')) out.push(u.id)
  }
  return out
}

/** Heads of department (hodDepartmentOf's rule) with a login: userId → departmentId. */
async function hodRecipients(tenantId: string): Promise<Map<string, string>> {
  const emps = await prisma.hrEmployee.findMany({
    where: { tenantId, status: 'active', departmentId: { not: null }, userId: { not: null } },
    select: { id: true, userId: true, departmentId: true },
  })
  const withReports = await prisma.hrEmployee.groupBy({
    by: ['managerId'], where: { tenantId, managerId: { in: emps.map((e) => e.id) }, status: { in: ['active', 'on_leave'] } }, _count: { _all: true },
  })
  const heads = new Set(withReports.map((r) => r.managerId))
  return new Map(emps.filter((e) => heads.has(e.id)).map((e) => [e.userId!, e.departmentId!]))
}

const markerKey = (tenantId: string) => `hr.digest.lastWeek:${tenantId}`

/** One company's weekly digest. Returns the notices created. */
export async function runHrDigestForCompany(tenantId: string, now: Date = new Date()): Promise<number> {
  const week = isoWeekOf(now)
  const marker = await prisma.setting.findUnique({ where: { key: markerKey(tenantId) } })
  if (marker?.value === week) return 0
  const items = await expiringItems(tenantId)
  const rows: NotifyInput[] = []
  if (items.length > 0) {
    const all = compose(items)
    for (const userId of await hrRecipients(tenantId)) {
      rows.push({ userId, tenantId, kind: 'hr.digest', severity: 'info', ...all, link: '/hr/reports', entityType: 'hr_digest', entityId: tenantId, dedupeKey: `hr.digest:${tenantId}:${week}` })
    }
    for (const [userId, departmentId] of await hodRecipients(tenantId)) {
      const mine = items.filter((i) => i.departmentId === departmentId)
      if (mine.length === 0) continue
      rows.push({ userId, tenantId, kind: 'hr.digest', severity: 'info', ...compose(mine), link: '/hr/me', entityType: 'hr_digest', entityId: tenantId, dedupeKey: `hr.digest:${tenantId}:${week}:hod` })
    }
  }
  const created = rows.length ? await notifyStaffMany(rows) : 0
  await prisma.setting.upsert({ where: { key: markerKey(tenantId) }, create: { key: markerKey(tenantId), value: week }, update: { value: week } })
  return created
}

export async function runHrDigestOnce(now: Date = new Date()): Promise<{ companies: number; notices: number }> {
  const companies = await prisma.tenant.findMany({ where: { deletedAt: null, kind: 'company' }, select: { id: true } })
  let notices = 0
  for (const { id } of companies) {
    try { notices += await runHrDigestForCompany(id, now) } catch (err) { console.error(`[hr-digest] company ${id}:`, (err as Error).message) }
  }
  return { companies: companies.length, notices }
}

/** Reminders for HR requests waiting 2+ days on the same step. */
export async function runHrRequestRemindersOnce(now: Date = new Date()): Promise<number> {
  const waiting = await prisma.hrRecord.findMany({
    where: { status: 'submitted', updatedAt: { lte: new Date(now.getTime() - REMINDER_AFTER_DAYS * DAY) } },
    select: { id: true, tenantId: true, section: true, currentStep: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
    take: 500,
  })
  let sent = 0
  for (const r of waiting) {
    const n = Math.min(MAX_REMINDERS, Math.floor((now.getTime() - r.updatedAt.getTime()) / (REMINDER_AFTER_DAYS * DAY)))
    if (n < 1) continue
    try {
      const found = await approverIdsFor('hr_request', r.id)
      if (!found || found.userIds.length === 0) continue
      const days = Math.floor((now.getTime() - r.updatedAt.getTime()) / DAY)
      const what = r.section.replace(/_/g, ' ')
      sent += await notifyStaffMany(found.userIds.map((userId) => ({
        userId, tenantId: r.tenantId, kind: 'hr.reminder' as const, severity: 'warning' as const,
        title: `Reminder: ${what} request waiting ${days} days for your decision`,
        body: `Reminder ${n} of up to ${MAX_REMINDERS}. It has waited on the same step since ${r.updatedAt.toISOString().slice(0, 10)}.`,
        link: '/ceo/approvals?type=hr_request', entityType: 'hr_request', entityId: r.id,
        dedupeKey: `hr.reminder:${r.id}:${r.currentStep}:${n}`,
      })))
    } catch (err) { console.error(`[hr-digest] reminder ${r.id}:`, (err as Error).message) }
  }
  return sent
}
