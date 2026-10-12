// Raast bank references — pure helpers (no I/O). One definition used by the
// till, the SMS parser, statement matching and finance's reference fix.
//
// A bank reference (the transfer's transaction ID from the bank SMS or the
// merchant app) is stored NORMALISED: upper-case, with spaces and the
// separators - _ . / # : removed. The same transfer can't pay two bills:
// RaastReceipt is unique on (tenantId, bankRef).

import { AppError } from '../../lib/errors.js'
import { orderRefOf } from '../../lib/orderRef.js'

const SEPARATORS = /[\s\-_./#:]+/g

/** Trim, upper-case, strip spaces and - _ . / # : */
export function normalizeBankRef(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toUpperCase().replace(SEPARATORS, '')
}

export interface RefRule { orderId?: string; min?: number; max?: number }

/**
 * 422 RAAST_REF_INVALID unless the (normalised) reference looks like a real
 * transfer ID: letters/digits only, min..max long (default 6..35), at least
 * three digits, not one repeated character, and not the bill's own order
 * reference (a cashier copying the bill number is the common mistake).
 */
export function assertValidBankRef(ref: string, rule: RefRule = {}): void {
  const min = rule.min ?? 6
  const max = rule.max ?? 35
  const fail = (why: string): never => {
    throw new AppError('RAAST_REF_INVALID', `That bank reference doesn't look right (${why}). Type the transaction ID from the bank SMS or the merchant app.`, 422, { min, max })
  }
  if (!new RegExp(`^[A-Z0-9]{${min},${max}}$`).test(ref)) fail(`${min}–${max} letters or digits`)
  if ((ref.match(/[0-9]/g) ?? []).length < 3) fail('at least 3 digits')
  if (/^(.)\1*$/.test(ref)) fail('not one repeated character')
  if (rule.orderId && ref === orderRefOf(rule.orderId)) fail("that is the bill's own number")
}

/** normalizeBankRef + assertValidBankRef; returns the normalised reference. */
export function cleanBankRef(raw: string | null | undefined, rule: RefRule = {}): string {
  const ref = normalizeBankRef(raw)
  assertValidBankRef(ref, rule)
  return ref
}

/**
 * Does a bank-statement description/reference mention this transfer?
 * A reference of 8+ characters matches as a substring of the text with every
 * non-alphanumeric removed (upper-cased); a shorter one must equal a whole
 * alphanumeric token (so "123456" never matches inside "9123456789").
 */
export function refInText(ref: string, text: string | null | undefined): boolean {
  const r = normalizeBankRef(ref)
  if (!r) return false
  const t = String(text ?? '').toUpperCase()
  if (r.length >= 8) return t.replace(/[^A-Z0-9]/g, '').includes(r)
  return t.split(/[^A-Z0-9]+/).some((tok) => tok === r)
}
