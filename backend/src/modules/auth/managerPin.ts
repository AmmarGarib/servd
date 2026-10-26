import bcrypt from 'bcryptjs'
import type { Prisma, UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { OVERRIDE_APPROVERS } from '../../lib/roles.js'
import { ACTIVE_ACCOUNT_WHERE } from './accountStatus.js'
import { hashPin } from './service.js'
import { getRlsContext } from '../../lib/rlsContext.js'
import { audit } from '../../lib/audit.js'
import { flagException } from '../../lib/exceptions.js'
import { notifyStaff, queueStaffNotify } from '../../lib/staffNotify.js'
import { claimPinAttempt, pinAttemptSucceeded, MANAGER_PIN_ACTOR_LIMIT, MANAGER_PIN_ORDER_LIMIT, type PinAttemptKeys } from '../../lib/managerPinLimit.js'

/**
 * Manager override PIN — ONE verifier, ONE setter.
 *
 * There used to be three verifiers (POS discounts/price overrides, the inline
 * check in the POS refund/void/comp cap, and trustops' petty cash / staff
 * meals) and four setters, and they disagreed: trustops had no company filter,
 * so a manager at company B could approve a company-A staff meal; the refund
 * cap skipped deleted accounts; PATCH /auth/users had no collision check, so
 * two managers could share a PIN and the approval was pinned on whichever
 * matched first; PIN rules were "exactly 6" on one path and "4-8" on another.
 *
 * The rules, once:
 *   verify — the PIN must belong to an ACTIVE, not-deleted, not-suspended
 *            account whose role is an override approver (owner decision 7) and
 *            who belongs to the company the action happens in (primary company
 *            or a membership). No company → nobody matches.
 *   set    — 6 to 8 digits (owner C1, 2026-10-26), not a guessable pattern, and not already held by
 *            anyone else in the same company(ies), so an approval is always
 *            attributable to exactly one person.
 */

export const PIN_FORMAT = /^\d{4,8}$/

/**
 * Owner C1 (2026-10-26, option b): "Managers and CEO need at least 6 digits
 * (short PINs changed at next use)". Every NEW override PIN is 6 to 8 digits
 * (422 PIN_TOO_SHORT) — User.pin is only ever an override PIN (CEO, managers,
 * finance: canHoldOverridePin); floor staff punch with the HR kiosk PIN
 * (hr/kioskPin.ts), which this does not touch.
 *
 * An existing 4–5 digit PIN still approves. Its FIRST successful use stamps
 * `User.pinChangeRequiredAt` and tells the holder on the bell ("Set a new
 * 6-digit PIN"); /auth/account returns `pinChangeRequired` + `pinChangeBy`
 * for the account page. Once SHORT_PIN_GRACE_HOURS have passed since that
 * first use, the short PIN is refused (403 PIN_CHANGE_REQUIRED) until the
 * holder sets a new one (POST /auth/pin/change takes the short PIN as the
 * current one). The 5-tries / 15-minute lock is unchanged.
 */
export const MIN_NEW_PIN_LENGTH = 6
export const SHORT_PIN_GRACE_HOURS = 72

/**
 * Reject PINs that a shoulder-surfer or a casual guesser would land quickly:
 * all-same digits (0000), ascending/descending runs (1234, 4321), and
 * plausible birth years. Not a substitute for lockout, but it removes the
 * handful of PINs that a meaningful share of people actually pick.
 */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true                      // 1111, 000000
  const asc  = '01234567890'
  const desc = '09876543210'
  if (asc.includes(pin) || desc.includes(pin)) return true      // 1234, 4321
  if (/^(19|20)\d{2}$/.test(pin)) return true                   // 1998, 2024
  return false
}

/** Members of any of these companies (primary company or a membership). */
function inCompanies(tenantIds: string[]): Prisma.UserWhereInput {
  return { OR: [{ tenantId: { in: tenantIds } }, { tenantMemberships: { some: { tenantId: { in: tenantIds } } } }] }
}

