// HR deletes an employee — with the CEO's approval (owner, 2026-11-05: "Give
// option to HR to delete employee from list with CEO's approval"). For a wrong
// or duplicate Employee Master entry (no designation, no join date, PKR 0…).
//
//   • POST /hr/employees/:id/delete-request {reason ≥10} — HR (with staff_hr) or
//     the CEO, the EMPLOYEE's company only (another company's → 404). By anyone
//     but the CEO it changes NOTHING: it raises an EmployeeDeleteRequest and
//     answers 202 { pendingApproval, request }. One pending per employee (409
//     DELETE_PENDING). The CEO's own call deletes at once (200 { deleted }) and
//     closes a pending request for that employee as approved in the same
//     transaction.
//   • Approval type employee_delete (lib/approvalRights.ts: section ceo, never
//     handed over). GET /hr/employee-delete-requests?status=&employeeId= lists
//     them (the approvals inbox reads it as the CEO — employeeDeleteApprovalProvider.ts);
//     POST /hr/employee-delete-requests/:id/approve (ADMIN_ONLY) deletes,
//     /reject {note ≥10} (ADMIN_ONLY), /withdraw (the requester or the CEO).
//     Every decision is a conditional claim (409 REQUEST_NOT_PENDING).
//
// What may be deleted: ONLY an entry with nothing the books, payroll or sales
// depend on. Checked when HR asks (so HR learns at once) and again inside the
// delete's transaction, under a row lock on the employee (FOR UPDATE, so a
// payslip / tip-pool row being written against it waits for us):
//   409 EMPLOYEE_HAS_LOGIN    a servd login is linked (HrEmployee.userId), or a
//                             login invite waiting for the CEO names them
//                             (User.inviteEmployeeId) — offboard / unlink first.
//   409 EMPLOYEE_HAS_HISTORY  (details.history lists each) — any payslip (draft
//                             runs included); an APPROVED record of a pay /
//                             movement / separation section (HISTORY_SECTIONS:
//                             loans & advances, overtime, salary revisions,
//                             promotions, transfers, bonuses, benefits, assets,
//                             resignation / termination / exit / full & final,
//                             EOBI) or any record whose effect was applied
//                             (appliedAt); tip-pool membership; till tickets
//                             they waited; journal lines tagged to their
//                             sub-account; the marketing tracker; people who
//                             report to them; moved to a head office.
// Deleted WITH it (kept in the Trash snapshot, restored with the same ids):
// their documents (HrDocument — the uploaded files stay with the documents'
// ids, erased only when the CEO empties the Trash), work locations / map pins
// (HrWorkLocation) and every other HR record about them (attendance days,
// rota, leave, draft / pending / rejected / cancelled requests…: with no
// payslip none of it has reached payroll). A sub-account finance opened in
// their name with NO tags is a ledger master and is left alone (its
// employeeId stays; a restore re-links it).
//
// The delete: moveToTrash (type hr_employee, snapshot of the employee + the
// rows above) in the SAME transaction as the request's claim and the hard
// delete. Only the CEO restores it (Trash provider hr_employee, ceoOnly); a
// restore is refused while another employee of the company holds the code.
// Audit: hr.employee.delete_request, .delete_request.approve | .reject |
// .withdraw, and hr.employee.deleted for the delete itself.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { HrEmployee, Prisma } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { audit } from '../../lib/audit.js'
import { moveToTrash } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'
import { OFFBOARDERS, assertHrBackOffice } from '../auth/offboarding.js'
import { sectionByKey } from './forms.js'
import { employeeLabelsAcross } from './service.js'
import { TRANSFERRED_STATUS } from './transfer.js'

type Db = Prisma.TransactionClient | typeof prisma

/** Who may ask (HR with staff_hr) or delete (the CEO). */
export const EMPLOYEE_DELETERS = OFFBOARDERS
export const DELETE_REASON = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500)
/** The Trash type (modules/trash/providers/masters/people.ts TRASH_PEOPLE.hr_employee). */
export const HR_EMPLOYEE_TRASH_TYPE = 'hr_employee'

/** HR record sections whose APPROVED records are pay / movement / separation history. */
export const HISTORY_SECTIONS = [
  'payroll_adjustment', 'benefit', 'overtime', 'loan', 'salary_revision', 'promotion', 'transfer',
  'asset_assignment', 'resignation', 'termination', 'exit_clearance', 'final_settlement', 'eobi_challan',
] as const

const STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What stops this employee from being deleted (empty = nothing). Plain words for the screen. */
export async function employeeHistory(db: Db, emp: Pick<HrEmployee, 'id' | 'status'>): Promise<string[]> {
  const id = emp.id
  const [payslips, records, tipPools, waited, tags, tracker, reports] = await Promise.all([
    db.hrPayslip.count({ where: { employeeId: id } }),
    db.hrRecord.groupBy({
      by: ['section'],
      where: { employeeId: id, OR: [{ status: 'approved', section: { in: [...HISTORY_SECTIONS] } }, { appliedAt: { not: null } }] },
      _count: { _all: true },
    }),
    db.tipPoolMember.count({ where: { employeeId: id } }),
    db.order.count({ where: { waiterEmployeeId: id } }),
    db.journalLineSubAccount.count({ where: { subAccount: { employeeId: id } } }),
    db.marketingTrackee.count({ where: { employeeId: id } }),
    db.hrEmployee.count({ where: { managerId: id, NOT: { id } } }),
  ])
  const out: string[] = []
  if (payslips) out.push(plural(payslips, 'payslip'))
  for (const r of records) out.push(`${plural(r._count._all, 'approved record')} in ${sectionByKey(r.section)?.title ?? r.section.replace(/_/g, ' ')}`)
  if (tipPools) out.push(plural(tipPools, 'tip pool'))
  if (waited) out.push(plural(waited, 'till ticket') + ' they waited')
  if (tags) out.push(plural(tags, 'journal line') + ' tagged to their sub-account')
  if (tracker) out.push('on the marketing tracker')
  if (reports) out.push(plural(reports, 'person reports', 'people report') + ' to them')
  if (emp.status === TRANSFERRED_STATUS) out.push('moved to a head office')
  return out
}

/** A linked login, or a login invite waiting for the CEO that names them. */
async function linkedLogin(db: Db, emp: Pick<HrEmployee, 'id' | 'userId'>): Promise<boolean> {
  if (emp.userId) return true
  const invite = await db.user.count({ where: { inviteEmployeeId: emp.id, deletedAt: null } })
  return invite > 0
}

/** Refuse unless the employee has no login and no history (409 EMPLOYEE_HAS_LOGIN / EMPLOYEE_HAS_HISTORY). */
export async function assertDeletable(db: Db, emp: Pick<HrEmployee, 'id' | 'userId' | 'status'>): Promise<void> {
  if (await linkedLogin(db, emp)) {
    throw new AppError('EMPLOYEE_HAS_LOGIN', 'A servd login is linked to this employee. Offboard or unlink the login first.', 409)
  }
  const history = await employeeHistory(db, emp)
  if (history.length) {
    throw new AppError('EMPLOYEE_HAS_HISTORY',
      `This employee has history the books or payroll depend on, so they cannot be deleted: ${history.join('; ')}. Mark them as left instead.`,
      409, { history })
  }
}

/**
 * The delete itself, inside the caller's transaction: lock the row, re-check,
 * snapshot the employee + what goes with it into the Trash, then delete.
 * Returns the Trash entry id.
 */
export async function deleteEmployeeTx(
  tx: Prisma.TransactionClient,
  req: FastifyRequest,
  employeeId: string,
  reason: string,
): Promise<{ trashEntryId: string; employee: HrEmployee }> {
  await tx.$queryRaw`SELECT id FROM hr_employees WHERE id = ${employeeId} FOR UPDATE`
  const emp = await tx.hrEmployee.findUnique({ where: { id: employeeId } })
  if (!emp) throw new AppError('EMPLOYEE_GONE', 'This employee no longer exists.', 409)
  await assertDeletable(tx, emp)
  const [documents, workLocations, records] = await Promise.all([
    tx.hrDocument.findMany({ where: { employeeId } }),
    tx.hrWorkLocation.findMany({ where: { employeeId } }),
    tx.hrRecord.findMany({ where: { employeeId } }),
  ])
  const snapshot = takeSnapshot('HrEmployee', emp as unknown as Record<string, unknown>, {
    HrDocument: documents as unknown as Array<Record<string, unknown>>,
    HrWorkLocation: workLocations as unknown as Array<Record<string, unknown>>,
    HrRecord: records as unknown as Array<Record<string, unknown>>,
  })
  const entry = await moveToTrash(tx, req, {
    type: 'hr_employee', entityId: emp.id, tenantId: emp.tenantId,
    title: `${emp.fullName} (${emp.employeeCode})`,
    subtitle: [documents.length && plural(documents.length, 'document'), records.length && plural(records.length, 'HR record')].filter(Boolean).join(', ') || null,
    reason, snapshot,
    meta: { employeeCode: emp.employeeCode, documents: documents.length, workLocations: workLocations.length, records: records.length },
  })
  await tx.hrRecord.deleteMany({ where: { employeeId } })
  await tx.hrDocument.deleteMany({ where: { employeeId } })
  await tx.hrWorkLocation.deleteMany({ where: { employeeId } })
  await tx.hrEmployee.delete({ where: { id: employeeId } })
  return { trashEntryId: entry.id, employee: emp }
}

