// Kiosk PIN — how staff WITHOUT a servd login punch in (decision 32).
//
// Most kitchen staff never get a login. They punch at a shared kiosk (the
// admin /time-clock page or the tablet's Time clock tab, signed in on the
// device) with their HR employee code and a personal PIN that HR sets. The PIN
// is keyed on the HrEmployee, so the punch lands on their attendance directly.
//
// Stored as a bcrypt hash in a Setting row per employee until HrEmployee gets
// a kioskPinHash column (see the report) — never in HrEmployee.data, which is
// printed into letters and returned by the employee API.

import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { hashPin } from '../auth/service.js'
import { isWeakPin } from '../auth/routes.js'
import * as rateLimit from '../../lib/loginRateLimit.js'

/** Five wrong PINs for one employee locks their kiosk punch for 15 minutes. */
export const KIOSK_PIN_LIMIT: Parameters<typeof rateLimit.check>[0] = { scope: 'hr-kiosk-pin', max: 5, lockoutSec: 15 * 60 }

export async function hasKioskPin(employeeId: string): Promise<boolean> {
  const e = await prisma.hrEmployee.findUnique({ where: { id: employeeId }, select: { kioskPinHash: true } })
  return !!e?.kioskPinHash
}

export async function setKioskPin(employeeId: string, pin: string): Promise<void> {
  if (!/^\d{4,6}$/.test(pin)) throw new AppError('BAD_PIN', 'The PIN must be 4 to 6 digits', 400)
  if (isWeakPin(pin)) throw new AppError('WEAK_PIN', 'That PIN is too easy to guess — avoid repeats, runs and years', 400)
  const kioskPinHash = await hashPin(pin)
  await prisma.hrEmployee.update({ where: { id: employeeId }, data: { kioskPinHash } })
}

export async function clearKioskPin(employeeId: string): Promise<void> {
  await prisma.hrEmployee.update({ where: { id: employeeId }, data: { kioskPinHash: null } })
}

/**
 * The current employee a kiosk punch is for, or an error. Checked in the
 * kiosk device's active company only; an unknown code and a wrong PIN answer
 * the same, and both count towards the employee's lockout.
 */
export async function verifyKioskPin(tenantId: string, employeeCode: string, pin: string) {
  const emp = await prisma.hrEmployee.findFirst({ where: { tenantId, employeeCode: employeeCode.trim() } })
  const limitKey = emp ? emp.id : `${tenantId}:${employeeCode.trim().toLowerCase()}`
  await rateLimit.check(KIOSK_PIN_LIMIT, limitKey)
  const ok = !!emp?.kioskPinHash && await bcrypt.compare(pin, emp.kioskPinHash)
  if (!emp || !ok) {
    await rateLimit.recordFailure(KIOSK_PIN_LIMIT, limitKey)
    throw new AppError('BAD_KIOSK_PIN', 'Employee code or PIN is not right', 401)
  }
  if (!['active', 'on_leave'].includes(emp.status)) throw new AppError('NOT_EMPLOYED', 'This employee record is not current — see HR', 403)
  await rateLimit.clearFailures(KIOSK_PIN_LIMIT, limitKey)
  return emp
}
