// "Move to head office" (D1 spec §5, amendment A16) — the CEO's tool that moves
// people from a company to a head office that serves it.
//
// Not a duplicate of the HR 'transfer' record section (hr/forms.ts, Movement):
// that one moves a person between branches / departments / managers INSIDE one
// company, through HOD → HR approval. This one is CEO-only and crosses
// companies: the person gets a NEW HrEmployee in the head office, and the old
// record ends with status 'transferred'.
//
//   previewTransfer(input, actor)                 what would happen, with every blocker and warning
//   transferEmployeesToHeadOffice(input, actor)   do it, in ONE transaction, or refuse:
//     422 NOT_IN_LINKED_COMPANY       not active in a company with a LIVE link to that head office
//     409 TRANSFER_LOAN_OUTSTANDING   a loan / advance still has money to recover
//     409 TRANSFER_OPEN_RECORDS       an HR record about them is still submitted
//     409 TRANSFER_PAYROLL_CONFLICT   an approved or locked payroll of the old company for the
//                                     effective month or later already pays them
//     409 ALREADY_IN_HEAD_OFFICE      their login already has an employee record in that head office
//     422 JOINED_AFTER_MOVE           they join after the effective date
//     409 DUPLICATE_LOGIN_IN_BATCH    two picked records share one login (the head office holds one per login)
//   A DRAFT payroll of the old company for the effective month or later only
//   warns: recalculating it drops them (lastWorkingDay = effective − 1 day).
//
// Payroll handover: the old record's lastWorkingDay is the day before the
// effective date (the 1st of a month K), so hr/service.ts payableEmployees pays
// them in the old company through K−1, and the head office from K.
//
// Money: NOTHING is posted. Carried leave (and, with "keep joining date", the
// service-linked gratuity) becomes the head office's liability; whether the
// company settles that with an inter-company adjustment is an open CA question
// (A16). The preview shows carried leave days × the old company's daily rate as
// a suggested amount — display only.
//
// Company separation: the CEO must be a member of the head office and of every
// employee's company (404 otherwise). Everything runs on the service client
// inside one transaction, after those checks.

import type { Prisma, HrEmployee } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { liveLink } from '../../lib/headOffice.js'
import { getSettings, leaveBalancesFor, loansFor, lockEmployeeLeave } from './service.js'
import { dailyRateCents, nextEmployeeCode, periodOf, accruedLeaveDays } from './logic.js'

type Tx = Prisma.TransactionClient

const CURRENT = ['active', 'on_leave']
/** The old record's status after the move. Not in separations.ts LEFT_STATUSES (the login stays on). */
export const TRANSFERRED_STATUS = 'transferred'
export const MAX_TRANSFER_BATCH = 100
const TX_OPTS = { timeout: 60_000, maxWait: 10_000 } as const

export interface TransferInput {
  employeeIds: string[]
  headOfficeTenantId: string
  /** 'YYYY-MM-01' — the first day of a (PKT) month. */
  effectiveDate: string
  keepJoiningDate?: boolean
  /** Companies (linked to this head office) whose membership the login keeps. */
  keepCompanyMemberships?: string[]
}

export interface TransferActor {
  id: string
  email?: string | null
  name?: string | null
  role: string
  memberTenantIds: string[]
}

export interface TransferBlocker { code: string; status: number; message: string }

export interface LeaveCarry {
  leaveTypeId: string
  name: string
  /** The balance they keep in the head office. */
  days: number
  /** What they earned and did not take up to the last working day (accrual basis). */
  accruedDays: number
  /** The head office leave type it lands on: an existing one (by name) or one copied now. */
  headOfficeLeaveTypeId: string | null
}

export interface EmployeePreview {
  employeeId: string
  employeeCode: string
  fullName: string
  fromTenantId: string
  fromTenantName: string
  status: string
  blockers: TransferBlocker[]
  warnings: string[]
  /** Department / designation / grade: matched in the head office by name, or created. */
  department: { name: string; match: 'existing' | 'create' } | null
  designation: { name: string; match: 'existing' | 'create' } | null
  grade: { name: string; match: 'existing' | 'create' } | null
  manager: { employeeId: string; mapped: boolean; note: string } | null
  joiningDate: string | null
  lastWorkingDay: string
  leave: LeaveCarry[]
  dailyRateCents: number
  /** A16: carried leave days × daily rate — a SUGGESTED inter-company adjustment, display only. */
  suggestedAdjustmentCents: number
  /** Same on accrued (earned-to-date) days, for the CA. */
  accruedLeaveCents: number
  login: {
    userId: string
    addHeadOfficeMembership: boolean
    primaryCompanyToHeadOffice: boolean
    removeMemberships: string[]
    keepMemberships: string[]
  } | null
  positions: Array<{ id: string; title: string; moves: boolean; note?: string }>
}

