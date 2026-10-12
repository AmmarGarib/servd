// Manager-PIN refusals, worded once for every PIN prompt in the admin (void,
// cancel, refund, comp, till pay-out). The server limits wrong PINs per
// person and per order (backend lib/managerPinLimit.ts): over the limit it
// answers 429 MANAGER_PIN_LOCKED with details.retryAfterSec and compares no
// PIN at all, so the prompt must stop asking and say who can still do it.

import { ApiError } from '../../lib/api'

/** True for the server's "too many wrong PINs" lock-out. */
export function isManagerPinLocked(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === 'MANAGER_PIN_LOCKED'
}

/** Whole minutes until the lock lifts (at least 1), or null when the API did not say. */
export function pinLockMinutes(e: ApiError): number | null {
  const d = e.details as { retryAfterSec?: unknown } | null | undefined
  const sec = typeof d?.retryAfterSec === 'number' && Number.isFinite(d.retryAfterSec) ? d.retryAfterSec : null
  return sec == null ? null : Math.max(1, Math.ceil(sec / 60))
}

/** "Too many wrong PINs…" for a MANAGER_PIN_LOCKED refusal; null for anything else. */
export function managerPinLockedMessage(e: unknown): string | null {
  if (!isManagerPinLocked(e)) return null
  const mins = pinLockMinutes(e)
  const wait = mins == null ? 'try again in a few minutes' : `try again in ${mins} minute${mins === 1 ? '' : 's'}`
  return `Too many wrong PINs. A manager must sign in, or ${wait}.`
}

/** The plain line for a PIN that was sent and did not match a manager of this company. */
export const WRONG_PIN_MESSAGE = 'That PIN is not right. Check it with the manager and try again.'

/**
 * Does the till's payment step show a Manager PIN box for this tender? A comp
 * always does (needed above the cashier's comp limit). A staff meal needs a
 * manager at ANY amount (backend compOrder), so it shows one unless the
 * signed-in user is an override approver, who approves with their own session.
 * Cash / card / QR never send a PIN.
 */
export function tenderNeedsPinBox(method: string, isManager: boolean): boolean {
  return method === 'comp' || (method === 'staff_meal' && !isManager)
}

/** The line for a 403 MANAGER_OVERRIDE_REQUIRED on a comp or a staff meal. */
export function compOverrideMessage(method: string): string {
  return method === 'staff_meal'
    ? 'A staff meal needs a manager — enter a manager’s PIN.'
    : 'This comp is above your limit — enter a manager PIN and try again.'
}
