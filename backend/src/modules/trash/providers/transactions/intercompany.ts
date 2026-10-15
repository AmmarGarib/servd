// Trash — rejected and reversed inter-company transfers (stream B7, spec §1c).
//
//   intercompany_transfer  IntercompanyTransfer `rejected` / `reversed`. Copy =
//                          PREFILL of the transfer form (a normal submission:
//                          the server re-checks the pair, the accounts and the
//                          approval): kind, the two companies, amount, memo,
//                          account codes, period, method. Never: the bank
//                          accounts' entries, the payment reference #, the
//                          decision, the postings. System transfers
//                          (ho_recharge / cod / fleet) are listed but not
//                          copyable — their source makes them again.
//
// Company: a transfer belongs to BOTH parties; the row is shown to a member of
// either, stamped with the caller's side (the active company when it is a
// party). Roles: list = FINANCIALS_VIEWERS (the transfers list's guard), copy =
// the preparers (intercompany/routes.ts TRANSFER_PREPARERS); module `accounting`.

import type { Prisma, UserRole } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { FINANCIALS_VIEWERS } from '../../../auth/middleware.js'
import { TRANSFER_PREPARERS } from '../../../intercompany/routes.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, n, pkr, pktDate, prefill, qWhere, roles, scopeIds } from './common.js'

export const TRASH_INTERCOMPANY = { intercompany_transfer: 'intercompany_transfer' } as const

const FIN = roles(FINANCIALS_VIEWERS)
const IC_PREPARE: readonly UserRole[] = TRANSFER_PREPARERS
const LINK = '/accounting/intercompany'
const SYSTEM_NOT_COPYABLE = 'A system transfer (head-office recharge, COD or shared fleet) is made again by its own source, not copied'

function scope(ctx: TrashCtx): Prisma.IntercompanyTransferWhereInput {
  const ids = scopeIds(ctx.readScope)
  return { OR: [{ tenantId: { in: ids } }, { counterpartyTenantId: { in: ids } }] }
}
const DEAD = { status: { in: ['rejected', 'reversed'] } } satisfies Prisma.IntercompanyTransferWhereInput

const SELECT = {
  id: true, tenantId: true, counterpartyTenantId: true, kind: true, source: true, amountCents: true, memo: true, status: true,
  decidedAt: true, decidedById: true, decisionNote: true, reversedAt: true, reversedById: true, reversalReason: true, updatedAt: true,
  debtor: { select: { name: true } }, creditor: { select: { name: true } },
} satisfies Prisma.IntercompanyTransferSelect
type Sel = Prisma.IntercompanyTransferGetPayload<{ select: typeof SELECT }>

function row(ctx: TrashCtx, t: Sel): TrashRow {
  const ids = scopeIds(ctx.readScope)
  const mine = ctx.activeTenantId && (t.tenantId === ctx.activeTenantId || t.counterpartyTenantId === ctx.activeTenantId)
    ? ctx.activeTenantId
    : ids.includes(t.tenantId) ? t.tenantId : t.counterpartyTenantId
  const reversed = t.status === 'reversed'
  return {
    id: t.id,
    tenantId: mine,
    title: `${t.kind} ${t.debtor.name} → ${t.creditor.name} — ${pkr(t.amountCents)}`,
    subtitle: t.memo,
    at: t.updatedAt,
    byId: reversed ? t.reversedById : t.decidedById,
    reason: reversed ? t.reversalReason : t.decisionNote,
    statusLabel: reversed ? 'Reversed' : 'Rejected',
    notCopyableReason: t.source === 'manual' ? null : SYSTEM_NOT_COPYABLE,
  }
}

const intercompanyTransfer: TrashProvider = {
  key: TRASH_INTERCOMPANY.intercompany_transfer,
  label: 'Inter-company transfer',
  moduleId: 'accounting',
  roles: { list: FIN, restore: IC_PREPARE, copy: IC_PREPARE },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => LINK,
  async list(ctx, f) {
    const rows = await db.intercompanyTransfer.findMany({
      where: { AND: [scope(ctx), DEAD, atWhere('updatedAt', f), qWhere(f.q, ['memo', 'decisionNote', 'reversalReason'])] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: SELECT,
    })
    return rows.map((t) => row(ctx, t))
  },
  async get(ctx, id) {
    const t = await db.intercompanyTransfer.findFirst({ where: { id, ...DEAD, ...scope(ctx) }, select: SELECT })
    return t ? row(ctx, t) : null
  },
  async copy(ctx, id) {
    const t = await db.intercompanyTransfer.findFirst({
      where: { id, ...DEAD, ...scope(ctx) },
      select: {
        kind: true, source: true, tenantId: true, counterpartyTenantId: true, amountCents: true, memo: true, period: true,
        debtorAccountCode: true, creditorAccountCode: true, conceptSplit: true, method: true, entryDate: true,
      },
    })
    if (!t) throw new NotFoundError('Trash item', id)
    // Never: bank accounts / bank reference, the decision, the two entries.
    return prefill(LINK, {
      kind: t.kind,
      debtorTenantId: t.tenantId,
      creditorTenantId: t.counterpartyTenantId,
      amountCents: n(t.amountCents),
      memo: t.memo,
      period: t.period,
      debtorAccountCode: t.debtorAccountCode,
      creditorAccountCode: t.creditorAccountCode,
      conceptSplit: t.conceptSplit,
      method: t.method,
      originalEntryDate: pktDate(t.entryDate),
      bankReference: null,
    })
  },
  erasable: () => false,
}

export const INTERCOMPANY_TRASH_PROVIDERS: readonly TrashProvider[] = [intercompanyTransfer]
