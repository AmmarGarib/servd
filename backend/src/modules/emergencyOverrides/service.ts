// Emergency overrides — the reads and the switch behind /emergency-overrides
// (Delivery & customers, resumed 2026-10-15). The actions themselves live
// where their rules live:
//   - send the hand-over code to the rider → dispatch/service.ts
//     rerouteHandoverCode / resendReroutedCode;
//   - food came back → orders/returnedFood.ts returnUndeliveredOrder;
//   - the per-company code-only switch → lib/deliveryRules.ts.
// This file only resolves the order through the caller's company scope,
// enforces the switch, and builds the page's lists. See README.md.
//
// Reads go through serviceClient with EXPLICIT company filters: a fleet
// partner's rider row belongs to another company and is hidden by RLS (the
// same reason /dispatch/board does it). Every filter is on the ORDER's
// company (concept.tenantId), so a fleet partner never sees its client's
// orders — only the client sees them.

import type { Prisma } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { formatBrandName } from '../../lib/brandName.js'
import { DELIVERY_OTP_MAX_ATTEMPTS } from '../../lib/deliveryOtp.js'
import { DELIVERY_CODE_ONLY_SETTING, codeOnlyDelivery, setCodeOnlyDelivery } from '../../lib/deliveryRules.js'
import type { TenantIdWhere } from '../../lib/tenantScope.js'
import type { DoorProblemKind } from '../rider/service.js'

/** The door-problem kinds a rider can report (rider/service.ts reportDoorProblem notes start with one). */
const DOOR_KINDS: readonly DoorProblemKind[] = ['no_code', 'refused', 'unreachable']

/** How far back the "recent overrides" list reaches. */
export const RECENT_DAYS = 14

/** A foreign or unknown order: 404, never a hint that it exists in another company. */
export function orderNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Order not found in your companies', 404)
}

export function codeOnlyOff(): AppError {
  return new AppError(
    'CODE_ONLY_OFF',
    "Emergency overrides work only once this company's code-only delivery is switched on (CEO → Emergency overrides → Settings).",
    409,
  )
}

/** Tenant ids named by a scope fragment. */
export function tenantIdsOf(scope: TenantIdWhere): string[] {
  return typeof scope.tenantId === 'string' ? [scope.tenantId] : scope.tenantId.in
}

// ─── The switch ─────────────────────────────────────────────────────────────

export interface CompanySwitch {
  tenantId: string
  name: string
  codeOnly: boolean
  since: string | null
}

/** The code-only switch for every company in `tenantIds` (the caller's read scope). */
export async function listSwitches(tenantIds: string[]): Promise<CompanySwitch[]> {
  if (tenantIds.length === 0) return []
  const tenants = await serviceClient.tenant.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  const rows = await serviceClient.setting.findMany({
    where: { key: { in: tenants.map((t) => `${DELIVERY_CODE_ONLY_SETTING}:${t.id}`) } },
    select: { key: true, value: true },
  })
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  return tenants.map((t) => {
    const at = byKey.get(`${DELIVERY_CODE_ONLY_SETTING}:${t.id}`)
    return { tenantId: t.id, name: t.name, codeOnly: at !== undefined, since: at ?? null }
  })
}

/**
 * Switch code-only delivery for one company. The caller (route) has already
 * checked the CEO role and that the company is one the CEO belongs to.
 */
export async function switchCodeOnly(a: { tenantId: string; codeOnly: boolean; reason: string; actorId: string }): Promise<CompanySwitch> {
  const tenant = await serviceClient.tenant.findUnique({ where: { id: a.tenantId }, select: { id: true, name: true } })
  if (!tenant) throw orderNotFound()
  const r = await serviceClient.$transaction((tx) => setCodeOnlyDelivery(tx, {
    tenantId: a.tenantId, on: a.codeOnly, actorId: a.actorId, reason: a.reason.trim(),
  }))
  return { tenantId: tenant.id, name: tenant.name, codeOnly: r.on, since: r.since ? r.since.toISOString() : null }
}

// ─── Resolving an order ─────────────────────────────────────────────────────

/**
 * The order, resolved through the caller's company scope on its brand
 * (`write` for actions, `read` for the preview). Foreign → 404.
 */
export async function orderInScope(orderId: string, scope: TenantIdWhere): Promise<{ id: string; tenantId: string }> {
  const ids = tenantIdsOf(scope)
  if (ids.length === 0 || !orderId || orderId.length > 64) throw orderNotFound()
  const o = await serviceClient.order.findFirst({
    where: { id: orderId, deletedAt: null, concept: { deletedAt: null, tenantId: { in: ids } } },
    select: { id: true, concept: { select: { tenantId: true } } },
  })
  if (!o || !o.concept.tenantId) throw orderNotFound()
  return { id: o.id, tenantId: o.concept.tenantId }
}

