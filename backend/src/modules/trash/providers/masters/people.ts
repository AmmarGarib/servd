// Trash providers — people & planning (stream B5; see ../../README.md).
//
//   hr_document          HrDocument           snapshot  the employee must still exist; erasable (HR manager reads it
//                                                       in the Trash until the CEO empties it — owner Q2 default).
//   hr_payroll_run       HrPayrollRun         snapshot  DRAFT runs only, WITH their payslips; clash on the period
//                                                       (409 PERIOD_TAKEN). Erasable.
//   hr_letter            HrLetterTemplate     snapshot  a company's own wording of a built-in letter; clash on the key.
//   scheduled_shift      ScheduledShift       snapshot  a rota exception deleted by hand (copy-week / auto-fill
//                                                       replaces are not kept — owner Q4 default), WITH its swap
//                                                       requests. Parent: its brand. The person must still be live.
//   concept_blockout     ConceptBlockout      snapshot  parent: its brand.
//   position             Position             status    "delete" is an archive; Restore puts the previous status back.
//   tenant_contribution  TenantContribution   status    "delete" is an end; Restore re-opens it (needs BOTH companies).
//   projection           Projection           snapshot  WITH its brand inputs.
//
// Positions and contributions are never erasable (history). Roles are the
// module routes' own guards, imported — never retyped. The route files
// hard-code these keys as string literals (importing this file from them
// would be a cycle); tests/trashPeople.test.ts pins both sides together.

import type { TrashEntry, UserRole } from '@prisma/client'
import { AppError, ForbiddenError } from '../../../../lib/errors.js'
import { MANAGERS, HR_TEAM, FINANCE_TEAM } from '../../../auth/middleware.js'
import { assertBothSidesOwned } from '../../../../lib/companyPairs.js'
import { headOfficeSetupApplied } from '../../../headOffices/books.js'
import { HR_ADMIN } from '../../../hr/routes.js'
import { ROTA_PLANNERS } from '../../../scheduling/routes.js'
import { OFF_MARK } from '../../../hr/rota.js'
import { restoreSnapshot, type Snapshot } from '../../snapshot.js'
import { purgeRecordFilesTx } from '../../../../lib/recordFiles.js'
import type { TrashProvider, Tx } from '../../types.js'

export const TRASH_PEOPLE = {
  hr_document: 'hr_document',
  hr_payroll_run: 'hr_payroll_run',
  hr_letter: 'hr_letter',
  scheduled_shift: 'scheduled_shift',
  concept_blockout: 'concept_blockout',
  position: 'position',
  tenant_contribution: 'tenant_contribution',
  projection: 'projection',
} as const

const metaOf = (e: TrashEntry) => (e.meta ?? {}) as Record<string, unknown>
const snapOf = (e: TrashEntry) => e.snapshot as unknown as Snapshot | null
const rowOf = (e: TrashEntry): Record<string, unknown> => snapOf(e)?.row ?? {}
const brandParent = (e: TrashEntry) => (e.conceptId ? { type: 'brand', id: e.conceptId } : null)

const HR_ROLES = HR_ADMIN as readonly UserRole[]
const ROTA_ROLES = ROTA_PLANNERS as readonly UserRole[]
const MANAGER_ROLES = MANAGERS as readonly UserRole[]
const HR_TEAM_ROLES = HR_TEAM as readonly UserRole[]
const FINANCE_ROLES = FINANCE_TEAM as readonly UserRole[]

/** Restore the snapshot, refusing when a person it names is gone (FK would 500). */
async function assertEmployeesExist(tx: Tx, tenantId: string | null, ids: string[]): Promise<void> {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length) return
  const n = await tx.hrEmployee.count({ where: { id: { in: uniq }, ...(tenantId ? { tenantId } : {}) } })
  if (n !== uniq.length) {
    throw new AppError('EMPLOYEE_NOT_AVAILABLE', 'An employee this belongs to no longer exists in this company — it cannot be restored', 409)
  }
}

async function snapshotRestore(tx: Tx, entry: TrashEntry): Promise<{ id: string }> {
  const snap = snapOf(entry)
  if (!snap) throw new AppError('PURGED', 'This item was deleted forever', 409)
  const id = await restoreSnapshot(tx, snap, { tenantId: entry.tenantId })
  return { id }
}

// ── HR document ──────────────────────────────────────────────────────────────

