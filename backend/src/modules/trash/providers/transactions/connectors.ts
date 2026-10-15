// Trash — rejected and withdrawn POS-connector change requests (stream B7,
// spec §1c).
//
//   pos_connector_change  PosConnectorChange `rejected` / `withdrawn`. Copy =
//                         PREFILL of the change-request form: the connector kind
//                         and the requested settings (`patch` — the PUT body
//                         minus secrets). Secrets (API key, webhook secret) are
//                         never copied: they are entered again. The CEO decides
//                         again.
//
// Company: PosConnectorChange.tenantId. Roles = CONNECTOR_ADMINS (who send a
// change request); module `api_pos`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { CONNECTOR_ADMINS } from '../../../../lib/connectorRoles.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, prefill, qWhere, roles, scopeIds } from './common.js'

export const TRASH_CONNECTORS = { pos_connector_change: 'pos_connector_change' } as const

const ADMINS = roles(CONNECTOR_ADMINS)
const LINK = '/connectors/pos'
const DEAD = { status: { in: ['rejected', 'withdrawn'] } } satisfies Prisma.PosConnectorChangeWhereInput
const tenantIn = (ctx: TrashCtx) => ({ tenantId: { in: scopeIds(ctx.readScope) } })
/** Anything that looks like a secret never leaves the row. */
const SECRET_KEY = /(api.?key|secret|token|password)/i

const SELECT = {
  id: true, tenantId: true, kind: true, status: true, decidedAt: true, decidedById: true, decisionNote: true, updatedAt: true, patch: true,
} satisfies Prisma.PosConnectorChangeSelect
type Sel = Prisma.PosConnectorChangeGetPayload<{ select: typeof SELECT }>

function row(c: Sel): TrashRow {
  const p = (c.patch ?? {}) as Record<string, unknown>
  return {
    id: c.id,
    tenantId: c.tenantId,
    title: `${c.kind === 'terminal' ? 'Card machine' : c.kind === 'fiscal' ? 'Fiscal POS' : c.kind} change${typeof p.driver === 'string' ? ` — ${p.driver}` : ''}`,
    subtitle: Object.keys(p).filter((k) => !SECRET_KEY.test(k)).join(', ') || null,
    at: c.decidedAt ?? c.updatedAt,
    byId: c.decidedById,
    reason: c.decisionNote,
    statusLabel: c.status === 'rejected' ? 'Rejected' : 'Withdrawn',
  }
}

function withoutSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutSecrets)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, withoutSecrets(x)]))
  }
  return v
}

const posConnectorChange: TrashProvider = {
  key: TRASH_CONNECTORS.pos_connector_change,
  label: 'POS connector change',
  moduleId: 'api_pos',
  roles: { list: ADMINS, restore: ADMINS, copy: ADMINS },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'identity',
  linkOf: () => LINK,
  async list(ctx, f) {
    const rows = await db.posConnectorChange.findMany({
      where: { AND: [tenantIn(ctx), DEAD, atWhere('updatedAt', f), qWhere(f.q, ['decisionNote'])] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: SELECT,
    })
    return rows.map((c) => ({ ...row(c), at: c.updatedAt }))
  },
  async get(ctx, id) {
    const c = await db.posConnectorChange.findFirst({ where: { id, ...tenantIn(ctx), ...DEAD }, select: SELECT })
    return c ? { ...row(c), at: c.updatedAt } : null
  },
  async preview(ctx, id) {
    const c = await db.posConnectorChange.findFirst({ where: { id, ...tenantIn(ctx) }, select: { kind: true, patch: true } })
    if (!c) return []
    const p = withoutSecrets(c.patch ?? {}) as Record<string, unknown>
    return [{ label: 'Connector', value: c.kind }, ...Object.entries(p).map(([k, v]) => ({ label: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }))]
  },
  async copy(ctx, id) {
    const c = await db.posConnectorChange.findFirst({ where: { id, ...tenantIn(ctx), ...DEAD }, select: { kind: true, patch: true } })
    if (!c) throw new NotFoundError('Trash item', id)
    return prefill(LINK, { kind: c.kind, changes: withoutSecrets(c.patch ?? {}), warnings: ['Enter the API key and webhook secret again if this change needs them'] })
  },
  erasable: () => false,
}

export const CONNECTOR_TRASH_PROVIDERS: readonly TrashProvider[] = [posConnectorChange]
