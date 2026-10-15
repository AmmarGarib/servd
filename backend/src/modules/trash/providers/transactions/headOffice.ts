// Trash — rejected, withdrawn and reversed head-office recharge runs (stream
// B7, spec §1c).
//
//   recharge_run  RechargeRun `rejected` / `withdrawn` / `reversed`. Copy =
//                 CREATED: the module's own prepare route
//                 (POST /accounting/intercompany/recharge-runs {headOfficeId,
//                 period}) as the caller — the lines are RECOMPUTED from today's
//                 books, never copied; the new run is a draft that is submitted
//                 for approval as usual. Nothing posts.
//
// Company: the run's head office (RechargeRun.tenantId). Roles = IC_PREPARERS
// (the run preparers); module `accounting`. Only members of the head office
// see its runs here (a served company sees its charges on its own screens).

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { IC_PREPARERS } from '../../../headOffices/runs.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, injectCreate, pkr, qWhere, roles, scopeIds } from './common.js'

export const TRASH_HEAD_OFFICE = { recharge_run: 'recharge_run' } as const

const PREP = roles(IC_PREPARERS)
const LINK = '/accounting/intercompany'
const DEAD = { status: { in: ['rejected', 'withdrawn', 'reversed'] } } satisfies Prisma.RechargeRunWhereInput
const LABEL: Record<string, string> = { rejected: 'Rejected', withdrawn: 'Withdrawn', reversed: 'Reversed' }
const tenantIn = (ctx: TrashCtx) => ({ tenantId: { in: scopeIds(ctx.readScope) } })

const SELECT = {
  id: true, tenantId: true, period: true, kind: true, status: true, baseCents: true, rechargedCents: true,
  decidedById: true, decisionNote: true, reversedById: true, reversalReason: true, updatedAt: true,
  tenant: { select: { name: true } },
} satisfies Prisma.RechargeRunSelect
type Sel = Prisma.RechargeRunGetPayload<{ select: typeof SELECT }>

function row(r: Sel): TrashRow {
  const reversed = r.status === 'reversed'
  return {
    id: r.id,
    tenantId: r.tenantId,
    title: `Recharge ${r.period} — ${r.tenant.name}`,
    subtitle: `${r.kind === 'true_up' ? 'True-up' : 'Monthly'} · ${pkr(r.rechargedCents)} of ${pkr(r.baseCents)}`,
    at: r.updatedAt,
    byId: reversed ? r.reversedById : r.decidedById,
    reason: reversed ? r.reversalReason : r.decisionNote,
    statusLabel: LABEL[r.status] ?? r.status,
  }
}

const rechargeRun: TrashProvider = {
  key: TRASH_HEAD_OFFICE.recharge_run,
  label: 'Head-office recharge run',
  moduleId: 'accounting',
  roles: { list: PREP, restore: PREP, copy: PREP },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => LINK,
  async list(ctx, f) {
    const rows = await db.rechargeRun.findMany({
      where: { AND: [tenantIn(ctx), DEAD, atWhere('updatedAt', f), qWhere(f.q, ['period', 'decisionNote', 'reversalReason'])] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: SELECT,
    })
    return rows.map(row)
  },
  async get(ctx, id) {
    const r = await db.rechargeRun.findFirst({ where: { id, ...tenantIn(ctx), ...DEAD }, select: SELECT })
    return r ? row(r) : null
  },
  async copy(ctx, id) {
    const r = await db.rechargeRun.findFirst({ where: { id, ...tenantIn(ctx), ...DEAD }, select: { tenantId: true, period: true } })
    if (!r) throw new NotFoundError('Trash item', id)
    const newId = await injectCreate(ctx, '/accounting/intercompany/recharge-runs', { headOfficeId: r.tenantId, period: r.period },
      (j) => (typeof j.id === 'string' ? j.id : undefined))
    return { mode: 'created', id: newId, link: LINK, newEntityType: TRASH_HEAD_OFFICE.recharge_run }
  },
  erasable: () => false,
}

export const HEAD_OFFICE_TRASH_PROVIDERS: readonly TrashProvider[] = [rechargeRun]