/** Who is sending the PIN and what it is for — the attempt limiter's keys (FOH-R2-01). */
export interface ManagerPinContext {
  /**
   * The signed-in person sending the PIN. Defaults to the request's staff
   * user (lib/rlsContext), so a caller that forgets it is still limited.
   */
  actorId?: string | null
  /** The order the override is for, when there is one (its own bucket). */
  orderId?: string | null
  /** What is being approved ("void", "refund", "discount", …) — for the audit trail. */
  action?: string
}

/**
 * Who, if anyone, approves with this PIN at `tenantId`'s tills and boxes.
 * Returns the approver so the caller can record them, or null.
 *
 * FOH-R2-01: every PIN that is actually sent is an attempt. It is counted
 * against the sender (and the order) BEFORE it is compared — over the limit
 * (5 per 15 minutes) → 429 MANAGER_PIN_LOCKED, with no comparison made. A
 * wrong PIN is audited ('manager_pin.failed': actor, order, company) and the
 * attempt that reaches the limit raises an exception flag for the company's
 * owner. A correct PIN gives back only its own slot — the wrong guesses
 * around it keep counting (T-RV-01: knowing one valid PIN must not reset the
 * budget for guessing the others). Every override in servd —
 * voids, cancels, refunds, comps, discounts, price overrides, pay-outs, staff
 * meals, petty cash — comes through here, so this is the one limit.
 *
 * A stored PIN of 4 to 8 digits verifies; a 4–5 digit one is on notice (C1, shortPinUsed).
 */
export async function verifyManagerPin(
  pin: string | null | undefined,
  tenantId: string | null | undefined,
  roles: readonly UserRole[] = OVERRIDE_APPROVERS,
  ctx: ManagerPinContext = {},
): Promise<{ id: string; role: UserRole } | null> {
  pin = pin?.trim()
  // Nothing sent, or no company to approve in: not an attempt (callers answer
  // "PIN required" / deny).
  if (!pin || !tenantId) return null

  const actorId = ctx.actorId ?? getRlsContext()?.staffUserId ?? null
  // No signed-in actor (a background path): count against the company, so the
  // limit still holds.
  const keys: PinAttemptKeys = { actor: actorId ? `user:${actorId}` : `company:${tenantId}`, orderId: ctx.orderId ?? null }
  const claimed = await claimPinAttempt(keys)

  let approver: { id: string; role: UserRole } | null = null
  if (PIN_FORMAT.test(pin)) {
    const candidates = await prisma.user.findMany({
      where: {
        ...ACTIVE_ACCOUNT_WHERE,
        role: { in: [...roles] },
        pin: { not: null },
        ...inCompanies([tenantId]),
      },
      select: { id: true, role: true, pin: true },
    })
    for (const c of candidates) {
      if (c.pin && await bcrypt.compare(pin, c.pin)) { approver = { id: c.id, role: c.role }; break }
    }
  }

  if (approver) {
    await pinAttemptSucceeded(keys)
    if (pin.length < MIN_NEW_PIN_LENGTH) await shortPinUsed(approver.id, tenantId)
    return approver
  }
  await recordPinFailure(tenantId, actorId, ctx, claimed)
  return null
}

/**
 * A correct but short (4–5 digit) PIN was just used (owner C1). First use:
 * stamp pinChangeRequiredAt (conditional — once) and tell the holder on the
 * bell. Past the grace: refuse (403 PIN_CHANGE_REQUIRED). Never touches the
 * attempt limiter (the slot was already given back).
 */