async function auditDeleted(req: FastifyRequest, emp: HrEmployee, reason: string, trashEntryId: string, extra: Record<string, unknown> = {}) {
  await audit({
    category: 'identity', action: 'hr.employee.deleted', entity: 'HrEmployee', entityId: emp.id,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: emp.tenantId,
    before: { employeeCode: emp.employeeCode, fullName: emp.fullName, status: emp.status },
    after: { reason, trashEntryId },
    metadata: { actorRole: req.staffUser!.role, actorTenantId: req.staffUser!.tenantId ?? null, ...extra },
  })
}

const notPending = () => new AppError('REQUEST_NOT_PENDING', 'This delete request is no longer waiting for the CEO.', 409)

export async function employeeDeleteRoutes(fastify: FastifyInstance) {
  // POST /hr/employees/:id/delete-request {reason} — HR asks (202); the CEO deletes at once (200).
  fastify.post<{ Params: { id: string } }>(
    '/employees/:id/delete-request',
    { preHandler: requireAuth(...EMPLOYEE_DELETERS) },
    async (req, reply) => {
      await assertHrBackOffice(req)
      const { reason } = z.object({ reason: DELETE_REASON }).parse(req.body ?? {})
      const scope = await scopeTenantWhere(req, 'write')
      const emp = await prisma.hrEmployee.findFirst({ where: { id: req.params.id, ...scope } })
      if (!emp) throw new NotFoundError('Employee', req.params.id)
      // So HR learns at once (checked again when the CEO approves).
      await assertDeletable(prisma, emp)

      if (req.staffUser!.role === 'admin') {
        const out = await prisma.$transaction(async (tx) => {
          const res = await deleteEmployeeTx(tx, req, emp.id, reason)
          await tx.employeeDeleteRequest.updateMany({
            where: { employeeId: emp.id, status: 'pending' },
            data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: 'Deleted by the CEO directly' },
          })
          return res
        })
        await auditDeleted(req, out.employee, reason, out.trashEntryId, { direct: true })
        return reply.status(200).send({ deleted: true, employeeId: emp.id, trashEntryId: out.trashEntryId })
      }

      let row
      try {
        row = await prisma.employeeDeleteRequest.create({
          data: { tenantId: emp.tenantId, employeeId: emp.id, employeeCode: emp.employeeCode, fullName: emp.fullName, reason, requestedById: req.staffUser!.id },
        })
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          throw new AppError('DELETE_PENDING', 'A delete of this employee is already waiting for the CEO.', 409)
        }
        throw err
      }
      await audit({
        category: 'identity', action: 'hr.employee.delete_request', entity: 'EmployeeDeleteRequest', entityId: row.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: emp.tenantId,
        after: { employeeId: emp.id, employeeCode: emp.employeeCode, fullName: emp.fullName, reason },
        metadata: { actorRole: req.staffUser!.role, actorTenantId: req.staffUser!.tenantId ?? null },
      })
      approvalWaiting('employee_delete', row.id, { round: row.createdAt.toISOString(), actorId: req.staffUser!.id })
      return reply.status(202).send({ pendingApproval: true, request: row })
    },
  )

  // GET /hr/employee-delete-requests?status=pending&employeeId= — the requests of the companies in view.
  fastify.get<{ Querystring: { status?: string; employeeId?: string } }>(
    '/employee-delete-requests',
    { preHandler: requireAuth(...EMPLOYEE_DELETERS) },
    async (req) => {
      await assertHrBackOffice(req)
      const scope = await scopeTenantWhere(req, 'read')
      const status = (STATUSES as readonly string[]).includes(req.query.status ?? '') ? req.query.status : undefined
      const rows = await prisma.employeeDeleteRequest.findMany({
        where: { ...scope, ...(status ? { status } : {}), ...(req.query.employeeId ? { employeeId: req.query.employeeId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      const userIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById].filter((x): x is string => !!x)))]
      const [users, tenants, emps] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
        prisma.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } }, select: { id: true, name: true } }),
        prisma.hrEmployee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } } }),
      ])
      const u = new Map(users.map((x) => [x.id, x.name]))
      const t = new Map(tenants.map((x) => [x.id, x.name]))
      const e = new Map(emps.map((x) => [x.id, x]))
      const label = await employeeLabelsAcross(emps)
      const items = []
      for (const r of rows) {
        const emp = e.get(r.employeeId)
        // What blocks it NOW (the CEO sees it before deciding) — pending ones only.
        const blockedBy = r.status === 'pending' && emp
          ? [...(await linkedLogin(prisma, emp) ? ['a servd login is linked'] : []), ...(await employeeHistory(prisma, emp))]
          : []
        items.push({
          ...r,
          employeeExists: !!emp,
          department: emp ? label(emp.departmentId) : null,
          designation: emp ? label(emp.designationId) : null,
          companyName: t.get(r.tenantId) ?? null,
          requestedByName: u.get(r.requestedById) ?? null,
          decidedByName: r.decidedById ? u.get(r.decidedById) ?? null : null,
          blockedBy,
        })
      }
      return { items }
    },
  )

  async function forDecision(req: FastifyRequest, id: string) {
    const scope = await scopeTenantWhere(req, 'write')
    const r = await prisma.employeeDeleteRequest.findFirst({ where: { id, ...scope } })
    if (!r) throw new NotFoundError('Delete request', id)
    return r
  }

  async function grantFor(req: FastifyRequest, id: string) {
    const s = await approvalSubject('employee_delete', id)
    if (!s) throw new NotFoundError('Delete request', id)
    return assertCanApprove(req, approvalInputOf('employee_delete', id, s))
  }

  // POST /hr/employee-delete-requests/:id/approve — the CEO deletes the employee now (into the Trash).
  fastify.post<{ Params: { id: string } }>(
    '/employee-delete-requests/:id/approve',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
      const r = await forDecision(req, req.params.id)
      const grant = await grantFor(req, r.id)
      if (r.status !== 'pending') throw notPending()
      const decidedAt = new Date()
      const out = await prisma.$transaction(async (tx) => {
        const claimed = await tx.employeeDeleteRequest.updateMany({
          where: { id: r.id, status: 'pending' },
          data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note ?? null },
        })
        if (claimed.count === 0) throw notPending()
        return deleteEmployeeTx(tx, req, r.employeeId, r.reason)
      })
      await auditDeleted(req, out.employee, r.reason, out.trashEntryId, { approvedBy: req.staffUser!.id, requestedBy: r.requestedById, requestId: r.id })
      await audit({
        category: 'identity', action: 'hr.employee.delete_request.approve', entity: 'EmployeeDeleteRequest', entityId: r.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId,
        metadata: { employeeId: r.employeeId, requestedBy: r.requestedById, trashEntryId: out.trashEntryId, note: body.note ?? null },
      })
      await auditApproval(req, {
        type: 'employee_delete', id: r.id, tenantId: r.tenantId, decision: 'approve', grant, entity: 'EmployeeDeleteRequest',
        metadata: { employeeId: r.employeeId, note: body.note ?? null, decidedAt },
      })
      return { id: r.id, approved: true, employeeId: r.employeeId, trashEntryId: out.trashEntryId }
    },
  )

  // POST /hr/employee-delete-requests/:id/reject {note ≥10} — the CEO turns it down; the employee stays.
  fastify.post<{ Params: { id: string } }>(
    '/employee-delete-requests/:id/reject',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      const body = z.object({ note: DELETE_REASON }).parse(req.body ?? {})
      const r = await forDecision(req, req.params.id)
      const grant = await grantFor(req, r.id)
      const decidedAt = new Date()
      const claimed = await prisma.employeeDeleteRequest.updateMany({
        where: { id: r.id, status: 'pending' },
        data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note },
      })
      if (claimed.count === 0) throw notPending()
      await audit({
        category: 'identity', action: 'hr.employee.delete_request.reject', entity: 'EmployeeDeleteRequest', entityId: r.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId,
        metadata: { employeeId: r.employeeId, requestedBy: r.requestedById, note: body.note },
      })
      await auditApproval(req, {
        type: 'employee_delete', id: r.id, tenantId: r.tenantId, decision: 'reject', grant, entity: 'EmployeeDeleteRequest',
        metadata: { employeeId: r.employeeId, note: body.note, decidedAt },
      })
      return { id: r.id, rejected: true }
    },
  )

  // POST /hr/employee-delete-requests/:id/withdraw — the requester (or the CEO) takes it back.
  fastify.post<{ Params: { id: string } }>(
    '/employee-delete-requests/:id/withdraw',
    { preHandler: requireAuth(...EMPLOYEE_DELETERS) },
    async (req) => {
      await assertHrBackOffice(req)
      const r = await forDecision(req, req.params.id)
      if (req.staffUser!.role !== 'admin' && r.requestedById !== req.staffUser!.id) {
        throw new AppError('NOT_YOUR_REQUEST', 'Only the person who asked (or the CEO) may withdraw it.', 403)
      }
      const claimed = await prisma.employeeDeleteRequest.updateMany({
        where: { id: r.id, status: 'pending' },
        data: { status: 'withdrawn', decidedById: req.staffUser!.id, decidedAt: new Date() },
      })
      if (claimed.count === 0) throw notPending()
      await audit({
        category: 'identity', action: 'hr.employee.delete_request.withdraw', entity: 'EmployeeDeleteRequest', entityId: r.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId,
        metadata: { employeeId: r.employeeId, requestedBy: r.requestedById, actorRole: req.staffUser!.role },
      })
      return { id: r.id, withdrawn: true }
    },
  )
}