export interface TransferPreview {
  headOffice: { id: string; name: string }
  effectiveDate: string
  effectivePeriod: string
  keepJoiningDate: boolean
  ok: boolean
  employees: EmployeePreview[]
  warnings: string[]
  suggestedAdjustmentCents: number
  suggestedAdjustmentNote: string
}

export interface TransferResult {
  headOfficeTenantId: string
  effectiveDate: string
  moved: Array<{
    fromEmployeeId: string
    fromTenantId: string
    toEmployeeId: string
    toEmployeeCode: string
    leaveAdjustmentIds: string[]
    positionIds: string[]
    removedMemberships: string[]
  }>
  warnings: string[]
}

// ─── Dates ────────────────────────────────────────────────────────────────────

const d10 = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

/** The effective date as HR stores dates (UTC midnight of the calendar day); must be a month's 1st. */
export function parseEffectiveDate(s: string): Date {
  const m = /^(\d{4})-(0[1-9]|1[0-2])-01$/.exec(s ?? '')
  if (!m) throw new AppError('BAD_EFFECTIVE_DATE', 'The move date must be the first day of a month (YYYY-MM-01)', 422)
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
}

const dayBefore = (d: Date) => new Date(d.getTime() - 86_400_000)
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()

// ─── Reads shared by preview and transfer ─────────────────────────────────────

async function headOfficeFor(actor: TransferActor, hoId: string) {
  const ho = await prisma.tenant.findFirst({
    where: { id: hoId, kind: 'head_office', deletedAt: null },
    select: { id: true, name: true, isActive: true },
  })
  if (!ho || !actor.memberTenantIds.includes(ho.id)) throw new NotFoundError('Head office', hoId)
  if (!ho.isActive) throw new AppError('HEAD_OFFICE_INACTIVE', 'This head office is switched off', 409)
  return ho
}

async function employeesFor(actor: TransferActor, ids: string[]): Promise<HrEmployee[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) throw new AppError('VALIDATION_ERROR', 'Pick at least one employee', 422)
  if (unique.length > MAX_TRANSFER_BATCH) throw new AppError('VALIDATION_ERROR', `At most ${MAX_TRANSFER_BATCH} people per move`, 422)
  const emps = await prisma.hrEmployee.findMany({ where: { id: { in: unique } } })
  for (const id of unique) {
    const e = emps.find((x) => x.id === id)
    // A row in a company the CEO does not belong to is not theirs to see.
    if (!e || !actor.memberTenantIds.includes(e.tenantId)) throw new NotFoundError('Employee', id)
  }
  return unique.map((id) => emps.find((x) => x.id === id)!)
}

/** A tenant that can be relied on: active and not deleted (same as lib/headOffice.ts). */
const LIVE_TENANT = { isActive: true, deletedAt: null } as const

/**
 * The companies with a LIVE link to the head office — the memberships the move
 * may remove. The same "live" as lib/headOffice.ts liveLink (its liveLinkWhere
 * is module-private): link not ended, head office and company active and not deleted.
 */
async function linkedCompanyIds(hoId: string): Promise<string[]> {
  const links = await prisma.headOfficeLink.findMany({
    where: {
      tenantId: hoId, endedAt: null,
      headOffice: { ...LIVE_TENANT, kind: 'head_office' },
      company: { ...LIVE_TENANT, kind: 'company' },
    },
    select: { companyTenantId: true },
  })
  return [...new Set(links.map((l) => l.companyTenantId))]
}

/**
 * Linked companies where this login still has a CURRENT employee record that is
 * not being moved in this batch. The login keeps those memberships whatever the
 * CEO picked: removing one would cut a current employee off from their own
 * company (ESS, payslips, seat).
 */
async function stillEmployedIn(q: Tx | typeof prisma, userId: string, linked: string[], batchIds: string[]): Promise<string[]> {
  if (linked.length === 0) return []
  const rows = await q.hrEmployee.findMany({
    where: { userId, tenantId: { in: linked }, status: { in: CURRENT }, id: { notIn: batchIds } },
    select: { tenantId: true },
  })
  return [...new Set(rows.map((r) => r.tenantId))]
}

/** Blockers that read the database (re-checked inside the transaction). */
async function stateBlockers(q: Tx | typeof prisma, emp: HrEmployee, hoId: string, effective: Date): Promise<TransferBlocker[]> {
  const out: TransferBlocker[] = []
  const period = periodOf(effective)
  const [open, conflict, already] = await Promise.all([
    q.hrRecord.count({ where: { tenantId: emp.tenantId, employeeId: emp.id, status: 'submitted' } }),
    q.hrPayslip.findMany({
      where: { employeeId: emp.id, tenantId: emp.tenantId, run: { tenantId: emp.tenantId, status: { in: ['approved', 'locked'] }, period: { gte: period } } },
      select: { run: { select: { period: true, status: true } } },
    }),
    emp.userId ? q.hrEmployee.findFirst({ where: { tenantId: hoId, userId: emp.userId }, select: { employeeCode: true } }) : Promise.resolve(null),
  ])
  if (open > 0) {
    out.push({ code: 'TRANSFER_OPEN_RECORDS', status: 409, message: `${emp.fullName} has ${open} HR request(s) still waiting for approval — decide or cancel them first` })
  }
  if (conflict.length > 0) {
    const runs = conflict.map((c) => `${c.run.period} (${c.run.status})`).join(', ')
    out.push({ code: 'TRANSFER_PAYROLL_CONFLICT', status: 409, message: `${emp.fullName} is on payroll ${runs} of their company, which is at or after the move month — reopen it or move them from a later month` })
  }
  if (already) {
    out.push({ code: 'ALREADY_IN_HEAD_OFFICE', status: 409, message: `${emp.fullName}'s login already has an employee record in the head office (${already.employeeCode})` })
  }
  return out
}

