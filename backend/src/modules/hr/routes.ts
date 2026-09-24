// /hr — the HR module API.
//
// Access. HR data is the most sensitive in the system: salaries, CNICs, family
// details, disciplinary cases. The admin surfaces are for HR_ADMIN only (CEO,
// co-owner, exec, HR). Everyone else reaches HR through two narrow doors:
//   /hr/me         their own record, payslips and requests (self-service)
//   /hr/approvals  requests waiting on THEM, as a reporting manager
// Neither can read anyone else's salary.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Prisma, UserRole, HrEmployee, HrRecord } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError, ForbiddenError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import {
  HR_SECTIONS, RECORD_SECTIONS, sectionByKey, validateAgainst, checkFormat, ORG_UNIT_KINDS, DOCUMENT_TYPES,
  type HrField, type WorkflowStep, type RecordSlot,
} from './forms.js'
import {
  getSettings, saveSettings, getFormat, getAllFormats, defaultFormat, employeeLabels,
  applyDueEffects, onFinalApproval, leaveBalancesFor, checkLeave, loansFor,
  calculateRun, recalcPayslip, dashboard, dueList, letterContext, payableEmployees,
} from './service.js'
import {
  mergeSettings, canActOnStep, finalSettlement, nextEmployeeCode, periodOf, periodStart, periodEnd,
  type ApprovalEntry, type HrSettings,
} from './logic.js'
import { DEFAULT_LETTERS, renderLetter, placeholdersIn } from './letters.js'
import { REPORTS, buildReport, type ReportQuery } from './reports.js'

const HR_ADMIN = ['admin', 'owner', 'management', 'hr'] as UserRole[]
const PAYROLL_APPROVERS = ['admin', 'owner', 'management'] as UserRole[]
/** What an employee may raise for themselves through self-service. */
const ESS_SECTIONS = ['leave', 'overtime', 'attendance_correction', 'training_request', 'resignation', 'loan']

// ─── helpers ────────────────────────────────────────────────────────────────

function activeTenant(req: FastifyRequest): string {
  const t = req.staffUser?.tenantId
  if (!t) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — HR records belong to one company', 422)
  return t
}
/** Companies this operator can read HR for. Portfolio view spans all of them. */
function readTenants(req: FastifyRequest): string[] {
  const su = req.staffUser!
  const wantsAll = req.headers['x-servd-portfolio'] === '1'
  if (wantsAll && su.memberTenantIds.length) return su.memberTenantIds
  return su.tenantId ? [su.tenantId] : []
}
const inTenants = (req: FastifyRequest) => ({ tenantId: { in: readTenants(req) } })
const writeTenants = (req: FastifyRequest) => ({ tenantId: { in: req.staffUser!.memberTenantIds.length ? req.staffUser!.memberTenantIds : [activeTenant(req)] } })

function recordSection(key: string) {
  const sec = sectionByKey(key)
  if (!sec || sec.kind !== 'record') throw new AppError('UNKNOWN_SECTION', `No HR record section "${key}"`, 404)
  return sec
}

const EMP_DATE_COLS = ['cnicExpiry', 'dateOfBirth', 'joiningDate', 'probationEnd', 'confirmationDate', 'contractEnd', 'lastWorkingDay']
const EMP_INT_COLS = ['noticePeriodDays', 'basicSalaryCents', 'grossSalaryCents', 'monthlyTaxCents']
const EMP_COLS = new Set([
  'employeeCode', 'fullName', 'fatherHusbandName', 'cnic', 'gender', 'phone', 'personalEmail',
  'departmentId', 'designationId', 'gradeId', 'locationId', 'managerId', 'employmentType', 'status',
  'paymentMethod', 'bankName', 'iban', 'eobiNo', 'sessiNo', 'ntn', 'photoUrl', ...EMP_DATE_COLS, ...EMP_INT_COLS,
])

// Columns that always hold a value. A blank field must fall back to the
// column's default on create and leave it alone on edit — never write null.
const EMP_NOT_NULL = new Set(['employeeCode', 'fullName', 'employmentType', 'status', 'basicSalaryCents', 'grossSalaryCents', 'monthlyTaxCents'])

function toEmployeeColumns(bound: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(bound)) {
    if (!EMP_COLS.has(k)) continue
    if (EMP_NOT_NULL.has(k) && (v === null || v === undefined || v === '')) continue
    if (EMP_DATE_COLS.includes(k)) out[k] = v ? new Date(String(v)) : null
    else if (EMP_INT_COLS.includes(k)) out[k] = v == null ? (k.endsWith('Cents') ? 0 : null) : Math.round(Number(v))
    else out[k] = v ?? null
  }
  return out
}

function slotColumns(slots: Partial<Record<RecordSlot, unknown>>) {
  const d = (v: unknown) => (v ? new Date(String(v)) : null)
  return {
    ...('employeeId' in slots && { employeeId: (slots.employeeId as string) ?? null }),
    ...('startDate' in slots && { startDate: d(slots.startDate) }),
    ...('endDate' in slots && { endDate: d(slots.endDate) }),
    ...('effectiveDate' in slots && { effectiveDate: d(slots.effectiveDate) }),
    ...('quantity' in slots && { quantity: slots.quantity == null ? null : Number(slots.quantity) }),
    ...('amountCents' in slots && { amountCents: slots.amountCents == null ? null : Math.round(Number(slots.amountCents)) }),
    ...('refId' in slots && { refId: (slots.refId as string) ?? null }),
    ...('category' in slots && { category: (slots.category as string) ?? null }),
  }
}

function formErrors(errors: Array<{ field: string; message: string }>) {
  return new AppError('VALIDATION_ERROR', errors.map((e) => e.message).join('; '), 400)
}

/** Every id a record's data points at must belong to the same company. A
 *  format is data, so a reference field is not trusted to point anywhere safe. */
async function checkReferences(tenantId: string, fields: HrField[], data: Record<string, unknown>) {
  for (const fl of fields) {
    const v = data[fl.key]
    if (v == null || v === '') continue
    const ids = Array.isArray(v) ? v.map(String) : [String(v)]
    let n = 0
    switch (fl.type) {
      case 'employee': case 'employees': n = await prisma.hrEmployee.count({ where: { tenantId, id: { in: ids } } }); break
      case 'orgunit': n = await prisma.hrOrgUnit.count({ where: { tenantId, id: { in: ids }, ...(fl.ref && { kind: fl.ref }) } }); break
      case 'department': n = await prisma.department.count({ where: { id: { in: ids }, OR: [{ tenantId }, { tenantId: null }] } }); break
      case 'location': n = await prisma.location.count({ where: { id: { in: ids }, tenantId } }); break
      case 'record': n = await prisma.hrRecord.count({ where: { tenantId, id: { in: ids }, ...(fl.ref && { section: fl.ref }) } }); break
      default: continue
    }
    if (n !== ids.length) throw new AppError('BAD_REFERENCE', `${fl.label}: not found in this company`, 400)
  }
}

