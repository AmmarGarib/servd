// Task lists (owner, 2026-11-04): "if i add a task on there, it should reflect on the 'people who are working on
// this' and it should notify them/send them an email. once they have completed the task and ticked off the box
// 'approved by leadership' only then will the task be checked off of their list. similarly if anything is added in
// the content calendar for the month, it should reflect on their task list (the resource assigned)."
//
// ONE store: a task IS a ContentEvent — a marketing board card (its owner `assigneeId` + its resources) or a plain
// content-calendar entry (its `assigneeId`). No task table. Two ticks on the row:
//   taskDoneAt / taskDoneById         — someone on the task (or a leader) marked it done; undone freely until approved.
//   leadApprovedAt / leadApprovedById — "Approved by leadership": only after done. Then it leaves everyone's list.
//
// Leadership: a board card → the CEO or a `marketing_lead` holder (the people who move cards). A calendar entry →
// the CEO, a `marketing_lead` holder, or whoever created it (they set the task). Never your own task (403
// SELF_APPROVAL_BLOCKED), the CEO excepted. Reopening (approved → open) is the same people.
//
// Company scope: a person's own tasks across every company they belong to (teamMode 'write'); a task of another
// company is 404. Interns are admitted (auth/middleware.ts INTERN_ROUTES) and see only their own.
//
// Notices: put on a task → bell (cards keep their marketing.card bell; calendar entries get marketing.task) and an
// EMAIL to each person (lib/notify.ts sendEmail — staff mail, no test-company scope; the practice copy sends none).
// Marked done → the approvers' bell. Approved / reopened → the people's bell. All after the commit; a failed email
// never fails the action.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { queueStaffNotify, notifyStaffMany } from '../../lib/staffNotify.js'
import { sendEmail } from '../../lib/notify.js'
import { INTERN_ROLE } from '../../lib/roles.js'
import { isLead, modulesOf } from './access.js'
import { STAGE_LABEL, type Stage } from './cards.js'

