// Trash — rejected and cancelled HR requests / records (stream B7, spec §1c).
//
//   hr_record  HrRecord `rejected` / `cancelled`. Copy = CREATED: a new DRAFT
//              through the module's own POST /hr/records/:section as the caller
//              (format validation, references and the company decide), with the
//              same form data. Approvals, stage and the system keys (`_…`,
//              written by logic) are never copied. A section whose work moved
//              elsewhere is listed but not copyable.
//
// Company: HrRecord.tenantId. Roles = HR_ADMIN (the HR back office); module
// `staff_hr`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { HR_ADMIN } from '../../../hr/routes.js'
import { sectionByKey } from '../../../hr/forms.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, injectCreate, roles, scopeIds } from './common.js'

export const TRASH_HR = { hr_record: 'hr_record' } as const

const HR = roles(HR_ADMIN)
const DEAD = { status: { in: ['rejected', 'cancelled'] } } satisfies Prisma.HrRecordWhereInput
const tenantIn = (ctx: TrashCtx) => ({ tenantId: { in: scopeIds(ctx.readScope) } })

const SELECT = {
  id: true, tenantId: true, section: true, status: true, startDate: true, updatedAt: true, approvals: true,
  employee: { select: { fullName: true } },
} satisfies Prisma.HrRecordSelect
type Sel = Prisma.HrRecordGetPayload<{ select: typeof SELECT }>

function lastNote(approvals: unknown): string | null {
  if (!Array.isArray(approvals)) return null
  for (let i = approvals.length - 1; i >= 0; i--) {
    const a = approvals[i] as { note?: unknown } | null
    if (a && typeof a.note === 'string' && a.note.trim()) return a.note
  }
  return null
}

function row(r: Sel): TrashRow {
  const sec = sectionByKey(r.section)
  return {
    id: r.id,
    tenantId: r.tenantId,
    title: `${sec?.title ?? r.section}${r.employee ? ` — ${r.employee.fullName}` : ''}`,
    subtitle: r.startDate ? `From ${r.startDate.toISOString().slice(0, 10)}` : null,
    at: r.updatedAt,
    reason: lastNote(r.approvals),
    statusLabel: r.status === 'rejected' ? 'Rejected' : 'Cancelled',
    notCopyableReason: !sec ? 'This kind of HR record no longer exists' : sec.movedTo ? sec.movedTo.message : null,
  }
}

const hrRecord: TrashProvider = {
  key: TRASH_HR.hr_record,
  label: 'HR request',
  moduleId: 'staff_hr',
  roles: { list: HR, restore: HR, copy: HR },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'identity',
  linkOf: () => '/hr',
  async list(ctx, f) {
    const s = f.q?.trim()
    const rows = await db.hrRecord.findMany({
      where: {
        AND: [
          tenantIn(ctx), DEAD, atWhere('updatedAt', f),
          s ? { OR: [{ section: { contains: s, mode: 'insensitive' } }, { employee: { fullName: { contains: s, mode: 'insensitive' } } }] } : {},
        ],
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: SELECT,
    })
    return rows.map(row)
  },
  async get(ctx, id) {
    const r = await db.hrRecord.findFirst({ where: { id, ...tenantIn(ctx), ...DEAD }, select: SELECT })
    return r ? row(r) : null
  },
  async copy(ctx, id) {
    const r = await db.hrRecord.findFirst({ where: { id, ...tenantIn(ctx), ...DEAD }, select: { section: true, data: true } })
    if (!r) throw new NotFoundError('Trash item', id)
    const stored = (r.data ?? {}) as Record<string, unknown>
    // Keys starting with _ are written by logic (an effect's _before, a swap's
    // _partner…) — never copied.
    const data = Object.fromEntries(Object.entries(stored).filter(([k]) => !k.startsWith('_')))
    const newId = await injectCreate(ctx, `/hr/records/${encodeURIComponent(r.section)}`, { data, submit: false }, (j) => {
      if (typeof j.id === 'string') return j.id
      const rec = j.record as { id?: unknown } | undefined
      return typeof rec?.id === 'string' ? rec.id : undefined
    })
    return { mode: 'created', id: newId, link: `/hr/s/${encodeURIComponent(r.section)}`, newEntityType: TRASH_HR.hr_record }
  },
  erasable: () => false,
}

export const HR_TRASH_PROVIDERS: readonly TrashProvider[] = [hrRecord]