interface Assessed {
  preview: TransferPreview
  emps: HrEmployee[]
  linked: string[]
  keep: string[]
  /** Approved loan / advance record ids seen per employee (re-checked inside the move's transaction). */
  loanIdsSeen: Map<string, string[]>
}

async function assess(input: TransferInput, actor: TransferActor): Promise<Assessed> {
  const effective = parseEffectiveDate(input.effectiveDate)
  const keepJoiningDate = input.keepJoiningDate !== false
  const ho = await headOfficeFor(actor, input.headOfficeTenantId)
  const emps = await employeesFor(actor, input.employeeIds)
  const linked = await linkedCompanyIds(ho.id)
  const keep = [...new Set(input.keepCompanyMemberships ?? [])]
  for (const k of keep) {
    if (!linked.includes(k) || !actor.memberTenantIds.includes(k)) {
      throw new AppError('BAD_KEEP_MEMBERSHIP', 'Only a company linked to this head office can be kept', 422)
    }
  }
  const period = periodOf(effective)
  const lastWorkingDay = dayBefore(effective)
  const batch = new Set(emps.map((e) => e.id))
  const loanIdsSeen = new Map<string, string[]>()
  // One login, one head-office record (@@unique([tenantId, userId])): a login with
  // records in two linked companies can only be moved from one of them.
  const loginCount = new Map<string, number>()
  for (const e of emps) if (e.userId) loginCount.set(e.userId, (loginCount.get(e.userId) ?? 0) + 1)
  // Direct reports who stay behind lose their manager in the company.
  const staying = await prisma.hrEmployee.findMany({
    where: { managerId: { in: [...batch] }, id: { notIn: [...batch] }, status: { in: CURRENT } },
    select: { managerId: true, fullName: true, tenantId: true },
  })

  // Head office lookups (by name) for the preview's "existing / create".
  const [hoDepts, hoUnits, hoLeaveTypes, hoEarlierRuns, companies] = await Promise.all([
    prisma.department.findMany({ where: { tenantId: ho.id }, select: { name: true } }),
    prisma.hrOrgUnit.findMany({ where: { tenantId: ho.id, kind: { in: ['designation', 'grade'] } }, select: { kind: true, name: true } }),
    prisma.hrRecord.findMany({ where: { tenantId: ho.id, section: 'leave_type', status: 'approved' }, select: { id: true, data: true } }),
    prisma.hrPayrollRun.findMany({ where: { tenantId: ho.id, period: { lt: period }, status: 'draft' }, select: { period: true } }),
    prisma.tenant.findMany({ where: { id: { in: [...new Set(emps.map((e) => e.tenantId))] } }, select: { id: true, name: true } }),
  ])
  const hoDeptNames = new Set(hoDepts.map((d) => norm(d.name)))
  const hoUnitNames = new Set(hoUnits.map((u) => `${u.kind}:${norm(u.name)}`))
  const hoTypeByName = new Map(hoLeaveTypes.map((t) => [norm((t.data as Record<string, unknown>)['name']), t.id]))
  const companyName = new Map(companies.map((c) => [c.id, c.name]))

  const refIds = [...new Set(emps.flatMap((e) => [e.departmentId, e.designationId, e.gradeId]).filter((x): x is string => !!x))]
  const [depts, units] = await Promise.all([
    prisma.department.findMany({ where: { id: { in: refIds } }, select: { id: true, name: true, tenantId: true } }),
    prisma.hrOrgUnit.findMany({ where: { id: { in: refIds } }, select: { id: true, name: true, tenantId: true, kind: true } }),
  ])

  const out: EmployeePreview[] = []
  for (const e of emps) {
    const blockers: TransferBlocker[] = []
    const warnings: string[] = []
    const link = await liveLink(ho.id, e.tenantId)
    if (!CURRENT.includes(e.status) || !link) {
      blockers.push({
        code: 'NOT_IN_LINKED_COMPANY', status: 422,
        message: !CURRENT.includes(e.status)
          ? `${e.fullName} is not a current employee (${e.status})`
          : `${e.fullName}'s company is not linked to this head office`,
      })
    }
    if (e.joiningDate && e.joiningDate > lastWorkingDay) {
      blockers.push({ code: 'JOINED_AFTER_MOVE', status: 422, message: `${e.fullName} joins on ${d10(e.joiningDate)}, after the move date — move them from a later month` })
    }
    if (e.userId && (loginCount.get(e.userId) ?? 0) > 1) {
      blockers.push({ code: 'DUPLICATE_LOGIN_IN_BATCH', status: 409, message: `${e.fullName}'s login has another employee record in this batch — move one record per login` })
    }
    const loans = await loansFor(e.tenantId, e.id)
    loanIdsSeen.set(e.id, loans.map((l) => l.id))
    const owed = loans.reduce((a, l) => a + l.outstandingCents, 0)
    if (owed > 0) {
      blockers.push({ code: 'TRANSFER_LOAN_OUTSTANDING', status: 409, message: `${e.fullName} still owes PKR ${(owed / 100).toFixed(2)} on a loan or advance — recover or settle it first` })
    }
    blockers.push(...await stateBlockers(prisma, e, ho.id, effective))

    const drafts = await prisma.hrPayslip.findMany({
      where: { employeeId: e.id, tenantId: e.tenantId, run: { tenantId: e.tenantId, status: 'draft', period: { gte: period } } },
      select: { run: { select: { period: true } } },
    })
    if (drafts.length > 0) {
      warnings.push(`On draft payroll ${drafts.map((d) => d.run.period).join(', ')} of their company — recalculate it after the move and they drop off`)
    }
    if (keepJoiningDate && hoEarlierRuns.length > 0) {
      warnings.push(`The head office has draft payroll for ${hoEarlierRuns.map((r) => r.period).join(', ')} (before the move month) — do not recalculate it, or they are paid twice for those months`)
    }
    const futureLeave = await prisma.hrRecord.count({ where: { tenantId: e.tenantId, employeeId: e.id, section: 'leave', status: 'approved', endDate: { gte: effective } } })
    if (futureLeave > 0) warnings.push('Approved leave on or after the move date stays on the old record; it is already taken off the balance carried over')
    const reports = staying.filter((r) => r.managerId === e.id && r.tenantId === e.tenantId)
    if (reports.length > 0) {
      warnings.push(`${reports.length} direct report(s) stay in the company and will have no manager there — reassign them in HR: ${reports.map((r) => r.fullName).join(', ')}`)
    }

    // Org lists.
    const dept = depts.find((d) => d.id === e.departmentId)
    const desig = units.find((u) => u.id === e.designationId)
    const grade = units.find((u) => u.id === e.gradeId)

    // Manager.
    let manager: EmployeePreview['manager'] = null
    if (e.managerId) {
      if (batch.has(e.managerId)) manager = { employeeId: e.managerId, mapped: true, note: 'Moves in the same batch' }
      else {
        const moved = await prisma.hrEmployee.findFirst({
          where: { tenantId: ho.id, data: { path: ['transferredFrom', 'employeeId'], equals: e.managerId } }, select: { id: true },
        })
        manager = moved
          ? { employeeId: e.managerId, mapped: true, note: 'Their manager already moved to the head office' }
          : { employeeId: e.managerId, mapped: false, note: 'Their manager stays in the company — no manager in the head office until HR sets one' }
      }
    }

    // Leave carried over (paid types only; the balance of the year containing the move date).
    const s = await getSettings(e.tenantId)
    const balances = await leaveBalancesFor(e.tenantId, e.id, effective)
    const leave: LeaveCarry[] = balances.filter((b) => b.paid).map((b) => ({
      leaveTypeId: b.leaveTypeId, name: b.name, days: b.balance,
      accruedDays: accruedLeaveDays(b, b.yearFrom, e.joiningDate, lastWorkingDay),
      headOfficeLeaveTypeId: hoTypeByName.get(norm(b.name)) ?? null,
    }))
    const rate = dailyRateCents(e.grossSalaryCents, s)
    const carriedDays = leave.reduce((a, l) => a + l.days, 0)
    const accruedDays = leave.reduce((a, l) => a + l.accruedDays, 0)

    // Login and seats.
    let login: EmployeePreview['login'] = null
    let positions: EmployeePreview['positions'] = []
    if (e.userId) {
      const [user, memberships, seats] = await Promise.all([
        prisma.user.findUnique({ where: { id: e.userId }, select: { tenantId: true, role: true } }),
        prisma.tenantMember.findMany({ where: { userId: e.userId }, select: { tenantId: true } }),
        prisma.position.findMany({ where: { tenantId: e.tenantId, filledByUserId: e.userId, status: 'filled' }, select: { id: true, title: true, headcount: true } }),
      ])
      const mine = new Set(memberships.map((m) => m.tenantId))
      if (user?.tenantId) mine.add(user.tenantId)
      const isCeo = user?.role === 'admin'
      const inLinked = [...mine].filter((t) => linked.includes(t))
      const held = await stillEmployedIn(prisma, e.userId, linked, [...batch])
      const remove = isCeo ? [] : inLinked.filter((t) => !keep.includes(t) && !held.includes(t) && actor.memberTenantIds.includes(t))
      if (isCeo) warnings.push('This login is the CEO\'s — it keeps every company membership')
      if (!isCeo) {
        const forced = held.filter((t) => inLinked.includes(t) && !keep.includes(t))
        if (forced.length) {
          const names = await prisma.tenant.findMany({ where: { id: { in: forced } }, select: { id: true, name: true } })
          for (const t of forced) {
            warnings.push(`Keeps the ${names.find((n) => n.id === t)?.name ?? 'other company'} membership: their login is still a current employee there`)
          }
        }
      }
      login = {
        userId: e.userId,
        addHeadOfficeMembership: !mine.has(ho.id),
        primaryCompanyToHeadOffice: !!user?.tenantId && (user.tenantId === e.tenantId || remove.includes(user.tenantId)),
        removeMemberships: remove,
        keepMemberships: inLinked.filter((t) => !remove.includes(t)),
      }
      positions = seats.map((p) => p.headcount > 1
        ? { id: p.id, title: p.title, moves: false, note: `A ${p.headcount}-seat row — split it first; it stays in the company` }
        : { id: p.id, title: p.title, moves: true })
      for (const p of positions) if (!p.moves) warnings.push(`Seat "${p.title}" is not moved: ${p.note}`)
    }

    out.push({
      employeeId: e.id, employeeCode: e.employeeCode, fullName: e.fullName,
      fromTenantId: e.tenantId, fromTenantName: companyName.get(e.tenantId) ?? '', status: e.status,
      blockers, warnings,
      department: dept ? { name: dept.name, match: hoDeptNames.has(norm(dept.name)) ? 'existing' : 'create' } : null,
      designation: desig ? { name: desig.name, match: hoUnitNames.has(`designation:${norm(desig.name)}`) ? 'existing' : 'create' } : null,
      grade: grade ? { name: grade.name, match: hoUnitNames.has(`grade:${norm(grade.name)}`) ? 'existing' : 'create' } : null,
      manager,
      joiningDate: d10(keepJoiningDate ? e.joiningDate : effective),
      lastWorkingDay: d10(lastWorkingDay)!,
      leave,
      dailyRateCents: Math.round(rate),
      suggestedAdjustmentCents: Math.round(carriedDays * rate),
      accruedLeaveCents: Math.round(accruedDays * rate),
      login, positions,
    })
  }

  const warnings: string[] = []
  if (keepJoiningDate) warnings.push('Joining dates are kept: the head office carries their full service (gratuity and leave history). Whether the company settles that by an inter-company adjustment is a question for the CA.')
  const preview: TransferPreview = {
    headOffice: { id: ho.id, name: ho.name },
    effectiveDate: d10(effective)!,
    effectivePeriod: period,
    keepJoiningDate,
    ok: out.every((e) => e.blockers.length === 0),
    employees: out,
    warnings,
    suggestedAdjustmentCents: out.reduce((a, e) => a + e.suggestedAdjustmentCents, 0),
    suggestedAdjustmentNote: 'Carried leave days × daily rate. A suggestion for the CA only — nothing is posted.',
  }
  return { preview, emps, linked, keep, loanIdsSeen }
}