/** Section-specific work before a record is saved. */
async function prepareRecord(tenantId: string, section: string, cols: ReturnType<typeof slotColumns>, data: Record<string, unknown>, id?: string) {
  if (section === 'leave') {
    const r = await checkLeave(tenantId, { id, employeeId: cols.employeeId ?? null, refId: cols.refId ?? null, startDate: cols.startDate ?? null, endDate: cols.endDate ?? null, quantity: cols.quantity ?? null })
    cols.quantity = r.quantity ?? null
    data['days'] = r.quantity
  }
  if (section === 'salary_revision' && cols.employeeId && cols.amountCents) {
    const emp = await prisma.hrEmployee.findUnique({ where: { id: cols.employeeId }, select: { grossSalaryCents: true } })
    if (emp) {
      data['increaseAmount'] = cols.amountCents - emp.grossSalaryCents
      data['increasePct'] = emp.grossSalaryCents > 0 ? Math.round(((cols.amountCents - emp.grossSalaryCents) / emp.grossSalaryCents) * 10000) / 100 : null
      data['currentGross'] = emp.grossSalaryCents
    }
  }
  if (section === 'final_settlement') {
    const n = (k: string) => (typeof data[k] === 'number' ? data[k] as number : 0)
    const net = n('salaryPayable') + n('otPayable') + n('leaveEncashment') - n('deductions') - n('loanRecovery') + n('otherAdjustments')
    data['netAmount'] = net
    cols.amountCents = net
  }
  if (section === 'overtime' && cols.quantity != null && cols.quantity <= 0) {
    throw new AppError('BAD_HOURS', 'OT hours must be more than zero', 400)
  }
}

function recordLabel(rec: HrRecord & { employee?: { fullName: string } | null }, fields: HrField[]): string {
  const d = rec.data as Record<string, unknown>
  const first = fields.find((f) => (f.type === 'text') && typeof d[f.key] === 'string' && d[f.key])
  const bits = [first ? String(d[first.key]) : null, rec.employee?.fullName ?? null, rec.startDate ? rec.startDate.toISOString().slice(0, 10) : null].filter(Boolean)
  return bits.join(' · ') || rec.id.slice(0, 8)
}

async function approvalSubject(rec: HrRecord) {
  if (!rec.employeeId) return { employeeUserId: null, managerUserId: null }
  const emp = await prisma.hrEmployee.findUnique({ where: { id: rec.employeeId }, select: { userId: true, managerId: true } })
  const mgr = emp?.managerId ? await prisma.hrEmployee.findUnique({ where: { id: emp.managerId }, select: { userId: true } }) : null
  return { employeeUserId: emp?.userId ?? null, managerUserId: mgr?.userId ?? null }
}