async function shortPinUsed(userId: string, tenantId: string): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { pinChangeRequiredAt: true } })
  const since = u?.pinChangeRequiredAt
  if (since) {
    if (Date.now() - since.getTime() > SHORT_PIN_GRACE_HOURS * 3600_000) {
      throw new AppError('PIN_CHANGE_REQUIRED', 'This manager PIN is too short and has expired. The manager must set a new 6-digit PIN (Account → PIN) before approving again.', 403)
    }
    return
  }
  const now = new Date()
  const stamped = await prisma.user.updateMany({ where: { id: userId, pinChangeRequiredAt: null }, data: { pinChangeRequiredAt: now } })
  if (stamped.count === 0) return
  const by = new Date(now.getTime() + SHORT_PIN_GRACE_HOURS * 3600_000)
  queueStaffNotify(() => notifyStaff({
    userId,
    tenantId,
    kind: 'task.next',
    severity: 'warning',
    title: 'Set a new 6-digit manager PIN',
    body: `Your manager PIN is shorter than 6 digits. It worked this time, but it stops working after ${by.toISOString().slice(0, 16).replace('T', ' ')} UTC. Set a new 6-digit PIN on your account page.`,
    link: '/account/password',
    entityType: 'User',
    entityId: userId,
    actorId: null,
    dedupeKey: `pin.short:${userId}:${now.getTime()}`,
  }))
}

async function recordPinFailure(
  tenantId: string,
  actorId: string | null,
  ctx: ManagerPinContext,
  claimed: { actorCount: number; orderCount: number | null },
): Promise<void> {
  await audit({
    category: 'identity',
    action: 'manager_pin.failed',
    entity: ctx.orderId ? 'Order' : 'User',
    entityId: ctx.orderId ?? actorId,
    userId: actorId,
    tenantId,
    metadata: { action: ctx.action ?? null, orderId: ctx.orderId ?? null, actorAttempts: claimed.actorCount, orderAttempts: claimed.orderCount },
  })
  // The attempt that fills a bucket locks it — tell the owner once per lock.
  const actorLocked = claimed.actorCount === MANAGER_PIN_ACTOR_LIMIT.max
  const orderLocked = claimed.orderCount === MANAGER_PIN_ORDER_LIMIT.max
  if (!actorLocked && !orderLocked) return
  const baseMeta = { realKind: 'manager_pin_failed', action: ctx.action ?? null, orderId: ctx.orderId ?? null, actorAttempts: claimed.actorCount, orderAttempts: claimed.orderCount }

  if (actorLocked) {
    // One person sent all five: they are the one locked out (every order), so
    // the flag names them.
    const who = actorId
      ? (await prisma.user.findUnique({ where: { id: actorId }, select: { name: true } }))?.name ?? 'A staff member'
      : 'A till'
    await flagException({
      tenantId,
      kind: 'manager_pin_failed',
      severity: 'high',
      title: `${who}: ${MANAGER_PIN_ACTOR_LIMIT.max} wrong manager PINs — overrides locked`,
      description: `${who} sent ${MANAGER_PIN_ACTOR_LIMIT.max} wrong manager PINs within 15 minutes${ctx.action ? ` (last: ${ctx.action})` : ''}. Manager-PIN approvals by ${who} are locked for 15 minutes${orderLocked ? ', and so are PIN approvals for this order' : ''}. Someone may be guessing a manager's PIN — check who was on the till and consider changing the managers' PINs.`,
      entityType: ctx.orderId ? 'Order' : 'User',
      entityId: ctx.orderId ?? actorId ?? undefined,
      actorId,
      metadata: { ...baseMeta, lock: orderLocked ? 'actor_and_order' : 'actor' },
    })
    return
  }

  // Only the ORDER's bucket filled (IB-RV-3): the wrong PINs for this order
  // may have come from several people over the void, cancel and refused-at-door
  // doors, so the last sender is not "the guesser". Name nobody as the actor;
  // list everyone who sent a wrong PIN for this order in the window (from the
  // manager_pin.failed audit rows, which include the attempt just recorded).
  const since = new Date(Date.now() - MANAGER_PIN_ORDER_LIMIT.lockoutSec * 1000)
  const rows = ctx.orderId
    ? await prisma.auditLog.findMany({
        where: { action: 'manager_pin.failed', tenantId, entityId: ctx.orderId, createdAt: { gte: since } },
        select: { userId: true },
      })
    : []
  const counts = new Map<string, number>()
  for (const r of rows) if (r.userId) counts.set(r.userId, (counts.get(r.userId) ?? 0) + 1)
  const people = counts.size
    ? await prisma.user.findMany({ where: { id: { in: [...counts.keys()] } }, select: { id: true, name: true } })
    : []
  const nameOf = new Map(people.map((p) => [p.id, p.name]))
  const senders = [...counts.entries()].map(([userId, attempts]) => ({ userId, name: nameOf.get(userId) ?? null, attempts }))
  const sendersText = senders.length
    ? ` Sent by: ${senders.map((s) => `${s.name ?? 'unknown staff member'} (${s.attempts})`).join(', ')}.`
    : ''
  await flagException({
    tenantId,
    kind: 'manager_pin_failed',
    severity: 'high',
    title: `${MANAGER_PIN_ORDER_LIMIT.max} wrong manager PINs on one order — PIN approvals for this order locked`,
    description: `${MANAGER_PIN_ORDER_LIMIT.max} wrong manager PINs were sent for one order within 15 minutes${ctx.action ? ` (last: ${ctx.action})` : ''}.${sendersText} Manager-PIN approvals for this order are locked for 15 minutes; a manager who signs in can still act on it. Someone may be guessing a manager's PIN — check who was on the till and consider changing the managers' PINs.`,
    entityType: 'Order',
    entityId: ctx.orderId ?? undefined,
    actorId: null,
    metadata: { ...baseMeta, lock: 'order', senders },
  })
}

