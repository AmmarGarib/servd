// The one-time move of interns out of employees (owner, 2026-11-06: "REPLACE the 'Intern' employment type"; decision
// 2: marketing interns / designers move to the Intern register). A boot step (src/index.ts), idempotent per employee:
// an employee already moved has an Intern with legacyEmployeeId = its id and is skipped (its tracker records are
// re-linked again, which is a no-op). Not SQL: it needs the Trash and the record-files store.
//
// Who moves: every HrEmployee with employmentType 'intern', and every employee on the marketing tracker whose linked
// login has role marketing_intern. For each, in ONE transaction (employee row locked):
//   1. An Intern in the SAME company: next INT-xxxx code; name, father / husband name, CNIC, date of birth, gender,
//      phone, personal email, address / emergency contact (from the employee's data when present), department,
//      designation (its name), supervisor = their manager (same company), start = joining date (else created day),
//      end = contract end (else last working day), paid with stipend = gross salary when > 0 (else unpaid), the
//      login (User) when no intern holds it. Status: active / on_leave → active; terminated → terminated (effective
//      = last working day, else today); any other (resigned, separated…) → completed (completed on = last working
//      day, else today). History event 'moved_from_employees'.
//   2. Standing attendance days (HrRecord section attendance: present / absent / late / half_day) copied to
//      intern_attendance (inside the internship window; an existing day is kept).
//   3. Marketing tracker records of the employee point at the intern (internId).
//   4. The employee:
//        • NO history (hr/employeeDelete.ts employeeHistory — the same rule as an HR delete: no payslip carrying
//          money past draft, no approved pay / movement record, no tip pool, … and no pending login invite):
//          its uploaded documents (record files of its HrDocuments) move to the intern (owner type
//          intern_document), the tracker records drop the employee link, and the employee goes to the TRASH through
//          deleteEmployeeTx (type hr_employee, snapshot, restorable by the CEO — the safest removal).
//        • WITH history: it stays, marked left — status 'separated', lastWorkingDay kept (else today), login
//          unlinked (the intern holds it), data._movedToIntern = the intern id. Its documents stay on it.
// A failure is logged and left for the next boot (that employee only).
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { STANDING_ATTENDANCE } from './service.js'
import { deleteEmployeeTx, employeeHistory } from './employeeDelete.js'
import { logInternEvent } from './internAccess.js'
import { nextInternCode } from './interns.js'
import { pktToday } from './logic.js'

const INTERN_ROLE = 'marketing_intern'
const dateOnly = (d: Date | null | undefined): Date | null => (d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null)
const str = (v: unknown, max = 400): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

export interface InternMoveResult { employeeId: string; tenantId: string; internId: string | null; action: 'removed' | 'kept' | 'already_moved' | 'failed'; reason?: string }

export async function migrateLegacyInterns(opts: { tenantIds?: string[] } = {}): Promise<InternMoveResult[]> {
  const scope = opts.tenantIds ? { tenantId: { in: opts.tenantIds } } : {}
  const internUsers = (await prisma.user.findMany({ where: { role: INTERN_ROLE as never }, select: { id: true } })).map((u) => u.id)
  const candidates = await prisma.hrEmployee.findMany({
    where: {
      ...scope,
      OR: [
        { employmentType: 'intern' },
        ...(internUsers.length ? [{ userId: { in: internUsers }, marketingTrackees: { some: {} } }] : []),
      ],
    },
    select: { id: true, tenantId: true },
  })
  const out: InternMoveResult[] = []
  for (const c of candidates) {
    const moved = await prisma.intern.findUnique({ where: { legacyEmployeeId: c.id }, select: { id: true } })
    if (moved) {
      // Idempotent re-link (a tracker record added under the employee after the move).
      await prisma.marketingTrackee.updateMany({ where: { employeeId: c.id, internId: null }, data: { internId: moved.id } }).catch(() => undefined)
      out.push({ employeeId: c.id, tenantId: c.tenantId, internId: moved.id, action: 'already_moved' })
      continue
    }
    try {
      out.push(await prisma.$transaction((tx) => moveOne(tx, c.id), { timeout: 120_000 }))
    } catch (err) {
      out.push({ employeeId: c.id, tenantId: c.tenantId, internId: null, action: 'failed', reason: (err as Error).message })
    }
  }
  return out
}