/** What the move would do — every blocker and warning; nothing is written. */
export async function previewTransfer(input: TransferInput, actor: TransferActor): Promise<TransferPreview> {
  return (await assess(input, actor)).preview
}

// ─── The move ────────────────────────────────────────────────────────────────

async function twinDepartment(tx: Tx, hoId: string, sourceId: string | null, cache: Map<string, string | null>): Promise<string | null> {
  if (!sourceId) return null
  if (cache.has(sourceId)) return cache.get(sourceId)!
  const src = await tx.department.findUnique({ where: { id: sourceId }, select: { name: true, emoji: true, order: true } })
  let id: string | null = null
  if (src) {
    // A live department first; an archived one of that name is brought back
    // (its name is unique per company, so a second one cannot be created).
    const have = await tx.department.findFirst({
      where: { tenantId: hoId, name: { equals: src.name, mode: 'insensitive' } },
      orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }],
      select: { id: true, archivedAt: true },
    })
    if (have?.archivedAt) await tx.department.update({ where: { id: have.id }, data: { archivedAt: null } })
    id = have?.id ?? (await tx.department.create({ data: { tenantId: hoId, name: src.name, emoji: src.emoji, order: src.order }, select: { id: true } })).id
  }
  cache.set(sourceId, id)
  return id
}

