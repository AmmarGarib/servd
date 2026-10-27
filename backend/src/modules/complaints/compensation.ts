// Compensation tickets (owner, 2026-10-27: "extend Complaints").
//
// Every situation where a customer is compensated runs on a TICKET — an
// OrderComplaint of kind 'compensation' on the existing Complaints queue (no
// second table). EVERY one, whatever the amount:
//   void           a rung-up line voided (audit 'order_item_void') or a whole
//                  bill cancelled by staff (audit 'order.cancel' with a user)
//   comp           a comp / No Charge (audit 'order_comp'; a staff meal,
//                  'order_staff_meal', is not customer compensation)
//   refund         a refund (audit 'order_refund' — card-machine refunds book
//                  through the same refundOrder; the refund a line void makes,
//                  metadata.voidedItemId, is part of that void's ticket),
//                  money handed back on a cancelled ticket ('order_refund_due')
//                  and a credit note's pay-out ('order_credit_note_payout')
//   discount       a discount above the cashier's limit (review flag
//                  'discount_above_cap' on the order)
//   price_override a line priced away from the menu at the till (review flag
//                  'price_override' on the order)
//
// Tickets are made FROM those committed rows, never by hooking the till: the
// till paths already write them. `syncCompensationTickets` reads the rows of a
// window, per company, and inserts one ticket per row with compSourceRef
// 'audit:<id>' / 'flag:<id>' (unique) via createMany skipDuplicates — so two
// workers, a retry, or the list route's own sync never make a second ticket.
// The worker runs it every minute (workers/compensationTickets.ts); the
// Compensation list runs it for the caller's companies before reading.
//
// A ticket made by a manager does NOT wait for the CEO: it is born 'resolved'
// (it went through). The CEO may FLAG any ticket (POST /complaints/:id/flag,
// note ≥10): an ExceptionFlag 'compensation_flagged' in the ticket's company
// naming the approving manager (actorId = the manager, so the bell's claim
// poller tells the CEO(s), never the manager); the manager sees the flag on
// the ticket. Unflag clears the ticket's mark and resolves that flag.
// Hand-over of the flag right: not built — see FLAG_ROLES below.
//
// Company: the ticket's brand (conceptId = the ORDER's brand) decides it, as
// for every complaint (complaintScopeWhere). Rows whose order is gone are
// skipped.

import type { Prisma } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { isOverrideApprover } from '../../lib/roles.js'

export const COMPENSATION_TYPES = ['void', 'comp', 'refund', 'discount', 'price_override'] as const
export type CompensationType = typeof COMPENSATION_TYPES[number]

export const COMPENSATION_LABEL: Record<CompensationType, string> = {
  void: 'Void', comp: 'Comp / No Charge', refund: 'Refund', discount: 'Discount above limit', price_override: 'Price override',
}

/**
 * Who may flag a ticket. The CEO only for now (owner, 2026-10-27). The owner
 * will hand this right over later; the approvals hand-over registry
 * (lib/approvalRights.ts APPROVAL_RIGHTS / approvals/delegations.ts) is built
 * for approving queue items of a head office's companies, not for a review
 * mark on a done ticket, so it does not fit as is — the hand-over is a
 * separate change (a delegable section or a module tick) when the owner asks.
 */
export const FLAG_ROLES = ['admin'] as const

/** The audit actions that make a ticket, and their type. */
export const AUDIT_SOURCES: Record<string, CompensationType> = {
  order_item_void: 'void',
  'order.cancel': 'void',
  order_comp: 'comp',
  order_refund: 'refund',
  order_refund_due: 'refund',
  order_credit_note_payout: 'refund',
}

/** The review-flag kinds that make a ticket, and their type. */
export const FLAG_SOURCES: Record<string, CompensationType> = {
  discount_above_cap: 'discount',
  price_override: 'price_override',
}

/** How far back a sync looks (the worker runs every minute; a week covers any outage). */
export const SYNC_WINDOW_DAYS = 7
const BATCH = 500

type Draft = {
  sourceRef: string
  type: CompensationType
  orderId: string
  valueCents: number
  reason: string
  actorId: string | null
  approverId: string | null
  at: Date
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const cents = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  // INT4 column; a figure outside it is clamped (a ticket must never fail to save).
  return Number.isFinite(n) ? Math.max(-2_147_483_647, Math.min(2_147_483_647, Math.round(Math.abs(n)))) : 0
}

function draftFromAudit(row: { id: string; action: string; entityId: string | null; userId: string | null; before: unknown; metadata: unknown; createdAt: Date }): Draft | null {
  const type = AUDIT_SOURCES[row.action]
  if (!type) return null
  const m = obj(row.metadata)
  // The refund a line void makes belongs to that void's ticket.
  if (row.action === 'order_refund' && m['voidedItemId']) return null
  // A whole-bill cancel by staff only (the auto-cancel sweep, a customer's
  // checkout undo and expo rejects use other actions or carry no user).
  if (row.action === 'order.cancel' && !row.userId) return null
  const orderId = row.action === 'order_item_void' ? str(m['orderId']) : row.entityId
  if (!orderId) return null
  const valueCents = row.action === 'order_item_void' ? cents(m['lineCents'])
    : row.action === 'order.cancel' ? cents(obj(row.before)['totalCents'])
    : cents(m['amountCents'])
  return {
    sourceRef: `audit:${row.id}`, type, orderId, valueCents,
    reason: str(m['reason']) ?? 'No reason recorded',
    actorId: row.userId, approverId: str(m['approverId']), at: row.createdAt,
  }
}