const hrDocument: TrashProvider = {
  key: TRASH_PEOPLE.hr_document,
  label: 'HR document',
  moduleId: 'staff_hr',
  roles: { list: HR_ROLES, restore: HR_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  model: 'HrDocument',
  linkOf: () => '/hr/documents',
  async restore(tx, _ctx, entry) {
    await assertEmployeesExist(tx, entry.tenantId, [String(rowOf(entry).employeeId ?? '')])
    return { ...(await snapshotRestore(tx, entry)), link: '/hr/documents' }
  },
  erasable: () => true,
  // Its uploaded files (record files, owner 'hr_document') stay with the
  // trashed document so a restore brings them back; "Delete forever" erases them.
  async purge(tx, entry) {
    await purgeRecordFilesTx(tx, { ownerType: 'hr_document', ownerId: entry.entityId, tenantId: entry.tenantId })
  },
}

// ── Payroll draft ────────────────────────────────────────────────────────────

const hrPayrollRun: TrashProvider = {
  key: TRASH_PEOPLE.hr_payroll_run,
  label: 'Payroll draft',
  moduleId: 'staff_hr',
  roles: { list: HR_ROLES, restore: HR_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  model: 'HrPayrollRun',
  linkOf: (id) => `/hr/payroll/${id}`,
  async clashOf(tx, entry) {
    const period = String(rowOf(entry).period ?? metaOf(entry).period ?? '')
    if (!period || !entry.tenantId) return null
    const live = await tx.hrPayrollRun.findFirst({ where: { tenantId: entry.tenantId, period }, select: { id: true } })
    if (!live) return null
    return {
      field: 'period', value: period, renamable: false, code: 'PERIOD_TAKEN',
      message: `A payroll for ${period} already exists in this company — delete or finish that one first`,
    }
  },
  async restore(tx, _ctx, entry) {
    const slips = snapOf(entry)?.children?.HrPayslip ?? []
    await assertEmployeesExist(tx, entry.tenantId, slips.map((s) => String(s.employeeId ?? '')))
    const out = await snapshotRestore(tx, entry)
    return { ...out, link: `/hr/payroll/${out.id}` }
  },
  erasable: () => true,
}

// ── Letter override ──────────────────────────────────────────────────────────

const hrLetter: TrashProvider = {
  key: TRASH_PEOPLE.hr_letter,
  label: 'Letter wording',
  moduleId: 'staff_hr',
  roles: { list: HR_ROLES, restore: HR_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  model: 'HrLetterTemplate',
  linkOf: () => '/hr/letters',
  async clashOf(tx, entry) {
    const key = String(rowOf(entry).key ?? metaOf(entry).key ?? '')
    if (!key || !entry.tenantId) return null
    const live = await tx.hrLetterTemplate.findUnique({ where: { tenantId_key: { tenantId: entry.tenantId, key } }, select: { id: true } })
    return live
      ? { field: 'key', value: key, renamable: false, message: 'This letter already has its own wording again — edit that one, or reset it first' }
      : null
  },
  restore: async (tx, _ctx, entry) => ({ ...(await snapshotRestore(tx, entry)), link: '/hr/letters' }),
  erasable: () => true,
}

// ── Rota exception ───────────────────────────────────────────────────────────

const overlaps = (a1: string, a2: string, b1: string, b2: string) => a1 < b2 && b1 < a2

const scheduledShift: TrashProvider = {
  key: TRASH_PEOPLE.scheduled_shift,
  label: 'Rota shift',
  moduleId: 'scheduling',
  roles: { list: ROTA_ROLES, restore: ROTA_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  model: 'ScheduledShift',
  linkOf: () => '/scheduling',
  parentOf: brandParent,
  async clashOf(tx, entry) {
    const row = rowOf(entry)
    const userId = String(row.userId ?? '')
    const date = row.date ? new Date(String(row.date)) : null
    if (!userId || !date || !entry.tenantId) return null
    const others = await tx.scheduledShift.findMany({
      where: { userId, date, concept: { tenantId: entry.tenantId } },
      select: { startTime: true, endTime: true, role: true },
    })
    const mineOff = row.role === OFF_MARK
    const hit = others.find((o) => mineOff || o.role === OFF_MARK || overlaps(String(row.startTime), String(row.endTime), o.startTime, o.endTime))
    return hit
      ? { field: 'date', value: String(row.date).slice(0, 10), renamable: false, message: 'This person already has a shift or day off on that day — edit that one instead' }
      : null
  },
  async restore(tx, _ctx, entry) {
    const row = rowOf(entry)
    const user = await tx.user.findFirst({ where: { id: String(row.userId ?? ''), deletedAt: null }, select: { id: true } })
    if (!user) throw new AppError('USER_NOT_AVAILABLE', 'The person this shift was for no longer has a login — it cannot be restored', 409)
    const brand = await tx.concept.findFirst({ where: { id: String(row.conceptId ?? ''), tenantId: entry.tenantId, deletedAt: null }, select: { id: true } })
    if (!brand) throw new AppError('BRAND_NOT_AVAILABLE', 'The brand this shift belongs to no longer exists in this company — it cannot be restored', 409)
    return { ...(await snapshotRestore(tx, entry)), link: '/scheduling' }
  },
  erasable: () => true,
}

// ── Reservation blockout ─────────────────────────────────────────────────────

const conceptBlockout: TrashProvider = {
  key: TRASH_PEOPLE.concept_blockout,
  label: 'Booking blockout',
  moduleId: 'reservations',
  roles: { list: MANAGER_ROLES, restore: MANAGER_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  model: 'ConceptBlockout',
  linkOf: () => '/reservations/blockouts',
  parentOf: brandParent,
  async restore(tx, _ctx, entry) {
    const brand = await tx.concept.findFirst({ where: { id: String(rowOf(entry).conceptId ?? ''), tenantId: entry.tenantId, deletedAt: null }, select: { id: true } })
    if (!brand) throw new AppError('BRAND_NOT_AVAILABLE', 'The brand this belongs to no longer exists in this company — it cannot be restored', 409)
    return { ...(await snapshotRestore(tx, entry)), link: '/reservations/blockouts' }
  },
  erasable: () => true,
}

// ── Position (archive) ───────────────────────────────────────────────────────

const position: TrashProvider = {
  key: TRASH_PEOPLE.position,
  label: 'Position',
  moduleId: 'staff_directory',
  roles: { list: HR_TEAM_ROLES, restore: HR_TEAM_ROLES },
  kind: 'master',
  strategy: 'status',
  auditCategory: 'identity',
  model: 'Position',
  linkOf: () => '/workforce',
  async restore(tx, _ctx, entry) {
    const prev = (metaOf(entry).previous ?? {}) as { status?: string }
    if (!prev.status) throw new AppError('NOT_RESTORABLE', 'What this position was before is not known — set it again on Workforce', 422)
    const seat = await tx.position.findFirst({ where: { id: entry.entityId, tenantId: entry.tenantId ?? '' }, select: { status: true } })
    if (!seat) throw new AppError('NOT_FOUND', 'This position no longer exists', 404)
    // Someone already re-opened it by hand: leave their status alone.
    if (seat.status === 'archived') await tx.position.update({ where: { id: entry.entityId }, data: { status: prev.status as never } })
    return { id: entry.entityId, link: '/workforce' }
  },
  erasable: () => false,
}

// ── Inter-company contribution (end) ─────────────────────────────────────────

const tenantContribution: TrashProvider = {
  key: TRASH_PEOPLE.tenant_contribution,
  label: 'Company contribution',
  moduleId: 'staff_directory',
  roles: { list: MANAGER_ROLES, restore: MANAGER_ROLES },
  kind: 'master',
  strategy: 'status',
  auditCategory: 'identity',
  model: 'TenantContribution',
  linkOf: () => '/workforce',
  async restore(tx, ctx, entry) {
    const c = await tx.tenantContribution.findUnique({ where: { id: entry.entityId } })
    if (!c || c.sourceTenantId !== entry.tenantId) throw new AppError('NOT_FOUND', 'This contribution no longer exists', 404)
    // Same pair rule as editing one: the operator belongs to BOTH companies.
    const members = ctx.req.staffUser?.memberTenantIds ?? []
    if (!members.includes(c.sourceTenantId) || !members.includes(c.destinationTenantId)) {
      throw new ForbiddenError('You must be a member of both companies to restore this contribution')
    }
    await assertBothSidesOwned(ctx.req, c.sourceTenantId, c.destinationTenantId, { what: 'contribution' })
    if (c.category === 'head_office' && (await headOfficeSetupApplied())) {
      throw new AppError('USE_HEAD_OFFICE', 'Shared head-office salaries are planned through the head office now, not a contribution', 422)
    }
    if (!c.isActive) await tx.tenantContribution.update({ where: { id: c.id }, data: { isActive: true, endedAt: null } })
    return { id: c.id, link: '/workforce' }
  },
  erasable: () => false,
}

// ── Projection scenario ──────────────────────────────────────────────────────

const projection: TrashProvider = {
  key: TRASH_PEOPLE.projection,
  label: 'Projection scenario',
  moduleId: 'projections',
  roles: { list: FINANCE_ROLES, restore: FINANCE_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  model: 'Projection',
  linkOf: () => '/finance/projections',
  async restore(tx, _ctx, entry) {
    // Brand inputs name brands of the same company; one gone for good would 500.
    const ids = (snapOf(entry)?.children?.ProjectionBrandInput ?? []).map((b) => String(b.conceptId ?? ''))
    if (ids.length) {
      const n = await tx.concept.count({ where: { id: { in: ids } } })
      if (n !== new Set(ids).size) throw new AppError('BRAND_NOT_AVAILABLE', 'A brand in this scenario no longer exists — it cannot be restored', 409)
    }
    return { ...(await snapshotRestore(tx, entry)), link: '/finance/projections' }
  },
  erasable: () => true,
}

export const PEOPLE_TRASH_PROVIDERS: TrashProvider[] = [
  hrDocument, hrPayrollRun, hrLetter, scheduledShift, conceptBlockout, position, tenantContribution, projection,
]