const TASK_INCLUDE = {
  board:     { select: { id: true, name: true } },
  concept:   { select: { id: true, name: true } },
  assignee:  { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  resources: { select: { userId: true, user: { select: { id: true, name: true } } } },
} satisfies Prisma.ContentEventInclude
type TaskRow = Prisma.ContentEventGetPayload<{ include: typeof TASK_INCLUDE }>

export type TaskStatus = 'open' | 'awaiting_approval' | 'done'
export const taskStatusOf = (t: { taskDoneAt: Date | null; leadApprovedAt: Date | null }): TaskStatus =>
  t.leadApprovedAt ? 'done' : t.taskDoneAt ? 'awaiting_approval' : 'open'

/** Everyone the task belongs to: the owner / assignee and the resources. */
export function peopleOnTask(t: { assigneeId: string | null; resources: Array<{ userId: string }> }): string[] {
  return Array.from(new Set([...(t.assigneeId ? [t.assigneeId] : []), ...t.resources.map((r) => r.userId)]))
}

const linkOf = (t: { id: string; boardId: string | null }) => (t.boardId ? `/marketing/board?card=${t.id}` : '/me/tasks')

function taskDto(t: TaskRow, me: string, names: Map<string, string>) {
  return {
    id: t.id,
    kind: t.boardId ? 'card' as const : 'calendar' as const,
    tenantId: t.tenantId,
    title: t.title,
    brief: t.description,
    type: t.type,
    deadline: t.startDate,
    board: t.board,
    brand: t.concept,
    stage: t.stage,
    stageLabel: t.stage ? STAGE_LABEL[t.stage as Stage] : null,
    myRole: t.assigneeId === me ? (t.boardId ? 'owner' as const : 'assignee' as const) : 'resource' as const,
    owner: t.assignee,
    resources: t.resources.map((r) => r.user),
    createdBy: t.createdBy,
    status: taskStatusOf(t),
    doneAt: t.taskDoneAt,
    doneBy: t.taskDoneById ? { id: t.taskDoneById, name: names.get(t.taskDoneById) ?? null } : null,
    approvedAt: t.leadApprovedAt,
    approvedBy: t.leadApprovedById ? { id: t.leadApprovedById, name: names.get(t.leadApprovedById) ?? null } : null,
    overdue: !t.taskDoneAt && t.startDate.getTime() < Date.now(),
    link: linkOf(t),
  }
}

async function namesOf(rows: TaskRow[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(rows.flatMap((r) => [r.taskDoneById, r.leadApprovedById]).filter((x): x is string => !!x)))
  if (ids.length === 0) return new Map()
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
  return new Map(users.map((u) => [u.id, u.name]))
}

/** May this caller tick "Approved by leadership" on the task? */
async function mayApprove(req: FastifyRequest, t: { boardId: string | null; createdById: string }): Promise<boolean> {
  const su = req.staffUser!
  if (su.role === 'admin') return true
  if (su.role === INTERN_ROLE) return false
  if (await isLead(req)) return true
  return !t.boardId && t.createdById === su.id
}

/** Active logins who may approve a task of `tenantId` (for the "marked done" bell): CEOs and marketing leads of
 *  the company, plus the calendar entry's creator. */
async function approverIdsOf(tenantId: string, t: { boardId: string | null; createdById: string }): Promise<string[]> {
  const staff = await prisma.user.findMany({
    where: {
      deletedAt: null, isActive: true, role: { not: INTERN_ROLE },
      OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
    },
    select: { id: true, role: true },
  })
  const out: string[] = []
  for (const u of staff) {
    if (u.role === 'admin' || (await modulesOf(u.id, u.role)).has('marketing_lead')) out.push(u.id)
  }
  if (!t.boardId) out.push(t.createdById)
  return Array.from(new Set(out))
}

function bell(t: { id: string; tenantId: string; title: string; boardId: string | null }, userIds: string[], actorId: string, title: string, dedupe: string) {
  const ids = Array.from(new Set(userIds)).filter((u) => u !== actorId)
  if (ids.length === 0) return
  queueStaffNotify(() => notifyStaffMany(ids.map((userId) => ({
    userId, tenantId: t.tenantId, kind: 'marketing.task' as const, severity: 'info' as const,
    title, body: t.title, link: linkOf(t),
    entityType: 'content_event', entityId: t.id, actorId, dedupeKey: `marketing.task:${t.id}:${dedupe}:${userId}`,
  }))))
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const adminOrigin = () => (process.env['ADMIN_ORIGIN'] ?? 'https://admin.servd.pk').replace(/\/+$/, '')

/**
 * Put on a task: an email to each person (and, for a calendar entry, the bell — a card already rings its own
 * marketing.card bell). Queued after the commit; never the actor; a person with no email is skipped.
 */
export function announceTaskAssigned(eventId: string, userIds: string[], actorId: string): void {
  const ids = Array.from(new Set(userIds)).filter((u) => u && u !== actorId)
  if (ids.length === 0) return
  queueStaffNotify(async () => {
    const t = await prisma.contentEvent.findUnique({
      where: { id: eventId },
      select: { id: true, tenantId: true, title: true, description: true, startDate: true, boardId: true, board: { select: { name: true } }, createdBy: { select: { name: true } } },
    })
    if (!t?.tenantId) return
    if (!t.boardId) bell({ ...t, tenantId: t.tenantId }, ids, actorId, 'A task was added to your list', 'assigned')
    const people = await prisma.user.findMany({ where: { id: { in: ids }, deletedAt: null, isActive: true }, select: { id: true, name: true, email: true } })
    const deadline = t.startDate.toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Karachi' })
    const where = t.board ? `the ${t.board.name} board` : 'the content calendar'
    const link = `${adminOrigin()}${linkOf(t)}`
    for (const p of people) {
      if (!p.email) continue
      const first = (p.name ?? '').trim().split(/\s+/)[0] || 'there'
      const html = `<p>Hi ${esc(first)},</p>`
        + `<p>${esc(t.createdBy?.name ?? 'Your team')} added you to a task on ${esc(where)}:</p>`
        + `<p><strong>${esc(t.title)}</strong><br>Due ${esc(deadline)}</p>`
        + (t.description ? `<p>${esc(t.description.slice(0, 600))}</p>` : '')
        + `<p><a href="${esc(link)}">Open it in servd</a>. Mark it done there when you finish; it leaves your list once leadership approves it.</p>`
      try { await sendEmail(p.email, `New task: ${t.title}`, html, 'task_assigned') }
      catch (err) { console.warn(`[tasks] email to a task assignee failed: ${(err as Error).message}`) }
    }
  })
}

/** The caller's own tasks (owner / resource / assignee), in every company they belong to. */
async function myTaskWhere(req: FastifyRequest): Promise<Prisma.ContentEventWhereInput> {
  const me = req.staffUser!.id
  return {
    ...(await scopeTenantWhere(req, 'write')),
    OR: [{ assigneeId: me }, { resources: { some: { userId: me } } }],
    AND: [{ OR: [{ boardId: null }, { board: { archivedAt: null } }] }],
  }
}

/** A task the caller may see: their own, or (as leadership) any of their companies'. 404 otherwise. */
async function taskInScope(req: FastifyRequest, id: string) {
  const t = await prisma.contentEvent.findFirst({
    where: { id, ...(await scopeTenantWhere(req, 'write')) },
    include: TASK_INCLUDE,
  })
  if (!t || !t.tenantId) throw new NotFoundError('Task', id)
  const me = req.staffUser!.id
  const mine = peopleOnTask(t).includes(me)
  if (!mine && !(await mayApprove(req, t))) throw new NotFoundError('Task', id)
  return { t: t as TaskRow & { tenantId: string }, mine }
}

export async function myTasksRoutes(fastify: FastifyInstance) {
  // Every staff login (calendar entries go to anyone), and the marketing intern (INTERN_ROUTES).
  const anyone = { preHandler: requireAuth(...ALL_STAFF, INTERN_ROLE) }

  // GET /my-tasks — { open, awaitingApproval, done (approved in the last 30 days), canApprove, toApprove? }.
  fastify.get('/', anyone, async (req) => {
    const me = req.staffUser!.id
    const base = await myTaskWhere(req)
    const since = new Date(Date.now() - 30 * 86_400_000)
    const [active, done] = await Promise.all([
      prisma.contentEvent.findMany({ where: { ...base, leadApprovedAt: null }, include: TASK_INCLUDE, orderBy: [{ startDate: 'asc' }], take: 500 }),
      prisma.contentEvent.findMany({ where: { ...base, leadApprovedAt: { gte: since } }, include: TASK_INCLUDE, orderBy: [{ leadApprovedAt: 'desc' }], take: 100 }),
    ])
    // Leadership: tasks of their companies waiting for "Approved by leadership".
    const su = req.staffUser!
    const lead = su.role === 'admin' || (su.role !== INTERN_ROLE && await isLead(req))
    const waitingWhere: Prisma.ContentEventWhereInput = {
      ...(await scopeTenantWhere(req, 'write')),
      taskDoneAt: { not: null }, leadApprovedAt: null,
      AND: [{ OR: [{ boardId: null }, { board: { archivedAt: null } }] }],
      ...(lead ? {} : { boardId: null, createdById: me }),
    }
    const waiting = su.role === INTERN_ROLE ? [] : await prisma.contentEvent.findMany({ where: waitingWhere, include: TASK_INCLUDE, orderBy: [{ taskDoneAt: 'asc' }], take: 300 })
    const toApprove = waiting.filter((t) => su.role === 'admin' || !peopleOnTask(t).includes(me))
    const names = await namesOf([...active, ...done, ...toApprove])
    return {
      open: active.filter((t) => !t.taskDoneAt).map((t) => taskDto(t, me, names)),
      awaitingApproval: active.filter((t) => t.taskDoneAt).map((t) => taskDto(t, me, names)),
      done: done.map((t) => taskDto(t, me, names)),
      canApprove: lead || toApprove.length > 0,
      toApprove: toApprove.map((t) => taskDto(t, me, names)),
    }
  })

  // POST /my-tasks/:id/done {done} — someone on the task, or leadership. Undone only until approved (409 TASK_APPROVED).
  fastify.post<{ Params: { id: string } }>('/:id/done', anyone, async (req) => {
    const { done } = z.object({ done: z.boolean() }).strict().parse(req.body)
    const { t, mine } = await taskInScope(req, req.params.id)
    if (!mine && !(await mayApprove(req, t))) throw new ForbiddenError('Only the people on this task mark it done')
    if (t.leadApprovedAt) throw new AppError('TASK_APPROVED', 'Leadership already approved this task — ask them to reopen it first.', 409)
    const me = req.staffUser!.id
    const moved = await prisma.contentEvent.updateMany({
      where: { id: t.id, leadApprovedAt: null, taskDoneAt: done ? null : { not: null } },
      data: done ? { taskDoneAt: new Date(), taskDoneById: me } : { taskDoneAt: null, taskDoneById: null },
    })
    if (moved.count === 0 && Boolean(t.taskDoneAt) !== done) throw new AppError('TASK_CHANGED', 'Someone else changed this task — refresh and try again.', 409)
    if (moved.count > 0 && done) bell(t, await approverIdsOf(t.tenantId, t), me, 'A task is done — approve it', `done:${Date.now()}`)
    const fresh = await prisma.contentEvent.findUniqueOrThrow({ where: { id: t.id }, include: TASK_INCLUDE })
    return taskDto(fresh, me, await namesOf([fresh]))
  })

  // POST /my-tasks/:id/approve {approved} — "Approved by leadership" (or reopen with false). Only after it is done
  // (409 TASK_NOT_DONE); never your own task (the CEO excepted).
  fastify.post<{ Params: { id: string } }>('/:id/approve', anyone, async (req) => {
    const { approved } = z.object({ approved: z.boolean() }).strict().parse(req.body)
    const { t } = await taskInScope(req, req.params.id)
    if (!(await mayApprove(req, t))) {
      throw new ForbiddenError(t.boardId ? 'Only the marketing lead or the CEO approves a board task' : 'Only the CEO, the marketing lead or whoever set this task approves it')
    }
    const me = req.staffUser!.id
    if (req.staffUser!.role !== 'admin' && peopleOnTask(t).includes(me)) {
      throw new AppError('SELF_APPROVAL_BLOCKED', 'You are on this task — someone else in leadership approves it.', 403)
    }
    if (approved && !t.taskDoneAt) throw new AppError('TASK_NOT_DONE', 'Nobody has marked this task done yet.', 409)
    const moved = await prisma.contentEvent.updateMany({
      where: approved ? { id: t.id, leadApprovedAt: null, taskDoneAt: { not: null } } : { id: t.id, leadApprovedAt: { not: null } },
      // Reopen sends it back to the list as open (the person marks it done again).
      data: approved ? { leadApprovedAt: new Date(), leadApprovedById: me } : { leadApprovedAt: null, leadApprovedById: null, taskDoneAt: null, taskDoneById: null },
    })
    if (moved.count > 0) {
      bell(t, peopleOnTask(t), me, approved ? 'Leadership approved your task' : 'Leadership reopened your task', `${approved ? 'approved' : 'reopened'}:${Date.now()}`)
    }
    const fresh = await prisma.contentEvent.findUniqueOrThrow({ where: { id: t.id }, include: TASK_INCLUDE })
    return taskDto(fresh, me, await namesOf([fresh]))
  })
}