/** 409 CODE_ONLY_OFF unless the order's company has code-only delivery on. */
export async function assertCodeOnly(tenantId: string): Promise<void> {
  if (!(await codeOnlyDelivery(serviceClient, tenantId))) throw codeOnlyOff()
}

// ─── The list ───────────────────────────────────────────────────────────────

export type Stage = 'assigned' | 'accepted' | 'picked_up' | 'arrived'

export interface OnTheRoadRow {
  orderId: string
  ref: string
  brand: string
  customerName: string | null
  stage: Stage
  rider: { id: string; name: string; fleetPartner: string | null }
  cashToCollectCents: number
  codeLocked: boolean
  rerouted: { at: string; byName: string | null } | null
  doorProblem: { kind: DoorProblemKind; at: string } | null
  minutesOut: number
  /** The order's company has code-only delivery on (the actions answer 409 CODE_ONLY_OFF otherwise). */
  codeOnly: boolean
}

export interface RecentRow {
  id: string
  type: 'code_rerouted' | 'returned'
  at: string
  orderId: string
  ref: string
  brand: string
  riderName: string | null
  actorName: string | null
  note: string | null
}

function stageOf(o: { riderAssignedAt: Date | null; riderAcceptedAt: Date | null; pickedUpAt: Date | null; arrivedAt: Date | null }): Stage {
  if (o.arrivedAt) return 'arrived'
  if (o.pickedUpAt) return 'picked_up'
  if (o.riderAcceptedAt) return 'accepted'
  if (o.riderAssignedAt) return 'assigned'
  // A dispatcher's rider without the app: the order left with them.
  return 'picked_up'
}

function doorKindOf(note: string | null): DoorProblemKind | null {
  if (!note) return null
  return DOOR_KINDS.find((k) => note === k || note.startsWith(`${k}:`)) ?? null
}

