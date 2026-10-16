// CEO-only undo of a BACK-DATED sale (owner, 2026-10-16, (c): "Only CEO will
// have the right to reopen the night run, to make the back dated entries, or
// to void/Cancel/Delete any back dated payment posting or bills" — and (d):
// the sales module only). Contract: ./README.md §4.5.
//
// An order is a back-dated sale when its sales day (completedAt, else
// scheduledFor, else placedAt — Karachi date) is before today AND either it is
// final (completed / refunded: a full and final bill was issued on an earlier
// day) or its sales day is locked by the night audit (audited / closed). An
// open ticket carried over midnight on a day not yet audited keeps the normal
// manager rules (the night run blocks on it anyway: open_orders).
//
// The gate runs INSIDE each service function (voidOrderItem, compOrder,
// cancelOrder, manualReverseCharge, issueCreditNoteForOrder), after the
// order's company scope and before any money moves:
//   not back-dated            → { backdated: false } (existing rules apply);
//   back-dated, no CEO        → 403 CEO_ONLY_BACKDATED { day, orderRef, action }
//                               (neither the signed-in login nor the manager-PIN
//                               approver has role 'admin');
//   CEO, reason < 10 chars    → 422 BACKDATED_REASON_REQUIRED;
//   CEO with a reason         → { backdated: true, day } — the caller runs
//                               auditBackdatedSalesUndo after its commit.
// The posting is still dated TODAY (the engines already do); the locked day is
// never reopened by this. Refunds, payment settles, on-account charges,
// deposit drops and Raast write-offs are NOT gated (owner question Q5).