async function moveOne(tx: Prisma.TransactionClient, employeeId: string): Promise<InternMoveResult> {
  await tx.$queryRaw`SELECT id FROM hr_employees WHERE id = ${employeeId} FOR UPDATE`
  const emp = await tx.hrEmployee.findUniqueOrThrow({ where: { id: employeeId } })
  const already = await tx.intern.findUnique({ where: { legacyEmployeeId: emp.id }, select: { id: true } })
  if (already) return { employeeId, tenantId: emp.tenantId, internId: already.id, action: 'already_moved' }
  const today = pktToday()
  const data = (emp.data ?? {}) as Record<string, unknown>
  const designation = emp.designationId ? (await tx.hrOrgUnit.findUnique({ where: { id: emp.designationId }, select: { name: true } }))?.name ?? null : null
  const supervisor = emp.managerId ? await tx.hrEmployee.findFirst({ where: { id: emp.managerId, tenantId: emp.tenantId }, select: { id: true } }) : null
  const loginFree = emp.userId ? !(await tx.intern.findUnique({ where: { userId: emp.userId }, select: { id: true } })) : false
  const startDate = dateOnly(emp.joiningDate) ?? dateOnly(emp.createdAt)!
  let endDate = dateOnly(emp.contractEnd) ?? dateOnly(emp.lastWorkingDay)
  if (endDate && endDate < startDate) endDate = null
  const leftOn = dateOnly(emp.lastWorkingDay) ?? today
  const live = emp.status === 'active' || emp.status === 'on_leave'
  const status = live ? 'active' : emp.status === 'terminated' ? 'terminated' : 'completed'
  const gender = typeof emp.gender === 'string' && ['male', 'female', 'other'].includes(emp.gender.toLowerCase()) ? emp.gender.toLowerCase() : null
  const paid = emp.grossSalaryCents > 0
  const intern = await tx.intern.create({
    data: {
      tenantId: emp.tenantId, internCode: await nextInternCode(tx, emp.tenantId), fullName: emp.fullName,
      fatherName: emp.fatherHusbandName, cnic: emp.cnic, dateOfBirth: dateOnly(emp.dateOfBirth), gender, phone: emp.phone, email: emp.personalEmail,
      address: str(data['currentAddress']) ?? str(data['address']) ?? str(data['permanentAddress']),
      emergencyContactName: str(data['emergencyContactName'], 120) ?? str(data['emergencyName'], 120),
      emergencyContactPhone: str(data['emergencyContactPhone'], 30) ?? str(data['emergencyPhone'], 30),
      departmentId: emp.departmentId, designation, supervisorEmployeeId: supervisor?.id ?? null,
      startDate, endDate, internshipType: paid ? 'paid' : 'unpaid', monthlyStipendCents: paid ? emp.grossSalaryCents : 0,
      status, approvedAt: new Date(), submittedAt: new Date(),
      ...(status === 'completed' && { completedOn: leftOn < startDate ? startDate : leftOn, completedAt: new Date() }),
      ...(status === 'terminated' && { terminationEffectiveDate: leftOn, terminationReason: 'Left before the move from employees to Intern Management' }),
      userId: loginFree ? emp.userId : null, legacyEmployeeId: emp.id,
    },
  })
  await logInternEvent(tx, intern, 'moved_from_employees', { note: `Moved from the employee record ${emp.employeeCode} (the 'intern' employment type is retired)`, before: { employeeId: emp.id, employeeCode: emp.employeeCode, employmentType: emp.employmentType, status: emp.status } })

  // Attendance: the standing HR attendance days, inside the internship.
  const records = await tx.hrRecord.findMany({ where: { employeeId: emp.id, section: 'attendance', status: STANDING_ATTENDANCE, startDate: { not: null } }, select: { startDate: true, category: true } })
  const seen = new Set<string>()
  const last = intern.status === 'completed' ? intern.completedOn : intern.status === 'terminated' ? intern.terminationEffectiveDate : intern.endDate
  for (const r of records) {
    const day = dateOnly(r.startDate)!
    const key = day.toISOString().slice(0, 10)
    if (seen.has(key) || day < intern.startDate || (last && day > last)) continue
    const st = r.category === 'present' || r.category === 'absent' || r.category === 'late' || r.category === 'half_day' ? r.category : null
    if (!st) continue
    seen.add(key)
    await tx.internAttendance.create({ data: { tenantId: intern.tenantId, internId: intern.id, date: day, status: st, source: 'import', note: 'From the employee attendance' } })
  }

  // The marketing tracker follows the person.
  await tx.marketingTrackee.updateMany({ where: { employeeId: emp.id, internId: null }, data: { internId: intern.id } })

  // The employee: removed (Trash) when nothing depends on it, else kept and marked left.
  if (loginFree) await tx.hrEmployee.update({ where: { id: emp.id }, data: { userId: null } })
  const invite = await tx.user.count({ where: { inviteEmployeeId: emp.id, deletedAt: null } })
  await tx.marketingTrackee.updateMany({ where: { employeeId: emp.id, internId: intern.id }, data: { employeeId: null } })
  const history = invite ? ['a login invite names them'] : await employeeHistory(tx, emp)
  if (history.length === 0 && (loginFree || !emp.userId)) {
    const docs = await tx.hrDocument.findMany({ where: { employeeId: emp.id }, select: { id: true } })
    if (docs.length) {
      await tx.cashVoucherAttachment.updateMany({
        where: { ownerType: 'hr_document', ownerId: { in: docs.map((d) => d.id) }, tenantId: emp.tenantId },
        data: { ownerType: 'intern_document', ownerId: intern.id },
      })
    }
    await deleteEmployeeTx(tx, { userId: null, actingTenantId: emp.tenantId }, emp.id, `Moved to Intern Management as ${intern.internCode} (the 'intern' employment type is retired)`)
    return { employeeId, tenantId: emp.tenantId, internId: intern.id, action: 'removed' }
  }
  // Kept: the tracker keeps its employee link for history.
  await tx.marketingTrackee.updateMany({ where: { internId: intern.id, employeeId: null }, data: { employeeId: emp.id } })
  await tx.hrEmployee.update({
    where: { id: emp.id },
    data: {
      status: 'separated', lastWorkingDay: emp.lastWorkingDay ?? today,
      data: { ...data, _movedToIntern: intern.id, _movedToInternAt: new Date().toISOString() } as Prisma.InputJsonValue,
    },
  })
  return { employeeId, tenantId: emp.tenantId, internId: intern.id, action: 'kept', reason: history.join('; ') }
}