async function twinOrgUnit(tx: Tx, hoId: string, sourceId: string | null, kind: 'designation' | 'grade', cache: Map<string, string | null>): Promise<string | null> {
  if (!sourceId) return null
  if (cache.has(sourceId)) return cache.get(sourceId)!
  const src = await tx.hrOrgUnit.findUnique({ where: { id: sourceId }, select: { name: true, code: true, kind: true } })
  let id: string | null = null
  if (src && src.kind === kind) {
    const have = await tx.hrOrgUnit.findFirst({ where: { tenantId: hoId, kind, name: { equals: src.name, mode: 'insensitive' } }, select: { id: true } })
    id = have?.id ?? (await tx.hrOrgUnit.create({ data: { tenantId: hoId, kind, name: src.name, code: src.code }, select: { id: true } })).id
  }
  cache.set(sourceId, id)
  return id
}

/**
 * The head office's leave type for a company leave type: the one with the same
 * name, else a copy. When the head office has none at all, every approved
 * leave type of the company is copied first (spec §5 step 2).
 */
async function ensureHoLeaveTypes(tx: Tx, hoId: string, companyId: string, actorId: string): Promise<Map<string, string>> {
  const nameOf = (d: unknown) => norm((d as Record<string, unknown>)['name'])
  const hoTypes = await tx.hrRecord.findMany({ where: { tenantId: hoId, section: 'leave_type', status: 'approved' }, select: { id: true, data: true } })
  const companyTypes = await tx.hrRecord.findMany({ where: { tenantId: companyId, section: 'leave_type', status: 'approved' }, orderBy: { createdAt: 'asc' } })
  const byName = new Map(hoTypes.map((t) => [nameOf(t.data), t.id]))
  const out = new Map<string, string>()
  for (const ct of companyTypes) {
    const n = nameOf(ct.data)
    let id = byName.get(n)
    if (!id) {
      const made = await tx.hrRecord.create({
        data: {
          tenantId: hoId, section: 'leave_type', formVersion: ct.formVersion, status: 'approved',
          quantity: ct.quantity, category: ct.category, data: (ct.data ?? {}) as Prisma.InputJsonValue,
          createdById: actorId,
        },
        select: { id: true },
      })
      id = made.id
      byName.set(n, id)
    }
    out.set(ct.id, id)
  }
  return out
}

