// Trash — rejected and cancelled cash vouchers (stream B7, spec §1c).
//
//   cash_voucher  CashVoucher `rejected` / `cancelled`. Copy = PREFILL of the
//                 voucher form (there is no draft step since 2026-10-15: a new
//                 voucher is `submitted` at once and goes finance → CEO again).
//                 Copied: kind, purpose, category, brand, department, amount;
//                 kind `expense` also the payee, gross and discount — finance's
//                 only, so for anyone else the copy becomes a plain request.
//                 Never: the number, the raiser (= whoever recovers it), the
//                 box, the holder, approvals / signatures, attachments.
//
// Company: CashVoucher.tenantId. Roles = FINANCIALS_VIEWERS (finance and the
// CEO decide vouchers); module `accounting`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { FINANCIALS_VIEWERS } from '../../../auth/middleware.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, pkr, prefill, qWhere, roles, scopeIds } from './common.js'

export const TRASH_CASH_VOUCHERS = { cash_voucher: 'cash_voucher' } as const

const FIN = roles(FINANCIALS_VIEWERS)
const LINK = '/finance/cash-vouchers'
const DEAD = { status: { in: ['rejected', 'cancelled'] } } satisfies Prisma.CashVoucherWhereInput
const tenantIn = (ctx: TrashCtx) => ({ tenantId: { in: scopeIds(ctx.readScope) } })

const SELECT = {
  id: true, tenantId: true, conceptId: true, number: true, payeeName: true, purpose: true, amountCents: true, status: true,
  rejectedAt: true, rejectedById: true, rejectNote: true, cancelledAt: true, cancelledById: true, cancelNote: true, updatedAt: true,
} satisfies Prisma.CashVoucherSelect
type Sel = Prisma.CashVoucherGetPayload<{ select: typeof SELECT }>

function row(v: Sel): TrashRow {
  const rejected = v.status === 'rejected'
  return {
    id: v.id,
    tenantId: v.tenantId,
    conceptId: v.conceptId,
    title: `${v.number} — ${pkr(v.amountCents)}`,
    subtitle: `${v.payeeName} · ${v.purpose}`.slice(0, 300),
    // The list is ordered by updatedAt (the reject / cancel is its last write).
    at: v.updatedAt,
    byId: rejected ? v.rejectedById : v.cancelledById,
    reason: rejected ? v.rejectNote : v.cancelNote,
    statusLabel: rejected ? 'Rejected' : 'Cancelled',
  }
}

const cashVoucher: TrashProvider = {
  key: TRASH_CASH_VOUCHERS.cash_voucher,
  label: 'Cash voucher',
  moduleId: 'accounting',
  roles: { list: FIN, restore: FIN, copy: FIN },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => LINK,
  async list(ctx, f) {
    const rows = await db.cashVoucher.findMany({
      where: { AND: [tenantIn(ctx), DEAD, atWhere('updatedAt', f), qWhere(f.q, ['number', 'payeeName', 'purpose', 'rejectNote', 'cancelNote'])] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: SELECT,
    })
    return rows.map(row)
  },
  async get(ctx, id) {
    const v = await db.cashVoucher.findFirst({ where: { id, ...tenantIn(ctx), ...DEAD }, select: SELECT })
    return v ? row(v) : null
  },
  async copy(ctx, id) {
    const v = await db.cashVoucher.findFirst({
      where: { id, ...tenantIn(ctx), ...DEAD },
      select: { kind: true, purpose: true, category: true, conceptId: true, department: true, amountCents: true, grossCents: true, discountCents: true, payeeName: true },
    })
    if (!v) throw new NotFoundError('Trash item', id)
    const warnings: string[] = []
    // An outside-payee expense (and its discount) is finance's only.
    const financeSide = ctx.isCeo || ctx.user.role === 'finance'
    const kind = v.kind === 'expense' && financeSide ? 'expense' : 'request'
    if (v.kind === 'expense' && kind === 'request') warnings.push('An outside-payee expense is raised by finance — this copy is a cash request')
    return prefill(LINK, {
      kind,
      purpose: v.purpose,
      category: v.category,
      conceptId: v.conceptId,
      department: v.department,
      amountCents: v.amountCents,
      ...(kind === 'expense'
        ? { payeeName: v.payeeName, grossCents: v.grossCents ?? v.amountCents + v.discountCents, discountCents: v.discountCents }
        : {}),
      warnings,
    })
  },
  erasable: () => false,
}

export const CASH_VOUCHER_TRASH_PROVIDERS: readonly TrashProvider[] = [cashVoucher]
