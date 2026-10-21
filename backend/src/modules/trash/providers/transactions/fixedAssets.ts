// Trash — rejected and cancelled fixed-asset requests (stream B7, spec §1c).
//
//   fixed_asset_request  FixedAssetEvent `rejected` / `cancelled` (the per-layer
//                        allocation rows the engine writes are never listed).
//                        Copy = PREFILL of the same request on the same asset
//                        (disposal, write-down, change of estimate, move, void,
//                        undo disposal): the reason and the kind's own figures.
//                        The CEO approves it again; the date starts from today;
//                        a sale's payment reference # is entered again.
//                        Capitalisations come from CapEx and pool requests from
//                        the pool screen — listed, not copyable here.
//
// The admin page reads { kind, assetId, reason, payload } after unwrapping ONE
// level of `payload`, so the copy is wrapped once more (see lib/trashPrefill.ts).
//
// Company: FixedAssetEvent.tenantId. Roles = FA_WRITER_ROLES (who raise
// requests); module `accounting`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { ALLOC_KINDS, FA_WRITER_ROLES } from '../../../fixedAssets/events.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, n, pkr, prefill, qWhere, roles, scopeIds } from './common.js'

export const TRASH_FIXED_ASSETS = { fixed_asset_request: 'fixed_asset_request' } as const

const FA = roles(FA_WRITER_ROLES)
const BASE = '/accounting/fixed-assets'
/** Requests raised on one asset — the asset page re-raises them. */
const ASSET_REQUEST_KINDS = new Set(['disposal', 'impairment', 'change_estimate', 'transfer', 'void', 'undispose'])
const KIND_LABEL: Record<string, string> = {
  capitalise: 'Capitalisation', disposal: 'Disposal', pool_write_off: 'Pool write-off', impairment: 'Write-down',
  change_estimate: 'Change of life / salvage', transfer: 'Move', pool_transfer: 'Pool move', void: 'Void', undispose: 'Undo disposal', count: 'Count',
  add_existing: 'Add existing asset',
}
const DEAD = { status: { in: ['rejected', 'cancelled'] }, kind: { notIn: [...ALLOC_KINDS] } } satisfies Prisma.FixedAssetEventWhereInput
const tenantIn = (ctx: TrashCtx) => ({ tenantId: { in: scopeIds(ctx.readScope) } })

const SELECT = {
  id: true, tenantId: true, kind: true, status: true, assetId: true, amountCents: true, reason: true,
  decidedAt: true, decidedById: true, decisionNote: true, requestedAt: true,
  asset: { select: { name: true, assetTag: true, conceptId: true } },
} satisfies Prisma.FixedAssetEventSelect
type Sel = Prisma.FixedAssetEventGetPayload<{ select: typeof SELECT }>

function notCopyable(e: Pick<Sel, 'kind' | 'assetId'>): string | null {
  if (e.kind === 'capitalise') return 'A capitalisation comes from its CapEx line — raise it there again'
  if (e.kind === 'add_existing') return 'Raise it again from Fixed assets → Add existing asset'
  if (!ASSET_REQUEST_KINDS.has(e.kind) || !e.assetId) return 'Raise this pool request again from the smallwares pool'
  return null
}

function row(e: Sel): TrashRow {
  const what = e.asset ? `${e.asset.assetTag ? `${e.asset.assetTag} ` : ''}${e.asset.name}` : e.kind === 'add_existing' ? 'not yet on the register' : 'pool'
  return {
    id: e.id,
    tenantId: e.tenantId,
    conceptId: e.asset?.conceptId ?? null,
    title: `${KIND_LABEL[e.kind] ?? e.kind} — ${what}`,
    subtitle: [e.amountCents != null ? pkr(e.amountCents) : null, e.reason].filter(Boolean).join(' · ').slice(0, 300),
    at: e.decidedAt ?? e.requestedAt,
    byId: e.decidedById,
    reason: e.decisionNote,
    statusLabel: e.status === 'rejected' ? 'Rejected' : 'Cancelled',
    notCopyableReason: notCopyable(e),
  }
}

const fixedAssetRequest: TrashProvider = {
  key: TRASH_FIXED_ASSETS.fixed_asset_request,
  label: 'Fixed-asset request',
  moduleId: 'accounting',
  roles: { list: FA, restore: FA, copy: FA },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => BASE,
  async list(ctx, f) {
    const rows = await db.fixedAssetEvent.findMany({
      where: { AND: [tenantIn(ctx), DEAD, { decidedAt: { not: null } }, atWhere('decidedAt', f), qWhere(f.q, ['reason', 'decisionNote'])] },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: SELECT,
    })
    return rows.map(row)
  },
  async get(ctx, id) {
    const e = await db.fixedAssetEvent.findFirst({ where: { id, ...tenantIn(ctx), ...DEAD }, select: SELECT })
    return e ? row(e) : null
  },
  async copy(ctx, id) {
    const e = await db.fixedAssetEvent.findFirst({
      where: { id, ...tenantIn(ctx), ...DEAD },
      select: { kind: true, assetId: true, reason: true, payload: true },
    })
    if (!e) throw new NotFoundError('Trash item', id)
    const figures = { ...((e.payload ?? {}) as Record<string, unknown>) }
    // Never: the sale's payment reference #, the CEO's decision, the date.
    delete figures.reference
    return prefill(`${BASE}/${e.assetId}`, {
      payload: { kind: e.kind, assetId: e.assetId, reason: e.reason, payload: figures },
    })
  },
  erasable: () => false,
}

export const FIXED_ASSET_TRASH_PROVIDERS: readonly TrashProvider[] = [fixedAssetRequest]
