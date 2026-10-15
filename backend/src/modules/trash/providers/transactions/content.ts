// Trash — cancelled calendar events (stream B7, spec §1c).
//
//   content_event_cancelled  ContentEvent `cancelled`. Copy = CREATED: a new
//                            `draft` through the module's own POST /calendar as
//                            the caller (brand and assignee must be the active
//                            company's): title, brand, type, copy (metadata),
//                            department, colour, the dates (kept, editable).
//                            The social post's publish state is never copied.
//
// (A DELETED calendar event is a different thing — the master type
// `content_event`, a snapshot in providers/masters/marketing.ts.)
//
// Company: ContentEvent.tenantId. Roles = MANAGERS (the calendar's write
// guard); module `calendar`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { MANAGERS } from '../../../auth/middleware.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, injectCreate, qWhere, roles, scopeIds } from './common.js'

export const TRASH_CONTENT = { content_event_cancelled: 'content_event_cancelled' } as const

const MGR = roles(MANAGERS)
const tenantIn = (ctx: TrashCtx) => ({ tenantId: { in: scopeIds(ctx.readScope) } })
const DEAD = { status: 'cancelled' } satisfies Prisma.ContentEventWhereInput

const SELECT = {
  id: true, tenantId: true, conceptId: true, title: true, type: true, startDate: true, updatedAt: true,
} satisfies Prisma.ContentEventSelect
type Sel = Prisma.ContentEventGetPayload<{ select: typeof SELECT }>

const row = (e: Sel): TrashRow => ({
  id: e.id,
  tenantId: e.tenantId,
  conceptId: e.conceptId,
  title: e.title,
  subtitle: `${e.type.replace(/_/g, ' ')} · ${e.startDate.toISOString().slice(0, 10)}`,
  at: e.updatedAt,
  statusLabel: 'Cancelled',
})

const contentEvent: TrashProvider = {
  key: TRASH_CONTENT.content_event_cancelled,
  label: 'Cancelled calendar event',
  moduleId: 'calendar',
  roles: { list: MGR, restore: MGR, copy: MGR },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'identity',
  linkOf: () => '/calendar',
  async list(ctx, f) {
    const rows = await db.contentEvent.findMany({
      where: { AND: [tenantIn(ctx), DEAD, atWhere('updatedAt', f), qWhere(f.q, ['title', 'description'])] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: SELECT,
    })
    return rows.map(row)
  },
  async get(ctx, id) {
    const e = await db.contentEvent.findFirst({ where: { id, ...tenantIn(ctx), ...DEAD }, select: SELECT })
    return e ? row(e) : null
  },
  async copy(ctx, id) {
    const e = await db.contentEvent.findFirst({
      where: { id, ...tenantIn(ctx), ...DEAD },
      select: {
        title: true, description: true, type: true, startDate: true, endDate: true, allDay: true,
        conceptId: true, assigneeId: true, department: true, color: true, metadata: true,
      },
    })
    if (!e) throw new NotFoundError('Trash item', id)
    const meta = e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>) : undefined
    const newId = await injectCreate(ctx, '/calendar', {
      title: e.title,
      ...(e.description ? { description: e.description } : {}),
      type: e.type,
      startDate: e.startDate.toISOString(),
      ...(e.endDate ? { endDate: e.endDate.toISOString() } : {}),
      allDay: e.allDay,
      status: 'draft',
      ...(e.conceptId ? { conceptId: e.conceptId } : {}),
      ...(e.assigneeId ? { assigneeId: e.assigneeId } : {}),
      ...(e.department ? { department: e.department } : {}),
      ...(e.color ? { color: e.color } : {}),
      ...(meta ? { metadata: meta } : {}),
    }, (j) => (typeof j.id === 'string' ? j.id : undefined))
    return { mode: 'created', id: newId, link: '/calendar', newEntityType: 'content_event' }
  },
  erasable: () => false,
}

export const CONTENT_TRASH_PROVIDERS: readonly TrashProvider[] = [contentEvent]