/**
 * Validate a new PIN for a staff member and return its hash. Throws a 400/409
 * AppError when it is malformed, guessable or already held by someone else in
 * the same company(ies). `excludeUserId` is the account being set (so
 * re-setting your own PIN is not a collision).
 */
export async function preparePin(
  pin: string,
  scope: { tenantIds: string[]; excludeUserId?: string },
): Promise<string> {
  if (!PIN_FORMAT.test(pin)) {
    throw new AppError('INVALID_PIN', 'PIN must be 6 to 8 digits.', 400)
  }
  if (pin.length < MIN_NEW_PIN_LENGTH) {
    throw new AppError('PIN_TOO_SHORT', 'A manager PIN must be at least 6 digits (6 to 8).', 422)
  }
  if (isWeakPin(pin)) {
    throw new AppError('WEAK_PIN', 'That PIN is too easy to guess — avoid repeated digits (1111), runs (1234), and years.', 400)
  }
  if (scope.tenantIds.length > 0) {
    const others = await prisma.user.findMany({
      where: {
        deletedAt: null,
        pin: { not: null },
        ...(scope.excludeUserId ? { id: { not: scope.excludeUserId } } : {}),
        ...inCompanies(scope.tenantIds),
      },
      select: { pin: true },
    })
    for (const o of others) {
      if (o.pin && await bcrypt.compare(pin, o.pin)) {
        throw new AppError('PIN_COLLISION', 'That PIN is already in use by someone else in this company. Pick a different one.', 409)
      }
    }
  }
  return hashPin(pin)
}

/** Every company a user belongs to: primary + memberships. */
export async function companiesOf(userId: string): Promise<string[]> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true, tenantMemberships: { select: { tenantId: true } } },
  })
  if (!u) return []
  return Array.from(new Set([
    ...(u.tenantId ? [u.tenantId] : []),
    ...u.tenantMemberships.map((m) => m.tenantId),
  ]))
}

/**
 * THE setter. Validates (format, weak, collision within the user's companies)
 * and stores the hash. A PIN set here is final — pinMustReset is cleared.
 * `null` clears the PIN.
 */
export async function setManagerPin(userId: string, pin: string | null): Promise<void> {
  if (pin === null) {
    await prisma.user.update({ where: { id: userId }, data: { pin: null } })
    return
  }
  const hash = await preparePin(pin, { tenantIds: await companiesOf(userId), excludeUserId: userId })
  await prisma.user.update({
    where: { id: userId },
    data: { pin: hash, pinMustReset: false, pinResetRequestedAt: null, pinChangeRequiredAt: null },
  })
}
