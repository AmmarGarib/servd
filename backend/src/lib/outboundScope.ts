import { practiceId } from './sandbox.js'
import { isTestTenant } from './testCompany.js'

// Test companies never contact anyone outside (owner, 2026-10-14).
//
// A company marked "test" (Tenant.isTest, lib/testCompany.ts) is for trying
// things out: it must never reach a real customer or an outside party. Every
// CUSTOMER-facing send names its company and audience:
//
//   sendText(to, text, { tenantId, audience: 'customer' })
//
// and the funnel skips it when that company is a test company. Staff messages
// (sign-in codes, 2FA, password reset, rider sign-in, owner alerts, scheduled
// reports) pass no scope, or audience 'staff', and are NEVER blocked — a test
// company's staff still have to sign in. This is separate from the practice
// copy (lib/sandbox.ts), which blocks everything on that server regardless.

/** Who a message is for, and which company sends it. */
export interface SendScope {
  tenantId?: string | null
  audience?: 'customer' | 'external' | 'staff'
}

/** Logged when a test company's send is skipped. Never the body or the address. */
export type TestCompanySendKind = 'whatsapp' | 'email' | 'push' | 'webhook' | 'supplier' | 'social'

/**
 * True when this send must be skipped because it is a customer / outside-party
 * message of a test company. Staff sends (no scope, or audience 'staff') are
 * never blocked. Never throws: a failed lookup is "not a test company"
 * (lib/testCompany.ts — blocking real customers on a DB blip is worse).
 */
export async function testCompanyBlocks(kind: TestCompanySendKind, scope?: SendScope | null): Promise<boolean> {
  if (!scope?.tenantId) return false
  if (scope.audience !== 'customer' && scope.audience !== 'external') return false
  let blocked = false
  try {
    blocked = await isTestTenant(scope.tenantId)
  } catch (err) {
    console.warn(`[test-company] could not check company for ${kind}: ${(err as Error).message}`)
    return false
  }
  if (blocked) console.log(`[test-company] blocked ${kind} (${scope.audience})`)
  return blocked
}

/** What a skipped send answers — the same "not sent" shape as the practice copy. */
export function testCompanyResult(): { id: string; practice: true; testCompany: true } {
  return { id: practiceId(), practice: true, testCompany: true }
}

/** `{ tenantId, audience: 'customer' }` — the scope every customer-facing send passes. */
export function customerScope(tenantId: string | null | undefined): SendScope {
  return { tenantId: tenantId ?? null, audience: 'customer' }
}

/** `{ tenantId, audience: 'external' }` — suppliers, webhook endpoints, social pages. */
export function externalScope(tenantId: string | null | undefined): SendScope {
  return { tenantId: tenantId ?? null, audience: 'external' }
}