function draftFromFlag(row: { id: string; kind: string; entityType: string | null; entityId: string | null; actorId: string | null; amountCents: unknown; description: string; metadata: unknown; createdAt: Date }, roles: Map<string, string>): Draft | null {
  const type = FLAG_SOURCES[row.kind]
  if (!type || row.entityType !== 'Order' || !row.entityId) return null
  const m = obj(row.metadata)
  // The flag names who approved it (metadata.approverId, from 2026-10-27: the manager whose PIN
  // was used, or the manager at the till). Older flags: a manager at the till approved it
  // themselves, otherwise the approver is unknown (null).
  const actorRole = row.actorId ? roles.get(row.actorId) ?? null : null
  return {
    sourceRef: `flag:${row.id}`, type, orderId: row.entityId, valueCents: cents(row.amountCents),
    reason: str(m['reason']) ?? row.description.slice(0, 1000),
    actorId: row.actorId, approverId: str(m['approverId']) ?? (row.actorId && isOverrideApprover(actorRole) ? row.actorId : null), at: row.createdAt,
  }
}

/**
 * Make the missing tickets of one company's window. Idempotent (compSourceRef
 * unique + skipDuplicates). Returns how many were made.
 */
export async function syncCompensationTicketsForCompany(tenantId: string, opts: { since?: Date } = {}): Promise<number> {
  const since = opts.since ?? new Date(Date.now() - SYNC_WINDOW_DAYS * 86_400_000)
  const db = serviceClient
  const drafts: Draft[] = []

  let cursor: string | undefined
  for (;;) {
    const rows = await db.auditLog.findMany({
      where: { tenantId, action: { in: Object.keys(AUDIT_SOURCES) }, createdAt: { gte: since } },
      select: { id: true, action: true, entityId: true, userId: true, before: true, metadata: true, createdAt: true },
      orderBy: { id: 'asc' }, take: BATCH, ...(cursor && { skip: 1, cursor: { id: cursor } }),
    })
    for (const r of rows) { const d = draftFromAudit(r); if (d) drafts.push(d) }
    if (rows.length < BATCH) break
    cursor = rows[rows.length - 1]!.id
  }

  const flags = await db.exceptionFlag.findMany({
    where: { tenantId, kind: { in: Object.keys(FLAG_SOURCES) }, entityType: 'Order', createdAt: { gte: since } },
    select: { id: true, kind: true, entityType: true, entityId: true, actorId: true, amountCents: true, description: true, metadata: true, createdAt: true },
  })
  const actorIds = [...new Set(flags.map((f) => f.actorId).filter((x): x is string => !!x))]
  const roles = new Map((actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, role: true } }) : []).map((u) => [u.id, u.role as string]))
  for (const f of flags) { const d = draftFromFlag(f, roles); if (d) drafts.push(d) }
  if (drafts.length === 0) return 0

  // Only what is not a ticket yet.
  const have = new Set((await db.orderComplaint.findMany({
    where: { compSourceRef: { in: drafts.map((d) => d.sourceRef) } }, select: { compSourceRef: true },
  })).map((r) => r.compSourceRef))
  const todo = drafts.filter((d) => !have.has(d.sourceRef))
  if (todo.length === 0) return 0

  const orders = new Map((await db.order.findMany({
    where: { id: { in: [...new Set(todo.map((d) => d.orderId))] } },
    select: { id: true, conceptId: true, customerId: true },
  })).map((o) => [o.id, o]))

  const data: Prisma.OrderComplaintCreateManyInput[] = []
  for (const d of todo) {
    const o = orders.get(d.orderId)
    if (!o) continue
    data.push({
      kind: 'compensation',
      orderId: o.id,
      conceptId: o.conceptId,
      customerId: o.customerId,
      title: `${COMPENSATION_LABEL[d.type]} — order #${orderRefOf(o.id)}`,
      description: d.reason.slice(0, 4000),
      category: d.type,
      status: 'resolved',
      priority: 'medium',
      resolvedAt: d.at,
      resolution: d.approverId ? 'Approved by a manager' : 'Approved at the till',
      createdAt: d.at,
      compType: d.type,
      compValueCents: d.valueCents,
      compApproverId: d.approverId,
      compActorId: d.actorId,
      compSourceRef: d.sourceRef,
    })
  }
  if (data.length === 0) return 0
  const made = await db.orderComplaint.createMany({ data, skipDuplicates: true })
  return made.count
}

const lastSync = new Map<string, number>()

/**
 * Every company (the worker), or the given ones (the list route). Never
 * throws. `throttleMs`: skip a company synced that recently by this process
 * (the list route — the worker catches anything it skips within a minute).
 */
export async function syncCompensationTickets(tenantIds?: string[], opts: { throttleMs?: number } = {}): Promise<number> {
  let made = 0
  const ids = tenantIds ?? (await serviceClient.tenant.findMany({ where: { kind: 'company' }, select: { id: true } })).map((t) => t.id)
  const now = Date.now()
  for (const t of ids) {
    if (opts.throttleMs && now - (lastSync.get(t) ?? 0) < opts.throttleMs) continue
    lastSync.set(t, now)
    try {
      made += await syncCompensationTicketsForCompany(t)
    } catch (err) {
      console.error(`[compensation] ticket sync failed for company ${t}:`, (err as Error).message)
    }
  }
  return made
}
