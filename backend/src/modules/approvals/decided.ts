// "What I decided" (owner, 2026-11-16: "i approved 3 POs just now that have disappeared" — an approved item leaves
// the inbox, and nothing listed what the person had just decided).
//
// GET /approvals/decided?days=30 — the CALLER's OWN decisions, newest first, read from the one audit row every
// approve / reject / return route writes (`approval.decide`, lib/approvalRights.ts auditApproval). Read only; no new
// store. Each row says what it was, which company, the decision, when, and — for purchase orders, GRNs and cash
// vouchers — the document's number and what state it is in NOW, with a link to where it lives.
//
// Company separation: only rows the caller wrote (userId = the caller), and a row / document is shown only when its
// company is one the caller belongs to (a decision made through a hand-over in a company the caller is not a member
// of shows its type and time, never the document). Read on the service client on purpose: it is the caller's own
// history across ALL their companies — test companies included — whatever company is in view.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { serviceClient } from '../../lib/prisma.js'
import { toCents } from '../../lib/money.js'
import { APPROVAL_RIGHTS, isApprovalType } from '../../lib/approvalRights.js'

const LINKS: Record<string, string> = {
  purchase_order: '/procurement?tab=pos', grn: '/procurement?tab=grns', grn_finance: '/procurement?tab=grns',
  cash_voucher: '/finance/cash-vouchers', cash_request_finance: '/finance/cash-vouchers',
}

export interface DecidedRow {
  id: string; type: string; typeLabel: string; decision: string; decidedAt: string
  tenantId: string | null; company: string | null
  entityId: string | null; title: string | null; statusNow: string | null; amountCents: number | null; link: string | null
}

export async function decidedRoutes(fastify: FastifyInstance) {
  fastify.get('/decided', { preHandler: requireAuth(...ALL_STAFF) }, async (req): Promise<DecidedRow[]> => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query ?? {})
    const su = req.staffUser!
    const members = new Set(su.memberTenantIds ?? [])
    const logs = await serviceClient.auditLog.findMany({
      where: { action: 'approval.decide', userId: su.id, createdAt: { gte: new Date(Date.now() - days * 86_400_000) } },
      orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, tenantId: true, entityId: true, metadata: true, createdAt: true },
    })
    const typeOf = (m: unknown) => String((m as { type?: unknown } | null)?.type ?? '')
    const idsOf = (...types: string[]) => [...new Set(logs.filter((l) => types.includes(typeOf(l.metadata)) && l.entityId).map((l) => l.entityId!))]

    const poIds = idsOf('purchase_order'); const grnIds = idsOf('grn', 'grn_finance'); const cvIds = idsOf('cash_voucher', 'cash_request_finance')
    const [pos, grns, cvs] = await Promise.all([
      poIds.length ? serviceClient.purchaseOrder.findMany({ where: { id: { in: poIds } }, select: { id: true, reference: true, status: true, totalCents: true, supplier: { select: { name: true, tenantId: true, systemKind: true } } } }) : [],
      grnIds.length ? serviceClient.goodsReceipt.findMany({ where: { id: { in: grnIds } }, select: { id: true, tenantId: true, grnNumber: true, grnStatus: true } }) : [],
      cvIds.length ? serviceClient.cashVoucher.findMany({ where: { id: { in: cvIds } }, select: { id: true, tenantId: true, number: true, status: true, amountCents: true, purpose: true } }) : [],
    ])
    type Doc = { tenantId: string | null; title: string; statusNow: string | null; amountCents: number | null }
    const docs = new Map<string, Doc>()
    for (const p of pos) docs.set(`po:${p.id}`, { tenantId: p.supplier.tenantId, title: `${p.reference ?? 'PO'} — ${p.supplier.systemKind ? 'no supplier yet' : p.supplier.name}`, statusNow: p.status, amountCents: toCents(p.totalCents) })
    for (const g of grns) docs.set(`grn:${g.id}`, { tenantId: g.tenantId, title: g.grnNumber ?? 'GRN', statusNow: g.grnStatus, amountCents: null })
    for (const v of cvs) docs.set(`cv:${v.id}`, { tenantId: v.tenantId, title: `${v.number}${v.purpose ? ` — ${v.purpose.slice(0, 80)}` : ''}`, statusNow: v.status, amountCents: toCents(v.amountCents) })

    const tenantIds = [...new Set([...logs.map((l) => l.tenantId), ...[...docs.values()].map((d) => d.tenantId)].filter((t): t is string => !!t && members.has(t)))]
    const names = new Map(tenantIds.length ? (await serviceClient.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]) : [])

    return logs.map((l) => {
      const m = (l.metadata ?? {}) as { type?: string; decision?: string }
      const type = String(m.type ?? '')
      const key = type === 'purchase_order' ? `po:${l.entityId}` : type === 'grn' || type === 'grn_finance' ? `grn:${l.entityId}` : type === 'cash_voucher' || type === 'cash_request_finance' ? `cv:${l.entityId}` : ''
      const found = key ? docs.get(key) : undefined
      // The document only when its company (now) is one of the caller's own.
      const doc = found && found.tenantId && members.has(found.tenantId) ? found : undefined
      const tenantId = doc?.tenantId ?? (l.tenantId && members.has(l.tenantId) ? l.tenantId : null)
      return {
        id: l.id, type, typeLabel: isApprovalType(type) ? APPROVAL_RIGHTS[type].label : type || 'Approval',
        decision: String(m.decision ?? ''), decidedAt: l.createdAt.toISOString(),
        tenantId, company: tenantId ? names.get(tenantId) ?? null : null,
        entityId: doc ? l.entityId : null, title: doc?.title ?? null, statusNow: doc?.statusNow ?? (key && !found ? 'not found' : null),
        amountCents: doc?.amountCents ?? null, link: LINKS[type] ?? null,
      }
    })
  })
}
