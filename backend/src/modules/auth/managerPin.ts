import bcrypt from 'bcryptjs'
import type { Prisma, UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { OVERRIDE_APPROVERS } from '../../lib/roles.js'
import { ACTIVE_ACCOUNT_WHERE } from './accountStatus.js'
import { hashPin } from './service.js'

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
 *   set    — 4 to 8 digits, not a guessable pattern, and not already held by
 *            anyone else in the same company(ies), so an approval is always
 *            attributable to exactly one person.
 */

export const PIN_FORMAT = /^\d{4,8}$/

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

/**
 * Who, if anyone, approves with this PIN at `tenantId`'s tills and boxes.
 * Returns the approver so the caller can record them, or null.
 */
export async function verifyManagerPin(
  pin: string | null | undefined,
  tenantId: string | null | undefined,
  roles: readonly UserRole[] = OVERRIDE_APPROVERS,
): Promise<{ id: string; role: UserRole } | null> {
  pin = pin?.trim()
  if (!pin || !PIN_FORMAT.test(pin) || !tenantId) return null
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
    if (c.pin && await bcrypt.compare(pin, c.pin)) return { id: c.id, role: c.role }
  }
  return null
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
    throw new AppError('INVALID_PIN', 'PIN must be 4 to 8 digits.', 400)
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
    data: { pin: hash, pinMustReset: false, pinResetRequestedAt: null },
  })
}