/**
 * Move the employees to the head office (spec §5). Refuses with the first
 * blocker found (see the header). Everything happens in one transaction.
 */
export async function transferEmployeesToHeadOffice(input: TransferInput, actor: TransferActor): Promise<TransferResult> {
  const { preview, emps, linked, keep, loanIdsSeen } = await assess(input, actor)
  for (const e of preview.employees) {
    const b = e.blockers[0]
    if (b) throw new AppError(b.code, b.message, b.status, { employeeId: e.employeeId, blockers: e.blockers })
  }
  const hoId = preview.headOffice.id
  const effective = parseEffectiveDate(preview.effectiveDate)
  const lastWorkingDay = dayBefore(effective)
  const keepJoiningDate = preview.keepJoiningDate
  const hoSettings = await getSettings(hoId)
  const now = new Date()
  const byName = actor.name ?? actor.email ?? 'CEO'

  return prisma.$transaction(async (tx) => {
    // One move at a time per person: the same lock leave booking takes.
    for (const e of [...emps].sort((a, b) => a.id.localeCompare(b.id))) await lockEmployeeLeave(tx, e.id)
    for (const e of emps) {
      const b = (await stateBlockers(tx, e, hoId, effective))[0]
      if (b) throw new AppError(b.code, b.message, b.status, { employeeId: e.id })
      // The link may have ended, or a loan been approved, since the checks above.
      if (!await liveLink(hoId, e.tenantId, tx)) {
        throw new AppError('NOT_IN_LINKED_COMPANY', `${e.fullName}'s company is no longer linked to this head office`, 422, { employeeId: e.id })
      }
      const newLoans = await tx.hrRecord.count({
        where: { tenantId: e.tenantId, employeeId: e.id, section: 'loan', status: 'approved', id: { notIn: loanIdsSeen.get(e.id) ?? [] } },
      })
      if (newLoans > 0) {
        throw new AppError('TRANSFER_LOAN_OUTSTANDING', `${e.fullName} has a loan or advance approved since the check — recover or settle it first`, 409, { employeeId: e.id })
      }
    }

    const deptCache = new Map<string, string | null>()
    const unitCache = new Map<string, string | null>()
    const leaveTypeMaps = new Map<string, Map<string, string>>()
    const codes = (await tx.hrEmployee.findMany({ where: { tenantId: hoId }, select: { employeeCode: true } })).map((c) => c.employeeCode)
    const newIdOf = new Map<string, string>()
    const moved: TransferResult['moved'] = []
    const warnings = [...preview.warnings, ...preview.employees.flatMap((e) => e.warnings.map((w) => `${e.fullName}: ${w}`))]

    // 1. The new head-office records.
    for (const e of emps) {
      // Claim the old record: a status change landing meanwhile stops the move.
      const claimed = await tx.hrEmployee.updateMany({
        where: { id: e.id, tenantId: e.tenantId, status: { in: CURRENT } },
        data: { updatedAt: now },
      })
      if (claimed.count === 0) throw new AppError('NOT_IN_LINKED_COMPANY', `${e.fullName} is no longer a current employee`, 422, { employeeId: e.id })

      const employeeCode = nextEmployeeCode(hoSettings.employeeCodePrefix, codes)
      codes.push(employeeCode)
      const transferredFrom = {
        tenantId: e.tenantId, employeeId: e.id, employeeCode: e.employeeCode,
        effectiveDate: d10(effective), originalJoiningDate: d10(e.joiningDate),
        locationId: e.locationId, at: now.toISOString(), byUserId: actor.id,
      }
      const created = await tx.hrEmployee.create({
        data: {
          tenantId: hoId, employeeCode, userId: e.userId,
          fullName: e.fullName, fatherHusbandName: e.fatherHusbandName, cnic: e.cnic, cnicExpiry: e.cnicExpiry,
          dateOfBirth: e.dateOfBirth, gender: e.gender, phone: e.phone, personalEmail: e.personalEmail,
          departmentId: await twinDepartment(tx, hoId, e.departmentId, deptCache),
          designationId: await twinOrgUnit(tx, hoId, e.designationId, 'designation', unitCache),
          gradeId: await twinOrgUnit(tx, hoId, e.gradeId, 'grade', unitCache),
          // Branches are company master data; a head office has none of the company's.
          locationId: null,
          managerId: null,
          employmentType: e.employmentType, status: e.status,
          joiningDate: keepJoiningDate ? e.joiningDate : effective,
          probationEnd: e.probationEnd, confirmationDate: e.confirmationDate, contractEnd: e.contractEnd,
          lastWorkingDay: null, noticePeriodDays: e.noticePeriodDays,
          basicSalaryCents: e.basicSalaryCents, grossSalaryCents: e.grossSalaryCents, monthlyTaxCents: e.monthlyTaxCents,
          paymentMethod: e.paymentMethod, bankName: e.bankName, iban: e.iban,
          eobiNo: e.eobiNo, sessiNo: e.sessiNo, ntn: e.ntn, photoUrl: e.photoUrl,
          // The kiosk PIN belongs to the company's branch tablets — not carried.
          kioskPinHash: null,
          data: { ...((e.data ?? {}) as Record<string, unknown>), transferredFrom } as Prisma.InputJsonValue,
          createdById: actor.id,
        },
        select: { id: true, employeeCode: true },
      })
      newIdOf.set(e.id, created.id)

      // Documents (CNIC, contracts, …) are part of the master record: copied, same files.
      const docs = await tx.hrDocument.findMany({ where: { employeeId: e.id } })
      if (docs.length) {
        await tx.hrDocument.createMany({
          data: docs.map((d) => ({
            tenantId: hoId, employeeId: created.id, docType: d.docType, title: d.title, fileUrl: d.fileUrl,
            issueDate: d.issueDate, expiryDate: d.expiryDate, verifiedById: d.verifiedById, verifiedAt: d.verifiedAt, notes: d.notes,
          })),
        })
      }
      moved.push({ fromEmployeeId: e.id, fromTenantId: e.tenantId, toEmployeeId: created.id, toEmployeeCode: created.employeeCode, leaveAdjustmentIds: [], positionIds: [], removedMemberships: [] })
    }

    // Managers: one moving in this batch, or one who already moved to this head office.
    for (const e of emps) {
      if (!e.managerId) continue
      let mgr = newIdOf.get(e.managerId) ?? null
      if (!mgr) {
        const m = await tx.hrEmployee.findFirst({
          where: { tenantId: hoId, status: { in: CURRENT }, data: { path: ['transferredFrom', 'employeeId'], equals: e.managerId } },
          select: { id: true },
        })
        mgr = m?.id ?? null
      }
      if (mgr) await tx.hrEmployee.update({ where: { id: newIdOf.get(e.id)! }, data: { managerId: mgr } })
    }

    for (const e of emps) {
      const m = moved.find((x) => x.fromEmployeeId === e.id)!
      const newId = m.toEmployeeId

      // 2. Leave balances, as approved system adjustments that bring the head
      //    office balance to exactly what they had (paid leave types only).
      let typeMap = leaveTypeMaps.get(e.tenantId)
      if (!typeMap) { typeMap = await ensureHoLeaveTypes(tx, hoId, e.tenantId, actor.id); leaveTypeMaps.set(e.tenantId, typeMap) }
      const [oldBal, hoBal] = await Promise.all([
        leaveBalancesFor(e.tenantId, e.id, effective, { tx }),
        leaveBalancesFor(hoId, newId, effective, { tx }),
      ])
      for (const b of oldBal.filter((x) => x.paid)) {
        const hoTypeId = typeMap.get(b.leaveTypeId)
        if (!hoTypeId) continue
        const have = hoBal.find((x) => x.leaveTypeId === hoTypeId)?.balance ?? 0
        const days = Math.round((b.balance - have) * 100) / 100
        if (days === 0) continue
        const reason = `Carried over from ${preview.employees.find((x) => x.employeeId === e.id)?.fromTenantName ?? 'the company'} on the move to head office`
        const approvals = [{ step: 'system', role: 'system', decision: 'approved', byUserId: actor.id, byName, at: now.toISOString(), note: reason }]
        const rec = await tx.hrRecord.create({
          data: {
            tenantId: hoId, section: 'leave_adjustment', formVersion: 0, employeeId: newId,
            refId: hoTypeId, quantity: days, effectiveDate: effective, status: 'approved', currentStep: 1,
            approvals: approvals as Prisma.InputJsonValue,
            data: { employee: newId, leaveType: hoTypeId, days, effectiveDate: d10(effective), reason, system: true, transferFromEmployeeId: e.id } as Prisma.InputJsonValue,
            appliedAt: now, createdById: actor.id,
          },
          select: { id: true },
        })
        m.leaveAdjustmentIds.push(rec.id)
      }

      // 3. The old record ends the day before; the company pays through K−1.
      await tx.hrEmployee.update({
        where: { id: e.id },
        data: {
          status: TRANSFERRED_STATUS, lastWorkingDay,
          data: { ...((e.data ?? {}) as Record<string, unknown>), transferredTo: { tenantId: hoId, employeeId: newId, effectiveDate: d10(effective), at: now.toISOString(), byUserId: actor.id } } as Prisma.InputJsonValue,
        },
      })

      // 4. The login: kept; a member of the head office; out of the linked
      //    companies except the ones the CEO keeps (never the CEO's own).
      if (e.userId) {
        const user = await tx.user.findUnique({ where: { id: e.userId }, select: { tenantId: true, role: true } })
        await tx.tenantMember.upsert({
          where: { userId_tenantId: { userId: e.userId, tenantId: hoId } },
          create: { userId: e.userId, tenantId: hoId, role: 'member' },
          update: {},
        })
        // Only companies the CEO belongs to (company separation) and never the CEO's own login.
        // Never a company where the login is still a current employee (outside this batch).
        const held = await stillEmployedIn(tx, e.userId, linked, emps.map((x) => x.id))
        const remove = user?.role === 'admin' ? [] : linked.filter((t) => !keep.includes(t) && !held.includes(t) && actor.memberTenantIds.includes(t))
        const removed = new Set<string>()
        if (remove.length) {
          const gone = await tx.tenantMember.findMany({ where: { userId: e.userId, tenantId: { in: remove } }, select: { tenantId: true } })
          await tx.tenantMember.deleteMany({ where: { userId: e.userId, tenantId: { in: remove } } })
          for (const g of gone) removed.add(g.tenantId)
        }
        if (user?.tenantId && (user.tenantId === e.tenantId || remove.includes(user.tenantId))) {
          await tx.user.update({ where: { id: e.userId }, data: { tenantId: hoId } })
          if (remove.includes(user.tenantId)) removed.add(user.tenantId)
        }
        m.removedMemberships = [...removed]

        // 5. The seat they fill moves with them, at 100% (the split is the head office's % table).
        const seats = await tx.position.findMany({
          where: { tenantId: e.tenantId, filledByUserId: e.userId, status: 'filled', headcount: 1 },
          select: { id: true, departmentId: true, monthlySalaryCents: true, shiftBand: { select: { tenantId: true } } },
        })
        for (const p of seats) {
          await tx.position.update({
            where: { id: p.id },
            data: {
              tenantId: hoId, conceptId: null,
              departmentId: await twinDepartment(tx, hoId, p.departmentId, deptCache),
              ...(p.shiftBand?.tenantId && p.shiftBand.tenantId !== hoId ? { shiftBandId: null } : {}),
              tenantCostShareCents: p.monthlySalaryCents,
            },
          })
          m.positionIds.push(p.id)
        }
      }

      // 6. Both companies' identity trails.
      const after = {
        fromTenantId: e.tenantId, fromEmployeeId: e.id, fromEmployeeCode: e.employeeCode,
        toTenantId: hoId, toEmployeeId: newId, toEmployeeCode: m.toEmployeeCode,
        effectiveDate: d10(effective), lastWorkingDay: d10(lastWorkingDay), keepJoiningDate,
        leaveAdjustmentIds: m.leaveAdjustmentIds, positionIds: m.positionIds,
        removedMemberships: m.removedMemberships, keptMemberships: keep,
      }
      await tx.auditLog.createMany({
        data: [
          { category: 'identity', tenantId: e.tenantId, action: 'hr.transfer', entity: 'HrEmployee', entityId: e.id, userId: actor.id, userEmail: actor.email ?? null, before: { status: e.status } as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue },
          { category: 'identity', tenantId: hoId, action: 'hr.transfer', entity: 'HrEmployee', entityId: newId, userId: actor.id, userEmail: actor.email ?? null, after: after as Prisma.InputJsonValue },
        ],
      })
    }

    return { headOfficeTenantId: hoId, effectiveDate: d10(effective)!, moved, warnings }
  }, TX_OPTS)
}