/** Delivery orders out with a rider in these companies (the ORDER's company), plus the last 14 days' overrides. */
export async function listOverrides(tenantIds: string[], now = new Date()): Promise<{ onTheRoad: OnTheRoadRow[]; recent: RecentRow[] }> {
  if (tenantIds.length === 0) return { onTheRoad: [], recent: [] }
  const inScope = new Set(tenantIds)
  const where: Prisma.OrderWhereInput = {
    deletedAt: null,
    fulfilmentType: 'delivery',
    status: 'ready',
    riderId: { not: null },
    deliveredAt: null,
    returnedAt: null,
    concept: { deletedAt: null, tenantId: { in: tenantIds } },
  }
  const orders = await serviceClient.order.findMany({
    where,
    orderBy: { placedAt: 'asc' },
    take: 500,
    select: {
      id: true, customerName: true, placedAt: true, riderId: true,
      riderAssignedAt: true, riderAcceptedAt: true, pickedUpAt: true, arrivedAt: true,
      deliveryOtpAttempts: true, handoverReroutedAt: true,
      customer: { select: { name: true } },
      concept: { select: { name: true, tenantId: true } },
      rider: { select: { id: true, name: true, tenantId: true } },
      payments: { where: { method: 'cash', status: 'pending' }, select: { amountCents: true } },
    },
  })
  const orderIds = orders.map((o) => o.id)

  // The latest door problem (by the order's current rider) and the reroute's manager.
  const events = orderIds.length === 0 ? [] : await serviceClient.riderJobEvent.findMany({
    where: { orderId: { in: orderIds }, type: { in: ['door_problem', 'code_rerouted'] } },
    orderBy: { createdAt: 'desc' },
    select: { orderId: true, riderId: true, type: true, note: true, createdAt: true, actorId: true },
  })
  const riderOf = new Map(orders.map((o) => [o.id, o.riderId]))
  const door = new Map<string, { kind: DoorProblemKind; at: Date }>()
  const rerouteBy = new Map<string, string | null>()
  for (const e of events) {
    if (e.type === 'door_problem' && !door.has(e.orderId) && e.riderId === riderOf.get(e.orderId)) {
      const kind = doorKindOf(e.note)
      if (kind) door.set(e.orderId, { kind, at: e.createdAt })
    }
    if (e.type === 'code_rerouted' && !rerouteBy.has(e.orderId)) rerouteBy.set(e.orderId, e.actorId)
  }

  const recentEvents = await serviceClient.riderJobEvent.findMany({
    where: {
      type: { in: ['code_rerouted', 'returned'] },
      tenantId: { in: tenantIds },
      createdAt: { gte: new Date(now.getTime() - RECENT_DAYS * 86_400_000) },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, type: true, createdAt: true, orderId: true, note: true, actorId: true,
      rider: { select: { name: true } },
      order: { select: { concept: { select: { name: true, tenantId: true } } } },
    },
  })

  const actorIds = [...new Set([
    ...[...rerouteBy.values()],
    ...recentEvents.map((e) => e.actorId),
  ].filter((x): x is string => !!x))]
  const actors = actorIds.length === 0 ? [] : await serviceClient.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
  const nameOf = new Map(actors.map((u) => [u.id, u.name]))

  const providerIds = [...new Set(orders.map((o) => o.rider?.tenantId).filter((t): t is string => !!t && !inScope.has(t)))]
  // A fleet partner's company name only — never its other data.
  const providers = providerIds.length === 0 ? [] : await serviceClient.tenant.findMany({ where: { id: { in: providerIds } }, select: { id: true, name: true } })
  const providerName = new Map(providers.map((t) => [t.id, t.name]))

  const orderTenants = [...new Set(orders.map((o) => o.concept.tenantId).filter((t): t is string => !!t))]
  const codeOnlyTenants = new Set<string>()
  for (const t of orderTenants) if (await codeOnlyDelivery(serviceClient, t)) codeOnlyTenants.add(t)

  const onTheRoad: OnTheRoadRow[] = orders.filter((o) => o.rider).map((o) => {
    const rider = o.rider!
    const orderTenant = o.concept.tenantId
    const fleet = rider.tenantId !== orderTenant
    const outSince = o.pickedUpAt ?? o.riderAcceptedAt ?? o.riderAssignedAt ?? o.placedAt
    const d = door.get(o.id)
    return {
      orderId: o.id,
      ref: orderRefOf(o.id),
      brand: formatBrandName(o.concept.name),
      customerName: o.customerName ?? o.customer?.name ?? null,
      stage: stageOf(o),
      rider: {
        id: rider.id,
        name: rider.name,
        fleetPartner: fleet ? (providerName.get(rider.tenantId ?? '') ?? 'Fleet partner') : null,
      },
      cashToCollectCents: o.payments.reduce((t, p) => t + p.amountCents, 0),
      codeLocked: o.deliveryOtpAttempts >= DELIVERY_OTP_MAX_ATTEMPTS,
      rerouted: o.handoverReroutedAt
        ? { at: o.handoverReroutedAt.toISOString(), byName: nameOf.get(rerouteBy.get(o.id) ?? '') ?? null }
        : null,
      doorProblem: d ? { kind: d.kind, at: d.at.toISOString() } : null,
      minutesOut: Math.max(0, Math.floor((now.getTime() - outSince.getTime()) / 60_000)),
      codeOnly: !!orderTenant && codeOnlyTenants.has(orderTenant),
    }
  })

  const recent: RecentRow[] = recentEvents.map((e) => ({
    id: e.id,
    type: e.type as 'code_rerouted' | 'returned',
    at: e.createdAt.toISOString(),
    orderId: e.orderId,
    ref: orderRefOf(e.orderId),
    brand: formatBrandName(e.order.concept.name),
    riderName: e.rider?.name ?? null,
    actorName: e.actorId ? (nameOf.get(e.actorId) ?? null) : null,
    note: e.note,
  }))

  return { onTheRoad, recent }
}

// ─── The "Food came back" dialog ────────────────────────────────────────────

export interface ReturnPreview {
  lines: Array<{ name: string; quantity: number }>
  /** Cash on delivery still pending — set to failed (never posted) when the food comes back. */
  codToVoidCents: number
  /** Money already taken on the ticket — handed back through the cancelled-ticket refund. */
  paidCents: number
}

export async function returnPreview(orderId: string): Promise<ReturnPreview> {
  const o = await serviceClient.order.findUnique({
    where: { id: orderId },
    select: {
      items: { where: { voidedAt: null }, select: { name: true, quantity: true }, orderBy: { createdAt: 'asc' } },
      payments: { select: { method: true, status: true, amountCents: true } },
    },
  })
  if (!o) throw orderNotFound()
  return {
    lines: o.items.map((i) => ({ name: i.name, quantity: i.quantity })),
    codToVoidCents: o.payments.filter((p) => p.method === 'cash' && p.status === 'pending').reduce((t, p) => t + p.amountCents, 0),
    paidCents: o.payments.filter((p) => p.status === 'paid').reduce((t, p) => t + p.amountCents, 0),
  }
}