function csv(rows: Array<Array<unknown>>): string {
  const cell = (v: unknown) => {
    const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
    // Guard against formula injection when the file is opened in Excel.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return rows.map((r) => r.map(cell).join(',')).join('\n')
}

async function createRecord(req: FastifyRequest, tenantId: string, section: string, input: Record<string, unknown>, opts: { submit: boolean; forEmployeeId?: string }) {
  const sec = recordSection(section)
  const fmt = await getFormat(tenantId, section)
  const payload = opts.forEmployeeId ? { ...input, ...Object.fromEntries(fmt.fields.filter((f) => f.bind === 'employeeId').map((f) => [f.key, opts.forEmployeeId])) } : input
  const v = validateAgainst(fmt.fields, payload)
  if (v.errors.length) throw formErrors(v.errors)
  await checkReferences(tenantId, fmt.fields, v.data)
  const cols = slotColumns(v.slots)
  await prepareRecord(tenantId, section, cols, v.data)
  const hasWorkflow = fmt.workflow.length > 0
  const rec = await prisma.hrRecord.create({
    data: {
      tenantId, section, formVersion: fmt.version, ...cols,
      status: hasWorkflow ? (opts.submit ? 'submitted' : 'draft') : 'approved',
      stage: fmt.stages[0] ?? null,
      data: v.data as Prisma.InputJsonValue,
      createdById: req.staffUser!.id,
    },
  })
  await audit({
    category: 'identity', action: `hr.${section}.create`, entity: 'HrRecord', entityId: rec.id,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { section, status: rec.status },
  })
  void sec
  return rec
}

// ─── routes ─────────────────────────────────────────────────────────────────

export async function hrRoutes(fastify: FastifyInstance) {
  // ── Sections & formats ────────────────────────────────────────────────────
  fastify.get('/sections', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const formats = await getAllFormats(activeTenant(req))
    return HR_SECTIONS.map((s) => ({
      key: s.key, specNo: s.specNo, title: s.title, group: s.group, kind: s.kind, config: !!s.config,
      effect: s.effect ?? null, requires: s.requires ?? [],
      format: s.kind === 'record' || s.key === 'employees' ? formats[s.key] : null,
    }))
  })

  fastify.get<{ Params: { section: string } }>('/forms/:section', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const tenantId = activeTenant(req)
    const sec = sectionByKey(req.params.section)
    if (!sec) throw new NotFoundError('HR section', req.params.section)
    const [current, versions] = await Promise.all([
      getFormat(tenantId, sec.key),
      prisma.hrFormDefinition.findMany({ where: { tenantId, section: sec.key }, orderBy: { version: 'desc' }, select: { version: true, isActive: true, note: true, createdAt: true, updatedById: true } }),
    ])
    return { section: { key: sec.key, title: sec.title, requires: sec.requires ?? [], effect: sec.effect ?? null }, current, versions, default: defaultFormat(sec) }
  })

  const fieldSchema: z.ZodType<HrField> = z.lazy(() => z.object({
    key: z.string().min(1).max(60),
    label: z.string().min(1).max(160),
    type: z.string() as unknown as z.ZodType<HrField['type']>,
    required: z.boolean().optional(),
    options: z.array(z.string().max(120)).max(200).optional(),
    ref: z.string().max(60).optional(),
    bind: z.string().max(60).optional() as unknown as z.ZodType<HrField['bind']>,
    group: z.string().max(80).optional(),
    help: z.string().max(300).optional(),
    readOnly: z.boolean().optional(),
    system: z.boolean().optional(),
    columns: z.array(fieldSchema).max(40).optional(),
  }))

  // PUT /hr/forms/:section — save the HR team's format as a new version.
  fastify.put<{ Params: { section: string } }>('/forms/:section', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const tenantId = activeTenant(req)
    const sec = sectionByKey(req.params.section)
    if (!sec || !(sec.kind === 'record' || sec.key === 'employees')) throw new NotFoundError('HR section', req.params.section)
    const body = z.object({
      title: z.string().min(1).max(160).optional(),
      fields: z.array(fieldSchema).min(1).max(200),
      workflow: z.array(z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(80), role: z.enum(['hod', 'hr', 'management']) })).max(6).optional(),
      stages: z.array(z.string().min(1).max(60)).max(30).optional(),
      note: z.string().max(300).optional(),
    }).parse(req.body)

    // Bindings may only point at real slots, and employee bindings only exist
    // on the Employee Master.
    const slots = ['employeeId', 'startDate', 'endDate', 'effectiveDate', 'quantity', 'amountCents', 'refId', 'category']
    for (const fl of body.fields) {
      if (!fl.bind) continue
      const ok = sec.key === 'employees' ? fl.bind.startsWith('employee.') && EMP_COLS.has(fl.bind.slice(9)) : slots.includes(fl.bind)
      if (!ok) throw new AppError('BAD_BINDING', `"${fl.label}" is bound to "${fl.bind}", which this section does not have`, 400)
    }
    if (sec.key === 'employees' && !body.fields.some((f) => f.bind === 'employee.fullName')) {
      throw new AppError('BAD_FORMAT', 'The Employee Master needs a field bound to the employee name', 400)
    }
    const problems = checkFormat({ ...sec, fields: sec.key === 'employees' ? [] : sec.fields }, body.fields)
    if (problems.length) throw new AppError('BAD_FORMAT', problems.join(' · '), 400)

    const last = await prisma.hrFormDefinition.findFirst({ where: { tenantId, section: sec.key }, orderBy: { version: 'desc' } })
    const version = (last?.version ?? 0) + 1
    const cur = await getFormat(tenantId, sec.key)
    await prisma.$transaction([
      prisma.hrFormDefinition.updateMany({ where: { tenantId, section: sec.key }, data: { isActive: false } }),
      prisma.hrFormDefinition.create({
        data: {
          tenantId, section: sec.key, version, title: body.title ?? cur.title,
          fields: body.fields as unknown as Prisma.InputJsonValue,
          workflow: (body.workflow ?? cur.workflow) as unknown as Prisma.InputJsonValue,
          stages: (body.stages ?? cur.stages) as unknown as Prisma.InputJsonValue,
          note: body.note ?? null, updatedById: req.staffUser!.id,
        },
      }),
    ])
    await audit({
      category: 'identity', action: 'hr.format.save', entity: 'HrFormDefinition', entityId: `${sec.key}:v${version}`,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { section: sec.key, version, fields: body.fields.length },
    })
    return getFormat(tenantId, sec.key)
  })

  // POST /hr/forms/:section/activate { version } — roll back to an earlier
  // version (0 = the built-in default).
  fastify.post<{ Params: { section: string } }>('/forms/:section/activate', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const tenantId = activeTenant(req)
    const { version } = z.object({ version: z.number().int().min(0) }).parse(req.body)
    await prisma.hrFormDefinition.updateMany({ where: { tenantId, section: req.params.section }, data: { isActive: false } })
    if (version > 0) {
      const n = await prisma.hrFormDefinition.updateMany({ where: { tenantId, section: req.params.section, version }, data: { isActive: true } })
      if (n.count === 0) throw new NotFoundError('Format version', String(version))
    }
    return getFormat(tenantId, req.params.section)
  })

  // ── Settings ──────────────────────────────────────────────────────────────
  fastify.get('/settings', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => getSettings(activeTenant(req)))

  fastify.put('/settings', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const tenantId = activeTenant(req)
    const body = z.object({
      workingDaysPerMonth: z.number().min(1).max(31),
      hoursPerDay: z.number().min(1).max(24),
      otMultiplier: z.number().min(1).max(5),
      eobi: z.object({
        employeePct: z.number().min(0).max(100), employerPct: z.number().min(0).max(100),
        base: z.enum(['fixed', 'gross']), fixedWageCents: z.number().int().min(0).nullable(),
      }),
      sessi: z.object({ employerPct: z.number().min(0).max(100), wageCeilingCents: z.number().int().min(0).nullable() }),
      latesPerDeductionDay: z.number().int().min(0).max(31),
      lateGraceMinutes: z.number().int().min(0).max(240),
      deductAbsences: z.boolean(),
      leaveYearStartMonth: z.number().int().min(1).max(12),
      encashLeaveOnExit: z.boolean(),
      employeeCodePrefix: z.string().max(12),
    }).parse(req.body)
    const before = await getSettings(tenantId)
    const next = mergeSettings(body as Partial<HrSettings>)
    await saveSettings(tenantId, next)
    await audit({ category: 'identity', action: 'hr.settings.update', entity: 'Setting', entityId: `hr.settings.${tenantId}`, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, before, after: next })
    return next
  })

  // ── Organization setup ────────────────────────────────────────────────────
  fastify.get('/org', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const tenantId = activeTenant(req)
    const [units, departments, locations] = await Promise.all([
      prisma.hrOrgUnit.findMany({ where: { tenantId }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] }),
      prisma.department.findMany({ where: { tenantId, archivedAt: null }, orderBy: { order: 'asc' }, select: { id: true, name: true } }),
      prisma.location.findMany({ where: { tenantId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ])
    return { units, departments, locations, kinds: ORG_UNIT_KINDS }
  })

  fastify.post('/org/units', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const tenantId = activeTenant(req)
    const body = z.object({ kind: z.enum(ORG_UNIT_KINDS), name: z.string().min(1).max(120), code: z.string().max(40).optional(), parentId: z.string().uuid().nullable().optional() }).parse(req.body)
    const exists = await prisma.hrOrgUnit.findFirst({ where: { tenantId, kind: body.kind, name: body.name.trim() } })
    if (exists) throw new AppError('DUPLICATE', `"${body.name}" already exists`, 409)
    const unit = await prisma.hrOrgUnit.create({ data: { tenantId, kind: body.kind, name: body.name.trim(), code: body.code || null, parentId: body.parentId ?? null } })
    return reply.status(201).send(unit)
  })

  fastify.patch<{ Params: { id: string } }>('/org/units/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const body = z.object({ name: z.string().min(1).max(120).optional(), code: z.string().max(40).nullable().optional(), isActive: z.boolean().optional() }).parse(req.body)
    const unit = await prisma.hrOrgUnit.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!unit) throw new NotFoundError('Org unit', req.params.id)
    return prisma.hrOrgUnit.update({ where: { id: unit.id }, data: body })
  })

  fastify.post('/org/departments', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const tenantId = activeTenant(req)
    const body = z.object({ name: z.string().min(1).max(120) }).parse(req.body)
    const exists = await prisma.department.findFirst({ where: { tenantId, name: body.name.trim() } })
    if (exists) throw new AppError('DUPLICATE', `"${body.name}" already exists`, 409)
    return reply.status(201).send(await prisma.department.create({ data: { tenantId, name: body.name.trim() } }))
  })

  // ── Lookups for pickers (names only — no salaries) ────────────────────────
  fastify.get('/lookups', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const tenantId = activeTenant(req)
    const isAdmin = HR_ADMIN.includes(req.staffUser!.role)
    const [employees, formats] = await Promise.all([
      prisma.hrEmployee.findMany({
        where: { tenantId, ...(isAdmin ? {} : { status: { in: ['active', 'on_leave'] } }) },
        select: { id: true, fullName: true, employeeCode: true, status: true },
        orderBy: { fullName: 'asc' },
      }),
      getAllFormats(tenantId),
    ])
    // Records other sections point at (shifts, leave types, candidates, …).
    const refSections = Array.from(new Set(Object.values(formats).flatMap((f) => f.fields.filter((x) => x.type === 'record' && x.ref).map((x) => x.ref!))))
    const recs = refSections.length
      ? await prisma.hrRecord.findMany({ where: { tenantId, section: { in: refSections }, status: { not: 'cancelled' } }, include: { employee: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' }, take: 2000 })
      : []
    const records: Record<string, Array<{ id: string; label: string }>> = {}
    for (const r of recs) (records[r.section] ??= []).push({ id: r.id, label: recordLabel(r, formats[r.section]?.fields ?? []) })
    return { employees, records }
  })

  // ── Employees ─────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { status?: string; q?: string; departmentId?: string; locationId?: string } }>(
    '/employees', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
      await Promise.all(readTenants(req).map((t) => applyDueEffects(t)))
      const { status, q, departmentId, locationId } = req.query
      const rows = await prisma.hrEmployee.findMany({
        where: {
          ...inTenants(req),
          ...(status === 'current' ? { status: { in: ['active', 'on_leave'] } } : status ? { status } : {}),
          ...(departmentId && { departmentId }),
          ...(locationId && { locationId }),
          ...(q && { OR: [
            { fullName: { contains: q, mode: 'insensitive' } }, { employeeCode: { contains: q, mode: 'insensitive' } },
            { cnic: { contains: q } }, { phone: { contains: q } },
          ] }),
        },
        orderBy: { employeeCode: 'asc' },
      })
      const label = await employeeLabels(activeTenant(req), rows)
      return rows.map((e) => ({
        id: e.id, employeeCode: e.employeeCode, fullName: e.fullName, phone: e.phone, status: e.status,
        employmentType: e.employmentType, joiningDate: e.joiningDate, grossSalaryCents: e.grossSalaryCents,
        department: label(e.departmentId), designation: label(e.designationId), branch: label(e.locationId), manager: label(e.managerId),
        userId: e.userId, tenantId: e.tenantId,
      }))
    })

  fastify.get<{ Params: { id: string } }>('/employees/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const emp = await prisma.hrEmployee.findFirst({ where: { id: req.params.id, ...inTenants(req) }, include: { documents: { orderBy: { createdAt: 'desc' } } } })
    if (!emp) throw new NotFoundError('Employee', req.params.id)
    await applyDueEffects(emp.tenantId)
    const fresh = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emp.id } })
    const [label, records, balances, loans, user] = await Promise.all([
      employeeLabels(emp.tenantId, [fresh]),
      prisma.hrRecord.findMany({ where: { employeeId: emp.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
      leaveBalancesFor(emp.tenantId, emp.id),
      loansFor(emp.tenantId, emp.id),
      fresh.userId ? prisma.user.findUnique({ where: { id: fresh.userId }, select: { id: true, name: true, email: true, role: true } }) : null,
    ])
    const salaryHistory = records
      .filter((r) => (r.section === 'salary_revision' || r.section === 'promotion') && r.status === 'approved' && r.amountCents)
      .map((r) => ({ section: r.section, effectiveDate: r.effectiveDate, grossCents: r.amountCents, applied: !!r.appliedAt }))
    return {
      employee: fresh,
      labels: { department: label(fresh.departmentId), designation: label(fresh.designationId), grade: label(fresh.gradeId), branch: label(fresh.locationId), manager: label(fresh.managerId) },
      documents: emp.documents, records, leaveBalances: balances, loans, salaryHistory, user,
    }
  })

  async function saveEmployee(req: FastifyRequest, id: string | null) {
    const tenantId = id ? (await prisma.hrEmployee.findFirst({ where: { id, ...writeTenants(req) }, select: { tenantId: true } }))?.tenantId : activeTenant(req)
    if (!tenantId) throw new NotFoundError('Employee', id ?? '')
    const fmt = await getFormat(tenantId, 'employees')
    const body = z.object({ data: z.record(z.unknown()) }).parse(req.body)
    const v = validateAgainst(fmt.fields, body.data, { partial: !!id })
    if (v.errors.length) throw formErrors(v.errors)
    await checkReferences(tenantId, fmt.fields, v.data)
    const cols = toEmployeeColumns(v.employee)
    if (id && cols['managerId'] === id) throw new AppError('BAD_MANAGER', 'An employee cannot report to themselves', 400)
    const extra = Object.fromEntries(Object.entries(v.data).filter(([k]) => !fmt.fields.find((f) => f.key === k)?.bind))
    if (!id) {
      const s = await getSettings(tenantId)
      if (!cols['employeeCode']) {
        const codes = await prisma.hrEmployee.findMany({ where: { tenantId }, select: { employeeCode: true } })
        cols['employeeCode'] = nextEmployeeCode(s.employeeCodePrefix, codes.map((c) => c.employeeCode))
      }
      if (await prisma.hrEmployee.findFirst({ where: { tenantId, employeeCode: String(cols['employeeCode']) } })) {
        throw new AppError('DUPLICATE_CODE', `Employee ID ${cols['employeeCode']} is already used`, 409)
      }
      const emp = await prisma.hrEmployee.create({
        data: { tenantId, ...(cols as object), fullName: String(cols['fullName']), employeeCode: String(cols['employeeCode']), data: extra as Prisma.InputJsonValue, createdById: req.staffUser!.id } as Prisma.HrEmployeeUncheckedCreateInput,
      })
      await audit({ category: 'identity', action: 'hr.employee.create', entity: 'HrEmployee', entityId: emp.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { employeeCode: emp.employeeCode, fullName: emp.fullName } })
      return emp
    }
    const cur = await prisma.hrEmployee.findUniqueOrThrow({ where: { id } })
    if (cols['employeeCode'] && cols['employeeCode'] !== cur.employeeCode &&
        await prisma.hrEmployee.findFirst({ where: { tenantId, employeeCode: String(cols['employeeCode']), NOT: { id } } })) {
      throw new AppError('DUPLICATE_CODE', `Employee ID ${cols['employeeCode']} is already used`, 409)
    }
    // Salary on the master can be corrected by HR, but a change is recorded —
    // the salary history should not have silent gaps.
    const salaryChanged = (cols['grossSalaryCents'] !== undefined && cols['grossSalaryCents'] !== cur.grossSalaryCents)
    const emp = await prisma.hrEmployee.update({
      where: { id },
      data: { ...(cols as object), data: { ...(cur.data as object), ...extra } as Prisma.InputJsonValue } as Prisma.HrEmployeeUncheckedUpdateInput,
    })
    await audit({
      category: 'identity', action: salaryChanged ? 'hr.employee.salary_edit' : 'hr.employee.update', entity: 'HrEmployee', entityId: id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      before: salaryChanged ? { grossSalaryCents: cur.grossSalaryCents } : undefined,
      after: salaryChanged ? { grossSalaryCents: emp.grossSalaryCents } : { fields: Object.keys(v.data) },
    })
    return emp
  }

  fastify.post('/employees', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => reply.status(201).send(await saveEmployee(req, null)))
  fastify.patch<{ Params: { id: string } }>('/employees/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => saveEmployee(req, req.params.id))

  // Link a servd login to an employee — unlocks self-service and HOD approvals.
  fastify.post<{ Params: { id: string } }>('/employees/:id/link-user', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const { userId } = z.object({ userId: z.string().uuid().nullable() }).parse(req.body)
    const emp = await prisma.hrEmployee.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!emp) throw new NotFoundError('Employee', req.params.id)
    if (userId) {
      const u = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } })
      if (!u) throw new NotFoundError('User', userId)
      const taken = await prisma.hrEmployee.findFirst({ where: { userId, NOT: { id: emp.id } } })
      if (taken) throw new AppError('ALREADY_LINKED', `That login is already linked to ${taken.fullName}`, 409)
    }
    return prisma.hrEmployee.update({ where: { id: emp.id }, data: { userId } })
  })

  // ── Documents ─────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { employeeId?: string; expiringDays?: string } }>('/documents', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const days = req.query.expiringDays ? parseInt(req.query.expiringDays, 10) : null
    return prisma.hrDocument.findMany({
      where: {
        ...inTenants(req),
        ...(req.query.employeeId && { employeeId: req.query.employeeId }),
        ...(days != null && { expiryDate: { not: null, lte: new Date(Date.now() + days * 86_400_000) } }),
      },
      include: { employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'desc' }],
      take: 1000,
    })
  })

  const docSchema = z.object({
    employeeId: z.string().uuid(),
    docType: z.string().min(1).max(60),
    title: z.string().max(160).optional(),
    fileUrl: z.string().url().max(1000).optional(),
    issueDate: z.string().optional(),
    expiryDate: z.string().optional(),
    notes: z.string().max(1000).optional(),
  })
  fastify.post('/documents', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const body = docSchema.parse(req.body)
    const emp = await prisma.hrEmployee.findFirst({ where: { id: body.employeeId, ...writeTenants(req) } })
    if (!emp) throw new NotFoundError('Employee', body.employeeId)
    const doc = await prisma.hrDocument.create({
      data: {
        tenantId: emp.tenantId, employeeId: emp.id, docType: body.docType, title: body.title || null, fileUrl: body.fileUrl || null,
        issueDate: body.issueDate ? new Date(body.issueDate) : null, expiryDate: body.expiryDate ? new Date(body.expiryDate) : null, notes: body.notes || null,
      },
    })
    return reply.status(201).send(doc)
  })
  fastify.post<{ Params: { id: string } }>('/documents/:id/verify', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const doc = await prisma.hrDocument.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!doc) throw new NotFoundError('Document', req.params.id)
    return prisma.hrDocument.update({ where: { id: doc.id }, data: { verifiedById: req.staffUser!.id, verifiedAt: new Date() } })
  })
  fastify.delete<{ Params: { id: string } }>('/documents/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const doc = await prisma.hrDocument.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!doc) throw new NotFoundError('Document', req.params.id)
    await prisma.hrDocument.delete({ where: { id: doc.id } })
    return reply.status(204).send()
  })
  fastify.get('/documents/types', { preHandler: requireAuth(...HR_ADMIN) }, async () => DOCUMENT_TYPES)

  // ── Section records ───────────────────────────────────────────────────────
  fastify.get<{ Params: { section: string }; Querystring: { status?: string; employeeId?: string; stage?: string; from?: string; to?: string } }>(
    '/records/:section', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
      const sec = recordSection(req.params.section)
      const { status, employeeId, stage, from, to } = req.query
      const [rows, fmt] = await Promise.all([
        prisma.hrRecord.findMany({
          where: {
            ...inTenants(req), section: sec.key,
            ...(status && { status }), ...(employeeId && { employeeId }), ...(stage && { stage }),
            ...((from || to) && { startDate: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } }),
          },
          include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
          orderBy: { createdAt: 'desc' },
          take: 1000,
        }),
        getFormat(activeTenant(req), sec.key),
      ])
      return { format: fmt, records: rows.map((r) => ({ ...r, label: recordLabel(r, fmt.fields) })) }
    })

  fastify.get<{ Params: { section: string; id: string } }>('/records/:section/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...inTenants(req) }, include: { employee: { select: { id: true, fullName: true, employeeCode: true } } } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
    return { record: rec, format: fmt }
  })

  fastify.post<{ Params: { section: string } }>('/records/:section', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const body = z.object({ data: z.record(z.unknown()), submit: z.boolean().default(true) }).parse(req.body)
    return reply.status(201).send(await createRecord(req, activeTenant(req), req.params.section, body.data, { submit: body.submit }))
  })

  fastify.patch<{ Params: { section: string; id: string } }>('/records/:section/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const body = z.object({ data: z.record(z.unknown()) }).parse(req.body)
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
    const approvals = rec.approvals as unknown as ApprovalEntry[]
    // Once an approver has acted, the content they approved is frozen. A
    // change after that is a new request, not an edit.
    if (fmt.workflow.length && (rec.status === 'approved' || rec.status === 'rejected' || approvals.length > 0)) {
      throw new AppError('LOCKED', 'This request has already been acted on and can no longer be edited', 409)
    }
    const merged = { ...(rec.data as Record<string, unknown>), ...body.data }
    const v = validateAgainst(fmt.fields, merged)
    if (v.errors.length) throw formErrors(v.errors)
    await checkReferences(rec.tenantId, fmt.fields, v.data)
    const cols = slotColumns(v.slots)
    await prepareRecord(rec.tenantId, rec.section, cols, v.data, rec.id)
    return prisma.hrRecord.update({ where: { id: rec.id }, data: { ...cols, data: v.data as Prisma.InputJsonValue } })
  })

  fastify.post<{ Params: { section: string; id: string } }>('/records/:section/:id/submit', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    if (!HR_ADMIN.includes(req.staffUser!.role) && rec.createdById !== req.staffUser!.id) throw new ForbiddenError('Not your request')
    if (rec.status !== 'draft') throw new AppError('NOT_DRAFT', 'Only a draft can be submitted', 409)
    if (rec.section === 'leave') await checkLeave(rec.tenantId, rec)
    return prisma.hrRecord.update({ where: { id: rec.id }, data: { status: 'submitted' } })
  })

  // POST /hr/records/:section/:id/decide — approve or reject the current step.
  fastify.post<{ Params: { section: string; id: string } }>('/records/:section/:id/decide', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({
      decision: z.enum(['approved', 'rejected']),
      note: z.string().max(500).optional(),
      approvedHours: z.number().min(0).max(24 * 31).optional(), // overtime only
    }).parse(req.body)
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    if (rec.status !== 'submitted') throw new AppError('NOT_PENDING', 'This request is not waiting for approval', 409)
    const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
    const step: WorkflowStep | undefined = fmt.workflow[rec.currentStep]
    if (!step) throw new AppError('NO_STEP', 'This request has no approval step left', 409)
    const who = canActOnStep(step.role, { id: req.staffUser!.id, role: req.staffUser!.role }, await approvalSubject(rec))
    if (!who.ok) throw new ForbiddenError(who.reason ?? 'You cannot approve this step')

    const entry: ApprovalEntry = {
      step: step.key, role: step.role, decision: body.decision, byUserId: req.staffUser!.id,
      byName: req.staffUser!.name ?? req.staffUser!.email ?? 'Unknown', at: new Date().toISOString(),
      ...(body.note && { note: body.note }), ...(who.override && { override: true }),
    }
    const isLast = rec.currentStep >= fmt.workflow.length - 1
    const nextStatus = body.decision === 'rejected' ? 'rejected' : isLast ? 'approved' : 'submitted'
    const s = await getSettings(rec.tenantId)

    const updated = await prisma.$transaction(async (tx) => {
      // Claim the step: two approvers clicking at once must not both advance it.
      const claimed = await tx.hrRecord.updateMany({
        where: { id: rec.id, status: 'submitted', currentStep: rec.currentStep },
        data: {
          status: nextStatus,
          currentStep: body.decision === 'approved' && !isLast ? rec.currentStep + 1 : rec.currentStep,
          approvals: [...(rec.approvals as unknown as ApprovalEntry[]), entry] as unknown as Prisma.InputJsonValue,
        },
      })
      if (claimed.count === 0) throw new AppError('CONFLICT', 'Someone else acted on this request first — reload', 409)
      if (nextStatus === 'approved') {
        const emp = rec.employeeId ? await tx.hrEmployee.findUnique({ where: { id: rec.employeeId } }) : null
        await onFinalApproval(tx, { ...rec, status: 'approved' }, emp, s, { approvedHours: body.approvedHours ?? null })
      }
      return tx.hrRecord.findUniqueOrThrow({ where: { id: rec.id } })
    })
    if (nextStatus === 'approved') await applyDueEffects(rec.tenantId)
    await audit({
      category: 'identity', action: `hr.${rec.section}.${body.decision}`, entity: 'HrRecord', entityId: rec.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: rec.tenantId,
      after: { step: step.key, status: nextStatus, override: who.override },
    })
    return updated
  })

  fastify.post<{ Params: { section: string; id: string } }>('/records/:section/:id/stage', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const { stage } = z.object({ stage: z.string().min(1).max(60) }).parse(req.body)
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    const fmt = await getFormat(rec.tenantId, rec.section)
    if (!fmt.stages.includes(stage)) throw new AppError('BAD_STAGE', `Stage must be one of: ${fmt.stages.join(', ')}`, 400)
    return prisma.hrRecord.update({ where: { id: rec.id }, data: { stage } })
  })

  fastify.post<{ Params: { section: string; id: string } }>('/records/:section/:id/cancel', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    if (!HR_ADMIN.includes(req.staffUser!.role) && rec.createdById !== req.staffUser!.id) throw new ForbiddenError('Not your request')
    if (rec.appliedAt) throw new AppError('APPLIED', 'This has already taken effect and cannot be cancelled — raise a new request to reverse it', 409)
    if (rec.section === 'loan' && rec.status === 'approved' && (await loansFor(rec.tenantId, rec.employeeId ?? undefined)).some((l) => l.id === rec.id && l.recoveredCents > 0)) {
      throw new AppError('APPLIED', 'Installments have already been deducted for this loan', 409)
    }
    return prisma.hrRecord.update({ where: { id: rec.id }, data: { status: 'cancelled' } })
  })

  fastify.get<{ Params: { section: string }; Querystring: { status?: string; from?: string; to?: string } }>('/records/:section/export.csv', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const sec = recordSection(req.params.section)
    const fmt = await getFormat(activeTenant(req), sec.key)
    const { status, from, to } = req.query
    const rows = await prisma.hrRecord.findMany({ where: {
      ...inTenants(req), section: sec.key, ...(status && { status }),
      ...((from || to) && { startDate: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } }),
    }, include: { employee: { select: { fullName: true, employeeCode: true } } }, orderBy: { createdAt: 'asc' } })
    const cols = fmt.fields.filter((f) => f.type !== 'table')
    const out = csv([
      ['Record', 'Status', 'Stage', 'Employee ID', 'Employee', ...cols.map((c) => c.label), 'Created'],
      ...rows.map((r) => [r.id, r.status, r.stage, r.employee?.employeeCode, r.employee?.fullName, ...cols.map((c) => (r.data as Record<string, unknown>)[c.key]), r.createdAt]),
    ])
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="hr-${sec.key}.csv"`).send(out)
  })

  // Offer → Employee Master.
  fastify.post<{ Params: { id: string } }>('/records/offer/:id/create-employee', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: 'offer', ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('Offer', req.params.id)
    if (rec.status !== 'approved') throw new AppError('NOT_APPROVED', 'The offer must be approved first', 409)
    const d = rec.data as Record<string, unknown>
    if (d['acceptance'] && d['acceptance'] !== 'accepted') throw new AppError('NOT_ACCEPTED', 'The offer has not been accepted', 409)
    if (d['_employeeId']) throw new AppError('ALREADY_CREATED', 'An employee was already created from this offer', 409)
    const s = await getSettings(rec.tenantId)
    const codes = await prisma.hrEmployee.findMany({ where: { tenantId: rec.tenantId }, select: { employeeCode: true } })
    const probMonths = typeof d['probationMonths'] === 'number' ? d['probationMonths'] as number : 0
    const joining = rec.startDate
    const emp = await prisma.hrEmployee.create({
      data: {
        tenantId: rec.tenantId,
        employeeCode: nextEmployeeCode(s.employeeCodePrefix, codes.map((c) => c.employeeCode)),
        fullName: String(d['candidateName'] ?? 'New employee'),
        designationId: typeof d['designation'] === 'string' ? d['designation'] : null,
        departmentId: typeof d['department'] === 'string' ? d['department'] : null,
        locationId: typeof d['location'] === 'string' ? d['location'] : null,
        grossSalaryCents: rec.amountCents ?? 0,
        joiningDate: joining,
        employmentType: probMonths > 0 ? 'probation' : 'permanent',
        probationEnd: joining && probMonths > 0 ? new Date(Date.UTC(joining.getUTCFullYear(), joining.getUTCMonth() + probMonths, joining.getUTCDate())) : null,
        noticePeriodDays: typeof d['noticePeriodDays'] === 'number' ? d['noticePeriodDays'] as number : null,
        createdById: req.staffUser!.id,
        data: { fromOfferId: rec.id } as Prisma.InputJsonValue,
      },
    })
    await prisma.hrRecord.update({ where: { id: rec.id }, data: { data: { ...d, _employeeId: emp.id } as Prisma.InputJsonValue } })
    await audit({ category: 'identity', action: 'hr.employee.create_from_offer', entity: 'HrEmployee', entityId: emp.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: rec.tenantId, after: { offerId: rec.id } })
    return reply.status(201).send(emp)
  })

  // Full & final — work the figures out from what HR already holds.
  fastify.post('/final-settlement/calculate', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const body = z.object({ employeeId: z.string().uuid(), lastWorkingDay: z.string(), unpaidMonthSalary: z.boolean().default(true) }).parse(req.body)
    const emp = await prisma.hrEmployee.findFirst({ where: { id: body.employeeId, ...writeTenants(req) } })
    if (!emp) throw new NotFoundError('Employee', body.employeeId)
    const lwd = new Date(body.lastWorkingDay)
    const s = await getSettings(emp.tenantId)
    const period = periodOf(lwd)
    const lockedRun = await prisma.hrPayrollRun.findFirst({ where: { tenantId: emp.tenantId, period, status: 'locked' } })
    const [ot, balances, loans] = await Promise.all([
      lockedRun ? Promise.resolve([]) : prisma.hrRecord.findMany({ where: { employeeId: emp.id, section: 'overtime', status: 'approved', startDate: { gte: periodStart(period), lte: periodEnd(period) } } }),
      leaveBalancesFor(emp.tenantId, emp.id, lwd),
      loansFor(emp.tenantId, emp.id),
    ])
    const leaveDays = balances.filter((b) => b.paid).reduce((a, b) => a + Math.max(0, b.balance), 0)
    const r = finalSettlement(emp, lwd, {
      unpaidMonthSalary: body.unpaidMonthSalary && !lockedRun,
      otPayableCents: ot.reduce((a, o) => a + (o.amountCents ?? 0), 0),
      leaveBalanceDays: leaveDays,
      loanOutstandingCents: loans.reduce((a, l) => a + l.outstandingCents, 0),
      deductionsCents: 0, otherAdjustmentsCents: 0,
    }, s)
    return { ...r, leaveBalanceDays: leaveDays, finalMonthAlreadyPaid: !!lockedRun }
  })

  // ── Payroll ───────────────────────────────────────────────────────────────
  fastify.get('/payroll/runs', { preHandler: requireAuth(...HR_ADMIN) }, async (req) =>
    prisma.hrPayrollRun.findMany({ where: inTenants(req), orderBy: { period: 'desc' }, take: 60 }))

  fastify.post('/payroll/runs', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const tenantId = activeTenant(req)
    const { period } = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.body)
    if (await prisma.hrPayrollRun.findFirst({ where: { tenantId, period } })) throw new AppError('EXISTS', `There is already a payroll for ${period}`, 409)
    const s = await getSettings(tenantId)
    const run = await prisma.hrPayrollRun.create({ data: { tenantId, period, settings: s as unknown as Prisma.InputJsonValue, createdById: req.staffUser!.id } })
    await calculateRun(tenantId, run.id)
    return reply.status(201).send(await prisma.hrPayrollRun.findUnique({ where: { id: run.id } }))
  })

  fastify.get<{ Params: { id: string } }>('/payroll/runs/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...inTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    const slips = await prisma.hrPayslip.findMany({ where: { runId: run.id }, include: { employee: { select: { fullName: true, employeeCode: true, bankName: true, iban: true, paymentMethod: true, eobiNo: true } } }, orderBy: { employee: { employeeCode: 'asc' } } })
    return { run, payslips: slips }
  })

  fastify.post<{ Params: { id: string } }>('/payroll/runs/:id/recalculate', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    return calculateRun(run.tenantId, run.id)
  })

  fastify.patch<{ Params: { id: string } }>('/payroll/payslips/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const body = z.object({
      absentDays: z.number().min(0).max(31).optional(),
      unpaidLeaveDays: z.number().min(0).max(31).optional(),
      lateCount: z.number().int().min(0).max(62).optional(),
      otHours: z.number().min(0).optional(),
      otCents: z.number().int().min(0).optional(),
      earningAdjustmentsCents: z.number().int().min(0).optional(),
      deductionAdjustmentsCents: z.number().int().min(0).optional(),
      loanInstallmentsCents: z.number().int().min(0).optional(),
    }).parse(req.body)
    const slip = await prisma.hrPayslip.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!slip) throw new NotFoundError('Payslip', req.params.id)
    await recalcPayslip(slip.id, body)
    return prisma.hrPayslip.findUnique({ where: { id: slip.id } })
  })

  fastify.post<{ Params: { id: string } }>('/payroll/runs/:id/approve', { preHandler: requireAuth(...PAYROLL_APPROVERS) }, async (req) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    // The person who prepared payroll does not also approve it — except the
    // CEO, who is allowed to run a one-person office.
    if (run.createdById === req.staffUser!.id && req.staffUser!.role !== 'admin') {
      throw new ForbiddenError('Payroll must be approved by someone other than the person who prepared it')
    }
    const n = await prisma.hrPayrollRun.updateMany({ where: { id: run.id, status: 'draft' }, data: { status: 'approved', approvedById: req.staffUser!.id, approvedAt: new Date() } })
    if (n.count === 0) throw new AppError('NOT_DRAFT', 'This payroll is not a draft', 409)
    await audit({ category: 'identity', action: 'hr.payroll.approve', entity: 'HrPayrollRun', entityId: run.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: run.tenantId, after: { period: run.period, totals: run.totals } })
    return prisma.hrPayrollRun.findUnique({ where: { id: run.id } })
  })

  fastify.post<{ Params: { id: string } }>('/payroll/runs/:id/reopen', { preHandler: requireAuth(...PAYROLL_APPROVERS) }, async (req) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    const n = await prisma.hrPayrollRun.updateMany({ where: { id: run.id, status: 'approved' }, data: { status: 'draft', approvedById: null, approvedAt: null } })
    if (n.count === 0) throw new AppError('NOT_APPROVED', 'Only an approved (not locked) payroll can be reopened', 409)
    return prisma.hrPayrollRun.findUnique({ where: { id: run.id } })
  })

  // Lock: final. Loan recoveries count from here, and nothing changes after.
  fastify.post<{ Params: { id: string } }>('/payroll/runs/:id/lock', { preHandler: requireAuth(...PAYROLL_APPROVERS) }, async (req) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    const n = await prisma.hrPayrollRun.updateMany({ where: { id: run.id, status: 'approved' }, data: { status: 'locked', lockedAt: new Date() } })
    if (n.count === 0) throw new AppError('NOT_APPROVED', 'Approve the payroll before locking it', 409)
    await audit({ category: 'identity', action: 'hr.payroll.lock', entity: 'HrPayrollRun', entityId: run.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: run.tenantId, after: { period: run.period } })
    return prisma.hrPayrollRun.findUnique({ where: { id: run.id } })
  })

  fastify.delete<{ Params: { id: string } }>('/payroll/runs/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    if (run.status !== 'draft') throw new AppError('NOT_DRAFT', 'Only a draft payroll can be deleted', 409)
    await prisma.hrPayrollRun.delete({ where: { id: run.id } })
    return reply.status(204).send()
  })

  fastify.get<{ Params: { id: string }; Querystring: { kind?: string } }>('/payroll/runs/:id/export.csv', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...inTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    const slips = await prisma.hrPayslip.findMany({ where: { runId: run.id }, include: { employee: true }, orderBy: { employee: { employeeCode: 'asc' } } })
    const kind = req.query.kind ?? 'register'
    const r = (c: number) => (c / 100).toFixed(2)
    let rows: unknown[][]
    if (kind === 'bank') {
      rows = [['Employee ID', 'Name', 'Bank', 'IBAN', 'Net pay'], ...slips.filter((s) => s.employee.paymentMethod !== 'cash').map((s) => [s.employee.employeeCode, s.employee.fullName, s.employee.bankName, s.employee.iban, r(s.netCents)])]
    } else if (kind === 'eobi') {
      rows = [['Employee ID', 'Name', 'CNIC', 'EOBI no.', 'Employee 1%', 'Employer 5%', 'Total'], ...slips.map((s) => [s.employee.employeeCode, s.employee.fullName, s.employee.cnic, s.employee.eobiNo, r(s.eobiEmployeeCents), r(s.eobiEmployerCents), r(s.eobiEmployeeCents + s.eobiEmployerCents)])]
    } else if (kind === 'deductions') {
      rows = [['Employee ID', 'Name', 'Deduction', 'Amount'], ...slips.flatMap((s) => (s.lines as Array<{ kind: string; label: string; amountCents: number }>).filter((l) => l.kind === 'deduction').map((l) => [s.employee.employeeCode, s.employee.fullName, l.label, r(l.amountCents)]))]
    } else {
      rows = [['Employee ID', 'Name', 'Gross', 'Earnings', 'Deductions', 'EOBI employee', 'EOBI employer', 'Net'], ...slips.map((s) => [s.employee.employeeCode, s.employee.fullName, r(s.grossCents), r(s.earningsCents), r(s.deductionsCents), r(s.eobiEmployeeCents), r(s.eobiEmployerCents), r(s.netCents)])]
    }
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="payroll-${run.period}-${kind}.csv"`).send(csv(rows))
  })

  // ── Letters ───────────────────────────────────────────────────────────────
  fastify.get('/letters', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const stored = await prisma.hrLetterTemplate.findMany({ where: { tenantId: activeTenant(req) } })
    return DEFAULT_LETTERS.map((d) => {
      const s = stored.find((x) => x.key === d.key)
      const body = s?.body ?? d.body
      return { key: d.key, title: s?.title ?? d.title, body, isDefault: !s, version: s?.version ?? 0, placeholders: placeholdersIn(body) }
    })
  })

  fastify.put<{ Params: { key: string } }>('/letters/:key', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const tenantId = activeTenant(req)
    if (!DEFAULT_LETTERS.some((d) => d.key === req.params.key)) throw new NotFoundError('Letter', req.params.key)
    const body = z.object({ title: z.string().min(1).max(160), body: z.string().min(1).max(100_000) }).parse(req.body)
    const cur = await prisma.hrLetterTemplate.findUnique({ where: { tenantId_key: { tenantId, key: req.params.key } } })
    return prisma.hrLetterTemplate.upsert({
      where: { tenantId_key: { tenantId, key: req.params.key } },
      create: { tenantId, key: req.params.key, title: body.title, body: body.body, updatedById: req.staffUser!.id },
      update: { title: body.title, body: body.body, version: (cur?.version ?? 1) + 1, updatedById: req.staffUser!.id },
    })
  })

  // Back to the built-in default: the company's own version is removed.
  fastify.delete<{ Params: { key: string } }>('/letters/:key', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    await prisma.hrLetterTemplate.deleteMany({ where: { tenantId: activeTenant(req), key: req.params.key } })
    return reply.status(204).send()
  })

  fastify.post('/letters/render', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const body = z.object({ key: z.string(), employeeId: z.string().uuid().optional(), recordId: z.string().uuid().optional() }).parse(req.body)
    const tenantId = activeTenant(req)
    const [emp, rec, tpl] = await Promise.all([
      body.employeeId ? prisma.hrEmployee.findFirst({ where: { id: body.employeeId, ...writeTenants(req) } }) : null,
      body.recordId ? prisma.hrRecord.findFirst({ where: { id: body.recordId, ...writeTenants(req) } }) : null,
      prisma.hrLetterTemplate.findUnique({ where: { tenantId_key: { tenantId, key: body.key } } }),
    ])
    const def = DEFAULT_LETTERS.find((d) => d.key === body.key)
    if (!def) throw new NotFoundError('Letter', body.key)
    const employee = emp ?? (rec?.employeeId ? await prisma.hrEmployee.findUnique({ where: { id: rec.employeeId } }) : null)
    const ctx = await letterContext(tenantId, employee, rec)
    const out = renderLetter(tpl?.body ?? def.body, ctx)
    await audit({ category: 'identity', action: 'hr.letter.render', entity: 'HrLetterTemplate', entityId: body.key, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { employeeId: employee?.id ?? null, recordId: rec?.id ?? null } })
    return { title: tpl?.title ?? def.title, ...out }
  })

  // ── Dashboard & reports ───────────────────────────────────────────────────
  fastify.get('/dashboard', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    await Promise.all(readTenants(req).map((t) => applyDueEffects(t)))
    const [d, due] = await Promise.all([dashboard(readTenants(req)), dueList(readTenants(req), 30)])
    return { ...d, due: due.slice(0, 50) }
  })

  fastify.get<{ Querystring: { days?: string } }>('/due', { preHandler: requireAuth(...HR_ADMIN) }, async (req) =>
    dueList(readTenants(req), Math.min(365, parseInt(req.query.days ?? '30', 10) || 30)))

  // Reports (§30). The two original CSV paths stay as aliases.
  fastify.get('/reports', { preHandler: requireAuth(...HR_ADMIN) }, async () => REPORTS)

  const sendReport = async (req: FastifyRequest, reply: FastifyReply, key: string, q: ReportQuery) => {
    const t = await buildReport(key, readTenants(req), activeTenant(req), q)
    return reply.header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="hr-${key.replace(/_/g, '-')}.csv"`)
      .send(csv([t.header, ...t.rows]))
  }
  fastify.get('/reports/employees.csv', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => sendReport(req, reply, 'employee_master', {}))
  fastify.get('/reports/leave-balances.csv', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => sendReport(req, reply, 'leave_balance', {}))

  fastify.get<{ Params: { key: string }; Querystring: ReportQuery }>('/reports/:key', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const m = /^(.+)\.csv$/.exec(req.params.key)
    if (m) return sendReport(req, reply, m[1]!, req.query)
    // On-screen preview: first 500 rows, with the full count.
    const t = await buildReport(req.params.key, readTenants(req), activeTenant(req), req.query)
    return { ...t, total: t.rows.length, rows: t.rows.slice(0, 500) }
  })

  // ── Manager / HOD portal ──────────────────────────────────────────────────
  fastify.get('/approvals', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const pending = await prisma.hrRecord.findMany({
      where: { tenantId: { in: req.staffUser!.memberTenantIds }, status: 'submitted' },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
      orderBy: { createdAt: 'asc' },
      take: 500,
    })
    const out = []
    for (const rec of pending) {
      const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
      const step = fmt.workflow[rec.currentStep]
      if (!step) continue
      const who = canActOnStep(step.role, { id: req.staffUser!.id, role: req.staffUser!.role }, await approvalSubject(rec))
      // An admin override is possible on everything; only list it for the CEO
      // when it is genuinely theirs, or nothing would ever leave their queue.
      if (!who.ok || who.override) continue
      out.push({ ...rec, label: recordLabel(rec, fmt.fields), sectionTitle: sectionByKey(rec.section)?.title ?? rec.section, step, format: fmt })
    }
    return out
  })

  fastify.get('/team', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const me = await prisma.hrEmployee.findFirst({ where: { userId: req.staffUser!.id } })
    if (!me) return { me: null, team: [] }
    const team = await prisma.hrEmployee.findMany({
      where: { managerId: me.id, status: { in: ['active', 'on_leave'] } },
      select: { id: true, fullName: true, employeeCode: true, status: true, phone: true, employmentType: true, probationEnd: true },
      orderBy: { fullName: 'asc' },
    })
    return { me: { id: me.id, fullName: me.fullName }, team }
  })

  // ── Employee self-service ─────────────────────────────────────────────────
  async function myEmployee(req: FastifyRequest): Promise<HrEmployee> {
    const me = await prisma.hrEmployee.findFirst({ where: { userId: req.staffUser!.id } })
    if (!me) throw new AppError('NOT_LINKED', 'Your login is not linked to an employee record yet — ask HR', 404)
    return me
  }

  fastify.get('/me', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const me = await myEmployee(req)
    await applyDueEffects(me.tenantId)
    const emp = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: me.id } })
    const [label, balances, records, payslips, loans] = await Promise.all([
      employeeLabels(emp.tenantId, [emp]),
      leaveBalancesFor(emp.tenantId, emp.id),
      prisma.hrRecord.findMany({ where: { employeeId: emp.id, section: { in: [...ESS_SECTIONS, 'roster', 'attendance'] } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.hrPayslip.findMany({ where: { employeeId: emp.id, run: { status: 'locked' } }, include: { run: { select: { period: true } } }, orderBy: { createdAt: 'desc' }, take: 24 }),
      loansFor(emp.tenantId, emp.id),
    ])
    return {
      profile: {
        employeeCode: emp.employeeCode, fullName: emp.fullName, phone: emp.phone, personalEmail: emp.personalEmail,
        department: label(emp.departmentId), designation: label(emp.designationId), branch: label(emp.locationId), manager: label(emp.managerId),
        employmentType: emp.employmentType, status: emp.status, joiningDate: emp.joiningDate, probationEnd: emp.probationEnd,
      },
      leaveBalances: balances,
      records,
      payslips: payslips.map((p) => ({ id: p.id, period: p.run.period, netCents: p.netCents })),
      loans,
      canRequest: ESS_SECTIONS,
    }
  })

  fastify.get<{ Params: { section: string } }>('/me/forms/:section', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    if (!ESS_SECTIONS.includes(req.params.section)) throw new ForbiddenError('Not available in self-service')
    const me = await myEmployee(req)
    const fmt = await getFormat(me.tenantId, req.params.section)
    // The employee field is filled in for them — they cannot raise a request for someone else.
    return { ...fmt, fields: fmt.fields.filter((f) => f.bind !== 'employeeId' && !f.readOnly) }
  })

  fastify.post<{ Params: { section: string } }>('/me/records/:section', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    if (!ESS_SECTIONS.includes(req.params.section)) throw new ForbiddenError('Not available in self-service')
    const me = await myEmployee(req)
    const body = z.object({ data: z.record(z.unknown()) }).parse(req.body)
    // Self-service writes into the employee's own company, whatever company
    // the login happens to have active.
    return reply.status(201).send(await createRecord(req, me.tenantId, req.params.section, body.data, { submit: true, forEmployeeId: me.id }))
  })

  fastify.get<{ Params: { id: string } }>('/me/payslips/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const me = await myEmployee(req)
    const slip = await prisma.hrPayslip.findFirst({ where: { id: req.params.id, employeeId: me.id, run: { status: 'locked' } }, include: { run: { select: { period: true } } } })
    if (!slip) throw new NotFoundError('Payslip', req.params.id)
    return slip
  })

  // Who is on the payroll for a month, before running it — a sanity check.
  fastify.get<{ Querystring: { period: string } }>('/payroll/preview', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const period = /^\d{4}-\d{2}$/.test(req.query.period ?? '') ? req.query.period : periodOf(new Date())
    const emps = await payableEmployees(activeTenant(req), period)
    return { period, employees: emps.length }
  })

  void RECORD_SECTIONS
}