import type { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../../lib/errors.js'
import { prisma as defaultPrisma } from '../../lib/prisma.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { fmtPktDate } from '../accounting/dates.js'
import { dayLockOf } from './lock.js'
import { MIN_REASON } from './types.js'

type Db = Prisma.TransactionClient | PrismaClient

/** The optional body field every gated sales route accepts. */
export const zBackdatedReason = z.string().trim().max(500).optional()

export type BackdatedAction = 'item_void' | 'comp' | 'cancel' | 'reject' | 'card_reverse' | 'credit_note' | 'raast_void'

const ACTION_WORDS: Record<BackdatedAction, string> = {
  item_void: 'void an item on',
  comp: 'comp',
  cancel: 'cancel',
  reject: 'reject',
  card_reverse: 'reverse the card payment of',
  credit_note: 'credit-note',
  raast_void: 'void the Raast payment of',
}

export interface SalesDayOrder {
  id: string
  status: string
  completedAt: Date | null
  scheduledFor: Date | null
  placedAt: Date
}

export const SALES_DAY_ORDER_SELECT = { id: true, status: true, completedAt: true, scheduledFor: true, placedAt: true } as const

/** The Karachi sales day of an order: completed, else scheduled, else placed. */
export function salesDayOfOrder(o: Pick<SalesDayOrder, 'completedAt' | 'scheduledFor' | 'placedAt'>): string {
  return fmtPktDate(o.completedAt ?? o.scheduledFor ?? o.placedAt)
}

const FINAL = new Set(['completed', 'refunded'])

/** Is this order a back-dated sale in `tenantId`'s books (see the header)? */
export async function isBackdatedSale(db: Db, tenantId: string | null, order: SalesDayOrder, now: Date = new Date()): Promise<{ backdated: boolean; day: string }> {
  const day = salesDayOfOrder(order)
  if (day >= fmtPktDate(now)) return { backdated: false, day }
  if (FINAL.has(order.status)) return { backdated: true, day }
  if (!tenantId) return { backdated: false, day }
  const lock = await dayLockOf(db, tenantId, order.completedAt ?? order.scheduledFor ?? order.placedAt)
  return { backdated: !!lock, day }
}

async function roleOf(db: Db, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const u = await db.user.findUnique({ where: { id: userId }, select: { role: true } })
  return u?.role ?? null
}

export interface BackdatedGateInput {
  tenantId: string | null
  order: SalesDayOrder
  action: BackdatedAction
  /** The signed-in login (null for a system or customer caller). Its role is read when not given. */
  actor: { id: string; role?: string | null } | null
  /** The manager-PIN approver, when one approved it. */
  approverId?: string | null
  /** The CEO's reason (≥ 10 characters). */
  reason?: string | null
  now?: Date
  /**
   * A day the money itself belongs to (e.g. an approved card charge's own
   * day): when it is before today the action is back-dated even if the
   * order's own sales day is not.
   */
  moneyDay?: string | null
}

export type BackdatedGateResult = { backdated: false } | { backdated: true; day: string; reason: string }

/** The gate (see the header). Never moves money; throws or answers. */
export async function assertBackdatedSalesUndoAllowed(db: Db, input: BackdatedGateInput): Promise<BackdatedGateResult> {
  let { backdated, day } = await isBackdatedSale(db, input.tenantId, input.order, input.now)
  if (!backdated && input.moneyDay && input.moneyDay < fmtPktDate(input.now ?? new Date())) {
    backdated = true
    day = input.moneyDay
  }
  if (!backdated) return { backdated: false }
  const orderRef = orderRefOf(input.order.id)
  const details = { day, orderRef, action: input.action }
  const actorRole = input.actor ? (input.actor.role ?? await roleOf(db, input.actor.id)) : null
  const approverRole = input.approverId && input.approverId !== input.actor?.id ? await roleOf(db, input.approverId) : null
  if (actorRole !== 'admin' && approverRole !== 'admin') {
    throw new AppError(
      'CEO_ONLY_BACKDATED',
      `Only the CEO can ${ACTION_WORDS[input.action]} a bill from ${day} — an earlier business day. Ask the CEO.`,
      403,
      details,
    )
  }
  const reason = (input.reason ?? '').trim()
  if (reason.length < MIN_REASON) {
    throw new AppError(
      'BACKDATED_REASON_REQUIRED',
      `This bill is from ${day} — an earlier business day. Give the reason (at least ${MIN_REASON} characters) to change it.`,
      422,
      details,
    )
  }
  return { backdated: true, day, reason }
}

/**
 * After the commit of a CEO's back-dated change: audit
 * 'sales.backdated.<action>' and raise ONE high 'backdated_sale_change' flag
 * in the order's company (so it shows on today's report). Never throws.
 */
export async function auditBackdatedSalesUndo(input: {
  tenantId: string | null
  orderId: string
  conceptId?: string | null
  action: BackdatedAction
  gate: BackdatedGateResult
  actorId: string | null
  actorEmail?: string | null
  amountCents?: number | null
}): Promise<void> {
  if (!input.gate.backdated) return
  const { day, reason } = input.gate
  const orderRef = orderRefOf(input.orderId)
  try {
    const { audit } = await import('../../lib/audit.js')
    await audit({
      category: 'accounting',
      action: `sales.backdated.${input.action}`,
      entity: 'Order',
      entityId: input.orderId,
      userId: input.actorId,
      userEmail: input.actorEmail ?? null,
      tenantId: input.tenantId,
      metadata: { day, reason, orderRef, amountCents: input.amountCents ?? null },
    })
    const { flagException } = await import('../../lib/exceptions.js')
    await flagException({
      tenantId: input.tenantId,
      kind: 'backdated_sale_change',
      severity: 'high',
      title: `CEO changed bill #${orderRef} from ${day} (${input.action.replace(/_/g, ' ')})`,
      description: `The CEO used the back-dated sales right on bill #${orderRef} of ${day}: ${reason}. `
        + 'The change is booked today; the locked day keeps its report.',
      entityType: 'Order',
      entityId: input.orderId,
      conceptId: input.conceptId ?? null,
      actorId: input.actorId,
      amountCents: input.amountCents ?? null,
      metadata: { day, reason, action: input.action },
    })
  } catch (err) {
    console.error(`[night-audit] back-dated audit failed for order ${input.orderId}:`, (err as Error).message)
  }
}

/** Convenience: load an order's sales-day fields (null when missing). */
export async function salesDayOrderOf(orderId: string, db: Db = defaultPrisma): Promise<SalesDayOrder | null> {
  return db.order.findUnique({ where: { id: orderId }, select: SALES_DAY_ORDER_SELECT })
}
